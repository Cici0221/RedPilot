import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const NOTE = 'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
const OLD = 'SOURCE_OLD_SENTINEL：旧版参考正文。';
const NEW = 'SOURCE_NEW_SENTINEL：重读后的最新参考正文。';
const page = text => ({ kind: 'note', status: 'ready', title: '实际参考问题', text, author: '测试作者', tags: [], images: [], canonicalUrl: NOTE, missing: [] });
const model = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '先确认通信适用条件', body: 'SimHelper 仍处于开发内测。SIM 需移入设备，设备需 Wi-Fi，手机需互联网。', tags: ['产品开发'], series: '通信小麻烦', slides: [], gaps: [], adaptation: '依据已保存的实际参考正文组织问题' }) } }] }));
async function fixture(t, { linkReader, fetcher, beforeClose }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-workflow-audit-'));
  const credentials = { email: 'workflow-audit@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  const app = await createApp({ root, directory, env: { REDPILOT_AI_KEY: 'test-only-workflow-key', REDPILOT_AI_MODEL: 'fixture-model', REDPILOT_AI_BASE_URL: 'https://model.example/v1' }, linkReader, fetcher,
    feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [] }), trendReader: async () => [],
    xhsPublisher: { async checkConnection() { return { status: 'unavailable' }; }, async publish() { throw Error('must not publish'); }, async verify() { throw Error('must not verify'); } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  t.after(async () => { beforeClose?.(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { async request(endpoint, data, method = 'POST') {
    const response = await fetch(base + '/api/' + endpoint, { method, signal: AbortSignal.timeout(5000), headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    assert.equal(response.status, 200); return response.json();
  } };
}
const state = f => f.request('state', undefined, 'GET');
async function waitUntil(fn, message) { for (let n = 0; n < 250; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail(message); }
async function initialReference(f) {
  const { item } = await f.request('inspirations', { url: NOTE, files: [] });
  return waitUntil(async () => (await state(f)).inspirations.find(ref => ref.id === item.id && ref.linkRead?.status === 'ready'), 'first reference read did not finish');
}
const generate = (f, referenceId) => f.request('draft-generations', { referenceId, method: 'ai', contentMode: 'text', clientRequestId: randomUUID() });

// These race regressions use only temporary state and gated fake readers/models.
test('an active reread is awaited even when the collection already contains a usable previous body', async t => {
  let release, reads = 0, calls = 0, prompt; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), linkReader: async () => { reads++; if (reads === 1) return page(OLD); await gate; return page(NEW); },
    fetcher: async (_url, request) => { calls++; prompt = JSON.parse(request.body); return model(); } });
  const reference = await initialReference(f); assert.equal(reference.text, OLD);
  await f.request(`inspirations/${reference.id}/read-link`, {}); await waitUntil(async () => reads === 2, 'reread did not start');
  const job = await generate(f, reference.id);
  await waitUntil(async () => (await state(f)).draftGenerationJobs.find(item => item.id === job.id && item.phase === 'reading'), 'generation bypassed the pending reread');
  assert.equal(calls, 0); release();
  const done = await waitUntil(async () => (await state(f)).draftGenerationJobs.find(item => item.id === job.id && item.status === 'completed'), 'generation did not finish after reread');
  assert.equal(calls, 1); assert.match(JSON.stringify(prompt), /SOURCE_NEW_SENTINEL/); assert.doesNotMatch(JSON.stringify(prompt), /SOURCE_OLD_SENTINEL/);
  assert.ok((await state(f)).drafts.some(draft => draft.id === done.draftId));
});

test('a new reread begun during AI generation invalidates its old result before the new body arrives', async t => {
  let releasePage, releaseModel, reads = 0, calls = 0;
  const pageGate = new Promise(resolve => { releasePage = resolve; }), modelGate = new Promise(resolve => { releaseModel = resolve; });
  const f = await fixture(t, { beforeClose: () => { releasePage(); releaseModel(); }, linkReader: async () => { reads++; if (reads === 1) return page(OLD); await pageGate; return page(NEW); },
    fetcher: async () => { calls++; await modelGate; return model(); } });
  const reference = await initialReference(f), initial = await state(f), job = await generate(f, reference.id);
  await waitUntil(async () => calls === 1, 'model did not start');
  await f.request(`inspirations/${reference.id}/read-link`, {}); await waitUntil(async () => reads === 2, 'new reread did not start');
  releaseModel();
  const failed = await waitUntil(async () => (await state(f)).draftGenerationJobs.find(item => item.id === job.id && item.status === 'failed'), 'old generation was saved before its pending reread');
  assert.equal(failed.reasonCode, 'source_changed'); assert.ok(!failed.draftId); assert.equal((await state(f)).drafts.length, initial.drafts.length);
  releasePage(); await waitUntil(async () => (await state(f)).inspirations.find(ref => ref.id === reference.id && ref.text === NEW), 'new body was not retained');
  assert.equal((await state(f)).draftGenerationJobs.find(item => item.id === job.id).status, 'failed'); assert.equal(calls, 1);
});

test('a failed reread cannot silently use an older usable body for the generation waiting on it', async t => {
  let release, reads = 0, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), linkReader: async () => { reads++; if (reads === 1) return page(OLD); await gate; return { status: 'needs_login', missing: [] }; }, fetcher: async () => { calls++; return model(); } });
  const reference = await initialReference(f), initial = await state(f);
  await f.request(`inspirations/${reference.id}/read-link`, {}); const job = await generate(f, reference.id);
  await waitUntil(async () => (await state(f)).draftGenerationJobs.find(item => item.id === job.id && item.phase === 'reading'), 'generation did not await reread');
  release(); const failed = await waitUntil(async () => (await state(f)).draftGenerationJobs.find(item => item.id === job.id && item.status === 'failed'), 'failed reread was not reported');
  assert.equal(failed.reasonCode, 'source_failed'); assert.equal(calls, 0); assert.equal((await state(f)).drafts.length, initial.drafts.length);
  assert.equal((await state(f)).inspirations.find(ref => ref.id === reference.id).text, OLD);
});
