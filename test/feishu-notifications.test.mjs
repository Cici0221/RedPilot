import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFeishuNotifications } from '../app/feishu-notifications.mjs';

const SECRET = 'fixture-only-feishu-app-secret';
const TOKEN = 'fixture-only-feishu-tenant-token';
const SECOND_TOKEN = 'fixture-only-feishu-refreshed-token';
const config = { appId: 'cli_fixture_app', appSecret: SECRET, receiveId: 'ou_fixture_recipient', receiveIdType: 'open_id' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenResponse = token => json({ code: 0, tenant_access_token: token, expire: 7200 });
const sentResponse = () => json({ code: 0, data: { message_id: 'om_fixture_message' } });
const isAuth = address => new URL(address).pathname === '/open-apis/auth/v3/tenant_access_token/internal';
const noSecrets = value => assert.doesNotMatch(JSON.stringify(value), /fixture-only-feishu-(?:app-secret|tenant-token|refreshed-token)|PRIVATE_UPSTREAM_BODY/);

async function fixture(t, fetcher = async () => { assert.fail('unexpected network request'); }, env = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-feishu-notification-'));
  const service = await createFeishuNotifications(directory, env, fetcher);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service };
}

test('unconfigured notifications are read-only and cannot trigger an outbound request', async t => {
  let calls = 0;
  const { service } = await fixture(t, async () => { calls++; return sentResponse(); });
  assert.equal(service.publicStatus().configured, false);
  noSecrets(service.publicStatus());
  const result = await service.send('账号掉线提醒');
  assert.equal(result.sent, false); assert.equal(result.reason, 'unconfigured');
  assert.equal(calls, 0);
});

test('private local configuration survives reopening, uses owner-only permissions and never returns the secret', async t => {
  const { service, directory } = await fixture(t);
  const saved = await service.configure(config);
  assert.equal(saved.configured, true);
  assert.equal(saved.appId, config.appId);
  assert.equal(saved.receiveId, config.receiveId);
  noSecrets(saved); noSecrets(service.publicStatus());
  const filename = path.join(directory, 'feishu-notifications.json');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.ok((await readFile(filename, 'utf8')).includes(SECRET));
  const restored = await createFeishuNotifications(directory, {}, async () => assert.fail('reopening must not call Feishu'));
  t.after(() => restored.close());
  assert.equal(restored.publicStatus().configured, true);
  assert.equal(restored.publicStatus().receiveId, config.receiveId);
  noSecrets(restored.publicStatus());
});

test('saving empty or omitted secret keeps it, while changing applications requires a new secret', async t => {
  const requests = [];
  const { service } = await fixture(t, async (address, init) => {
    requests.push({ address, init });
    return isAuth(address) ? tokenResponse(TOKEN) : sentResponse();
  });
  await service.configure(config);
  await service.configure({ appSecret: '', receiveId: 'ou_new_recipient' });
  await service.configure({ receiveId: config.receiveId });
  await assert.rejects(service.configure({ appId: 'cli_different_app', appSecret: '' }));
  assert.equal(service.publicStatus().appId, config.appId);
  await service.send('重新登录提醒');
  const auth = requests.find(request => isAuth(request.address));
  assert.deepEqual(JSON.parse(auth.init.body), { app_id: config.appId, app_secret: SECRET });
});

test('only direct-message recipient types are accepted and invalid configuration never reaches the network', async t => {
  let calls = 0;
  const { service } = await fixture(t, async () => { calls++; return sentResponse(); });
  await service.configure(config);
  const invalid = [
    { receiveIdType: 'chat_id', receiveId: 'oc_group' },
    { receiveIdType: 'unknown' },
    { appId: 'bad\napp' },
    { appId: 'x'.repeat(4096) },
    { appSecret: 'bad\nsecret' },
    { appSecret: 'x'.repeat(4096) },
    { receiveId: '' },
    { receiveId: 'recipient\u0000secret' },
    { receiveId: 'x'.repeat(4096) },
    { receiveIdType: 'email', receiveId: 'invalid-address' }
  ];
  for (const input of invalid) await assert.rejects(service.configure(input));
  assert.equal(service.publicStatus().receiveId, config.receiveId);
  assert.equal(calls, 0);
});

