import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { normalizeFeishuSource, readFeishuSources } from '../app/feishu-reader.mjs';

const ORIGIN = 'https://workspace.feishu.cn';
const A = ORIGIN + '/docx/FixtureDocumentA001', B = ORIGIN + '/docx/FixtureDocumentB002';
const FOLDER = ORIGIN + '/drive/folder/FixtureFolder001';
const WIKI = ORIGIN + '/wiki/FixtureWikiDocument01';
const json = value => new Response(JSON.stringify(value));
const doc = (url, text = '仅用于测试的产品资料。', extra = {}) => ({ url, kind: 'document', status: 'ready', title: '测试文档', blocks: [{ id: 'body-block-1', text }], complete: true, atEnd: true, error: '', ...extra });
const folder = (links, extra = {}) => ({ url: FOLDER, kind: 'folder', status: 'partial', links, complete: false, atEnd: true, error: '目录为部分窗口', ...extra });
function proxy({ pages = {}, infoOverride, failOn, navigationTimeout = false, afterEval } = {}) {
  const calls = []; let current = 'about:blank';
  const fetcher = async (address, init = {}) => {
    const url = new URL(address); calls.push({ url, init, page: current });
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '3456');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (failOn?.(url, init, current)) throw new Error('private-fixture-provider-body');
    if (url.pathname === '/new') { assert.equal(url.searchParams.get('url'), 'about:blank'); return json({ targetId: 'OWN-FEISHU-TAB' }); }
    assert.equal(url.searchParams.get('target'), 'OWN-FEISHU-TAB');
    if (url.pathname === '/close') return json({ success: true });
    if (url.pathname === '/navigate') {
      current = url.searchParams.get('url');
      if (navigationTimeout) throw new DOMException('not logged', 'TimeoutError');
      return json({ frameId: 'OWN-FEISHU-TAB' });
    }
    if (url.pathname === '/info') return json(infoOverride?.(current) || { url: current, ready: 'interactive' });
    if (url.pathname === '/eval') {
      if (init.body.includes('function scrollPage')) return json({ value: { scrolled: true } });
      const value = typeof pages[current] === 'function' ? pages[current](init.body) : pages[current] || doc(current);
      afterEval?.(current, value);
      return json({ value });
    }
    assert.fail('unexpected proxy route');
  };
  return { fetcher, calls, navigations: () => calls.filter(call => call.url.pathname === '/navigate').map(call => call.url.searchParams.get('url')), closed: () => calls.filter(call => call.url.pathname === '/close').length };
}

test('source normalization accepts canonical tenant docx/wiki/folder URLs and removes tracking and anchors', () => {
  assert.equal(normalizeFeishuSource(A + '/?from=copy#section'), A);
  assert.equal(normalizeFeishuSource(FOLDER + '?from=space'), FOLDER);
  assert.equal(normalizeFeishuSource(WIKI), WIKI);
  assert.equal(normalizeFeishuSource('https://tenant.larksuite.com:443/docx/FixtureDocumentA001'), 'https://tenant.larksuite.com/docx/FixtureDocumentA001');
});

test('foreign, insecure, credential-bearing, attachment, API and unsupported paths are rejected before network access', async () => {
  const invalid = ['http://workspace.feishu.cn/docx/FixtureDocumentA001', 'https://workspace.feishu.cn.evil.example/docx/FixtureDocumentA001',
    'https://evil.example/docx/FixtureDocumentA001', 'https://workspace.feishu.cn:8443/docx/FixtureDocumentA001',
    'https://user:password@workspace.feishu.cn/docx/FixtureDocumentA001', ORIGIN + '/file/FixtureAttachment001',
    ORIGIN + '/open-apis/docx/v1/documents/FixtureDocumentA001', ORIGIN + '/sheets/FixtureSheet001', A + '/extra', ORIGIN + '/DOCX/FixtureDocumentA001', A + '\n'];
  let calls = 0;
  for (const url of invalid) {
    assert.throws(() => normalizeFeishuSource(url));
    await assert.rejects(readFeishuSources({ urls: [url] }, {}, async () => { calls++; }));
  }
  assert.equal(calls, 0);
});

