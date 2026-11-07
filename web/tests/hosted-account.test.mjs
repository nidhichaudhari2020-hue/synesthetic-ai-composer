import test from 'node:test';
import assert from 'node:assert/strict';
import { readAccount, createAccount, listCloudTracks, saveCloudTrack, removeCloudTrack, signInHref, signOutHref } from '../hosted-account.js';
import { createShowcaseTrack } from '../showcase.js';
import { publicConfigSchema } from '../public-config.js';

test('hosted config contains no external credentials and login paths stay on this site', () => {
  const config = { mode: 'hosted', apiBaseUrl: '', auth0Domain: '', auth0ClientId: '', auth0Audience: '', turnstileSiteKey: '' };
  assert.equal(publicConfigSchema.safeParse(config).success, true);
  assert.equal(publicConfigSchema.safeParse({ ...config, secret: 'private' }).success, false);
  assert.equal(publicConfigSchema.safeParse({ ...config, apiBaseUrl: 'https://other.example' }).success, false);
  for (const href of [signInHref, signOutHref]) {
    const url = new URL(href, 'https://studio.example');
    assert.equal(url.origin, 'https://studio.example');
    assert.ok(url.searchParams.get('return_to').startsWith('/'));
  }
});

test('account adapter uses same-origin requests, refuses redirects and sends no owner or session identity', async (t) => {
  const calls = [], track = { ...createShowcaseTrack(), id: crypto.randomUUID() };
  const account = { authenticated: true, hasAccount: true, displayName: 'Composer' };
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, init });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (path === '/api/account') return Response.json(account);
    return Response.json(init.method === 'POST' ? { track } : { tracks: [track] });
  });
  assert.deepEqual(await readAccount(), account);
  assert.deepEqual(await createAccount(), account);
  assert.deepEqual(await listCloudTracks(), [track]);
  assert.deepEqual(await saveCloudTrack(track), track);
  await removeCloudTrack(track.id);
  for (const { init } of calls) {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, undefined);
    if (init.method !== 'GET') assert.equal(init.headers['X-Auralis-Request'], '1');
  }
  const body = JSON.parse(calls.find(c => c.path === '/api/library' && c.init.method === 'POST').init.body);
  assert.deepEqual(Object.keys(body).sort(), ['id','title','bars','tempo','instrument','temperature','duration','notes'].sort());
});

test('expired sessions, rate limits and malformed successful responses fail visibly', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  await assert.rejects(listCloudTracks, /expired/);
  mock.mock.mockImplementation(async () => new Response(null, { status: 429 }));
  await assert.rejects(() => saveCloudTrack(createShowcaseTrack()), /wait a minute/);
  mock.mock.mockImplementation(async () => Response.json({ authenticated: false, hasAccount: true }));
  await assert.rejects(readAccount);
  mock.mock.mockImplementation(async () => Response.json({ tracks: [{ title: 'incomplete' }] }));
  await assert.rejects(listCloudTracks);
});
