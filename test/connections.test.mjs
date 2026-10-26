import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
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
const responsesPayload = (value, extra = {}) => ({ id: 'resp-fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...extra });
const responsesJSON = (value, extra) => new Response(JSON.stringify(responsesPayload(value, extra)), { headers: { 'Content-Type': 'application/json' } });
const responsesSSE = value => new Response('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: responsesPayload(value) }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
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
  for (let n = 0; n < 3; n++) { const current = await connections(f); assert.equal(current.ai.configured, false); assert.equal(current.ai.status, 'unconfigured'); assert.equal(current.ai.wireApi, 'chat'); noSecrets(current); }
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
  assert.equal(captured.body.model, 'fixture-vision-model'); assert.equal(captured.body.store, false); assert.equal(captured.body.response_format.type, 'json_object'); assert.equal(captured.body.max_completion_tokens, 512);
  const image = captured.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'image_url');
  assert.ok(image); assert.match(image.image_url.url, /^data:image\/png;base64,/);
  const pixels = Buffer.from(image.image_url.url.split(',')[1], 'base64');
  assert.deepEqual([...pixels.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.equal(pixels.readUInt32BE(16), 32); assert.equal(pixels.readUInt32BE(20), 32);
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

test('HTTP 429 classifies only whitelisted error codes or types into specific safe next actions', async t => {
  let error;
  const f = await fixture(t, { fetcher: async () => new Response(JSON.stringify({ error }), { status: 429 }) }); await configure(f);
  const cases = [
    ['billing_not_active', /计费未激活.*当前服务商.*账单.*启用/],
    ['credit_balance_exhausted', /余额不足.*当前服务商.*账单.*余额/],
    ['project_spend_limit_exceeded', /项目消费限额/],
    ['organization_spend_limit_exceeded', /组织消费限额/],
    ['organization_usage_limit_exceeded', /组织用量限额/],
    ['insufficient_quota', /额度不足.*账单.*限额/],
    ['rate_limit_exceeded', /暂时限流.*稍后重试.*降低请求频率/],
    ['slow_down', /暂时限流.*稍后重试.*降低请求频率/]
  ];
  for (const [code, expected] of cases) for (const field of ['code', 'type']) {
    error = { [field]: code, message: 'NEVER_ECHO_PROVIDER_BODY ' + KEY };
    const checked = ok(await f.request('connections/ai/test', {}));
    assert.equal(checked.status, 'failed'); assert.match(checked.error, expected); assert.ok(checked.error.includes(code));
    assert.doesNotMatch(checked.error, /OpenAI|官方账单/);
    assert.doesNotMatch(JSON.stringify(checked), /NEVER_ECHO_PROVIDER_BODY/); noSecrets(checked);
  }
  noSecrets(await state(f)); noSecrets(await connections(f));
});

test('unknown or malformed 429 bodies keep the generic message instead of exposing or guessing from provider text', async t => {
  let body;
  const f = await fixture(t, { fetcher: async () => new Response(body, { status: 429 }) }); await configure(f);
  const cases = ['invalid JSON ' + KEY, JSON.stringify({ error: { code: 'unrecognized', message: 'credit_balance_exhausted ' + KEY } }),
    JSON.stringify({ error: { code: '__proto__', type: 'toString', message: KEY } }), JSON.stringify({ error: { code: { value: 'slow_down' }, type: 429 } }), JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED' } })];
  for (body of cases) {
    const checked = ok(await f.request('connections/ai/test', {}));
    assert.equal(checked.status, 'failed'); assert.equal(checked.error, 'AI 服务额度或频率受限，请检查项目额度'); noSecrets(checked);
  }
});

test('oversized 429 responses use the bounded reader and fall back safely without reflecting body contents', async t => {
  let cancelled = false;
  const f = await fixture(t, { fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: 'credit_balance_exhausted', message: KEY } }))); },
    cancel() { cancelled = true; }
  }), { status: 429, headers: { 'Content-Length': String(1024 * 1024 + 1) } }) });
  await configure(f); const checked = ok(await f.request('connections/ai/test', {}));
  assert.equal(checked.status, 'failed'); assert.equal(checked.error, 'AI 服务额度或频率受限，请检查项目额度'); assert.equal(cancelled, true); noSecrets(checked);
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

test('the selected wire protocol persists privately and older saved configurations remain Chat Completions compatible', async t => {
  const requests = [];
  const f = await fixture(t, { env: { REDPILOT_AI_WIRE_API: 'chat' }, fetcher: async (url, request) => { requests.push(url); return url.endsWith('/responses') ? responsesJSON({ ok: true }) : response({ ok: true }); } });
  const configured = await configure(f, { wireApi: 'responses' }); assert.equal(configured.wireApi, 'responses'); noSecrets(configured);
  const filename = path.join(f.directory, 'connections.json'); assert.equal(JSON.parse(await readFile(filename, 'utf8')).ai.wireApi, 'responses');
  await f.reopen({ REDPILOT_AI_WIRE_API: 'invalid-ignored-fallback' }); assert.equal((await connections(f)).ai.wireApi, 'responses');
  assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready'); assert.equal(requests[0], BASE + '/responses');
  await f.reopen(); assert.equal((await connections(f)).ai.status, 'ready');
  const legacy = JSON.parse(await readFile(filename, 'utf8')); delete legacy.ai.wireApi;
  await writeFile(filename, JSON.stringify(legacy), { mode: 0o600 });
  await f.reopen({ REDPILOT_AI_WIRE_API: 'responses' });
  const current = (await connections(f)).ai; assert.equal(current.wireApi, 'chat'); assert.equal(current.status, 'untested');
  assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready'); assert.equal(requests[1], BASE + '/chat/completions');
});

