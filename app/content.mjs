export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export function str(value, max = 2000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InputError(`文本不能为空，且不能超过 ${max} 个字符`);
  return value.trim();
}
export function lines(value, max = 30) {
  if (!Array.isArray(value) || value.length > max) throw new InputError('列表格式不正确');
  return value.map(x => str(x, 2000, true));
}
export function sourceUrl(value) {
  if (!value) return '';
  let u; try { u = new URL(str(value, 4000)); } catch { throw new InputError('请输入完整的 https 链接'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new InputError('仅支持不含账号密码的 https 链接');
  return u.href;
}
export function noteKey(url) {
  if (!url) return null;
  const u = new URL(url);
  if (u.hostname === 'www.xiaohongshu.com' || u.hostname === 'xiaohongshu.com') {
    const extended = u.pathname.match(/^\/user\/profile\/[a-f\d]{24}\/([a-f\d]{24})(?:\/|$)/i);
    if (extended) return `explore:${extended[1].toLowerCase()}`;
    const m = u.pathname.match(/^\/(explore|discovery\/item|user\/profile)\/([a-f\d]{24})(?:\/|$)/i);
    if (m) return `${m[1]==='user/profile'?'user/profile':'explore'}:${m[2].toLowerCase()}`;
  }
  return u.origin + u.pathname + u.search;
}
export function validateProduct(p) {
  return { name: str(p.name, 80, true), brand: str(p.brand, 80, true), stage: str(p.stage, 500, true),
    summary: str(p.summary, 5000, true), facts: lines(p.facts), conditions: lines(p.conditions),
    restrictions: lines(p.restrictions), sources: lines(p.sources, 20).map(sourceUrl), version: id(), updatedAt: now() };
}
export function contentMode(value = 'image') {
  if (!['text', 'image'].includes(value)) throw new InputError('稿件类型不正确');
  return value;
}
export function validateDraft(d) {
  const mode = contentMode(d.contentMode);
  return { contentMode: mode, title: str(d.title, 80, true), body: str(d.body, 8000, true), tags: lines(d.tags, 10),
    series: str(d.series ?? '', 80),
    slides: (() => {
      if (mode === 'text') return [];
      const slides = d.slides ?? [];
      if (!Array.isArray(slides) || slides.length > 9) throw new InputError('图片策划最多 9 页');
      return slides.map(s => ({ headline: str(s.headline, 120, true), body: str(s.body || '', 1500) }));
    })(), gaps: lines(d.gaps || [], 20) };
}
export function imageRole(asset, assets = []) {
  if (asset?.kind !== 'image') return null;
  const byId = new Map(assets.map(value => [value.id, value]));
  const pending = [asset], seen = new Set();
  // Test provenance survives both manual adjustments and AI source chains.
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current.metadata?.testOnly === true) return 'test';
    const parents = [current.metadata?.adjustedFromAssetId, ...(Array.isArray(current.metadata?.sourceAssetIds) ? current.metadata.sourceAssetIds : [])];
    for (const key of parents) if (byId.has(key)) pending.push(byId.get(key));
  }
  seen.clear();
  for (let current = asset; current && !seen.has(current); current = byId.get(current.metadata?.adjustedFromAssetId)) {
    seen.add(current);
    if (current.metadata?.previewOnly === true) return 'modelPreview';
    if (current.metadata?.usage === 'publication') return 'publication';
    if (current.metadata?.modelAssetId) return 'modelPreview';
  }
  return 'image';
}
export function isPublishableImage(asset, assets = []) { return ['image', 'publication'].includes(imageRole(asset, assets)); }
export function isAutomaticImage(asset, assets = []) {
  if (!isPublishableImage(asset, assets)) return false;
  const byId = new Map(assets.map(value => [value.id, value])), seen = new Set();
  for (let current = asset; current && !seen.has(current); current = byId.get(current.metadata?.adjustedFromAssetId)) {
    seen.add(current);
    if (current.metadata?.draftId || current.metadata?.reusable === false) return false;
  }
  return true;
}
export function checks(d, product, assets = []) {
  const problems = [];
  if (d.productVersion !== product.version) problems.push('产品资料已更新，请重新生成或核对后保存草稿');
  if ([...d.title].length > 20) problems.push('标题超过 20 字，请缩短');
  if ([...d.body].length > 1000) problems.push('正文超过 1000 字，请精简');
  if (d.contentMode !== 'text') {
    const selected = (d.productAssetIds || []).map(key => assets.find(asset => asset.id === key));
    if (!selected.some(asset => isPublishableImage(asset, assets))) problems.push('请至少选择一张真实产品图作为主图');
    if (selected.some(asset => imageRole(asset, assets) === 'test')) problems.push('测试图片不能用于发布，请更换产品成品图');
    if (selected.some(asset => imageRole(asset, assets) === 'modelPreview')) problems.push('3D 模型预览图不能直接发布，请先制作成品配图');
  }
  if (d.gaps?.length) problems.push(...d.gaps);
  // Only the title and body are published copy. Legacy storyboard notes stay
  // readable in saved drafts but cannot add promises or satisfy disclosures.
  const text = `${d.title}\n${d.body}`;
  const promises = /零延迟|永不漏接|全运营商|全机型|零漫游|双卡同时在线|正式发售|已售\d+|100%/g;
  const claims = [...text.matchAll(promises)].filter(match => {
    const prefix = text.slice(0, match.index).split(/[。！？；;，,\n]/).at(-1);
    // Only explicit, immediately preceding denials are exempt. Questions,
    // double negatives and a later positive repetition still require review.
    const denial = prefix.match(/(?:并非|并不是|不是|尚未|暂未|还未|未曾|未|不代表|不等于|不承诺|不能承诺|不保证|无法保证|不支持|不能宣称|不宣称)\s*[“「『"]?\s*$/);
    if (!denial) return true;
    return /(?:并非|并不是|不是|不代表|不等于|不承诺|不能承诺|不保证|无法保证|不支持|不能宣称|不宣称|不|未)\s*$/.test(prefix.slice(0, denial.index));
  }).map(match => match[0]);
  if (claims.length) problems.push('请核对宣传表述的依据：'+[...new Set(claims)].join('、'));
  if (!text.includes(product.stage) && !text.includes('内测')) problems.push('请补充当前产品阶段说明');
  return [...new Set(problems)];
}
export function templateDraft(product, reference, instruction = '', mode = 'image') {
  contentMode(mode);
  const name = product.name;
  const custom = instruction.trim();
  return { contentMode: mode, title: `${name}，先聊聊你的使用场景`, series: '',
    body: `我们是${product.brand}，正在做 ${name}。\n\n${product.summary}\n\n资料中记录的方向：\n${product.facts.map(x=>'· '+x).join('\n')}\n\n先说清条件：\n${product.conditions.map(x=>'· '+x).join('\n')}\n\n当前阶段：${product.stage}。具体表现需要以当前实机测试为准。\n\n你最想解决哪种通信困扰？可以只讲场景，不用留下号码。`,
    tags: [name, '产品开发', '内测意向'], slides: [], gaps: [], method: 'template', referenceIds: reference ? [reference.id] : [],
    adaptation: custom ? `你的要求「${custom}」已保存。当前为本地事实模板，尚未用 AI 执行风格改写。` : '本地事实模板；未执行 AI 风格分析或改写。', instruction: custom };
}
export function dateParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date).map(p=>[p.type,p.value]));
}
export function dailyKey(date, timezone) { const p = dateParts(date, timezone); return `${p.year}-${p.month}-${p.day}`; }
export function validateSettings(s) {
  const timezone = str(s.timezone, 80, true); try { dateParts(new Date(), timezone); } catch { throw new InputError('时区不正确，请填写 IANA 时区'); }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new InputError('时间格式应为 HH:mm');
  if (!['automatic','review'].includes(s.mode)) throw new InputError('发布模式不正确');
  if (typeof s.enabled !== 'boolean') throw new InputError('启用状态不正确');
  const imageShare = s.imageShare === undefined ? 70 : s.imageShare;
  if (!Number.isInteger(imageShare) || imageShare < 0 || imageShare > 100) throw new InputError('图文占比应为 0 至 100 的整数');
  return { enabled:s.enabled, timezone, time:s.time, mode:s.mode, imageShare };
}
