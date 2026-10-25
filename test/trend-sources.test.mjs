import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { TREND_PLATFORMS, isOfficialTrendUrl, fetchTrendBoards } from '../app/trend-sources.mjs';

const json = value => new Response(JSON.stringify(value));
const disabledBrowser = { REDPILOT_READER_PROXY_URL: 'https://not-a-local-proxy.example' };
const baiduRow = (rank, title = '示例热搜', href = 'https://www.baidu.com/s?wd=fixture') => `<div class="category-wrap_fixture horizontal_fixture"><div class="index_fixture">${rank}</div><div class="hot-index_fixture">123456</div><a href="${href}" class="title_fixture"><div class="c-single-text-ellipsis">${title}</div></a></div>`;
const toutiao = count => ({ status: 'success', data: Array.from({ length: count }, (_, index) => ({ ClusterIdStr: `7700000000000000${index.toString().padStart(3, '0')}`, Title: `示例热点${index + 1}`, Url: `https://www.toutiao.com/trending/${index + 100}/?event_type=hot_board`, HotValue: String(5000 - index) })) });

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
  const boards = await fetchTrendBoards({ platformIds: ['zhihu', 'douyin'] }, {}, p.fetcher);
  assert.deepEqual(boards.map(board => board.status), ['needs_login', 'blocked']);
  assert.ok(boards.every(board => board.items.length === 0 && board.error && Number.isFinite(Date.parse(board.fetchedAt))));
  assert.equal(p.calls.filter(call => call.url.pathname === '/close').length, 1);
});

test('an external browser redirect is rejected before DOM evaluation even while loading', async () => {
  const p = chromeProxy({ infoFor: () => ({ url: 'https://evil.example/hot', ready: 'loading' }) });
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher);
  assert.equal(board.status, 'unavailable'); assert.deepEqual(board.items, []);
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
