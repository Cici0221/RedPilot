import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';
import { queueDraftImages, settleDraftImageBatch, adoptDraftImage, planDraftImages } from '../app/draft-images.mjs';

const root = path.resolve(import.meta.dirname, '..');
const env = { REDPILOT_IMAGE_API_KEY: 'fixture-draft-image-key', REDPILOT_IMAGE_BASE_URL: 'https://images.example/v1', REDPILOT_IMAGE_MODEL: 'fixture-image' };
const image = (id, metadata = {}, extra = {}) => ({ id, name: '产品实拍.png', kind: 'image', mime: 'image/png', size: 100, metadata, ...extra });
function unitState() {
  return { accounts: [{ id: 'account', enabled: true, archived: false }], jobs: [], imageJobs: [], productAssets: [image('original')],
    product: { version: 'v1', name: 'RingHi', facts: ['保留备用号码'], conditions: ['设备需连接 Wi-Fi', '手机需要联网'], restrictions: ['不承诺零费用'] },
    drafts: [{ id: 'draft', accountId: 'account', contentMode: 'image', title: '备用号码怎么放', body: '保留备用号码。先确认使用条件。', productAssetIds: ['original'], revision: 1, history: [], approved: true }] };
}
const complete = (state, job, assetId) => {
  state.productAssets.push(image(assetId, { usage: 'publication', draftId: job.draftId, aiGenerated: true }));
  Object.assign(job, { status: 'completed', assetId });
};

test('image plans assign cover, points and conditions, prefer genuine references and exclude tests/icons/other drafts', () => {
  const s = unitState();
  s.productAssets.unshift(image('test', { testOnly: true }), image('derived-test', { sourceAssetIds: ['test'] }),
    image('cad', { previewOnly: true }), image('other-draft', { usage: 'publication', aiGenerated: true, draftId: 'other' }),
    image('logo-png', {}, { name: 'RingHi-logo.png' }), image('icon', {}, { kind: 'icon', mime: 'image/svg+xml' }));
  const plans = planDraftImages(s, s.drafts[0]);
  assert.deepEqual(plans.map(p => p.role), ['cover', 'points', 'conditions']);
  for (const plan of plans) {
    assert.deepEqual(plan.sourceAssetIds, ['original']); assert.equal(plan.mode, 'edit'); assert.equal(plan.size, '1024x1536');
    assert.ok(plan.prompt.length <= 4000); assert.ok(plan.copy.length <= 2);
  }
  assert.deepEqual(plans[0].copy, []); assert.deepEqual(plans[2].copy, s.product.conditions);
  s.productAssets = []; s.product.facts = []; s.product.conditions = [];
  const withoutSources = planDraftImages(s, s.drafts[0]);
  assert.equal(withoutSources[0].mode, 'generate'); assert.match(withoutSources[0].prompt, /不能凭空生成产品硬件/);
  assert.deepEqual(withoutSources[2].copy, ['RingHi']);
  s.productAssets = [image('cad', { previewOnly: true })];
  assert.match(planDraftImages(s, s.drafts[0])[0].prompt, /CAD几何参考/);
});

test('reference-led plans use the saved visible brief without treating competitor screenshots as product images', () => {
  const s = unitState(), draft = s.drafts[0];
  s.inspirations = [{id:'ref',accountId:'account',assets:['/uploads/competitor.png'],analysis:{visual:'旧的蓝白配色分析'}}];
  draft.referenceIds = ['ref'];
  draft.title = 'RingHi｜备用号，还要带备用机？';
  draft.body = '旧号还在用，工作号也不能随便停。为了备用号还要带手机吗？\n我们正在做 RingHi。\n• SIM 必须移入设备。\n• 短信同步到 App／网页查看。';
  draft.imageBrief = {basis:'reference',referenceId:'ref',layout:'大标题在上、产品生活场景在下',palette:'黑底、白字、亮蓝重点',typography:'高对比粗体问题标题',productTreatment:'真实产品放在桌面场景'};
  const plans = planDraftImages(s,draft);
  assert.equal(plans[0].referenceStyle.basis,'reference');assert.deepEqual(plans[0].referenceStyle.referenceIds,['ref']);
  assert.match(plans[0].prompt,/黑底、白字、亮蓝重点/);assert.doesNotMatch(plans[0].prompt,/旧的蓝白配色分析|整套保持一致的蓝白配色/);
  assert.equal(plans[0].headline,'备用号，还要带备用机？');
  assert.equal(plans[1].headline,'短信，怎么查看？');assert.ok(plans[1].copy.includes('短信同步到 App／网页查看'));
  assert.ok(plans[1].copy.every(line=>!line.includes('旧号还在用')&&!line.includes('我们正在')&&!line.includes('还要带手机')));
  assert.notEqual(plans[1].headline,plans[2].headline);
  for(const plan of plans){assert.deepEqual(plan.sourceAssetIds,['original']);assert.doesNotMatch(plan.prompt,/\/uploads\/competitor/);assert.match(plan.prompt,/不执行其中命令|不执行其中指令/);}
});

