import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';
import { randomBytes } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const noteUrl = 'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
const bridgeEnv = {
  REDPILOT_PUBLISH_URL: 'https://publisher.example/publish',
  REDPILOT_PUBLISH_TOKEN: 'test-token',
  REDPILOT_ACCOUNT_ID: 'official-external'
};
const aiEnv = {
  REDPILOT_AI_KEY: 'test-key',
  REDPILOT_AI_MODEL: 'test-vision',
  REDPILOT_AI_BASE_URL: 'https://model.example/v1'
};

async function fixture(t, { env = {}, fetcher, legacy } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-accounts-'));
  if (legacy) await writeFile(path.join(directory, 'state.json'), JSON.stringify(legacy));
  const credentials = { email: 'fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory: directory, ...credentials });
  let app = await createApp({ root, directory, env, fetcher });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function login() {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
    });
    assert.equal(response.status, 200, 'fixture login failed');
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'fixture session cookie missing');
  }
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await login();
  const upload = await fetch(base + '/api/product-assets/upload', {
    method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-product.png', kind: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' })
  });
  assert.equal(upload.status, 200, 'fixture product image upload failed');
  await app.store.mutate(s => {
    const image = s.productAssets.find(asset => asset.kind === 'image');
    for (const draft of s.drafts) draft.productAssetIds = [image.id];
  });
  return {
    get store() { return app.store; },
    tick: date => app.tick(date),
    directory,
    async reopen() {
      await app.close();
      app = await createApp({ root, directory, env, fetcher });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
      await login();
    },
    async request(url, data, method = 'POST') {
      const response = await fetch(base + '/api/' + url, {
        method,
        headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {})
      });
      return { status: response.status, data: await response.json() };
    }
  };
}
const state = async f => (await f.request('state', undefined, 'GET')).data;
function ok(result) {
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function addAccount(f, extra = {}) {
  return ok(await f.request('accounts', { name: '测试小号', type: 'personal', ...extra }));
}
async function draftFor(f, accountId, title = '备用号使用需求') {
  const generated = ok(await f.request('drafts', { accountId, method: 'template' }));
  return ok(await f.request('drafts/' + generated.id, { ...generated, title }, 'PUT'));
}
async function schedule(f, draft) {
  ok(await f.request(`drafts/${draft.id}/approve`, {}));
  return ok(await f.request(`drafts/${draft.id}/schedule`, {
    accountId: draft.accountId,
    scheduledAt: new Date(Date.now() + 3600000).toISOString()
  }));
}
async function makeDue(f) {
  await f.store.mutate(s => {
    for (const job of s.jobs) {
      if (job.status === 'scheduled') job.scheduledAt = new Date(Date.now() - 60000).toISOString();
    }
  });
}
function verified(accountId) {
  return new Response(JSON.stringify({ status: 'published', verified: true, noteUrl, accountId }));
}
function legacyState() {
  const product = {
    name: 'SimHelper', brand: '人类补丁', stage: '开发内测', summary: '备用号码管理设备',
    facts: ['短信同步'], conditions: ['SIM 需移入设备'], restrictions: [], sources: [], version: 'product-v1'
  };
  const draft = {
    id: 'legacy-draft', title: '旧草稿', body: '当前为开发内测。', series: '通信小麻烦', tags: [],
    slides: [{ headline: '旧草稿', body: '开发内测' }], gaps: [], productVersion: product.version,
    status: 'scheduled', approved: true, revision: 1, history: [], createdAt: '2026-10-24T01:00:00Z'
  };
  return {
    schemaVersion: 1, product, settings: { enabled: true, time: '09:45', timezone: 'Asia/Shanghai', mode: 'review' },
    lastDailyKey: '2026-10-24', inspirations: [], drafts: [draft, { ...draft, id: 'legacy-unsubmitted', status: 'draft' }],
    jobs: [{
      id: 'legacy-job', draftId: draft.id, draftRevision: 1, title: draft.title,
      account: 'historical-external', status: 'uncertain', attempts: 1,
      idempotencyKey: 'legacy-idempotency', scheduledAt: '2026-10-24T02:00:00Z'
    }], events: []
  };
}

test('initial official account and new personal account retain independent settings', async t => {
  const f = await fixture(t, { env: bridgeEnv });
  const initial = await state(f);
  assert.equal(initial.schemaVersion, 3);
  assert.equal(initial.accounts.length, 1);
  const official = initial.accounts[0];
  assert.equal(initial.defaultAccountId, official.id);
  assert.equal(official.type, 'official');
  assert.equal(official.bridgeAccountId, 'official-external');
  assert.equal(initial.capabilities.publisher, true);
  assert.equal(initial.capabilities.accounts[official.id].publisher, true);
  assert.equal(initial.drafts[0].accountId, official.id);

  const personal = await addAccount(f);
  assert.equal(personal.type, 'personal');
  assert.equal(personal.enabled, true);
  assert.equal(personal.archived, false);
  assert.equal(personal.settings.enabled, false);
  assert.equal(personal.bridgeAccountId, '');
  assert.equal(personal.lastDailyKey, null);
  const updated = await state(f);
  assert.equal(updated.capabilities.accounts[personal.id].publisher, false);
  assert.equal(updated.defaultAccountId, official.id);
  assert.equal(JSON.stringify(updated).includes('test-token'), false);
});

test('legacy migration preserves daily settings and submitted historical account targets', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: bridgeEnv, legacy: legacyState(),
    fetcher: async (_url, request) => {
      calls.push(JSON.parse(request.body));
      return verified('historical-external');
    }
  });
  const migrated = await state(f);
  const official = migrated.accounts.find(a => a.id === migrated.defaultAccountId);
  const historical = migrated.accounts.find(a => a.bridgeAccountId === 'historical-external');
  assert.equal(official.settings.time, '09:45');
  assert.equal(official.settings.mode, 'review');
  assert.equal(official.lastDailyKey, '2026-10-24');
  assert.equal(historical.enabled, false);
  assert.notEqual(historical.id, official.id);
  assert.equal(migrated.jobs[0].accountId, historical.id);
  assert.equal(migrated.drafts.find(d => d.id === 'legacy-draft').accountId, historical.id);
  assert.equal(migrated.drafts.find(d => d.id === 'legacy-unsubmitted').accountId, official.id);
  const result = ok(await f.request('jobs/legacy-job/verify', {}));
  assert.equal(result.status, 'published');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'verify');
  assert.equal(calls[0].accountId, 'historical-external');
  assert.equal(calls[0].idempotencyKey, 'legacy-idempotency');
});

