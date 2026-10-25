import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { browserExtractScript } from '../app/xhs-page-extract.mjs';

// Small DOM-only fixture: the extractor has no access to browser state or APIs.
function element(tag, options = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), className: options.className || '', id: options.id || '',
    hidden: options.hidden || false, style: options.style || {}, attributes: options.attributes || {},
    ownText: options.text || '', children, parentElement: null,
    src: options.src || '', currentSrc: options.currentSrc || '',
    naturalWidth: options.width ?? 1040, naturalHeight: options.height ?? 1512,
    box: { top: 10, left: 10, right: 510, bottom: 510, width: 500, height: 500, ...options.box },
    get innerText() { return [this.ownText, ...this.children.filter(child => !child.hidden && child.style.display !== 'none').map(child => child.innerText)].filter(Boolean).join('\n'); },
    getAttribute(name) { return name === 'class' ? this.className : name === 'id' ? this.id : this.attributes[name] ?? null; },
    getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [this.box]; },
    getBoundingClientRect() { return this.box; },
    querySelectorAll(selector) { return descendants(this).filter(candidate => selector.split(',').some(part => matches(candidate, part.trim()))); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    closest(selector) { for (let candidate = this; candidate; candidate = candidate.parentElement) if (selector.split(',').some(part => matches(candidate, part.trim()))) return candidate; return null; }
  };
  node.classList = { contains: name => node.className.split(/\s+/).includes(name) };
  for (const child of children) child.parentElement = node;
  return node;
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function simple(node, selector) {
  const tag = selector.match(/^[a-z][a-z\d-]*/i)?.[0];
  const id = selector.match(/#([\w-]+)/)?.[1];
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  return (!tag || node.tagName === tag.toUpperCase()) && (!id || node.id === id) && classes.every(name => node.classList.contains(name));
}
function matches(node, selector) {
  const parts = selector.split(/\s+/);
  if (!simple(node, parts.pop())) return false;
  let ancestor = node.parentElement;
  while (parts.length) {
    const part = parts.pop();
    while (ancestor && !simple(ancestor, part)) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}
const image = (name, extra = {}) => element('img', { src: `https://sns-webpic.example/${name}.png`, ...extra });
const slide = (index, images = [image(`page-${index}`)], extra = {}) => element('div', { className: 'swiper-slide', attributes: { 'data-swiper-slide-index': String(index) }, ...extra }, images);
function note({ title = '产品开发记录', body = '这是自己产品的可见正文。', author = '示例品牌', slides = [slide(0)], extra = [], titleOnly = false } = {}) {
  return element('div', { id: 'noteContainer', className: 'note-container' }, [
    element('div', { className: 'media-container' }, [element('div', { className: 'note-slider' }, slides)]),
    ...(!author ? [] : [element('div', { className: 'author-container' }, [element('a', { className: 'name', text: author })])]),
    element('div', { className: 'note-content' }, [element('h1', { id: 'detail-title', text: title }), ...(!titleOnly ? [element('div', { id: 'detail-desc', text: body })] : [])]),
    ...extra
  ]);
}
const noteUrl = 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=fixture-token';
function extract(nodes, url = noteUrl) {
  const body = element('body', {}, nodes);
  const document = { body, querySelectorAll: selector => body.querySelectorAll(selector) };
  Object.defineProperty(document, 'cookie', { get() { assert.fail('extractor read cookies'); } });
  const context = { document, location: { href: url }, URL, innerHeight: 1000, innerWidth: 1200,
    getComputedStyle: node => ({ display: node.style.display || 'block', visibility: node.style.visibility || 'visible', backgroundImage: node.style.backgroundImage || 'none' }) };
  for (const key of ['localStorage', 'sessionStorage', '__INITIAL_STATE__', 'fetch', 'XMLHttpRequest']) {
    Object.defineProperty(context, key, { get() { assert.fail(`extractor accessed ${key}`); } });
  }
  return JSON.parse(JSON.stringify(runInNewContext(browserExtractScript(), context)));
}

test('foreign or unsafe locations are rejected before any document or style access', () => {
  for (const href of [
    'https://evil.example/explore/0123456789abcdef01234567',
    'https://www.xiaohongshu.com.evil.example/explore/0123456789abcdef01234567',
    'https://sub.xiaohongshu.com/explore/0123456789abcdef01234567',
    'http://www.xiaohongshu.com/explore/0123456789abcdef01234567',
    'https://www.xiaohongshu.com:8443/explore/0123456789abcdef01234567',
    'https://user@www.xiaohongshu.com/explore/0123456789abcdef01234567',
    'https://user:password@xiaohongshu.com/explore/0123456789abcdef01234567',
    'javascript:document.body.innerText', 'not-a-url'
  ]) {
    const context = { location: { href }, URL };
    for (const key of ['document', 'getComputedStyle', 'innerHeight', 'innerWidth']) {
      Object.defineProperty(context, key, { get() { assert.fail(`unsafe page accessed ${key}`); } });
    }
    const value = JSON.parse(JSON.stringify(runInNewContext(browserExtractScript(), context)));
    assert.equal(value.kind, null);
    assert.equal(value.status, 'unavailable');
    assert.equal(value.title, '');
    assert.equal(value.text, '');
    assert.deepEqual(value.imageUrls, []);
    assert.deepEqual(value.missing, ['链接跳转到了非小红书页面，未读取内容']);
  }
});

test('both official HTTPS hosts and their explicit default port remain readable', () => {
  for (const origin of ['https://www.xiaohongshu.com', 'https://xiaohongshu.com', 'https://www.xiaohongshu.com:443', 'https://xiaohongshu.com:443']) {
    const value = extract([note()], `${origin}/explore/0123456789abcdef01234567`);
    assert.equal(value.kind, 'note');
    assert.equal(value.status, 'ready');
  }
});

test('extractor is an executable DOM expression and returns only the opened main note', () => {
  const main = note();
  const description = main.querySelector('#detail-desc');
  description.children.push(element('a', { className: 'tag', text: '#产品开发' }));
  description.children[0].parentElement = description;
  const value = extract([
    element('section', { className: 'note-item', text: '推荐流的不同标题和正文' }, [image('recommendation')]),
    main,
    element('div', { className: 'login-modal', text: '手机号登录' })
  ]);
  assert.equal(value.kind, 'note');
  assert.equal(value.status, 'ready');
  assert.equal(value.title, '产品开发记录');
  assert.equal(value.author, '示例品牌');
  assert.equal(value.text, '这是自己产品的可见正文。\n#产品开发');
  assert.deepEqual(value.tags, ['产品开发']);
  assert.deepEqual(value.imageUrls, ['https://sns-webpic.example/page-0.png']);
  assert.equal(value.canonicalUrl, noteUrl);
  assert.equal(value.resolvedUrl, noteUrl);
  assert.deepEqual(value.missing, []);
});

test('main carousel keeps real order, ignores duplicate slides, avatars, comment images and recommendations', () => {
  const main = note({ slides: [slide(2), slide(0, [image('page-0')]), slide(1), slide(0, [image('wrong-duplicate')], { className: 'swiper-slide swiper-slide-duplicate' })], extra: [
    element('div', { className: 'comment-container' }, [element('a', { className: 'name', text: '评论者' }), image('comment')]),
    element('div', { className: 'recommend-container' }, [image('recommendation')])
  ] });
  main.querySelector('.note-slider').children[1].children.push(element('div', { className: 'avatar-container' }, [image('avatar')]));
  const added = main.querySelector('.note-slider').children[1].children.at(-1);
  added.parentElement = main.querySelector('.note-slider').children[1];
  assert.deepEqual(extract([main]).imageUrls, [0, 1, 2].map(index => `https://sns-webpic.example/page-${index}.png`));
});

test('unloaded non-active carousel images use their existing DOM src and currentSrc takes precedence', () => {
  const value = extract([note({ slides: [slide(0, [image('fallback', { currentSrc: 'https://sns-webpic.example/current.webp' })]), slide(1, [image('lazy', { width: 0, height: 0 })])] })]);
  assert.deepEqual(value.imageUrls, ['https://sns-webpic.example/current.webp', 'https://sns-webpic.example/lazy.png']);
});

test('only main media backgrounds are considered, with a maximum of nine images', () => {
  const slides = Array.from({ length: 12 }, (_, index) => slide(index));
  slides[0] = slide(0, [element('div', { className: 'note-slider-img', style: { backgroundImage: 'url("https://sns-webpic.example/background.png")' } })]);
  const value = extract([note({ slides })]);
  assert.equal(value.imageUrls.length, 9);
  assert.equal(value.imageUrls[0], 'https://sns-webpic.example/background.png');
  assert.equal(value.imageUrls[8], 'https://sns-webpic.example/page-8.png');
  assert.equal(value.status, 'partial');
  assert.ok(value.missing.includes('配图最多保留前9张'));
});

test('a visible pagination total marks unloaded carousel images as missing', () => {
  const value = extract([note({ extra: [element('div', { className: 'slider-pagination-container', text: '1/7' })] })]);
  assert.equal(value.imageUrls.length, 1);
  assert.equal(value.status, 'partial');
  assert.ok(value.missing.includes('部分轮播配图尚未在DOM中加载'));
});

test('non-network, insecure, credential-bearing image sources and small decorations are excluded', () => {
  const value = extract([note({ slides: [slide(0, [
    image('valid'), image('small', { width: 32, height: 32 }),
    image('data', { src: 'data:image/png;base64,AAAA' }), image('script', { src: 'javascript:bad()' }),
    image('http', { src: 'http://sns-webpic.example/insecure.png' }),
    image('credentials', { src: 'https://user:password@sns-webpic.example/private.png' })
  ])] })]);
  assert.deepEqual(value.imageUrls, ['https://sns-webpic.example/valid.png']);
});

test('a video note is partial and explicitly states that video content was not transcribed', () => {
  const value = extract([note({ slides: [], extra: [element('video')] })]);
  assert.equal(value.kind, 'note');
  assert.equal(value.status, 'partial');
  assert.deepEqual(value.imageUrls, []);
  assert.ok(value.missing.some(message => message.includes('未转录视频内容')));
});

test('missing note fields are reported instead of using feed text as fallback', () => {
  const value = extract([note({ body: '', author: '' }), element('div', { text: '外部作者和推荐正文' })]);
  assert.equal(value.kind, 'note');
  assert.equal(value.status, 'partial');
  assert.equal(value.text, '');
  assert.equal(value.author, '');
  assert.ok(value.missing.some(message => message.includes('正文')));
  assert.ok(value.missing.some(message => message.includes('作者')));
});

test('feed cards without a main detail container never become a note', () => {
  const value = extract([element('section', { className: 'note-item' }, [element('a', { className: 'title', text: '推荐标题' }), image('feed')])]);
  assert.equal(value.kind, null);
  assert.equal(value.status, 'unavailable');
  assert.equal(value.title, '');
  assert.deepEqual(value.imageUrls, []);
});

test('login and verification pages return their specific gate status without extracting unrelated content', () => {
  const login = extract([element('div', { className: 'login-container', text: '手机号登录' })]);
  assert.equal(login.kind, null);
  assert.equal(login.status, 'needs_login');
  const blocked = extract([element('div', { text: '请完成验证，安全验证' })]);
  assert.equal(blocked.kind, null);
  assert.equal(blocked.status, 'blocked');
});

test('an error placeholder with detail selectors is not treated as a successfully extracted note', () => {
  const value = extract([note({ title: '笔记已删除', body: '内容不存在', author: '', slides: [] }), element('section', { className: 'note-item', text: '推荐内容' })]);
  assert.equal(value.kind, null);
  assert.equal(value.status, 'unavailable');
  assert.equal(value.title, '');
  assert.equal(value.text, '');
});

test('hidden note containers cannot supply content while a visible login wall is present', () => {
  const hidden = note(); hidden.style.display = 'none';
  const value = extract([hidden, element('div', { className: 'login-modal', text: '扫码登录' })]);
  assert.equal(value.kind, null);
  assert.equal(value.status, 'needs_login');
  assert.deepEqual(value.imageUrls, []);
});

test('profile extraction includes only visible profile fields and a few on-screen card summaries', () => {
  const cards = Array.from({ length: 5 }, (_, index) => element('section', { className: 'note-item', ...(index === 0 ? { box: { top: 2000, bottom: 2500 } } : {}) }, [
    element('a', { className: 'title', text: `可见卡片${index}` }),
    element('a', { className: 'cover' }, [image(`card-${index}`)]),
    element('div', { className: 'avatar-container' }, [image(`avatar-${index}`)]),
    ...(index === 1 ? [element('span', { className: 'play-icon' })] : [])
  ]));
  const profile = element('div', { id: 'userPageContainer' }, [
    element('div', { className: 'user-info' }, [element('div', { className: 'user-name', text: '示例账号' }), element('div', { className: 'user-desc', text: '记录产品开发进度' })]), ...cards
  ]);
  const value = extract([profile, element('div', { text: '站外无关正文' })], 'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567');
  assert.equal(value.kind, 'profile');
  assert.equal(value.status, 'partial');
  assert.equal(value.author, '示例账号');
  assert.ok(value.text.includes('卡片摘要（非正文）'));
  assert.equal(value.text.includes('可见卡片0'), false);
  assert.equal(value.text.includes('可见卡片4'), false);
  assert.deepEqual(value.imageUrls, [1, 2, 3].map(index => `https://sns-webpic.example/card-${index}.png`));
  assert.ok(value.missing.some(message => message.includes('未读取任何笔记全文')));
  assert.ok(value.missing.some(message => message.includes('未转录视频内容')));
});

test('a profile URL alone and a generic document title cannot manufacture profile evidence', () => {
  const value = extract([element('h1', { text: '示例账号 - 小红书' })], 'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567');
  assert.equal(value.kind, null);
  assert.equal(value.status, 'unavailable');
});

test('profile DOM under a note URL waits for the note modal instead of returning a profile snapshot', () => {
  const profile = element('div', { id: 'userPageContainer' }, [
    element('div', { className: 'user-info' }, [
      element('div', { className: 'user-name', text: '示例账号' }),
      element('div', { className: 'user-desc', text: '这是主页资料，不是笔记正文' })
    ]),
    element('section', { className: 'note-item' }, [
      element('a', { className: 'title', text: '底层主页卡片摘要' }),
      element('a', { className: 'cover' }, [image('profile-card')])
    ])
  ]);
  const author = '0123456789abcdef01234567', note = '1123456789abcdef01234567';
  for (const href of [
    `https://www.xiaohongshu.com/user/profile/${author}/${note}?xsec_token=fixture-token`,
    `https://www.xiaohongshu.com/explore/${note}?xsec_token=fixture-token`
  ]) {
    const value = extract([profile], href);
    assert.equal(value.kind, null);
    assert.equal(value.status, 'unavailable');
    assert.equal(value.title, '');
    assert.equal(value.text, '');
    assert.deepEqual(value.imageUrls, []);
  }
  const actualProfile = extract([profile], `https://www.xiaohongshu.com/user/profile/${author}`);
  assert.equal(actualProfile.kind, 'profile');
  assert.equal(actualProfile.status, 'partial');
  assert.equal(actualProfile.author, '示例账号');
  assert.ok(actualProfile.text.includes('底层主页卡片摘要'));
});