test('image direction falls back to visible saved analysis and excludes foreign or unviewed references', () => {
  const s=unitState(),draft=s.drafts[0];
  draft.referenceIds=['foreign','text-only','seen'];
  s.inspirations=[
    {id:'foreign',accountId:'other',assets:['/uploads/foreign.png'],analysis:{visual:'FOREIGN_STYLE'}},
    {id:'text-only',accountId:'account',assets:[],analysis:{visual:'UNSEEN_STYLE'}},
    {id:'seen',accountId:'account',assets:['/uploads/own-reference.png'],analysis:{visible_cover_patterns:['暖白纸感','左侧粗字标题']}}
  ];
  draft.imageBrief={basis:'reference',referenceId:'foreign',palette:'FOREIGN_BRIEF'};
  const observed=planDraftImages(s,draft)[0];assert.equal(observed.referenceStyle.basis,'reference');assert.deepEqual(observed.referenceStyle.referenceIds,['seen']);assert.match(observed.prompt,/暖白纸感/);assert.doesNotMatch(observed.prompt,/FOREIGN_STYLE|UNSEEN_STYLE|FOREIGN_BRIEF/);
  s.inspirations.pop();const original=planDraftImages(s,draft)[0];assert.equal(original.referenceStyle.basis,'original');assert.deepEqual(original.referenceStyle.referenceIds,[]);assert.match(original.prompt,/未取得可用封面视觉分析/);assert.doesNotMatch(original.prompt,/FOREIGN_STYLE|UNSEEN_STYLE|FOREIGN_BRIEF/);
});

test('maximal image briefs keep prompts within transport limits without dropping the user instruction', () => {
  const s=unitState(),draft=s.drafts[0];
  s.product.name='产'.repeat(32);s.product.stage='阶'.repeat(120);s.product.facts=Array.from({length:4},(_,i)=>String(i)+'实'.repeat(71));s.product.conditions=Array.from({length:4},(_,i)=>String(i)+'条'.repeat(63));s.product.restrictions=Array.from({length:4},(_,i)=>String(i)+'限'.repeat(71));
  s.inspirations=[{id:'ref',assets:['/uploads/ref.png']}];draft.referenceIds=['ref'];draft.imageBrief={basis:'reference',referenceId:'ref',...Object.fromEntries(['layout','palette','typography','productTreatment'].map(key=>[key,'设'.repeat(220)]))};
  const instruction='要'.repeat(800);const plans=planDraftImages(s,draft,{instruction});
  for(const plan of plans){assert.ok(plan.prompt.length<=4000,plan.prompt.length);assert.ok(plan.prompt.endsWith(instruction));}
});

test('automatic batches may wait behind another draft but never duplicate the same draft in flight', () => {
  const s=unitState();const other={...structuredClone(s.drafts[0]),id:'other'};s.drafts.push(other);
  queueDraftImages(s,'draft',{revision:1,count:1});
  assert.throws(()=>queueDraftImages(s,'other',{revision:1,count:1}),{status:409});
  const queued=queueDraftImages(s,'other',{revision:1,count:1},{allowQueue:true});assert.equal(queued.jobs.length,1);assert.equal(queued.jobs[0].draftId,'other');
  assert.throws(()=>queueDraftImages(s,'other',{revision:1,count:1},{allowQueue:true}),{status:409});
});

