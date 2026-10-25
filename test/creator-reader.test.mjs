import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { normalizeCreatorInput, readCreatorFeed } from '../app/creator-reader.mjs';
import { creatorExtractScript, creatorSearchScript } from '../app/xhs-creator-extract.mjs';

const A = '0123456789abcdef01234567', B = '1123456789abcdef01234567';
const profileUrl = id => `https://www.xiaohongshu.com/user/profile/${id}`;
const note = (index, extra = {}) => ({ id: index.toString(16).padStart(24, '0'), url: `${profileUrl(A)}/${index.toString(16).padStart(24, '0')}?xsec_token=fixture-${index}`, title: `笔记${index}`, pinned: false, ...extra });
const profile = (id = A, handle = 'HumanPatch') => ({ id, profileUrl: profileUrl(id), name: '示例账号', handle });
const page = (notes = [], extra = {}) => ({ status: 'ready', profile: profile(), resolvedUrl: profileUrl(A), notes, scan: { complete: false, limitReached: false }, missing: [], ...extra });
const json = value => new Response(JSON.stringify(value));
function proxy({ frames = [page([note(1)])], candidates = [], profiles = {}, redirect, evalResult, errorOn, infoSequence = [] } = {}) {
  const calls = []; let current = '', frame = 0, infoIndex = 0;
  const fetcher = async (address, init = {}) => {
    const url = new URL(address); calls.push({ url, init });
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '3456');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (errorOn?.(url, init)) throw new Error('fixture secret must not be exposed');
    if (url.pathname === '/new') { current = url.searchParams.get('url'); return json({ targetId: 'OWN-CREATOR-TAB' }); }
    assert.equal(url.searchParams.get('target'), 'OWN-CREATOR-TAB');
    if (url.pathname === '/close') return json({ success: true });
    if (url.pathname === '/info') return json(infoSequence[infoIndex++] || { url: redirect || current, ready: 'complete', title: 'fixture' });
    if (url.pathname === '/navigate') { current = url.searchParams.get('url'); return json({ frameId: 'OWN-CREATOR-TAB' }); }
    if (url.pathname === '/scroll') { frame++; return json({ success: true }); }
    if (url.pathname === '/eval') {
      if (evalResult) return json({ value: evalResult(current, init.body) });
      if (new URL(current).pathname === '/search_result') return json({ value: { status: 'ready', candidates, resolvedUrl: current, missing: [] } });
      const id = new URL(current).pathname.split('/').at(-1);
      return json({ value: profiles[id] || frames[Math.min(frame, frames.length - 1)] });
    }
    assert.fail(`unexpected proxy route ${url.pathname}`);
  };
  return { fetcher, calls, closed: () => calls.filter(call => call.url.pathname === '/close').length };
}

test('normalization accepts canonical profile paths or handles without inventing an ID', () => {
  assert.deepEqual(normalizeCreatorInput({ profileUrl: profileUrl(A) + '?xsec_token=fixture' }), { profileUrl: profileUrl(A) + '?xsec_token=fixture', id: A, handle: '' });
  for (const handle of ['HumanPatch', '@HumanPatch', '小红书号：HumanPatch']) {
    assert.deepEqual(normalizeCreatorInput({ handle }), { profileUrl: '', id: '', handle: 'HumanPatch' });
  }
  assert.deepEqual(normalizeCreatorInput({ handle: A }), { profileUrl: '', id: '', handle: A });
});

test('invalid inputs and nonlocal proxy addresses fail without network calls', async () => {
  for (const input of [{}, { profileUrl: 'https://evil.example/user/profile/' + A }, { profileUrl: 'http://www.xiaohongshu.com/user/profile/' + A },
    { profileUrl: 'https://user@www.xiaohongshu.com/user/profile/' + A }, { profileUrl: profileUrl(A) + '/' + B }, { handle: 'not a handle' }, { handle: 'name\n' }]) {
    assert.throws(() => normalizeCreatorInput(input));
  }
  let calls = 0;
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, { REDPILOT_READER_PROXY_URL: 'https://remote.example' }, async () => { calls++; });
  assert.equal(result.status, 'unavailable'); assert.equal(calls, 0);
});

