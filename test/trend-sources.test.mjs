import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { TREND_PLATFORMS, isOfficialTrendUrl, fetchTrendBoards, safeTrendFailure } from '../app/trend-sources.mjs';

const json = value => new Response(JSON.stringify(value));
const disabledBrowser = { REDPILOT_READER_PROXY_URL: 'https://not-a-local-proxy.example' };
const baiduRow = (rank, title = '示例热搜', href = 'https://www.baidu.com/s?wd=fixture') => `<div class="category-wrap_fixture horizontal_fixture"><div class="index_fixture">${rank}</div><div class="hot-index_fixture">123456</div><a href="${href}" class="title_fixture"><div class="c-single-text-ellipsis">${title}</div></a></div>`;
const toutiao = count => ({ status: 'success', data: Array.from({ length: count }, (_, index) => ({ ClusterIdStr: `7700000000000000${index.toString().padStart(3, '0')}`, Title: `示例热点${index + 1}`, Url: `https://www.toutiao.com/trending/${index + 100}/?event_type=hot_board`, HotValue: String(5000 - index) })) });

test('trend failure reasons use a fixed allowlist and never reflect source errors or private details', () => {
  const codes = ['needs_login', 'verification_required', 'browser_unavailable', 'network_error', 'invalid_source', 'board_not_exposed', 'board_not_loaded', 'source_unavailable', 'response_too_large', 'invalid_response'];
  const privateText = 'PRIVATE_SOURCE_DETAILS sk-fixture-private-key /Users/private/runtime/secret.json';
  for (const reasonCode of codes) {
    const result = safeTrendFailure({ reasonCode, error: privateText, message: privateText });
    assert.equal(result.reasonCode, reasonCode); assert.ok(result.error); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE_DETAILS|sk-fixture|\/Users\/private/);
    assert.deepEqual(safeTrendFailure(reasonCode), result);
  }
  const generic = safeTrendFailure('source_unavailable');
  for (const value of [privateText, { error: privateText }, { message: privateText }, { reasonCode: '__proto__', error: privateText }, { reasonCode: 'toString' }, { reasonCode: privateText }, { reasonCode: null }, { reasonCode: {} }]) assert.deepEqual(safeTrendFailure(value), generic);
  assert.deepEqual(safeTrendFailure({ reasonCode: 'unknown', error: '官方榜单需要登录后读取' }, 'needs_login'), generic);
  assert.equal(safeTrendFailure({ error: privateText }, 'needs_login').reasonCode, 'needs_login');
  assert.equal(safeTrendFailure({}, 'blocked').reasonCode, 'verification_required');
  for (const text of ['官方榜单需要登录后读取', '该平台需要登录']) assert.equal(safeTrendFailure({ error: text }).reasonCode, 'needs_login');
  assert.equal(safeTrendFailure({ error: '该平台暂时限制访问' }).reasonCode, 'verification_required');
  assert.equal(safeTrendFailure(undefined, 'needs_login').reasonCode, 'needs_login');
  assert.equal(safeTrendFailure(null, 'blocked').reasonCode, 'verification_required');
});

test('metadata contains exactly the seven fixed official boards and cannot be mutated', () => {
  assert.deepEqual(TREND_PLATFORMS.map(item => item.id), ['xiaohongshu', 'douyin', 'bilibili', 'weibo', 'zhihu', 'baidu', 'toutiao']);
  for (const platform of TREND_PLATFORMS) {
    assert.ok(platform.name && platform.boardName);
    assert.equal(isOfficialTrendUrl(platform.id, platform.url), true);
    assert.equal(Object.isFrozen(platform), true);
  }
  assert.equal(Object.isFrozen(TREND_PLATFORMS), true);
});

test('official URL validation uses precise domain suffixes, HTTPS, no credentials and default port', () => {
  const accepted = { xiaohongshu: ['https://www.xiaohongshu.com/explore', 'https://xhslink.com/a/fixture'], douyin: ['https://www.douyin.com/hot'],
    bilibili: ['https://api.bilibili.com/x/web-interface/ranking/v2', 'https://b23.tv/fixture'], weibo: ['https://s.weibo.com/top/summary', 'https://weibo.cn/fixture'],
    zhihu: ['https://www.zhihu.com/question/123'], baidu: ['https://top.baidu.com:443/board', 'https://www.baidu.com/s?wd=fixture'], toutiao: ['https://www.toutiao.com/trending/123/'] };
  for (const [id, urls] of Object.entries(accepted)) {
    for (const url of urls) assert.equal(isOfficialTrendUrl(id, url), true, url);
    const host = new URL(urls[0]).hostname;
    for (const url of [`http://${host}/`, `https://${host}:8443/`, `https://user:password@${host}/`, `https://${host}.evil.example/`, 'https://evil.example/']) assert.equal(isOfficialTrendUrl(id, url), false, url);
  }
  assert.equal(isOfficialTrendUrl('unknown', 'https://www.baidu.com/'), false);
  assert.equal(isOfficialTrendUrl('bilibili', 'https://evilbilibili.com/'), false);
});