test('selected product sources guide the brief and changed visual inputs prevent stale attachment', () => {
  const base=unitState();base.productAssets.push(image('selected-source'));base.drafts[0].productAssetIds=[];base.drafts[0].imageSourceAssetIds=['selected-source'];
  assert.equal(planDraftImages(base,base.drafts[0])[0].sourceAssetIds[0],'selected-source');
  for(const change of [s=>{s.drafts[0].imageSourceAssetIds=['original'];},s=>{s.drafts[0].imageBrief={basis:'original',layout:'新的视觉方向'};},s=>{s.drafts[0].referenceIds=['new-reference'];}]){
    const s=structuredClone(base),batch=queueDraftImages(s,'draft',{revision:1,count:1});change(s);complete(s,batch.jobs[0],'finished');settleDraftImageBatch(s,batch.batchId);
    assert.deepEqual(s.drafts[0].productAssetIds,[]);assert.equal(batch.jobs[0].attachStatus,'conflict');
  }
});

test('an image batch attaches only once after all jobs terminate and invalidates approval', () => {
  const s = unitState(), draft = s.drafts[0];
  const batch = queueDraftImages(s, draft.id, { revision: 1, clientRequestId: 'one' });
  batch.jobs.forEach((job, index) => { complete(s, job, 'result-' + index); settleDraftImageBatch(s, batch.batchId);
    if (index < 2) assert.deepEqual(draft.productAssetIds, ['original']); });
  assert.deepEqual(draft.productAssetIds, ['result-0', 'result-1', 'result-2']);
  assert.equal(draft.revision, 2); assert.equal(draft.approved, false); assert.equal(draft.history.length, 1);
  assert.ok(batch.jobs.every(job => job.attachStatus === 'attached' && job.attachedRevision === 2));
  settleDraftImageBatch(s, batch.batchId); assert.equal(draft.revision, 2);
  const replay = queueDraftImages(s, draft.id, { revision: 1, clientRequestId: 'one' });
  assert.equal(replay.batchId, batch.batchId); assert.equal(s.imageJobs.length, 3);
  assert.throws(() => queueDraftImages(s, draft.id, { revision: 1, count: 1, clientRequestId: 'one' }), { status: 409 });
});

test('concurrent edits, asset changes, product changes, archive and schedule prevent automatic attachment', () => {
  for (const change of [
    s => { s.drafts[0].revision++; s.drafts[0].body = '用户新正文'; },
    s => { s.drafts[0].productAssetIds = []; },
    s => { s.product.version = 'v2'; },
    s => { s.accounts[0].archived = true; },
    s => { s.jobs.push({ draftId: 'draft', status: 'scheduled' }); },
    s => { s.drafts[0].accountId = 'other'; },
    s => { s.drafts = []; }
  ]) {
    const s = unitState();
    const batch = queueDraftImages(s, 'draft', { revision: 1, count: 1 });
    change(s); const saved = structuredClone(s.drafts);
    complete(s, batch.jobs[0], 'result'); settleDraftImageBatch(s, batch.batchId);
    assert.deepEqual(s.drafts, saved); assert.equal(batch.jobs[0].attachStatus, 'conflict');
    assert.equal(batch.jobs[0].assetId, 'result'); assert.ok(batch.jobs[0].attachError);
  }
});

test('failed single-image retries preserve successful siblings and restore the original order', () => {
  const s = unitState();
  const batch = queueDraftImages(s, 'draft', { revision: 1 });
  complete(s, batch.jobs[0], 'cover'); batch.jobs[1].status = 'failed'; complete(s, batch.jobs[2], 'conditions');
  settleDraftImageBatch(s, batch.batchId);
  assert.deepEqual(s.drafts[0].productAssetIds, ['cover', 'conditions']);
  const retry = queueDraftImages(s, 'draft', { revision: 2, retryJobId: batch.jobs[1].id, clientRequestId: 'retry' });
  assert.equal(retry.jobs.length, 1); assert.equal(retry.jobs[0].index, 1); assert.equal(retry.jobs[0].role, 'points');
  assert.equal(retry.jobs[0].setId, batch.batchId);
  complete(s, retry.jobs[0], 'points'); settleDraftImageBatch(s, retry.batchId);
  assert.deepEqual(s.drafts[0].productAssetIds, ['cover', 'points', 'conditions']);
  assert.throws(() => queueDraftImages(s, 'draft', { revision: 3, retryJobId: batch.jobs[1].id }), { status: 409 });
});

