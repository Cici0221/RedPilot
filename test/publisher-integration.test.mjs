import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PROFILE_ID = '111111111111111111111111';
const OTHER_ID = '222222222222222222222222';
const PROFILE = 'https://www.xiaohongshu.com/user/profile/' + PROFILE_ID;
const OTHER_PROFILE = 'https://www.xiaohongshu.com/user/profile/' + OTHER_ID;
const NOTE = 'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
const EXTENDED_NOTE = PROFILE + '/6a95c0ff000000002902de43?xsec_token=test-card-token';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const published = accountId => ({ status: 'published', verified: true, accountId, noteUrl: NOTE });
async function fixture(t, { env = {}, profileUrl = PROFILE, check, publish, verify, beforeClose } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-native-publisher-'));
  const credentials = { email: 'native-publisher-fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  const calls = { check: [], publish: [], verify: [], close: 0 };
  const xhsPublisher = {
    async checkConnection(id) { calls.check.push(id); return check ? check(id) : { status: 'ready', accountId: id, image: true }; },
    async publish(request) { calls.publish.push(structuredClone(request)); return publish ? publish(request) : published(request.accountId); },
    async verify(request) { calls.verify.push(structuredClone(request)); return verify ? verify(request) : published(request.accountId); },
    async close() { calls.close++; }
  };
  const app = await createApp({ root, directory, env, xhsPublisher,
    fetcher: async () => { throw Error('native tests must not use a bridge or external provider'); },
    feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }),
    trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [] }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  t.after(async () => { beforeClose?.(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const f = { directory, calls, get store() { return app.store; }, tick: date => app.tick(date),
    async request(endpoint, data, method = 'POST', { authenticated = true, headers = {} } = {}) {
      const response = await fetch(base + '/api/' + endpoint, { method, signal: AbortSignal.timeout(5000),
        headers: { Origin: base, ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, data: await response.json() };
    }
  };
  f.accountId = (await state(f)).defaultAccountId;
  ok(await f.request(`accounts/${f.accountId}`, { profileUrl }, 'PUT'));
  f.asset = ok(await f.request('product-assets/upload', { name: 'test-product.png', kind: 'image', data: PNG }));
  return f;
}
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const state = async f => ok(await f.request('state', undefined, 'GET'));
const connect = async f => ok(await f.request(`accounts/${f.accountId}/connect-publisher`, {}));
async function waitUntil(fn, message) {
  for (let n = 0; n < 250; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
async function draft(f, { accountId = f.accountId, contentMode = 'image' } = {}) {
  return ok(await f.request('drafts', { accountId, method: 'template', contentMode, productAssetIds: contentMode === 'image' ? [f.asset.id] : [] }));
}
async function schedule(f, item, { owner = true } = {}) {
  if (owner) { const approved = ok(await f.request(`drafts/${item.id}/approve`, {})); assert.equal(approved.approvalKind, 'owner'); }
  else await f.store.mutate(s => { const record = s.drafts.find(d => d.id === item.id); record.approved = true; delete record.approvalKind; });
  return ok(await f.request(`drafts/${item.id}/schedule`, { scheduledAt: new Date(Date.now() + 3600000).toISOString() }));
}
async function due(f, job) {
  await f.store.mutate(s => { s.jobs.find(item => item.id === job.id).scheduledAt = new Date(Date.now() - 60000).toISOString(); });
  await f.tick(new Date());
}
async function terminal(f, job) {
  return waitUntil(async () => (await state(f)).jobs.find(item => item.id === job.id && !['scheduled', 'publishing'].includes(item.status)), 'native publishing task did not finish');
}

// Publishers and every source reader are injected; no real browser or platform request is made.
test('checking an account binds only the matching profile and is read-only on the publishing platform', async t => {
  const f = await fixture(t), result = await connect(f), current = await state(f), account = current.accounts.find(item => item.id === f.accountId);
  assert.equal(result.status, 'ready'); assert.equal(result.accountId, PROFILE_ID); assert.equal(result.publishVerified, false);
  assert.equal(account.bridgeAccountId, PROFILE_ID); assert.equal(account.publisherDriver, 'chrome');
  assert.deepEqual(f.calls.check, [PROFILE_ID]); assert.equal(f.calls.publish.length, 0); assert.equal(f.calls.verify.length, 0);
  assert.equal(current.capabilities.accounts[f.accountId].publisher, true);
});

test('a mismatched ready response and unsupported login UI never bind an external account', async t => {
  let status = 'ready';
  const f = await fixture(t, { check: async () => ({ status, accountId: OTHER_ID, image: false, error: 'test-only unsupported UI' }) });
  const mismatch = await connect(f); assert.equal(mismatch.status, 'mismatch');
  let account = (await state(f)).accounts.find(item => item.id === f.accountId);
  assert.equal(account.bridgeAccountId, ''); assert.notEqual(account.publisherDriver, 'chrome');
  status = 'unsupported'; assert.equal((await connect(f)).status, 'unsupported');
  account = (await state(f)).accounts.find(item => item.id === f.accountId);
  assert.equal(account.bridgeAccountId, ''); assert.notEqual(account.publisherDriver, 'chrome'); assert.equal(f.calls.publish.length, 0);
});

test('native account checking requires a valid profile, authentication and a same-origin request', async t => {
  const f = await fixture(t, { profileUrl: '' });
  assert.equal((await f.request(`accounts/${f.accountId}/connect-publisher`, {})).status, 400);
  ok(await f.request(`accounts/${f.accountId}`, { profileUrl: PROFILE }, 'PUT'));
  assert.equal((await f.request(`accounts/${f.accountId}/connect-publisher`, {}, 'POST', { authenticated: false })).status, 401);
  assert.equal((await f.request(`accounts/${f.accountId}/connect-publisher`, {}, 'POST', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(f.calls.check.length, 0); assert.equal(f.calls.publish.length, 0);
});

test('profile changes during a login check reject its old result and the check does not hold the state lock', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), check: async id => { await gate; return { status: 'ready', accountId: id, image: true }; } });
  const pending = f.request(`accounts/${f.accountId}/connect-publisher`, {});
  await waitUntil(async () => f.calls.check.length === 1, 'native login check did not start');
  ok(await f.request(`accounts/${f.accountId}`, { profileUrl: OTHER_PROFILE }, 'PUT'));
  release(); assert.equal((await pending).status, 409);
  const account = (await state(f)).accounts.find(item => item.id === f.accountId);
  assert.equal(account.profileUrl, OTHER_PROFILE); assert.equal(account.bridgeAccountId, ''); assert.notEqual(account.publisherDriver, 'chrome');
});

test('duplicate account mappings and unfinished bridge work prevent switching another record to the native driver', async t => {
  const f = await fixture(t); await connect(f);
  const other = ok(await f.request('accounts', { name: '重复目标账号', profileUrl: PROFILE, type: 'personal' }));
  assert.equal((await f.request(`accounts/${other.id}/connect-publisher`, {})).status, 409);
  assert.equal((await state(f)).accounts.find(item => item.id === other.id).bridgeAccountId, '');
  const bridge = await fixture(t, { env: { REDPILOT_PUBLISH_URL: 'https://publisher.example/publish', REDPILOT_PUBLISH_TOKEN: 'test-only-token', REDPILOT_ACCOUNT_ID: 'legacy-external' } });
  const pending = await schedule(bridge, await draft(bridge));
  assert.equal((await bridge.request(`accounts/${bridge.accountId}/connect-publisher`, {})).status, 409);
  const current = await state(bridge), account = current.accounts.find(item => item.id === bridge.accountId);
  assert.equal(account.bridgeAccountId, 'legacy-external'); assert.notEqual(account.publisherDriver, 'chrome');
  assert.equal(current.jobs.find(job => job.id === pending.id).status, 'scheduled'); assert.equal(bridge.calls.publish.length, 0);
});

test('changed profile details or a mismatched or unsupported connection block all future native dispatch until rechecked', async t => {
  for (const reason of ['profile_changed', 'mismatch', 'unsupported']) {
    let status = 'ready';
    const f = await fixture(t, { check: async id => ({ status, accountId: status === 'mismatch' ? OTHER_ID : id, image: status === 'ready' }) });
    await connect(f);
    if (reason === 'profile_changed') ok(await f.request(`accounts/${f.accountId}`, { profileUrl: OTHER_PROFILE }, 'PUT'));
    else { status = reason; assert.equal((await connect(f)).status, reason); }
    const before = await state(f), account = before.accounts.find(item => item.id === f.accountId);
    assert.equal(account.publisherDriver, 'chrome'); assert.equal(account.bridgeAccountId, PROFILE_ID);
    assert.equal(account.publisherConnection.status, reason === 'profile_changed' ? 'unconfigured' : reason);
    assert.equal(before.capabilities.accounts[f.accountId].publisher, false);
    const job = await schedule(f, await draft(f)); await due(f, job);
    const blocked = await terminal(f, job); assert.equal(blocked.status, 'blocked', reason); assert.equal(blocked.attempts, 0);
    assert.match(blocked.error, /连接已失效|重新检查登录/); assert.equal(f.calls.publish.length, 0);
    await f.tick(new Date()); assert.equal(f.calls.publish.length, 0);
  }
});

test('the first native note requires an explicit owner review and only a verified first publish unlocks later automatic drafts', async t => {
  const f = await fixture(t); await connect(f);
  const firstDraft = await draft(f), firstJob = await schedule(f, firstDraft, { owner: false }); await due(f, firstJob);
  const blocked = await terminal(f, firstJob); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.attempts, 0);
  assert.match(blocked.error, /首次发布|核对草稿/); assert.equal(f.calls.publish.length, 0);
  ok(await f.request(`jobs/${firstJob.id}/cancel`, {}));
  const ownerJob = await schedule(f, firstDraft); await due(f, ownerJob);
  const completed = await terminal(f, ownerJob); assert.equal(completed.status, 'published'); assert.equal(completed.account, PROFILE_ID); assert.equal(completed.publisherDriver, 'chrome');
  let current = await state(f); assert.equal(current.accounts.find(account => account.id === f.accountId).publisherConnection.publishVerified, true);
  const later = await schedule(f, await draft(f), { owner: false }); await due(f, later);
  assert.equal((await terminal(f, later)).status, 'published'); assert.equal(f.calls.publish.length, 2);
  current = await state(f); assert.equal(current.drafts.find(item => item.id === firstDraft.id).status, 'published');
});

test('native image publishing passes actual files and waits outside the state lock without duplicate dispatch', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeClose: () => release(), publish: async request => { await gate; return { ...published(request.accountId), noteUrl: EXTENDED_NOTE }; } });
  await connect(f); const item = await draft(f), job = await schedule(f, item); await due(f, job);
  await waitUntil(async () => f.calls.publish.length === 1, 'native publishing did not start');
  const payload = f.calls.publish[0]; assert.equal(payload.accountId, PROFILE_ID); assert.equal(payload.idempotencyKey, job.idempotencyKey); assert.equal(payload.retry, false);
  assert.equal(payload.post.contentMode, 'image'); assert.equal(payload.post.title, item.title); assert.equal(payload.post.body, item.body);
  assert.equal(payload.post.images.length, 1); assert.equal(payload.post.images[0].id, f.asset.id); assert.equal(payload.post.images[0].mime, 'image/png');
  assert.ok(path.isAbsolute(payload.post.images[0].path)); assert.deepEqual(await readFile(payload.post.images[0].path), Buffer.from(PNG, 'base64'));
  ok(await f.request('accounts', { name: '浏览器发布等待期间的账号', type: 'personal' }));
  await f.tick(new Date()); assert.equal(f.calls.publish.length, 1);
  release(); const completed = await terminal(f, job); assert.equal(completed.status, 'published'); assert.equal(completed.noteUrl, EXTENDED_NOTE); assert.equal(f.calls.publish.length, 1);
});

test('a pre-submit native block records zero attempts and only an explicit retry resubmits with the same target and idempotency key', async t => {
  let attempts = 0;
  const f = await fixture(t, { publish: async request => ++attempts === 1 ? { status: 'blocked', submitted: false, error: '请先检查编辑界面' } : published(request.accountId) });
  await connect(f); const job = await schedule(f, await draft(f)); await due(f, job);
  const blocked = await terminal(f, job); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.attempts, 0);
  await f.tick(new Date()); assert.equal(f.calls.publish.length, 1);
  ok(await f.request(`jobs/${job.id}/retry`, {})); await f.tick(new Date());
  const completed = await terminal(f, job); assert.equal(completed.status, 'published'); assert.equal(completed.attempts, 1);
  assert.equal(f.calls.publish.length, 2); assert.equal(f.calls.publish[0].retry, false); assert.equal(f.calls.publish[1].retry, true);
  assert.equal(f.calls.publish[0].idempotencyKey, f.calls.publish[1].idempotencyKey); assert.equal(f.calls.publish[1].accountId, PROFILE_ID);
});

test('uncertain, thrown, mismatched or invalid native results never complete or automatically resubmit a note', async t => {
  let outcome;
  const f = await fixture(t, { publish: async request => { if (outcome.throw) throw Error('test-only interrupted browser'); return { ...published(request.accountId), ...outcome }; } });
  await connect(f);
  const cases = [{ status: 'unknown' }, { throw: true }, { accountId: OTHER_ID }, { verified: false },
    { noteUrl: 'https://evil.example/explore/6a95c0ff000000002902de43' }, { noteUrl: NOTE.replace('https:', 'http:') },
    { noteUrl: 'https://www.xiaohongshu.com/explore/not-a-note-id' }, { noteUrl: NOTE.replace('https://', 'https://user@') }, { noteUrl: NOTE.replace('.com/', '.com:8443/') },
    { noteUrl: EXTENDED_NOTE.replace(PROFILE_ID, OTHER_ID) }];
  for (outcome of cases) {
    const job = await schedule(f, await draft(f)); await due(f, job);
    const uncertain = await terminal(f, job); assert.equal(uncertain.status, 'uncertain', JSON.stringify(outcome)); assert.equal(uncertain.attempts, 1);
    assert.equal((await f.request(`jobs/${job.id}/retry`, {})).status, 409);
    const before = f.calls.publish.length; await f.tick(new Date()); assert.equal(f.calls.publish.length, before);
  }
  assert.equal(f.calls.publish.length, cases.length); assert.equal(new Set(f.calls.publish.map(request => request.idempotencyKey)).size, cases.length);
  assert.equal((await state(f)).accounts.find(account => account.id === f.accountId).publisherConnection.publishVerified, false);
});

test('native verification uses the frozen driver and target without reopening images or re-publishing', async t => {
  const f = await fixture(t, { env: { REDPILOT_PUBLISH_URL: 'https://publisher.example/publish', REDPILOT_PUBLISH_TOKEN: 'test-only-token' }, publish: async () => ({ status: 'unknown' }) });
  await connect(f); const job = await schedule(f, await draft(f)); await due(f, job);
  const initial = await terminal(f, job); assert.equal(initial.status, 'uncertain'); assert.equal(initial.account, PROFILE_ID); assert.equal(initial.publisherDriver, 'chrome');
  const filename = f.calls.publish[0].post.images[0].path; await rm(filename);
  ok(await f.request(`accounts/${f.accountId}`, { profileUrl: OTHER_PROFILE, enabled: false }, 'PUT'));
  assert.equal((await state(f)).accounts.find(account => account.id === f.accountId).publisherConnection.status, 'unconfigured');
  await f.store.mutate(s => { s.accounts.find(account => account.id === f.accountId).publisherDriver = 'bridge'; });
  ok(await f.request(`jobs/${job.id}/verify`, {}));
  await waitUntil(async () => f.calls.verify.length === 1, 'native verification did not start');
  const completed = await waitUntil(async () => (await state(f)).jobs.find(item => item.id === job.id && item.status === 'published'), 'native verification did not finish');
  assert.equal(f.calls.publish.length, 1); assert.equal(f.calls.verify.length, 1);
  assert.deepEqual(f.calls.verify[0], { idempotencyKey: initial.idempotencyKey, accountId: PROFILE_ID, sessionId: f.accountId, retry: false });
  assert.equal(completed.publisherDriver, 'chrome'); assert.equal(completed.account, PROFILE_ID);
});

test('verification permits a retry only when the driver explicitly proves the uncertain attempt was never submitted', async t => {
  let proof = false, attempts = 0;
  const f = await fixture(t, { publish: async request => ++attempts === 1 ? { status: 'unknown' } : published(request.accountId),
    verify: async () => ({ status: 'blocked', submitted: false, ...(proof ? { verifiedNoSubmission: true } : {}), error: '提交状态核对' }) });
  await connect(f); const job = await schedule(f, await draft(f)); await due(f, job); assert.equal((await terminal(f, job)).status, 'uncertain');
  ok(await f.request(`jobs/${job.id}/verify`, {}));
  await waitUntil(async () => f.calls.verify.length === 1 && (await state(f)).jobs.find(item => item.id === job.id)?.verificationPending === false, 'first verification did not finish');
  const unknown = (await state(f)).jobs.find(item => item.id === job.id); assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.attempts, 1);
  assert.equal((await f.request(`jobs/${job.id}/retry`, {})).status, 409);
  proof = true; ok(await f.request(`jobs/${job.id}/verify`, {}));
  const blocked = await waitUntil(async () => (await state(f)).jobs.find(item => item.id === job.id && item.status === 'blocked'), 'proven unsubmitted attempt was not unblocked');
  assert.equal(blocked.attempts, 0); await f.tick(new Date()); assert.equal(f.calls.publish.length, 1);
  ok(await f.request(`jobs/${job.id}/retry`, {})); await f.tick(new Date());
  assert.equal((await terminal(f, job)).status, 'published'); assert.equal(f.calls.publish.length, 2);
  assert.equal(f.calls.publish[1].retry, true); assert.equal(f.calls.publish[1].idempotencyKey, job.idempotencyKey);
});

test('native text publishing stays blocked until a supported text driver exists', async t => {
  const f = await fixture(t, { env: { REDPILOT_PUBLISH_TEXT_ENABLED: 'true' } }); await connect(f);
  const job = await schedule(f, await draft(f, { contentMode: 'text' })); await due(f, job);
  const blocked = await terminal(f, job); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.attempts, 0);
  assert.match(blocked.error, /文字稿/); assert.equal(f.calls.publish.length, 0);
});
