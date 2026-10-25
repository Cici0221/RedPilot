import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';
import { readableAssetFile } from '../app/product-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#007aff"/></svg>');
const bridgeEnv = {
  REDPILOT_PUBLISH_URL: 'https://publisher.example/publish',
  REDPILOT_PUBLISH_TOKEN: 'test-token', REDPILOT_ACCOUNT_ID: 'official-external'
};
const aiEnv = {
  REDPILOT_AI_KEY: 'test-key', REDPILOT_AI_MODEL: 'test-model', REDPILOT_AI_BASE_URL: 'https://model.example/v1'
};
const noteUrl = 'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';

async function fixture(t, { env = {}, fetcher } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-content-modes-'));
  const credentials = { email: 'fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  let app = await createApp({ feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }), trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env, fetcher });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function login() {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
    });
    assert.equal(response.status, 200, 'fixture login failed');
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'session cookie missing');
  }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await login();
  return {
    get store() { return app.store; },
    tick: date => app.tick(date),
    async reopen() {
      await app.close();
      app = await createApp({ feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }), trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env, fetcher });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
      await login();
    },
    async request(url, data, method = 'POST') {
      const response = await fetch(base + '/api/' + url, {
        method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {})
      });
      return { status: response.status, data: await response.json() };
    }
  };
}
const state = async f => (await f.request('state', undefined, 'GET')).data;
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function image(f, index = 0) {
  const before = new Set((await state(f)).productAssets.map(a => a.id));
  const data = index ? Buffer.concat([PNG, Buffer.from(String(index))]) : PNG;
  ok(await f.request('product-assets/upload', { name: `test-product-${index}.png`, kind: 'image', data: data.toString('base64') }));
  return (await state(f)).productAssets.find(a => !before.has(a.id));
}
async function draft(f, contentMode, extra = {}) {
  const generated = ok(await f.request('drafts', { contentMode, method: 'template', ...extra }));
  return ok(await f.request('drafts/' + generated.id, { ...generated, title: '备用号使用需求', ...extra }, 'PUT'));
}
async function schedule(f, d) {
  ok(await f.request(`drafts/${d.id}/approve`, {}));
  return ok(await f.request(`drafts/${d.id}/schedule`, { accountId: d.accountId, scheduledAt: new Date(Date.now() + 3600000).toISOString() }));
}
async function due(f) {
  await f.store.mutate(s => { for (const j of s.jobs) if (j.status === 'scheduled') j.scheduledAt = new Date(Date.now() - 60000).toISOString(); });
}
async function settings(f, imageShare, accountId, mode = 'review') {
  return ok(await f.request(accountId ? `accounts/${accountId}/settings` : 'settings', {
    enabled: true, time: '10:00', timezone: 'Asia/Shanghai', mode, imageShare
  }, 'PUT'));
}
function modelResult(index) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    title: `通信需求${index}`, body: 'SimHelper 当前处于开发内测。SIM 需要移入设备，设备需 Wi-Fi，手机需互联网。',
    tags: ['产品开发'], series: '一起打磨', slides: [{ headline: '通信需求', body: '开发内测' }], gaps: [], adaptation: '从具体问题切入'
  }) } }] }));
}
const day = number => new Date(Date.UTC(2027, 0, number, 2, 1));

// All credentials and images below are isolated test fixtures, never user runtime data.
test('legacy drafts migrate to image mode and legacy account settings receive the default image ratio', async t => {
  const f = await fixture(t);
  await f.store.mutate(s => {
    for (const d of s.drafts) delete d.contentMode;
    for (const a of s.accounts) { delete a.settings.imageShare; delete a.dailyHistory; }
  });
  await f.reopen();
  const s = await state(f);
  assert.ok(s.drafts.every(d => d.contentMode === 'image'));
  assert.equal(s.accounts[0].settings.imageShare, 70);
  assert.deepEqual(s.accounts[0].dailyHistory, []);
});