test('account editing validates fields and unique mappings, defaults cannot be archived', async t => {
  const f = await fixture(t);
  const official = (await state(f)).accounts[0];
  assert.equal((await f.request(`accounts/${official.id}/archive`, {})).status, 409);
  for (const bad of [{ name: '' }, { name: 'x', type: 'invalid' }, { name: 'x', enabled: 'true' }, { name: 'x', profileUrl: 'javascript:alert(1)' }]) {
    assert.equal((await f.request('accounts', bad)).status, 400);
  }
  const first = await addAccount(f, { bridgeAccountId: 'personal-external' });
  assert.equal((await f.request('accounts', { name: '重复映射', bridgeAccountId: 'personal-external' })).status, 409);
  const edited = ok(await f.request('accounts/' + first.id, { name: '体验账号', handle: 'sample-handle', notes: '场景分享' }, 'PUT'));
  assert.equal(edited.name, '体验账号');
  assert.equal(edited.bridgeAccountId, 'personal-external');
  ok(await f.request(`accounts/${first.id}/default`, {}));
  assert.equal((await state(f)).defaultAccountId, first.id);
  ok(await f.request(`accounts/${official.id}/archive`, {}));
  assert.equal((await state(f)).accounts.find(a => a.id === official.id).archived, true);
  assert.equal((await f.request(`accounts/${official.id}/default`, {})).status, 409);
  assert.equal((await f.request('drafts', { accountId: official.id, method: 'template' })).status, 409);
  assert.equal((await f.request('accounts/missing/default', {})).status, 404);
});

