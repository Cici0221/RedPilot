import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginMonitor, LOGIN_MONITOR_SCHEDULE } from '../app/login-monitor.mjs';

const PROFILE_A = '111111111111111111111111';
const PROFILE_B = '222222222222222222222222';
const day = (number, time = '08:00:00') => new Date(`2026-10-${number}T${time}+08:00`);
const account = (id = 'a', profile = PROFILE_A, extra = {}) => ({
  id, name: id === 'a' ? '公司账号' : '普通账号', enabled: true, archived: false,
  profileUrl: `https://www.xiaohongshu.com/user/profile/${profile}`, bridgeAccountId: profile,
  publisherDriver: 'chrome', publisherConnection: { status: 'ready', publishVerified: true }, ...extra
});
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture({ accounts = [account()], check, configured = true, send, now = day(27) } = {}) {
  const state = { accounts: structuredClone(accounts) }, calls = { check: [], send: [], writes: 0 };
  let clock = now, enabled = configured, queue = Promise.resolve();
  const store = {
    rootState: state,
    run(id, fn) { return fn(state); },
    mutate(fn) { const task = queue.then(() => { calls.writes++; return fn(state); }); queue = task.catch(() => {}); return task; }
  };
  const notifier = {
    publicStatus: () => ({ configured: enabled }),
    async send(text, options) { calls.send.push({ text, ...options }); return send ? send(text, options) : { sent: true }; }
  };
  const checkAccount = async (id, options) => {
    calls.check.push({ id, ...options });
    return check ? check(id, options) : { status: 'ready', accountId: state.accounts.find(item => item.id === id).bridgeAccountId };
  };
  const create = () => createLoginMonitor({ store, checkAccount, notifier, clock: () => clock });
  let monitor = create();
  return {
    state, calls, get monitor() { return monitor; },
    setConfigured(value) { enabled = value; },
    async run(date) { clock = date; await monitor.tick(date); await monitor.wait(); },
    async reopen() { await monitor.close(); monitor = create(); await monitor.initialize(); }
  };
}

test('login monitoring uses Beijing 08:00 and persists one claim per day across concurrent ticks and restarts', async () => {
  assert.deepEqual(LOGIN_MONITOR_SCHEDULE, { time: '08:00', timezone: 'Asia/Shanghai' });
  const f = fixture(); await f.monitor.initialize();
  await f.run(day(27, '07:59:59')); assert.equal(f.calls.check.length, 0);
  await Promise.all([f.monitor.tick(day(27)), f.monitor.tick(day(27)), f.monitor.tick(day(27, '08:00:15'))]);
  await f.monitor.wait(); assert.equal(f.calls.check.length, 1);
  assert.equal(f.state.accounts[0].loginMonitor.lastDailyKey, '2026-10-27');
  await f.reopen(); await f.run(day(27, '19:00:00')); assert.equal(f.calls.check.length, 1);
  await f.run(day(28)); assert.equal(f.calls.check.length, 2);
  await f.monitor.close();
});

test('late startup catches only the current day instead of replaying missed days', async () => {
  const f = fixture({ now: day(29, '14:12:00') }); await f.monitor.initialize();
  await f.run(day(29, '14:12:00'));
  assert.equal(f.calls.check.length, 1);
  assert.equal(f.state.accounts[0].loginMonitor.lastDailyKey, '2026-10-29');
  await f.monitor.close();
});

test('restart retries an interrupted queued or running check for the current day, while completed work stays deduplicated', async () => {
  for (const interruptedStatus of ['queued', 'checking']) {
    for (const interruptedDay of ['2026-10-26', '2026-10-27']) {
      const f = fixture(); await f.monitor.initialize();
      Object.assign(f.state.accounts[0].loginMonitor, { lastDailyKey: interruptedDay, status: interruptedStatus });
      await f.reopen();
      assert.equal(f.state.accounts[0].loginMonitor.lastDailyKey, null);
      await f.run(day(27, '10:00:00'));
      assert.equal(f.calls.check.length, 1); assert.equal(f.state.accounts[0].loginMonitor.lastDailyKey, '2026-10-27');
      assert.equal(f.state.accounts[0].loginMonitor.status, 'ready');
      await f.reopen(); await f.run(day(27, '11:00:00'));
      assert.equal(f.calls.check.length, 1, 'a completed check must not rerun on another restart');
      await f.monitor.close();
    }
  }
});