test('unknown platform inputs are rejected before making any request', async () => {
  let calls = 0;
  for (const platformIds of ['baidu', ['unknown'], ['https://127.0.0.1/'], Array(8).fill('baidu'), [{ id: 'baidu' }]]) {
    await assert.rejects(fetchTrendBoards({ platformIds }, {}, async () => { calls++; }));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await fetchTrendBoards({ platformIds: [] }, {}, async () => { calls++; }), []);
});

test('Baidu parses visible official ranks and hrefs, excludes unnumbered pinned stories and never uses heat as a rank', async () => {
  const html = baiduRow('<img src="top.png">', '无序号置顶') + baiduRow('1', '示例 &amp; 标题', 'https://www.baidu.com/s?wd=fixture&amp;sa=board')
    + baiduRow('2', '第二条', 'https://www.baidu.com/s?wd=second')
    + '<div class="category-wrap_fixture"><div class="hot-index_fixture">999999</div><a class="title_fixture" href="https://www.baidu.com/s?wd=unranked"><div class="c-single-text-ellipsis">没有序号</div></a></div>'
    + `<script>window.__INITIAL_STATE__=${JSON.stringify(baiduRow('3', '隐藏状态假行'))}</script>`;
  const calls = [];
  const [board] = await fetchTrendBoards({ platformIds: ['baidu'] }, {}, async (url, init) => { calls.push({ url, init }); return new Response(html); });
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'manual'); assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(board.status, 'ready'); assert.equal(board.boardName, '百度热搜');
  assert.equal('reasonCode' in board, false); assert.equal('error' in board, false);
  assert.deepEqual(board.items.map(item => item.rank), [1, 2]);
  assert.equal(board.items[0].title, '示例 & 标题'); assert.equal(board.items[0].url, 'https://www.baidu.com/s?wd=fixture&sa=board');
  assert.equal(board.items[0].heatText, '123456'); assert.ok(Number.isFinite(Date.parse(board.fetchedAt)));
});