test('direct documents are read once, preserve plaintext, and provide root provenance without browser state access', async () => {
  const p = proxy({ pages: { [A]: doc(A, '测试第一段\n测试第二段') } });
  const result = await readFeishuSources({ urls: [A, A + '?from=copy'] }, {}, p.fetcher);
  assert.equal(result.status, 'ready'); assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].text, '测试第一段\n测试第二段');
  assert.deepEqual(result.documents[0].sourceUrls, [A]); assert.equal(result.documents[0].complete, true);
  assert.ok(Number.isFinite(Date.parse(result.documents[0].readAt)));
  assert.deepEqual(result.sources, [{ url: A, status: 'ready', documentCount: 1, complete: true, documentUrls: [A] }]);
  assert.deepEqual(p.navigations(), [A]); assert.equal(p.closed(), 1);
});

test('explicit documents are prioritized and directory discovery merges new same-tenant documents and source roots', async () => {
  const foreign = 'https://other.feishu.cn/docx/ForeignDocument001';
  const p = proxy({ pages: { [FOLDER]: folder([A, B, B, foreign, FOLDER, ORIGIN + '/file/AttachmentFixture001']) } });
  const result = await readFeishuSources({ urls: [FOLDER, A] }, {}, p.fetcher);
  assert.equal(result.status, 'partial'); assert.deepEqual(p.navigations(), [A, FOLDER, B]);
  assert.equal(result.documents.length, 2);
  assert.deepEqual(result.documents.find(document => document.url === A).sourceUrls, [A, FOLDER]);
  assert.deepEqual(result.documents.find(document => document.url === B).sourceUrls, [FOLDER]);
  const source = result.sources.find(source => source.url === FOLDER);
  assert.deepEqual(source.documentUrls, [A, B]); assert.equal(source.documentCount, 2); assert.equal(source.complete, false); assert.equal(source.status, 'partial');
  assert.equal(p.closed(), 1);
});

test('directory document count is bounded to twenty unique attempts and extra documents remain explicitly partial', async () => {
  const links = Array.from({ length: 25 }, (_, index) => ORIGIN + '/docx/FixtureDocument' + String(index).padStart(4, '0'));
  const p = proxy({ pages: { [FOLDER]: folder(links) } });
  const result = await readFeishuSources({ urls: [FOLDER] }, {}, p.fetcher);
  assert.equal(result.status, 'partial'); assert.equal(result.documents.length, 20);
  assert.equal(p.navigations().length, 21); assert.equal(result.sources[0].documentUrls.length, 25);
  assert.match(result.sources[0].error, /20篇|时间预算/); assert.equal(p.closed(), 1);
});

test('unsuccessful document attempts also consume the twenty-document cap', async () => {
  const links = Array.from({ length: 25 }, (_, index) => ORIGIN + '/docx/RestrictedDocument' + String(index).padStart(4, '0'));
  const pages = Object.fromEntries(links.map(url => [url, { url, kind: null, status: 'needs_login', error: '需要登录', blocks: [] }]));
  pages[FOLDER] = folder(links);
  const p = proxy({ pages }); const result = await readFeishuSources({ urls: [FOLDER] }, {}, p.fetcher);
  assert.equal(result.status, 'needs_login'); assert.equal(result.documents.length, 0); assert.equal(p.navigations().length, 21); assert.equal(p.closed(), 1);
});

test('a wiki page can yield rendered document blocks without calling private APIs', async () => {
  const p = proxy({ pages: { [WIKI]: doc(WIKI, '测试知识库的可见正文。') } });
  const result = await readFeishuSources({ urls: [WIKI] }, {}, p.fetcher);
  assert.equal(result.status, 'ready'); assert.equal(result.documents[0].url, WIKI);
  assert.ok(p.calls.every(call => call.url.hostname === '127.0.0.1'));
});

test('virtualized or incomplete document text is retained as partial and never labelled complete', async () => {
  const p = proxy({ pages: { [A]: doc(A, '当前可见的测试正文。', { status: 'partial', complete: false, virtualized: true, atEnd: true, error: '尚未确认正文完整' }) } });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(result.status, 'partial'); assert.equal(result.documents[0].complete, false); assert.match(result.sources[0].error, /未确认/);
});

