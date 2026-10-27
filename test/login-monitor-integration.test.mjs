import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureAuth } from '../app/auth.mjs';
import { createApp } from '../app/server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PROFILE = '111111111111111111111111';
const OTHER = '222222222222222222222222';
const day = (number, time = '08:00:00') => new Date(`2026-10-${number}T${time}+08:00`);
async function fixture(t, { notificationClose } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-login-monitor-'));
  const credentials = { email: 'login-monitor-fixture@example.test', password: 'Fixture-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  const calls = { check: [], publish: [], verify: [], configure: [], send: [], notificationClose: 0 };
  let checkResult = { status: 'ready', accountId: PROFILE, image: true };
  let notificationStatus = { configured: false, status: 'unconfigured', appId: '', receiveId: '', receiveIdType: 'email' };
  const app = await createApp({ root, directory, env: {}, loginMonitorClock: () => day(27, '07:00:00'),
    fetcher: async () => { throw Error('This fixture must never contact an external service'); },
    feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [] }),
    trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [] }),
    xhsPublisher: {
      async checkConnection(id) { calls.check.push(id); return structuredClone(checkResult); },
      async publish(input) { calls.publish.push(input); throw Error('monitor must not publish'); },
      async verify(input) { calls.verify.push(input); throw Error('monitor must not verify notes'); },
      async close() {}
    },
    notifications: {
      publicStatus: () => ({ ...notificationStatus }),
      async configure(input) { calls.configure.push(input); notificationStatus = { configured: true, status: 'untested', appId: input.appId, receiveId: input.receiveId, receiveIdType: input.receiveIdType }; return { ...notificationStatus }; },
      async send(text, options) { calls.send.push({ text, ...options }); return { sent: true, messageId: 'test-message' }; },
      async close() { calls.notificationClose++; await notificationClose?.(); }
    }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  let closePromise;
  const close = () => closePromise ||= app.close();
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (endpoint, data, method = 'POST', { authenticated = true, origin = base } = {}) => {
    const response = await fetch(base + '/api/' + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  return { app, calls, request, close, setCheck: value => { checkResult = value; }, get account() { return app.store.rootState.accounts[0]; } };
}
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const configuration = { appId: 'cli_monitor_fixture', appSecret: 'fixture-secret-never-in-state', receiveId: 'owner@example.test', receiveIdType: 'email' };

test('Feishu configuration and explicit test endpoints require authentication and same-origin writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('notifications/feishu', undefined, 'GET', { authenticated: false })).status, 401);
  assert.equal((await f.request('notifications/feishu', configuration, 'PUT', { authenticated: false })).status, 401);
  assert.equal((await f.request('notifications/feishu', configuration, 'PUT', { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.request('notifications/feishu/test', {}, 'POST', { authenticated: false })).status, 401);
  assert.equal((await f.request('notifications/feishu/test', {}, 'POST', { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal(f.calls.configure.length, 0); assert.equal(f.calls.send.length, 0);
  const saved = ok(await f.request('notifications/feishu', configuration, 'PUT'));
  assert.equal(saved.configured, true); assert.ok(!JSON.stringify(saved).includes(configuration.appSecret));
  assert.equal(f.calls.configure.length, 1); assert.equal(f.calls.send.length, 0, 'saving credentials must not send a test');
  const state = ok(await f.request('state', undefined, 'GET'));
  assert.equal(state.connections.feishuNotifications.configured, true);
  assert.ok(!JSON.stringify(state).includes(configuration.appSecret));
  assert.equal(ok(await f.request('notifications/feishu/test', {})).sent, true);
  assert.equal(f.calls.send.length, 1); assert.match(f.calls.send[0].text, /测试/);
  assert.equal(f.calls.publish.length, 0); assert.equal(f.calls.verify.length, 0);
});

test('scheduled login checks update the bound account and notify expiry without publishing or losing verified history', async t => {
  const f = await fixture(t), id = f.account.id;
  ok(await f.request(`accounts/${id}`, { name: '公司账号', profileUrl: `https://www.xiaohongshu.com/user/profile/${PROFILE}` }, 'PUT'));
  assert.equal(ok(await f.request(`accounts/${id}/connect-publisher`, {})).status, 'ready');
  await f.app.store.mutate(s => { const account = s.accounts.find(item => item.id === id); account.publisherConnection.publishVerified = true; account.publisherConnection.lastPublishedAt = '2026-10-26T00:00:00.000Z'; });
  ok(await f.request('notifications/feishu', configuration, 'PUT'));
  f.setCheck({ status: 'needs_login', accountId: null });
  await f.app.tick(day(27, '07:59:59')); await f.app.loginMonitor.wait(); assert.equal(f.calls.check.length, 1);
  await f.app.tick(day(27)); await f.app.loginMonitor.wait();
  assert.equal(f.calls.check.length, 2); assert.equal(f.calls.send.length, 1);
  assert.equal(f.account.bridgeAccountId, PROFILE); assert.equal(f.account.publisherDriver, 'chrome');
  assert.equal(f.account.publisherConnection.status, 'needs_login');
  assert.equal(f.account.publisherConnection.publishVerified, true); assert.equal(f.account.publisherConnection.lastPublishedAt, '2026-10-26T00:00:00.000Z');
  assert.equal(f.account.loginMonitor.outage.notification.status, 'delivered');
  assert.equal(f.calls.publish.length, 0); assert.equal(f.calls.verify.length, 0);
  await f.app.tick(day(27, '08:01:00')); await f.app.loginMonitor.wait(); assert.equal(f.calls.send.length, 1);
});

test('manual login recovery clears a pending outage and a different profile cannot silently rebind the target', async t => {
  const f = await fixture(t), id = f.account.id;
  ok(await f.request(`accounts/${id}`, { profileUrl: `https://www.xiaohongshu.com/user/profile/${PROFILE}` }, 'PUT'));
  ok(await f.request(`accounts/${id}/connect-publisher`, {}));
  f.setCheck({ status: 'needs_login' }); await f.app.tick(day(27)); await f.app.loginMonitor.wait();
  assert.equal(f.account.loginMonitor.outage.notification.status, 'pending'); assert.equal(f.calls.send.length, 0);
  f.setCheck({ status: 'ready', accountId: PROFILE, image: true });
  ok(await f.request(`accounts/${id}/connect-publisher`, {}));
  assert.equal(f.account.loginMonitor.outage, null);
  ok(await f.request('notifications/feishu', configuration, 'PUT'));
  await f.app.tick(day(27, '08:01:00')); await f.app.loginMonitor.wait(); assert.equal(f.calls.send.length, 0);
  f.setCheck({ status: 'ready', accountId: OTHER, image: true });
  await f.app.tick(day(28)); await f.app.loginMonitor.wait();
  assert.equal(f.account.publisherConnection.status, 'mismatch'); assert.equal(f.account.bridgeAccountId, PROFILE);
  assert.equal(f.calls.send.length, 1); assert.match(f.calls.send[0].text, /其他账号/);
  assert.equal(f.calls.publish.length, 0); assert.equal(f.calls.verify.length, 0);
});

test('application shutdown waits for the notification channel to close', async t => {
  let started, release;
  const start = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { notificationClose: async () => { started(); await pending; } });
  let closed = false; const closing = f.close().then(() => { closed = true; });
  try {
    await start; assert.equal(f.calls.notificationClose, 1);
    await Promise.resolve(); assert.equal(closed, false);
  } finally { release(); }
  await closing; assert.equal(closed, true);
});