test('direct messages use official fixed endpoints, serialized text and a stable idempotency UUID', async t => {
  const requests = [];
  const { service } = await fixture(t, async (address, init) => {
    const url = new URL(address); requests.push({ url, init });
    assert.equal(url.origin, 'https://open.feishu.cn');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return isAuth(address) ? tokenResponse(TOKEN) : sentResponse();
  });
  await service.configure(config);
  const result = await service.send('薯航：人类补丁账号已掉线。\n请重新登录。', { idempotencyKey: 'offline-fixture-2026-10-27' });
  assert.equal(result.sent, true); assert.equal(result.messageId, 'om_fixture_message');
  const message = requests.find(request => !isAuth(request.url));
  assert.equal(message.url.pathname, '/open-apis/im/v1/messages');
  assert.equal(message.url.searchParams.get('receive_id_type'), 'open_id');
  assert.equal(new Headers(message.init.headers).get('Authorization'), 'Bearer ' + TOKEN);
  const body = JSON.parse(message.init.body);
  assert.equal(body.receive_id, config.receiveId);
  assert.equal(body.msg_type, 'text');
  assert.equal(JSON.parse(body.content).text, '薯航：人类补丁账号已掉线。\n请重新登录。');
  assert.ok(typeof body.uuid === 'string' && body.uuid.length > 0 && body.uuid.length <= 50);
  noSecrets(service.publicStatus());
});

test('tenant tokens are cached across messages but are never written to the local configuration', async t => {
  let authCalls = 0, messages = 0;
  const { service, directory } = await fixture(t, async address => {
    if (isAuth(address)) { authCalls++; return tokenResponse(TOKEN); }
    messages++; return sentResponse();
  });
  await service.configure(config);
  await service.send('第一条提醒', { idempotencyKey: 'first' });
  await service.send('第二条提醒', { idempotencyKey: 'second' });
  assert.equal(authCalls, 1); assert.equal(messages, 2);
  assert.doesNotMatch(await readFile(path.join(directory, 'feishu-notifications.json'), 'utf8'), /fixture-only-feishu-tenant-token/);
  noSecrets(service.publicStatus());
});

test('changing the application discards its cached tenant token', async t => {
  const authBodies = [], authorizations = [];
  const { service } = await fixture(t, async (address, init) => {
    if (isAuth(address)) { authBodies.push(JSON.parse(init.body)); return tokenResponse(authBodies.length === 1 ? TOKEN : SECOND_TOKEN); }
    authorizations.push(new Headers(init.headers).get('Authorization')); return sentResponse();
  });
  await service.configure(config); await service.send('第一应用');
  await service.configure({ appId: 'cli_another_app', appSecret: 'another-fixture-secret' });
  await service.send('第二应用');
  assert.equal(authBodies.length, 2);
  assert.equal(authBodies[1].app_id, 'cli_another_app');
  assert.deepEqual(authorizations, ['Bearer ' + TOKEN, 'Bearer ' + SECOND_TOKEN]);
});

test('an explicitly expired token is refreshed once and preserves the message UUID on retry', async t => {
  let authCalls = 0; const bodies = [], authorizations = [];
  const { service } = await fixture(t, async (address, init) => {
    if (isAuth(address)) return tokenResponse(++authCalls === 1 ? TOKEN : SECOND_TOKEN);
    bodies.push(JSON.parse(init.body)); authorizations.push(new Headers(init.headers).get('Authorization'));
    return bodies.length === 1 ? json({ code: 99991663, msg: 'tenant token expired PRIVATE_UPSTREAM_BODY' }) : sentResponse();
  });
  await service.configure(config);
  await service.send('账号掉线', { idempotencyKey: 'same-outage' });
  assert.equal(authCalls, 2); assert.equal(bodies.length, 2);
  assert.equal(bodies[0].uuid, bodies[1].uuid);
  assert.deepEqual(authorizations, ['Bearer ' + TOKEN, 'Bearer ' + SECOND_TOKEN]);
  noSecrets(service.publicStatus());
});

