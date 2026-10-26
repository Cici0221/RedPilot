import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fetchTrendBoards, parseXhsClassicTopics } from '../app/trend-sources.mjs';

const source = 'https://creator.xiaohongshu.com/new/inspiration';
const explore = 'https://www.xiaohongshu.com/explore';
// Visible text observed in the signed-in official creator centre on 2026-10-26.
// Image URLs, user account data and unrelated example notes are omitted.
const observedText = `创作服务平台
笔记灵感
经典话题 粉丝们长期关注和喜爱的选题，跟着写，流量自然来！
美食
美妆
时尚
出行
知识
兴趣爱好
高颜值巧克力
35.4万人参与 · 16.5亿次浏览
6.8万
瑞士百年老牌巧克力
8475
巧克力糯米船
早餐吃什么
311.5万人参与 · 113.2亿次浏览
4.3万
十分钟搞定的番茄面
面条的花式做法
33.6万人参与 · 33.4亿次浏览
24万
葱油拌面`;

function visibleText(innerText) { return { innerText, getClientRects: () => [{}] }; }
function topicDom(page, categories = [], selectedIndex = 0) {
  const cards = parseXhsClassicTopics(page).map(item => ({ ...visibleText(item.title + '\n' + item.heatText), querySelector: selector => {
    assert.ok([':scope > span.title', ':scope > .notes-desc > .notes-num'].includes(selector));
    return visibleText(selector.includes('span.title') ? item.title : item.heatText);
  } }));
  const headings = categories.map((item, index) => ({ ...visibleText(item.name), classList: { contains: value => value === 'active' && index === selectedIndex }, querySelector: selector => {
    assert.equal(selector, 'h6.d-tabs-header-label'); return visibleText(item.name);
  } }));
  const container = { ...visibleText(page), querySelector: selector => {
    assert.equal(selector, '.title-container'); return visibleText(page.includes('经典话题') ? '经典话题' : '猜你喜欢');
  }, querySelectorAll: selector => {
    if (selector === '.d-tabs-headers > .d-tabs-header') return headings;
    assert.equal(selector, '.d-tabs-pane .panle-box > div > .panel-container'); return cards;
  } };
  return { body: { innerText: page }, querySelectorAll: () => [], querySelector: selector => { assert.equal(selector, '.classic-topics-container'); return container; } };
}
function fixture({ page = observedText, oldStatus = 'unavailable', oldReason = 'board_not_exposed', redirect, failEval = false, frozen = false, corruptResult, categories = [], staleAfterClick = false, neverUpdates = false } = {}) {
  let current, elapsed = 0, selectedIndex = 0, priorIndex = 0, staleRead = false;
  const calls = [], sleeps = [];
  const fetcher = async (address, init = {}) => {
    const url = new URL(address);
    assert.equal(url.origin, 'http://127.0.0.1:3456');
    calls.push({ route: url.pathname, target: url.searchParams.get('target'), url: url.searchParams.get('url') });
    if (url.pathname === '/new') { current = url.searchParams.get('url'); return Response.json({ targetId: 'OWN-XHS-TOPICS' }); }
    assert.equal(url.searchParams.get('target'), 'OWN-XHS-TOPICS');
    if (url.pathname === '/navigate') { current = redirect || url.searchParams.get('url'); return Response.json({ ok: true }); }
    if (url.pathname === '/close') return Response.json({ ok: true });
    if (url.pathname === '/click') {
      if (current === source) {
        const match = init.body.match(/^\.classic-topics-container \.d-tabs-header:nth-child\(([1-6])\)$/);
        assert.ok(match); priorIndex = selectedIndex; selectedIndex = Number(match[1]) - 1; staleRead = staleAfterClick;
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/info') return Response.json({ url: current, ready: 'complete' });
    if (url.pathname === '/eval') {
      if (failEval) throw new Error('PRIVATE_BRIDGE_DETAILS');
      if (current === explore) return Response.json({ value: { status: oldStatus, reasonCode: oldReason, sourceUrl: current, items: [] } });
      const displayIndex = staleRead || neverUpdates ? priorIndex : selectedIndex;
      const displayed = categories.length ? categories[displayIndex].page : page; staleRead = false;
      const context = { URL, location: { href: current }, document: topicDom(displayed, categories, selectedIndex), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
      return Response.json({ value: corruptResult || runInNewContext(init.body, context) });
    }
    assert.fail('Unexpected network operation');
  };
  return { fetcher, calls, sleeps, timing: { clock: () => elapsed, sleep: async ms => { sleeps.push(ms); if (!frozen) elapsed += ms; } } };
}

test('classic-topic text yields titles and cumulative totals without example notes or invented ranks', () => {
  const items = parseXhsClassicTopics(observedText);
  assert.deepEqual(items.map(item => item.title), ['高颜值巧克力', '早餐吃什么', '面条的花式做法']);
  assert.equal(items[0].heatText, '35.4万人参与 · 16.5亿次浏览');
  assert.equal(new URL(items[0].url).searchParams.get('keyword'), '高颜值巧克力');
  assert.ok(items.every(item => !Object.hasOwn(item, 'rank')));
  assert.equal(items.some(item => item.title === '巧克力糯米船'), false);
});

test('classic-topic parser requires its heading, strict metrics and valid titles, deduplicates and caps the window', () => {
  assert.deepEqual(parseXhsClassicTopics(observedText.replace('经典话题 ', '猜你喜欢 ')), []);
  assert.deepEqual(parseXhsClassicTopics(null), []);
  assert.deepEqual(parseXhsClassicTopics('经典话题\n早餐吃什么\n3万人参与 · 昨日浏览很多'), []);
  assert.deepEqual(parseXhsClassicTopics('经典话题\n知识\n3万人参与 · 4亿次浏览'), []);
  assert.equal(parseXhsClassicTopics(observedText + '\n高颜值巧克力\n35.4万人参与 · 16.5亿次浏览').length, 3);
  assert.equal(parseXhsClassicTopics('经典话题\n' + Array.from({ length: 40 }, (_, index) => '话题 ' + index + '\n1万人参与 · 2亿次浏览').join('\n')).length, 30);
});

test('empty XHS search uses its owned tab for real classic-topic fallback and cleans it up once', async () => {
  const p = fixture();
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
  assert.equal(board.status, 'partial'); assert.equal(board.kind, 'topics'); assert.equal(board.boardName, '经典话题');
  assert.equal(board.sourceUrl, source); assert.equal(board.items.length, 3);
  assert.ok(board.items.every(item => !Object.hasOwn(item, 'rank')));
  assert.match(board.scope, /累计/); assert.match(board.scope, /站内关键词搜索/);
  assert.equal(p.calls.filter(call => call.route === '/new').length, 1);
  assert.deepEqual(p.calls.filter(call => call.route === '/navigate').map(call => call.url), [source]);
  assert.equal(p.calls.filter(call => call.route === '/close').length, 1);
});

test('login, verification and bridge failures in the original source do not get hidden by fallback', async () => {
  for (const options of [{ oldStatus: 'needs_login' }, { oldStatus: 'blocked' }, { failEval: true }]) {
    const p = fixture(options);
    const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
    assert.equal(board.items.length, 0);
    assert.equal(p.calls.some(call => call.route === '/navigate'), false);
    assert.equal(p.calls.filter(call => call.route === '/close').length, 1);
    assert.doesNotMatch(JSON.stringify(board), /PRIVATE_BRIDGE_DETAILS/);
  }
});

test('creator login and verification remain explicit instead of fabricating topics', async () => {
  for (const [options, expected] of [[{ redirect: 'https://creator.xiaohongshu.com/login?lastUrl=%2Fnew%2Finspiration' }, 'needs_login'], [{ page: '请完成验证后继续浏览\n' + observedText }, 'verification_required']]) {
    const p = fixture(options);
    const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
    assert.equal(board.reasonCode, expected); assert.equal(board.items.length, 0);
    assert.equal(p.calls.filter(call => call.route === '/close').length, 1);
  }
});

test('foreign and non-inspiration pages cannot be presented as official classic topics', async () => {
  for (const redirect of ['https://creator.xiaohongshu.com.evil.example/new/inspiration', 'https://creator.xiaohongshu.com/new/home', 'https://www.xiaohongshu.com/search_result']) {
    const p = fixture({ redirect });
    const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
    assert.equal(board.reasonCode, 'invalid_source'); assert.equal(board.items.length, 0);
    assert.equal(p.calls.filter(call => call.route === '/close').length, 1);
  }
});

test('missing classic topics remain empty with bounded loading time and a frozen-clock cap', async () => {
  for (const frozen of [false, true]) {
    const p = fixture({ page: '创作服务平台\n笔记灵感\n经典话题\n正在加载', frozen });
    const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
    assert.equal(board.status, 'unavailable'); assert.equal(board.reasonCode, 'board_not_loaded'); assert.equal(board.items.length, 0);
    assert.ok(p.calls.filter(call => call.route === '/eval').length <= 60);
    assert.ok(p.sleeps.reduce((a, b) => a + b, 0) <= 23200);
  }
});

test('six observed category controls collect five genuine topics each and wait for the active content to change', async () => {
  const categories = ['美食', '美妆', '时尚', '出行', '知识', '兴趣爱好'].map(name => ({ name, page: '经典话题\n' + Array.from({ length: 10 }, (_, index) => name + '话题 ' + index + '\n1万人参与 · 2亿次浏览').join('\n') }));
  const p = fixture({ categories, staleAfterClick: true });
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
  assert.equal(board.kind, 'topics'); assert.equal(board.items.length, 30); assert.match(board.scope, /6个分类/);
  for (const category of categories) assert.equal(board.items.filter(item => item.title.startsWith(category.name)).length, 5);
  assert.equal(p.calls.filter(call => call.route === '/click').length, 5);
  assert.ok(board.items.every(item => !Object.hasOwn(item, 'rank')));
});

test('a category whose body never updates retains only the previously verified topics', async () => {
  const categories = ['美食', '知识'].map(name => ({ name, page: '经典话题\n' + name + '话题\n1万人参与 · 2亿次浏览' }));
  const p = fixture({ categories, neverUpdates: true });
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
  assert.equal(board.status, 'partial'); assert.equal(board.items.length, 1); assert.equal(board.items[0].title, '美食话题');
  assert.match(board.scope, /1个分类/); assert.equal(p.calls.filter(call => call.route === '/click').length, 1);
});

test('topic transport cannot pass fabricated URLs, unverified totals, kinds or ranks', async () => {
  const correct = parseXhsClassicTopics(observedText)[0];
  for (const item of [{ ...correct, url: 'https://evil.example/' }, { ...correct, heatText: '今日热搜第一' }]) {
    const p = fixture({ corruptResult: { status: 'partial', kind: 'topics', sourceUrl: source, items: [item] } });
    const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
    assert.equal(board.items.length, 0);
  }
  const p = fixture({ corruptResult: { status: 'partial', kind: 'topics', sourceUrl: source, items: [{ ...correct, rank: 1 }] } });
  const [board] = await fetchTrendBoards({ platformIds: ['xiaohongshu'] }, {}, p.fetcher, p.timing);
  assert.equal(board.items.length, 1); assert.equal(Object.hasOwn(board.items[0], 'rank'), false);
});