test('Toutiao uses the public official API order, string IDs and actual item URLs with a 30-item limit', async () => {
  const payload = toutiao(50), source = TREND_PLATFORMS.find(item => item.id === 'toutiao').url;
  const [board] = await fetchTrendBoards({ platformIds: ['toutiao'] }, {}, async url => { assert.equal(url, source); return json(payload); });
  assert.equal(board.status, 'ready'); assert.equal(board.sourceUrl, source); assert.equal(board.items.length, 30);
  assert.equal(board.items[0].id, payload.data[0].ClusterIdStr); assert.equal(board.items[0].url, payload.data[0].Url);
  assert.deepEqual(board.items.map(item => item.rank), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal(board.items[0].heatText, payload.data[0].HotValue);
});

test('API items with foreign destinations or missing actual URLs are excluded without fabricating links', async () => {
  const payload = toutiao(3); payload.data[0].Url = 'https://evil.example/article'; delete payload.data[1].Url;
  const [board] = await fetchTrendBoards({ platformIds: ['toutiao'] }, {}, async () => json(payload));
  assert.equal(board.items.length, 1); assert.equal(board.items[0].rank, 3); assert.equal(board.items[0].url, payload.data[2].Url);
});

test('Bilibili accepts a successful public API response and does not synthesize a URL from a video ID', async () => {
  const [board] = await fetchTrendBoards({ platformIds: ['bilibili'] }, {}, async () => json({ code: 0, data: { list: [
    { bvid: 'BVfixtureA', title: '官方结构中的第一条', short_link_v2: 'https://b23.tv/fixtureA' },
    { bvid: 'BVfixtureB', title: '缺链接，不能硬拼视频地址' }
  ] } }));
  assert.equal(board.status, 'ready'); assert.equal(board.items.length, 1); assert.equal(board.items[0].rank, 1); assert.equal(board.items[0].url, 'https://b23.tv/fixtureA');
});

test('Weibo HTML accepts numeric ranks only, preserving real links and skipping ads and pinned entries', async () => {
  const row = (rank, title, href = '/weibo?q=fixture') => `<tr><td class="td-01">${rank}</td><td class="td-02"><a${href ? ` href="${href}"` : ''}>${title}</a><span>12345</span></td></tr>`;
  const html = `<table><tbody>${row('', '置顶')}${row('•', '广告')}${row('1', '真实序号')}${row('2', '缺少链接', '')}</tbody></table>`;
  const [board] = await fetchTrendBoards({ platformIds: ['weibo'] }, {}, async () => new Response(html));
  assert.equal(board.status, 'ready'); assert.deepEqual(board.items, [{ title: '真实序号', url: 'https://s.weibo.com/weibo?q=fixture', rank: 1, heatText: '12345' }]);
});

test('redirects are followed only within the same official platform and stop before an external request', async () => {
  let calls = 0;
  const [valid] = await fetchTrendBoards({ platformIds: ['baidu'] }, {}, async url => {
    calls++; return calls === 1 ? new Response('', { status: 302, headers: { Location: 'https://www.baidu.com/official-board' } }) : new Response(baiduRow('1'));
  });
  assert.equal(valid.status, 'ready'); assert.equal(calls, 2);
  calls = 0;
  const [invalid] = await fetchTrendBoards({ platformIds: ['baidu'] }, disabledBrowser, async url => { calls++; assert.equal(new URL(url).hostname, 'top.baidu.com'); return new Response('', { status: 302, headers: { Location: 'https://top.baidu.com.evil.example/steal' } }); });
  assert.equal(invalid.status, 'unavailable'); assert.equal(calls, 1); assert.deepEqual(invalid.items, []);
});

function chromeProxy({ resultFor, infoFor, failEval = false } = {}) {
  const calls = []; let current = '', inflight = 0, maximum = 0;
  const fetcher = async (address, init = {}) => {
    inflight++; maximum = Math.max(maximum, inflight);
    try {
      const url = new URL(address); calls.push({ url, init });
      if (url.hostname !== '127.0.0.1') return new Response('blocked', { status: 403 });
      assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
      if (url.pathname === '/new') { current = url.searchParams.get('url'); return json({ targetId: 'OWN-TREND-TAB' }); }
      assert.equal(url.searchParams.get('target'), 'OWN-TREND-TAB');
      if (url.pathname === '/navigate') { current = url.searchParams.get('url'); return json({ frameId: 'OWN-TREND-TAB' }); }
      if (url.pathname === '/close') return json({ success: true });
      if (url.pathname === '/info') return json(infoFor?.(current) || { url: current, ready: 'complete' });
      if (url.pathname === '/eval') {
        if (failEval) throw new Error('private-provider-details');
        return json({ value: resultFor?.(current, init.body) || { status: 'partial', sourceUrl: current, items: [{ title: '浏览器可见的官方榜单项', url: current, rank: 1 }] } });
      }
      assert.fail('unexpected proxy path');
    } finally { inflight--; }
  };
  return { fetcher, calls, maximum: () => maximum };
}
function fakeTiming({ frozen = false } = {}) {
  let elapsed = 0; const sleeps = [];
  return { options: { clock: () => elapsed, sleep: async milliseconds => { sleeps.push(milliseconds); if (!frozen) elapsed += milliseconds; } }, elapsed: () => elapsed, sleeps };
}

test('Chrome fallback is sequential, reuses only one owned background tab and always closes it', async () => {
  const p = chromeProxy();
  const boards = await fetchTrendBoards({ platformIds: ['bilibili', 'weibo'] }, {}, p.fetcher);
  assert.ok(boards.every(board => board.status === 'partial' && board.items.length === 1));
  assert.equal(p.calls.filter(call => call.url.pathname === '/new').length, 1);
  assert.equal(p.calls.filter(call => call.url.pathname === '/navigate').length, 1);
  assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
  assert.equal(p.maximum(), 1);
  assert.ok(boards.every(board => board.scope.includes('DOM')));
});

test('login and verification states are explicit and never populated with fake board entries', async () => {
  const p = chromeProxy({ resultFor: current => ({ status: current.includes('zhihu.com') ? 'needs_login' : 'blocked', sourceUrl: current, items: [] }) });
  const timing = fakeTiming();
  const boards = await fetchTrendBoards({ platformIds: ['zhihu', 'douyin'] }, {}, p.fetcher, timing.options);
  assert.deepEqual(boards.map(board => board.status), ['needs_login', 'blocked']);
  assert.deepEqual(boards.map(board => board.reasonCode), ['needs_login', 'verification_required']);
  assert.ok(boards.every(board => board.items.length === 0 && board.error && Number.isFinite(Date.parse(board.fetchedAt))));
  assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
  assert.deepEqual(timing.sleeps, []);
});

test('loading browser pages and DOM windows are retried within the budget until real ranked rows become readable', async () => {
  let infos = 0, reads = 0;
  const timing = fakeTiming();
  const p = chromeProxy({ infoFor: current => {
    infos++;
    return infos === 1 ? { url: 'about:blank', ready: 'loading' } : { url: current, ready: infos === 2 ? 'loading' : 'complete' };
  }, resultFor: current => {
    reads++;
    return reads === 1 ? { status: 'unavailable', reasonCode: 'board_not_loaded', sourceUrl: current, items: [] }
      : { status: 'partial', sourceUrl: current, items: [{ title: '加载后可见的真实排名', url: 'https://www.douyin.com/hot/fixture?from=official-board', rank: 7 }] };
  } });
  const [board] = await fetchTrendBoards({ platformIds: ['douyin'] }, {}, p.fetcher, timing.options);
  assert.equal(board.status, 'partial'); assert.equal(board.items[0].rank, 7);
  assert.equal(board.items[0].url, 'https://www.douyin.com/hot/fixture?from=official-board');
  assert.equal(infos, 4); assert.equal(reads, 2); assert.equal(timing.elapsed(), 1200);
  assert.deepEqual(timing.sleeps, [400, 400, 400]);
  assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
});

test('a permanently loading browser stops at eight seconds and a frozen clock still has an attempt cap', async () => {
  for (const frozen of [false, true]) {
    const timing = fakeTiming({ frozen });
    const p = chromeProxy({ infoFor: current => ({ url: current, ready: 'loading' }) });
    const [board] = await fetchTrendBoards({ platformIds: ['douyin'] }, {}, p.fetcher, timing.options);
    assert.equal(board.status, 'unavailable'); assert.equal(board.reasonCode, 'board_not_loaded'); assert.deepEqual(board.items, []);
    assert.equal(p.calls.filter(call => call.url.pathname === '/info').length, frozen ? 21 : 20);
    assert.equal(p.calls.filter(call => call.url.pathname === '/eval').length, 0);
    assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
    assert.equal(timing.sleeps.reduce((sum, value) => sum + value, 0), 8000);
    assert.equal(timing.elapsed(), frozen ? 0 : 8000);
  }
});

test('an external browser redirect is rejected before DOM evaluation even while loading', async () => {
  const p = chromeProxy({ infoFor: () => ({ url: 'https://evil.example/hot', ready: 'loading' }) });
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher);
  assert.equal(board.status, 'unavailable'); assert.deepEqual(board.items, []);
  assert.equal(board.reasonCode, 'invalid_source');
  assert.equal(p.calls.filter(call => call.url.pathname === '/eval').length, 0); assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
});

