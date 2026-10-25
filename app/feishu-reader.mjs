import { setTimeout as delay } from 'node:timers/promises';
import { InputError } from './content.mjs';

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 60000;
const DOCUMENT_LIMIT = 20;
const specificTitle = value => typeof value === 'string' && Boolean(value.trim()) && !/^(?:飞书文档|飞书云文档|飞书|云空间|文档|目录|加载中|登录|Lark|Feishu|Docs|Wiki)$/i.test(value.trim());
// Leave five seconds for closing our tab within the approximately 120s budget.
const READ_BUDGET = 115000;
const TENANT = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.(?:feishu\.cn|larksuite\.com)$/i;
function feishuUrl(value) {
  let url; try { url = new URL(value); } catch { return null; }
  return url.protocol === 'https:' && TENANT.test(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') ? url : null;
}
export function normalizeFeishuSource(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 12000 || /[\u0000-\u001f\u007f]/.test(input)) throw new InputError('请输入完整的飞书文档或目录链接');
  const url = feishuUrl(input.trim());
  if (!url || !/^\/(?:docx|wiki)\/[A-Za-z\d_-]{8,128}\/?$/.test(url.pathname) && !/^\/drive\/folder\/[A-Za-z\d_-]{8,128}\/?$/.test(url.pathname)) {
    throw new InputError('仅支持飞书租户 HTTPS 目录、docx 和 wiki 正文链接');
  }
  url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}
