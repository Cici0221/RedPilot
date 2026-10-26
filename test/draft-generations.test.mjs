import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const aiEnv = { REDPILOT_AI_KEY: 'test-only-draft-generation-key', REDPILOT_AI_MODEL: 'fixture-model', REDPILOT_AI_BASE_URL: 'https://model.example/v1' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
function modelResponse(extra = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    title: '先确认备用号使用条件', body: 'SimHelper 处于开发内测阶段。SIM 卡需移入设备，设备需 Wi-Fi，手机需互联网。请先核对适用条件。',
    tags: ['产品开发'], series: '通信小麻烦', slides: [{ headline: '确认使用条件', body: 'SIM 移入设备，设备与手机均需联网。' }], gaps: [], adaptation: '学习参考中的问题先行结构', ...extra
  }) } }] }));
}
async function fixture(t, { env = aiEnv, fetcher = async () => modelResponse(), linkReader = async () => ({ status: 'unavailable', missing: [], error: 'test-only offline' }), beforeClose } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-draft-generations-'));
  const credentials = { email: 'draft-generations-fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  const sideEffects = { publish: 0, verify: 0 };
  let app, base, cookie;
  async function open() {
    app = await createApp({ root, directory, env, fetcher,
      xhsPublisher: { async checkConnection() { return { status: 'unavailable' }; }, async publish() { sideEffects.publish++; throw Error('draft generation must not publish'); }, async verify() { sideEffects.verify++; throw Error('draft generation must not verify'); } },
      feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }),
      trendReader: async () => [], linkReader });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  }
  await open();
  t.after(async () => { beforeClose?.(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, sideEffects, get store() { return app.store; },
    async reopen() { await app.close(); await open(); },
    async request(endpoint, data, method = 'POST', { authenticated = true, headers = {}, accountId } = {}) {
      const result = await fetch(base + '/api/' + endpoint, { method, signal: AbortSignal.timeout(5000),
        headers: { Origin: base, ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...(accountId ? { 'X-RedPilot-Account': accountId } : {}), ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: result.status, data: await result.json() };
    }
  };
}
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const state = async (f, accountId) => ok(await f.request('state', undefined, 'GET', { accountId }));
async function waitUntil(fn, message) {
  for (let n = 0; n < 250; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
async function source(f, extra = {}) { return ok(await f.request('inspirations', { title: '真实参考文字', text: '参考正文先提出一个具体问题，然后解释使用条件，最后邀请用户补充需求。', files: [], ...extra })).item; }
async function image(f, data = PNG, name = 'test-product.png') { return ok(await f.request('product-assets/upload', { name, kind: 'image', data })); }
const payload = (extra = {}) => ({ method: 'ai', contentMode: 'text', instruction: '说明适用条件，不编造实测', mode: '综合借鉴', clientRequestId: randomUUID(), ...extra });
async function start(f, extra = {}) { return ok(await f.request('draft-generations', payload(extra))); }
async function finished(f, jobId, accountId) {
  return waitUntil(async () => (await state(f, accountId)).draftGenerationJobs.find(job => job.id === jobId && ['completed', 'failed'].includes(job.status)), 'draft generation did not finish');
}

// All source readers and models are injected; no real documents, credentials or accounts are used.
test('an AI generation returns a persisted task promptly and releases the state lock while the provider is pending', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async () => { calls++; await gate; return modelResponse(); } });
  const ref = await source(f), initial = await state(f), job = await start(f, { referenceId: ref.id });
  await waitUntil(async () => calls === 1, 'AI model did not start');
  const pending = (await state(f)).draftGenerationJobs.find(item => item.id === job.id);
  assert.equal(pending.status, 'running'); assert.equal(pending.phase, 'generating'); assert.ok(!pending.draftId);
  ok(await f.request('accounts', { name: '生成等待期间的账号', type: 'personal' }));
  await source(f, { title: '同时收藏的另一个资料', text: '这份资料与当前生成任务没有关系。' });
  assert.equal((await state(f)).drafts.length, initial.drafts.length); assert.equal(calls, 1);
  release(); const done = await finished(f, job.id); assert.equal(done.status, 'completed'); assert.equal(done.phase, 'completed'); assert.ok(done.draftId);
  const current = await state(f), generated = current.drafts.find(item => item.id === done.draftId);
  assert.ok(generated); assert.equal(current.drafts.length, initial.drafts.length + 1); assert.equal(generated.accountId, initial.defaultAccountId);
  assert.deepEqual(generated.referenceIds, [ref.id]); assert.equal(generated.contentMode, 'text'); assert.deepEqual(generated.slides, []); assert.deepEqual(generated.productAssetIds, []);
  assert.equal(generated.status, 'draft'); assert.notEqual(generated.approved, true); assert.equal(current.jobs.length, 0);
  assert.deepEqual(f.sideEffects, { publish: 0, verify: 0 }); assert.doesNotMatch(JSON.stringify(current), /test-only-draft-generation-key/);
  await f.reopen(); const restored = await state(f);
  assert.equal(restored.draftGenerationJobs.find(item => item.id === job.id).draftId, done.draftId);
  assert.equal(restored.draftGenerationJobs.find(item => item.id === job.id).status, 'completed'); assert.equal(calls, 1);
});

test('the legacy draft creation response can wait for AI without locking unrelated writes', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async () => { calls++; await gate; return modelResponse(); } });
  const pending = f.request('drafts', payload()); await waitUntil(async () => calls === 1, 'legacy AI request did not start');
  await source(f, { title: '旧接口生成期间的新收藏' });
  assert.ok((await state(f)).draftGenerationJobs.some(job => job.status === 'running'));
  release(); const generated = ok(await pending); assert.equal(generated.method, 'ai'); assert.ok(generated.id);
  const current = await state(f); assert.equal(current.draftGenerationJobs[0].draftId, generated.id); assert.equal(calls, 1);
});

