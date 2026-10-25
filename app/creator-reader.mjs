import { setTimeout as delay } from 'node:timers/promises';
import { InputError } from './content.mjs';
import { creatorExtractScript, creatorSearchScript } from './xhs-creator-extract.mjs';

const HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const MAX_RESPONSE = 2 * 1024 * 1024;
const WINDOW_NOTE = '仅扫描主页当前加载的近期窗口，未覆盖全部历史';
function pageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') ? url : null;
  } catch { return null; }
}
function profileUrl(value) {
  const url = pageUrl(value), match = url?.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/?$/i);
  return match ? { url: url.href, canonical: `${url.origin}/user/profile/${match[1].toLowerCase()}`, id: match[1].toLowerCase() } : null;
}
export function normalizeCreatorInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('请输入博主主页链接或小红书号');
  let url = '', id = '', handle = '';
  if (input.profileUrl) {
    if (typeof input.profileUrl !== 'string' || input.profileUrl.length > 12000) throw new InputError('博主主页链接不正确');
    const parsed = profileUrl(input.profileUrl.trim());
    if (!parsed) throw new InputError('请输入完整的小红书账号主页链接');
    url = parsed.url; id = parsed.id;
  }
  if (input.handle) {
    if (typeof input.handle !== 'string' || input.handle.length > 120 || /[\u0000-\u001f\u007f]/.test(input.handle)) throw new InputError('小红书号格式不正确');
    handle = input.handle.trim().replace(/^小红书号\s*[:：]\s*/, '').replace(/^@/, '').trim();
    if (!handle || handle.length > 100 || /\s|[\\/?#]/.test(handle)) throw new InputError('请输入完整的小红书号');
  }
  if (!url && !handle) throw new InputError('请输入博主主页链接或小红书号');
  return { profileUrl: url, handle, id };
}
function proxyBase(env) {
  let url; try { url = new URL(env.REDPILOT_READER_PROXY_URL || 'http://127.0.0.1:3456'); } catch {}
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new InputError('本地浏览器读取器地址配置不正确', 409);
  return url.origin;
}
async function proxyCall(fetcher, base, route, script, timeout) {
  const response = await fetcher(base + route, { method: script ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeout || (route.startsWith('/new?') ? 45000 : route.startsWith('/close?') ? 5000 : 20000)),
    ...(script ? { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: script } : {}) });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE) { await response.body?.cancel().catch(() => {}); throw new Error('proxy_unavailable'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('proxy_empty');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw new Error('proxy_limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!data || typeof data !== 'object' || data.error) throw new Error('proxy_invalid');
  return data;
}
const sameHandle = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
function empty(status = 'unavailable', error, missing = []) {
  return { status, profile: { profileUrl: '', id: '', name: '', handle: '' }, notes: [], scan: { complete: false, limitReached: false }, missing, ...(error ? { error } : {}) };
}
function verifiedNotes(notes, expectedId) {
  const result = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    const url = pageUrl(note?.url); if (!url) continue;
    const simple = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i);
    const extended = url.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/([a-f\d]{24})\/?$/i);
    const id = (simple?.[1] || (extended?.[1].toLowerCase() === expectedId ? extended[2] : ''))?.toLowerCase();
    if (!id || id !== note.id?.toLowerCase() || result.has(id)) continue;
    result.set(id, { id, url: url.href, title: typeof note.title === 'string' ? note.title.slice(0, 160) : '', pinned: note.pinned === true });
    if (result.size >= 50) break;
  }
  return Array.from(result.values());
}

