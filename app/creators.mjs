import { id, now, InputError, str, validateSettings } from './content.mjs';
import { normalizeCreatorInput } from './creator-reader.mjs';
import { inspirationUrl } from './link-reader.mjs';

export const activeTask = task => ['queued','running'].includes(task.status);
export function creatorById(state,key,archived=false) {
  const creator=state.creators.find(c=>c.id===key);
  if(!creator)throw new InputError('博主不存在',404);
  if(creator.archived&&!archived)throw new InputError('博主已归档',409);
  return creator;
}
function creatorOptions(input,current={}) {
  const value={enabled:true,autoAnalyze:false,time:'09:00',timezone:'Asia/Shanghai',...current,...input};
  const settings=validateSettings({...value,mode:'review'});
  if(typeof value.autoAnalyze!=='boolean')throw new InputError('自动拆解设置不正确');
  return {enabled:settings.enabled,autoAnalyze:value.autoAnalyze,time:settings.time,timezone:settings.timezone};
}
function identity(input) {
  const value=str(input,12000,true);
  let parsed;try{parsed=normalizeCreatorInput(/https?:\/\//i.test(value)?{profileUrl:inspirationUrl(value)}:{handle:value});}catch(error){throw new InputError(error.message||'请输入博主主页链接或小红书号');}
  return {...parsed,input:value};
}
function uniqueCreator(state,value,except) {
  if(state.creators.some(c=>c.id!==except&&!c.archived&&((value.id&&c.profileId===value.id)
    ||(value.handle&&c.handle?.toLowerCase()===value.handle.toLowerCase()))))throw new InputError('这个博主已在列表中',409);
}
export function createCreator(state,input) {
  const source=identity(input.input);uniqueCreator(state,source);
  const creator={id:id(),input:source.input,name:source.handle||'待读取博主',handle:source.handle||'',profileUrl:source.profileUrl||'',
    profileId:source.id||'',...creatorOptions(input),archived:false,status:'pending',seenNoteIds:[],baselineAt:null,
    importedCount:0,lastDailyKey:null,lastSyncAt:null,lastError:null,createdAt:now(),updatedAt:now()};
  state.creators.unshift(creator);return creator;
}
export function updateCreator(state,key,input) {
  const creator=creatorById(state,key);
  if(input.input!==undefined&&input.input!==creator.input) {
    if(creator.baselineAt||state.creatorSyncs.some(j=>j.creatorId===key&&activeTask(j)))throw new InputError('已有同步记录的博主不能替换，请添加新博主',409);
    const source=identity(input.input);uniqueCreator(state,source,key);
    Object.assign(creator,{input:source.input,handle:source.handle||'',profileUrl:source.profileUrl||'',profileId:source.id||'',name:source.handle||'待读取博主',status:'pending'});
  }
  Object.assign(creator,creatorOptions(input,creator),{updatedAt:now()});
  if(!creator.enabled&&!state.creatorSyncs.some(j=>j.creatorId===key&&activeTask(j)))creator.status='paused';
  else if(creator.status==='paused'&&creator.enabled)creator.status='idle';
  return creator;
}
export function archiveCreator(state,key) {
  const creator=creatorById(state,key);
  Object.assign(creator,{archived:true,enabled:false,autoAnalyze:false,status:'paused',updatedAt:now()});
  for(const job of state.creatorSyncs.filter(j=>j.creatorId===key&&j.status==='queued'))Object.assign(job,{status:'failed',error:'博主已归档，未继续同步',completedAt:now()});
  for(const task of state.analysisTasks.filter(j=>j.creatorId===key&&j.status==='queued'))Object.assign(task,{status:'blocked',reason:'disabled',error:'博主已归档，未开始拆解',completedAt:now()});
  return creator;
}
export function queueCreatorSync(state,key,reason='manual') {
  const creator=creatorById(state,key);
  const current=state.creatorSyncs.find(j=>j.creatorId===key&&activeTask(j));if(current)return current;
  const job={id:id(),creatorId:key,status:'queued',reason,added:0,discovered:0,createdAt:now()};
  state.creatorSyncs.unshift(job);creator.status='syncing';return job;
}