test('duplicate clicks, active equivalent requests and replay after success create one task and one draft', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), fetcher: async () => { calls++; await gate; return modelResponse(); } });
  const ref = await source(f), request = payload({ referenceId: ref.id }), initial = await state(f);
  const results = await Promise.all([f.request('draft-generations', request), f.request('draft-generations', request)]);
  const first = ok(results[0]), second = ok(results[1]); assert.equal(first.id, second.id);
  await waitUntil(async () => calls === 1, 'AI model did not start');
  const equivalentRequest = { ...request, clientRequestId: randomUUID() }, equivalent = ok(await f.request('draft-generations', equivalentRequest)); assert.equal(equivalent.id, first.id);
  assert.equal((await state(f)).draftGenerationJobs.length, 1); assert.equal(calls, 1);
  const conflict = await f.request('draft-generations', { ...request, instruction: '另一个不同的创作要求' }); assert.equal(conflict.status, 409);
  release(); const done = await finished(f, first.id); assert.equal(done.status, 'completed');
  assert.equal(ok(await f.request('draft-generations', request)).id, first.id);
  assert.equal(ok(await f.request('draft-generations', equivalentRequest)).id, first.id);
  const current = await state(f); assert.equal(current.drafts.length, initial.drafts.length + 1); assert.equal(calls, 1);
  assert.equal(current.drafts.filter(item => item.id === done.draftId).length, 1);
});

test('failed model calls are explicit durable failures with no false success, duplicate draft or automatic retry', async t => {
  let fail = true, calls = 0;
  const f = await fixture(t, { fetcher: async () => { calls++; if (fail) throw Error('NEVER_ECHO /private/credentials ' + aiEnv.REDPILOT_AI_KEY); return modelResponse(); } });
  const initial = await state(f), request = payload(), job = ok(await f.request('draft-generations', request));
  const failed = await finished(f, job.id); assert.equal(failed.status, 'failed'); assert.equal(failed.phase, 'failed'); assert.ok(failed.error); assert.ok(failed.reasonCode);
  assert.ok(!failed.draftId); assert.equal((await state(f)).drafts.length, initial.drafts.length);
  assert.doesNotMatch(JSON.stringify(failed), /NEVER_ECHO|\/private\/credentials|test-only-draft-generation-key/);
  assert.equal(ok(await f.request('draft-generations', request)).id, job.id); await f.reopen(); assert.equal(calls, 1);
  fail = false; const retry = ok(await f.request('draft-generations', { ...request, clientRequestId: randomUUID() })); assert.notEqual(retry.id, job.id);
  assert.equal((await finished(f, retry.id)).status, 'completed'); assert.equal(calls, 2); assert.equal((await state(f)).drafts.length, initial.drafts.length + 1);
});

