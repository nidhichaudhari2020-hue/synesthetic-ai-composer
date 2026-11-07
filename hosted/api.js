// This module runs only behind Sites dispatch. Dispatch authenticates visitors
// and supplies the site-scoped identity header. Never mount on a direct origin.
const MAX_TRACKS = 50;
const WRITE_LIMIT = 10;
const WINDOW_MS = 60_000;
const MAX_BODY = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

class ApiError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function visitor(request) {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id || id.length > 256 || /[\s,\u0000-\u001f\u007f]/u.test(id)) return null;
  let displayName = request.headers.get('oai-authenticated-user-full-name') || '';
  if (request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { displayName = decodeURIComponent(displayName); } catch { displayName = ''; }
  }
  displayName = displayName.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 100);
  return { id, displayName: displayName || 'Composer' };
}

function requireSameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin ||
      request.headers.get('x-auralis-request') !== '1') {
    throw new ApiError(403, 'Use the same-origin studio to change your library.');
  }
}

async function readJson(request, limit = MAX_BODY) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Expected application/json.');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)) {
    throw new ApiError(413, 'Request body is too large.');
  }
  if (!request.body) throw new ApiError(400, 'Expected a JSON object.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, content = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, 'Request body is too large.');
      }
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Invalid JSON body.');
  } finally {
    reader.releaseLock();
  }
}