test('profile reading merges every loaded note by ID across three bounded scrolls and preserves actual token links', async () => {
  const pinned = note(1, { pinned: true });
  const p = proxy({ frames: [page([pinned, note(2)]), page([pinned, note(2), note(3)]), page([pinned, note(4)]), page([note(5), note(1, { url: 'https://www.xiaohongshu.com/explore/' + pinned.id })])] });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.notes.map(item => item.id), [1, 2, 3, 4, 5].map(index => note(index).id));
  assert.equal(result.notes[0].url, pinned.url);
  assert.equal(result.notes[0].pinned, true);
  assert.deepEqual(result.scan, { complete: false, limitReached: false });
  assert.ok(result.missing.includes('仅扫描主页当前加载的近期窗口，未覆盖全部历史'));
  assert.equal(p.calls.filter(call => call.url.pathname === '/scroll').length, 3);
  assert.equal(p.closed(), 1);
});

test('fifty notes stop further scrolling and the scan never claims complete historical coverage', async () => {
  const p = proxy({ frames: [page(Array.from({ length: 60 }, (_, index) => note(index + 1)), { scan: { complete: true, limitReached: true } })] });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
  assert.equal(result.notes.length, 50); assert.equal(result.scan.limitReached, true); assert.equal(result.scan.complete, false);
  assert.equal(p.calls.filter(call => call.url.pathname === '/scroll').length, 0); assert.equal(p.closed(), 1);
});

test('handle lookup uses normal user search and confirms the exact visible handle on a candidate profile', async () => {
  const p = proxy({ candidates: [
    { id: B, profileUrl: profileUrl(B), name: 'Human Patch', handle: '293323067' },
    { id: A, profileUrl: profileUrl(A) + '?xsec_token=profile-fixture', name: '示例账号', handle: 'humanpatch' }
  ], profiles: { [A]: page([note(1)]) } });
  const result = await readCreatorFeed({ handle: 'HumanPatch' }, {}, p.fetcher);
  assert.equal(result.status, 'ready'); assert.equal(result.profile.id, A); assert.equal(result.profile.profileUrl, profileUrl(A));
  const start = new URL(p.calls.find(call => call.url.pathname === '/new').url.searchParams.get('url'));
  assert.equal(start.pathname, '/search_result'); assert.equal(start.searchParams.get('keyword'), 'HumanPatch');
  assert.ok(p.calls.some(call => call.url.pathname === '/eval' && call.init.body.includes('creatorSearch')));
  const navigations = p.calls.filter(call => call.url.pathname === '/navigate');
  assert.equal(navigations.length, 1); assert.equal(navigations[0].url.searchParams.get('url'), profileUrl(A) + '?xsec_token=profile-fixture');
  assert.equal(p.closed(), 1);
});

test('a 24-hex-looking handle is still searched rather than used as a fabricated profile ID', async () => {
  const p = proxy({ candidates: [] });
  const result = await readCreatorFeed({ handle: A }, {}, p.fetcher);
  assert.equal(result.status, 'needs_selection');
  const start = new URL(p.calls[0].url.searchParams.get('url'));
  assert.equal(start.pathname, '/search_result'); assert.equal(start.searchParams.get('keyword'), A);
  assert.equal(result.profile.id, ''); assert.equal(p.closed(), 1);
});

test('ambiguous candidates or a handle mismatch require selection and never select by display name', async () => {
  const exact = [A, B].map(id => ({ id, profileUrl: profileUrl(id), name: '同名账号', handle: 'HumanPatch' }));
  const ambiguous = proxy({ candidates: exact });
  assert.equal((await readCreatorFeed({ handle: 'HumanPatch' }, {}, ambiguous.fetcher)).status, 'needs_selection');
  assert.equal(ambiguous.calls.filter(call => call.url.pathname === '/navigate').length, 0);
  const changed = proxy({ candidates: [exact[0]], profiles: { [A]: page([note(1)], { profile: profile(A, 'AnotherHandle') }) } });
  const result = await readCreatorFeed({ handle: 'HumanPatch' }, {}, changed.fetcher);
  assert.equal(result.status, 'needs_selection'); assert.equal(result.profile.id, ''); assert.deepEqual(result.notes, []);
  assert.equal(changed.closed(), 1);
});

