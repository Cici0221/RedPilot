import {createHash} from 'node:crypto';
import {id,now,InputError,str} from './content.mjs';
import {normalizeFeishuSource} from './feishu-reader.mjs';

const active=job=>['queued','running'].includes(job.status);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourceList=urls=>{
  if(!Array.isArray(urls)||urls.length>20)throw new InputError('飞书来源最多20个');
  return [...new Set(urls.map(normalizeFeishuSource))];
};
export function initFeishu(state) {
  const current=state.feishuSync;
  const defaults=(state.product.sources||[]).flatMap(url=>{try{return [normalizeFeishuSource(url)];}catch{return [];}});
  state.feishuSync={enabled:true,intervalMinutes:60,sourceUrls:defaults,status:'idle',lastAttemptAt:null,lastSyncAt:null,nextSyncAt:null,lastError:null,configVersion:id(),...current};
  state.feishuDocuments ||= [];state.feishuJobs ||= [];
  let interrupted=false;
  for(const job of state.feishuJobs)if(active(job)){Object.assign(job,{status:'failed',error:'服务已重启，请稍后同步',completedAt:now()});interrupted=true;}
  if(interrupted||state.feishuSync.status==='syncing'){
    state.feishuSync.status='failed';state.feishuSync.lastError='服务已重启，保留上次资料，下个周期再试';
    state.feishuSync.nextSyncAt=new Date(Date.now()+state.feishuSync.intervalMinutes*60000).toISOString();
    for(const doc of state.feishuDocuments)if(docBelongsTo(doc,state.feishuSync.sourceUrls)){doc.stale=true;doc.status='unavailable';}
  }
}
export function updateFeishuSettings(state,input) {
  const current=state.feishuSync,next={...current};
  if('enabled'in input){if(typeof input.enabled!=='boolean')throw new InputError('自动同步开关不正确');next.enabled=input.enabled;}
  if('intervalMinutes'in input){if(![15,60,360,1440].includes(input.intervalMinutes))throw new InputError('请选择15分钟、每小时、6小时或每天同步');next.intervalMinutes=input.intervalMinutes;}
  if('sourceUrls'in input)next.sourceUrls=sourceList(input.sourceUrls);
  const sourceChanged=JSON.stringify(next.sourceUrls)!==JSON.stringify(current.sourceUrls);
  if(sourceChanged){next.configVersion=id();next.nextSyncAt=null;next.lastError=null;if(next.status!=='syncing')next.status='idle';}
  if(!current.enabled&&next.enabled)next.nextSyncAt=null;
  if(next.intervalMinutes!==current.intervalMinutes&&!sourceChanged)next.nextSyncAt=new Date(Date.now()+next.intervalMinutes*60000).toISOString();
  state.feishuSync=next;
  if(sourceChanged){
    state.product.version=id();state.product.updatedAt=now();for(const d of state.drafts)if(d.status!=='published')d.approved=false;
    for(const doc of state.feishuDocuments)if(!docBelongsTo(doc,next.sourceUrls)){doc.stale=true;doc.status='unavailable';}
  }
  return next;
}
export function queueFeishuSync(state,reason='manual',at=new Date()) {
  const running=state.feishuJobs.find(active);if(running)return running;
  const settings=state.feishuSync;
  if(!settings.sourceUrls.length)throw new InputError('请先添加飞书资料来源');
  const job={id:id(),status:'queued',reason,sourceUrls:[...settings.sourceUrls],configVersion:settings.configVersion,createdAt:at.toISOString()};
  state.feishuJobs.unshift(job);state.feishuJobs=state.feishuJobs.slice(0,50);
  settings.status='syncing';settings.lastAttemptAt=at.toISOString();settings.nextSyncAt=new Date(at.valueOf()+settings.intervalMinutes*60000).toISOString();settings.lastError=null;
  return job;
}
export function feishuDue(state,date=new Date()) {
  const settings=state.feishuSync;
  return settings.enabled&&settings.sourceUrls.length>0&&!state.feishuJobs.some(active)&&(!validTime(settings.nextSyncAt)||Date.parse(settings.nextSyncAt)<=date.valueOf());
}
function docBelongsTo(d,urls){return urls.includes(d.url)||(d.sourceUrls||[]).some(url=>urls.includes(url));}
export function productForAI(state) {
  let remaining=24000;
  const sources=state.feishuDocuments.filter(d=>docBelongsTo(d,state.feishuSync.sourceUrls)).slice().sort((a,b)=>(b.changedAt||'').localeCompare(a.changedAt||''));
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
  settings.nextSyncAt=new Date(Date.now()+settings.intervalMinutes*60000).toISOString();
  Object.assign(job,{status:complete?'completed':readable?'partial':'failed',error:settings.lastError,added,changed,unchanged,incomplete,documentCount:readDocs.length,completedAt:time});
  if(added||changed){state.product.version=id();state.product.updatedAt=time;for(const draft of state.drafts)if(draft.status!=='published')draft.approved=false;}
}
