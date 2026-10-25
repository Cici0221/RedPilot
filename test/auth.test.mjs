import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const TEST_EMAIL = 'fixture@example.test';
const password = () => 'Test-only-Case-' + randomBytes(18).toString('hex') + '!';

async function fixture(t, { configured = true, email = TEST_EMAIL, secret = password() } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-auth-'));
  let clock = Date.now();
  const authClock = () => clock;
  if (configured) await configureAuth({ directory, email, password: secret });
  let app = await createApp({ trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env: {}, authClock });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, email, secret,
    advance(milliseconds) { clock += milliseconds; },
    async reopen() {
      await app.close();
      app = await createApp({ trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env: {}, authClock });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
    },
    async request(url, { method = 'GET', json, cookie = '', origin = base, headers = {} } = {}) {
      const response = await fetch(base + url, {
        method, redirect: 'manual',
        headers: {
          ...(origin === null ? {} : { Origin: origin }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {})
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { /* binary and HEAD responses are expected */ }
      return { status: response.status, headers: response.headers, text, data };
    },
    async login(extra = {}) {
      return this.request('/api/auth/login', { method: 'POST', json: { email, password: secret }, ...extra });
    }
  };
}
function sessionCookie(result) {
  const setCookie = result.headers.get('set-cookie');
  assert.ok(setCookie, 'login response did not set a session cookie');
  return setCookie.split(';')[0];
}
async function loginCookie(f) {
  const result = await f.login();
  assert.equal(result.status, 200, 'test fixture login failed');
  return sessionCookie(result);
}
function findSecrets(value, target = []) {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/salt|hash/i.test(key) && typeof item === 'string') target.push(item);
      else findSecrets(item, target);
    }
  }
  return target;
}

test('an unconfigured server fails closed while allowing the login screen and public auth status', async t => {
  const f = await fixture(t, { configured: false });
  const status = await f.request('/api/auth/session', { origin: null });
  assert.equal(status.status, 200);
  assert.equal(status.data.authenticated, false);
  assert.equal(status.data.configured, false);
  const login = await f.login();
  assert.equal(login.status, 503);
  assert.equal(login.headers.has('set-cookie'), false);
  const protectedState = await f.request('/api/state');
  assert.equal(protectedState.status, 401);
  assert.equal(protectedState.data.code, 'AUTH_REQUIRED');
  const page = await f.request('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await f.request('/login')).status, 200);
});

test('auth configuration stores salted scrypt data with private permissions and never plaintext', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-auth-record-'));
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  const secret = password();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await configureAuth({ directory: first, email: TEST_EMAIL, password: secret });
  await configureAuth({ directory: second, email: TEST_EMAIL, password: secret });
  const filename = path.join(first, 'auth.json');
  const raw = await readFile(filename, 'utf8');
  const record = JSON.parse(raw);
  const other = JSON.parse(await readFile(path.join(second, 'auth.json'), 'utf8'));
  assert.equal(raw.includes(secret), false);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const secrets = findSecrets(record);
  const otherSecrets = findSecrets(other);
  assert.ok(secrets.length >= 2, 'salt and derived password hash were not stored');
  assert.notDeepEqual(secrets, otherSecrets, 'same password reused an identical salt/hash record');
});

