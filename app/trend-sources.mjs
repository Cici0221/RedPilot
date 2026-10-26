import { setTimeout as delay } from 'node:timers/promises';
import { InputError } from './content.mjs';

export const TREND_PLATFORMS = Object.freeze([
  { id: 'xiaohongshu', name: '小红书', boardName: '热门搜索', url: 'https://www.xiaohongshu.com/explore' },
  { id: 'douyin', name: '抖音', boardName: '抖音热榜', url: 'https://www.douyin.com/hot' },
  { id: 'bilibili', name: 'B站', boardName: '综合排行榜', url: 'https://www.bilibili.com/v/popular/rank/all' },
  { id: 'weibo', name: '微博', boardName: '微博热搜', url: 'https://s.weibo.com/top/summary?cate=realtimehot' },
  { id: 'zhihu', name: '知乎', boardName: '知乎热榜', url: 'https://www.zhihu.com/hot' },
  { id: 'baidu', name: '百度', boardName: '百度热搜', url: 'https://top.baidu.com/board?tab=realtime' },
  { id: 'toutiao', name: '今日头条', boardName: '头条热榜', url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc' }
].map(Object.freeze));
const DOMAINS = Object.freeze({ xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'], douyin: ['douyin.com'],
  bilibili: ['bilibili.com', 'b23.tv'], weibo: ['weibo.com', 'weibo.cn'], zhihu: ['zhihu.com'], baidu: ['baidu.com'], toutiao: ['toutiao.com'] });
const BY_ID = new Map(TREND_PLATFORMS.map(platform => [platform.id, platform]));
const LIMIT = 2 * 1024 * 1024;
const BILI_API = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
const XHS_CLASSIC_TOPICS = 'https://creator.xiaohongshu.com/new/inspiration';
const STATUSES = new Set(['ready', 'partial', 'needs_login', 'blocked', 'unavailable']);
const TREND_FAILURES = Object.freeze({
  needs_login: '官方榜单需要登录后读取，请在 Chrome 登录后刷新',
  verification_required: '官方页面要求安全验证或暂时阻止访问，请完成验证后刷新',
  browser_unavailable: '浏览器读取服务暂时不可用，请连接 Chrome 后重试',
  network_error: '官方来源网络请求失败，请稍后刷新',
  invalid_source: '来源不是该平台的官方页面，已停止读取',
  board_not_exposed: '当前页面未读取到带排名和链接的热榜，请稍后刷新',
  board_not_loaded: '官方热榜尚未加载完成，请稍后刷新',
  source_unavailable: '官方榜单暂时无法读取，请稍后刷新',
  response_too_large: '官方来源响应超过2MB限制，已停止读取',
  invalid_response: '官方来源未返回可识别的榜单数据'
});
const LEGACY_FAILURES = new Map([
  ['官方榜单需要登录后读取', 'needs_login'], ['官方来源需要登录或访客验证', 'needs_login'], ['该平台需要登录', 'needs_login'],
  ['官方页面要求验证或暂时阻止访问', 'verification_required'], ['该平台暂时限制访问', 'verification_required'],
  ['本地浏览器读取桥地址配置不正确', 'browser_unavailable'], ['本地浏览器读取桥暂时不可用', 'browser_unavailable'],
  ['本地浏览器读取桥未返回有效结果', 'browser_unavailable'], ['浏览器未能建立自己的榜单标签', 'browser_unavailable'],
  ['来源跳转到了非本平台官方页面，已停止读取', 'invalid_source'], ['榜单跳转到了非本平台官方页面，已停止读取', 'invalid_source'],
  ['来源跳转到了非本平台官方页面，未读取内容', 'invalid_source'],
  ['当前官方页面未提供可验证的热门榜单，未用推荐流代替', 'board_not_exposed'],
  ['官方页面尚未提供可读取的榜单内容', 'board_not_loaded'],
  ['官方榜单暂时无法读取，请稍后刷新', 'source_unavailable'],
  ['官方来源响应超过2MB限制', 'response_too_large'],
  ['官方来源未返回可识别的榜单数据', 'invalid_response'], ['官方来源没有返回可读取内容', 'invalid_response'],
  ['官方页面未返回有效榜单结果', 'invalid_response'], ['官方页面未提供可验证的排名与条目链接', 'invalid_response']
]);
for (const [code, error] of Object.entries(TREND_FAILURES)) LEGACY_FAILURES.set(error, code);
export function safeTrendFailure(value, status = 'unavailable') {
  let code, oldText;
  if (typeof value === 'string') { code = value; oldText = value; }
  else if (value && typeof value === 'object') { code = value.reasonCode; oldText = value.error; }
  if (typeof code === 'string' && Object.hasOwn(TREND_FAILURES, code)) return { reasonCode: code, error: TREND_FAILURES[code] };
  if (code === undefined && typeof oldText === 'string') code = LEGACY_FAILURES.get(oldText);
  else if (typeof value === 'string' && !Object.hasOwn(TREND_FAILURES, value)) code = LEGACY_FAILURES.get(value);
  if (!code && (value == null || typeof value === 'object' && value.reasonCode === undefined)) code = status === 'needs_login' ? 'needs_login' : status === 'blocked' ? 'verification_required' : undefined;
  if (typeof code !== 'string' || !Object.hasOwn(TREND_FAILURES, code)) code = 'source_unavailable';
  return { reasonCode: code, error: TREND_FAILURES[code] };
}

export function isOfficialTrendUrl(platformId, value) {
  try {
    const url = new URL(value), domains = DOMAINS[platformId];
    return Boolean(domains && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)));
  } catch { return false; }
}
class SourceError extends Error {
  constructor(status, reasonCode) { const failure = safeTrendFailure(reasonCode, status); super(failure.error); this.status = status; this.reasonCode = failure.reasonCode; }
}
async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel().catch(() => {}); throw new SourceError('unavailable', 'response_too_large'); }
  const reader = response.body?.getReader(); if (!reader) throw new SourceError('unavailable', 'invalid_response');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel().catch(() => {}); throw new SourceError('unavailable', 'response_too_large'); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('unavailable', 'network_error'); }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}
