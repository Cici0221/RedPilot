import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createXhsPublisher } from '../app/xhs-publisher.mjs';

const A = '0123456789abcdef01234567', B = '1123456789abcdef01234567';
const OLD = '2123456789abcdef01234567', NEW = '3123456789abcdef01234567';
const profile = id => 'https://www.xiaohongshu.com/user/profile/' + id;
const note = id => `${profile(A)}/${id}?xsec_token=fixture-${id}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const json = value => new Response(JSON.stringify(value));
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-publisher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'product-assets'));
  const file = path.join(directory, 'product-assets', 'source.png'); await writeFile(file, PNG);
  const config = { ...options }, calls = [], live = new Map(); let submitted = false, filledTitle = '', filledBody = '', uploads = [], tabCounter = 0;
  const fetcher = async (address, init = {}) => {
    const url = new URL(address); calls.push({ url, init });
    assert.equal(url.origin, 'http://127.0.0.1:3456'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    const route = url.pathname, id = url.searchParams.get('target');
    if (route === '/new') { const targetId = 'OWN-' + (++tabCounter); live.set(targetId, 'about:blank'); return json({ targetId }); }
    assert.ok(live.has(id));
    if (route === '/close') { live.delete(id); return json({ success: true }); }
    if (route === '/navigate') {
      let current = url.searchParams.get('url');
      if (config.login && current.includes('/new/home')) current = 'https://creator.xiaohongshu.com/login';
      if (config.canonicalNotes && /\/user\/profile\/[a-f\d]{24}\/[a-f\d]{24}/.test(current)) {
        const original = new URL(current); current = 'https://www.xiaohongshu.com/explore/' + original.pathname.split('/').at(-1) + original.search;
      }
      live.set(id, current);
      if (current.includes('target=image')) { uploads = []; filledTitle = ''; filledBody = ''; }
      return json({ success: true });
    }
    const current = live.get(id);
    if (route === '/info') return json({ url: config.foreignInfo || current, ready: 'complete' });
    if (route === '/setFiles') {
      const body = JSON.parse(init.body); assert.equal(body.files.length, 1); assert.ok(path.isAbsolute(body.files[0]));
      uploads.push(body.files[0]); return json({ success: true });
    }
    if (route === '/eval') {
      const marker = init.body.lastIndexOf('})('); assert.ok(marker > 0);
      const [op, args] = JSON.parse('[' + init.body.slice(marker + 3, -1) + ']');
      let value;
      if (op === 'home') value = { status: 'ready', ...(args.performance ? {dashboardText:config.dashboardText || '笔记数据总览\n统计周期 10-21 至 10-27\n曝光数 1,621\n环比 +12369%\n观看数 313\n环比 +6160%\n最新笔记'} : {}), handle: config.switchAfterUpload && uploads.length ? 'ChangedAccount' : config.creatorHandle || 'CompanyFixture' };
      if (op === 'profile') value = { status: 'ready', handle: 'CompanyFixture', notes: config.emptyProfile ? [] : [
        { url: note(OLD), title: '已有笔记' },
        ...(submitted || config.appeared ? [{ url: note(NEW), title: '产品使用方法' }] : [])
      ] };
      if (op === 'note') {
        const fresh = current.includes(NEW);
        value = { status: 'ready', title: fresh ? '产品使用方法' : '已有笔记', body: fresh ? (config.wrongBody ? '不是同一正文' : '步骤一\n步骤二\n\n#产品') : '旧正文',
          authorUrl: profile(config.wrongAuthor ? B : A), imageCount: fresh ? (config.wrongCount ? 2 : config.imageCount || 1) : 0, hasVideo: !fresh };
      }
      if (op === 'text-inspect') value = {status:'ready',entryCount:config.textAvailable ? 1 : 0, editorCount:config.textStage === 'editor' ? 1 : 0, cardText:config.cardText || '',templateReady:config.textStage === 'templates',cardKeys:[config.selectedCard || 'card:default']};
      if (op === 'text-open') {config.textStage='editor'; value={status:config.textAvailable ? 'opened' : 'ambiguous'};}
      if (op === 'text-fill') {config.cardText=args.text;value={status:'filled'};}
      if (op === 'text-generate') {config.textStage='templates';value={status:'generating'};}
      if (op === 'text-template') {config.selectedCard='card:selected';value={status:'selected',selectedKey:config.selectedCard};}
      if (op === 'text-next') {config.textStage='publish';uploads=['platform-text-card'];value={status:'next'};}
      if (op === 'inspect') value = { status: 'ready', fileInputCount: config.ambiguousFile ? 2 : 1, selector: 'input.upload-input[type="file"]',
        titleCount: uploads.length ? config.ambiguousForm ? 2 : 1 : 0, editorCount: uploads.length ? 1 : 0, buttonCount: uploads.length ? 1 : 0,
        files: uploads.length ? [{ name: path.basename(uploads.at(-1)), size: PNG.length }] : [], imageCount: uploads.length,
        previewKeys: uploads.map((file, index) => config.reorder && index === 0 && uploads.length > 1 ? 'different' : 'blob:preview-' + index),
        imagesLoaded: true, busy: false, title: config.revertTitle ? '被平台修改' : filledTitle, body: filledBody, enabled: true };
      if (op === 'fill') { filledTitle = args.title; filledBody = args.body; value = { status: 'filled' }; }
      if (op === 'submit') {
        assert.equal(args.title, filledTitle); assert.equal(args.body, filledBody); assert.equal(args.imageCount, uploads.length);
        if (config.beforeSubmit) await config.beforeSubmit(directory);
        if (config.throwOnSubmit) throw new Error('private provider detail must not escape');
        submitted = true; value = { status: 'clicked' };
      }
      assert.ok(value, `unknown DOM operation ${op}`);
      return json({ value: { ...value, resolvedUrl: config.foreignEval || current } });
    }
    assert.fail('unexpected route: ' + route);
  };
  const post = { contentMode: 'image', title: '产品使用方法', body: '步骤一\n步骤二', tags: ['产品'], images: [{ path: file }] };
  const input = { accountId: A, idempotencyKey: 'job-fixture', post };
  const create = () => createXhsPublisher({ directory, env: {}, fetcher });
  const count = route => calls.filter(call => call.url.pathname === route).length;
  const opCount = op => calls.filter(call => call.url.pathname === '/eval' && call.init.body.slice(call.init.body.lastIndexOf('})(') + 3).startsWith(JSON.stringify(op) + ',')).length;
  return { directory, file, config, calls, live, post, input, fetcher, create, count, opCount, state: async () => JSON.parse(await readFile(path.join(directory, 'xhs-publisher.json'), 'utf8')) };
}

test('connection proves unique creator handle, profile handle and exact public-note author identity', async t => {
  const f = await fixture(t); const result = await f.create().checkConnection(A);
  assert.equal(result.status, 'ready'); assert.equal(result.accountId, A); assert.equal(result.handle, 'CompanyFixture');
  assert.equal(result.image, true); assert.equal(result.text, false); assert.equal(result.evidence.authorProfileId, A);
  assert.equal(f.count('/setFiles'), 0); assert.equal(f.opCount('fill'), 0); assert.equal(f.opCount('submit'), 0); assert.equal(f.live.size, 0);
});

test('connection rejects wrong handles and authors without any upload', async t => {
  for (const options of [{ creatorHandle: 'WrongAccount' }, { wrongAuthor: true }]) {
    const f = await fixture(t, options); const result = await f.create().checkConnection(A);
    assert.equal(result.status, 'mismatch'); assert.equal(result.image, false); assert.equal(f.count('/setFiles'), 0); assert.equal(f.live.size, 0);
  }
});

test('login redirect is classified precisely and every own tab closes', async t => {
  const f = await fixture(t, { login: true }); const result = await f.create().checkConnection(A);
  assert.equal(result.status, 'needs_login'); assert.equal(f.count('/eval'), 0); assert.equal(f.live.size, 0);
});

test('a new account can bind with matching unique official handles before its first post', async t => {
  const f = await fixture(t, { emptyProfile: true });
  const result=await f.create().checkConnection(A);assert.equal(result.status,'ready');assert.equal(result.evidence.method,'creator-handle/profile-handle');assert.equal(result.evidence.profileId,A);assert.equal(f.live.size,0);
});

test('foreign proxy and foreign navigations fail before reading or writing the page', async t => {
  const f = await fixture(t, { foreignInfo: 'https://evil.example/new/home' });
  assert.equal((await f.create().checkConnection(A)).status, 'unavailable'); assert.equal(f.count('/eval'), 0); assert.equal(f.live.size, 0);
  let calls = 0; const publisher = createXhsPublisher({ directory: f.directory, env: { REDPILOT_PUBLISHER_PROXY_URL: 'http://remote.example:3456' }, fetcher: async () => { calls++; } });
  assert.equal((await publisher.checkConnection(A)).status, 'unavailable'); assert.equal(calls, 0);
});

test('DOM expression guards a raced foreign location before accessing document', async t => {
  const f = await fixture(t); await f.create().checkConnection(A);
  const source = f.calls.find(call => call.url.pathname === '/eval').init.body;
  let reads = 0; const context = { URL, location: { href: 'https://www.xiaohongshu.com.evil.example/new/home' } };
  Object.defineProperty(context, 'document', { get() { reads++; throw new Error('document should not be touched'); } });
  const result = runInNewContext(source, context); assert.equal(result.status, 'unavailable'); assert.equal(reads, 0);
});

test('invalid drafts never open Chrome', async t => {
  const f = await fixture(t);
  for (const post of [{ ...f.post, contentMode: 'unknown' }, { ...f.post, title: '超'.repeat(21) }, { ...f.post, body: '长'.repeat(1001) }, { ...f.post, images: [] }]) {
    const result = await f.create().publish({ ...f.input, post }); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false);
  }
  assert.equal(f.count('/new'), 0);
});

test('only real managed raster files can be uploaded, symlinks outside are rejected', async t => {
  const f = await fixture(t); const external = await mkdtemp(path.join(os.tmpdir(), 'redpilot-outside-')); t.after(() => rm(external, { recursive: true, force: true }));
  const outside = path.join(external, 'source.png'); await writeFile(outside, PNG);
  const alias = path.join(f.directory, 'alias.png'); await symlink(outside, alias);
  for (const image of [outside, alias]) {
    const result = await f.create().publish({ ...f.input, post: { ...f.post, images: [{ path: image }] } }); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false);
  }
  await writeFile(f.file, 'not a real PNG even if the filename says so');
  assert.equal((await f.create().publish(f.input)).status, 'blocked'); assert.equal(f.count('/new'), 0);
});

test('ambiguous file entry blocks before upload, explicit retry can safely prepare again', async t => {
  const f = await fixture(t, { ambiguousFile: true }); const publisher = f.create();
  const result = await publisher.publish(f.input); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false); assert.equal(f.count('/setFiles'), 0);
  const before = f.count('/new'); await publisher.publish(f.input); assert.equal(f.count('/new'), before);
  f.config.ambiguousFile = false; const retried = await publisher.publish({ ...f.input, retry: true });
  assert.equal(retried.status, 'published'); assert.equal(f.opCount('submit'), 1); assert.equal(f.live.size, 0);
});

test('ambiguous post-upload title/body/publish controls fail closed without clicking', async t => {
  const f = await fixture(t, { ambiguousForm: true }); const result = await f.create().publish(f.input);
  assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false); assert.equal(f.count('/setFiles'), 1); assert.equal(f.opCount('fill'), 0); assert.equal(f.opCount('submit'), 0); assert.equal(f.live.size, 0);
});

test('sequential uploads require the previous visible preview prefix to remain in order', async t => {
  const f = await fixture(t, { reorder: true }); const second = path.join(f.directory, 'second.png'); await writeFile(second, PNG);
  const result = await f.create().publish({ ...f.input, post: { ...f.post, images: [{ path: f.file }, { path: second }] } });
  assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false); assert.equal(f.count('/setFiles'), 2); assert.equal(f.opCount('submit'), 0);
});

test('durable unknown intent precedes the only final click, exact public content verifies success', async t => {
  let sawIntent = false;
  const f = await fixture(t, { beforeSubmit: async directory => {
    const state = JSON.parse(await readFile(path.join(directory, 'xhs-publisher.json'), 'utf8'));
    const job = Object.values(state.jobs)[0]; assert.equal(job.status, 'unknown'); assert.ok(job.submitIntentAt); sawIntent = true;
  } });
  const result = await f.create().publish(f.input);
  assert.equal(result.status, 'published'); assert.equal(result.verified, true); assert.equal(result.accountId, A); assert.equal(result.noteUrl, note(NEW)); assert.equal(result.submitted, true); assert.ok(sawIntent);
  const mode = (await stat(path.join(f.directory, 'xhs-publisher.json'))).mode & 0o777; assert.equal(mode, 0o600); assert.equal(f.live.size, 0);
  const oldCount = f.count('/new'); assert.deepEqual(await f.create().publish(f.input), result); assert.equal(f.count('/new'), oldCount); assert.equal(f.opCount('submit'), 1);
});

test('same key changed payload or file bytes is rejected before any second upload', async t => {
  const f = await fixture(t, { ambiguousForm: true }); const publisher = f.create(); await publisher.publish(f.input);
  const before = f.count('/setFiles');
  const changed = await publisher.publish({ ...f.input, retry: true, post: { ...f.post, body: '变更正文' } }); assert.equal(changed.status, 'blocked');
  await writeFile(f.file, Buffer.concat([PNG, Buffer.from('changed')]));
  assert.equal((await publisher.publish({ ...f.input, retry: true })).status, 'blocked'); assert.equal(f.count('/setFiles'), before);
});

test('timeout after submit stays unknown across restart; retry and verify are read only', async t => {
  const f = await fixture(t, { throwOnSubmit: true }); const first = await f.create().publish(f.input);
  assert.equal(first.status, 'unknown'); assert.equal(first.submitted, true); assert.equal(first.verified, false);
  assert.ok(!first.error.includes('private provider'));
  const beforeUploads = f.count('/setFiles'), beforeFills = f.opCount('fill');
  const retry = await f.create().publish({ ...f.input, retry: true }); assert.equal(retry.status, 'unknown');
  const verification = await f.create().verify(f.input); assert.equal(verification.status, 'unknown');
  assert.equal(f.opCount('submit'), 1); assert.equal(f.count('/setFiles'), beforeUploads); assert.equal(f.opCount('fill'), beforeFills); assert.equal(f.live.size, 0);
  f.config.appeared = true; const verified = await f.create().verify(f.input); assert.equal(verified.status, 'published'); assert.equal(verified.verified, true); assert.equal(f.opCount('submit'), 1);
});

test('public-note body or image-count mismatch cannot be published even after a clicked button', async t => {
  for (const config of [{ wrongBody: true }, { wrongCount: true }]) {
    const f = await fixture(t, config); const result = await f.create().publish(f.input);
    assert.equal(result.status, 'unknown'); assert.equal(result.verified, false); assert.equal(result.submitted, true); assert.equal(f.opCount('submit'), 1);
  }
});

test('corrupt persisted tasks never reset into a fresh publish; no raw errors leak', async t => {
  const f = await fixture(t); await writeFile(path.join(f.directory, 'xhs-publisher.json'), '{ private damaged');
  const result = await f.create().publish(f.input); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false); assert.equal(f.count('/new'), 0);
  assert.ok(!JSON.stringify(result).includes('private damaged'));
});


test('connection cannot advertise image publishing when the upload entry is ambiguous', async t => {
  const f = await fixture(t, { ambiguousFile: true }); const result = await f.create().checkConnection(A);
  assert.equal(result.status, 'unsupported'); assert.equal(result.image, false); assert.equal(result.text, false); assert.equal(f.count('/setFiles'), 0); assert.equal(f.live.size, 0);
});

test('Chrome account switching during uploads is blocked by a second independent identity tab', async t => {
  const f = await fixture(t, { switchAfterUpload: true }); const result = await f.create().publish(f.input);
  assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false); assert.equal(result.verifiedNoSubmission, true);
  assert.equal(f.count('/new'), 2); assert.equal(f.count('/setFiles'), 1); assert.equal(f.opCount('fill'), 1); assert.equal(f.opCount('submit'), 0); assert.equal(f.live.size, 0);
});

test('missing task records remain unknown while known prepared records allow explicit safe retry', async t => {
  const f = await fixture(t, { ambiguousForm: true });
  const missing = await f.create().verify(f.input); assert.equal(missing.status, 'unknown'); assert.equal(missing.submitted, true); assert.equal(missing.verifiedNoSubmission, false);
  await f.create().publish(f.input); const state = await f.state(); const job = Object.values(state.jobs)[0]; job.status = 'prepared'; delete job.error;
  await writeFile(path.join(f.directory, 'xhs-publisher.json'), JSON.stringify(state), { mode: 0o600 });
  const prepared = await f.create().verify(f.input); assert.equal(prepared.status, 'blocked'); assert.equal(prepared.submitted, false); assert.equal(prepared.verifiedNoSubmission, true);
  const count = f.count('/setFiles'); await f.create().publish(f.input); assert.equal(f.count('/setFiles'), count);
  f.config.ambiguousForm = false; assert.equal((await f.create().publish({ ...f.input, retry: true })).status, 'published'); assert.equal(f.opCount('submit'), 1);
});

test('same key cannot silently reuse a published result for changed file bytes', async t => {
  const f = await fixture(t); assert.equal((await f.create().publish(f.input)).status, 'published');
  await writeFile(f.file, Buffer.concat([PNG, Buffer.from('changed')]));
  const result = await f.create().publish(f.input); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, true); assert.equal(f.opCount('submit'), 1);
});


test('known never-submitted tasks can be verified while Chrome is offline, without creating a tab', async t => {
  const f = await fixture(t, { ambiguousForm: true }); await f.create().publish(f.input);
  let calls = 0; const offline = createXhsPublisher({ directory: f.directory, env: {}, fetcher: async () => { calls++; throw new Error('offline'); } });
  const result = await offline.verify(f.input); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, false); assert.equal(result.verifiedNoSubmission, true); assert.equal(calls, 0);
});

test('unreadable current source files never downgrade a previously verified published record', async t => {
  const f = await fixture(t); await f.create().publish(f.input); await rm(f.file);
  const result = await f.create().publish(f.input); assert.equal(result.status, 'blocked'); assert.equal(result.submitted, true);
  assert.equal(Object.values((await f.state()).jobs)[0].status, 'published');
  assert.equal((await f.create().verify(f.input)).status, 'published'); assert.equal(f.opCount('submit'), 1);
});


test('dashboard account extraction waits for its own value and never consumes adjacent achievement text', async t => {
  const f = await fixture(t); await f.create().checkConnection(A);
  const source = f.calls.find(call => call.url.pathname === '/eval').init.body;
  const node = value => ({ innerText: value, children: [], parentElement: null, hidden: false, getAttribute: () => null, getClientRects: () => [{}] });
  const snapshot = (leafTexts, body) => runInNewContext(source, {
    URL, location: { href: 'https://creator.xiaohongshu.com/new/home' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { body: node(body), querySelectorAll: selector => selector === 'div,span,p' ? leafTexts.map(node) : [] }
  });
  const pending = snapshot(['小红书账号: ', '你已达成'], '小红书账号: \n你已达成');
  assert.equal(pending.status, 'loading'); assert.equal(pending.handle, '');
  const loaded = snapshot(['小红书账号: HumanPatch', '你已达成'], '小红书账号: HumanPatch\n你已达成');
  assert.equal(loaded.status, 'ready'); assert.equal(loaded.handle, 'HumanPatch');
  const split = snapshot(['小红书账号:\n你已达成'], '小红书账号:\n你已达成');
  assert.equal(split.handle, '');
});


test('official same-note canonical redirects from profile cards to explore keep strict note identity', async t => {
  const f = await fixture(t, { canonicalNotes: true });
  assert.equal((await f.create().checkConnection(A)).status, 'ready'); assert.equal(f.live.size, 0);
  const result = await f.create().publish(f.input); assert.equal(result.status, 'published'); assert.equal(result.verified, true); assert.equal(f.opCount('submit'), 1); assert.equal(f.live.size, 0);
});


test('native text cards follow the observed platform workflow, with no image upload', async t => {
  const f = await fixture(t,{textAvailable:true});
  const publisher = f.create();
  const connection = await publisher.checkConnection(A); assert.equal(connection.text,true);
  const result = await publisher.publish({...f.input,post:{...f.post,contentMode:'text',images:[],cardText:'测试文字卡片',textTemplate:'简约'}});
  assert.equal(result.status,'published');assert.equal(f.count('/setFiles'),0);assert.equal(f.opCount('submit'),1);
  assert.equal(f.opCount('text-generate'),1);assert.equal(f.config.cardText,'测试文字卡片');
  assert.equal(Object.values((await f.state()).jobs)[0].expectedImageCount,1);
});
test('native text cards fail closed when the platform entry is unavailable', async t => {
  const f=await fixture(t);const result=await f.create().publish({...f.input,post:{...f.post,contentMode:'text',images:[]}});
  assert.equal(result.status,'blocked');assert.equal(f.count('/setFiles'),0);assert.equal(f.opCount('submit'),0);assert.match(result.error,/文字配图入口/);
});
test('account session is bound to a durable publishing job, never swapped for retry',async t=>{
  const f=await fixture(t,{ambiguousForm:true});let sessionCalls=[];
  const sessions={isLegacy:id=>!id || id==='legacy',status:id=>({mode:id?'isolated':'legacy'}),transport:async id=>{sessionCalls.push(id);if(!id || id==='legacy')return null;return async(route,body,jsonBody)=>{const result=await f.fetcher('http://127.0.0.1:3456'+route,{redirect:'error',signal:AbortSignal.timeout(1000),...(body===undefined?{}:{body:jsonBody?JSON.stringify(body):body})});return result.json();};}};
  const publisher=createXhsPublisher({directory:f.directory,env:{},fetcher:f.fetcher,sessions});
  await publisher.publish({...f.input,sessionId:'account-one'});const before=f.count('/new');
  const swapped=await publisher.publish({...f.input,sessionId:'account-two',retry:true});
  assert.equal(swapped.status,'blocked');assert.match(swapped.error,/另一个账号会话/);assert.equal(f.count('/new'),before);
  assert.equal(Object.values((await f.state()).jobs)[0].sessionId,'account-one');assert.deepEqual(sessionCalls,['account-one']);
});
test('performance reads only a verified account and preserves the official date window',async t=>{
  const f=await fixture(t);const result=await f.create().readPerformance(A);
  assert.equal(result.status,'partial');assert.equal(result.accountId,A);assert.equal(result.summary.views,313);assert.equal(result.summary.impressions,1621);assert.equal(result.summary.likes,null);assert.deepEqual(result.notes,[]);
  assert.equal(f.count('/setFiles'),0);assert.equal(f.opCount('submit'),0);assert.equal(f.live.size,0);
  f.config.creatorHandle='wrong';const wrong=await f.create().readPerformance(A);assert.equal(wrong.status,'unavailable');assert.equal(wrong.errorCode,'mismatch');assert.equal(wrong.summary,undefined);
});
test('closed isolated sessions return an actionable error without using legacy Chrome',async t=>{
 const f=await fixture(t);const publisher=createXhsPublisher({directory:f.directory,env:{},fetcher:f.fetcher,sessions:{isLegacy:()=>false,transport:async()=>{throw Object.assign(Error('请打开此账号的登录窗口'),{code:'session_closed'});}}});
 const result=await publisher.checkConnection(A,{sessionId:'other'});assert.equal(result.status,'unavailable');assert.equal(result.errorCode,'session_closed');assert.match(result.error,/登录窗口/);assert.equal(f.count('/new'),0);
});
