import {createHash} from 'node:crypto';
import {id,now,InputError,str,sourceUrl} from './content.mjs';
import {normalizeFeishuSource} from './feishu-reader.mjs';

const active=job=>['queued','running'].includes(job.status);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourceList=urls=>{
  if(!Array.isArray(urls)||urls.length>20)throw new InputError('飞书来源最多20个');
  return [...new Set(urls.map(normalizeFeishuSource))];
};
const productSourceList=urls=>{
  if(!Array.isArray(urls)||urls.length>20)throw new InputError('资料来源最多20个');
  return [...new Set(urls.map(value=>{
    const url=sourceUrl(str(value,2000,true));
    return /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/i.test(new URL(url).hostname)?normalizeFeishuSource(value):url;
  }))];
};
const feishuSources=urls=>(urls||[]).flatMap(url=>{try{return [normalizeFeishuSource(url)];}catch{return [];}});
function invalidateProduct(state){state.product.version=id();state.product.updatedAt=now();for(const draft of state.drafts)if(draft.status!=='published')draft.approved=false;}
export function alignFeishuSources(state){
  const current=state.feishuSync,sourceUrls=[...new Set(feishuSources(state.product.sources))];
  const changed=JSON.stringify(current.sourceUrls)!==JSON.stringify(sourceUrls);
  Object.assign(current,{enabled:false,nextSyncAt:null,sourceMode:'product',sourceUrls});delete current.intervalMinutes;
  if(changed){
    current.configVersion=id();current.lastError=null;if(current.status!=='syncing')current.status='idle';
    for(const doc of state.feishuDocuments)if(!docBelongsTo(doc,sourceUrls)){doc.stale=true;doc.status='unavailable';}
  }
  return current;
}
function saveProductSources(state,urls){
  const sources=productSourceList(urls);
  if(JSON.stringify(state.product.sources)!==JSON.stringify(sources)){state.product.sources=sources;invalidateProduct(state);}
  return alignFeishuSources(state);
}
export function initFeishu(state) {
  const current=state.feishuSync;
  // Migrate the former independent source form once, keeping its folder links.
  // Later restarts must not resurrect a source removed from the product form.
  if(current?.sourceMode!=='product'){
    const existing=(state.product.sources||[]).map(url=>{try{return normalizeFeishuSource(url);}catch{return url;}});
    state.product.sources=[...new Set([...existing,...feishuSources(current?.sourceUrls)])];
  }
  state.feishuSync={status:'idle',lastAttemptAt:null,lastSyncAt:null,lastError:null,configVersion:id(),...current};
  state.feishuDocuments ||= [];state.feishuJobs ||= [];
  alignFeishuSources(state);
  let interrupted=false;
  for(const job of state.feishuJobs)if(active(job)){Object.assign(job,{status:'failed',error:'服务已重启，请点击飞书同步重试',completedAt:now()});interrupted=true;}
  if(interrupted||state.feishuSync.status==='syncing'){
    state.feishuSync.status='failed';state.feishuSync.lastError='服务已重启，请点击飞书同步重试';
    for(const doc of state.feishuDocuments)if(docBelongsTo(doc,state.feishuSync.sourceUrls)){doc.stale=true;doc.status='unavailable';}
  }
}
export function updateFeishuSettings(state,input) {
  if('enabled'in input&&input.enabled!==false)throw new InputError('飞书资料仅支持点击同步');
  // Accept old clients saving a valid frequency, but never schedule a read.
  if('intervalMinutes'in input&&![15,60,360,1440].includes(input.intervalMinutes))throw new InputError('同步设置不正确');
  if('sourceUrls'in input){
    const sources=sourceList(input.sourceUrls),others=(state.product.sources||[]).filter(url=>!feishuSources([url]).length);
    return saveProductSources(state,[...others,...sources]);
  }
  return alignFeishuSources(state);
}
export function queueFeishuSync(state,input={},at=new Date()) {
  const sources=productSourceList('sourceUrls'in input?input.sourceUrls:state.product.sources);
  const urls=[...new Set(feishuSources(sources))];
  if(!urls.length)throw new InputError('请先添加飞书资料来源');
  const running=state.feishuJobs.find(active);
  if(running&&JSON.stringify(running.sourceUrls)!==JSON.stringify(urls))throw new InputError('同步进行中，请完成后重试',409);
  const settings=saveProductSources(state,sources);
  if(running)return running;
  const job={id:id(),status:'queued',reason:'manual',sourceUrls:[...settings.sourceUrls],configVersion:settings.configVersion,createdAt:at.toISOString()};
  state.feishuJobs.unshift(job);state.feishuJobs=state.feishuJobs.slice(0,50);
  settings.status='syncing';settings.lastAttemptAt=at.toISOString();settings.lastError=null;
  return job;
}
function docBelongsTo(d,urls){return urls.includes(d.url)||(d.sourceUrls||[]).some(url=>urls.includes(url));}
export function productForAI(state) {
  let remaining=24000;
  const sources=state.feishuDocuments.filter(d=>docBelongsTo(d,feishuSources(state.product.sources))).slice().sort((a,b)=>(b.changedAt||'').localeCompare(a.changedAt||''));
  const syncedSources=[];
  for(const doc of sources){
    if(!remaining)break;
    const limit=Math.min(8000,remaining),text=doc.text.slice(0,limit);remaining-=text.length;
    syncedSources.push({url:doc.url,title:doc.title,text,complete:doc.complete===true,stale:doc.stale===true,readAt:doc.readAt,contextTruncated:text.length<doc.text.length});
  }
  return {...state.product,syncedSources,syncedSourceCount:sources.length};
}
export function finishFeishuSync(state,job,result) {
  const settings=state.feishuSync,time=now();
  if(job.configVersion!==settings.configVersion){
    Object.assign(job,{status:'failed',error:'飞书来源已修改，本次旧来源结果未入库',completedAt:time});settings.status='idle';settings.lastError=job.error;settings.nextSyncAt=null;return;
  }
  const raw=result&&typeof result==='object'?result:{};
  const sourceResults=Array.isArray(raw.sources)?raw.sources.slice(0,20):[];
  const sources=job.sourceUrls.map(url=>{
    const value=sourceResults.find(v=>{try{return normalizeFeishuSource(v.url)===url;}catch{return false;}});
    return {url,status:['ready','partial','needs_login','blocked','unavailable'].includes(value?.status)?value.status:'unavailable',complete:value?.complete===true,error:typeof value?.error==='string'?value.error.slice(0,400):null};
  });
  const readDocs=[],seen=new Set();let added=0,changed=0,unchanged=0,incomplete=0;
  for(const input of (Array.isArray(raw.documents)?raw.documents:[]).slice(0,20)){
    let url,title,text;try{url=normalizeFeishuSource(input.url);title=str(input.title,300,true);text=str(input.text,60000,true);}catch{continue;}
    if(/\/drive\/folder\//.test(new URL(url).pathname)||seen.has(url))continue;
    const parents=Array.isArray(input.sourceUrls)?input.sourceUrls.flatMap(value=>{try{const source=normalizeFeishuSource(value);return job.sourceUrls.includes(source)?[source]:[];}catch{return [];}}):[];
    if(job.sourceUrls.includes(url))parents.push(url);
    if(!parents.length){const folders=job.sourceUrls.filter(root=>new URL(root).origin===new URL(url).origin&&/\/drive\/folder\//.test(new URL(root).pathname));if(folders.length===1)parents.push(folders[0]);}
    if(!parents.length)continue;
    seen.add(url);readDocs.push(url);
    const old=state.feishuDocuments.find(d=>d.url===url),complete=input.complete===true,contentHash=hash(title+'\n'+text);
    // A virtualized window or interrupted read must never replace a full snapshot.
    if(old?.complete&&!complete){old.stale=true;old.status='partial';old.lastAttemptAt=time;incomplete++;continue;}
    const differs=!old||old.contentHash!==contentHash||old.complete!==complete;
    if(!old)added++;else if(differs)changed++;else unchanged++;
    const doc=old||{id:id(),url,createdAt:time};
    Object.assign(doc,{title,text,contentHash,complete,readAt:validTime(input.readAt)?input.readAt:time,changedAt:differs?time:old.changedAt,lastAttemptAt:time,stale:false,status:complete?'ready':'partial',sourceUrls:[...new Set(parents)]});
    if(!old)state.feishuDocuments.unshift(doc);
    if(!complete)incomplete++;
  }
  // Missing documents are kept as old snapshots. No destructive deletion from a
  // partial folder window, a permission error, or a temporarily unavailable page.
  for(const doc of state.feishuDocuments.filter(d=>docBelongsTo(d,job.sourceUrls)))if(!readDocs.includes(doc.url)){doc.stale=true;doc.lastAttemptAt=time;doc.status='unavailable';}
  const readable=readDocs.length>0;
  const complete=readable&&incomplete===0&&sources.every(s=>s.status==='ready'&&s.complete);
  const failureStatus=['needs_login','blocked','unavailable'].includes(raw.status)?raw.status:'unavailable';
  settings.status=complete?'ready':readable?'partial':failureStatus;
  const sourceError=sources.find(s=>['needs_login','blocked','unavailable'].includes(s.status)&&s.error)?.error||sources.find(s=>s.error)?.error;
  settings.lastError=complete?null:sourceError||(typeof raw.error==='string'?raw.error.slice(0,400):readable?'部分资料未能完整读取，已保留可用快照':'未读取到飞书正文，请检查 Chrome 登录和文档权限');
  if(readable)settings.lastSyncAt=time;
  settings.sourceResults=sources;
  settings.nextSyncAt=null;
  Object.assign(job,{status:complete?'completed':readable?'partial':'failed',error:settings.lastError,added,changed,unchanged,incomplete,documentCount:readDocs.length,completedAt:time});
  if(added||changed){state.product.version=id();state.product.updatedAt=time;for(const draft of state.drafts)if(draft.status!=='published')draft.approved=false;}
}