const folderUrl = value => new URL(value).pathname.startsWith('/drive/folder/');
function proxyBase(env) {
  let url; try { url = new URL(env.REDPILOT_READER_PROXY_URL || 'http://127.0.0.1:3456'); } catch {}
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new InputError('本地浏览器读取桥地址配置不正确', 409);
  return url.origin;
}
class ReadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { await response.body?.cancel().catch(() => {}); throw new ReadError('unavailable', '飞书读取结果超过2MiB限制'); }
  const reader = response.body?.getReader(); if (!reader) throw new ReadError('unavailable', '浏览器未返回可读取结果');
  let length = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) { await reader.cancel().catch(() => {}); throw new ReadError('unavailable', '飞书读取结果超过2MiB限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new ReadError('unavailable', '浏览器未返回有效读取结果'); }
}

// Both expressions guard the actual location before looking at any DOM. The
// document editor may be contenteditable; we only read its rendered text.
function extractPage(expected) {
  const result = { url: String(location.href || ''), kind: null, status: 'unavailable', title: '', blocks: [], links: [], complete: false, error: '' };
  const canonical = value => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.(?:feishu\.cn|larksuite\.com)$/i.test(url.hostname)
        || url.username || url.password || url.port && url.port !== '443'
        || !/^\/(?:docx|wiki)\/[A-Za-z\d_-]{8,128}\/?$/.test(url.pathname) && !/^\/drive\/folder\/[A-Za-z\d_-]{8,128}\/?$/.test(url.pathname)) return null;
      url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, ''); return url.href;
    } catch { return null; }
  };
  if (canonical(result.url) !== expected) { result.error = '飞书页面跳转到了不同来源，未读取内容'; return result; }
  result.url = expected;
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const visible = node => {
    if (!node) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return node.getClientRects().length > 0;
  };
  const first = (root, selector) => all(root, selector).find(visible);
  const text = node => String(node?.innerText || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trim();
  const cleanTitle = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const navigationTitle = value => /^(?:飞书|飞书云文档|飞书文档|云文档|云空间|文档|目录|加载中|登录|登录飞书|Lark|Feishu|Docs|Wiki|Loading\.*|Sign in|Log in)$/i.test(value);
  const documentTitle = () => {
    for (const node of all(document, '.suite-title__title, .suite-title input, .suite-title textarea, .suite-title [contenteditable], .suite-title').filter(visible)) {
      const value = cleanTitle(typeof node.value === 'string' && node.value.trim() ? node.value : node.innerText || node.textContent);
      if (value && !navigationTitle(value)) return value.slice(0, 200);
    }
    const fallback = cleanTitle(document.title).replace(/\s*[-–—|｜·]\s*(?:飞书云文档|飞书文档|飞书|Feishu\s+Docs?|Lark\s+Docs?|Lark|Feishu)\s*$/i, '').trim();
    return fallback && !navigationTitle(fallback) ? fallback.slice(0, 200) : '飞书文档';
  };
  const host = new URL(expected).hostname;
  if (new URL(expected).pathname.startsWith('/drive/folder/')) {
    const list = first(document, '.explorer-file-list-virtualized__container');
    if (list) {
      result.kind = 'folder'; result.status = 'partial';
      const links = [], entries = [];
      for (const row of all(list, '.file-list-item').filter(visible)) {
        for (const anchor of all(row, 'a[href]').filter(visible)) {
          const link = canonical(anchor.href);
          if (link && new URL(link).hostname === host && !links.includes(link)) {
            links.push(link);
            const label = first(anchor, '.file-name, [class*="FileName"], [data-testid="file-name"]');
            const name = cleanTitle(text(label) || anchor.getAttribute('title') || text(anchor).split('\n')[0]);
            entries.push({ url: link, title: name.slice(0, 200) });
          }
        }
      }
      result.links = links.slice(0, 100);
      result.entries = entries.slice(0, 100);
      result.complete = false;
      result.atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
      result.error = '目录仅扫描当前加载窗口，未确认全量；子目录和附件不自动递归读取';
      return result;
    }
  } else {
    const root = first(document, '.docx-page-block .root-render-unit-container');
    if (root) {
      const candidates = all(root, '.block[data-block-id]').filter(node => {
        if (!visible(node)) return false;
        const parent = node.parentElement?.closest('.block[data-block-id]');
        return !parent || !root.contains(parent);
      });
      let count = 0;
      for (const node of candidates.slice(0, 2000)) {
        const value = text(node); if (!value) continue;
        const remaining = 60001 - count; if (remaining <= 0) break;
        const piece = value.slice(0, remaining);
        result.blocks.push({ id: String(node.getAttribute('data-block-id') || '').slice(0, 120), text: piece });
        count += piece.length;
      }
      if (result.blocks.length) {
        result.kind = 'document';
        result.title = documentTitle();
        const scroller = first(document, '.bear-web-x-container');
        result.atEnd = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
        result.virtualized = all(root, '.bear-virtual-renderUnit-placeholder').some(node => visible(node) && node.getBoundingClientRect().height > 0);
        result.truncated = count > 60000 || candidates.length > 2000;
        result.complete = Boolean(result.atEnd && !result.virtualized && !result.truncated && candidates.length);
        result.status = result.complete ? 'ready' : 'partial';
        result.error = result.truncated ? '正文达到60000字或可见块上限，仅保留已读取部分' : result.complete ? '' : '正文存在虚拟渲染或未读取窗口，尚未确认完整';
        return result;
      }
    }
  }
  const page = text(document.body).slice(0, 40000);
  if (/没有访问权限|没有权限访问|无权访问|无权限|申请访问|没有查看权限|Access denied|Request access/i.test(page)) { result.status = 'blocked'; result.error = '当前账号没有该飞书来源的访问权限'; }
  else if (/安全验证|操作过于频繁|访问异常|请完成验证|请求频繁/.test(page)) { result.status = 'blocked'; result.error = '飞书要求验证或暂时限制读取'; }
  else if (/验证码登录|扫码登录|登录飞书|登录以继续|Sign in to|Log in to/i.test(page)) { result.status = 'needs_login'; result.error = '请先在 Chrome 登录飞书后读取'; }
  else result.error = '未定位到可读取的飞书正文或目录，页面可能尚未加载完成';
  return result;
}
function scrollPage(expected, folder) {
  let current; try { current = new URL(location.href); current.search = ''; current.hash = ''; current.pathname = current.pathname.replace(/\/$/, ''); } catch {}
  if (current?.href !== expected) return { scrolled: false };
  const node = document.querySelector(folder ? '.explorer-file-list-virtualized__container' : '.bear-web-x-container');
  if (!node) return { scrolled: false };
  const before = node.scrollTop;
  node.scrollTop = Math.min(node.scrollHeight, before + Math.max(300, Math.min(node.clientHeight * 0.9, 700)));
  return { scrolled: node.scrollTop > before, atEnd: node.scrollTop + node.clientHeight >= node.scrollHeight - 4 };
}