test('idle scheduler ticks do not rewrite persisted state before the daily time or after completion', async () => {
  const f = fixture(); await f.monitor.initialize(); const initialWrites = f.calls.writes;
  await f.run(day(27, '07:00:00')); await f.run(day(27, '07:59:59'));
  assert.equal(f.calls.writes, initialWrites);
  await f.run(day(27)); const completedWrites = f.calls.writes;
  await f.run(day(27, '08:00:15')); await f.run(day(27, '12:00:00'));
  assert.equal(f.calls.writes, completedWrites); await f.monitor.close();
});

test('checks only enabled nonarchived explicitly bound Chrome accounts without changing bindings', async () => {
  const accounts = [account(), account('b', PROFILE_B), account('off', PROFILE_A, { enabled: false }),
    account('archived', PROFILE_A, { archived: true }), account('unbound', PROFILE_A, { bridgeAccountId: '' }),
    account('wrong-binding', PROFILE_A, { bridgeAccountId: PROFILE_B }), account('bridge', PROFILE_A, { publisherDriver: 'bridge' }),
    account('unconfigured', PROFILE_A, { publisherConnection: { status: 'unconfigured' } })];
  const before = accounts.map(a => [a.id, a.bridgeAccountId, a.publisherDriver]);
  const f = fixture({ accounts }); await f.monitor.initialize(); await f.run(day(27));
  assert.deepEqual(f.calls.check.map(c => c.id), ['a', 'b']);
  assert.deepEqual(f.state.accounts.map(a => [a.id, a.bridgeAccountId, a.publisherDriver]), before);
  assert.equal(f.calls.send.length, 0); await f.monitor.close();
});

test('confirmed expiry sends one private alert for a continuous outage, even after restart or the next day', async () => {
  const f = fixture({ check: async () => ({ status: 'needs_login' }) });
  await f.monitor.initialize(); await f.run(day(27));
  assert.equal(f.calls.send.length, 1); assert.match(f.calls.send[0].text, /公司账号/);
  assert.match(f.calls.send[0].text, /重新登录|登录已失效/);
  assert.match(f.calls.send[0].text, /creator\.xiaohongshu\.com/);
  assert.ok(f.calls.send[0].idempotencyKey);
  assert.equal(f.state.accounts[0].loginMonitor.outage.notification.status, 'delivered');
  await f.run(day(27, '20:00:00')); await f.reopen(); await f.run(day(28));
  assert.equal(f.calls.check.length, 2); assert.equal(f.calls.send.length, 1);
  await f.monitor.close();
});

test('verified recovery resets the outage so a later expiry sends a fresh alert', async () => {
  let status = 'needs_login';
  const f = fixture({ check: async () => ({ status, accountId: PROFILE_A }) });
  await f.monitor.initialize(); await f.run(day(27));
  const first = f.calls.send[0].idempotencyKey;
  status = 'ready'; await f.run(day(28));
  assert.equal(f.state.accounts[0].loginMonitor.outage, null);
  status = 'needs_login'; await f.run(day(29));
  assert.equal(f.calls.send.length, 2); assert.notEqual(f.calls.send[1].idempotencyKey, first);
  await f.monitor.close();
});

test('a different logged-in profile is treated as an account mismatch without rebinding either account', async () => {
  const f = fixture({ accounts: [account(), account('b', PROFILE_B)], check: async () => ({ status: 'ready', accountId: PROFILE_B }) });
  await f.monitor.initialize(); await f.run(day(27));
  assert.equal(f.state.accounts[0].loginMonitor.status, 'mismatch');
  assert.equal(f.state.accounts[1].loginMonitor.status, 'ready');
  assert.equal(f.calls.send.length, 1); assert.match(f.calls.send[0].text, /其他账号/);
  assert.equal(f.state.accounts[0].bridgeAccountId, PROFILE_A); assert.equal(f.state.accounts[1].bridgeAccountId, PROFILE_B);
  assert.equal(f.state.accounts[0].publisherConnection.publishVerified, true);
  await f.monitor.close();
});

test('browser unavailability, an unsupported UI, and thrown failures never become an offline alert', async () => {
  for (const result of [{ status: 'unavailable' }, { status: 'blocked' }, { status: 'unsupported' }, null]) {
    const f = fixture({ check: async () => { if (result === null) throw Error('browser disconnected'); return result; } });
    await f.monitor.initialize(); await f.run(day(27));
    assert.equal(f.calls.send.length, 0); assert.equal(f.state.accounts[0].loginMonitor.status, 'failed');
    assert.equal(f.state.accounts[0].loginMonitor.outage, null); await f.monitor.close();
  }
});