test('invalid wire protocols cannot replace a valid configuration or cause any network request', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return response({ ok: true }); } });
  await configure(f);
  for (const wireApi of ['', 'other', 'Responses', 'chat/completions', null, 7, {}, []]) assert.equal((await f.request('connections/ai', { wireApi }, 'PUT')).status, 400);
  assert.equal((await connections(f)).ai.wireApi, 'chat'); assert.equal(calls, 0);
  assert.equal(ok(await f.request('connections/ai', { wireApi: ' responses ', apiKey: '' }, 'PUT')).wireApi, 'responses');
});

test('Responses probes accept completed JSON and SSE and use the shared fixed-image request format', async t => {
  let stream = false; const requests = [];
  const f = await fixture(t, { fetcher: async (url, request) => { requests.push({ url, body: JSON.parse(request.body) }); return stream ? responsesSSE({ ok: true }) : responsesJSON({ ok: true }); } });
  await f.store.mutate(s => { s.product.summary = 'PRIVATE_PRODUCT_SENTINEL'; s.inspirations[0].text = 'PRIVATE_REFERENCE_SENTINEL'; });
  await configure(f, { wireApi: 'responses' }); assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
  stream = true; assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
  assert.equal(requests.length, 2);
  for (const { url, body } of requests) {
    assert.equal(url, BASE + '/responses'); assert.equal(body.model, 'fixture-vision-model'); assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, 1024); assert.equal(body.text.format.type, 'json_object'); assert.equal(body.messages, undefined);
    const image = body.input[0].content.find(item => item.type === 'input_image'); assert.ok(image); assert.equal(image.detail, 'low');
    const pixels = Buffer.from(image.image_url.split(',')[1], 'base64'); assert.equal(pixels.readUInt32BE(16), 32); assert.equal(pixels.readUInt32BE(20), 32);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_(?:PRODUCT|REFERENCE)_SENTINEL/);
  }
  noSecrets(await connections(f)); noSecrets(await state(f));
});

test('unfinished or failed Responses data never marks a connection ready and never echoes provider content', async t => {
  let result;
  const f = await fixture(t, { fetcher: async () => result() }); await configure(f, { wireApi: 'responses' });
  const replies = [
    () => responsesJSON({ ok: true }, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    () => new Response('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '{"ok":true}' }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    () => new Response('event: response.failed\ndata: ' + JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: 'NEVER_ECHO_PROVIDER_BODY ' + KEY } } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    () => responsesJSON({ ok: false })
  ];
  for (result of replies) {
    const checked = ok(await f.request('connections/ai/test', {})); assert.equal(checked.status, 'failed'); assert.ok(checked.error);
    assert.doesNotMatch(JSON.stringify(checked), /NEVER_ECHO_PROVIDER_BODY|max_output_tokens/); noSecrets(checked);
  }
});

test('an environment protocol change invalidates a saved successful check without changing the model or key', async t => {
  let calls = 0;
  const env = { REDPILOT_AI_KEY: ENV_KEY, REDPILOT_AI_MODEL: 'fixture-model', REDPILOT_AI_BASE_URL: BASE, REDPILOT_AI_WIRE_API: 'responses' };
  const f = await fixture(t, { env, fetcher: async () => { calls++; return responsesJSON({ ok: true }); } });
  assert.equal((await connections(f)).ai.wireApi, 'responses'); assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready');
  await f.reopen({ ...env, REDPILOT_AI_WIRE_API: 'chat' });
  const current = (await connections(f)).ai; assert.equal(current.wireApi, 'chat'); assert.equal(current.status, 'untested'); assert.equal(current.checkedAt, null); assert.equal(calls, 1);
});

test('switching only the wire protocol while a probe is pending rejects its old completion', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; }), urls = [];
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async (url) => { calls++; urls.push(url); if (calls === 1) await gate; return url.endsWith('/responses') ? responsesJSON({ ok: true }) : response({ ok: true }); } });
  await configure(f); const pending = f.request('connections/ai/test', {}); await waitUntil(async () => calls === 1, 'probe did not start');
  const updated = ok(await f.request('connections/ai', { wireApi: 'responses', apiKey: '' }, 'PUT'));
  assert.equal(updated.status, 'untested'); assert.equal(updated.wireApi, 'responses'); release(); assert.equal((await pending).status, 409);
  assert.equal((await connections(f)).ai.status, 'untested');
  assert.equal(ok(await f.request('connections/ai/test', {})).status, 'ready'); assert.deepEqual(urls, [BASE + '/chat/completions', BASE + '/responses']);
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