test('long document text is truncated at sixty thousand characters with a clear partial status', async () => {
  const p = proxy({ pages: { [A]: doc(A, '字'.repeat(60001)) } });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(result.documents[0].text.length, 60000); assert.equal(result.documents[0].complete, false); assert.equal(result.status, 'partial'); assert.match(result.sources[0].error, /60000/);
});

test('stable DOM block IDs merge finite scroll windows without repeating paragraphs', async () => {
  let pass = 0;
  const p = proxy({ pages: { [A]: () => ++pass === 1 ? doc(A, '第一段', { complete: false, atEnd: false }) : doc(A, '', { blocks: [{ id: 'body-block-1', text: '第一段' }, { id: 'body-block-2', text: '第二段' }], complete: true }) } });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(result.documents[0].text, '第一段\n\n第二段'); assert.equal(result.documents[0].complete, true); assert.equal(p.closed(), 1);
});

test('already verified text survives a later network failure as an incomplete snapshot', async () => {
  let reads = 0;
  const p = proxy({ pages: { [A]: doc(A, '已经核对的第一段。', { complete: false, atEnd: false }) },
    failOn: (url, init) => url.pathname === '/eval' && init.body.includes('function extractPage') && ++reads === 2 });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(result.status, 'partial'); assert.equal(result.documents[0].text, '已经核对的第一段。'); assert.equal(result.documents[0].complete, false); assert.equal(p.closed(), 1);
});

test('navigation load timeout is recovered only when the target URL matches exactly', async () => {
  const p = proxy({ navigationTimeout: true });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(result.status, 'ready'); assert.equal(result.documents.length, 1); assert.equal(p.closed(), 1);
});

test('foreign redirects and different document IDs are rejected before reading the DOM', async () => {
  for (const url of ['https://evil.example/docx/FixtureDocumentA001', B, 'https://other.feishu.cn/docx/FixtureDocumentA001']) {
    const p = proxy({ infoOverride: () => ({ url, ready: 'complete' }) });
    const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.documents, []);
    assert.equal(p.calls.filter(call => call.url.pathname === '/eval').length, 0); assert.equal(p.closed(), 1);
  }
});

test('login and access-control failures have explicit statuses and never store page boilerplate', async () => {
  const login = proxy({ infoOverride: () => ({ url: 'https://accounts.feishu.cn/suite/passport/page/login', ready: 'complete' }) });
  const loginResult = await readFeishuSources({ urls: [A] }, {}, login.fetcher);
  assert.equal(loginResult.status, 'needs_login'); assert.deepEqual(loginResult.documents, []); assert.equal(login.closed(), 1);
  const denied = proxy({ pages: { [A]: { url: A, kind: null, status: 'blocked', error: '没有访问权限', blocks: [] } } });
  const deniedResult = await readFeishuSources({ urls: [A] }, {}, denied.fetcher);
  assert.equal(deniedResult.status, 'blocked'); assert.deepEqual(deniedResult.documents, []); assert.equal(denied.closed(), 1);
});

test('the read budget leaves unprocessed sources partial while preserving earlier documents and closing the tab', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const p = proxy({ afterEval: () => { clock += 116000; } });
  const result = await readFeishuSources({ urls: [A, B] }, {}, p.fetcher);
  assert.equal(result.status, 'partial'); assert.equal(result.documents.length, 1);
  assert.equal(result.sources.find(source => source.url === B).status, 'partial');
  assert.match(result.sources.find(source => source.url === B).error, /预算/); assert.equal(p.closed(), 1);
});

test('disconnected or invalid proxies remain unavailable rather than claiming a successful partial import', async () => {
  let calls = 0;
  const invalid = await readFeishuSources({ urls: [A] }, { REDPILOT_READER_PROXY_URL: 'https://remote.example' }, async () => { calls++; });
  assert.equal(invalid.status, 'unavailable'); assert.equal(calls, 0); assert.deepEqual(invalid.documents, []);
  const disconnected = proxy({ failOn: url => url.pathname === '/new' });
  const failed = await readFeishuSources({ urls: [A] }, {}, disconnected.fetcher);
  assert.equal(failed.status, 'unavailable'); assert.equal(JSON.stringify(failed).includes('private-fixture-provider-body'), false);
});