test('replacement keeps the target slot and manual adoption is scoped to the original draft and current revision', () => {
  const s = unitState();
  s.drafts[0].productAssetIds = ['original', 'old']; s.productAssets.push(image('old', { usage: 'publication', draftId: 'draft' }));
  const batch = queueDraftImages(s, 'draft', { revision: 1, replaceAssetId: 'old', instruction: '背景改为浅蓝' });
  assert.equal(batch.jobs.length, 1); assert.deepEqual(batch.jobs[0].sourceAssetIds, ['old', 'original']);
  complete(s, batch.jobs[0], 'new'); settleDraftImageBatch(s, batch.batchId);
  assert.deepEqual(s.drafts[0].productAssetIds, ['original', 'new']);
  const another = structuredClone(s.drafts[0]); another.id = 'other'; s.drafts.push(another);
  assert.throws(() => adoptDraftImage(s, 'other', batch.jobs[0].id, { revision: 2 }), { status: 409 });
  const conflict = queueDraftImages(s, 'draft', { revision: 2, count: 1 });
  s.drafts[0].revision++; s.drafts[0].body = '保留修改后的正文';
  complete(s, conflict.jobs[0], 'choice'); settleDraftImageBatch(s, conflict.batchId);
  assert.equal(conflict.jobs[0].attachStatus, 'conflict');
  assert.throws(() => adoptDraftImage(s, 'draft', conflict.jobs[0].id, { revision: 2 }), { status: 409 });
  adoptDraftImage(s, 'draft', conflict.jobs[0].id, { revision: 3 });
  assert.equal(s.drafts[0].body, '保留修改后的正文'); assert.deepEqual(s.drafts[0].productAssetIds, ['original', 'new', 'choice']);
});

test('invalid, text-mode, stale and overlapping requests are rejected before creating jobs', () => {
  const s = unitState();
  for (const input of [{}, { revision: 0 }, { revision: 1, count: 2 }, { revision: 1, instruction: 'x'.repeat(801) }]) {
    assert.throws(() => queueDraftImages(s, 'draft', input)); assert.equal(s.imageJobs.length, 0);
  }
  assert.throws(() => queueDraftImages(s, 'draft', { revision: 1 }, { ready: false }), { status: 409 });
  s.drafts[0].contentMode = 'text'; assert.throws(() => queueDraftImages(s, 'draft', { revision: 1 }), { status: 409 });
  s.drafts[0].contentMode = 'image'; queueDraftImages(s, 'draft', { revision: 1 });
  assert.throws(() => queueDraftImages(s, 'draft', { revision: 1 }), { status: 409 }); assert.equal(s.imageJobs.length, 3);
});

