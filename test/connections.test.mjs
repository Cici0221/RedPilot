import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const BASE = 'https://models.example.com/v1';
const KEY = 'test-only-runtime-provider-key';
const ENV_KEY = 'test-only-environment-provider-key';
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }));
async function fixture(t, { env = {}, fetcher = async () => { throw Error('unexpected provider request'); }, beforeClose } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-connections-'));
  const credentials = { email: 'connections-fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  let app, base, cookie;
  async function open() {
    app = await createApp({ root, directory, env, fetcher,
      feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }),
      trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [] }) });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  }
  await open();
  t.after(async () => { beforeClose?.(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get store() { return app.store; },
    async reopen(nextEnv = env) { await app.close(); env = nextEnv; await open(); },
    async request(endpoint, data, method = 'POST', { authenticated = true, headers = {} } = {}) {
      const result = await fetch(base + '/api/' + endpoint, { method, signal: AbortSignal.timeout(5000),
        headers: { Origin: base, ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: result.status, data: await result.json() };
    }
  };
}
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const state = async f => ok(await f.request('state', undefined, 'GET'));
const connections = async f => ok(await f.request('connections', undefined, 'GET'));
const configure = async (f, extra = {}) => ok(await f.request('connections/ai', { apiKey: KEY, model: 'fixture-vision-model', baseUrl: BASE, ...extra }, 'PUT'));
async function waitUntil(fn, message) {
  for (let n = 0; n < 200; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
function noSecrets(value) { assert.doesNotMatch(JSON.stringify(value), /test-only-(?:runtime|environment)-provider-key/); }

// Only test credentials and injected provider responses are used; the probes never call a real service.
test('connection status is read-only, ignores unrelated global keys, and an unconfigured test never calls the provider', async t => {
  let calls = 0;
  const f = await fixture(t, { env: { OPENAI_API_KEY: 'test-only-unrelated-global-key' }, fetcher: async () => { calls++; return response({ ok: true }); } });
  for (let n = 0; n < 3; n++) { const current = await connections(f); assert.equal(current.ai.configured, false); assert.equal(current.ai.status, 'unconfigured'); noSecrets(current); }
  assert.equal((await f.request('connections/ai/test', {})).status, 409); assert.equal(calls, 0);
});

test('runtime AI configuration is private, survives reopening, and overrides environment fallback without entering business state', async t => {
  const requests = [];
  const f = await fixture(t, { env: { REDPILOT_AI_KEY: ENV_KEY, REDPILOT_AI_MODEL: 'environment-model', REDPILOT_AI_BASE_URL: 'https://api.openai.com/v1' },
    fetcher: async (url, request) => { requests.push({ url, authorization: request.headers.Authorization, body: JSON.parse(request.body) }); return response({ ok: true }); }
  });
  const fallback = (await connections(f)).ai;
  assert.equal(fallback.configured, true); assert.equal(fallback.model, 'environment-model'); assert.equal(fallback.status, 'untested');
  const configured = await configure(f); assert.equal(configured.configured, true); assert.equal(configured.status, 'untested'); noSecrets(configured);
  const filename = path.join(f.directory, 'connections.json');
  assert.equal((await stat(filename)).mode & 0o777, 0o600); assert.ok((await readFile(filename, 'utf8')).includes(KEY));
  assert.equal((await f.request('../connections.json', undefined, 'GET')).status, 404);
  assert.equal((await f.request('../runtime/connections.json', undefined, 'GET')).status, 404);
  await f.reopen(); const current = (await connections(f)).ai;
  assert.equal(current.model, 'fixture-vision-model'); assert.equal(current.baseUrl, BASE); assert.equal(current.configured, true);
  assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
  assert.equal(requests.length, 1); assert.equal(requests[0].authorization, 'Bearer ' + KEY); assert.equal(requests[0].url, BASE + '/chat/completions');
  const business = await state(f); noSecrets(business); noSecrets(await connections(f));
  const { capabilities, draftChecks, ...backup } = business; noSecrets(backup);
  assert.doesNotMatch(await readFile(path.join(f.directory, 'state.json'), 'utf8'), /test-only-(?:runtime|environment)-provider-key/);
});

test('saving an empty key preserves the same provider secret but a provider change requires a newly supplied key', async t => {
  const requests = [];
  const f = await fixture(t, { fetcher: async (url, request) => { requests.push({ url, key: request.headers.Authorization }); return response({ ok: true }); } });
  await configure(f); ok(await f.request('connections/ai', { apiKey: '', model: 'edited-model', baseUrl: BASE }, 'PUT'));
  const first = ok(await f.request('connections/ai/test', {})); assert.equal(first.status, 'ready'); assert.equal(requests[0].key, 'Bearer ' + KEY);
  const switched = await f.request('connections/ai', { apiKey: '', model: 'edited-model', baseUrl: 'https://different.example.com/v1' }, 'PUT');
  assert.equal(switched.status, 400); assert.equal((await connections(f)).ai.baseUrl, BASE); assert.equal(requests.length, 1);
});

test('AI configuration rejects local or reserved destinations, credentials, queries, fragments and malformed secrets before any provider call', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return response({ ok: true }); } });
  const invalidUrls = ['http://models.example.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://0x7f000001/v1', 'https://192.168.1.8/v1', 'https://10.0.0.1/v1', 'https://172.16.0.1/v1', 'https://169.254.169.254/v1', 'https://192.0.0.1/v1', 'https://192.0.2.1/v1', 'https://198.18.0.1/v1', 'https://198.51.100.1/v1', 'https://203.0.113.1/v1', 'https://[::1]/v1', 'https://[fc00::1]/v1', 'https://service.local/v1', 'https://service.internal/v1', 'https://user:password@models.example.com/v1', 'https://models.example.com:444/v1', BASE + '?token=secret', BASE + '#secret'];
  for (const baseUrl of invalidUrls) assert.equal((await f.request('connections/ai', { apiKey: KEY, model: 'fixture-model', baseUrl }, 'PUT')).status, 400, baseUrl);
  for (const invalid of [{ model: 'x'.repeat(101) }, { model: 'bad\nmodel' }, { apiKey: 'x'.repeat(501) }, { apiKey: 'key\nsecret' }, { apiKey: 'key\u0000secret' }]) {
    assert.equal((await f.request('connections/ai', { apiKey: KEY, model: 'fixture-model', baseUrl: BASE, ...invalid }, 'PUT')).status, 400);
  }
  assert.equal(calls, 0); assert.equal((await connections(f)).ai.configured, false);
});

test('a successful connection check uses a fixed image and JSON prompt without sending private working material', async t => {
  let captured;
  const f = await fixture(t, { fetcher: async (url, request) => { captured = { url, request, body: JSON.parse(request.body) }; return response({ ok: true }); } });
  await f.store.mutate(s => { s.product.summary = 'PRIVATE_PRODUCT_SENTINEL'; s.inspirations[0].text = 'PRIVATE_REFERENCE_SENTINEL'; s.feishuDocuments.push({ id: 'private-doc', text: 'PRIVATE_FEISHU_SENTINEL' }); });
  await configure(f); assert.equal((await connections(f)).ai.status, 'untested');
  const checked = ok(await f.request('connections/ai/test', {})); assert.equal(checked.status, 'ready'); assert.ok(checked.checkedAt); assert.equal(checked.error, null);
  assert.equal(captured.body.model, 'fixture-vision-model'); assert.equal(captured.body.store, false); assert.equal(captured.body.response_format.type, 'json_object');
  const image = captured.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'image_url');
  assert.ok(image); assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual([...Buffer.from(image.image_url.url.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.doesNotMatch(JSON.stringify(captured.body), /PRIVATE_(?:PRODUCT|REFERENCE|FEISHU)_SENTINEL/);
  noSecrets(checked); noSecrets(await state(f));
});

test('authentication and transport failures remain failed and never expose provider-returned secrets', async t => {
  let throws = false, calls = 0;
  const f = await fixture(t, { fetcher: async () => {
    calls++; if (throws) throw Error('provider echoed ' + KEY);
    return new Response(JSON.stringify({ error: { message: 'invalid secret ' + KEY } }), { status: 401 });
  } });
  await configure(f); const denied = ok(await f.request('connections/ai/test', {}));
  assert.equal(denied.status, 'failed'); assert.ok(denied.error); assert.ok(denied.checkedAt); noSecrets(denied);
  assert.equal((await connections(f)).ai.status, 'failed');
  throws = true; const failed = ok(await f.request('connections/ai/test', {}));
  assert.equal(failed.status, 'failed'); noSecrets(failed); noSecrets(await state(f));
  assert.equal(calls, 2);
});

test('changing environment fallback configuration on restart invalidates the previous successful provider check', async t => {
  let calls = 0;
  const f = await fixture(t, { env: { REDPILOT_AI_KEY: ENV_KEY, REDPILOT_AI_MODEL: 'environment-model-a', REDPILOT_AI_BASE_URL: 'https://api.openai.com/v1' }, fetcher: async () => { calls++; return response({ ok: true }); } });
  assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
  await f.reopen({ REDPILOT_AI_KEY: ENV_KEY, REDPILOT_AI_MODEL: 'environment-model-b', REDPILOT_AI_BASE_URL: 'https://api.openai.com/v1' });
  const current = (await connections(f)).ai;
  assert.equal(current.configured, true); assert.equal(current.model, 'environment-model-b'); assert.equal(current.status, 'untested'); assert.equal(current.checkedAt, null);
  assert.equal(calls, 1);
});

test('only a literal successful JSON probe marks the provider ready', async t => {
  let value;
  const f = await fixture(t, { fetcher: async () => response(value) }); await configure(f);
  for (value of ['not-json', { ok: false }, { ok: 'true' }, { unrelated: true }]) {
    const checked = ok(await f.request('connections/ai/test', {}));
    assert.equal(checked.status, 'failed'); assert.ok(checked.error); assert.equal((await connections(f)).ai.status, 'failed');
  }
  value = { ok: true }; assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
});

test('concurrent connection probes share one provider call and do not block unrelated state changes', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async () => { calls++; await gate; return response({ ok: true }); } });
  await configure(f); const first = f.request('connections/ai/test', {});
  await waitUntil(async () => calls === 1, 'provider probe did not start');
  const second = f.request('connections/ai/test', {});
  ok(await f.request('accounts', { name: '接入测试期间新增账号', type: 'personal' }));
  assert.equal(calls, 1); release();
  const [a, b] = await Promise.all([first, second]); assert.equal(ok(a).status, 'ready');
  assert.ok([200, 409].includes(b.status)); if (b.status === 200) assert.equal(b.data.status, 'ready');
  assert.equal(calls, 1);
});