function fields(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validateTrack(input) {
  const invalid = () => { throw new ApiError(422, 'Invalid composition fields or note timing.'); };
  if (!fields(input, ['id', 'title', 'bars', 'tempo', 'instrument', 'temperature', 'duration', 'notes'])) invalid();
  const { id, title, bars, tempo, instrument, temperature, duration, notes } = input;
  if (typeof id !== 'string' || !UUID.test(id) || typeof title !== 'string' ||
      !/^[\p{L}\p{N}\p{M} .,'’()&:–—-]{1,100}$/u.test(title) || !title.trim() ||
      ![16, 32].includes(bars) || !Number.isInteger(tempo) || tempo < 40 || tempo > 180 ||
      !['piano', 'synth', 'strings'].includes(instrument) || !Number.isFinite(temperature) ||
      temperature < 0.2 || temperature > 1.5 || !Number.isFinite(duration) ||
      Math.abs(duration - bars * 240 / tempo) > 1e-6 || !Array.isArray(notes) || notes.length > bars * 16) invalid();
  let end = 0;
  const canonicalNotes = notes.map((note) => {
    if (!fields(note, ['pitch', 'start', 'duration', 'velocity'])) invalid();
    const { pitch, start, duration: length, velocity } = note;
    if (!Number.isInteger(pitch) || pitch < 48 || pitch > 84 || !Number.isInteger(velocity) ||
        velocity < 1 || velocity > 127 || !Number.isFinite(start) || start < 0 ||
        start < end - 1e-6 || !Number.isFinite(length) || length <= 0 || start + length > duration + 1e-6) invalid();
    end = start + length;
    return { pitch, start, duration: length, velocity };
  });
  // Canonical fields make retries insensitive to object key ordering.
  return { id: id.toLowerCase(), payload: JSON.stringify({ title: title.trim(), bars, tempo,
    instrument, temperature, duration: bars * 240 / tempo, notes: canonicalNotes }) };
}

function track(row) {
  return { ...JSON.parse(row.payload), id: row.id, created_at: row.created_at, model: 'lstm-synthetic-demo' };
}

function rateError() {
  throw new ApiError(429, 'Library write limit reached. Try again in a minute.', { 'Retry-After': '60' });
}

const COUNT_WRITES = '(SELECT count(*) FROM library_writes WHERE owner_id=?)';
const COUNT_TRACKS = '(SELECT count(*) FROM tracks WHERE owner_id=?)';
const RECORD = 'SELECT id, created_at, payload FROM tracks WHERE owner_id=? AND id=?';

async function save(db, user, input) {
  const { id, payload } = validateTrack(input);
  const now = Date.now(), created = new Date(now).toISOString(), receipt = crypto.randomUUID();
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  // D1 executes batch() in one transaction. A receipt authorizes precisely
  // one write, and deleting a track cannot refund the rate-limit budget.
  const result = await db.batch([
    sql('DELETE FROM library_writes WHERE owner_id=? AND at_ms<=?', user, now - WINDOW_MS),
    sql(`INSERT INTO library_writes(owner_id,receipt,at_ms) SELECT ?,?,?
         WHERE EXISTS(SELECT 1 FROM accounts WHERE user_id=?)
         AND NOT EXISTS(SELECT 1 FROM tracks WHERE owner_id=? AND id=?)
         AND ${COUNT_WRITES}<? AND ${COUNT_TRACKS}<?`, user, receipt, now, user, user, id, user, WRITE_LIMIT, user, MAX_TRACKS),
    sql(`INSERT INTO tracks(owner_id,id,created_at,payload) SELECT ?,?,?,?
         WHERE EXISTS(SELECT 1 FROM library_writes WHERE owner_id=? AND receipt=?)`, user, id, created, payload, user, receipt),
    sql(RECORD, user, id),
    sql(`SELECT ${COUNT_TRACKS} AS count`, user),
  ]);
  const row = result[3].results[0];
  if (row) {
    if (row.payload !== payload) throw new ApiError(409, 'This composition ID already has a different score.');
    return json({ track: track(row) }, result[2].meta.changes === 1 ? 201 : 200);
  }
  if (result[4].results[0].count >= MAX_TRACKS) throw new ApiError(409, 'The library holds 50 compositions. Remove one to save another.');
  rateError();
}

async function remove(db, user, id) {
  const now = Date.now(), receipt = crypto.randomUUID();
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  const result = await db.batch([
    sql('DELETE FROM library_writes WHERE owner_id=? AND at_ms<=?', user, now - WINDOW_MS),
    sql(`INSERT INTO library_writes(owner_id,receipt,at_ms) SELECT ?,?,?
         WHERE EXISTS(SELECT 1 FROM tracks WHERE owner_id=? AND id=?) AND ${COUNT_WRITES}<?`, user, receipt, now, user, id, user, WRITE_LIMIT),
    sql(`DELETE FROM tracks WHERE owner_id=? AND id=? AND EXISTS(
         SELECT 1 FROM library_writes WHERE owner_id=? AND receipt=?)`, user, id, user, receipt),
    sql('SELECT 1 FROM tracks WHERE owner_id=? AND id=?', user, id),
  ]);
  if (result[2].meta.changes === 1) return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (result[3].results.length) rateError();
  throw new ApiError(404, 'Composition not found.');
}

export async function handleApi(request, db) {
  try {
    const path = new URL(request.url).pathname, method = request.method;
    const accountRoute = path === '/api/account', libraryRoute = path === '/api/library';
    const item = /^\/api\/library\/([^/]+)$/.exec(path);
    if (!accountRoute && !libraryRoute && !(item && UUID.test(item[1]))) throw new ApiError(404, 'Route not found.');
    const allowed = item ? ['DELETE'] : ['GET', 'POST'];
    if (!allowed.includes(method)) throw new ApiError(405, 'Method not allowed.', { Allow: allowed.join(', ') });
    const user = visitor(request);
    if (!user) {
      if (accountRoute && method === 'GET') return json({ authenticated: false, hasAccount: false, displayName: null });
      throw new ApiError(401, 'Sign in to use your private library.');
    }
    if (method !== 'GET') requireSameOrigin(request);
    if (accountRoute && method === 'POST') {
      if (!fields(await readJson(request, 256), [])) throw new ApiError(422, 'Expected an empty account object.');
      await db.prepare('INSERT INTO accounts(user_id,created_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING')
        .bind(user.id, new Date().toISOString()).run();
    }
    const account = await db.prepare('SELECT 1 AS present FROM accounts WHERE user_id=?').bind(user.id).first();
    if (accountRoute) return json({ authenticated: true, hasAccount: Boolean(account), displayName: user.displayName });
    if (!account) throw new ApiError(403, 'Create your Auralis profile to use the library.');
    if (item) {
      if (request.body) throw new ApiError(400, 'DELETE does not accept a body.');
      return await remove(db, user.id, item[1].toLowerCase());
    }
    if (method === 'POST') return await save(db, user.id, await readJson(request));
    const result = await db.prepare('SELECT id,created_at,payload FROM tracks WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .bind(user.id, MAX_TRACKS).all();
    return json({ tracks: result.results.map(track) });
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status, error.headers);
    console.error(JSON.stringify({ event: 'auralis_library_unavailable' }));
    return json({ error: 'Library unavailable. Please try again.' }, 503);
  }
}