test('unknown search handles inspect no more than four candidate profiles', async () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({ id: (index + 10).toString(16).padStart(24, '0'), name: '相似名称', handle: '', profileUrl: profileUrl((index + 10).toString(16).padStart(24, '0')) }));
  const profiles = Object.fromEntries(candidates.map(candidate => [candidate.id, page([], { profile: profile(candidate.id, 'Different'), resolvedUrl: candidate.profileUrl })]));
  const p = proxy({ candidates, profiles });
  const result = await readCreatorFeed({ handle: 'HumanPatch' }, {}, p.fetcher);
  assert.equal(result.status, 'needs_selection'); assert.equal(p.calls.filter(call => call.url.pathname === '/navigate').length, 4);
  assert.equal(result.candidates.length, 4); assert.equal(p.closed(), 1);
});

test('profile targets and actual evaluated locations are verified before returning any data', async () => {
  const foreign = proxy({ redirect: 'https://evil.example/user/profile/' + A });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, foreign.fetcher);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.notes, []);
  assert.equal(foreign.calls.filter(call => call.url.pathname === '/eval').length, 0); assert.equal(foreign.closed(), 1);
  const raced = proxy({ evalResult: () => page([note(1)], { resolvedUrl: profileUrl(B), profile: profile(B) }) });
  const raceResult = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, raced.fetcher);
  assert.equal(raceResult.status, 'unavailable'); assert.deepEqual(raceResult.notes, []); assert.equal(raced.closed(), 1);
});

test('new-tab blank and loading transitions are awaited without evaluating the pending DOM', async () => {
  const p = proxy({ infoSequence: [{ url: 'about:blank', ready: 'loading' }, { url: 'https://www.xiaohongshu.com/explore', ready: 'complete' }, { url: profileUrl(A), ready: 'loading' }] });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
  assert.equal(result.status, 'ready');
  const firstEval = p.calls.findIndex(call => call.url.pathname === '/eval');
  assert.equal(p.calls.slice(0, firstEval).filter(call => call.url.pathname === '/info').length, 4);
  assert.equal(p.calls.filter(call => call.url.pathname === '/navigate').length, 0);
  assert.equal(p.closed(), 1);
});

test('official login URLs have a login status while wrong accounts and foreign pages are rejected immediately', async () => {
  for (const [redirect, status] of [['https://www.xiaohongshu.com/login?next=fixture', 'needs_login'], [profileUrl(B), 'unavailable'], ['https://evil.example/login', 'unavailable']]) {
    const p = proxy({ redirect });
    const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
    assert.equal(result.status, status);
    assert.equal(p.calls.filter(call => call.url.pathname === '/info').length, 1);
    assert.equal(p.calls.filter(call => call.url.pathname === '/eval').length, 0);
    assert.equal(p.calls.filter(call => call.url.pathname === '/navigate').length, 0);
    assert.equal(p.closed(), 1);
  }
});

test('a tab that remains blank stops after a bounded URL wait and never reads its DOM', async () => {
  const p = proxy({ redirect: 'about:blank' });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
  assert.equal(result.status, 'unavailable');
  assert.ok(result.missing.some(value => value.includes('尚未进入目标')));
  assert.ok(p.calls.filter(call => call.url.pathname === '/info').length <= 11);
  assert.equal(p.calls.filter(call => call.url.pathname === '/eval').length, 0);
  assert.equal(p.closed(), 1);
});

test('URLs from other hosts, other profile owners or mismatched note IDs are never returned', async () => {
  const p = proxy({ frames: [page([
    note(1), note(2, { url: 'https://evil.example/explore/' + note(2).id }),
    note(3, { url: profileUrl(B) + '/' + note(3).id + '?xsec_token=wrong-owner' }),
    note(4, { url: 'https://www.xiaohongshu.com/explore/' + note(5).id })
  ])] });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
  assert.deepEqual(result.notes.map(value => value.id), [note(1).id]); assert.equal(p.closed(), 1);
});

