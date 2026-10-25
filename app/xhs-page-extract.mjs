// Executed in the browser as a read-only DOM expression. Do not add access to
// cookies, web storage, hydration state, page globals, or site-internal APIs.
function extractXhsPage() {
  const href = String(location.href || '').slice(0, 12000);
  const result = { kind: null, title: '', text: '', author: '', tags: [], imageUrls: [],
    canonicalUrl: href, resolvedUrl: href, missing: [], status: 'unavailable' };
  // A page may navigate between transport checks and this evaluation. Reject
  // foreign locations before touching any DOM, even if they mimic note markup.
  let pageUrl;
  try { pageUrl = new URL(href); } catch {}
  if (!pageUrl || pageUrl.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(pageUrl.hostname)
    || (pageUrl.port && pageUrl.port !== '443') || pageUrl.username || pageUrl.password) {
    result.missing.push('链接跳转到了非小红书页面，未读取内容');
    return result;
  }
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const text = (node, limit = 16000) => clean(node?.innerText).slice(0, limit);
  const visible = node => {
    if (!node) return false;
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return node.getClientRects().length > 0;
  };
  const onScreen = node => {
    if (!visible(node)) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
      && box.top < innerHeight && box.left < innerWidth;
  };
  const firstVisible = (root, selector) => all(root, selector).find(visible) || null;
  const unique = values => [...new Set(values.filter(Boolean))];
  const tagsFrom = node => unique([
    ...all(node, 'a.tag, .tag').filter(visible).map(node => text(node, 80).replace(/^[#＃]+/, '').trim()),
    ...(text(node).match(/[#＃]([^\s#＃]+)/g) || []).map(value => value.slice(1))
  ]).map(value => value.slice(0, 80)).slice(0, 30);
  const excludedImage = node => node.closest('.avatar, .avatar-container, .avatar-click, .author-avatar, .author-container, .comment-container, .comments-container, .comment-inner-container, .note-warning-tip, .recommend-container, .recommendations');
  const addImage = raw => {
    if (!raw || result.imageUrls.length >= 9) return;
    try {
      const url = new URL(raw, href);
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8000) return;
      if (!result.imageUrls.includes(url.href)) result.imageUrls.push(url.href);
    } catch {}
  };
  const collectMedia = (root, { profile = false } = {}) => {
    if (!root) return;
    for (const image of all(root, 'img')) {
      if (excludedImage(image) || image.hidden) continue;
      // Non-active carousel slides can be unloaded, but their main-image DOM src
      // still describes the note. Never inspect data-* hydration attributes.
      if (image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 80 && image.naturalHeight <= 80) continue;
      if (profile && !onScreen(image)) continue;
      addImage(image.currentSrc || image.src);
    }
    for (const node of [root, ...all(root, '.note-slider-img, .img-container, .swiper-slide')]) {
      if (excludedImage(node) || (profile && !onScreen(node))) continue;
      const background = getComputedStyle(node).backgroundImage || '';
      for (const match of background.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) addImage(match[1]);
    }
  };

  // The detail container exists alongside the recommendation feed and comments.
  // Restrict every content/media selector to the actual opened main note.
  const note = firstVisible(document, '#noteContainer, .note-detail-mask .note-container');
  const titleNode = firstVisible(note, '#detail-title');
  const descNode = firstVisible(note, '#detail-desc');
  const noteAuthor = all(note, '.author-container .name, .author .name').find(node => visible(node)
    && !node.closest('.comment-container, .comments-container, .comment-item, .comment-inner-container'));
  const media = firstVisible(note, '.note-slider') || firstVisible(note, '.media-container');
  const gateWithoutAuthor = !text(noteAuthor) && /笔记不存在|内容不存在|笔记已删除|内容已删除|登录后查看|登录后浏览|手机号登录|扫码登录/.test(`${text(titleNode)}\n${text(descNode)}`);
  const hasMedia = all(media, 'img').some(node => !excludedImage(node) && (node.currentSrc || node.src)) || firstVisible(note, 'video');
  if (note && (titleNode || descNode) && !gateWithoutAuthor && (text(noteAuthor) || hasMedia)
    && (text(titleNode) || text(descNode) || hasMedia)) {
    result.kind = 'note';
    result.title = text(titleNode, 160);
    result.text = text(descNode);
    result.author = text(noteAuthor, 120);
    result.tags = tagsFrom(descNode);
    const slides = all(media, '.swiper-slide').filter(node => !node.classList.contains('swiper-slide-duplicate'));
    if (slides.length) {
      slides.sort((a, b) => Number(a.getAttribute('data-swiper-slide-index') || 0) - Number(b.getAttribute('data-swiper-slide-index') || 0));
      for (const slide of slides) collectMedia(slide);
    } else collectMedia(media);
    const video = firstVisible(note, 'video');
    if (!result.title) result.missing.push('未读取到笔记标题');
    if (!result.text) result.missing.push('未读取到笔记正文');
    if (!result.author) result.missing.push('未读取到笔记作者');
    if (video) result.missing.push('视频仅保留可见标题与描述，未转录视频内容');
    else if (!result.imageUrls.length) result.missing.push('未读取到主笔记配图');
    const pagination = text(firstVisible(note, '.slider-pagination-container, .pagination-media-container'), 40);
    const count = pagination.match(/\d+\s*\/\s*(\d+)/);
    if (count && Number(count[1]) > result.imageUrls.length) result.missing.push(Number(count[1]) > 9 ? '配图最多保留前9张' : '部分轮播配图尚未在DOM中加载');
    else if (slides.length > 9) result.missing.push('配图最多保留前9张');
    result.status = result.missing.length ? 'partial' : 'ready';
    return result;
  }

  const profile = firstVisible(document, '#userPageContainer');
  const info = firstVisible(profile, '.user-info');
  const name = text(firstVisible(info, '.user-name'), 120);
  if (profile && info && name) {
    result.kind = 'profile';
    result.author = name;
    result.title = `${name} · 账号主页`.slice(0, 160);
    const cards = all(profile, 'section.note-item').filter(onScreen).slice(0, 3);
    const summaries = cards.map(card => text(firstVisible(card, 'a.title'), 200)).filter(Boolean);
    result.text = `账号资料（仅主页可见信息）\n${text(info, 6000)}`
      + (summaries.length ? `\n\n当前可见笔记卡片摘要（非正文）\n${summaries.map((value, index) => `${index + 1}. ${value}`).join('\n')}` : '');
    result.tags = tagsFrom(firstVisible(info, '.user-desc'));
    for (const card of cards) collectMedia(firstVisible(card, 'a.cover'), { profile: true });
    result.missing.push('账号主页不是单篇笔记，未读取任何笔记全文', '仅包含主页资料与当前可见的少量卡片摘要');
    if (cards.some(card => card.querySelector('video, .play-icon'))) result.missing.push('视频卡片未转录视频内容');
    result.status = 'partial';
    return result;
  }

  // Content wins over a background login button or overlay. Only classify a
  // gate when no actual opened note/profile content could be extracted above.
  const page = text(document.body, 30000);
  if (firstVisible(document, '.captcha-container, #captcha, #nc_1_wrapper')
    || /安全验证|访问过于频繁|操作过于频繁|访问异常|验证后继续|请完成验证|网络异常.*重试/.test(page)) {
    result.status = 'blocked'; result.missing.push('页面要求验证或暂时阻止访问，未读取笔记内容');
  } else if (firstVisible(document, '.login-container, .login-modal, .login-box')
    || /登录后查看|登录后浏览|登录即可|手机号登录|扫码登录|请先登录/.test(page)) {
    result.status = 'needs_login'; result.missing.push('当前页面需要登录，未读取笔记内容');
  } else if (/笔记不存在|内容不存在|笔记已删除|内容已删除|页面不存在|页面走丢|暂时无法浏览|无法查看该笔记/.test(page)) {
    result.missing.push('页面提示内容不可用，未将推荐内容当作原笔记');
  } else result.missing.push('未定位到可读取的主笔记或账号资料；页面可能尚未完成加载');
  return result;
}

export function browserExtractScript() {
  return `(${extractXhsPage.toString()})()`;
}
