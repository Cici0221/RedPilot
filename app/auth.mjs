import { readFile, writeFile, mkdir, rename, chmod, unlink } from 'node:fs/promises';
import { randomBytes, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { InputError } from './content.mjs';

const scrypt = promisify(derive);
const COOKIE = 'redpilot_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const canonicalEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export async function configureAuth({ directory, email, password }) {
  const normalized = canonicalEmail(email);
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new InputError('请输入有效登录邮箱');
  if (typeof password !== 'string' || !password.length || password.length > 1024) throw new InputError('密码不能为空，且不能超过 1024 个字符');
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64, PARAMS)).toString('hex');
  const record = { version: 1, email: normalized, algorithm: 'scrypt', salt, hash,
    params: { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p }, updatedAt: new Date().toISOString() };
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'auth.json');
  const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } finally { await unlink(temporary).catch(() => {}); }
  return { email: normalized };
}

function validRecord(record) {
  return record?.version === 1 && record.algorithm === 'scrypt' &&
    typeof record.email === 'string' && record.email === canonicalEmail(record.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email) &&
    /^[a-f0-9]{32}$/.test(record.salt || '') && /^[a-f0-9]{128}$/.test(record.hash || '') &&
    record.params?.N === PARAMS.N && record.params?.r === PARAMS.r && record.params?.p === PARAMS.p;
}

function cookieToken(request) {
  const value = request.headers.cookie;
  if (typeof value !== 'string' || value.length > 8192) return null;
  const matches = value.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function createAuth({ directory, clock = () => Date.now(), secureCookies = false }) {
  let record = null;
  try { record = JSON.parse(await readFile(path.join(directory, 'auth.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('登录配置无法读取，请在本机重新配置'); }
  if (record && !validRecord(record)) throw new Error('登录配置无效，请在本机重新配置');
  const sessions = new Map();
  const attempts = new Map();
  const filename = path.join(directory, 'sessions.json');
  const credentialFingerprint = record ? tokenHash(JSON.stringify([record.email, record.salt, record.hash, record.params])) : null;
  try {
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    await chmod(filename, 0o600);
    if (record && saved?.version === 1 && saved.credentialFingerprint === credentialFingerprint && Array.isArray(saved.sessions)) {
      const time = clock();
      for (const item of saved.sessions.slice(-1000)) {
        if (!/^[a-f0-9]{64}$/.test(item?.tokenHash || '') || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.expiresAt) ||
            item.createdAt > time || item.expiresAt <= time || item.expiresAt - item.createdAt !== REMEMBER_MS) continue;
        sessions.set(item.tokenHash, { createdAt: item.createdAt, expiresAt: item.expiresAt, remember: true });
      }
    }
  } catch (error) {
    // A missing or damaged remembered session never grants access or prevents a fresh login.
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new Error('记住登录的数据无法读取，请检查本机文件权限');
  }
  let writes = Promise.resolve();
  async function persistSessions() {
    const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
    const saved = { version: 1, credentialFingerprint, sessions: [...sessions].filter(([, value]) => value.remember && value.expiresAt > clock())
      .map(([hash, value]) => ({ tokenHash: hash, createdAt: value.createdAt, expiresAt: value.expiresAt })) };
    try {
      await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function changeSessions(change) {
    const task = writes.then(async () => {
      const previous = new Map(sessions);
      try { purge(); change(); await persistSessions(); }
      catch {
        sessions.clear(); for (const [key, value] of previous) sessions.set(key, value);
        throw new InputError('登录状态保存失败，请检查本机存储后重试', 503);
      }
    });
    writes = task.catch(() => {});
    return task;
  }
  function cookie(value, seconds, request) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secureCookies || request.socket.encrypted ? '; Secure' : ''}`;
  }
  function purge() {
    const time = clock();
    for (const [key, session] of sessions) if (session.expiresAt <= time) sessions.delete(key);
    for (const [key, timestamps] of attempts) {
      const recent = timestamps.filter(value => value > time - WINDOW_MS);
      if (recent.length) attempts.set(key, recent); else attempts.delete(key);
    }
  }
  function session(request) {
    purge();
    const token = cookieToken(request);
    if (!token) return null;
    return sessions.get(tokenHash(token)) || null;
  }
  function status(request) {
    const current = session(request);
    return current ? { authenticated: true, configured: true, user: { email: record.email }, expiresAt: new Date(current.expiresAt).toISOString() }
      : { authenticated: false, configured: Boolean(record) };
  }
  async function logout(request, response) {
    const token = cookieToken(request);
    if (token && sessions.has(tokenHash(token))) await changeSessions(() => sessions.delete(tokenHash(token)));
    response.setHeader('Set-Cookie', cookie('', 0, request));
  }
  async function login(request, response, input) {
    if (!record) throw new InputError('登录账号尚未配置，请先在本机完成设置', 503);
    if (input?.remember !== undefined && typeof input.remember !== 'boolean') throw new InputError('记住登录的选项不正确');
    purge();
    // Use the actual peer address; forwarded headers cannot reset or share another client's limit.
    const address = request.socket.remoteAddress || 'local';
    let entry = attempts.get(address);
    if (!entry) { entry = []; attempts.set(address, entry); }
    if (entry.length >= MAX_ATTEMPTS) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry[0] + WINDOW_MS - clock()) / 1000))));
      throw new InputError('尝试次数过多，请稍后再试', 429);
    }
    // Reserve before scrypt so concurrent requests cannot bypass the attempt limit.
    entry.push(clock());
    const email = canonicalEmail(input?.email);
    const password = input?.password;
    if (typeof password !== 'string' || !password.length || password.length > 1024 || email.length > 254) throw new InputError('账号或密码不正确', 401);
    const actual = await scrypt(password, record.salt, 64, PARAMS);
    const passwordMatches = timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
    if (!passwordMatches || email !== record.email) throw new InputError('账号或密码不正确', 401);
    attempts.delete(address);
    const token = randomBytes(32).toString('base64url');
    const remember = input.remember === true, duration = remember ? REMEMBER_MS : SESSION_MS;
    const createdAt = clock(), expiresAt = createdAt + duration, previousToken = cookieToken(request);
    await changeSessions(() => {
      if (previousToken) sessions.delete(tokenHash(previousToken));
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
      sessions.set(tokenHash(token), { createdAt, expiresAt, remember });
    });
    response.setHeader('Set-Cookie', cookie(token, duration / 1000, request));
    return { ok: true, user: { email: record.email }, expiresAt: new Date(expiresAt).toISOString() };
  }
  return { status, session, login, logout, async close() { await writes; sessions.clear(); attempts.clear(); } };
}
