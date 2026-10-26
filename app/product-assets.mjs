import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, stat, open, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { id, now, InputError, str } from './content.mjs';
const run = promisify(execFile);
const TYPES = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'], '.svg': ['icon', 'image/svg+xml'], '.pdf': ['brochure', 'application/pdf'],
  '.step': ['model', 'model/step'], '.stp': ['model', 'model/step'], '.stl': ['model', 'model/stl'],
  '.glb': ['model', 'model/gltf-binary'], '.gltf': ['model', 'model/gltf+json'],
  '.obj': ['model', 'text/plain'], '.blend': ['model', 'application/octet-stream']
};
const MAX_FILE = 20 * 1024 * 1024;
export async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function validateSignature(ext, head) {
  const text = head.toString('utf8');
  let valid = false;
  if (ext === '.png') valid = head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  else if (ext === '.jpg' || ext === '.jpeg') valid = head[0] === 255 && head[1] === 216 && head[2] === 255;
  else if (ext === '.webp') valid = head.toString('ascii',0,4) === 'RIFF' && head.toString('ascii',8,12) === 'WEBP';
  else if (ext === '.pdf') valid = text.startsWith('%PDF-');
  else if (ext === '.step' || ext === '.stp') valid = /ISO-10303-21\s*;/i.test(text);
  else if (ext === '.glb') valid = head.toString('ascii',0,4) === 'glTF';
  else if (ext === '.blend') valid = head.toString('ascii',0,7) === 'BLENDER';
  else if (ext === '.gltf') { try { valid = Boolean(JSON.parse(text).asset?.version); } catch {} }
  else if (ext === '.obj') valid = /^(?:v|vn|vt|f|o|g)\s+.+/m.test(text);
  else if (ext === '.stl') valid = text.startsWith('solid') || head.length >= 84;
  else if (ext === '.svg') {
    valid = /<svg(?:\s|>)/i.test(text);
    if (/<script\b|<foreignObject\b|\bon[a-z]+\s*=|<!ENTITY|<!DOCTYPE|(?:href|xlink:href)\s*=\s*["'](?!#)|url\(\s*["']?(?!#|["']?#)/i.test(text)) {
      throw new InputError('SVG 包含脚本、事件或外部资源，不能导入');
    }
  }
  if (!valid) throw new InputError('文件内容与扩展名不一致，或文件格式不受支持');
}
async function inspectFile(filename, mode, requestedKind) {
  const resolved = await realpath(filename);
  const info = await stat(resolved);
  if (!info.isFile()) throw new InputError('只支持导入文件');
  const ext = path.extname(filename).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new InputError('不支持此素材格式');
  const [kind, mime] = type;
  if (requestedKind && requestedKind !== kind) throw new InputError('素材分类与文件格式不一致');
  if (kind === 'model' && mode !== 'linked') throw new InputError('3D 模型只保存本地引用，不复制源文件');
  if (kind !== 'model' && mode !== 'managed') throw new InputError('图片、图标与宣传册需要保存到本机素材库');
  if (kind !== 'model' && info.size > MAX_FILE) throw new InputError('单个素材不能超过 20MB');
  if (kind === 'model' && info.size > 1024 ** 3) throw new InputError('模型超过 1GB，请先提供轻量版模型');
  const file = await open(resolved, 'r');
  const head = Buffer.alloc(Math.min(info.size, kind === 'icon' || ext === '.gltf' ? MAX_FILE : 65536));
  try { await file.read(head,0,head.length,0); } finally { await file.close(); }
  validateSignature(ext, head);
  return { resolved, info, ext, kind, mime, head };
}
function dimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return {};
}
async function enrichBrochure(asset, filename, directory) {
  try {
    const { stdout } = await run('pdfinfo',[filename],{timeout:20000,maxBuffer:1024*1024});
    const pages=stdout.match(/^Pages:\s+(\d+)/m);
    if(pages)asset.metadata.pages=Number(pages[1]);
  } catch { asset.metadata.previewNote='PDF 解析工具未安装或文档无法读取，原文件已保存'; }
  try {
    const { stdout } = await run('pdftotext',['-layout','-enc','UTF-8',filename,'-'],{timeout:30000,maxBuffer:2*1024*1024});
    asset.metadata.extractedText=stdout.trim().slice(0,30000);
    asset.metadata.textScope='宣传册原文，仅作为来源资料，不自动当作已验证产品事实';
  } catch { asset.metadata.extractedText=''; }
  try {
    const prefix=path.join(directory,'product-assets','previews',asset.id);
    await run('pdftoppm',['-f','1','-singlefile','-scale-to','1200','-png',filename,prefix],{timeout:45000,maxBuffer:1024*1024});
    asset.previewName=asset.id+'.png';
    delete asset.metadata.previewNote;
  } catch { asset.metadata.previewNote='首页预览未生成，可下载原始 PDF'; }
}
export async function importProductAssets(state, directory, paths, mode='managed', names=[]) {
  if (!['managed','linked'].includes(mode)) throw new InputError('素材存储方式不正确');
  if (!Array.isArray(paths) || !paths.length || paths.length>30) throw new InputError('每次导入 1 至 30 个文件');
  const inspected=[];
  // Validate the whole batch before adding any records.
  for(const filename of paths) {
    str(filename,4096,true);
    if(!path.isAbsolute(filename))throw new InputError('导入文件需要绝对路径');
    try { inspected.push(await inspectFile(filename,mode)); }
    catch(e){if(e.status)throw e;throw new InputError('无法读取导入的文件，请确认文件仍在原位置');}
  }
  const base=path.join(directory,'product-assets');
  await mkdir(path.join(base,'files'),{recursive:true});
  await mkdir(path.join(base,'previews'),{recursive:true});
  const imported=[];
  for(let i=0;i<inspected.length;i++) {
    const f=inspected[i],sha256=await digest(f.resolved);
    const existing=state.productAssets.find(a=>a.sha256===sha256&&a.kind===f.kind);
    if(existing){imported.push(existing);continue;}
    const asset={id:id(),name:str(names[i]||path.basename(paths[i]),180,true),originalName:path.basename(paths[i]),kind:f.kind,
      mime:f.mime,size:f.info.size,sha256,storage:mode,createdAt:now(),metadata:{...dimensions(f.head)},
      description:f.kind==='model'?'完整模型源文件本地引用；渲染结果为几何示意，不代表实机验证':'用户提供的自有产品素材'};
    if(mode==='linked')asset.sourcePath=f.resolved;
    else {asset.fileName=sha256+f.ext;await copyFile(f.resolved,path.join(base,'files',asset.fileName));}
    asset.sourceLabel=path.basename(path.dirname(paths[i]))+'/'+path.basename(paths[i]);
    if(f.kind==='icon') {const t=f.head.toString('utf8');asset.metadata.vector=true;const label=t.match(/<title[^>]*>([^<]+)<\/title>/i);if(label)asset.description=label[1].slice(0,300);}
    if(f.kind==='brochure')await enrichBrochure(asset,path.join(base,'files',asset.fileName),directory);
    state.productAssets.push(asset);imported.push(asset);
  }
  return imported;
}
export async function uploadProductAsset(state,directory,input) {
  const name=str(input.name,180,true),ext=path.extname(name).toLowerCase();
  if(!['icon','image','brochure'].includes(input.kind)||TYPES[ext]?.[0]!==input.kind)throw new InputError('素材分类与文件格式不一致');
  let source;
  if(input.sourceAssetId!==undefined){
    if(input.kind!=='image'||typeof input.sourceAssetId!=='string')throw new InputError('调整来源必须是已有图片');
    source=state.productAssets.find(a=>a.id===input.sourceAssetId&&a.kind==='image');
    if(!source)throw new InputError('调整来源图片不存在，请重新选择');
  }
  const data=str(input.data,29*1024*1024,true);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw new InputError('素材编码不正确');
  const bytes=Buffer.from(data,'base64');
  if(!bytes.length||bytes.length>MAX_FILE)throw new InputError('单个素材不能超过 20MB');
  validateSignature(ext,bytes);
  const staging=path.join(directory,'product-assets','staging');await mkdir(staging,{recursive:true});
  const file=path.join(staging,id()+ext);await writeFile(file,bytes,{mode:0o600});
  try {
    const [asset]=await importProductAssets(state,directory,[file],'managed',[name]);
    asset.originalName=name;asset.sourceLabel='上传素材/'+name;
    if(source){
      asset.metadata ||= {};
      if(source.id!==asset.id)asset.metadata.adjustedFromAssetId=source.id;
      if(source.metadata?.testOnly===true)asset.metadata.testOnly=true;
      if(source.metadata?.aiGenerated===true)asset.metadata.aiGenerated=true;
      asset.description=source.metadata?.testOnly===true?'接口测试素材的手动调整，不是产品图片':'根据已有图片手动调整；不代表新增实拍或功能验证';
    }
    return asset;
  } finally { await unlink(file).catch(()=>{}); }
}
export function assetFile(asset,directory) {
  if(asset.storage==='linked')return asset.sourcePath;
  if(!/^[a-f\d]{64}\.[a-z0-9]+$/.test(asset.fileName||''))throw new InputError('素材文件无效',404);
  return path.join(directory,'product-assets','files',asset.fileName);
}
export async function readableAssetFile(asset,directory) {
  const filename=assetFile(asset,directory);
  try {
    const info=await stat(filename);
    if(!info.isFile())throw new InputError('素材源文件不可用',404);
    if(asset.storage==='linked'&&await digest(filename)!==asset.sha256)throw new InputError('模型源文件已改变，请重新关联后再渲染',409);
    return filename;
  }catch(e){if(e.status)throw e;throw new InputError('原始素材已移动或不可读取，请重新关联',404);}
}
export function publicAsset(asset,state) {
  const {sourcePath,fileName,previewName,previewAssetId,...safe}=asset;
  let previewUrl=null;
  if(['image','icon'].includes(asset.kind))previewUrl=`/api/product-assets/${asset.id}/file`;
  else if(asset.previewName)previewUrl=`/api/product-assets/${asset.id}/preview`;
  else if(asset.previewAssetId&&state.productAssets.some(a=>a.id===asset.previewAssetId))previewUrl=`/api/product-assets/${asset.previewAssetId}/file`;
  return {...safe,fileUrl:`/api/product-assets/${asset.id}/file`,previewUrl,
    renderable:asset.kind==='model'&&/\.(step|stp)$/i.test(asset.originalName),
    renderStatus:asset.kind==='model'&&/\.(step|stp)$/i.test(asset.originalName)?'ready':'unavailable'};
}
export function selectedProductAssets(state,ids=[]) {
  if(!Array.isArray(ids)||ids.length>9||ids.some(x=>typeof x!=='string'))throw new InputError('最多选择 9 个产品图片或图标');
  return [...new Set(ids)].map(key=>{
    const asset=state.productAssets.find(a=>a.id===key);
    if(!asset||!['image','icon'].includes(asset.kind))throw new InputError('所选产品素材不存在或不是图片/图标');
    return asset;
  });
}
export async function productVisionImages(assets,directory) {
  const parts=[];
  for(const asset of assets.filter(a=>a.kind==='image').slice(0,3)) {
    if(asset.size>8*1024*1024)continue;
    const filename=await readableAssetFile(asset,directory);
    parts.push({type:'image_url',image_url:{url:`data:${asset.mime};base64,${(await readFile(filename)).toString('base64')}`}});
  }
  return parts;
}
export async function runProductRender({modelPath,outputPath,preset,cacheDirectory},root,env=process.env) {
  await mkdir(path.dirname(outputPath),{recursive:true});
  try {
    await run(env.REDPILOT_PYTHON||'python3',[path.join(root,'app','render_product.py'),'--model',modelPath,'--output',outputPath,'--preset',preset,'--cache-dir',cacheDirectory],{timeout:900000,maxBuffer:2*1024*1024,env:{...process.env,...env}});
    return outputPath;
  }catch(e) {
    if(e.code==='ENOENT')throw new InputError('未找到 Python 渲染环境，请配置 REDPILOT_PYTHON',409);
    if(e.killed)throw new InputError('模型渲染超过 15 分钟，请稍后重试或使用轻量模型',409);
    const detail=String(e.stderr||e.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0,400);
    throw new InputError('渲染失败：'+detail,409);
  }
}
export function cleanRenderError(error,paths=[]) {
  let message=String(error.message||'模型渲染未完成');
  for(const p of paths.filter(Boolean))message=message.split(p).join('[本地文件]');
  return message.replace(/\/(?:Users|private|var|tmp|opt|Library|usr)\/[^\s'"),]+/g,'[本地路径]').slice(0,600);
}