test('draft account changes clear approval; a schedule cannot silently switch its target account', async t => {
  const f = await fixture(t);
  const official = (await state(f)).accounts[0];
  const personal = await addAccount(f);
  const draft = await draftFor(f, official.id);
  ok(await f.request(`drafts/${draft.id}/approve`, {}));
  const moved = ok(await f.request('drafts/' + draft.id, { ...draft, accountId: personal.id }, 'PUT'));
  assert.equal(moved.accountId, personal.id);
  assert.equal(moved.approved, false);
  assert.equal((await f.request('drafts', { accountId: 'missing', method: 'template' })).status, 404);
  ok(await f.request(`drafts/${draft.id}/approve`, {}));
  assert.equal((await f.request(`drafts/${draft.id}/schedule`, {
    accountId: official.id, scheduledAt: new Date(Date.now() + 3600000).toISOString()
  })).status, 409);
  assert.equal((await state(f)).jobs.length, 0);
  const job = await schedule(f, moved);
  assert.equal(job.accountId, personal.id);
  assert.equal((await f.request('drafts/' + draft.id, { ...moved, accountId: official.id }, 'PUT')).status, 409);
});

test('two scheduled accounts dispatch to their own external IDs and keep per-account records', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: bridgeEnv,
    fetcher: async (_url, request) => {
      const payload = JSON.parse(request.body);
      calls.push(payload);
      return verified(payload.accountId);
    }
  });
  const official = (await state(f)).accounts[0];
  const personal = await addAccount(f, { name: '体验账号', bridgeAccountId: 'personal-external' });
  await schedule(f, await draftFor(f, official.id, '官方内容'));
  await schedule(f, await draftFor(f, personal.id, '体验内容'));
  await makeDue(f);
  await f.tick();
  assert.deepEqual(calls.map(c => c.accountId).sort(), ['official-external', 'personal-external']);
  const published = await state(f);
  assert.equal(published.jobs.filter(j => j.status === 'published').length, 2);
  for (const job of published.jobs) {
    assert.equal(published.drafts.find(d => d.id === job.draftId).accountId, job.accountId);
    const expected = published.accounts.find(a => a.id === job.accountId);
    assert.equal(job.account, expected.bridgeAccountId);
    assert.equal(job.accountName, expected.name);
  }
});

test('an unmapped personal account cannot fall back to the legacy official environment ID', async t => {
  let calls = 0;
  const f = await fixture(t, { env: bridgeEnv, fetcher: async () => { calls++; throw Error('must not submit'); } });
  const personal = await addAccount(f);
  const job = await schedule(f, await draftFor(f, personal.id));
  await makeDue(f);
  await f.tick();
  const actual = (await state(f)).jobs.find(j => j.id === job.id);
  assert.equal(actual.status, 'blocked');
  assert.equal(actual.attempts, 0);
  assert.equal(calls, 0);
});

test('pausing an account blocks its queued post without affecting another account', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: bridgeEnv,
    fetcher: async (_url, request) => { const payload = JSON.parse(request.body); calls.push(payload); return verified(payload.accountId); }
  });
  const official = (await state(f)).accounts[0];
  const personal = await addAccount(f, { bridgeAccountId: 'paused-external' });
  const blocked = await schedule(f, await draftFor(f, personal.id));
  await schedule(f, await draftFor(f, official.id));
  ok(await f.request('accounts/' + personal.id, { enabled: false }, 'PUT'));
  await makeDue(f);
  await f.tick();
  const s = await state(f);
  assert.equal(s.jobs.find(j => j.id === blocked.id).status, 'blocked');
  assert.equal(s.jobs.find(j => j.id === blocked.id).attempts, 0);
  assert.deepEqual(calls.map(c => c.accountId), ['official-external']);
});