async function officialFetch(platformId, initial, fetcher) {
  let address = initial;
  for (let step = 0; step < 3; step++) {
    if (!isOfficialTrendUrl(platformId, address)) throw new SourceError('unavailable', 'invalid_source');
    let response;
    try { response = await fetcher(address, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json,text/html;q=0.9' } }); }
    catch { throw new SourceError('unavailable', 'network_error'); }
    if (response.url && !isOfficialTrendUrl(platformId, response.url)) { await response.body?.cancel().catch(() => {}); throw new SourceError('unavailable', 'invalid_source'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
      if (!location) throw new SourceError('unavailable', 'invalid_response');
      try { address = new URL(location, address).href; } catch { throw new SourceError('unavailable', 'invalid_source'); }
      if (!isOfficialTrendUrl(platformId, address)) throw new SourceError('unavailable', 'invalid_source');
      if (/\/(?:signin|login|visitor|passport)(?:\/|$)/i.test(new URL(address).pathname)) throw new SourceError('needs_login', 'needs_login');
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status === 401 ? 'needs_login' : [403, 412, 429].includes(response.status) ? 'blocked' : 'unavailable';
      throw new SourceError(status, status === 'needs_login' ? 'needs_login' : status === 'blocked' ? 'verification_required' : 'source_unavailable');
    }
    return { text: await boundedText(response), url: response.url || address };
  }
  throw new SourceError('unavailable', 'source_unavailable');
}
function decodeHtml(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = /^&#x/i.test(entity), code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
const htmlText = html => decodeHtml(String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (html, name) => decodeHtml(html.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '');
function classText(html, prefix) {
  const match = html.match(new RegExp(`<([a-z][a-z\\d]*)\\b[^>]*class=["'](?:[^"']*\\s)?${prefix}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
  return match ? htmlText(match[2]) : '';
}
function sanitizeItems(platformId, input) {
  const ranks = new Set(), links = new Set(), result = [];
  for (const item of Array.isArray(input) ? input : []) {
    const title = typeof item.title === 'string' ? item.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
    if (!title || !Number.isInteger(item.rank) || item.rank < 1 || !isOfficialTrendUrl(platformId, item.url) || ranks.has(item.rank) || links.has(item.url)) continue;
    ranks.add(item.rank); links.add(item.url);
    result.push({ ...(typeof item.id === 'string' && item.id ? { id: item.id.slice(0, 160) } : {}), title, url: new URL(item.url).href, rank: item.rank,
      ...(typeof item.heatText === 'string' && item.heatText.trim() ? { heatText: item.heatText.trim().slice(0, 120) } : {}) });
    if (result.length >= 30) break;
  }
  return result.sort((a, b) => a.rank - b.rank);
}
function parseBaidu(html) {
  // Parse visible server-rendered rows only; script/hydration contents are excluded.
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  return visible.split(/<div\b[^>]*class=["'][^"']*\bcategory-wrap[^"']*["'][^>]*>/i).slice(1).map(row => {
    const rankText = classText(row, 'index_');
    const anchor = Array.from(row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).find(match => /(?:^|\s)title_/.test(attr(match[1], 'class')));
    if (!/^\d+$/.test(rankText) || !anchor) return null; // Unnumbered pinned stories are not rank 1.
    return { title: classText(anchor[2], 'c-single-text-ellipsis') || htmlText(anchor[2]), url: attr(anchor[1], 'href'), rank: Number(rankText), heatText: classText(row, 'hot-index_') };
  }).filter(Boolean);
}
function parseWeibo(html) {
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return Array.from(visible.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).map(match => {
    const row = match[1], rankText = classText(row, 'td-01');
    const cell = row.match(/<td\b[^>]*class=["'][^"']*\btd-02\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || '';
    const anchor = cell.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!/^\d+$/.test(rankText) || !anchor || !attr(anchor[1], 'href')) return null;
    return { rank: Number(rankText), title: htmlText(anchor[2]), url: new URL(attr(anchor[1], 'href'), 'https://s.weibo.com/').href,
      heatText: Array.from(cell.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)).map(value => htmlText(value[1])).join(' ') };
  }).filter(Boolean);
}
async function staticBoard(platform, fetcher) {
  const api = platform.id === 'bilibili' ? BILI_API : platform.url;
  if (!['baidu', 'toutiao', 'bilibili', 'weibo'].includes(platform.id)) return null;
  const response = await officialFetch(platform.id, api, fetcher); let items;
  if (platform.id === 'baidu') items = parseBaidu(response.text);
  else if (platform.id === 'weibo') items = parseWeibo(response.text);
  else {
    let value; try { value = JSON.parse(response.text); } catch { throw new SourceError('unavailable', 'invalid_response'); }
    if (platform.id === 'toutiao') {
      if (value?.status !== 'success' || !Array.isArray(value.data)) throw new SourceError('unavailable', 'source_unavailable');
      items = value.data.map((item, index) => ({ id: item.ClusterIdStr, title: item.Title, url: item.Url, rank: index + 1, heatText: typeof item.HotValue === 'string' ? item.HotValue : String(item.HotValue ?? '') }));
    } else {
      if (value?.code !== 0 || !Array.isArray(value?.data?.list)) { const blocked = [-352, -412].includes(value?.code); throw new SourceError(blocked ? 'blocked' : 'unavailable', blocked ? 'verification_required' : 'source_unavailable'); }
      items = value.data.list.map((item, index) => ({ id: item.bvid, title: item.title, url: item.short_link_v2 || item.uri || item.short_link, rank: index + 1 }));
    }
  }
  const valid = sanitizeItems(platform.id, items);
  if (!valid.length) throw new SourceError('unavailable', 'invalid_response');
  return { status: 'ready', sourceUrl: response.url, items: valid, scope: '官方公开榜单前30条；排名来自页面数字序号或官方接口数组顺序，不含无序号置顶及广告' };
}

function browserBoard(platformId, domains) {
  const result = { status: 'unavailable', items: [], sourceUrl: String(location.href || ''), scope: '仅当前官方页面DOM可读取的榜单窗口，最多30条，不代表全量榜单' };
  let url; try { url = new URL(result.sourceUrl); } catch {}
  const official = address => {
    if (typeof address !== 'string' || !address.trim()) return false;
    try { const link = new URL(address, result.sourceUrl); return link.protocol === 'https:' && !link.username && !link.password && (!link.port || link.port === '443') && domains.some(domain => link.hostname === domain || link.hostname.endsWith('.' + domain)); } catch { return false; }
  };
  if (!url || !official(url.href)) { result.reasonCode = 'invalid_source'; return result; }
  if (/\/(?:signin|login|visitor|passport)(?:\/|$)/i.test(url.pathname)) { result.status = 'needs_login'; result.reasonCode = 'needs_login'; return result; }
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const text = node => String(node?.innerText || '').replace(/\s+/g, ' ').trim();
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  const add = (title, href, rank, heatText = '') => { if (title && official(href) && Number.isInteger(rank) && rank > 0) result.items.push({ title, url: new URL(href, result.sourceUrl).href, rank, ...(heatText ? { heatText } : {}) }); };
  let labelledBoard = false;
  if (platformId === 'bilibili' && /^\/v\/popular\/rank\/all\/?$/.test(url.pathname)) {
    for (const row of all(document, '.rank-list .rank-item').filter(visible)) { const anchor = row.querySelector('a.title'); add(text(anchor), anchor?.href, Number(text(row.querySelector('.num')))); }
  } else if (platformId === 'weibo' && url.hostname === 's.weibo.com' && url.pathname === '/top/summary') {
    for (const row of all(document, '#pl_top_realtimehot table tbody tr, table tbody tr').filter(visible)) { const anchor = row.querySelector('.td-02 a'); add(text(anchor), anchor?.href, Number(text(row.querySelector('.td-01'))), all(row, '.td-02 span').map(text).join(' ')); }
  } else if (platformId === 'zhihu' && url.pathname === '/hot') {
    for (const row of all(document, '.HotItem').filter(visible)) { const anchor = row.querySelector('.HotItem-content a, a.HotItem-content, a[href]'); add(text(row.querySelector('.HotItem-title')), anchor?.href, Number(text(row.querySelector('.HotItem-rank, .HotItem-index'))), text(row.querySelector('.HotItem-metrics'))); }
  } else if (platformId === 'baidu' && url.pathname === '/board') {
    for (const row of all(document, '[class*="category-wrap"]').filter(visible)) { const anchor = row.querySelector('a[class*="title_"]'); add(text(anchor?.querySelector('.c-single-text-ellipsis')), anchor?.href, Number(text(row.querySelector('[class^="index_"], [class*=" index_"]'))), text(row.querySelector('[class*="hot-index_"]'))); }
  } else if (platformId === 'toutiao' && url.pathname === '/hot-event/hot-board/') {
    try { const value = JSON.parse(document.body?.innerText || ''); if (value.status === 'success' && Array.isArray(value.data)) for (const [index, item] of value.data.entries()) add(item.Title, item.Url, index + 1, String(item.HotValue || '')); } catch {}
  } else if (platformId === 'douyin' && /^\/hot\/?$/.test(url.pathname)) {
    // The current official board has a separate heading and a ranked list.
    // Top-three places are SVG badges; the pinned up.svg is not rank 1.
    for (const board of all(document, '[data-e2e="feed-right-list-container"]').filter(visible)) {
      if (!/^抖音热榜$/.test(text(board.querySelector('h1')))) continue;
      labelledBoard = true;
      for (const row of all(board, 'li').filter(visible)) {
        const anchor = row.querySelector('a[href]'), rankNode = row.querySelector('.listStyle');
        let rank = /^\d+$/.test(text(rankNode)) ? Number(text(rankNode)) : NaN;
        const badge = rankNode?.querySelector('img');
        if (badge) {
          try {
            const image = new URL(badge.src, result.sourceUrl), match = image.pathname.match(/\/hot_top([123])\.svg$/);
            if (image.protocol === 'https:' && /(?:^|\.)douyinstatic\.com$/.test(image.hostname) && match) rank = Number(match[1]);
          } catch {}
        }
        const heat = text(row).match(/(\d+(?:\.\d+)?(?:万|亿)?)\s*热度/);
        add(text(anchor?.querySelector('h3')) || text(anchor), anchor?.href, rank, heat ? heat[1] + '热度' : '');
      }
    }
  }
  if (!result.items.length && (platformId === 'xiaohongshu' || platformId === 'douyin')) {
    // Require an explicitly labelled ranking widget. Recommendation cards and
    // view/like counts are never substituted for an official hot-search board.
    const heading = platformId === 'douyin' ? /抖音热榜|热点榜/ : /热门搜索|热搜榜|搜索发现/;
    for (const board of all(document, '[data-e2e="hotboard"], [data-e2e="hot-board"], .hot-search-list, .hot-list')) {
      if (!visible(board) || !heading.test(text(board)) && !all(board.parentElement, 'h1, h2, h3, [role="heading"]').some(node => visible(node) && heading.test(text(node)))) continue;
      labelledBoard = true;
      for (const anchor of all(board, 'a[href]').filter(visible)) {
        const row = anchor.closest('li') || anchor.parentElement, rank = Number(text(row?.querySelector('.rank, .index, [data-e2e="rank"]')));
        add(text(anchor), anchor.href, rank);
      }
    }
  }
  if (result.items.length) { result.status = 'partial'; result.items = result.items.slice(0, 30); return result; }
  const page = text(document.body).slice(0, 40000);
  if (/安全验证|访问过于频繁|操作过于频繁|验证后继续|请完成验证|访问异常|请求异常/.test(page)) { result.status = 'blocked'; result.reasonCode = 'verification_required'; }
  else if (all(document, '.login-modal, .login-container, .SignFlow, .LoginModal, [role="dialog"]').some(node => visible(node) && /登录|登入/.test(text(node))) ||
    platformId === 'xiaohongshu' && all(document, '#search-input').some(node => visible(node) && /登录/.test(node.placeholder || ''))) { result.status = 'needs_login'; result.reasonCode = 'needs_login'; }
  else if (platformId === 'xiaohongshu' && !labelledBoard && all(document, '#search-input').some(node => visible(node) && !node.value && document.activeElement !== node)) { result.reasonCode = 'board_not_loaded'; result.action = 'open_search'; }
  else if (labelledBoard || !page || document.readyState && document.readyState !== 'complete' || /正在加载|加载中|榜单加载/.test(page)) result.reasonCode = 'board_not_loaded';
  else result.reasonCode = ['xiaohongshu', 'douyin'].includes(platformId) ? 'board_not_exposed' : 'board_not_loaded';
  return result;
}

// Observed in the official creator centre: each classic-topic title is followed
// by its participation / view totals. Example-note titles and likes follow later.
// These are evergreen topics, not a numbered or real-time hot-search ranking.
export function parseXhsClassicTopics(page) {
  if (typeof page !== 'string') return [];
  const lines = page.slice(0, 80000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const start = lines.findIndex(line => /^经典话题(?:\s|$)/.test(line));
  if (start < 0) return [];
  const metrics = /^\d+(?:\.\d+)?(?:万|亿)?人参与\s*[·•]\s*\d+(?:\.\d+)?(?:万|亿)?次浏览$/;
  const skip = /^(?:经典话题|美食|美妆|时尚|出行|知识|兴趣爱好|加载中|正在加载|暂无数据|\d+(?:\.\d+)?(?:万|亿)?)$/;
  const seen = new Set(), items = [];
  for (let index = start + 2; index < lines.length; index++) {
    if (!metrics.test(lines[index])) continue;
    const title = lines[index - 1];
    if (!title || title.length > 200 || skip.test(title) || /人参与|次浏览/.test(title) || seen.has(title)) continue;
    seen.add(title);
    items.push({ title, url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(title), heatText: lines[index] });
    if (items.length === 30) break;
  }
  return items;
}
function browserClassicTopics(parseVisibleText) {
  const source = 'https://creator.xiaohongshu.com/new/inspiration';
  const result = { status: 'unavailable', kind: 'topics', boardName: '经典话题', items: [], sourceUrl: String(location.href || '') };
  let url; try { url = new URL(result.sourceUrl); } catch {}
  if (!url || url.protocol !== 'https:' || url.hostname !== 'creator.xiaohongshu.com' || url.username || url.password || url.port && url.port !== '443') { result.reasonCode = 'invalid_source'; return result; }
  if (/^\/(?:login|signin|passport)(?:\/|$)/.test(url.pathname)) { result.status = 'needs_login'; result.reasonCode = 'needs_login'; return result; }
  if (url.pathname !== '/new/inspiration') { result.reasonCode = 'invalid_source'; return result; }
  result.sourceUrl = source;
  const page = String(document.body?.innerText || '').slice(0, 80000);
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  if (/安全验证|访问过于频繁|操作过于频繁|验证后继续|请完成验证|访问异常|请求异常/.test(page)) { result.status = 'blocked'; result.reasonCode = 'verification_required'; return result; }
  if (Array.from(document.querySelectorAll('.login-modal, .login-container, [role="dialog"]')).some(node => visible(node) && /登录|登入/.test(node.innerText || ''))) { result.status = 'needs_login'; result.reasonCode = 'needs_login'; return result; }
  const container = document.querySelector('.classic-topics-container');
  if (!visible(container)) { result.reasonCode = 'board_not_loaded'; return result; }
  const heading = container.querySelector('.title-container');
  if (!visible(heading) || !/^经典话题(?:\s|$)/.test(String(heading.innerText || '').trim())) { result.reasonCode = 'board_not_loaded'; return result; }
  const categories = ['美食', '美妆', '时尚', '出行', '知识', '兴趣爱好'];
  result.categories = Array.from(container.querySelectorAll('.d-tabs-headers > .d-tabs-header')).map((node, index) => ({ name: String(node.querySelector('h6.d-tabs-header-label')?.innerText || '').trim(), index: index + 1, active: node.classList.contains('active'), visible: visible(node) })).filter(item => item.visible && categories.includes(item.name) && item.index <= 6).map(({ visible, ...item }) => item);
  result.category = result.categories.find(item => item.active)?.name || '';
  const cards = Array.from(container.querySelectorAll('.d-tabs-pane .panle-box > div > .panel-container')).filter(visible);
  result.items = cards.flatMap(card => {
    const title = card.querySelector(':scope > span.title'), metrics = card.querySelector(':scope > .notes-desc > .notes-num');
    if (!visible(title) || !visible(metrics)) return [];
    return parseVisibleText('经典话题\n' + String(title.innerText || '').trim() + '\n' + String(metrics.innerText || '').replace(/\s+/g, ' ').trim());
  }).slice(0, 30);
  if (result.items.length) { result.status = 'partial'; result.scope = '官方创作中心当前分类的经典话题；参与和浏览量为累计值，未提供实时名次；条目链接为站内关键词搜索'; }
  else result.reasonCode = 'board_not_loaded';
  return result;
}

function sanitizeClassicTopics(input) {
  const items = [], seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    const title = typeof item?.title === 'string' ? item.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!title || title.length > 200 || seen.has(title) || typeof item.heatText !== 'string' || !/^\d+(?:\.\d+)?(?:万|亿)?人参与\s*[·•]\s*\d+(?:\.\d+)?(?:万|亿)?次浏览$/.test(item.heatText.trim())) continue;
    // The DOM has no detail href. A search link is generated deliberately, never
    // represented as an extracted topic-detail URL or a source ranking.
    const url = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(title);
    if (item.url !== url) continue;
    seen.add(title); items.push({ title, url, heatText: item.heatText.trim() });
    if (items.length === 30) break;
  }
  return items;
}
function proxyBase(env) {
  let url; try { url = new URL(env.REDPILOT_READER_PROXY_URL || 'http://127.0.0.1:3456'); } catch {}
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new SourceError('unavailable', 'browser_unavailable');
  return url.origin;
}
async function proxyCall(fetcher, base, route, script, timeoutMs) {
  let response;
  try { response = await fetcher(base + route, { method: script ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs ?? (route.startsWith('/close?') ? 5000 : 20000)),
    ...(script ? { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: script } : {}) }); }
  catch { throw new SourceError('unavailable', 'browser_unavailable'); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new SourceError('unavailable', 'browser_unavailable'); }
  let value; try { value = JSON.parse(await boundedText(response)); } catch (error) { if (error instanceof SourceError && error.reasonCode === 'response_too_large') throw error; throw new SourceError('unavailable', 'browser_unavailable'); }
  if (!value || typeof value !== 'object' || value.error) throw new SourceError('unavailable', 'browser_unavailable');
  return value;
}
async function chromeBoard(platform, env, fetcher, browser, timing) {
  const topics = platform.kind === 'topics';
  const topicMetadata = topics ? { kind: 'topics', boardName: '经典话题', sourceUrl: XHS_CLASSIC_TOPICS } : {};
  browser.base ||= proxyBase(env);
  if (!browser.target) {
    const created = await proxyCall(fetcher, browser.base, '/new?url=' + encodeURIComponent(platform.url));
    browser.target = created.targetId;
    if (typeof browser.target !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(browser.target)) throw new SourceError('unavailable', 'browser_unavailable');
  } else await proxyCall(fetcher, browser.base, '/navigate?target=' + encodeURIComponent(browser.target) + '&url=' + encodeURIComponent(platform.url));
  const deadline = timing.clock() + (topics ? 15000 : 8000);
  const attemptLimit = topics ? 38 : 20;
  const remaining = () => Math.max(0, Math.ceil(deadline - timing.clock()));
  const step = async (route, script) => {
    const budget = remaining(); if (budget <= 0) throw new SourceError('unavailable', 'board_not_loaded');
    try { return await proxyCall(fetcher, browser.base, route, script, budget); }
    catch (error) { if (remaining() <= 0) throw new SourceError('unavailable', 'board_not_loaded'); throw error; }
  };
  const waitAgain = async attempt => {
    const budget = remaining(); if (attempt >= attemptLimit || budget <= 0) return false;
    await timing.sleep(Math.min(400, budget)); return true;
  };
  let result, searchOpened = false, topicSelection = null;
  const collectedTopics = [], collectedCategories = new Set();
  const topicResult = items => ({ status: 'partial', kind: 'topics', boardName: '经典话题', sourceUrl: XHS_CLASSIC_TOPICS, items,
    scope: `官方创作中心经典话题${collectedCategories.size ? '，已读取' + collectedCategories.size + '个分类（每类最多5条）' : '当前分类'}；参与和浏览量为累计值，未提供实时名次；条目链接为站内关键词搜索` });
  // DOM hydration may finish after document.readyState. Both the deadline and
  // attempt cap bound retries; login and verification are never retried away.
  for (let attempt = 0; attempt <= attemptLimit && remaining() > 0; attempt++) {
    const info = await step('/info?target=' + encodeURIComponent(browser.target));
    if (info.url && info.url !== 'about:blank' && !isOfficialTrendUrl(platform.id, info.url)) throw new SourceError('unavailable', 'invalid_source');
    if (!info.url || info.url === 'about:blank' || info.ready === 'loading') { if (await waitAgain(attempt)) continue; break; }
    if (!isOfficialTrendUrl(platform.id, info.url)) throw new SourceError('unavailable', 'invalid_source');
    if (topics && info.url === BY_ID.get('xiaohongshu').url) { if (await waitAgain(attempt)) continue; break; }
    const expression = topics ? `(${browserClassicTopics.toString()})(${parseXhsClassicTopics.toString()})` : `(${browserBoard.toString()})(${JSON.stringify(platform.id)},${JSON.stringify(DOMAINS[platform.id])})`;
    result = (await step('/eval?target=' + encodeURIComponent(browser.target), expression)).value;
    if (!result || typeof result !== 'object') throw new SourceError('unavailable', 'invalid_response');
    if (!isOfficialTrendUrl(platform.id, result.sourceUrl)) throw new SourceError('unavailable', 'invalid_source');
    if (topics && result.sourceUrl !== XHS_CLASSIC_TOPICS && !/^https:\/\/creator\.xiaohongshu\.com\/(?:login|signin|passport)(?:\/|\?|$)/.test(result.sourceUrl)) throw new SourceError('unavailable', 'invalid_source');
    const items = topics ? result.kind === 'topics' && result.sourceUrl === XHS_CLASSIC_TOPICS && ['ready', 'partial'].includes(result.status) ? sanitizeClassicTopics(result.items) : [] : sanitizeItems(platform.id, result.items);
    if (items.length) {
      if (!topics) return { status: 'partial', sourceUrl: result.sourceUrl, items, scope: '仅当前官方页面DOM可读取的榜单窗口，最多30条，不代表全量榜单' };
      const categories = Array.isArray(result.categories) ? result.categories.filter(item => ['美食', '美妆', '时尚', '出行', '知识', '兴趣爱好'].includes(item.name) && Number.isInteger(item.index) && item.index >= 1 && item.index <= 6) : [];
      const signature = JSON.stringify(items.map(item => item.title));
      if (topicSelection && (result.category !== topicSelection.name || signature === topicSelection.previous)) { if (await waitAgain(attempt)) continue; break; }
      if (!categories.some(item => item.name === result.category)) return topicResult(items);
      if (!collectedCategories.has(result.category)) {
        collectedCategories.add(result.category);
        for (const item of items.slice(0, 5)) if (!collectedTopics.some(old => old.url === item.url)) collectedTopics.push(item);
      }
      const next = categories.find(item => !collectedCategories.has(item.name));
      if (!next || collectedTopics.length >= 30) return topicResult(collectedTopics.slice(0, 30));
      topicSelection = { name: next.name, previous: signature };
      await step('/click?target=' + encodeURIComponent(browser.target), '.classic-topics-container .d-tabs-header:nth-child(' + next.index + ')');
      if (await waitAgain(attempt)) continue;
      break;
    }
    if (['needs_login', 'blocked'].includes(result.status)) return { status: result.status, sourceUrl: result.sourceUrl, ...topicMetadata, items: [], ...safeTrendFailure(result.status === 'needs_login' ? 'needs_login' : 'verification_required') };
    const failure = safeTrendFailure(result);
    if (!topics && platform.id === 'xiaohongshu' && result.action === 'open_search' && !searchOpened) {
      await step('/click?target=' + encodeURIComponent(browser.target), '#search-input');
      searchOpened = true;
    }
    if (!['board_not_loaded', 'board_not_exposed'].includes(failure.reasonCode)) return { status: 'unavailable', sourceUrl: result.sourceUrl, ...topicMetadata, items: [], ...failure };
    if (!await waitAgain(attempt)) break;
  }
  if (topics && collectedTopics.length) return topicResult(collectedTopics.slice(0, 30));
  return { status: 'unavailable', sourceUrl: platform.url, ...topicMetadata, items: [], ...safeTrendFailure(result || 'board_not_loaded') };
}

export async function fetchTrendBoards({ platformIds } = {}, env = process.env, fetcher = fetch, { sleep = delay, clock = () => performance.now() } = {}) {
  const ids = platformIds ?? TREND_PLATFORMS.map(platform => platform.id);
  if (!Array.isArray(ids) || ids.length > 7 || ids.some(id => typeof id !== 'string' || !BY_ID.has(id))) throw new InputError('请选择支持的热点平台');
  const boards = [], browser = {};
  try {
    // Sampling is deliberately sequential. Reuse only our own one background tab.
    for (const platformId of [...new Set(ids)]) {
      const platform = BY_ID.get(platformId); let result, failure;
      try { result = await staticBoard(platform, fetcher); } catch (error) { failure = error; }
      if (!result) try { result = await chromeBoard(platform, env, fetcher, browser, { sleep, clock }); } catch (error) { failure = error; }
      if (platformId === 'xiaohongshu' && result?.status === 'unavailable' && ['board_not_exposed', 'board_not_loaded'].includes(result.reasonCode)) {
        try { result = await chromeBoard({ ...platform, url: XHS_CLASSIC_TOPICS, kind: 'topics' }, env, fetcher, browser, { sleep, clock }); }
        catch (error) { const status = error instanceof SourceError && STATUSES.has(error.status) ? error.status : 'unavailable'; result = { status, kind: 'topics', boardName: '经典话题', sourceUrl: XHS_CLASSIC_TOPICS, items: [], ...safeTrendFailure(error, status) }; }
      }
      if (!result) { const status = failure instanceof SourceError && STATUSES.has(failure.status) ? failure.status : 'unavailable'; result = { status, items: [], ...safeTrendFailure(failure, status) }; }
      boards.push({ platformId, name: platform.name, boardName: platform.boardName, sourceUrl: result.sourceUrl || platform.url,
        ...result, fetchedAt: new Date().toISOString() });
    }
    return boards;
  } finally {
    if (browser.base && typeof browser.target === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(browser.target)) await proxyCall(fetcher, browser.base, '/close?target=' + encodeURIComponent(browser.target)).catch(() => {});
  }
}