test('DOM expression also guards the actual evaluated location before any document access', async () => {
  let guarded = false;
  const p = chromeProxy({ resultFor: (current, script) => {
    const context = { location: { href: 'https://www.bilibili.com.evil.example/hot' }, URL };
    Object.defineProperty(context, 'document', { get() { assert.fail('read foreign DOM'); } });
    const value = runInNewContext(script, context); guarded = value.status === 'unavailable'; return value;
  } });
  const [board] = await fetchTrendBoards({ platformIds: ['bilibili'] }, {}, p.fetcher);
  assert.equal(guarded, true); assert.equal(board.status, 'unavailable'); assert.deepEqual(board.items, []);
});

test('provider errors are sanitized and the owned browser tab is closed after a failed eval', async () => {
  const p = chromeProxy({ failEval: true });
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher);
  assert.equal(board.status, 'unavailable'); assert.equal(JSON.stringify(board).includes('private-provider-details'), false);
  assert.equal(board.reasonCode, 'browser_unavailable');
  assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
});

test('declared and streamed responses over two MiB are cancelled before parsing', async () => {
  let cancelled = false;
  const [declared] = await fetchTrendBoards({ platformIds: ['toutiao'] }, disabledBrowser, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }));
  assert.equal(declared.status, 'unavailable'); assert.equal(cancelled, true);
  cancelled = false; let pulls = 0;
  const [streamed] = await fetchTrendBoards({ platformIds: ['toutiao'] }, disabledBrowser, async () => new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } })));
  assert.equal(streamed.status, 'unavailable'); assert.equal(cancelled, true); assert.ok(pulls <= 4);
});