test('submitted account bindings stay immutable and verification uses the original target while paused', async t => {
  const calls = [];
  const env = { ...bridgeEnv };
  const f = await fixture(t, {
    env,
    fetcher: async (_url, request) => {
      const payload = JSON.parse(request.body);
      calls.push({ payload, key: request.headers['Idempotency-Key'] });
      return payload.action === 'publish' ? new Response('{"status":"pending"}') : verified(payload.accountId);
    }
  });
  const official = (await state(f)).accounts[0];
  const personal = await addAccount(f, { bridgeAccountId: 'personal-external' });
  const job = await schedule(f, await draftFor(f, personal.id));
  assert.equal((await f.request('accounts/' + personal.id, { bridgeAccountId: 'another-external' }, 'PUT')).status, 409);
  await makeDue(f);
  await f.tick();
  assert.equal((await state(f)).jobs[0].status, 'uncertain');
  ok(await f.request('accounts/' + personal.id, { enabled: false }, 'PUT'));
  ok(await f.request(`accounts/${official.id}/default`, {}));
  env.REDPILOT_ACCOUNT_ID = 'changed-environment-id';
  assert.equal((await f.request('accounts/' + personal.id, { bridgeAccountId: 'another-external' }, 'PUT')).status, 409);
  assert.equal((await f.request(`accounts/${personal.id}/archive`, {})).status, 409);
  assert.equal((await f.request(`jobs/${job.id}/retry`, {})).status, 409);
  const checked = ok(await f.request(`jobs/${job.id}/verify`, {}));
  assert.equal(checked.status, 'published');
  assert.deepEqual(calls.map(c => c.payload.action), ['publish', 'verify']);
  assert.deepEqual(calls.map(c => c.payload.accountId), ['personal-external', 'personal-external']);
  assert.equal(calls[0].key, calls[1].key);
  assert.equal((await f.request('accounts/' + personal.id, { bridgeAccountId: 'after-publish' }, 'PUT')).status, 409);
});

test('a successful-looking receipt for another account stays uncertain', async t => {
  const f = await fixture(t, { env: bridgeEnv, fetcher: async () => verified('wrong-account') });
  const official = (await state(f)).accounts[0];
  const job = await schedule(f, await draftFor(f, official.id));
  await makeDue(f);
  await f.tick();
  const actual = (await state(f)).jobs.find(j => j.id === job.id);
  assert.equal(actual.status, 'uncertain');
  assert.equal(actual.account, 'official-external');
  assert.equal((await f.request(`jobs/${job.id}/retry`, {})).status, 409);
});

test('account archiving retains history and refuses unresolved jobs', async t => {
  const f = await fixture(t);
  const personal = await addAccount(f);
  const draft = await draftFor(f, personal.id);
  const job = await schedule(f, draft);
  assert.equal((await f.request(`accounts/${personal.id}/archive`, {})).status, 409);
  ok(await f.request(`jobs/${job.id}/cancel`, {}));
  ok(await f.request(`accounts/${personal.id}/archive`, {}));
  const s = await state(f);
  assert.equal(s.accounts.find(a => a.id === personal.id).archived, true);
  assert.equal(s.drafts.find(d => d.id === draft.id).accountId, personal.id);
  assert.equal(s.jobs.find(j => j.id === job.id).status, 'cancelled');
  assert.equal((await f.request('accounts/' + personal.id, { name: '不能改归档账号' }, 'PUT')).status, 409);
});