test('a malformed model result cannot leave a partial or successfully labelled draft', async t => {
  const f = await fixture(t, { fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"unexpected":"not a draft"}' } }] })) });
  const initial = await state(f), job = await start(f), failed = await finished(f, job.id);
  assert.equal(failed.status, 'failed'); assert.ok(failed.error); assert.ok(!failed.draftId);
  assert.equal((await state(f)).drafts.length, initial.drafts.length);
});

test('provider timeouts produce a retryable explicit failure without an automatically repeated call', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; throw new DOMException('test-only timeout', 'TimeoutError'); } });
  const job = await start(f), failed = await finished(f, job.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.reasonCode, 'ai_timeout'); assert.match(failed.error, /超时|超过|未完成/);
  assert.ok(!failed.draftId); assert.equal(calls, 1); assert.equal((await state(f)).jobs.length, 0);
});

test('templates, automatic fallback and image or text modes retain existing draft semantics without any AI calls', async t => {
  let calls = 0; const f = await fixture(t, { env: {}, fetcher: async () => { calls++; throw Error('template must not call AI'); } });
  const asset = await image(f);
  for (const [method, contentMode, ids] of [['template', 'text', [asset.id]], ['auto', 'text', []], ['template', 'image', []], ['template', 'image', [asset.id]]]) {
    const job = await start(f, { method, contentMode, productAssetIds: ids }); const done = await finished(f, job.id); assert.equal(done.status, 'completed');
    const generated = (await state(f)).drafts.find(item => item.id === done.draftId);
    assert.equal(generated.method, 'template'); assert.equal(generated.contentMode, contentMode);
    if (contentMode === 'text') { assert.deepEqual(generated.slides, []); assert.deepEqual(generated.productAssetIds, []); }
    else { assert.deepEqual(generated.productAssetIds, ids); if (!ids.length) assert.equal((await f.request(`drafts/${generated.id}/approve`, {})).status, 409); }
  }
  assert.equal(calls, 0); assert.equal((await state(f)).jobs.length, 0);
  assert.equal((await f.request('draft-generations', payload())).status, 409);
});

test('default product pictures exclude test-only assets while an explicit selection remains explicit', async t => {
  const f = await fixture(t, { env: {}, fetcher: async () => { throw Error('template must not call AI'); } });
  const normal = await image(f), marked = await image(f, 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQy/tAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAN/z8EzmkyhsAAAAAElFTkSuQmCC', 'reference-background.png');
  await f.store.mutate(s => { s.productAssets.find(item => item.id === marked.id).metadata.testOnly = true; });
  const automatic = await start(f, { method: 'template', contentMode: 'image' }), defaultDone = await finished(f, automatic.id);
  assert.equal(defaultDone.status, 'completed'); assert.deepEqual((await state(f)).drafts.find(item => item.id === defaultDone.draftId).productAssetIds, [normal.id]);
  const explicit = await start(f, { method: 'template', contentMode: 'image', productAssetIds: [marked.id] }), explicitDone = await finished(f, explicit.id);
  assert.equal(explicitDone.status, 'completed'); assert.deepEqual((await state(f)).drafts.find(item => item.id === explicitDone.draftId).productAssetIds, [marked.id]);
});

test('invalid targets and inputs are rejected before queueing or contacting a model while paused accounts can still prepare drafts', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return modelResponse(); } });
  const archived = ok(await f.request('accounts', { name: '归档账号', type: 'personal' })); ok(await f.request(`accounts/${archived.id}/archive`, {}));
  const paused = ok(await f.request('accounts', { name: '暂停但可写稿账号', type: 'personal', enabled: false }));
  const cases = [[{ accountId: 'missing-account' }, 404], [{ accountId: archived.id }, 409], [{ referenceId: 'missing-reference' }, 404], [{ method: 'invalid' }, 400], [{ contentMode: 'video' }, 400], [{ contentMode: 'image', productAssetIds: ['missing-image'] }, 400]];
  for (const [invalid, status] of cases) assert.equal((await f.request('draft-generations', payload(invalid))).status, status);
  assert.equal((await state(f)).draftGenerationJobs.length, 0); assert.equal(calls, 0);
  ok(await f.request('product', (await state(f)).product, 'PUT', { accountId: paused.id }));
  const job = ok(await f.request('draft-generations', payload({ method: 'template', accountId: paused.id }), 'POST', { accountId: paused.id })), done = await finished(f, job.id, paused.id);
  assert.equal(done.status, 'completed'); assert.equal((await state(f, paused.id)).drafts.find(item => item.id === done.draftId).accountId, paused.id); assert.equal(calls, 0);
  assert.equal((await state(f)).drafts.some(item => item.id === done.draftId), false);
});

