import { setTimeout as delay } from 'node:timers/promises';
import { sourceUrl, InputError } from './content.mjs';
import { browserExtractScript } from './xhs-page-extract.mjs';

const PAGE_HOSTS=new Set(['www.xiaohongshu.com','xiaohongshu.com','xhslink.com','www.xhslink.com','xhslink.cn','www.xhslink.cn']);
const PAGE_LIMIT=2*1024*1024, IMAGE_LIMIT=8*1024*1024, TOTAL_IMAGES=16*1024*1024;

export function inspirationUrl(input) {
  if(!input)return '';
  if(typeof input!=='string'||input.length>12000)throw new InputError('链接或分享内容过长');
  const links=input.replace(/\\&/g,'&').match(/https?:\/\/[^\s<>"'，。！？、；（）【】《》]+/g)||[];
  if(!links.length)throw new InputError('请粘贴完整链接或含链接的分享内容');
  const candidates=links.map(link=>link.replace(/[，。！？、）】》)\]}.,;；]+$/g,''));
  let selected=candidates.find(link=>{try{return PAGE_HOSTS.has(new URL(link).hostname);}catch{return false;}})||candidates[0];
  let parsed;try{parsed=new URL(selected);}catch{throw new InputError('请输入完整有效的链接');}
  if(parsed.protocol==='http:'&&PAGE_HOSTS.has(parsed.hostname))parsed.protocol='https:';
  return sourceUrl(parsed.href);
}

export function supportedPageUrl(input) {
  try {const u=new URL(input);return u.protocol==='https:'&&PAGE_HOSTS.has(u.hostname)&&!u.username&&!u.password&&(!u.port||u.port==='443');}
  catch{return false;}
}

export function supportedImageUrl(input) {
  try {
    const u=new URL(input);
    return u.protocol==='https:'&&(!u.port||u.port==='443')&&!u.username&&!u.password
      && (u.hostname.endsWith('.xhscdn.com')||u.hostname==='xhscdn.com'||u.hostname==='ci.xiaohongshu.com');
  }catch{return false;}
}

async function boundedBytes(response,limit) {
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel().catch(()=>{});throw new Error('response_limit');}
  const reader=response.body?.getReader();if(!reader)throw new Error('response_empty');
  const chunks=[];let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel().catch(()=>{});throw new Error('response_limit');}chunks.push(value);}
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks,length);
}

function proxyBase(env) {
  const u=new URL(env.REDPILOT_READER_PROXY_URL||'http://127.0.0.1:3456');
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new InputError('本地浏览器读取器地址配置不正确',409);
  return u.origin;
}

async function proxyCall(fetcher,base,route,{method='GET',script,timeout=20000}={}) {
  const response=await fetcher(base+route,{method,redirect:'error',signal:AbortSignal.timeout(timeout),
    ...(script?{headers:{'Content-Type':'text/plain; charset=utf-8'},body:script}:{})});
  if(!response.ok)throw new Error('browser_unavailable');
  const value=JSON.parse((await boundedBytes(response,PAGE_LIMIT)).toString('utf8'));
  if(value?.error)throw new Error('browser_unavailable');
  return value;
}

function imageExtension(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw new Error('image_format');
}

async function referenceImages(urls,fetcher) {
  const images=[],missing=[];let total=0;
  for(const url of [...new Set(urls)].slice(0,9)) {
    if(!supportedImageUrl(url)){missing.push('有图片来源不受支持，未下载');continue;}
    try {
      const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{Referer:'https://www.xiaohongshu.com/'}});
      if(!response.ok)throw new Error('image_unavailable');
      const bytes=await boundedBytes(response,Math.min(IMAGE_LIMIT,TOTAL_IMAGES-total));
      const ext=imageExtension(bytes);total+=bytes.length;
      images.push({name:`参考图片-${images.length+1}.${ext}`,data:bytes.toString('base64'),url});
      if(total>=TOTAL_IMAGES){missing.push('图片达到本次读取大小上限');break;}
    }catch{missing.push('部分笔记图片未能下载，正文已保留');}
  }
  if(urls.length>9)missing.push('当前只保存前 9 张笔记图片');
  return {images,missing:[...new Set(missing)]};
}

// Uses the existing local Chrome bridge. It creates and closes only its own tab,
// and reads rendered note DOM without cookies, storage or hidden application state.
export async function readReferenceLink({url},env=process.env,fetcher=fetch) {
  if(!supportedPageUrl(url))return {status:'unavailable',missing:[],error:'自动读取目前支持小红书笔记、账号及分享短链接'};
  let base,target;
  try {
    base=proxyBase(env);
    const created=await proxyCall(fetcher,base,'/new?url='+encodeURIComponent(url),{timeout:45000});
    target=created.targetId;
    if(typeof target!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(target))throw new Error('invalid_target');
    let result;
    for(let attempt=0;attempt<12;attempt++) {
      const before=await proxyCall(fetcher,base,'/info?target='+encodeURIComponent(target));
      if(!supportedPageUrl(before.url))return {status:'unavailable',missing:[],error:'链接跳转到了非小红书页面，已停止读取'};
      result=(await proxyCall(fetcher,base,'/eval?target='+encodeURIComponent(target),{method:'POST',script:browserExtractScript()})).value;
      if(result&&['ready','partial','needs_login','blocked'].includes(result.status))break;
      if(attempt<11)await delay(500);
    }
    const info=await proxyCall(fetcher,base,'/info?target='+encodeURIComponent(target));
    if(!supportedPageUrl(info.url))return {status:'unavailable',missing:[],error:'链接跳转到了非小红书页面，已停止读取'};
    if(!result||typeof result!=='object')throw new Error('empty_result');
    if(['needs_login','blocked','unavailable'].includes(result.status))return {...result,images:[],resolvedUrl:info.url};
    const media=await referenceImages(Array.isArray(result.imageUrls)?result.imageUrls:[],fetcher);
    const missing=[...new Set([...(Array.isArray(result.missing)?result.missing:[]),...media.missing])];
    return {...result,...media,missing,status:missing.length?'partial':result.status,resolvedUrl:info.url};
  }catch(error) {
    return {status:'unavailable',missing:[],error:error instanceof InputError?error.message:'浏览器读取器未连接或页面未能打开；请确认 Chrome 已连接后重读'};
  }finally {
    if(base&&typeof target==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(target))await proxyCall(fetcher,base,'/close?target='+encodeURIComponent(target),{timeout:5000}).catch(()=>{});
  }
}