test('login issues an opaque HttpOnly SameSite Strict cookie and normalizes email casing', async t => {
  const f = await fixture(t, { email: ' Fixture@Example.TEST ' });
  const before = await f.request('/api/auth/session');
  assert.equal(before.data.configured, true);
  assert.equal(before.data.authenticated, false);
  const result = await f.login({ json: { email: '  FIXTURE@example.test ', password: f.secret } });
  assert.equal(result.status, 200);
  const header = result.headers.get('set-cookie');
  assert.match(header, /^redpilot_session=[^;]{43,}/);
  assert.match(header, /;\s*HttpOnly(?:;|$)/i);
  assert.match(header, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(header, /;\s*Path=\/(?:;|$)/i);
  assert.equal(header.includes(f.secret), false);
  const cookie = sessionCookie(result);
  const active = await f.request('/api/auth/session', { cookie });
  assert.equal(active.status, 200);
  assert.equal(active.data.authenticated, true);
  assert.equal(active.data.user.email, TEST_EMAIL);
  const workspace = await f.request('/api/state', { cookie });
  assert.equal(workspace.status, 200);
  assert.equal((await f.request('/', { cookie })).status, 200);
});

test('wrong usernames, wrong passwords and password casing return the same login error', async t => {
  const f = await fixture(t);
  const attempts = [
    { email: 'absent@example.test', password: f.secret },
    { email: TEST_EMAIL, password: 'unrelated-test-password' },
    { email: TEST_EMAIL, password: f.secret.toLowerCase() }
  ];
  let expected;
  for (const json of attempts) {
    const response = await f.login({ json });
    assert.equal(response.status, 401);
    assert.equal(response.data.error, '账号或密码不正确');
    assert.equal(response.headers.has('set-cookie'), false);
    if (expected) assert.deepEqual(response.data, expected);
    expected = response.data;
  }
  const status = await f.request('/api/auth/session');
  assert.equal(status.data.authenticated, false);
});

test('login rejects missing, null or foreign origins and does not authenticate through spoofed forwarded headers', async t => {
  const f = await fixture(t);
  for (const origin of [null, 'null', 'https://evil.example', 'http://evil.example']) {
    const result = await f.login({ origin, headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } });
    assert.equal(result.status, 403);
    assert.equal(result.headers.has('set-cookie'), false);
  }
  assert.equal((await f.request('/api/auth/session')).data.authenticated, false);
  const preflight = await f.request('/api/auth/login', { method: 'OPTIONS', origin: 'https://evil.example', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.ok(preflight.status >= 400);
  assert.equal(preflight.headers.has('access-control-allow-origin'), false);
});

test('logout requires the correct origin, removes the server session and clears its cookie', async t => {
  const f = await fixture(t);
  const cookie = await loginCookie(f);
  const forged = await f.request('/api/auth/logout', { method: 'POST', json: {}, cookie, origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  assert.equal((await f.request('/api/auth/session', { cookie })).data.authenticated, true);
  const noOrigin = await f.request('/api/auth/logout', { method: 'POST', json: {}, cookie, origin: null });
  assert.equal(noOrigin.status, 403);
  const result = await f.request('/api/auth/logout', { method: 'POST', json: {}, cookie });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /redpilot_session=;/);
  assert.equal((await f.request('/api/auth/session', { cookie })).data.authenticated, false);
  assert.equal((await f.request('/api/state', { cookie })).status, 401);
});

test('sessions expire after eight hours using the injected server clock', async t => {
  const f = await fixture(t);
  const cookie = await loginCookie(f);
  f.advance(8 * 60 * 60 * 1000 - 1);
  assert.equal((await f.request('/api/auth/session', { cookie })).data.authenticated, true);
  f.advance(2);
  const expired = await f.request('/api/auth/session', { cookie });
  assert.equal(expired.data.authenticated, false);
  assert.equal((await f.request('/api/state', { cookie })).status, 401);
});

test('server restart invalidates in-memory sessions while preserving configured credentials', async t => {
  const f = await fixture(t);
  const original = await loginCookie(f);
  await f.reopen();
  const status = await f.request('/api/auth/session', { cookie: original });
  assert.equal(status.data.configured, true);
  assert.equal(status.data.authenticated, false);
  assert.equal((await f.request('/api/state', { cookie: original })).status, 401);
  const replacement = await loginCookie(f);
  assert.notEqual(replacement, original);
  assert.equal((await f.request('/api/state', { cookie: replacement })).status, 200);
  assert.equal((await f.request('/api/state', { cookie: original })).status, 401);
});

test('all business read/write APIs, file APIs and HEAD requests require a session', async t => {
  const f = await fixture(t);
  for (const url of ['/api/state', '/api/health', '/api/product-assets/unknown/file', '/api/product-assets/unknown/preview']) {
    const result = await f.request(url);
    assert.equal(result.status, 401, url);
    assert.equal(result.data.code, 'AUTH_REQUIRED', url);
  }
  for (const [url, method] of [
    ['/api/drafts', 'POST'], ['/api/accounts', 'POST'], ['/api/product', 'PUT'],
    ['/api/settings', 'PUT'], ['/api/product-assets/upload', 'POST'],
    ['/api/product-assets/import', 'POST'], ['/api/inspirations/unknown', 'DELETE']
  ]) {
    const result = await f.request(url, { method, json: {} });
    assert.equal(result.status, 401, url);
    assert.equal(result.data.code, 'AUTH_REQUIRED', url);
  }
  const head = await f.request('/api/state', { method: 'HEAD' });
  assert.equal(head.status, 401);
  assert.equal(head.text, '');
  const invalidCookie = await f.request('/api/state', { cookie: 'redpilot_session=not-a-valid-session' });
  assert.equal(invalidCookie.status, 401);
});

test('business pages and static content redirect to login; only the login resource allowlist is public', async t => {
  const f = await fixture(t);
  for (const url of ['/', '/index.html', '/app.js', '/examples/inspirations/assets/tayumon-profile.jpg', '/uploads/' + '0'.repeat(64) + '.png', '/runtime/auth.json']) {
    const result = await f.request(url);
    assert.equal(result.status, 302, url);
    assert.equal(result.headers.get('location'), '/login', url);
  }
  const head = await f.request('/index.html', { method: 'HEAD' });
  assert.equal(head.status, 302);
  for (const url of ['/login', '/login.html', '/login.js', '/style.css', '/fonts/InstrumentSans-Bold.ttf']) {
    assert.equal((await f.request(url)).status, 200, url);
  }
});

test('five failures throttle the remote IP regardless of username or forwarded IP and expire after fifteen minutes', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await f.login({ json: { email: `absent-${attempt}@example.test`, password: 'invalid-test-password' }, headers: { 'X-Forwarded-For': `192.0.2.${attempt + 1}` } });
    assert.equal(result.status, 401);
  }
  const limited = await f.login({ headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.has('set-cookie'), false);
  f.advance(15 * 60 * 1000 - 1);
  assert.equal((await f.login()).status, 429);
  f.advance(2);
  assert.equal((await f.login()).status, 200);
});

test('successful login clears preceding failures instead of accumulating them across sessions', async t => {
  const f = await fixture(t);
  const wrong = { json: { email: TEST_EMAIL, password: 'wrong-test-password' } };
  for (let n = 0; n < 4; n++) assert.equal((await f.login(wrong)).status, 401);
  assert.equal((await f.login()).status, 200);
  for (let n = 0; n < 4; n++) assert.equal((await f.login(wrong)).status, 401);
  assert.equal((await f.login()).status, 200);
});

test('business state and static routes never expose the password hash, salt or auth file', async t => {
  const f = await fixture(t);
  const cookie = await loginCookie(f);
  const record = JSON.parse(await readFile(path.join(f.directory, 'auth.json'), 'utf8'));
  const result = await f.request('/api/state', { cookie });
  assert.equal(result.status, 200);
  assert.equal(result.text.includes(f.secret), false);
  for (const secret of findSecrets(record)) assert.equal(result.text.includes(secret), false);
  assert.equal('auth' in result.data, false);
  for (const url of ['/auth.json', '/runtime/auth.json', '/app/auth.mjs']) {
    const response = await f.request(url, { cookie });
    assert.equal(response.status, 404, url);
    for (const secret of findSecrets(record)) assert.equal(response.text.includes(secret), false);
  }
});

test('the failure limit rolls over individual attempt timestamps rather than clearing an entire fixed window', async t => {
  const f = await fixture(t);
  const wrong = { json: { email: TEST_EMAIL, password: 'rolling-window-test-password' } };
  assert.equal((await f.login(wrong)).status, 401);
  f.advance(14 * 60 * 1000);
  for (let n = 0; n < 4; n++) assert.equal((await f.login(wrong)).status, 401);
  assert.equal((await f.login()).status, 429);
  // Only the first attempt has left the 15-minute window; four recent failures remain.
  f.advance(60 * 1000 + 1);
  assert.equal((await f.login(wrong)).status, 401);
  assert.equal((await f.login()).status, 429);
  f.advance(14 * 60 * 1000);
  assert.equal((await f.login()).status, 200);
});