test('login, verification and transport failures preserve clear statuses and always close their own tab', async () => {
  for (const status of ['needs_login', 'blocked']) {
    const p = proxy({ frames: [{ status, profile: null, resolvedUrl: profileUrl(A), missing: ['fixture gate'] }] });
    const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
    assert.equal(result.status, status); assert.equal(p.closed(), 1);
  }
  const p = proxy({ errorOn: url => url.pathname === '/eval' });
  const result = await readCreatorFeed({ profileUrl: profileUrl(A) }, {}, p.fetcher);
  assert.equal(result.status, 'unavailable'); assert.equal(JSON.stringify(result).includes('fixture secret'), false); assert.equal(p.closed(), 1);
});

function domNode({ text = '', maps = {}, href = '', src = '', classes = [], parent = null } = {}) {
  return { innerText: text, href, src, currentSrc: '', parentElement: parent, hidden: false,
    getAttribute: () => null, getClientRects: () => [{}], classList: { contains: value => classes.includes(value) },
    querySelectorAll: selector => maps[selector] || [], querySelector: selector => maps[selector]?.[0] || null,
    closest: selector => selector === 'a.title' ? null : null };
}
test('creator DOM extraction keeps the actual token-bearing card link and a separate pinned marker', () => {
  const visibleName = domNode({ text: '示例账号' }), handle = domNode({ text: '小红书号：HumanPatch' });
  const authorLink = domNode({ href: profileUrl(A) });
  const bare = domNode({ href: 'https://www.xiaohongshu.com/explore/' + note(1).id });
  const cover = domNode({ href: note(1).url }), title = domNode({ text: '一条置顶笔记', href: note(1).url });
  const card = domNode({ maps: { 'a.cover, a.title, a[href]': [bare, cover, title, authorLink], 'a.title': [title], 'span, div': [domNode({ text: '置顶' })] } });
  const duplicate = domNode({ maps: { 'a.cover, a.title, a[href]': [cover], 'a.title': [title], 'span, div': [] } });
  const info = domNode({ maps: { '.user-name': [visibleName], '.user-redId': [handle] } });
  const root = domNode({ maps: { '.user-info': [info], 'section.note-item': [card, duplicate] } });
  const document = { querySelectorAll: selector => selector === '#userPageContainer' ? [root] : [], body: domNode() };
  Object.defineProperty(document, 'cookie', { get() { assert.fail('read cookies'); } });
  const context = { location: { href: profileUrl(A) }, URL, document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  for (const key of ['localStorage', 'sessionStorage', '__INITIAL_STATE__', 'fetch']) Object.defineProperty(context, key, { get() { assert.fail('read ' + key); } });
  const value = JSON.parse(JSON.stringify(runInNewContext(creatorExtractScript(A), context)));
  assert.equal(value.status, 'ready'); assert.equal(value.profile.handle, 'HumanPatch');
  assert.deepEqual(value.notes, [{ id: note(1).id, url: note(1).url, title: '一条置顶笔记', pinned: true }]);
  assert.equal(value.scan.complete, false);
});

test('creator and search expressions reject unsafe locations before accessing DOM', () => {
  for (const [script, href] of [[creatorExtractScript(A), 'https://evil.example/user/profile/' + A], [creatorExtractScript(A), profileUrl(B)],
    [creatorExtractScript(A), 'https://www.xiaohongshu.com:8443/user/profile/' + A], [creatorSearchScript(), 'https://evil.example/search_result']]) {
    const context = { location: { href }, URL };
    Object.defineProperty(context, 'document', { get() { assert.fail('unsafe DOM read'); } });
    Object.defineProperty(context, 'getComputedStyle', { get() { assert.fail('unsafe style read'); } });
    const value = JSON.parse(JSON.stringify(runInNewContext(script, context)));
    assert.equal(value.status, 'unavailable');
  }
});

test('normal user-search DOM expression clicks only the user-results tab before reading candidates', () => {
  let clicked = 0;
  const tab = domNode({ text: '用户', classes: ['channel'] }); tab.click = () => { clicked++; };
  const context = { location: { href: 'https://www.xiaohongshu.com/search_result?keyword=HumanPatch' }, URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), document: { querySelectorAll: selector => selector === '.channel-scroll-container .channel' ? [tab] : assert.fail('read results before choosing user tab') } };
  const value = JSON.parse(JSON.stringify(runInNewContext(creatorSearchScript(), context)));
  assert.equal(value.status, 'loading'); assert.equal(clicked, 1);
});