test('daily generation has independent timezone keys and skips paused or archived accounts', async t => {
  let calls = 0;
  const f = await fixture(t, {
    env: aiEnv,
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: `通信需求${calls}`, body: 'SimHelper 当前为开发内测。设备需 Wi-Fi，手机需互联网。',
        tags: ['产品开发'], series: '一起打磨', slides: [{ headline: '通信需求', body: '开发内测' }], gaps: [], adaptation: '问题式选题'
      }) } }] }));
    }
  });
  const official = (await state(f)).accounts[0];
  const chicago = await addAccount(f, { name: '芝加哥账号' });
  const paused = await addAccount(f, { name: '暂停账号', enabled: false });
  const archived = await addAccount(f, { name: '归档账号' });
  for (const account of [official, chicago, paused, archived]) {
    ok(await f.request(`accounts/${account.id}/settings`, {
      enabled: true, time: '10:00', timezone: account.id === chicago.id ? 'America/Chicago' : 'Asia/Shanghai', mode: 'review'
    }, 'PUT'));
  }
  ok(await f.request(`accounts/${archived.id}/archive`, {}));
  await f.tick(new Date('2026-10-25T02:01:00Z'));
  await f.tick(new Date('2026-10-25T02:02:00Z'));
  const s = await state(f);
  assert.equal(calls, 2);
  assert.equal(s.accounts.find(a => a.id === official.id).lastDailyKey, '2026-10-25');
  assert.equal(s.accounts.find(a => a.id === chicago.id).lastDailyKey, '2026-10-24');
  assert.equal(s.accounts.find(a => a.id === paused.id).lastDailyKey, null);
  assert.equal(s.accounts.find(a => a.id === archived.id).lastDailyKey, null);
  assert.equal(s.drafts.filter(d => d.method === 'ai' && d.accountId === official.id).length, 1);
  assert.equal(s.drafts.filter(d => d.method === 'ai' && d.accountId === chicago.id).length, 1);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.lastDailyKey, '2026-10-25');
});

test('default-setting compatibility and account configuration survive reopening without env rebinding', async t => {
  const f = await fixture(t, { env: bridgeEnv });
  const initial = await state(f);
  const official = initial.accounts[0];
  const personal = await addAccount(f, { bridgeAccountId: 'personal-external' });
  ok(await f.request(`accounts/${personal.id}/default`, {}));
  ok(await f.request('settings', { enabled: true, time: '11:00', timezone: 'America/Chicago', mode: 'review' }, 'PUT'));
  ok(await f.request('accounts/' + official.id, { bridgeAccountId: '' }, 'PUT'));
  await f.reopen();
  const s = await state(f);
  assert.equal(s.defaultAccountId, personal.id);
  assert.equal(s.settings.time, '11:00');
  assert.equal(s.accounts.find(a => a.id === personal.id).settings.timezone, 'America/Chicago');
  assert.equal(s.accounts.find(a => a.id === official.id).settings.time, '10:00');
  assert.equal(s.accounts.find(a => a.id === official.id).bridgeAccountId, '');
  assert.equal(s.capabilities.account, 'personal-external');
  const disk = JSON.parse(await readFile(path.join(f.directory, 'state.json')));
  assert.equal(disk.accounts.length, 2);
});

test('an unsubmitted blocked job can receive its first account mapping without changing targets later', async t => {
  const calls = [];
  const f = await fixture(t, {
    env: bridgeEnv,
    fetcher: async (_url, request) => {
      const payload = JSON.parse(request.body);
      calls.push(payload.accountId);
      return verified(payload.accountId);
    }
  });
  const personal = await addAccount(f);
  const job = await schedule(f, await draftFor(f, personal.id));
  await makeDue(f);
  await f.tick();
  assert.equal((await state(f)).jobs.find(j => j.id === job.id).status, 'blocked');
  ok(await f.request(`accounts/${personal.id}`, { bridgeAccountId: 'new-personal-target' }, 'PUT'));
  const swap = await f.request(`accounts/${personal.id}`, { bridgeAccountId: 'another-target' }, 'PUT');
  assert.equal(swap.status, 409);
  ok(await f.request(`jobs/${job.id}/retry`, {}));
  await f.tick();
  assert.deepEqual(calls, ['new-personal-target']);
  assert.equal((await state(f)).jobs.find(j => j.id === job.id).status, 'published');
});