test('pure text template drafts save, approve and schedule with no slides or product pictures', async t => {
  const f = await fixture(t);
  const d = await draft(f, 'text');
  assert.equal(d.contentMode, 'text');
  assert.deepEqual(d.slides, []);
  assert.deepEqual(d.productAssetIds, []);
  assert.equal((await state(f)).productAssets.length, 0);
  const job = await schedule(f, d);
  assert.equal(job.draftId, d.id);
  assert.equal((await state(f)).draftChecks[d.id].some(x => /图片|主图|分镜/.test(x)), false);
});

test('changing an image draft to text removes both custom images and visual storyboard data', async t => {
  const f = await fixture(t);
  const asset = await image(f);
  const original = await draft(f, 'image', { productAssetIds: [asset.id], slides: [{ headline: '产品图', body: '开发内测' }] });
  ok(await f.request(`drafts/${original.id}/approve`, {}));
  const changed = ok(await f.request('drafts/' + original.id, { ...original, contentMode: 'text' }, 'PUT'));
  assert.equal(changed.contentMode, 'text');
  assert.deepEqual(changed.slides, []);
  assert.deepEqual(changed.productAssetIds, []);
  assert.equal(changed.approved, false);
  assert.equal((await f.request('drafts', { method: 'template', contentMode: 'invalid' })).status, 400);
});

test('image drafts may be saved without pictures but a logo cannot replace a product main image at approval', async t => {
  const f = await fixture(t);
  ok(await f.request('product-assets/upload', { name: 'brand.svg', kind: 'icon', data: ICON.toString('base64') }));
  const icon = (await state(f)).productAssets[0];
  for (const productAssetIds of [[], [icon.id]]) {
    const d = await draft(f, 'image', { productAssetIds, slides: [] });
    assert.equal(d.contentMode, 'image');
    const result = await f.request(`drafts/${d.id}/approve`, {});
    assert.equal(result.status, 409);
    assert.match(result.data.error, /主图|产品图/);
    assert.equal((await f.request(`drafts/${d.id}/schedule`, { scheduledAt: new Date(Date.now() + 3600000).toISOString() })).status, 409);
  }
});

test('image drafts can use a real main image without a storyboard and auto-select up to two recent images', async t => {
  const f = await fixture(t);
  const first = await image(f);
  const second = await image(f, 1);
  const third = await image(f, 2);
  const automatic = ok(await f.request('drafts', { contentMode: 'image', method: 'template' }));
  assert.equal(automatic.productAssetIds.length, 2);
  assert.deepEqual([...automatic.productAssetIds].sort(), [second.id, third.id].sort());
  assert.equal(automatic.productAssetIds.includes(first.id), false);
  const explicit = await draft(f, 'image', { productAssetIds: [], slides: [] });
  assert.deepEqual(explicit.productAssetIds, []);
  assert.equal((await f.request(`drafts/${explicit.id}/approve`, {})).status, 409);
  const ready = ok(await f.request('drafts/' + explicit.id, { ...explicit, productAssetIds: [first.id], slides: [] }, 'PUT'));
  assert.equal((await f.request(`drafts/${ready.id}/approve`, {})).status, 200);
});

test('text mode keeps normal product fact checks instead of bypassing content review', async t => {
  const f = await fixture(t);
  const d = await draft(f, 'text');
  ok(await f.request('drafts/' + d.id, { ...d, body: '当前为开发内测。我们承诺全运营商兼容。' }, 'PUT'));
  const result = await f.request(`drafts/${d.id}/approve`, {});
  assert.equal(result.status, 409);
  assert.match(result.data.error, /承诺|依据|核对/);
});

test('image ratio is an integer percentage, preserves the current value when omitted and persists across restart', async t => {
  const f = await fixture(t);
  assert.equal((await state(f)).settings.imageShare, 70);
  for (const imageShare of [-1, 101, 42.5, '70', null]) {
    const result = await f.request('settings', { enabled: false, time: '10:00', timezone: 'Asia/Shanghai', mode: 'review', imageShare }, 'PUT');
    assert.equal(result.status, 400);
  }
  await settings(f, 30);
  ok(await f.request('settings', { enabled: false, time: '11:00', timezone: 'Asia/Shanghai', mode: 'review' }, 'PUT'));
  assert.equal((await state(f)).settings.imageShare, 30);
  await f.reopen();
  assert.equal((await state(f)).settings.imageShare, 30);
});