// Local Chrome proxy only. Every operation uses a freshly created background
// tab; all reading is DOM-based, and every allocated tab is closed in finally.
export async function readCreatorFeed(input, env = process.env, fetcher = fetch) {
  let normalized, base, target;
  try {
    normalized = normalizeCreatorInput(input); base = proxyBase(env);
    const start = normalized.profileUrl || `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(normalized.handle)}&source=web_user_page`;
    const created = await proxyCall(fetcher, base, '/new?url=' + encodeURIComponent(start));
    target = created.targetId;
    if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(target)) throw new Error('invalid_target');
    const targetQuery = encodeURIComponent(target);
    const awaitLocation = async (id, search) => {
      const deadline = Date.now() + 5000;
      for (let attempt = 0; attempt <= 10; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const info = await proxyCall(fetcher, base, '/info?target=' + targetQuery, undefined, remaining);
        const address = typeof info.url === 'string' ? info.url : '';
        const current = pageUrl(address), identity = profileUrl(address);
        if (current) {
          if (/^\/(?:login|signin|auth)(?:\/|$)/i.test(current.pathname)) return { status: 'needs_login', missing: ['主页或用户搜索需要登录后读取'] };
          if (search ? current.pathname === '/search_result' : identity?.id === id) {
            if (info.ready !== 'loading') return null;
          } else if (current.pathname.startsWith('/user/profile/') || !['/', '/explore', '/search_result'].includes(current.pathname)) {
            return { status: 'unavailable', missing: ['页面跳转到了不同账号或非预期页面，已停止读取'] };
          }
        } else if (address && !['about:blank', 'about:newtab', 'chrome://newtab/'].includes(address)) {
          return { status: 'unavailable', missing: ['页面跳转到了不同账号或非预期页面，已停止读取'] };
        }
        // The newly allocated tab may still be blank or showing the previous
        // official landing/search page. Wait briefly without evaluating its DOM.
        if (attempt < 10 && Date.now() < deadline) await delay(Math.min(500, deadline - Date.now()));
      }
      return { status: 'unavailable', missing: ['页面尚未进入目标主页或用户搜索，请稍后重试'] };
    };
    const read = async (id, search = false) => {
      const pending = await awaitLocation(id, search);
      if (pending) return pending;
      const value = (await proxyCall(fetcher, base, '/eval?target=' + targetQuery, search ? creatorSearchScript() : creatorExtractScript(id))).value;
      if (!value || typeof value !== 'object') throw new Error('empty_result');
      const resolved = search ? pageUrl(value.resolvedUrl) : profileUrl(value.resolvedUrl);
      if (!resolved || (search ? resolved.pathname !== '/search_result' : resolved.id !== id)) return { status: 'unavailable', missing: ['页面跳转到了不同账号或非预期页面，已停止读取'] };
      return value;
    };
    const waitProfile = async id => {
      let value;
      for (let attempt = 0; attempt < 8; attempt++) {
        value = await read(id);
        if (value.profile?.id === id && profileUrl(value.profile.profileUrl)?.id === id && typeof value.profile.name === 'string' && value.profile.name) return value;
        if (['needs_login', 'blocked'].includes(value.status) || !profileUrl(value.resolvedUrl)) return value;
        if (attempt < 7) await delay(300);
      }
      return value;
    };

    let expected = normalized.id, first;
    if (!expected) {
      let search;
      for (let attempt = 0; attempt < 10; attempt++) {
        search = await read('', true);
        if (['ready', 'needs_login', 'blocked', 'unavailable'].includes(search.status)) break;
        if (attempt < 9) await delay(300);
      }
      if (['needs_login', 'blocked', 'unavailable'].includes(search.status)) return empty(search.status, undefined, search.missing || ['用户搜索未完成']);
      const candidates = (Array.isArray(search.candidates) ? search.candidates : []).map(candidate => ({ ...candidate, parsed: profileUrl(candidate.profileUrl) }))
        .filter(candidate => candidate.parsed && candidate.id === candidate.parsed.id).slice(0, 4);
      const visibleExact = candidates.filter(candidate => sameHandle(candidate.handle, normalized.handle));
      const choices = visibleExact.length ? visibleExact : candidates.filter(candidate => !candidate.handle);
      if (visibleExact.length > 1) return { ...empty('needs_selection', undefined, ['多个搜索候选显示相同小红书号，请确认博主主页']), candidates: candidates.map(({ parsed, ...candidate }) => candidate) };
      for (const candidate of choices) {
        await proxyCall(fetcher, base, '/navigate?target=' + targetQuery + '&url=' + encodeURIComponent(candidate.profileUrl));
        const value = await waitProfile(candidate.id);
        if (['needs_login', 'blocked'].includes(value.status)) return empty(value.status, undefined, value.missing || []);
        if (value.profile?.id === candidate.id && sameHandle(value.profile.handle, normalized.handle)) { expected = candidate.id; first = value; break; }
      }
      if (!expected) return { ...empty('needs_selection', undefined, ['未在最多4个用户搜索候选中确认完全匹配的小红书号，请提供博主主页链接']), candidates: candidates.map(({ parsed, ...candidate }) => candidate) };
    }
    first ||= await waitProfile(expected);
    if (!first.profile || first.profile.id !== expected || profileUrl(first.profile.profileUrl)?.id !== expected) return empty(first.status === 'loading' ? 'unavailable' : first.status, undefined, first.missing || ['未确认目标博主主页']);
    if (normalized.handle && !sameHandle(first.profile.handle, normalized.handle)) return empty('needs_selection', undefined, ['主页可见小红书号与填写内容不一致，请确认目标账号']);
    const merged = new Map(); let latest = first, limitReached = false;
    for (let pass = 0; pass < 4; pass++) {
      if (pass) {
        const before = await proxyCall(fetcher, base, '/info?target=' + targetQuery);
        if (profileUrl(before.url)?.id !== expected) return empty('unavailable', undefined, ['主页跳转到了不同账号，已停止读取']);
        await proxyCall(fetcher, base, '/scroll?target=' + targetQuery + '&direction=bottom');
        await delay(350);
        latest = await waitProfile(expected);
      }
      if (!latest.profile || latest.profile.id !== expected || profileUrl(latest.profile.profileUrl)?.id !== expected) return empty(latest.status || 'unavailable', undefined, latest.missing || ['主页读取中断']);
      if (normalized.handle && !sameHandle(latest.profile.handle, normalized.handle)) return empty('needs_selection', undefined, ['主页小红书号在读取期间发生变化，已停止同步']);
      for (const note of verifiedNotes(latest.notes, expected)) {
        const previous = merged.get(note.id);
        if (previous && previous.url.includes('xsec_token=') && !note.url.includes('xsec_token=')) {
          previous.pinned ||= note.pinned;
        } else if (merged.size < 50 || previous) merged.set(note.id, note);
      }
      limitReached ||= latest.scan?.limitReached === true || merged.size >= 50;
      if (limitReached) break;
    }
    const missing = [...new Set([WINDOW_NOTE, ...(Array.isArray(latest.missing) ? latest.missing : [])])];
    if (limitReached) missing.push('本次最多读取50条已加载笔记');
    return { status: latest.status === 'ready' ? 'ready' : 'partial', profile: { ...latest.profile, profileUrl: profileUrl(latest.profile.profileUrl).canonical },
      notes: Array.from(merged.values()), scan: { complete: false, limitReached }, missing };
  } catch (error) {
    return empty('unavailable', error instanceof InputError ? error.message : '浏览器读取器未连接或博主主页未能读取，请稍后重试');
  } finally {
    if (base && typeof target === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(target)) await proxyCall(fetcher, base, '/close?target=' + encodeURIComponent(target)).catch(() => {});
  }
}