test('URL-only references reuse their pending reader before generating and reading does not block other writes', async t => {
  let release, calls = 0, prompt; const gate = new Promise(resolve => { release = resolve; });
  const url = 'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
  const f = await fixture(t, { beforeClose: () => release(), linkReader: async ({ url }) => { await gate; return { status: 'ready', kind: 'note', title: '已读主笔记', text: '网页实际完整正文：先提出具体问题，再写使用条件。', author: '测试作者', tags: [], images: [], canonicalUrl: url, missing: [] }; },
    fetcher: async (_url, request) => { calls++; prompt = JSON.parse(request.body); return modelResponse(); } });
  const ref = ok(await f.request('inspirations', { url, files: [] })).item, job = await start(f, { referenceId: ref.id });
  await waitUntil(async () => (await state(f)).draftGenerationJobs.find(item => item.id === job.id && item.phase === 'reading'), 'task did not wait for its existing reader');
  assert.equal(calls, 0); ok(await f.request('accounts', { name: '读取参考期间可写入', type: 'personal' }));
  release(); const done = await finished(f, job.id); assert.equal(done.status, 'completed'); assert.equal(calls, 1);
  assert.match(JSON.stringify(prompt), /网页实际完整正文/);
  assert.deepEqual((await state(f)).drafts.find(item => item.id === done.draftId).referenceIds, [ref.id]);
});

test('a login-gated pending source fails clearly without calling AI or losing the saved reference', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const url = 'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
  const f = await fixture(t, { beforeClose: () => release(), linkReader: async () => { await gate; return { status: 'needs_login', missing: [] }; }, fetcher: async () => { calls++; return modelResponse(); } });
  const ref = ok(await f.request('inspirations', { url, files: [] })).item, initial = await state(f), job = await start(f, { referenceId: ref.id });
  await waitUntil(async () => (await state(f)).draftGenerationJobs.some(item => item.id === job.id && item.phase === 'reading'), 'task did not enter source reading phase');
  release(); const failed = await finished(f, job.id); assert.equal(failed.status, 'failed'); assert.match(failed.error, /读取|登录|参考/); assert.equal(calls, 0);
  const current = await state(f); assert.equal(current.inspirations.find(item => item.id === ref.id).url, url); assert.equal(current.drafts.length, initial.drafts.length);
  assert.equal((await f.request('draft-generations', payload({ referenceId: ref.id }))).status, 409);
});