test('a transport failure after message submission is not automatically sent a second time', async t => {
  let messages = 0;
  const { service } = await fixture(t, async address => {
    if (isAuth(address)) return tokenResponse(TOKEN);
    messages++; throw Error('PRIVATE_UPSTREAM_BODY ' + SECRET + ' ' + TOKEN);
  });
  await service.configure(config);
  const result = await service.send('掉线提醒', { idempotencyKey: 'transport-unknown' });
  assert.equal(result.sent, false); assert.ok(result.error); noSecrets(result);
  assert.equal(messages, 1); noSecrets(service.publicStatus());
});

test('HTTP and Feishu API failures expose safe diagnostics without echoed provider content', async t => {
  for (const mode of ['auth-http', 'auth-api', 'message-http', 'message-api']) {
    const { service } = await fixture(t, async address => {
      const auth = isAuth(address);
      if (auth && mode.startsWith('message')) return tokenResponse(TOKEN);
      if (!auth && mode === 'message-http' || auth && mode === 'auth-http') return json({ code: 9999, msg: 'PRIVATE_UPSTREAM_BODY ' + SECRET + ' ' + TOKEN }, 403);
      return json({ code: 9999, msg: 'PRIVATE_UPSTREAM_BODY ' + SECRET + ' ' + TOKEN });
    });
    await service.configure(config);
    const result = await service.send('提醒');
    assert.equal(result.sent, false); assert.ok(result.error); noSecrets(result);
    noSecrets(service.publicStatus());
  }
});

test('malformed or oversized responses cannot be mistaken for successful delivery', async t => {
  for (const makeResponse of [() => new Response('not-json'), () => json({ code: 0 }), () => new Response('x'.repeat(2 * 1024 * 1024))]) {
    const { service } = await fixture(t, async address => isAuth(address) ? tokenResponse(TOKEN) : makeResponse());
    await service.configure(config);
    assert.equal((await service.send('提醒')).sent, false);
    noSecrets(service.publicStatus());
  }
});

test('a failed atomic configuration write keeps the previously usable configuration', async t => {
  const { service, directory } = await fixture(t);
  await service.configure(config);
  const before = await readFile(path.join(directory, 'feishu-notifications.json'), 'utf8');
  await mkdir(path.join(directory, 'feishu-notifications.json.tmp'));
  await assert.rejects(service.configure({ receiveId: 'ou_not_persisted' }));
  assert.equal(service.publicStatus().receiveId, config.receiveId);
  assert.equal(await readFile(path.join(directory, 'feishu-notifications.json'), 'utf8'), before);
});

test('recipient types are inferred for personal IDs and email without an extra UI setting', async t => {
  const { service } = await fixture(t);
  for (const [receiveId, expectedType] of [['ou_fixture_person', 'open_id'], ['fixture_person', 'user_id'], ['person@example.test', 'email']]) {
    const result = await service.configure({ ...config, receiveIdType: '', receiveId });
    assert.equal(result.receiveIdType, expectedType);
    assert.equal(result.receiveId, receiveId);
  }
});

test('retries triggered by the caller keep the same stable delivery UUID and new outages receive another', async t => {
  const ids = [];
  const { service } = await fixture(t, async (address, init) => {
    if (isAuth(address)) return tokenResponse(TOKEN);
    ids.push(JSON.parse(init.body).uuid); return sentResponse();
  });
  await service.configure(config);
  await service.send('同一掉线', { idempotencyKey: 'outage-one' });
  await service.send('同一掉线', { idempotencyKey: 'outage-one' });
  await service.send('另一次掉线', { idempotencyKey: 'outage-two' });
  assert.equal(ids[0], ids[1]); assert.notEqual(ids[0], ids[2]);
});

test('close waits for an in-flight delivery and prevents accepting new work', async t => {
  let unblock, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const { service } = await fixture(t, async address => {
    if (isAuth(address)) return tokenResponse(TOKEN);
    started(); await gate; return sentResponse();
  });
  await service.configure(config);
  const sending = service.send('正在发送的提醒'); await startedPromise;
  let finished = false;
  const closing = service.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  await assert.rejects(service.configure({ receiveId: 'ou_new_recipient' }));
  unblock(); assert.equal((await sending).sent, true); await closing;
  assert.equal(finished, true);
});