test('changing AI configuration while its probe is in flight rejects the old result instead of marking new settings ready', async t => {
  let release, calls = 0; const models = [], gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async (url, request) => {
    calls++; models.push(JSON.parse(request.body).model); if (calls === 1) await gate; return response({ ok: true });
  } });
  await configure(f); const pending = f.request('connections/ai/test', {}); await waitUntil(async () => calls === 1, 'provider probe did not start');
  const edited = ok(await f.request('connections/ai', { apiKey: '', model: 'updated-vision-model', baseUrl: BASE }, 'PUT'));
  assert.equal(edited.status, 'untested'); release(); assert.equal((await pending).status, 409);
  const current = (await connections(f)).ai;
  assert.equal(current.model, 'updated-vision-model'); assert.equal(current.status, 'untested');
  assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
  assert.deepEqual(models, ['fixture-vision-model', 'updated-vision-model']); assert.equal(calls, 2);
});

test('connection APIs require authentication and same-origin mutations while private configuration files stay inaccessible', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return response({ ok: true }); } });
  const anonymous = await f.request('connections', undefined, 'GET', { authenticated: false });
  assert.equal(anonymous.status, 401); assert.equal(anonymous.data.code, 'AUTH_REQUIRED');
  for (const [endpoint, data, method] of [['connections/ai', { apiKey: KEY, model: 'fixture-model', baseUrl: BASE }, 'PUT'], ['connections/ai/test', {}, 'POST']]) {
    assert.equal((await f.request(endpoint, data, method, { authenticated: false })).status, 401);
    assert.equal((await f.request(endpoint, data, method, { headers: { Origin: 'https://evil.example' } })).status, 403);
  }
  assert.equal(calls, 0); assert.equal((await connections(f)).ai.configured, false);
});