function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; }
function chunk(type, bytes) {
  const name = Buffer.from(type), output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); name.copy(output, 4); bytes.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, bytes])), output.length - 4); return output;
}
function png(color) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, color, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
const response = color => new Response(JSON.stringify({ data: [{ b64_json: png(color).toString('base64') }] }));
async function fixture(t, fetcher) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-draft-images-'));
  const credentials = { email: 'images@example.test', password: 'Fixture-' + randomBytes(16).toString('hex') };
  await configureAuth({ directory, ...credentials });
  let app, base, cookie, callsToPublish = 0;
  const open = async () => {
    app = await createApp({ root, directory, env, fetcher, trendReader: async () => [],
      feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [] }),
      xhsPublisher: { async publish() { callsToPublish++; }, async verify() { callsToPublish++; }, async close() {} } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  };
  await open();
  t.after(async () => { await app.close(); assert.equal(callsToPublish, 0); await rm(directory, { recursive: true, force: true }); });
  return { get store() { return app.store; }, async reopen() { await app.close(); await open(); },
    async request(endpoint, data, { anonymous = false, origin = base } = {}) {
      const result = await fetch(base + '/api/' + endpoint, { method: data === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', ...(anonymous ? {} : { Cookie: cookie }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: result.status, data: await result.json() };
    }
  };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
async function waitForBatch(f, batchId) {
  for (let i = 0; i < 120; i++) {
    const state = ok(await f.request('state'));
    const jobs = state.imageJobs.filter(job => job.batchId === batchId);
    if (jobs.length && jobs.every(job => ['completed', 'failed'].includes(job.status))) return { state, jobs };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('image batch did not finish');
}

test('draft-image HTTP batches use the existing edit API sequentially, persist provenance and deduplicate replay', async t => {
  let calls = 0, running = 0, maximum = 0;
  const f = await fixture(t, async (url, request) => {
    calls++; running++; maximum = Math.max(maximum, running);
    assert.equal(url, 'https://images.example/v1/images/edits');
    assert.ok(request.body instanceof FormData); assert.equal(request.body.getAll('image[]').length, 1);
    assert.match(request.body.get('prompt'), /上图文案/);
    await new Promise(resolve => setTimeout(resolve, 20)); running--; return response(calls);
  });
  ok(await f.request('product-assets/upload', { name: '产品实拍.png', kind: 'image', data: png(100).toString('base64') }));
  const initial = ok(await f.request('state')), draft = initial.drafts[0];
  const url = `drafts/${draft.id}/images`, input = { revision: draft.revision, clientRequestId: 'browser-unique-request' };
  assert.equal((await f.request(url, input, { anonymous: true })).status, 401);
  assert.equal((await f.request(url, input, { origin: 'https://evil.example' })).status, 403);
  const batch = ok(await f.request(url, input));
  const replay = ok(await f.request(url, input)); assert.equal(replay.batchId, batch.batchId);
  assert.equal((await f.request(url, { ...input, clientRequestId: 'different' })).status, 409);
  const done = await waitForBatch(f, batch.batchId);
  assert.equal(calls, 3); assert.equal(maximum, 1);
  assert.deepEqual(done.jobs.map(j => j.index), [0, 1, 2]);
  assert.ok(done.jobs.every(j => j.status === 'completed' && j.attachStatus === 'attached' && j.clientRequestId === input.clientRequestId));
  const saved = done.state.drafts.find(d => d.id === draft.id);
  assert.equal(saved.revision, draft.revision + 1); assert.deepEqual(saved.productAssetIds, done.jobs.map(j => j.assetId));
  for (const job of done.jobs) {
    const asset = done.state.productAssets.find(a => a.id === job.assetId);
    assert.equal(asset.metadata.draftId, draft.id); assert.equal(asset.metadata.reusable, false);
  }
  assert.equal(JSON.stringify(done.state).includes(env.REDPILOT_IMAGE_API_KEY), false);
  ok(await f.request(url, input)); assert.equal(calls, 3);
  await f.reopen(); assert.equal(ok(await f.request('state')).drafts.find(d => d.id === draft.id).productAssetIds.length, 3); assert.equal(calls, 3);
});

test('provider failure retains other images and retry bills only the requested failed slot', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++; if (calls === 2) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
    return response(calls);
  });
  const draft = ok(await f.request('state')).drafts[0], url = `drafts/${draft.id}/images`;
  const batch = ok(await f.request(url, { revision: 1 })), done = await waitForBatch(f, batch.batchId);
  assert.equal(done.jobs[1].status, 'failed'); assert.equal(done.state.drafts[0].productAssetIds.length, 2);
  const retry = ok(await f.request(url, { revision: 2, retryJobId: done.jobs[1].id }));
  const retried = await waitForBatch(f, retry.batchId);
  assert.equal(calls, 4); assert.equal(retried.jobs[0].attachStatus, 'attached');
  assert.deepEqual(retried.state.drafts[0].productAssetIds, [done.jobs[0].assetId, retried.jobs[0].assetId, done.jobs[2].assetId]);
});
