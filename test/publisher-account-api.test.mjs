import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PROFILE_A = '111111111111111111111111';
const PROFILE_B = '222222222222222222222222';
const profileUrl = id => `https://www.xiaohongshu.com/user/profile/${id}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
async function waitFor(fn, label) {
  for (let n = 0; n < 200; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(label);
}
const performance = (accountId, views = 31) => ({ status: 'partial', accountId, period: { start: '2026-10-21', end: '2026-10-27' },
  summary: { views, likes: 4, comments: null }, notes: [], readAt: '2026-10-28T01:00:00.000Z' });

// All platform access is injected. These regressions never launch Chrome, publish, or send messages.
async function fixture(t, { readPerformance, openLogin, beforeClose } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-publisher-account-api-'));
  const credentials = { email: 'session-api@example.test', password: 'Fixture-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  const calls = { check: [], login: [], performance: [], publish: [], send: [] };
  const app = await createApp({ root, directory, env: {},
    fetcher: async () => { throw Error('Unexpected external request'); },
    trendReader: async () => [], feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [] }),
    linkReader: async () => ({ status: 'unavailable', missing: [] }),
    xhsPublisher: {
      async checkConnection(id, options) { calls.check.push({ id, ...options }); return { status: 'ready', accountId: id, image: true, text: true }; },
      async openLogin(id, options) { calls.login.push({ id, ...options }); return openLogin ? openLogin(id, options) : { sessionId: id, mode: 'isolated', opened: true }; },
      async readPerformance(id, options) { calls.performance.push({ id, ...options }); return readPerformance ? readPerformance(id, options) : performance(id); },
      async publish(input) { calls.publish.push(input); throw Error('Read-only API test must not publish'); },
      async verify() { throw Error('Read-only API test must not verify publication'); }, async close() {}
    },
    notifications: { publicStatus: () => ({ configured: false, status: 'unconfigured' }),
      async send(input) { calls.send.push(input); throw Error('Read-only API test must not send'); }, async close() {} }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  t.after(async () => { beforeClose?.(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (workspaceId, endpoint, data, method = 'POST', { authenticated = true, origin = base } = {}) => {
    const response = await fetch(base + '/api/' + endpoint, { method, signal: AbortSignal.timeout(5000),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}), ...(workspaceId ? { 'X-RedPilot-Account': workspaceId } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const state = async workspaceId => ok(await request(workspaceId, 'state', undefined, 'GET'));
  const initial = await state(), owner = initial.workspaceAccountId || initial.defaultAccountId;
  ok(await request(owner, `accounts/${owner}`, { profileUrl: profileUrl(PROFILE_A) }, 'PUT'));
  const secondary = ok(await request(owner, 'accounts', { name: '测试小号', type: 'personal', profileUrl: profileUrl(PROFILE_B) })).id;
  return { app, calls, request, state, owner, secondary };
}

test('account checks and login windows always use the selected local account session', async t => {
  const f = await fixture(t);
  // The account menu may be opened from another workspace; the explicit route owns the action.
  assert.equal(ok(await f.request(f.owner, `accounts/${f.secondary}/connect-publisher`, {})).status, 'ready');
  assert.equal(ok(await f.request(f.secondary, `accounts/${f.owner}/connect-publisher`, {})).status, 'ready');
  assert.deepEqual(f.calls.check, [{ id: PROFILE_B, sessionId: f.secondary }, { id: PROFILE_A, sessionId: f.owner }]);
  ok(await f.request(f.owner, `accounts/${f.secondary}/open-login`, {}));
  ok(await f.request(f.secondary, `accounts/${f.owner}/open-login`, { isolated: true }));
  assert.deepEqual(f.calls.login, [{ id: f.secondary, isolated: false }, { id: f.owner, isolated: true }]);
  const a = await f.state(f.owner), b = await f.state(f.secondary);
  assert.equal(a.workspaceAccountId, f.owner); assert.equal(b.workspaceAccountId, f.secondary);
  for (const [id, target] of [[f.owner, PROFILE_A], [f.secondary, PROFILE_B]]) {
    const account = a.accounts.find(item => item.id === id);
    assert.equal(account.bridgeAccountId, target); assert.equal(account.publisherConnection.text, true);
  }
  assert.deepEqual(f.calls.publish, []); assert.deepEqual(f.calls.send, []);
});

test('login migration is explicit and failed legacy access returns a usable migration result', async t => {
  const f = await fixture(t, { openLogin: async (id, options) => {
    if (!options.isolated) throw Object.assign(Error('sensitive internal browser details'), { code: 'legacy_disconnected', canMigrate: true });
    return { sessionId: id, mode: 'isolated', opened: true, migrated: true };
  } });
  const failed = await f.request(f.owner, `accounts/${f.owner}/open-login`, {});
  assert.equal(failed.status, 409); assert.equal(failed.data.code, 'legacy_disconnected'); assert.equal(failed.data.canMigrate, true);
  assert.ok(!JSON.stringify(failed.data).includes('sensitive')); assert.equal(f.calls.login.length, 1, 'no automatic migration retry');
  const migrated = ok(await f.request(f.owner, `accounts/${f.owner}/open-login`, { isolated: true }));
  assert.equal(migrated.migrated, true); assert.equal(migrated.sessionId, f.owner);
});

test('login and performance endpoints reject unauthenticated and cross-origin calls before touching a browser', async t => {
  const f = await fixture(t);
  for (const action of ['open-login', 'performance']) {
    assert.equal((await f.request(f.owner, `accounts/${f.owner}/${action}`, {}, 'POST', { authenticated: false })).status, 401);
    assert.equal((await f.request(f.owner, `accounts/${f.owner}/${action}`, {}, 'POST', { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await f.request(f.owner, `accounts/missing-account/${action}`, {})).status, 404);
  }
  assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.performance, []); assert.deepEqual(f.calls.publish, []);
});

test('delayed performance reads remain in the originating workspace and duplicate requests are coalesced', async t => {
  const gate = deferred();
  const f = await fixture(t, { beforeClose: () => gate.resolve(), readPerformance: async id => { if (id === PROFILE_A) await gate.promise; return performance(id, id === PROFILE_A ? 31 : 87); } });
  ok(await f.request(f.owner, `accounts/${f.owner}/performance`, {}));
  await waitFor(() => f.calls.performance.length === 1, 'A read did not start');
  ok(await f.request(f.secondary, `accounts/${f.owner}/performance`, {}));
  ok(await f.request(f.secondary, `accounts/${f.secondary}/performance`, {}));
  assert.equal((await f.state(f.secondary)).performance, null, 'no A result in B while loading');
  ok(await f.request(f.secondary, `accounts/${f.secondary}`, { name: '读取时可以编辑' }, 'PUT'));
  gate.resolve();
  await waitFor(async () => (await f.state(f.secondary)).performance?.summary?.views === 87, 'B read did not complete');
  const [a, b] = await Promise.all([f.state(f.owner), f.state(f.secondary)]);
  assert.deepEqual(f.calls.performance, [{ id: PROFILE_A, sessionId: f.owner }, { id: PROFILE_B, sessionId: f.secondary }]);
  assert.equal(a.performance.summary.views, 31); assert.equal(b.performance.summary.views, 87);
  assert.equal(a.performance.accountId, PROFILE_A); assert.equal(b.performance.accountId, PROFILE_B);
  assert.equal(a.performance.summary.impressions, null); assert.equal(a.performance.summary.comments, null);
  assert.deepEqual(a.performance.period, { start: '2026-10-21', end: '2026-10-27' });
  assert.deepEqual(f.calls.publish, []); assert.deepEqual(f.calls.send, []);
});

test('performance failures retain a clearly stale last result and never accept another profile metrics', async t => {
  let result = performance(PROFILE_A);
  const f = await fixture(t, { readPerformance: async id => id === PROFILE_A ? structuredClone(result) : performance(id) });
  const refresh = () => f.request(f.owner, `accounts/${f.owner}/performance`, {}).then(ok);
  await refresh(); await waitFor(async () => (await f.state(f.owner)).performance?.status === 'partial', 'first performance did not finish');
  // Finish the initial queue claim before requesting another read of the same account.
  ok(await f.request(f.secondary, `accounts/${f.secondary}/performance`, {}));
  await waitFor(async () => (await f.state(f.secondary)).performance?.status === 'partial', 'queue fence did not finish');
  result = performance(PROFILE_B, 9999);
  await refresh();
  await waitFor(async () => (await f.state(f.owner)).performance?.status === 'unavailable', 'mismatch result not rejected');
  const stale = (await f.state(f.owner)).performance;
  assert.equal(stale.summary.views, 31); assert.equal(stale.accountId, PROFILE_A);
  assert.equal(stale.readAt, '2026-10-28T01:00:00.000Z'); assert.ok(stale.attemptedAt);
  assert.equal((await f.state(f.secondary)).performance.accountId, PROFILE_B);
});

test('profile changes during a performance read discard the previous profile result', async t => {
  const gate = deferred();
  const f = await fixture(t, { beforeClose: () => gate.resolve(), readPerformance: async id => { await gate.promise; return performance(id); } });
  ok(await f.request(f.owner, `accounts/${f.owner}/performance`, {}));
  await waitFor(() => f.calls.performance.length === 1, 'performance read did not start');
  ok(await f.request(f.owner, `accounts/${f.owner}`, { profileUrl: profileUrl('333333333333333333333333') }, 'PUT'));
  gate.resolve();
  // Queue a B read as a completion fence for the shared performance queue.
  ok(await f.request(f.secondary, `accounts/${f.secondary}/performance`, {}));
  await waitFor(async () => (await f.state(f.secondary)).performance?.status === 'partial', 'completion fence did not finish');
  assert.equal((await f.state(f.owner)).performance, null);
});

test('changing the official profile clears the previous profile metrics and its daily refresh claim', async t => {
  const f = await fixture(t);
  ok(await f.request(f.owner, `accounts/${f.owner}/performance`, {}));
  await waitFor(async () => (await f.state(f.owner)).performance?.status === 'partial', 'first performance did not finish');
  await f.app.store.mutate(s => { s.accounts.find(item => item.id === f.owner).performanceDailyKey = '2026-10-28'; });
  ok(await f.request(f.owner, `accounts/${f.owner}`, { profileUrl: profileUrl('333333333333333333333333') }, 'PUT'));
  const current = await f.state(f.owner);
  assert.equal(current.performance, null, 'previous profile statistics must not follow a new official profile');
  assert.ok(!current.accounts.find(item => item.id === f.owner).performanceDailyKey);
});

test('a failed read for the previous profile cannot overwrite the newly selected profile', async t => {
  const gate = deferred();
  const f = await fixture(t, { beforeClose: () => gate.resolve(), readPerformance: async id => {
    if (id === PROFILE_A) { await gate.promise; throw Error('old profile browser disconnected'); }
    return performance(id);
  } });
  ok(await f.request(f.owner, `accounts/${f.owner}/performance`, {}));
  await waitFor(() => f.calls.performance.length === 1, 'performance read did not start');
  ok(await f.request(f.owner, `accounts/${f.owner}`, { profileUrl: profileUrl('333333333333333333333333') }, 'PUT'));
  gate.resolve();
  ok(await f.request(f.secondary, `accounts/${f.secondary}/performance`, {}));
  await waitFor(async () => (await f.state(f.secondary)).performance?.status === 'partial', 'completion fence did not finish');
  assert.equal((await f.state(f.owner)).performance, null);
});

test('09:00 performance refresh checks each account in its own session once per Beijing day', async t => {
  const f = await fixture(t);
  for (const id of [f.owner, f.secondary]) ok(await f.request(id, `accounts/${id}/connect-publisher`, {}));
  await f.app.tick(new Date('2033-05-08T08:59:00+08:00')); await f.app.loginMonitor.wait();
  assert.equal(f.calls.performance.length, 0);
  await f.app.tick(new Date('2033-05-08T09:00:00+08:00')); await f.app.loginMonitor.wait();
  await waitFor(async () => (await f.state(f.secondary)).performance?.status === 'partial', 'daily reads did not finish');
  await f.app.tick(new Date('2033-05-08T09:01:00+08:00')); await f.app.loginMonitor.wait();
  assert.deepEqual(f.calls.performance, [{ id: PROFILE_A, sessionId: f.owner }, { id: PROFILE_B, sessionId: f.secondary }]);
  assert.ok(f.calls.check.every(item => item.sessionId === (item.id === PROFILE_A ? f.owner : f.secondary)));
  assert.deepEqual(f.calls.publish, []); assert.deepEqual(f.calls.send, []);
});