test('daily mixing uses successful per-account history: ten successes give seven images and three texts', async t => {
  let calls = 0;
  const f = await fixture(t, { env: aiEnv, fetcher: async () => modelResult(++calls) });
  await image(f);
  await draft(f, 'text');
  await draft(f, 'image');
  assert.deepEqual((await state(f)).accounts[0].dailyHistory, []);
  await settings(f, 70);
  for (let n = 1; n <= 10; n++) { await f.tick(day(n)); await f.tick(day(n)); }
  const s = await state(f);
  const history = s.accounts[0].dailyHistory;
  assert.equal(calls, 10);
  assert.equal(history.length, 10);
  assert.equal(history.filter(x => x.contentMode === 'image').length, 7);
  assert.equal(history.filter(x => x.contentMode === 'text').length, 3);
  assert.equal(new Set(history.map(x => x.date)).size, 10);
  for (const entry of history) assert.equal(s.drafts.find(d => d.id === entry.draftId).contentMode, entry.contentMode);
  assert.equal(s.jobs.length, 0);
});

test('failed generation does not consume the image/text ratio and changing a ratio keeps past history', async t => {
  let calls = 0;
  const f = await fixture(t, {
    env: aiEnv,
    fetcher: async () => { calls++; if (calls <= 2) throw Error('test provider failure'); return modelResult(calls); }
  });
  await image(f);
  await settings(f, 70);
  for (let n = 1; n <= 12; n++) await f.tick(day(n));
  const history = (await state(f)).accounts[0].dailyHistory;
  assert.equal(history.length, 10);
  assert.equal(history.filter(x => x.contentMode === 'image').length, 7);
  assert.equal(history.filter(x => x.contentMode === 'text').length, 3);
  assert.equal(history.some(x => x.date === '2027-01-01' || x.date === '2027-01-02'), false);
  const previousEntries = structuredClone(history);
  await settings(f, 0);
  for (let n = 13; n <= 15; n++) await f.tick(day(n));
  const updated = (await state(f)).accounts[0].dailyHistory;
  assert.deepEqual(updated.filter(x => previousEntries.some(p => p.draftId === x.draftId)), previousEntries);
  assert.equal(updated.filter(x => !previousEntries.some(p => p.draftId === x.draftId)).every(x => x.contentMode === 'text'), true);
  // Starting 70% again begins a fresh phase; it does not try to compensate for old text-only days.
  const beforeResetIds = new Set(updated.map(x => x.draftId));
  await settings(f, 70);
  for (let n = 16; n <= 25; n++) await f.tick(day(n));
  const freshPhase = (await state(f)).accounts[0].dailyHistory.filter(x => !beforeResetIds.has(x.draftId));
  assert.equal(freshPhase.filter(x => x.contentMode === 'image').length, 7);
  assert.equal(freshPhase.filter(x => x.contentMode === 'text').length, 3);
});

test('missing product photos leave an automatic image draft pending instead of silently switching to text', async t => {
  let calls = 0;
  const f = await fixture(t, { env: aiEnv, fetcher: async () => modelResult(++calls) });
  await settings(f, 100, undefined, 'automatic');
  await f.tick(day(1));
  const s = await state(f);
  const generated = s.drafts.find(d => d.method === 'ai');
  assert.equal(generated.contentMode, 'image');
  assert.deepEqual(generated.productAssetIds, []);
  assert.ok(s.draftChecks[generated.id].some(x => /主图|产品图/.test(x)));
  assert.equal(s.jobs.length, 0);
});