test('unconfigured Feishu preserves a pending alert and delivers once credentials become available', async () => {
  const f = fixture({ configured: false, check: async () => ({ status: 'needs_login' }) });
  await f.monitor.initialize(); await f.run(day(27));
  const outageId = f.state.accounts[0].loginMonitor.outage.id;
  assert.equal(f.calls.send.length, 0); assert.equal(f.state.accounts[0].loginMonitor.outage.notification.attempts, 0);
  f.setConfigured(true); await f.run(day(27, '08:05:00'));
  assert.equal(f.calls.check.length, 1); assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0].idempotencyKey, outageId);
  await f.run(day(27, '08:05:15')); assert.equal(f.calls.send.length, 1); await f.monitor.close();
});

test('failed delivery retries with backoff and the same idempotency key without repeating the login check', async () => {
  let succeeds = false;
  const f = fixture({ check: async () => ({ status: 'needs_login' }), send: async () => succeeds ? { sent: true } : { sent: false, reason: 'failed' } });
  await f.monitor.initialize(); await f.run(day(27));
  assert.equal(f.calls.send.length, 1); assert.equal(f.state.accounts[0].loginMonitor.outage.notification.status, 'pending');
  await f.run(day(27, '08:14:59')); assert.equal(f.calls.send.length, 1);
  await f.run(day(27, '08:15:00')); assert.equal(f.calls.send.length, 2);
  await f.run(day(27, '09:14:59')); assert.equal(f.calls.send.length, 2);
  succeeds = true; await f.run(day(27, '09:15:00'));
  assert.equal(f.calls.send.length, 3); assert.equal(f.calls.check.length, 1);
  assert.equal(new Set(f.calls.send.map(c => c.idempotencyKey)).size, 1);
  assert.equal(f.state.accounts[0].loginMonitor.outage.notification.status, 'delivered'); await f.monitor.close();
});

test('tick does not block on browser work, and close waits for an in-flight check without sending after shutdown', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ check: async () => { started.resolve(); await release.promise; return { status: 'needs_login' }; } });
  await f.monitor.initialize(); await f.monitor.tick(day(27)); await started.promise;
  assert.equal(f.calls.check.length, 1);
  let closed = false; const closing = f.monitor.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release.resolve(); await closing;
  assert.equal(closed, true); assert.equal(f.calls.send.length, 0);
  await f.monitor.tick(day(28)); assert.equal(f.calls.check.length, 1);
});

test('restart preserves an interrupted send for a deduplicated retry instead of marking it delivered', async () => {
  const f = fixture({ configured: false, check: async () => ({ status: 'needs_login' }) });
  await f.monitor.initialize(); await f.run(day(27));
  const notification = f.state.accounts[0].loginMonitor.outage.notification;
  notification.status = 'sending'; notification.attempts = 1;
  const outageId = f.state.accounts[0].loginMonitor.outage.id;
  await f.reopen(); f.setConfigured(true); await f.run(day(27, '08:14:59')); assert.equal(f.calls.send.length, 0);
  await f.run(day(27, '08:15:00')); assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0].idempotencyKey, outageId); await f.monitor.close();
});

test('a check crossing midnight does not consume the following day before that day can be checked', async () => {
  const started = deferred(), release = deferred(); let first = true;
  const f = fixture({ check: async () => {
    if (first) { first = false; started.resolve(); await release.promise; }
    return { status: 'ready', accountId: PROFILE_A };
  } });
  await f.monitor.initialize(); await f.monitor.tick(day(27, '23:59:59')); await started.promise;
  await f.monitor.tick(day(28));
  assert.equal(f.state.accounts[0].loginMonitor.lastDailyKey, '2026-10-27');
  release.resolve(); await f.monitor.wait();
  await f.run(day(28, '08:00:15'));
  assert.equal(f.calls.check.length, 2); assert.equal(f.state.accounts[0].loginMonitor.lastDailyKey, '2026-10-28');
  assert.equal(f.state.accounts[0].loginMonitor.status, 'ready'); await f.monitor.close();
});