test('the response limit cancels oversized data and cleanup still closes the owned tab', async () => {
  let current = 'about:blank', cancelled = false, closed = 0;
  const fetcher = async address => {
    const url = new URL(address);
    if (url.pathname === '/new') return json({ targetId: 'LIMIT-FEISHU-TAB' });
    if (url.pathname === '/navigate') { current = url.searchParams.get('url'); return json({}); }
    if (url.pathname === '/info') return json({ url: current });
    if (url.pathname === '/close') { closed++; return json({ success: true }); }
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } });
  };
  const result = await readFeishuSources({ urls: [A] }, {}, fetcher);
  assert.equal(result.status, 'unavailable'); assert.equal(cancelled, true); assert.equal(closed, 1); assert.deepEqual(result.documents, []);
});

test('the browser expression guards the actual evaluated URL before reading any DOM or browser storage', async () => {
  let checked = false;
  const p = proxy({ pages: { [A]: script => {
    const context = { location: { href: 'https://workspace.feishu.cn.evil.example/docx/FixtureDocumentA001' }, URL };
    for (const key of ['document', 'getComputedStyle', 'localStorage', 'sessionStorage', '__INITIAL_STATE__']) Object.defineProperty(context, key, { get() { assert.fail('unsafe access to ' + key); } });
    const value = runInNewContext(script, context); checked = true; return value;
  } } });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(checked, true); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.documents, []); assert.equal(p.closed(), 1);
});

function titleDom(script, { nodeValue, nodeText = '', nodeContent = '', pageTitle = '飞书云文档' } = {}) {
  const node = ({ innerText = '', textContent = '', value, maps = {}, blockId } = {}) => ({
    innerText, textContent, value, parentElement: null, hidden: false, clientHeight: 300, scrollHeight: 300, scrollTop: 0,
    getAttribute: key => key === 'data-block-id' ? blockId || null : null,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ height: 300 }), closest: () => null, contains: () => false,
    querySelectorAll: selector => maps[selector] || []
  });
  const block = node({ innerText: '仅用于标题读取测试的正文。', blockId: 'fixture-block-1' });
  const root = node({ maps: { '.block[data-block-id]': [block] } });
  const title = node({ innerText: nodeText, textContent: nodeContent, value: nodeValue });
  const document = { title: pageTitle, body: node(), querySelectorAll: selector => selector === '.docx-page-block .root-render-unit-container' ? [root]
    : selector === '.suite-title__title, .suite-title input, .suite-title textarea, .suite-title [contenteditable], .suite-title' ? [title] : [] };
  Object.defineProperty(document, 'cookie', { get() { assert.fail('read cookies'); } });
  return JSON.parse(JSON.stringify(runInNewContext(script, { location: { href: A }, URL, document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) })));
}

test('visible title controls use input or textarea values and DOM textContent when innerText is empty', async () => {
  for (const [options, expected] of [
    [{ nodeValue: '测试输入标题' }, '测试输入标题'],
    [{ nodeText: '测试可见标题' }, '测试可见标题'],
    [{ nodeContent: '测试文本标题' }, '测试文本标题']
  ]) {
    const p = proxy({ pages: { [A]: script => titleDom(script, options) } });
    const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
    assert.equal(result.documents[0].title, expected); assert.equal(p.closed(), 1);
  }
});

test('document title fallback removes Feishu or Lark suffixes but never uses a generic navigation title', async () => {
  for (const [pageTitle, expected] of [['测试来源标题 - 飞书云文档', '测试来源标题'], ['测试来源标题 | Lark Docs', '测试来源标题'], ['云空间 - 飞书', '飞书文档'], ['飞书云文档', '飞书文档']]) {
    const p = proxy({ pages: { [A]: script => titleDom(script, { pageTitle }) } });
    const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
    assert.equal(result.documents[0].title, expected); assert.equal(p.closed(), 1);
  }
});

test('a body-first render gets a bounded extra snapshot for its asynchronously loaded title', async () => {
  let snapshots = 0;
  const p = proxy({ pages: { [A]: () => doc(A, '正文已加载并保持不变。', { title: ++snapshots === 1 ? '飞书文档' : '异步加载的文档标题' }) } });
  const result = await readFeishuSources({ urls: [A] }, {}, p.fetcher);
  assert.equal(result.documents[0].title, '异步加载的文档标题');
  assert.equal(result.documents[0].text, '正文已加载并保持不变。');
  assert.equal(snapshots, 2); assert.equal(p.closed(), 1);
});

