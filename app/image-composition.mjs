import { InputError } from './content.mjs';

const COLORS = /^#[a-f\d]{6}$/i;
const WEIGHTS = new Set([400,500,600,700,800,900]);
const ALIGNS = new Set(['left','center','right']);
const FONTS = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
const MAX_BYTES = 20 * 1024 * 1024;
const number = (value,min,max,label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new InputError(`${label}超出可用范围`);
  return value;
};

/** Accept data only; no SVG, CSS, markup or external font/image URLs may enter a layer. */
export function validateTextOverlay(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) throw new InputError('图片文字格式不正确');
  const width = number(input.width,320,4096,'图片宽度'), height = number(input.height,320,4096,'图片高度');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 12_000_000) throw new InputError('图片尺寸过大');
  if (!Array.isArray(input.layers) || input.layers.length > 6) throw new InputError('最多添加 6 个文字区');
  const seen = new Set();
  const layers = input.layers.map((layer,index) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) || typeof layer.text !== 'string' || [...layer.text].length > 220 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(layer.text)) throw new InputError('图片文字内容不正确');
    const id = typeof layer.id === 'string' && /^[a-z\d_-]{1,60}$/i.test(layer.id) ? layer.id : `text-${index + 1}`;
    if (seen.has(id)) throw new InputError('文字区标识重复'); seen.add(id);
    const color = layer.color || '#152238', align = layer.align || 'left', fontWeight = layer.fontWeight ?? 700;
    if (!COLORS.test(color) || !ALIGNS.has(align) || !WEIGHTS.has(fontWeight)) throw new InputError('图片文字样式不正确');
    const fontSize = number(layer.fontSize ?? 64,20,180,'字号');
    const lineHeight = number(layer.lineHeight ?? 1.25,1,2,'行距');
    const x = number(layer.x ?? 72,0,width,'文字位置'), y = number(layer.y ?? 100,0,height-fontSize,'文字位置');
    const maxWidth = number(layer.maxWidth ?? width-144,60,width,'文字宽度');
    const left = align === 'left' ? x : align === 'center' ? x-maxWidth/2 : x-maxWidth;
    if (left < 0 || left+maxWidth > width) throw new InputError('文字超出图片边缘');
    const maxLines = number(layer.maxLines ?? 6,1,8,'文字行数');
    if (!Number.isInteger(maxLines)) throw new InputError('文字行数不正确');
    return {id,text:layer.text.replace(/\r\n?/g,'\n').trim(),x,y,fontSize,color:color.toLowerCase(),fontWeight,align,maxWidth,lineHeight,maxLines};
  });
  if (layers.reduce((sum,layer)=>sum+[...layer.text].length,0)>660) throw new InputError('图片文字过多，请精简后保存');
  return {version:1,width,height,layers};
}

export function wrapOverlayText(context,text,maxWidth) {
  const rows = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const char of [...paragraph]) {
      if (line && context.measureText(line+char).width > maxWidth) { rows.push(line); line = char.trimStart(); }
      else line += char;
    }
    rows.push(line.trimEnd());
  }
  return rows;
}

/** The result is a fresh raster plus the normalized editable overlay; source bytes never change. */
export async function composeImage(backgroundBytes,input,{canvasModule}={}) {
  const overlay = validateTextOverlay(input);
  if (!(backgroundBytes instanceof Uint8Array) || !backgroundBytes.length || backgroundBytes.length > MAX_BYTES) throw new InputError('背景图片不可用');
  let renderer = canvasModule;
  try { renderer ||= await import('@napi-rs/canvas'); }
  catch { throw new InputError('图片排版组件未安装，请更新服务依赖',409); }
  let source;
  try { source = await renderer.loadImage(Buffer.from(backgroundBytes)); }
  catch { throw new InputError('背景图片无法读取',422); }
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width < 1 || source.height < 1 || source.width*source.height > 50_000_000) throw new InputError('背景图片尺寸不受支持');
  const canvas = renderer.createCanvas(overlay.width,overlay.height), context = canvas.getContext('2d');
  const scale = Math.max(overlay.width/source.width,overlay.height/source.height);
  context.drawImage(source,(overlay.width-source.width*scale)/2,(overlay.height-source.height*scale)/2,source.width*scale,source.height*scale);
  const boxes = [];
  for (const layer of overlay.layers.filter(layer=>layer.text)) {
    context.font = `${layer.fontWeight} ${layer.fontSize}px ${FONTS}`;
    context.textBaseline = 'top'; context.textAlign = layer.align; context.fillStyle = layer.color;
    const rows = wrapOverlayText(context,layer.text,layer.maxWidth);
    if (rows.length > layer.maxLines || layer.y+rows.length*layer.fontSize*layer.lineHeight > overlay.height-24) throw new InputError('图片文字放不下，请缩短文字或调整字号',422);
    const actualWidth = Math.max(...rows.map(row=>context.measureText(row).width),0);
    const left = layer.align==='left'?layer.x:layer.align==='center'?layer.x-actualWidth/2:layer.x-actualWidth;
    const box = {x:left,y:layer.y,width:actualWidth,height:rows.length*layer.fontSize*layer.lineHeight};
    if (boxes.some(other=>box.x<other.x+other.width&&box.x+box.width>other.x&&box.y<other.y+other.height&&box.y+box.height>other.y)) throw new InputError('两处文字重叠，请调整位置',422);
    boxes.push(box);
    rows.forEach((row,index)=>context.fillText(row,layer.x,layer.y+index*layer.fontSize*layer.lineHeight));
  }
  let bytes;
  try { bytes = await canvas.encode('png'); } catch { bytes = canvas.toBuffer('image/png'); }
  if (bytes.length>MAX_BYTES) throw new InputError('合成图片超过大小限制');
  return {bytes:Buffer.from(bytes),mime:'image/png',extension:'png',width:overlay.width,height:overlay.height,overlay};
}