test('content ratios are independent for different accounts', async t => {
  let calls = 0;
  const f = await fixture(t, { env: aiEnv, fetcher: async () => modelResult(++calls) });
  await image(f);
  const first = (await state(f)).accounts[0];
  const second = ok(await f.request('accounts', { name: '第二账号' }));
  await settings(f, 100, first.id);
  await settings(f, 0, second.id);
  await f.tick(day(1));
  const s = await state(f);
  assert.equal(s.accounts.find(a => a.id === first.id).dailyHistory[0].contentMode, 'image');
  assert.equal(s.accounts.find(a => a.id === second.id).dailyHistory[0].contentMode, 'text');
  assert.equal(calls, 2);
});

test('text dispatch explicitly uses platform-default cover semantics with no image data', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: { ...bridgeEnv, REDPILOT_PUBLISH_TEXT_ENABLED: 'true' },
    fetcher: async (_url, request) => {
      const payload = JSON.parse(request.body); calls.push(payload);
      return new Response(JSON.stringify({ status: 'published', verified: true, accountId: payload.accountId, noteUrl }));
    }
  });
  const d = await draft(f, 'text');
  await schedule(f, d); await due(f); await f.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].post.contentMode, 'text');
  assert.equal(calls[0].post.coverStrategy, 'platform_default');
  assert.deepEqual(calls[0].post.slides, []);
  assert.deepEqual(calls[0].post.images, []);
  assert.deepEqual(calls[0].post.sourceAssets, []);
  assert.equal((await state(f)).jobs[0].status, 'published');
});

test('text jobs stay blocked without an explicit text-capable bridge configuration', async t => {
  let submitted = 0;
  const f = await fixture(t, { env: bridgeEnv, fetcher: async () => { submitted++; throw Error('must not publish'); } });
  const d = await draft(f, 'text');
  await schedule(f, d); await due(f); await f.tick();
  const s = await state(f);
  assert.equal(s.jobs[0].status, 'blocked');
  assert.equal(s.jobs[0].attempts, 0);
  assert.equal(submitted, 0);
});

test('image dispatch sends the selected real product image even when no storyboard is present', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: bridgeEnv,
    fetcher: async (_url, request) => {
      const payload = JSON.parse(request.body); calls.push(payload);
      return new Response(JSON.stringify({ status: 'published', verified: true, accountId: payload.accountId, noteUrl }));
    }
  });
  const asset = await image(f);
  const d = await draft(f, 'image', { productAssetIds: [asset.id], slides: [] });
  await schedule(f, d); await due(f); await f.tick();
  assert.equal(calls.length, 1);
  const post = calls[0].post;
  assert.equal(post.contentMode, 'image');
  assert.equal(post.coverStrategy, 'custom');
  assert.equal(post.images.length, 1);
  assert.equal(post.images[0].id, asset.id);
  assert.deepEqual(Buffer.from(post.images[0].data, 'base64'), PNG);
  assert.ok(post.sourceAssets.some(a => a.id === asset.id));
  assert.equal((await state(f)).jobs[0].status, 'published');
});


test('verification of an image post needs only the saved submission key, even if its original image file is gone', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: bridgeEnv,
    fetcher: async (_url, request) => {
      const payload = JSON.parse(request.body); calls.push(payload);
      return new Response(JSON.stringify(payload.action === 'publish' ? { status: 'pending' } : {
        status: 'published', verified: true, accountId: payload.accountId, noteUrl
      }));
    }
  });
  const asset = await image(f);
  const d = await draft(f, 'image', { productAssetIds: [asset.id], slides: [] });
  const job = await schedule(f, d); await due(f); await f.tick();
  assert.equal((await state(f)).jobs[0].status, 'uncertain');
  const stored = f.store.state.productAssets.find(a => a.id === asset.id);
  await rm(await readableAssetFile(stored, f.store.directory));
  const checked = ok(await f.request(`jobs/${job.id}/verify`, {}));
  assert.equal(checked.status, 'published');
  assert.deepEqual(calls.map(c => c.action), ['publish', 'verify']);
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey);
  assert.equal(calls[1].accountId, calls[0].accountId);
  assert.deepEqual(calls[1].post.sourceAssets, []);
  assert.deepEqual(calls[1].post.images, []);
});
