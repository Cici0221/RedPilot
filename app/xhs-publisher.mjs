import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublisherSessions } from './publisher-sessions.mjs';
import { parseCreatorPerformance } from './publisher-performance.mjs';

const CREATOR = 'https://creator.xiaohongshu.com';
const PUBLIC = 'https://www.xiaohongshu.com';
const LOGIN = `${CREATOR}/login`;
const HOME = `${CREATOR}/new/home`;
const IMAGE = `${CREATOR}/publish/publish?from=menu&target=image`;
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;
const queues = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const clean = value => String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
const sameText = (a, b) => clean(a).replace(/\s+/gu, ' ') === clean(b).replace(/\s+/gu, ' ');
const profile = id => `${PUBLIC}/user/profile/${id}`;
const publisherError = (code, message) => Object.assign(new Error(message),{code});
function official(value, creator = false) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (creator ? u.hostname === 'creator.xiaohongshu.com' : ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname))
      && !u.username && !u.password && (!u.port || u.port === '443') ? u : null;
  } catch { return null; }
}
function noteId(value, authorId) {
  const u = official(value); if (!u) return '';
  const simple = u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i);
  const extended = u.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/([a-f\d]{24})\/?$/i);
  return (simple?.[1] || (extended?.[1].toLowerCase() === authorId ? extended[2] : '') || '').toLowerCase();
}
function baseUrl(env) {
  let u; try { u = new URL(env.REDPILOT_PUBLISHER_PROXY_URL || env.REDPILOT_READER_PROXY_URL || 'http://127.0.0.1:3456'); } catch {}
  if (!u || u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('本地 Chrome 连接地址配置不正确');
  return u.origin;
}
async function boundedJson(response) {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE) { await response.body?.cancel().catch(() => {}); throw new Error('浏览器连接暂不可用'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('浏览器未返回结果');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw new Error('浏览器结果超过读取限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!data || typeof data !== 'object' || data.error) throw new Error('浏览器连接暂不可用');
  return data;
}

// This is ordinary rendered DOM only. The first guard runs before any DOM
// access; a page navigation between /info and /eval cannot read a foreign page.
function publisherDom(op, args) {
  const resolvedUrl = String(location.href || '');
  let u; try { u = new URL(resolvedUrl); } catch {}
  const creator = u?.hostname === 'creator.xiaohongshu.com';
  const publicPage = ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u?.hostname);
  if (!u || u.protocol !== 'https:' || (!creator && !publicPage) || u.username || u.password || (u.port && u.port !== '443')) return { status: 'unavailable', resolvedUrl };
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const text = node => String(node?.innerText || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  const visible = node => {
    if (!node || !node.getClientRects().length) return false;
    for (let n = node; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (n.hidden || n.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  };
  const first = (root, selector) => all(root, selector).find(visible);
  const body = text(document.body).slice(0, 25000);
  const gate = /安全验证|请完成验证|访问过于频繁|操作过于频繁|访问异常/.test(body) ? 'blocked'
    : /\/login(?:\/|$)/.test(u.pathname) || /手机号登录|扫码登录|请先登录/.test(body) ? 'needs_login' : '';
  if (op === 'home') {
    if (!creator || u.pathname !== '/new/home') return { status: gate || 'unavailable', resolvedUrl };
    // The account value loads after the surrounding dashboard. Never let a
    // whitespace pattern cross a line and consume the next achievement label.
    const handles = [...new Set(all(document, 'div,span,p').filter(node => !node.children.length && visible(node))
      .map(node => text(node).match(/^小红书账号[ \t]*[:：][ \t]*([^\s:：]+)[ \t]*$/u)?.[1]).filter(Boolean))];
    const handle = handles.length === 1 ? handles[0] : '';
    return { status: handle ? 'ready' : gate || 'loading', resolvedUrl, handle: handle.slice(0, 100), name: text(first(document, '.user-info .name-box')).slice(0, 120), ...(args.performance ? {dashboardText:body} : {}) };
  }
  if (op === 'profile') {
    if (!publicPage || u.pathname.replace(/\/$/, '') !== '/user/profile/' + args.accountId) return { status: gate || 'unavailable', resolvedUrl };
    const root = first(document, '#userPageContainer');
    const handle = text(first(root, '.user-redId')).match(/^小红书号[ \t]*[:：][ \t]*([^\s:：]+)[ \t]*$/u)?.[1] || '';
    const notes = all(root, 'section.note-item').filter(visible).slice(0, 30).map(card => {
      const link = card.querySelector('a.cover[href]');
      return { url: link?.href || '', title: text(first(card, 'a.title, .title')).slice(0, 160) };
    });
    return { status: handle ? 'ready' : gate || 'loading', resolvedUrl, handle, notes };
  }
  if (op === 'note') {
    if (!publicPage) return { status: 'unavailable', resolvedUrl };
    const root = first(document, '#noteContainer');
    const title = text(first(root, '#detail-title'));
    const desc = first(root, '#detail-desc');
    const author = first(root, '.author-container .name[href]');
    const media = first(root, '.note-slider, .media-container');
    const slides = all(media, '.swiper-slide').filter(n => !n.classList.contains('swiper-slide-duplicate'));
    const photos = all(media, 'img').filter(n => !n.closest('.author-container, .avatar, .comment-container') && (n.currentSrc || n.src));
    const pagination = text(first(root, '.slider-pagination-container, .pagination-media-container')).match(/\d+\s*\/\s*(\d+)/);
    const hasVideo = !!first(root, 'video');
    const imageCount = hasVideo ? 0 : pagination ? Number(pagination[1]) : slides.length || photos.length;
    return { status: root && author && (title || text(desc)) ? 'ready' : gate || 'loading', resolvedUrl,
      title, body: text(desc), authorUrl: author?.href || '', imageCount, hasVideo };
  }
  // No upload, fill, or click is allowed outside the exact image editor.
  if (!creator || u.pathname !== '/publish/publish' || u.searchParams.get('target') !== 'image') return { status: gate || 'unavailable', resolvedUrl };
  // Labels below were observed in the official 2026-10-28 text-card workflow.
  // Match a unique visible leaf, never an inferred CSS class or hidden state.
  const label = value => all(document, 'button,[role="button"],span,div,p').filter(n => visible(n) && text(n) === value && !Array.from(n.children).some(child => text(child) === value));
  const cardEntries = label('文字配图');
  const cardEditors = all(document,'textarea,[contenteditable="true"]').filter(n => visible(n) && (/真诚分享经验或资讯，提个问题也不错/.test(`${n.placeholder || ''} ${n.getAttribute('data-placeholder') || ''} ${n.getAttribute('aria-label') || ''}`) || body.includes('写文字') && !body.includes('填写标题')));
  const cardImages = all(document,'img').filter(n => visible(n) && /\/zs2tab_[^/]+\.jpg(?:\?|$)/.test(n.currentSrc || n.src || ''));
  const cardState = {status:gate || 'ready',resolvedUrl,entryCount:cardEntries.length,editorCount:cardEditors.length,cardText:cardEditors.length === 1 ? ('value' in cardEditors[0] ? cardEditors[0].value : text(cardEditors[0])) : '',
    templateReady:!gate && body.includes('选择一个喜欢的卡片') && cardImages.length > 0, cardKeys:cardImages.map(n => n.currentSrc || n.src)};
  if (op === 'text-inspect') return cardState;
  if (op === 'text-open') {if (gate || cardEntries.length !== 1) return {...cardState,status:'ambiguous'};cardEntries[0].click();return {...cardState,status:'opened'};}
  if (op === 'text-fill') {
    if (gate || cardEditors.length !== 1) return {...cardState,status:'ambiguous'};
    const editor = cardEditors[0]; editor.focus();
    if ('value' in editor) {const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;if(!setter)return {...cardState,status:'ambiguous'};setter.call(editor,args.text);}
    else editor.textContent = args.text;
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:args.text}));return {...cardState,status:'filled'};
  }
  if (op === 'text-generate') {
    const buttons = label('生成图片');
    if (gate || cardEditors.length !== 1 || cardState.cardText !== args.text || buttons.length !== 1) return {...cardState,status:'ambiguous'};
    buttons[0].click();return {...cardState,status:'generating'};
  }
  if (op === 'text-template') {
    const choices = label(args.template), next = all(document,'button').filter(n => visible(n) && text(n) === '下一步');
    if (!cardState.templateReady || choices.length !== 1 || next.length !== 1 || next[0].disabled) return {...cardState,status:'ambiguous'};
    let choice = choices[0];
    while (choice && !all(choice,'img').length) choice = choice.parentElement;
    const pictures = all(choice,'img').filter(n => visible(n) && cardImages.includes(n));
    if (pictures.length !== 1) return {...cardState,status:'ambiguous'};
    choices[0].click();return {...cardState,status:'selected',selectedKey:pictures[0].currentSrc || pictures[0].src};
  }
  if (op === 'text-next') {
    const next = all(document,'button').filter(n => visible(n) && text(n) === '下一步');
    if (!cardState.templateReady || next.length !== 1 || next[0].disabled || !args.selectedKey || cardState.cardKeys[0] !== args.selectedKey) return {...cardState,status:'ambiguous'};
    next[0].click();return {...cardState,status:'next'};
  }
  const inputs = all(document, 'input[type="file"]').filter(n => /\.(?:jpg|jpeg|png|webp)|image\//i.test(n.accept));
  const titles = all(document, 'input, textarea').filter(n => visible(n) && /标题/.test(`${n.placeholder || ''} ${n.getAttribute('aria-label') || ''}`));
  const editors = all(document, '[contenteditable="true"]').filter(n => visible(n) && (n.matches('.ProseMirror') || /正文|描述/.test(`${n.getAttribute('data-placeholder') || ''} ${n.getAttribute('aria-label') || ''}`)));
  const buttons = all(document, 'button, [role="button"], .publishBtn, .publish-button').filter(n => visible(n) && text(n) === '发布');
  const previewRoots = all(document, '.img-preview-area, .image-preview-area, .upload-list, .image-list, .media-list').filter(visible);
  const previews = [...new Set(previewRoots.flatMap(root => all(root, 'img').filter(n => visible(n) && !n.closest('.avatar, .icon') && (n.currentSrc || n.src))))];
  // Native text cards use a platform-generated image rather than a file input.
  if (!previews.length && titles.length === 1 && editors.length === 1 && !body.includes('选择一个喜欢的卡片')) previews.push(...cardImages.filter((n,index,list) => list.findIndex(other => (other.currentSrc || other.src) === (n.currentSrc || n.src)) === index));
  const previewKeys = previews.map(n => n.currentSrc || n.src);
  const files = inputs.length === 1 ? Array.from(inputs[0].files || []).map(f => ({ name: f.name, size: f.size })) : [];
  const uploadSelector = inputs.length === 1 && inputs[0].classList.contains('upload-input') && document.querySelectorAll('input.upload-input[type="file"]').length === 1 ? 'input.upload-input[type="file"]' : '';
  const form = { status: gate || 'ready', resolvedUrl, fileInputCount: inputs.length, titleCount: titles.length, editorCount: editors.length, buttonCount: buttons.length,
    selector: uploadSelector,
    title: titles.length === 1 ? titles[0].value : '', body: editors.length === 1 ? text(editors[0]) : '', files, previewKeys,
    imageCount: previews.length, imagesLoaded: previews.every(n => n.complete && n.naturalWidth > 0),
    busy: /上传中|上传失败|正在上传|图片处理中|图片处理失败/.test(body), enabled: buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute('aria-disabled') !== 'true' };
  if (op === 'fill') {
    if (titles.length !== 1 || editors.length !== 1 || buttons.length !== 1) return { ...form, status: 'ambiguous' };
    const title = titles[0], editor = editors[0];
    const setter = Object.getOwnPropertyDescriptor(title.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return { ...form, status: 'ambiguous' };
    setter.call(title, args.title); title.dispatchEvent(new Event('input', { bubbles: true })); title.dispatchEvent(new Event('change', { bubbles: true }));
    editor.focus(); editor.textContent = args.body;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.body }));
    return { status: 'filled', resolvedUrl };
  }
  if (op === 'submit') {
    const equal = (a, b) => String(a).replace(/\s+/gu, ' ').trim() === String(b).replace(/\s+/gu, ' ').trim();
    const ordered = previewKeys.length === args.previewKeys.length && previewKeys.every((value, index) => value === args.previewKeys[index]);
    if (form.status !== 'ready' || titles.length !== 1 || editors.length !== 1 || !form.enabled || form.busy || !form.imagesLoaded || !ordered
      || previews.length !== args.imageCount || !equal(form.title, args.title) || !equal(form.body, args.body)) return { status: 'not_submitted', resolvedUrl };
    buttons[0].click();
    return { status: 'clicked', resolvedUrl };
  }
  return form;
}
const script = (op, args = {}) => `(${publisherDom.toString()})(${JSON.stringify(op)},${JSON.stringify(args)})`;

function normalizePost(post) {
  if (!post || typeof post !== 'object') throw new Error('发布内容不完整');
  const mode = post.contentMode || post.mode || 'image';
  if (!['image','text'].includes(mode)) throw new Error('发布内容类型不正确');
  const title = clean(post.title), body = clean(post.body ?? post.text), tags = Array.isArray(post.tags) ? post.tags.map(t => clean(t).replace(/^[#＃]+/, '')) : [];
  if (!title || [...title].length > 20 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('标题需为1至20字');
  if (tags.length > 10 || tags.some(t => !t || [...t].length > 30 || /[\s#＃]/u.test(t))) throw new Error('话题格式不正确');
  const fullBody = body + (tags.length ? `${body ? '\n\n' : ''}${tags.map(t => '#' + t).join(' ')}` : '');
  if (!fullBody || [...fullBody].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(fullBody)) throw new Error('正文及话题需为1至1000字');
  if (mode === 'text') {
    const cardText = clean(post.cardText || `${title}\n\n${body}`), textTemplate = post.textTemplate || '简约';
    if (!cardText || [...cardText].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cardText)) throw new Error('文字卡片需为1至1000字');
    if (!['基础','备忘','简约','涂写','边框','便签','涂鸦','几何','手写','清新'].includes(textTemplate)) throw new Error('文字模板不支持');
    return {title,body:fullBody,images:[],mode,cardText,textTemplate};
  }
  if (!Array.isArray(post.images) || !post.images.length || post.images.length > 9) throw new Error('图文需提供1至9张图片');
  const images = post.images.map(image => {
    if (!image || typeof image.path !== 'string' || !path.isAbsolute(image.path) || /[\u0000-\u001f\u007f]/.test(image.path)) throw new Error('图片需来自本机受控素材目录');
    return { path: path.resolve(image.path) };
  });
  return { title, body: fullBody, images };
}
async function imageDetails(images, directory) {
  const root = await realpath(directory);
  const details = [];
  for (const image of images) {
    const file = await realpath(image.path), relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('图片不在本机受控素材目录');
    const info = await stat(file); if (!info.isFile() || info.size < 12 || info.size > MAX_IMAGE) throw new Error('图片大小不符合平台限制');
    const handle = await open(file, 'r'); const header = Buffer.alloc(12);
    try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
    const png = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
    const webp = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    const ext = path.extname(file).toLowerCase();
    if (!(png && ext === '.png' || jpeg && ['.jpg', '.jpeg'].includes(ext) || webp && ext === '.webp')) throw new Error('仅支持真实 PNG、JPEG 或 WebP 图片');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
    details.push({ path: file, name: path.basename(file), size: info.size, sha256: hash.digest('hex') });
  }
  return details;
}

export function createXhsPublisher({ directory, env = process.env, fetcher = fetch, legacySessionId = '', sessions } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('发布任务目录需为绝对路径');
  const root = path.resolve(directory), statePath = path.join(root, 'xhs-publisher.json');
  const browserSessions = sessions || createPublisherSessions({directory:root,env,fetcher,legacySessionId});
  const normalizeSession = value => value || legacySessionId || '';
  const failureMessages = {browser_missing:'未找到 Chrome，请先安装 Chrome',session_closed:'请打开此账号的登录窗口',session_start_failed:'账号登录窗口未能启动，请重新打开',browser_timeout:'账号浏览器操作超时，请重试',browser_disconnected:'账号浏览器已断开，请重新打开登录窗口',browser_command:'浏览器操作未完成，请重试连接',page_script:'小红书页面已变化，请重新检查账号',page_changed:'浏览器页面已跳转，已停止操作',page_loading:'小红书页面加载超时，请稍后重试',legacy_disconnected:'当前 Chrome 连接不可用，请使用独立账号窗口重新登录'};
  const connectionFailure = error => error?.status === 'needs_login' ? {code:'needs_login',message:'请在账号登录窗口登录小红书'} : {code:failureMessages[error?.code] ? error.code : 'browser_unavailable',message:failureMessages[error?.code] || 'Chrome 连接不可用，请打开账号登录窗口后重试'};
  const serialize = task => {
    const previous = queues.get(root) || Promise.resolve();
    const next = previous.catch(() => {}).then(task); queues.set(root, next);
    return next.finally(() => { if (queues.get(root) === next) queues.delete(root); });
  };
  async function load() {
    await mkdir(root, { recursive: true });
    try {
      const info = await stat(statePath); if (info.size > 16 * 1024 * 1024) throw new Error('发布任务记录过大，已停止自动提交');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.version !== 1 || !state.jobs || Array.isArray(state.jobs) || typeof state.jobs !== 'object') throw new Error();
      await chmod(statePath, 0o600); return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, jobs: {} };
      throw new Error('发布任务记录无法核验，已停止自动提交');
    }
  }
  async function save(state) {
    const temporary = path.join(root, '.xhs-publisher-' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, statePath); await chmod(statePath, 0o600);
    } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  async function withTab(task, sessionId) {
    const managed = await browserSessions.transport(normalizeSession(sessionId));
    const base = managed ? '' : baseUrl(env); let target;
    const call = managed || (async (route, body, json = false) => boundedJson(await fetcher(base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(route.startsWith('/close?') ? 5000 : 20000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8' }, body: json ? JSON.stringify(body) : body }) })));
    try {
      const created = await call('/new?url=about%3Ablank'); target = created.targetId;
      if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(target)) throw new Error('浏览器未创建独立工作标签');
      const query = '?target=' + encodeURIComponent(target);
      let expected;
      const matchesExpected = current => current && (expected.noteId ? noteId(current.href, expected.authorId) === expected.noteId
        : current.pathname.replace(/\/$/, '') === expected.url.pathname.replace(/\/$/, '')) && (!expected.image || current.searchParams.get('target') === 'image');
      const locationGuard = async () => {
        const info = await call('/info' + query); const current = official(info.url, expected.creator);
        if (current && /\/(?:login|signin)(?:\/|$)/.test(current.pathname)) throw Object.assign(new Error('请在 Chrome 登录小红书创作者中心'), { status: 'needs_login' });
        if (!matchesExpected(current)) throw publisherError('page_changed','浏览器页面已跳转，已停止操作');
        return info;
      };
      const evaluate = async (op, args = {}) => {
        await locationGuard();
        const value = (await call('/eval' + query, script(op, args))).value;
        const actual = official(value?.resolvedUrl, expected.creator);
        if (!matchesExpected(actual)) throw publisherError('page_changed','浏览器页面已跳转，已停止操作');
        return value;
      };
      const navigate = async address => {
        const u = official(address, true) || official(address); if (!u) throw new Error('拒绝非小红书页面');
        const authorId = u.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/[a-f\d]{24}\/?$/i)?.[1]?.toLowerCase() || '';
        expected = { url: u, creator: u.hostname === 'creator.xiaohongshu.com', image: u.href === IMAGE, authorId, noteId: noteId(u.href, authorId) };
        await call('/navigate' + query + '&url=' + encodeURIComponent(address)).catch(() => {});
        for (let pass = 0; pass < 10; pass++) {
          const info = await call('/info' + query), current = official(info.url, expected.creator);
          if (current && /\/(?:login|signin)(?:\/|$)/.test(current.pathname)) throw Object.assign(new Error('请在 Chrome 登录小红书创作者中心'), { status: 'needs_login' });
          if (matchesExpected(current) && info.ready !== 'loading') return;
          if (info.url && info.url !== 'about:blank' && !official(info.url, true) && !official(info.url)) throw publisherError('page_changed','浏览器跳转到了非小红书页面，已停止操作');
          if (pass < 9) await delay(300);
        }
        throw publisherError('page_loading','小红书页面尚未加载完成');
      };
      const wait = async (op, args, predicate, count = 6) => {
        let value;
        for (let pass = 0; pass < count; pass++) {
          value = await evaluate(op, args);
          if (predicate(value) || ['blocked', 'needs_login', 'unavailable', 'ambiguous'].includes(value.status)) return value;
          if (pass < count - 1) await delay(350);
        }
        return value;
      };
      return await task({ navigate, evaluate, wait, setFile: async (selector, file) => {
        await locationGuard(); return call('/setFiles' + query, { selector, files: [file] }, true);
      } });
    } finally {
      if (typeof target === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(target)) await call('/close?target=' + encodeURIComponent(target)).catch(() => {});
    }
  }
  async function identity(tab, accountId) {
    await tab.navigate(HOME);
    const home = await tab.wait('home', {}, value => !!value.handle, 10);
    if (home.status === 'needs_login') return { status: 'needs_login', error: '请在 Chrome 登录小红书创作者中心' };
    if (home.status !== 'ready' || !home.handle) return { status: home.status === 'blocked' ? 'unavailable' : 'unsupported', error: '未能从创作者中心确认当前小红书号' };
    await tab.navigate(profile(accountId));
    const page = await tab.wait('profile', { accountId }, value => !!value.handle, 10);
    if (page.status !== 'ready' || !page.handle) return { status: page.status === 'needs_login' ? 'needs_login' : 'unavailable', error: '未能核对目标公司账号主页' };
    if (home.handle.toLowerCase() !== page.handle.toLowerCase()) return { status: 'mismatch', error: 'Chrome 登录账号与目标公司账号不一致' };
    const notes = (Array.isArray(page.notes) ? page.notes : []).map(note => ({ ...note, id: noteId(note.url, accountId) })).filter(note => note.id);
    if (!notes.length) return {status:'ready',accountId,handle:home.handle,notes:[],evidence:{method:'creator-handle/profile-handle',profileId:accountId}};
    const proof = notes[0]; await tab.navigate(proof.url);
    const note = await tab.wait('note', {}, value => value.status === 'ready');
    const author = official(note.authorUrl)?.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/?$/i)?.[1]?.toLowerCase();
    if (author !== accountId || noteId(note.resolvedUrl, accountId) !== proof.id || !sameText(note.title, proof.title)) return { status: 'mismatch', error: '公开笔记作者或标题与目标账号不一致，已停止发布' };
    return { status: 'ready', accountId, handle: home.handle, notes, evidence: { method: 'creator-handle/profile-handle/public-note-author', profileId: accountId, authorProfileId: author } };
  }
  const blocked = (error, extra = {}) => ({ status: 'blocked', submitted: false, verified: false, error, ...extra });
  const outcome = job => ({ status: job.status, submitted: !!job.submitIntentAt, verified: job.status === 'published', verifiedNoSubmission: !job.submitIntentAt, accountId: job.accountId,
    ...(job.noteUrl ? { noteUrl: job.noteUrl } : {}), ...(job.error ? { error: job.error } : {}), ...(job.errorCode ? {errorCode:job.errorCode} : {}) });
  async function verifyJob(state, job, tab) {
    if (job.status === 'published') return outcome(job);
    if (!job.submitIntentAt) return blocked(job.error || '尚未尝试提交，可在确认后重试', { accountId: job.accountId, verifiedNoSubmission: true });
    const proof = await identity(tab, job.accountId);
    if (proof.status !== 'ready') return { ...outcome(job), status: 'unknown', error: proof.error || '未能核对发布账号，未重新提交' };
    // Only inspect real current card links. Never invent a token-less note URL.
    await tab.navigate(profile(job.accountId));
    const page = await tab.wait('profile', { accountId: job.accountId }, value => value.status === 'ready');
    const candidates = (Array.isArray(page.notes) ? page.notes : []).map(note => ({ ...note, id: noteId(note.url, job.accountId) }))
      .filter(note => note.id && !job.beforeIds.includes(note.id) && sameText(note.title, job.post.title)).slice(0, 5);
    const matches = [];
    for (const candidate of candidates) {
      await tab.navigate(candidate.url);
      const note = await tab.wait('note', {}, value => value.status === 'ready');
      const author = official(note.authorUrl)?.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/?$/i)?.[1]?.toLowerCase();
      if (note.status === 'ready' && noteId(note.resolvedUrl, job.accountId) === candidate.id && author === job.accountId && !note.hasVideo
        && sameText(note.title, job.post.title) && sameText(note.body, job.post.body) && note.imageCount === (job.expectedImageCount || job.images.length)) matches.push(candidate);
    }
    if (matches.length === 1) {
      job.status = 'published'; job.noteUrl = matches[0].url; job.verifiedAt = new Date().toISOString(); delete job.error; await save(state);
    } else {
      job.status = 'unknown'; job.error = matches.length > 1 ? '发现多篇相同内容，无法唯一核验；未重新提交' : '尚未找到正文、作者和图数均匹配的公开笔记；未重新提交'; await save(state);
    }
    return outcome(job);
  }
  return {
    sessionStatus: sessionId => browserSessions.status(sessionId),
    openLogin: (sessionId, options) => browserSessions.openLogin(sessionId,options),
    close: () => browserSessions.close(),
    readPerformance: (expectedProfileId, {sessionId} = {}) => serialize(async () => {
      const readAt = new Date().toISOString();
      if (typeof expectedProfileId !== 'string' || !/^[a-f\d]{24}$/i.test(expectedProfileId)) return {status:'unavailable',readAt,notes:[],error:'请提供完整的小红书账号ID'};
      try {return await withTab(async tab => {
        const proof = await identity(tab,expectedProfileId.toLowerCase());
        if (proof.status !== 'ready') return {status:'unavailable',readAt,notes:[],error:proof.error,errorCode:proof.status};
        await tab.navigate(HOME);
        const home = await tab.wait('home',{performance:true},value => value.handle && value.dashboardText?.includes('统计周期'),10);
        if (home.handle?.toLowerCase() !== proof.handle.toLowerCase()) return {status:'unavailable',readAt,notes:[],error:'当前账号已切换',errorCode:'mismatch'};
        return {...parseCreatorPerformance(home.dashboardText,{readAt}),accountId:expectedProfileId.toLowerCase()};
      },sessionId);} catch(error) {const failure=connectionFailure(error);return {status:'unavailable',readAt,notes:[],error:failure.message,errorCode:failure.code};}
    }),
    checkConnection: (expectedProfileId, {sessionId} = {}) => serialize(async () => {
      const checkedAt = new Date().toISOString(), common = { checkedAt, image: false, text: false, loginUrl: LOGIN };
      if (typeof expectedProfileId !== 'string' || !/^[a-f\d]{24}$/i.test(expectedProfileId)) return { ...common, status: 'unsupported', error: '请提供完整的目标小红书账号ID' };
      try {
        const proof = await withTab(async tab => {
          const result = await identity(tab, expectedProfileId.toLowerCase());
          if (result.status !== 'ready') return result;
          await tab.navigate(IMAGE);
          const form = await tab.wait('inspect', {}, value => value.fileInputCount > 0);
          if (form.status !== 'ready' || form.fileInputCount !== 1 || !form.selector) return { ...result, status: 'unsupported', error: '已核对账号，但未找到唯一的图文上传入口' };
          const cards = await tab.evaluate('text-inspect');
          return {...result,text:cards.status === 'ready' && cards.entryCount === 1};
        },sessionId);
        const { notes, ...result } = proof; return { ...common, ...result, image: proof.status === 'ready' };
      } catch (error) {const failure = connectionFailure(error); return { ...common, status: error.status === 'needs_login' ? 'needs_login' : 'unavailable', error: failure.message, errorCode:failure.code }; }
    }),
    publish: input => serialize(async () => {
      let state, job;
      try {
        const { idempotencyKey, accountId, post, retry = false, sessionId } = input || {};
        if (typeof accountId !== 'string' || !/^[a-f\d]{24}$/i.test(accountId) || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) return blocked('账号或发布任务标识不正确');
        const id = accountId.toLowerCase(), normalized = normalizePost(post), inputHash = sha(JSON.stringify(normalized));
        state = await load(); const key = sha(id + ':' + idempotencyKey); job = state.jobs[key];
        if (job && normalizeSession(job.sessionId) !== normalizeSession(sessionId)) return blocked('此发布任务属于另一个账号会话，不能切换登录窗口重发', {submitted:!!job.submitIntentAt,accountId:id});
        if (job && job.inputHash !== inputHash) return blocked('同一发布任务不能更改内容或图片，请新建任务', { submitted: !!job.submitIntentAt, accountId: id });
        if (job?.submitIntentAt) {
          if (job.status === 'published') {
            const currentImages = await imageDetails(normalized.images, root);
            const currentHash = sha(JSON.stringify({ title: normalized.title, body: normalized.body, images: currentImages.map(({ size, sha256 }) => ({ size, sha256 })), ...(normalized.mode === 'text' ? {cardText:normalized.cardText,textTemplate:normalized.textTemplate} : {}) }));
            if (currentHash !== job.payloadHash) return blocked('同一已发布任务的图片已变化，请新建任务', { submitted: true, accountId: id });
            return outcome(job);
          }
          return await withTab(tab => verifyJob(state, job, tab),job.sessionId);
        }
        const images = await imageDetails(normalized.images, root);
        const payloadHash = sha(JSON.stringify({ title: normalized.title, body: normalized.body, images: images.map(({ size, sha256 }) => ({ size, sha256 })), ...(normalized.mode === 'text' ? {cardText:normalized.cardText,textTemplate:normalized.textTemplate} : {}) }));
        if (job && job.payloadHash !== payloadHash) return blocked('任务图片已变化，请新建发布任务', { accountId: id });
        if (job && (!['blocked', 'prepared'].includes(job.status) || !retry)) return blocked(job.error || '该任务准备曾中断，请确认后点击重试', { accountId: id, verifiedNoSubmission: true });
        job = { accountId: id, sessionId: normalizeSession(sessionId), idempotencyKey, inputHash, payloadHash, post: normalized, images, expectedImageCount: normalized.mode === 'text' ? 1 : images.length, status: 'prepared', createdAt: job?.createdAt || new Date().toISOString(), beforeIds: [] };
        state.jobs[key] = job; await save(state);
        return await withTab(async tab => {
          const stop = async error => { job.status = 'blocked'; job.error = error; await save(state); return outcome(job); };
          const proof = await identity(tab, id); if (proof.status !== 'ready') return stop(proof.error || '发布账号尚未确认');
          job.beforeIds = proof.notes.map(note => note.id); await save(state);
          await tab.navigate(IMAGE);
          let form, previousKeys = [];
          if (normalized.mode === 'text') {
            const opened = await tab.evaluate('text-open');
            if (opened.status !== 'opened') return stop('未找到唯一的文字配图入口，未提交');
            const editor = await tab.wait('text-inspect',{},value => value.editorCount === 1,12);
            if (editor.status !== 'ready' || editor.editorCount !== 1) return stop('文字卡片编辑器未就绪，未提交');
            await tab.evaluate('text-fill',{text:normalized.cardText});
            const filled = await tab.wait('text-inspect',{},value => value.cardText === normalized.cardText);
            if (filled.cardText !== normalized.cardText) return stop('文字卡片内容未写入，未提交');
            const generated = await tab.evaluate('text-generate',{text:normalized.cardText});
            if (generated.status !== 'generating') return stop('文字卡片生成未启动，未提交');
            const templates = await tab.wait('text-inspect',{},value => value.templateReady,90);
            if (!templates.templateReady) return stop('文字卡片生成超时，未提交');
            const selected = await tab.evaluate('text-template',{template:normalized.textTemplate});
            if (selected.status !== 'selected' || !selected.selectedKey) return stop('文字模板未能选中，未提交');
            const selectedCard = await tab.wait('text-inspect',{},value => value.cardKeys?.[0] === selected.selectedKey,12);
            if (selectedCard.cardKeys?.[0] !== selected.selectedKey) return stop('文字模板预览与所选样式不一致，未提交');
            const next = await tab.evaluate('text-next',{selectedKey:selected.selectedKey});
            if (next.status !== 'next') return stop('文字卡片未能进入发布编辑器，未提交');
              form = await tab.wait('inspect',{},value => value.titleCount === 1 && value.editorCount === 1 && value.imageCount === 1 && value.imagesLoaded,20);
              if (form.status !== 'ready' || form.imageCount !== 1 || !form.imagesLoaded || form.busy || !form.previewKeys?.length) return stop('未能确认生成的文字卡片，未提交');
              previousKeys = form.previewKeys;
            } else {
            form = await tab.wait('inspect', {}, value => value.fileInputCount > 0);
            if (form.status !== 'ready' || form.fileInputCount !== 1 || !form.selector || form.imageCount !== 0) return stop('图片上传入口不唯一或已有图片，未提交');
            for (let index = 0; index < images.length; index++) {
              const current = await imageDetails([normalized.images[index]], root);
              if (current[0].sha256 !== images[index].sha256) return stop('图片在上传前发生变化，未提交');
              // Append one file at a time, then require the visible preview prefix
              // to remain unchanged. This verifies order without private site state.
              await tab.setFile(form.selector, images[index].path);
              form = await tab.wait('inspect', {}, value => value.imageCount === index + 1 && value.imagesLoaded && !value.busy, 12);
              if (form.status !== 'ready' || form.imageCount !== index + 1 || !form.imagesLoaded || form.busy || !Array.isArray(form.previewKeys)
                || !previousKeys.every((value, position) => form.previewKeys[position] === value)) return stop('未能确认上传图片的数量与顺序，未提交');
              previousKeys = form.previewKeys;
            }
          }
          if (form.titleCount !== 1 || form.editorCount !== 1 || form.buttonCount !== 1) return stop('标题、正文或发布按钮不唯一，未提交');
          await tab.evaluate('fill', { title: normalized.title, body: normalized.body });
          form = await tab.wait('inspect', {}, value => sameText(value.title, normalized.title) && sameText(value.body, normalized.body) && value.enabled);
          if (form.status !== 'ready' || form.titleCount !== 1 || form.editorCount !== 1 || form.buttonCount !== 1 || !form.enabled || form.busy || !form.imagesLoaded
            || form.imageCount !== job.expectedImageCount || !sameText(form.title, normalized.title) || !sameText(form.body, normalized.body)
            || !Array.isArray(form.previewKeys) || form.previewKeys.length !== previousKeys.length || !form.previewKeys.every((value, position) => previousKeys[position] === value)) return stop('稿件或图片预览与待发布内容不一致，未提交');
          const finalImages = await imageDetails(normalized.images, root);
          if (finalImages.some((image, index) => image.sha256 !== images[index].sha256)) return stop('图片在提交前发生变化，未提交');
          // Recheck the current Chrome identity without abandoning the editor.
          // A person may have switched accounts during the image upload.
          const finalProof = await withTab(checkTab => identity(checkTab, id),sessionId);
          if (finalProof.status !== 'ready') return stop(finalProof.error || '提交前账号身份无法核对，未提交');
          form = await tab.evaluate('inspect');
          if (form.status !== 'ready' || form.titleCount !== 1 || form.editorCount !== 1 || form.buttonCount !== 1 || !form.enabled || form.busy || !form.imagesLoaded
            || form.imageCount !== job.expectedImageCount || !sameText(form.title, normalized.title) || !sameText(form.body, normalized.body)
            || !Array.isArray(form.previewKeys) || form.previewKeys.length !== previousKeys.length || !form.previewKeys.every((value, position) => previousKeys[position] === value)) return stop('提交前稿件或图片预览发生变化，未提交');
          // Durable intent MUST precede the one possible final click. A crash,
          // timeout, or unrecognised receipt after this point can only verify.
          job.status = 'unknown'; job.submitIntentAt = new Date().toISOString(); job.error = '提交结果待核验，禁止重复提交'; await save(state);
          const submitted = await tab.evaluate('submit', { title: normalized.title, body: normalized.body, imageCount: job.expectedImageCount, previewKeys: previousKeys });
          // Even an apparent not_submitted result is not safe to replay after an
          // intent: the browser or transport can lose a response after clicking.
          if (submitted.status !== 'clicked') return outcome(job);
          return verifyJob(state, job, tab);
        },sessionId);
      } catch (error) {
        if (job?.status === 'published') return blocked('该任务已有核验成功的发布记录，图片当前不可重核；请使用只读核验', { submitted: true, accountId: job.accountId, noteUrl: job.noteUrl });
        if (job && state) {
          job.status = job.submitIntentAt ? 'unknown' : 'blocked'; job.error = job.submitIntentAt ? '发布结果暂未核验，未重复提交' : connectionFailure(error).message + '；未点击发布';
          job.errorCode = connectionFailure(error).code;
          await save(state).catch(() => {}); return outcome(job);
        }
        return blocked(error instanceof Error && /图片|标题|正文|话题|任务记录|文字模板|发布内容|本机/.test(error.message) ? error.message : '发布准备失败，未提交');
      }
    }),
    verify: input => serialize(async () => {
      try {
        const { accountId, idempotencyKey, sessionId } = input || {};
        if (typeof accountId !== 'string' || !/^[a-f\d]{24}$/i.test(accountId) || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) return blocked('账号或发布任务标识不正确');
        const state = await load(), job = state.jobs[sha(accountId.toLowerCase() + ':' + idempotencyKey)];
        if (!job) return { status: 'unknown', submitted: true, verified: false, verifiedNoSubmission: false, error: '未找到该发布任务记录，不能确认是否已提交；未重新提交' };
        if (sessionId !== undefined && normalizeSession(job.sessionId) !== normalizeSession(sessionId)) return {status:'unknown',submitted:!!job.submitIntentAt,verified:false,error:'该任务属于另一个账号会话，未重新提交'};
        if (!job.submitIntentAt) return blocked(job.error || '任务记录证明尚未尝试提交，可确认后重试', { accountId: job.accountId, verifiedNoSubmission: true });
        return job.status === 'published' ? outcome(job) : await withTab(tab => verifyJob(state, job, tab),job.sessionId);
      } catch { return { status: 'unknown', submitted: true, verified: false, error: '浏览器或任务记录暂不可用，未重新提交' }; }
    })
  };
}