test('a public-source restriction followed by browser failure keeps an actionable safe browser reason', async () => {
  let calls = 0;
  const privateText = 'PRIVATE_BRIDGE_DETAILS sk-fixture-private-key /Users/private/runtime/secret.json';
  const [board] = await fetchTrendBoards({ platformIds: ['bilibili'] }, {}, async address => {
    calls++;
    if (new URL(address).hostname === 'api.bilibili.com') return json({ code: -352, message: privateText });
    throw new Error(privateText);
  });
  assert.equal(calls, 2); assert.equal(board.status, 'unavailable'); assert.equal(board.reasonCode, 'browser_unavailable');
  assert.deepEqual(board.items, []); assert.match(board.error, /Chrome/); assert.doesNotMatch(JSON.stringify(board), /PRIVATE_BRIDGE_DETAILS|sk-fixture|\/Users\/private/);
});

test('no-item DOM results retain whitelisted diagnostics and never reflect an unknown bridge message', async () => {
  const p = chromeProxy({ resultFor: current => ({ status: 'unavailable', sourceUrl: current, items: [], reasonCode: 'board_not_loaded', error: 'PRIVATE_PROVIDER_DETAILS' }) });
  const timing = fakeTiming();
  const [board] = await fetchTrendBoards({ platformIds: ['douyin'] }, {}, p.fetcher, timing.options);
  assert.equal(board.reasonCode, 'board_not_loaded'); assert.match(board.error, /加载/); assert.doesNotMatch(JSON.stringify(board), /PRIVATE_PROVIDER_DETAILS/);
  assert.equal(p.calls.filter(call => call.url.pathname === '/eval').length, 20); assert.equal(timing.elapsed(), 8000);
  assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
});

async function browserExpression(platformId) {
  let expression;
  const p = chromeProxy({ resultFor: (current, script) => {
    expression = script;
    return { status: 'partial', sourceUrl: current, items: [{ title: '固定网络桩', url: current, rank: 1 }] };
  } });
  await fetchTrendBoards({ platformIds: [platformId] }, {}, p.fetcher);
  return expression;
}
function domContext(platformId, { page = '发现 推荐内容 1 今日记录', readyState = 'complete', boardText, login = false } = {}) {
  const visibleNode = innerText => ({ innerText, getClientRects: () => [{}], querySelectorAll: () => [] });
  const board = boardText ? visibleNode(boardText) : null;
  return { location: { href: TREND_PLATFORMS.find(item => item.id === platformId).url }, URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { readyState, body: { innerText: page }, querySelectorAll: selector => selector.includes('login-modal') ? login ? [visibleNode('登录')] : [] : selector.includes('hotboard') && board ? [board] : [] } };
}

test('browser DOM diagnostics distinguish login, verification, loading and an unread ranking without inventing feed entries', async () => {
  for (const platformId of ['xiaohongshu', 'douyin']) {
    const expression = await browserExpression(platformId);
    const cases = [
      [{}, 'board_not_exposed'],
      [{ page: '' }, 'board_not_loaded'],
      [{ page: '页面正在加载', readyState: 'loading' }, 'board_not_loaded'],
      [{ boardText: platformId === 'xiaohongshu' ? '热门搜索' : '抖音热榜' }, 'board_not_loaded'],
      [{ page: '请完成验证后继续浏览' }, 'verification_required'],
      [{ login: true }, 'needs_login']
    ];
    for (const [options, reasonCode] of cases) {
      const result = runInNewContext(expression, domContext(platformId, options));
      assert.equal(result.reasonCode, reasonCode); assert.equal(result.items.length, 0);
      assert.ok(['unavailable', 'blocked', 'needs_login'].includes(result.status));
    }
  }
});

test('a targeted retry reads only its selected platform and coalesces duplicate IDs', async () => {
  const calls=[];
  const boards=await fetchTrendBoards({platformIds:['baidu','baidu']},{},async url=>{calls.push(url);assert.equal(new URL(url).hostname,'top.baidu.com');return new Response(baiduRow('1','手机通信'));});
  assert.deepEqual(boards.map(board=>board.platformId),['baidu']);assert.equal(calls.length,1);assert.equal(boards[0].status,'ready');
});