export async function readFeishuSources({ urls } = {}, env = process.env, fetcher = fetch) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 20) throw new InputError('每次可同步1至20个飞书来源');
  const roots = [...new Set(urls.map(normalizeFeishuSource))];
  const sources = roots.map(url => ({ url, status: 'unavailable', documentCount: 0, complete: false, documentUrls: folderUrl(url) ? [] : [url] }));
  const queue = new Map(), documents = new Map();
  const addDocument = (url, sourceUrl, directoryTitle = '') => {
    let record = queue.get(url); if (!record) { record = { url, sourceUrls: new Set(), attempted: false }; queue.set(url, record); }
    record.sourceUrls.add(sourceUrl);
    if (specificTitle(directoryTitle)) record.titleHint = directoryTitle.trim().slice(0, 200);
    const saved = documents.get(url); if (saved && !saved.sourceUrls.includes(sourceUrl)) saved.sourceUrls.push(sourceUrl);
    if (saved && !specificTitle(saved.title) && record.titleHint) saved.title = record.titleHint;
    return record;
  };
  for (const url of roots.filter(url => !folderUrl(url))) addDocument(url, url);
  let base, target, documentAttempts = 0; const deadline = Date.now() + READ_BUDGET;
  const call = async (route, script, desired = 12000, cleanup = false) => {
    const remaining = deadline - Date.now();
    if (!cleanup && remaining <= 0) throw new ReadError('partial', '达到本次约120秒读取预算，部分来源留待下次同步');
    const response = await fetcher(base + route, { method: script ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(cleanup ? 5000 : Math.max(1, Math.min(desired, remaining))),
      ...(script ? { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: script } : {}) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ReadError('unavailable', '本地浏览器读取桥暂时不可用'); }
    const value = await boundedJson(response);
    if (!value || typeof value !== 'object' || value.error) throw new ReadError('unavailable', '本地浏览器读取桥未返回有效结果');
    return value;
  };
  const targetQuery = () => encodeURIComponent(target);
  const checkLocation = async (expected, desired = 12000) => {
    const info = await call('/info?target=' + targetQuery(), undefined, desired);
    const current = feishuUrl(info.url);
    if (current && /\/(?:login|signin|passport|auth|accounts)(?:\/|$)/i.test(current.pathname)) throw new ReadError('needs_login', '请先在 Chrome 登录飞书后读取');
    let canonical; try { canonical = normalizeFeishuSource(info.url); } catch {}
    if (canonical !== expected) throw new ReadError('unavailable', '飞书来源跳转到了其他页面，未读取正文');
  };
  const navigate = async url => {
    try { await call('/navigate?target=' + targetQuery() + '&url=' + encodeURIComponent(url), undefined, 12000); }
    catch (error) {
      // Feishu can leave document.readyState interactive while the visible
      // editor is usable. A navigation timeout is recoverable only after URL verification.
      await checkLocation(url);
    }
  };
  const snapshot = async (url, until) => {
    const timeout = () => until === undefined ? 12000 : Math.max(1, until - Date.now());
    if (until !== undefined && until <= Date.now()) throw new ReadError('partial', '标题等待已到时，正文已保留');
    await checkLocation(url, timeout());
    if (until !== undefined && until <= Date.now()) throw new ReadError('partial', '标题等待已到时，正文已保留');
    const value = (await call('/eval?target=' + targetQuery(), `(${extractPage.toString()})(${JSON.stringify(url)})`, timeout())).value;
    if (!value || typeof value !== 'object') throw new ReadError('unavailable', '飞书页面未返回有效读取结果');
    let resolved; try { resolved = normalizeFeishuSource(value.url); } catch {}
    if (resolved !== url) throw new ReadError('unavailable', '飞书页面在读取期间跳转，未采用正文');
    return value;
  };
  const waitSnapshot = async url => {
    let value, verified;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { value = await snapshot(url); }
      catch (error) {
        if (!verified) throw error;
        return { ...verified, status: 'partial', complete: false, error: '页面后续加载中断，已保留读取到的正文或目录窗口' };
      }
      if (['needs_login', 'blocked'].includes(value.status)) return value;
      if (value.kind) verified = value;
      if (value.kind === 'document' && specificTitle(value.title)) return value;
      if (value.kind === 'folder' && (value.links?.length || value.entries?.length)) return value;
      if (attempt < 9) await delay(Math.max(1, Math.min(500, deadline - Date.now())));
    }
    if (verified?.kind === 'document' && !specificTitle(verified.title)) return { ...verified, status: 'partial', complete: false, error: '正文已读取，文档标题尚未完成加载；仅保留已核对部分' };
    return verified || value;
  };
  const readDocument = async record => {
    if (record.attempted || documentAttempts >= DOCUMENT_LIMIT) return;
    record.attempted = true; documentAttempts++;
    const blocks = new Map(); let title = '';
    const saveDocument = complete => {
      const content = [...blocks.values()].join('\n\n').trim();
      if (!content) return false;
      documents.set(record.url, { url: record.url, title: specificTitle(title) ? title : record.titleHint || title || '飞书文档', text: content.slice(0, TEXT_LIMIT), complete: complete && content.length <= TEXT_LIMIT,
        readAt: new Date().toISOString(), sourceUrls: [...record.sourceUrls] });
      return true;
    };
    try {
      await navigate(record.url);
      let value = await waitSnapshot(record.url), complete = false, reason = '';
      for (let pass = 0; pass < 4; pass++) {
        if (value.kind !== 'document') throw new ReadError(['needs_login', 'blocked'].includes(value.status) ? value.status : 'unavailable', value.error || '未读取到已核对的飞书正文');
        if (typeof value.title === 'string' && value.title.trim() && (value.title !== '飞书文档' || !title)) title = value.title.slice(0, 200);
        for (const block of Array.isArray(value.blocks) ? value.blocks : []) {
          if (typeof block.id !== 'string' || !block.id || typeof block.text !== 'string' || !block.text.trim()) continue;
          blocks.set(block.id, block.text.slice(0, TEXT_LIMIT + 1));
        }
        const length = [...blocks.values()].join('\n\n').length;
        complete = value.complete === true && length <= TEXT_LIMIT;
        reason = typeof value.error === 'string' ? value.error : '';
        if (complete || length > TEXT_LIMIT || value.atEnd || pass === 3) break;
        await checkLocation(record.url);
        const movement = (await call('/eval?target=' + targetQuery(), `(${scrollPage.toString()})(${JSON.stringify(record.url)},false)`)).value;
        if (!movement?.scrolled) break;
        await delay(Math.max(1, Math.min(200, deadline - Date.now())));
        value = await snapshot(record.url);
      }
      const content = [...blocks.values()].join('\n\n').trim();
      if (!content) throw new ReadError('unavailable', '未读取到已核对的飞书正文');
      const truncated = content.length > TEXT_LIMIT;
      saveDocument(complete && !truncated);
      record.status = complete && !truncated ? 'ready' : 'partial';
      record.error = truncated ? '正文超过60000字，仅保留已读取部分' : record.status === 'partial' ? reason || '尚未确认正文完整，仅保留已读取部分' : undefined;
    } catch (error) {
      record.status = error instanceof ReadError && ['partial', 'needs_login', 'blocked', 'unavailable'].includes(error.status) ? error.status : 'unavailable';
      record.error = error instanceof ReadError ? error.message : '飞书正文读取未完成，请稍后同步';
      if (saveDocument(false)) record.status = 'partial';
    }
  };
  try {
    base = proxyBase(env);
    const created = await call('/new?url=about%3Ablank', undefined, 12000);
    target = created.targetId;
    if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(target)) throw new ReadError('unavailable', '未能建立自己的飞书读取标签');
    // Explicit documents are read first so a large folder cannot starve them.
    for (const record of queue.values()) { if (Date.now() >= deadline) break; await readDocument(record); }
    for (const source of sources.filter(source => folderUrl(source.url))) {
      if (Date.now() >= deadline) { source.status = 'partial'; source.error = '达到本次约120秒预算，目录留待下次同步'; continue; }
      try {
        await navigate(source.url);
        let value = await waitSnapshot(source.url); const links = new Set(), directoryTitles = new Map();
        for (let pass = 0; pass < 3; pass++) {
          if (value.kind !== 'folder') throw new ReadError(['needs_login', 'blocked'].includes(value.status) ? value.status : 'unavailable', value.error || '未读取到已核对的飞书目录');
          const entries = [...(Array.isArray(value.entries) ? value.entries : []), ...(Array.isArray(value.links) ? value.links : [])];
          for (const input of entries) {
            let link; try { link = normalizeFeishuSource(typeof input === 'string' ? input : input?.url); } catch { continue; }
            if (new URL(link).hostname !== new URL(source.url).hostname || folderUrl(link)) continue;
            links.add(link);
            if (specificTitle(input?.title)) directoryTitles.set(link, input.title.trim().slice(0, 200));
          }
          if (value.atEnd || pass === 2 || links.size >= DOCUMENT_LIMIT) break;
          await checkLocation(source.url);
          const movement = (await call('/eval?target=' + targetQuery(), `(${scrollPage.toString()})(${JSON.stringify(source.url)},true)`)).value;
          if (!movement?.scrolled) break;
          await delay(Math.max(1, Math.min(200, deadline - Date.now()))); value = await snapshot(source.url);
        }
        source.documentUrls = [...links]; source.status = 'partial'; source.complete = false;
        source.error = '目录只扫描当前加载窗口，未确认全量；子目录和附件不自动读取';
        for (const link of links) addDocument(link, source.url, directoryTitles.get(link));
      } catch (error) {
        source.status = error instanceof ReadError && ['partial', 'needs_login', 'blocked', 'unavailable'].includes(error.status) ? error.status : 'unavailable';
        source.error = error instanceof ReadError ? error.message : '飞书目录读取未完成，请稍后同步';
      }
    }
    for (const record of queue.values()) { if (Date.now() >= deadline || documentAttempts >= DOCUMENT_LIMIT) break; await readDocument(record); }
  } catch (error) {
    const reason = error instanceof InputError || error instanceof ReadError ? error.message : '本地浏览器读取桥未连接或飞书读取未完成';
    for (const source of sources) { source.status = 'unavailable'; source.error = reason; }
  } finally {
    if (base && typeof target === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(target)) await call('/close?target=' + targetQuery(), undefined, 5000, true).catch(() => {});
  }
  for (const source of sources) {
    const records = source.documentUrls.map(url => queue.get(url)).filter(Boolean);
    source.documentCount = [...documents.values()].filter(document => document.sourceUrls.includes(source.url)).length;
    if (!folderUrl(source.url)) {
      const record = queue.get(source.url); source.status = record?.status || (source.error ? source.status : 'partial'); source.complete = documents.get(source.url)?.complete === true;
      if (record?.error) source.error = record.error;
      else if (record?.status === 'ready') delete source.error;
      else if (!record?.attempted && !source.error) source.error = '达到本次文档数量或时间预算，来源留待下次同步';
    } else if (records.some(record => !record.attempted)) {
      source.status = 'partial'; source.error = '目录为部分窗口，且部分文档达到20篇或时间预算，留待下次同步';
    } else if (records.some(record => record.status !== 'ready')) {
      source.status = 'partial'; source.error = records.some(record => record.status === 'needs_login') ? '目录为部分窗口，部分文档需要先在 Chrome 登录飞书后读取'
        : records.some(record => record.status === 'blocked') ? '目录为部分窗口，部分文档没有访问权限或要求验证' : '目录为部分窗口，部分正文未确认完整或读取受阻';
    }
  }
  const output = [...documents.values()];
  const status = output.length ? sources.every(source => source.status === 'ready') && output.every(document => document.complete) ? 'ready' : 'partial'
    : sources.some(source => source.status === 'needs_login') || [...queue.values()].some(record => record.status === 'needs_login') ? 'needs_login'
      : sources.some(source => source.status === 'blocked') || [...queue.values()].some(record => record.status === 'blocked') ? 'blocked'
      : sources.some(source => source.status === 'partial') ? 'partial' : 'unavailable';
  return { status, documents: output, sources, ...(output.length ? {} : { error: '本次未读取到有可见正文的飞书文档；请查看各来源状态' }) };
}
