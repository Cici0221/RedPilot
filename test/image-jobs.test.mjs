import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const imageEnv = {
  REDPILOT_IMAGE_API_KEY: 'test-image-key-never-public',
  REDPILOT_IMAGE_BASE_URL: 'https://images.example/v1',
  REDPILOT_IMAGE_MODEL: 'test-image-model'
};
function crc32(buffer) { let crc = -1; for (const byte of buffer) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; }
function chunk(type, bytes) {
  const name = Buffer.from(type), output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length, 0); name.copy(output, 4); bytes.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, bytes])), output.length - 4); return output;
}
function sourcePNG() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function response(bytes = PNG) { return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { status: 200 }); }
const generation = (extra = {}) => ({ mode: 'generate', prompt: '为产品制作一张简洁的蓝白背景图', sourceAssetIds: [], size: '1024x1024', ...extra });
async function fixture(t, { env = imageEnv, fetcher = async () => response(), beforeClose } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-image-jobs-'));
  const credentials = { email: 'fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  let app = await createApp({ feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }), trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env, fetcher });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function login() {
    const result = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(result.status, 200, 'fixture login failed'); cookie = result.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  }
  t.after(async () => { beforeClose?.(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  await login();
  return {
    get store() { return app.store; }, tick: date => app.tick(date),
    async reopen() {
      await app.close(); app = await createApp({ feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }), trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env, fetcher });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`; await login();
    },
    async request(url, data, method = 'POST', authenticated = true) {
      const result = await fetch(base + '/api/' + url, {
        method, signal: AbortSignal.timeout(5000), headers: { Origin: base, ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {})
      });
      return { status: result.status, data: await result.json() };
    },
    async file(url, authenticated = true) {
      const result = await fetch(base + url, { headers: authenticated ? { Cookie: cookie } : {} });
      return { status: result.status, bytes: Buffer.from(await result.arrayBuffer()), type: result.headers.get('content-type') };
    }
  };
}
const state = async f => (await f.request('state', undefined, 'GET')).data;
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function upload(f, bytes = sourcePNG(), name = 'source.png', kind = 'image') {
  const before = new Set((await state(f)).productAssets.map(a => a.id));
  ok(await f.request('product-assets/upload', { name, kind, data: bytes.toString('base64') }));
  return (await state(f)).productAssets.find(a => !before.has(a.id));
}
async function waitFor(f, id, status) {
  for (let n = 0; n < 100; n++) {
    const s = await state(f), job = s.imageJobs.find(j => j.id === id);
    if (job?.status === status) return { job, state: s };
    if (job?.status === 'failed' && status !== 'failed') assert.fail(JSON.stringify(job));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('image job did not reach ' + status);
}
function noKey(s) { assert.equal(JSON.stringify(s).includes(imageEnv.REDPILOT_IMAGE_API_KEY), false); }

test('image jobs refuse a main-provider key when the image service differs without leaking credentials', async t => {
  let calls = 0;
  const mainKey = 'test-text-key-never-sent-to-another-service';
  const f = await fixture(t, { env: { REDPILOT_AI_KEY: mainKey, REDPILOT_AI_MODEL: 'test-text-model', REDPILOT_AI_BASE_URL: 'https://text.example/v1' }, fetcher: async () => { calls++; throw Error('must not call'); } });
  const initial = await state(f);
  assert.equal(initial.imageProvider.ready, false);
  assert.equal(JSON.stringify(initial).includes(mainKey), false);
  assert.equal((await f.request('image-jobs', generation())).status, 409);
  assert.deepEqual((await state(f)).imageJobs, []);
  assert.equal(calls, 0);
});

test('same-service main-provider fallback enables image jobs and state without exposing or persisting the key', async t => {
  const mainKey = 'test-main-key-shared-only-with-same-service';
  let calls = 0;
  const f = await fixture(t, { env: { REDPILOT_AI_KEY: mainKey, REDPILOT_AI_MODEL: 'test-text-model', REDPILOT_AI_BASE_URL: 'https://API.OpenAI.com:443/v1/' }, fetcher: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(request.headers.Authorization, 'Bearer ' + mainKey);
    assert.equal(JSON.parse(request.body).model, 'gpt-image-2.5-sunburst');
    return response();
  } });
  const initial = await state(f);
  assert.deepEqual(initial.imageProvider, { ready: true, model: 'gpt-image-2.5-sunburst' });
  assert.equal(JSON.stringify(initial).includes(mainKey), false);
  const job = ok(await f.request('image-jobs', generation()));
  const done = await waitFor(f, job.id, 'completed');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(done.state).includes(mainKey), false);
  assert.equal(JSON.stringify(f.store.state).includes(mainKey), false);
  assert.equal(done.state.productAssets.find(a => a.id === done.job.assetId).kind, 'image');
});

test('generation runs once asynchronously and stores its returned raster image in the managed asset library', async t => {
  const calls = [];
  const f = await fixture(t, { fetcher: async (url, request) => { calls.push({ url, request }); return response(); } });
  const initial = await state(f);
  assert.equal(initial.imageProvider.ready, true);
  assert.equal(initial.imageProvider.model, imageEnv.REDPILOT_IMAGE_MODEL);
  const queued = ok(await f.request('image-jobs', generation()));
  assert.ok(['queued', 'generating'].includes(queued.status));
  const done = await waitFor(f, queued.id, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://images.example/v1/images/generations');
  const payload = JSON.parse(calls[0].request.body);
  assert.ok(payload.prompt.includes(generation().prompt));
  assert.match(payload.prompt,/成品图片/);
  assert.equal(done.job.prompt,generation().prompt,'the stored job keeps the original user brief');
  assert.equal(payload.model, imageEnv.REDPILOT_IMAGE_MODEL);
  assert.equal(payload.size, '1024x1024');
  assert.equal(new Headers(calls[0].request.headers).get('authorization'), 'Bearer ' + imageEnv.REDPILOT_IMAGE_API_KEY);
  assert.ok(Number.isFinite(Date.parse(done.job.createdAt)));
  assert.ok(Number.isFinite(Date.parse(done.job.startedAt)));
  assert.ok(Number.isFinite(Date.parse(done.job.completedAt)));
  const asset = done.state.productAssets.find(a => a.id === done.job.assetId);
  assert.equal(asset.kind, 'image'); assert.equal(asset.storage, 'managed');
  assert.equal(asset.metadata.aiGenerated, true);
  assert.deepEqual((await f.file(asset.fileUrl)).bytes, PNG);
  noKey(done.state);
  await f.reopen();
  assert.equal((await state(f)).imageJobs.find(j => j.id === queued.id).status, 'completed');
  assert.equal(calls.length, 1);
});

test('editing sends selected raster sources in multipart form and preserves their IDs on the job', async t => {
  const calls = [];
  const f = await fixture(t, { fetcher: async (url, request) => { calls.push({ url, request }); return response(); } });
  const source = await upload(f);
  const job = ok(await f.request('image-jobs', generation({ mode: 'edit', sourceAssetIds: [source.id], size: '1024x1536', prompt: '保持产品外观，更换为白色桌面背景' })));
  const done = await waitFor(f, job.id, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://images.example/v1/images/edits');
  const form = calls[0].request.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), imageEnv.REDPILOT_IMAGE_MODEL);
  assert.equal(form.get('size'), '1024x1536');
  const files = form.getAll('image[]');
  assert.equal(files.length, 1);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), sourcePNG());
  assert.deepEqual(done.job.sourceAssetIds, [source.id]);
  assert.equal(done.state.productAssets.find(a => a.id === done.job.assetId).metadata.aiGenerated, true);
  noKey(done.state);
});

test('invalid image requests are rejected before creating a chargeable job', async t => {
  let calls = 0;
  const f = await fixture(t, { fetcher: async () => { calls++; return response(); } });
  const source = await upload(f);
  const icon = await upload(f, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'), 'brand.svg', 'icon');
  for (const input of [
    generation({ mode: 'invalid' }), generation({ prompt: '' }), generation({ prompt: 'x'.repeat(4001) }),
    generation({ size: 'arbitrary' }), generation({ sourceAssetIds: [source.id] }),
    generation({ mode: 'edit', sourceAssetIds: [] }), generation({ mode: 'edit', sourceAssetIds: [source.id, source.id] }),
    generation({ mode: 'edit', sourceAssetIds: Array(5).fill(source.id) }),
    generation({ mode: 'edit', sourceAssetIds: [icon.id] }), generation({ sourceAssetIds: 'not-an-array' })
  ]) assert.equal((await f.request('image-jobs', input)).status, 400);
  const missing = await f.request('image-jobs', generation({ mode: 'edit', sourceAssetIds: ['missing-asset'] }));
  assert.ok([400, 404].includes(missing.status));
  assert.deepEqual((await state(f)).imageJobs, []);
  assert.equal(calls, 0);
});

test('only one queued or generating image job is allowed while provider work runs outside the state lock', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async () => { calls++; await gate; return response(); } });
  const first = ok(await f.request('image-jobs', generation()));
  await waitFor(f, first.id, 'generating');
  const duplicate = await f.request('image-jobs', generation({ prompt: '另一个不同的创作要求' }));
  assert.equal(duplicate.status, 409);
  assert.equal((await state(f)).imageJobs.length, 1);
  assert.equal(calls, 1);
  release();
  await waitFor(f, first.id, 'completed');
});

test('provider failures are persisted without automatic retries or leaking provider error details', async t => {
  let calls = 0;
  const f = await fixture(t, {
    fetcher: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'provider rejected key ' + imageEnv.REDPILOT_IMAGE_API_KEY } }), { status: 401 }); }
  });
  const job = ok(await f.request('image-jobs', generation({ size: '1536x1024' })));
  const failed = await waitFor(f, job.id, 'failed');
  assert.equal(typeof failed.job.error, 'string');
  assert.equal(failed.state.productAssets.length, 0);
  await f.tick();
  await f.reopen();
  assert.equal((await state(f)).imageJobs.find(j => j.id === job.id).status, 'failed');
  assert.equal(calls, 1);
  noKey(failed.state);
});

test('non-image provider data cannot be registered as a completed asset', async t => {
  const f = await fixture(t, { fetcher: async () => response(Buffer.from('not a real PNG')) });
  const job = ok(await f.request('image-jobs', generation()));
  const failed = await waitFor(f, job.id, 'failed');
  assert.equal(failed.state.productAssets.length, 0);
  noKey(failed.state);
});

test('service restart marks interrupted queued or generating jobs failed without resubmitting them', async t => {
  let calls = 0;
  const f = await fixture(t, { fetcher: async () => { calls++; return response(); } });
  await f.store.mutate(s => {
    s.imageJobs.push(
      { ...generation(), id: 'interrupted-queued', status: 'queued', createdAt: new Date().toISOString() },
      { ...generation(), id: 'interrupted-generating', status: 'generating', createdAt: new Date().toISOString() }
    );
  });
  await f.reopen();
  const s = await state(f);
  for (const job of s.imageJobs) { assert.equal(job.status, 'failed'); assert.equal(typeof job.error, 'string'); }
  assert.equal(calls, 0);
  noKey(s);
});

test('image jobs and generated files remain protected by the actual login session', async t => {
  let calls = 0;
  const f = await fixture(t, { fetcher: async () => { calls++; return response(); } });
  const anonymous = await f.request('image-jobs', generation(), 'POST', false);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.data.code, 'AUTH_REQUIRED');
  assert.equal(calls, 0);
  const job = ok(await f.request('image-jobs', generation()));
  const done = await waitFor(f, job.id, 'completed');
  const asset = done.state.productAssets.find(a => a.id === done.job.assetId);
  assert.equal((await f.file(asset.fileUrl, false)).status, 401);
  assert.equal((await f.file(asset.fileUrl)).status, 200);
});

test('a byte-identical edit reuses its original asset without rewriting genuine-photo provenance', async t => {
  const f = await fixture(t);
  const source = await upload(f, PNG, 'genuine-product.png');
  await f.store.mutate(s => {
    const asset = s.productAssets.find(a => a.id === source.id);
    asset.description = '真实产品实拍';
    asset.metadata = { ...asset.metadata, provenance: 'original-photo', aiGenerated: false };
  });
  const original = (await state(f)).productAssets.find(a => a.id === source.id);
  const job = ok(await f.request('image-jobs', generation({ mode: 'edit', sourceAssetIds: [source.id] })));
  const done = await waitFor(f, job.id, 'completed');
  assert.equal(done.job.assetId, source.id);
  const reused = done.state.productAssets.find(a => a.id === source.id);
  assert.equal(reused.description, original.description);
  assert.deepEqual(reused.metadata, original.metadata);
  assert.equal(done.state.productAssets.length, 1);
});
