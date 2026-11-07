import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { handleApi } from '../api.js';

const ORIGIN = 'https://studio.example';

// Executes the handler's real SQL in SQLite. The adapter supplies D1's result
// envelope and transactional batch semantics; it never encodes tenant rules.
function database() {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys=ON;');
  native.exec(readFileSync(new URL('../drizzle/0000_demonic_hammerhead.sql', import.meta.url), 'utf8'));
  return {
    native,
    prepare(query) {
      return { bind(...parameters) {
        const statement = native.prepare(query);
        return {
          first() { return statement.get(...parameters) ?? null; },
          all() { return { results: statement.all(...parameters), meta: { changes: 0 } }; },
          run() { return { results: [], meta: { changes: statement.run(...parameters).changes } }; },
          execute() { return /^\s*SELECT/i.test(query) ? this.all() : this.run(); },
        };
      } };
    },
    batch(statements) {
      native.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement) => statement.execute());
        native.exec('COMMIT');
        return result;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function fixture(t) {
  const db = database();
  t.after(() => db.native.close());
  return db;
}

function call(db, user, path, method = 'GET', body, extra = {}) {
  const headers = new Headers({ origin: ORIGIN, 'X-Auralis-Request': '1', ...extra });
  if (user) headers.set('oai-authenticated-user-id', user);
  const init = { method, headers };
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return handleApi(new Request(ORIGIN + path, init), db);
}

function score(id = crypto.randomUUID()) {
  return { id, title: 'A quiet study', bars: 16, tempo: 96, temperature: 0.85, duration: 40,
    instrument: 'piano', notes: [{ pitch: 60, start: 0, duration: 0.3125, velocity: 94 }] };
}

async function register(db, user) {
  assert.equal((await call(db, user, '/api/account', 'POST', {})).status, 200);
}

test('viewing the account never creates it and registering twice is harmless', async (t) => {
  const db = fixture(t);
  const guest = await call(db, null, '/api/account');
  assert.deepEqual(await guest.json(), { authenticated: false, hasAccount: false, displayName: null });
  assert.equal(guest.headers.get('cache-control'), 'private, no-store');
  const before = await call(db, 'alice', '/api/account', 'GET', undefined, {
    'oai-authenticated-user-full-name': 'Zo%C3%AB', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
  });
  assert.deepEqual(await before.json(), { authenticated: true, hasAccount: false, displayName: 'Zoë' });
  assert.equal((await call(db, 'alice', '/api/library')).status, 403);
  await Promise.all([register(db, 'alice'), register(db, 'alice')]);
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal((await (await call(db, 'alice', '/api/account')).json()).hasAccount, true);
});

test('only the caller can list or delete a record, even when client IDs collide', async (t) => {
  const db = fixture(t);
  await register(db, 'alice'); await register(db, 'bob');
  const original = score();
  const saved = await call(db, 'alice', '/api/library', 'POST', original);
  assert.equal(saved.status, 201);
  const { track } = await saved.json();
  assert.equal(track.model, 'lstm-synthetic-demo');
  assert.ok(Number.isFinite(Date.parse(track.created_at)));
  assert.equal(track.owner_id, undefined);
  const bobList = await call(db, 'bob', '/api/library?owner_id=alice', 'GET', undefined, { 'x-owner-id': 'alice' });
  assert.deepEqual(await bobList.json(), { tracks: [] });
  assert.equal((await call(db, 'bob', `/api/library/${original.id}`, 'DELETE')).status, 404);
  assert.equal((await call(db, 'bob', '/api/library', 'POST', { ...original, title: 'Bob’s score' })).status, 201);
  assert.equal((await call(db, 'bob', `/api/library/${original.id}`, 'DELETE')).status, 204);
  assert.deepEqual((await (await call(db, 'alice', '/api/library')).json()).tracks, [track]);
});

test('concurrent identical retries persist one score and consume one receipt', async (t) => {
  const db = fixture(t); await register(db, 'alice');
  const input = score();
  const requests = await Promise.all(Array.from({ length: 12 }, () => call(db, 'alice', '/api/library', 'POST', input)));
  assert.equal(requests.filter((r) => r.status === 201).length, 1);
  assert.equal(requests.filter((r) => r.status === 200).length, 11);
  const conflict = await call(db, 'alice', '/api/library', 'POST', { ...input, title: 'Different score' });
  assert.equal(conflict.status, 409);
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM library_writes').get().n, 1);
});

test('simultaneous saves cannot exceed 10/min, and deletion cannot refund a write', async (t) => {
  const db = fixture(t); await register(db, 'alice'); await register(db, 'bob');
  const initial = score();
  await call(db, 'alice', '/api/library', 'POST', initial);
  assert.equal((await call(db, 'alice', `/api/library/${initial.id}`, 'DELETE')).status, 204);
  const results = await Promise.all(Array.from({ length: 20 }, () => call(db, 'alice', '/api/library', 'POST', score())));
  assert.equal(results.filter((r) => r.status === 201).length, 8);
  assert.equal(results.filter((r) => r.status === 429 && r.headers.get('retry-after') === '60').length, 12);
  assert.equal((await call(db, 'bob', '/api/library', 'POST', score())).status, 201);
  db.native.prepare('UPDATE library_writes SET at_ms=? WHERE owner_id=?').run(Date.now() - 60_100, 'alice');
  assert.equal((await call(db, 'alice', '/api/library', 'POST', score())).status, 201);
});

test('concurrent saves at capacity never exceed the account limit', async (t) => {
  const db = fixture(t); await register(db, 'alice');
  for (let i = 0; i < 49; i++) {
    const row = score();
    const { id, ...payload } = row;
    db.native.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run('alice', id, new Date().toISOString(), JSON.stringify(payload));
  }
  const results = await Promise.all(Array.from({ length: 10 }, () => call(db, 'alice', '/api/library', 'POST', score())));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal((await (await call(db, 'alice', '/api/library')).json()).tracks.length, 50);
});

test('anonymous, cross-origin, missing custom header and ownership injection attempts fail', async (t) => {
  const db = fixture(t);
  assert.equal((await call(db, null, '/api/account', 'POST', {}, { 'x-owner-id': 'alice' })).status, 401);
  for (const headers of [{ origin: 'https://other.example' }, { 'X-Auralis-Request': '' }, { origin: 'null' }]) {
    assert.equal((await call(db, 'alice', '/api/account', 'POST', {}, headers)).status, 403);
  }
  await register(db, 'alice');
  assert.equal((await call(db, 'alice', '/api/account', 'POST', { owner_id: 'bob' })).status, 422);
  const good = score();
  for (const change of [{ id: '../../account' }, { owner: 'bob' }, { created_at: 'fake' }, { model: 'production' },
    { bars: 64 }, { duration: 400 }, { title: '<script>' }, { notes: [{ ...good.notes[0], start: 41 }] },
    { notes: [{ ...good.notes[0], pitch: 1000 }] }, { notes: [{ ...good.notes[0], owner_id: 'bob' }] }]) {
    assert.equal((await call(db, 'alice', '/api/library', 'POST', { ...good, ...change })).status, 422);
  }
  assert.equal((await call(db, 'alice', '/api/library', 'POST', { ...good, title: 'x'.repeat(65536) })).status, 413);
  const wrongType = new Request(ORIGIN + '/api/library', { method: 'POST', body: '{}', headers: {
    origin: ORIGIN, 'x-auralis-request': '1', 'oai-authenticated-user-id': 'alice', 'content-type': 'text/plain',
  } });
  assert.equal((await handleApi(wrongType, db)).status, 415);
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 0);
});