test('AI generation can use screenshots and selected own product images while keeping their roles distinct on the saved draft', async t => {
  let request;
  const f = await fixture(t, { fetcher: async (_url, options) => { request = JSON.parse(options.body); return modelResponse(); } });
  const asset = await image(f), ref = await source(f, { text: '', files: [{ name: 'reference.png', data: PNG }] });
  const job = await start(f, { referenceId: ref.id, contentMode: 'image', productAssetIds: [asset.id] }), done = await finished(f, job.id);
  assert.equal(done.status, 'completed'); const generated = (await state(f)).drafts.find(item => item.id === done.draftId);
  assert.deepEqual(generated.referenceIds, [ref.id]); assert.deepEqual(generated.productAssetIds, [asset.id]); assert.equal(generated.contentMode, 'image');
  assert.equal(request.messages[1].content.filter(item => item.type === 'image_url').length, 2);
  assert.equal((await state(f)).imageJobs.length, 0); assert.deepEqual(f.sideEffects, { publish: 0, verify: 0 });
});

test('product, source, account, discussion or selected material changes invalidate pending model output', async t => {
  for (const changed of ['product', 'source', 'account', 'discussion', 'material']) {
    let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { beforeClose: () => release(), fetcher: async () => { calls++; await gate; return modelResponse(); } });
    const initial = await state(f), ref = await source(f), asset = await image(f);
    const discussion = changed === 'discussion' ? ok(await f.request('discussions', { accountId: initial.defaultAccountId, title: '待生成的讨论', brief: '原始需求', sources: [{ title: '当前参考', url: '#reference/' + ref.id }] })) : null;
    const job = await start(f, { referenceId: ref.id, contentMode: 'image', productAssetIds: [asset.id], ...(discussion ? { discussionId: discussion.id } : {}) });
    await waitUntil(async () => calls === 1, 'model did not start for ' + changed);
    if (changed === 'product') ok(await f.request('product', { ...initial.product, summary: initial.product.summary + ' 已更新。' }, 'PUT'));
    else if (changed === 'source') await source(f, { targetId: ref.id, text: '更新后的参考正文与原先内容不同。' });
    else if (changed === 'account') ok(await f.request(`accounts/${initial.defaultAccountId}`, { notes: '新的账号定位' }, 'PUT'));
    else if (changed === 'discussion') ok(await f.request(`discussions/${discussion.id}`, { brief: '更新后的讨论需求' }, 'PUT'));
    else await f.store.mutate(s => { s.productAssets.find(item => item.id === asset.id).description = '已更改的产品图片说明'; });
    release(); const failed = await finished(f, job.id);
    assert.equal(failed.status, 'failed', changed); assert.equal(failed.reasonCode, 'source_changed', changed); assert.ok(!failed.draftId);
    assert.equal((await state(f)).drafts.length, initial.drafts.length, changed); assert.equal(calls, 1);
  }
});

test('restart marks queued and running generations failed without another model call and leaves finished jobs recoverable', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return modelResponse(); } });
  const initial = await state(f);
  await f.store.mutate(s => { s.draftGenerationJobs.push(
    { id: 'interrupted-draft-queued', status: 'queued', phase: 'queued', request: payload(), accountId: initial.defaultAccountId, createdAt: new Date().toISOString() },
    { id: 'interrupted-draft-running', status: 'running', phase: 'generating', request: payload(), accountId: initial.defaultAccountId, createdAt: new Date().toISOString() }
  ); });
  await f.reopen(); const current = await state(f);
  for (const id of ['interrupted-draft-queued', 'interrupted-draft-running']) { const job = current.draftGenerationJobs.find(item => item.id === id); assert.equal(job.status, 'failed'); assert.equal(job.phase, 'failed'); assert.match(job.error, /重启/); assert.ok(!job.draftId); }
  assert.equal(calls, 0); assert.equal(current.drafts.length, initial.drafts.length);
});

test('generation APIs require the real session and same-origin mutations without queueing unauthorized tasks', async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return modelResponse(); } });
  const anonymous = await f.request('draft-generations', payload(), 'POST', { authenticated: false }); assert.equal(anonymous.status, 401); assert.equal(anonymous.data.code, 'AUTH_REQUIRED');
  assert.equal((await f.request('draft-generations', payload(), 'POST', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await state(f)).draftGenerationJobs.length, 0); assert.equal(calls, 0);
});