test('a new failed browser check pauses a pending stale alert until expiry is confirmed again', async () => {
  let status = 'needs_login';
  const f = fixture({ configured: false, check: async () => ({ status }) });
  await f.monitor.initialize(); await f.run(day(27));
  const outageId = f.state.accounts[0].loginMonitor.outage.id;
  f.setConfigured(true); status = 'unavailable'; await f.run(day(28));
  assert.equal(f.calls.send.length, 0); assert.equal(f.state.accounts[0].loginMonitor.outage.notification.status, 'pending');
  await f.run(day(28, '09:00:00')); assert.equal(f.calls.send.length, 0);
  status = 'needs_login'; await f.run(day(29));
  assert.equal(f.calls.send.length, 1); assert.equal(f.calls.send[0].idempotencyKey, outageId);
  await f.monitor.close();
});

test('temporary check failures retry at five and fifteen minutes, then notify once without claiming logout', async () => {
  let status = 'unavailable';
  const f = fixture({check: async () => ({status, accountId: PROFILE_A})});
  await f.monitor.initialize(); await f.run(day(27));
  assert.equal(f.calls.check.length, 1); assert.equal(f.calls.send.length, 0);
  await f.run(day(27, '08:04:59')); assert.equal(f.calls.check.length, 1);
  await f.run(day(27, '08:05:00')); assert.equal(f.calls.check.length, 2);
  await f.run(day(27, '08:19:59')); assert.equal(f.calls.check.length, 2);
  await f.run(day(27, '08:20:00')); assert.equal(f.calls.check.length, 3); assert.equal(f.calls.send.length, 1);
  assert.match(f.calls.send[0].text, /检查未完成/); assert.match(f.calls.send[0].text, /尚不能判断/);
  assert.doesNotMatch(f.calls.send[0].text, /登录已失效/);
  const incident = f.state.accounts[0].loginMonitor.checkFailure.id;
  await f.reopen(); await f.run(day(27, '09:20:00')); assert.equal(f.calls.check.length, 4); assert.equal(f.calls.send.length, 1);
  await f.run(day(28)); assert.equal(f.calls.send.length, 1); assert.equal(f.state.accounts[0].loginMonitor.checkFailure.id, incident);
  status = 'ready'; await f.run(day(28, '08:05:00'));
  assert.equal(f.state.accounts[0].loginMonitor.status, 'ready'); assert.equal(f.state.accounts[0].loginMonitor.checkFailure, null);
  assert.equal(f.state.accounts[0].loginMonitor.nextCheckAt, null);
  await f.monitor.close();
});

test('successful same-day recheck ends retries without a notification', async () => {
  let status = 'unavailable';
  const f = fixture({check: async () => ({status, accountId: PROFILE_A})});
  await f.monitor.initialize(); await f.run(day(27));
  status = 'ready'; await f.run(day(27, '08:05:00')); await f.run(day(27, '20:00:00'));
  assert.equal(f.calls.check.length, 2); assert.equal(f.calls.send.length, 0); assert.equal(f.state.accounts[0].loginMonitor.status, 'ready');
  await f.monitor.close();
});

test('failed-check incidents do not replace confirmed logout incidents or send stale failures after recovery', async () => {
  let status = 'unavailable';
  const f = fixture({configured: false, check: async () => ({status, accountId: PROFILE_A})});
  await f.monitor.initialize(); await f.run(day(27)); await f.run(day(27, '08:05:00')); await f.run(day(27, '08:20:00'));
  assert.ok(f.state.accounts[0].loginMonitor.checkFailure);
  status = 'needs_login'; await f.run(day(27, '09:20:00'));
  assert.equal(f.state.accounts[0].loginMonitor.checkFailure, null);
  assert.ok(f.state.accounts[0].loginMonitor.outage);
  f.setConfigured(true); await f.run(day(27, '09:21:00'));
  assert.equal(f.calls.send.length, 1); assert.match(f.calls.send[0].text, /需要重新登录/);
  await f.monitor.close();
});

test('concurrent retry ticks claim only one new check and do not rewrite state between retry times', async () => {
  const f = fixture({check: async () => ({status: 'unavailable'})});
  await f.monitor.initialize(); await f.run(day(27)); const count = f.calls.writes;
  await f.run(day(27, '08:01:00')); await f.run(day(27, '08:04:00')); assert.equal(f.calls.writes, count);
  await Promise.all([f.monitor.tick(day(27,'08:05:00')), f.monitor.tick(day(27,'08:05:00'))]); await f.monitor.wait();
  assert.equal(f.calls.check.length, 2); await f.monitor.close();
});
