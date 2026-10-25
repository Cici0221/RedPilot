// These browser expressions inspect rendered DOM only. The sole UI action is
// choosing the normal search page's user-results tab in our own browser tab.
function creatorPage(expectedId) {
  const result = { status: 'unavailable', profile: null, notes: [], scan: { complete: false, limitReached: false }, missing: [], resolvedUrl: String(location.href || '') };
  let url; try { url = new URL(result.resolvedUrl); } catch {}
  const match = url?.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/?$/i);
  if (!url || url.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443') || !match || match[1].toLowerCase() !== expectedId) {
    result.missing.push('主页跳转到了不同账号或非小红书页面，已停止读取'); return result;
  }
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const visible = node => {
    if (!node) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return node.getClientRects().length > 0;
  };
  const text = node => String(node?.innerText || '').replace(/\u00a0/g, ' ').trim();
  const first = (root, selector) => all(root, selector).find(visible);
  const root = first(document, '#userPageContainer'), info = first(root, '.user-info');
  const name = text(first(info, '.user-name')).slice(0, 120);
  if (root && info && name) {
    const handle = (text(first(info, '.user-redId')).match(/小红书号\s*[:：]\s*([^\s]+)/)?.[1] || '').slice(0, 100);
    const profile = { profileUrl: `${url.origin}/user/profile/${expectedId}`, id: expectedId, name, handle };
    const avatar = first(info, '.avatar img, img.user-image');
    try {
      const image = new URL(avatar?.currentSrc || avatar?.src);
      if (image.protocol === 'https:' && !image.username && !image.password && (!image.port || image.port === '443')
        && (image.hostname === 'xhscdn.com' || image.hostname.endsWith('.xhscdn.com') || image.hostname === 'ci.xiaohongshu.com')) profile.avatarUrl = image.href;
    } catch {}
    result.profile = profile;
    const notes = new Map(); let rejected = 0;
    for (const card of all(root, 'section.note-item').filter(visible)) {
      const links = all(card, 'a.cover, a.title, a[href]').map(anchor => {
        try {
          const link = new URL(anchor.href, url.href);
          if (link.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(link.hostname)
            || link.username || link.password || (link.port && link.port !== '443')) return null;
          const simple = link.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i);
          const extended = link.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/([a-f\d]{24})\/?$/i);
          if (!simple && (!extended || extended[1].toLowerCase() !== expectedId)) return null;
          return { id: (simple?.[1] || extended[2]).toLowerCase(), url: link.href, token: link.searchParams.has('xsec_token') };
        } catch { return null; }
      }).filter(Boolean);
      // The empty explore anchor often lacks the token; cover/title anchors
      // contain the actual navigable extended href. Never synthesize a note URL.
      const selected = links.find(link => link.token) || links[0];
      if (!selected) { rejected++; continue; }
      const pinned = all(card, 'span, div').some(node => visible(node) && text(node) === '置顶' && !node.closest('a.title'));
      const note = { id: selected.id, url: selected.url, title: text(first(card, 'a.title')).slice(0, 160), pinned };
      const previous = notes.get(note.id);
      if (!previous || (!previous.url.includes('xsec_token=') && selected.token)) notes.set(note.id, note);
      else if (pinned) previous.pinned = true;
    }
    result.scan.limitReached = notes.size >= 50;
    result.notes = Array.from(notes.values()).slice(0, 50);
    if (!handle) result.missing.push('未读取到主页可见的小红书号');
    if (!result.notes.length) result.missing.push('当前主页尚无可读取的已加载笔记卡片');
    if (rejected) result.missing.push('部分卡片缺少可验证的实际笔记链接，已跳过');
    result.status = result.missing.length ? 'partial' : 'ready';
    return result;
  }
  const page = text(document.body).slice(0, 30000);
  if (/安全验证|访问过于频繁|操作过于频繁|访问异常|验证后继续|请完成验证/.test(page)) result.status = 'blocked';
  else if (first(document, '.login-container, .login-modal, .login-box') || /登录后查看|登录后浏览|手机号登录|扫码登录|请先登录/.test(page)) result.status = 'needs_login';
  result.missing.push(result.status === 'needs_login' ? '主页需要登录后读取' : result.status === 'blocked' ? '主页要求验证或暂时阻止访问' : '未定位到可读取的账号主页资料');
  return result;
}

function creatorSearch() {
  const result = { status: 'unavailable', candidates: [], missing: [], resolvedUrl: String(location.href || '') };
  let url; try { url = new URL(result.resolvedUrl); } catch {}
  if (!url || url.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443') || url.pathname !== '/search_result') {
    result.missing.push('搜索跳转到了非预期页面，已停止读取'); return result;
  }
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  const text = node => String(node?.innerText || '').trim();
  const tab = Array.from(document.querySelectorAll('.channel-scroll-container .channel')).find(node => visible(node) && text(node) === '用户');
  if (tab && !tab.classList.contains('active')) { tab.click(); result.status = 'loading'; return result; }
  if (tab) {
    const seen = new Set();
    for (const row of Array.from(document.querySelectorAll('.user-list-item')).filter(visible).slice(0, 4)) {
      const anchor = row.querySelector('a[href]') || row.closest('a[href]');
      try {
        const link = new URL(anchor?.href, url.href), match = link.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/?$/i);
        if (!match || link.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(link.hostname)
          || link.username || link.password || (link.port && link.port !== '443') || seen.has(match[1].toLowerCase())) continue;
        seen.add(match[1].toLowerCase());
        result.candidates.push({ profileUrl: link.href, id: match[1].toLowerCase(),
          name: text(row.querySelector('.user-name')).slice(0, 120),
          handle: (text(row).match(/小红书号\s*[:：]\s*([^\s]+)/)?.[1] || '').slice(0, 100) });
      } catch {}
    }
    if (result.candidates.length || /THE END|没有找到|暂无.*用户|无搜索结果/i.test(text(document.body))) { result.status = 'ready'; return result; }
  }
  const page = text(document.body).slice(0, 30000);
  if (/安全验证|访问过于频繁|操作过于频繁|访问异常|验证后继续|请完成验证/.test(page)) result.status = 'blocked';
  else if (Array.from(document.querySelectorAll('.login-container, .login-modal, .login-box')).some(visible) || /登录后查看|登录后浏览|手机号登录|扫码登录|请先登录/.test(page)) result.status = 'needs_login';
  else result.status = 'loading';
  return result;
}

export const creatorExtractScript = expectedId => `(${creatorPage.toString()})(${JSON.stringify(expectedId)})`;
export const creatorSearchScript = () => `(${creatorSearch.toString()})()`;
