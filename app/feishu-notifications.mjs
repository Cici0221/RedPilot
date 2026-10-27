import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {InputError} from './content.mjs';

const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';
const MAX_RESPONSE = 65536;
const TOKEN_ERRORS = new Set([99991661, 99991663, 99991664]);
const clean = value => typeof value === 'string' ? value.trim() : '';
const invalid = value => /[\u0000-\u001f\u007f\s]/u.test(value);

function recipientType(value) {
  return value.includes('@') ? 'email' : value.startsWith('ou_') ? 'open_id' : 'user_id';
}

function validated(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('飞书应用资料不正确');
  for (const key of ['appId', 'appSecret', 'receiveId', 'receiveIdType']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new InputError('飞书应用资料不正确');
  }
  const appId = clean(input.appId ?? previous.appId);
  const suppliedSecret = clean(input.appSecret);
  if (!/^cli_[A-Za-z0-9_]{1,96}$/.test(appId)) throw new InputError('请填写飞书应用 App ID');
  if (appId !== previous.appId && !suppliedSecret) throw new InputError('更换应用时请重新填写 App Secret');
  const appSecret = suppliedSecret || previous.appSecret || '';
  if (appSecret.length < 8 || appSecret.length > 500 || invalid(appSecret)) throw new InputError('请填写有效的 App Secret');
  const receiveId = clean(input.receiveId ?? previous.receiveId);
  const receiveIdType = clean(input.receiveIdType) || (input.receiveId !== undefined ? recipientType(receiveId) : previous.receiveIdType) || recipientType(receiveId);
  if (!['open_id', 'user_id', 'email'].includes(receiveIdType)) throw new InputError('请选择个人飞书接收人');
  if (!receiveId || receiveId.length > 200 || invalid(receiveId)) throw new InputError('请填写飞书接收人');
  if (receiveIdType === 'email' ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(receiveId)
    : receiveIdType === 'open_id' ? !/^ou_[A-Za-z0-9_-]+$/.test(receiveId)
      : !/^[A-Za-z0-9_-]{1,128}$/.test(receiveId) || /^(?:oc_|ou_)/.test(receiveId)) throw new InputError('请填写飞书邮箱、Open ID 或用户 ID');
  return {appId, appSecret, receiveId, receiveIdType};
}

async function boundedJson(response) {
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw Error('http');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('empty');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) {await reader.cancel().catch(() => {}); throw Error('limit');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('json');
  return data;
}

function messageUuid(key) {
  if (!key) return randomUUID();
  const hex = createHash('sha256').update(String(key)).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function createFeishuNotifications(directory, env = {}, fetcher = fetch) {
  const filename = path.join(directory, 'feishu-notifications.json');
  let saved = {};
  try {saved = JSON.parse(await readFile(filename, 'utf8')); await chmod(filename, 0o600);}
  catch (error) {if (error.code !== 'ENOENT') throw Error('飞书提醒资料无法读取，已保留原文件');}
  const fallback = {
    appId: env.REDPILOT_FEISHU_APP_ID || env.FEISHU_APP_ID || env.LARK_APP_ID || '',
    appSecret: env.REDPILOT_FEISHU_APP_SECRET || env.FEISHU_APP_SECRET || env.LARK_APP_SECRET || '',
    receiveId: env.REDPILOT_FEISHU_RECEIVE_ID || env.FEISHU_RECEIVE_ID || env.FEISHU_USER_ID || '',
    receiveIdType: env.REDPILOT_FEISHU_RECEIVE_ID_TYPE || env.FEISHU_RECEIVE_ID_TYPE || ''
  };
  let config;
  try {config = validated(saved.config || fallback);} catch {config = null;}
  let queue = Promise.resolve(), token = null, closed = false;
  const transaction = fn => {
    if (closed) return Promise.reject(new InputError('飞书提醒正在关闭', 503));
    const task = queue.then(fn); queue = task.catch(() => {}); return task;
  };
  const persist = async next => {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await writeFile(filename + '.tmp', JSON.stringify(next, null, 2), {mode: 0o600});
    await chmod(filename + '.tmp', 0o600);
    await rename(filename + '.tmp', filename);
    saved = next;
  };
  const publicStatus = () => ({
    configured: Boolean(config), appId: config?.appId || '', receiveId: config?.receiveId || '',
    receiveIdType: config?.receiveIdType || '', status: config ? saved.check?.status || 'untested' : 'unconfigured',
    checkedAt: saved.check?.checkedAt || null, error: saved.check?.error || null
  });
  const request = async (url, body, accessToken) => boundedJson(await fetcher(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: {'Content-Type': 'application/json; charset=utf-8', ...(accessToken ? {Authorization: `Bearer ${accessToken}`} : {})},
    body: JSON.stringify(body)
  }));
  const accessToken = async () => {
    if (token && token.expiresAt > Date.now() + 60000) return token.value;
    const data = await request(TOKEN_URL, {app_id: config.appId, app_secret: config.appSecret});
    if (data.code !== 0 || typeof data.tenant_access_token !== 'string' || !data.tenant_access_token || invalid(data.tenant_access_token)
      || !Number.isFinite(data.expire) || data.expire <= 0) throw Error('credentials');
    token = {value: data.tenant_access_token, expiresAt: Date.now() + Math.min(data.expire, 7200) * 1000};
    return token.value;
  };
  return {
    publicStatus,
    configure(input) {return transaction(async () => {
      const next = validated(input, config || {});
      await persist({config: next, check: {status: 'untested', checkedAt: null, error: null}});
      config = next; token = null; return publicStatus();
    });},
    send(text, {idempotencyKey} = {}) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16000) throw new InputError('提醒内容不正确');
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 500)) throw new InputError('提醒标识不正确');
      return transaction(async () => {
        if (!config) return {sent: false, reason: 'unconfigured', error: '请先连接飞书提醒'};
        let result;
        try {
          const body = {receive_id: config.receiveId, msg_type: 'text', content: JSON.stringify({text}), uuid: messageUuid(idempotencyKey)};
          const url = `${MESSAGE_URL}?receive_id_type=${config.receiveIdType}`;
          let data = await request(url, body, await accessToken());
          if (TOKEN_ERRORS.has(data.code)) {token = null; data = await request(url, body, await accessToken());}
          if (data.code !== 0 || typeof data.data?.message_id !== 'string' || !data.data.message_id) {
            const code = Number.isSafeInteger(data.code) ? `（代码 ${data.code}）` : '';
            result = {sent: false, reason: 'failed', error: `飞书消息未发送，请检查机器人权限、接收人与应用可用范围${code}`};
          } else result = {sent: true, messageId: data.data.message_id};
        } catch (error) {
          result = {sent: false, reason: 'failed', error: error.message === 'credentials' ? '飞书应用认证失败，请检查 App ID 和 App Secret' : '飞书消息未确认送达，请检查网络后重试'};
        }
        const check = {status: result.sent ? 'ready' : 'failed', checkedAt: new Date().toISOString(), error: result.error || null};
        // Delivery stays successful if writing the local check timestamp fails.
        // The monitor separately persists its durable outage receipt.
        try {await persist({...saved, check});} catch {saved = {...saved, check};}
        return result;
      });
    },
    async close() {closed = true; await queue; token = null;}
  };
}