test('directory names replace generic titles on both previously read and newly discovered documents', async () => {
  const counts = { [A]: 0, [B]: 0 };
  const p = proxy({ pages: {
    [A]: () => { counts[A]++; return doc(A, '第一份可见正文', { title: '飞书文档' }); },
    [B]: () => { counts[B]++; return doc(B, '第二份可见正文', { title: '飞书文档' }); },
    [FOLDER]: folder([A, B], { entries: [{ url: A, title: '目录中的第一份文档' }, { url: B, title: '目录中的第二份文档' }] })
  } });
  const result = await readFeishuSources({ urls: [A, FOLDER] }, {}, p.fetcher);
  assert.equal(result.documents.find(document => document.url === A).title, '目录中的第一份文档');
  assert.equal(result.documents.find(document => document.url === B).title, '目录中的第二份文档');
  assert.ok(counts[A] <= 10 && counts[B] <= 10, 'the header wait must be bounded');
  assert.deepEqual(p.navigations(), [A, FOLDER, B]);
  assert.deepEqual(result.documents.find(document => document.url === A).sourceUrls, [A, FOLDER]);
  assert.equal(p.closed(), 1);
});

test('a directory fallback never overwrites an already verified specific document header', async () => {
  const p = proxy({ pages: { [A]: doc(A, '测试正文', { title: '文档内的当前标题' }), [FOLDER]: folder([A], { entries: [{ url: A, title: '目录中的旧名称' }] }) } });
  const result = await readFeishuSources({ urls: [A, FOLDER] }, {}, p.fetcher);
  assert.equal(result.documents[0].title, '文档内的当前标题'); assert.equal(p.closed(), 1);
});

test('the folder DOM snapshot returns visible anchor names while retaining the legacy URL-only links', async () => {
  let captured;
  const visible = extra => ({ innerText: '', hidden: false, parentElement: null, getAttribute: () => null, getClientRects: () => [{}], querySelectorAll: () => [], ...extra });
  const anchor = visible({ href: A, innerText: '真实目录名称\n测试所有者\n测试更新时间' });
  const row = visible({ querySelectorAll: selector => selector === 'a[href]' ? [anchor] : [] });
  const list = visible({ scrollTop: 0, clientHeight: 300, scrollHeight: 300, querySelectorAll: selector => selector === '.file-list-item' ? [row] : [] });
  const document = { body: visible(), querySelectorAll: selector => selector === '.explorer-file-list-virtualized__container' ? [list] : [] };
  const p = proxy({ pages: { [FOLDER]: script => {
    captured = JSON.parse(JSON.stringify(runInNewContext(script, { location: { href: FOLDER }, URL, document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) })));
    return captured;
  } } });
  await readFeishuSources({ urls: [FOLDER] }, {}, p.fetcher);
  assert.deepEqual(captured.links, [A]); assert.deepEqual(captured.entries, [{ url: A, title: '真实目录名称' }]); assert.equal(p.closed(), 1);
});

test('slow document and folder mounts wait through loading and a generic header before returning verified content', async () => {
  let documentReads = 0, folderReads = 0;
  const p = proxy({ pages: {
    [A]: () => {
      documentReads++;
      return documentReads === 1 ? { url: A, kind: null, status: 'unavailable', error: '页面尚未加载', blocks: [] }
        : doc(A, '慢加载后核对到的正文', { title: documentReads === 2 ? '飞书文档' : '异步完成的真实标题' });
    },
    [FOLDER]: () => ++folderReads === 1 ? { url: FOLDER, kind: null, status: 'unavailable', error: '目录尚未加载', links: [] }
      : folder([A], { entries: [{ url: A, title: '目录名称' }] })
  } });
  const result = await readFeishuSources({ urls: [A, FOLDER] }, {}, p.fetcher);
  assert.equal(result.documents[0].title, '异步完成的真实标题');
  assert.equal(result.documents[0].text, '慢加载后核对到的正文');
  assert.deepEqual(result.documents[0].sourceUrls, [A, FOLDER]);
  assert.equal(documentReads, 3); assert.equal(folderReads, 2); assert.equal(p.closed(), 1);
});
