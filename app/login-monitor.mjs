import { randomUUID } from 'node:crypto';
import { dateParts, dailyKey } from './content.mjs';

export const LOGIN_MONITOR_SCHEDULE = Object.freeze({ time: '08:00', timezone: 'Asia/Shanghai' });
const offline = status => ['needs_login', 'mismatch'].includes(status);
const retryDelays = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export function publisherProfileId(account) {
  return String(account?.profileUrl || '').match(/^https:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/([a-f\d]{24})(?:[/?#]|$)/i)?.[1]?.toLowerCase() || null;
}
const targetKey = account => `${account.publisherDriver || ''}:${publisherProfileId(account) || ''}:${account.bridgeAccountId || ''}`;
const connected = account => account.publisherDriver === 'chrome' && Boolean(publisherProfileId(account))
  && account.bridgeAccountId === publisherProfileId(account) && account.publisherConnection?.status !== 'unconfigured';
const eligible = account => account.enabled && !account.archived && connected(account);
const emptyState = account => ({ ...LOGIN_MONITOR_SCHEDULE, targetKey: targetKey(account), lastDailyKey: null,
  status: 'unchecked', checkedAt: null, error: null, outage: null });
const safeName = account => String(account.name || account.handle || '小红书账号').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);

// Browser work and notification delivery never run while holding a store transaction.
export function createLoginMonitor({ store, checkAccount, notifier, clock = () => new Date() }) {
  let checks = Promise.resolve(), deliveries = Promise.resolve(), closing = false;
  const checking = new Set(), sending = new Set();
  const dateNow = () => new Date(clock());
  const stateFor = account => {
    if (!account.loginMonitor || account.loginMonitor.targetKey !== targetKey(account)) account.loginMonitor = emptyState(account);
    Object.assign(account.loginMonitor, LOGIN_MONITOR_SCHEDULE);
    return account.loginMonitor;
  };
  const configured = () => { try { return notifier?.publicStatus?.().configured === true; } catch { return false; } };
  async function initialize() {
    const at = dateNow();
    await store.mutate(s => {
      for (const account of s.accounts) {
        if (!account.loginMonitor && !connected(account)) continue;
        const monitor = stateFor(account);
        if (['queued', 'checking'].includes(monitor.status)) Object.assign(monitor, { lastDailyKey: null, status: 'failed', error: '服务重启，将补查当天登录状态' });
        if (monitor.outage?.notification?.status === 'sending') Object.assign(monitor.outage.notification, {
          status: 'pending', nextAttemptAt: new Date(at.getTime() + retryDelays[0]).toISOString(), error: '提醒发送结果未确认，稍后核对重试'
        });
      }
    });
  }
  function pumpDelivery(accountId, date) {
    if (closing || sending.has(accountId) || !configured()) return;
    const account = store.rootState.accounts.find(item => item.id === accountId), monitor = account?.loginMonitor;
    const notification = monitor?.outage?.notification;
    if (!account || !monitor || !eligible(account) || monitor.targetKey !== targetKey(account) || !offline(monitor.status)
      || !notification || notification.status !== 'pending' || notification.nextAttemptAt && new Date(notification.nextAttemptAt) > date) return;
    sending.add(accountId);
    const task = deliveries.catch(() => {}).then(() => store.run(accountId, async () => {
      if (!configured()) return;
      const request = await store.mutate(s => {
        const account = s.accounts.find(item => item.id === accountId), monitor = account?.loginMonitor, outage = monitor?.outage;
        if (!account || !monitor || !eligible(account) || monitor.targetKey !== targetKey(account) || !offline(monitor.status)
          || !outage || outage.notification.status !== 'pending' || outage.notification.nextAttemptAt && new Date(outage.notification.nextAttemptAt) > date) return null;
        Object.assign(outage.notification, { status: 'sending', attempts: (outage.notification.attempts || 0) + 1, attemptedAt: date.toISOString(), error: null });
        const time = new Intl.DateTimeFormat('zh-CN', { timeZone: LOGIN_MONITOR_SCHEDULE.timezone, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(outage.checkedAt));
        return { id: outage.id, target: monitor.targetKey, text: `薯航｜小红书账号需要重新登录\n账号：${safeName(account)}\n状态：${outage.status === 'mismatch' ? '当前浏览器登录了其他账号' : '登录已失效'}\n检查时间：${time}（北京时间）\n请在运行薯航的电脑打开 https://creator.xiaohongshu.com/ 登录此账号。` };
      });
      if (!request) return;
      let result;
      try { result = await notifier.send(request.text, { idempotencyKey: request.id }); }
      catch { result = { sent: false, reason: 'failed' }; }
      await store.mutate(s => {
        const account = s.accounts.find(item => item.id === accountId), monitor = account?.loginMonitor, outage = monitor?.outage;
        if (!outage || outage.id !== request.id || monitor.targetKey !== request.target) return;
        const notification = outage.notification;
        if (result?.sent === true) Object.assign(notification, { status: 'delivered', deliveredAt: date.toISOString(), nextAttemptAt: null, error: null });
        else if (result?.reason === 'unconfigured') Object.assign(notification, { status: 'pending', attempts: Math.max(0, notification.attempts - 1), nextAttemptAt: null, error: null });
        else Object.assign(notification, { status: 'pending', nextAttemptAt: new Date(date.getTime() + retryDelays[Math.min(notification.attempts - 1, retryDelays.length - 1)]).toISOString(), error: '飞书提醒发送失败，稍后重试' });
      });
    }));
    deliveries = task.catch(() => {}).finally(() => sending.delete(accountId));
  }
  function scheduleCheck(accountId, key, target, date) {
    if (closing || checking.has(accountId)) return;
    checking.add(accountId);
    const task = checks.catch(() => {}).then(() => store.run(accountId, async () => {
      const active = await store.mutate(s => {
        const account = s.accounts.find(item => item.id === accountId), monitor = account?.loginMonitor;
        if (!account || !eligible(account) || targetKey(account) !== target || monitor?.lastDailyKey !== key) return false;
        monitor.status = 'checking'; return true;
      });
      if (!active) return;
      let result;
      try { result = await checkAccount(accountId, { date }); }
      catch { result = { status: 'unavailable' }; }
      await store.mutate(s => {
        const account = s.accounts.find(item => item.id === accountId), monitor = account?.loginMonitor;
        if (!account || !eligible(account) || targetKey(account) !== target || monitor?.lastDailyKey !== key) return;
        let status = result?.status;
        if (status === 'ready' && result.accountId !== publisherProfileId(account)) status = 'mismatch';
        const confirmed = status === 'ready' || offline(status);
        Object.assign(monitor, { status: confirmed ? status : 'failed', checkedAt: date.toISOString(), error: confirmed ? null : '未能完成登录检查，请检查浏览器连接' });
        if (status === 'ready') monitor.outage = null;
        else if (offline(status) && !monitor.outage) monitor.outage = {
          id: randomUUID(), status, checkedAt: date.toISOString(), notification: { status: 'pending', attempts: 0, deliveredAt: null, nextAttemptAt: null, error: null }
        };
      });
      pumpDelivery(accountId, date);
    }));
    checks = task.catch(() => {}).finally(() => checking.delete(accountId));
  }
  async function tick(input = dateNow()) {
    if (closing) return;
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) throw new TypeError('登录检查时间不正确');
    const parts = dateParts(date, LOGIN_MONITOR_SCHEDULE.timezone), key = dailyKey(date, LOGIN_MONITOR_SCHEDULE.timezone);
    const due = `${parts.hour}:${parts.minute}` >= LOGIN_MONITOR_SCHEDULE.time;
    const candidates = due ? store.rootState.accounts.filter(account => eligible(account) && !checking.has(account.id)
      && (!account.loginMonitor || account.loginMonitor.targetKey !== targetKey(account) || account.loginMonitor.lastDailyKey !== key)).map(account => account.id) : [];
    const claims = candidates.length ? await store.mutate(s => {
      const claimed = [];
      for (const account of s.accounts.filter(account => candidates.includes(account.id))) {
        if (!eligible(account) || checking.has(account.id)) continue;
        const monitor = stateFor(account);
        if (due && monitor.lastDailyKey !== key) {
          Object.assign(monitor, { lastDailyKey: key, status: 'queued', error: null });
          claimed.push({ accountId: account.id, target: monitor.targetKey });
        }
      }
      return claimed;
    }) : [];
    for (const claim of claims) scheduleCheck(claim.accountId, key, claim.target, date);
    for (const account of store.rootState.accounts) pumpDelivery(account.id, date);
  }
  async function wait() { await checks; await deliveries; }
  return { initialize, tick, wait, async close() { closing = true; await wait(); } };
}
