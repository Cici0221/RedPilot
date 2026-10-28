import {id, now, InputError, str, validateDraft, checks} from './content.mjs';
import {selectedProductAssets} from './product-assets.mjs';

export const visibleDraft = draft => !draft.archivedAt && !draft.deletedAt;
const get = (items, key) => {const item=items.find(value=>value.id===key);if(!item)throw new InputError('记录不存在',404);return item;};
function selection(items, ids) {
  if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(value=>typeof value!=='string'))throw new InputError('请选择 1–100 项');
  return [...new Set(ids)].map(key=>get(items,key));
}
export function assertDraftEditable(state,draft) {
  if(draft.deletedAt)throw new InputError('草稿已移入回收站',409);
  if(draft.archivedAt)throw new InputError('请先恢复已归档草稿',409);
  if(state.jobs.some(job=>job.draftId===draft.id&&!['cancelled','failed'].includes(job.status)))throw new InputError('请先取消排期；已发布的内容可复制为新稿',409);
}
export function rememberDraft(draft,{kind='edit',at=now(),force=false}={}) {
  draft.history ||= [];
  // One continuous typing session is one undo point; image/AI/restoration changes always get their own version.
  if(!force&&kind==='edit'&&draft.lastHistoryKind==='edit'&&Date.parse(at)-Date.parse(draft.lastHistoryAt||0)<60000)return;
  draft.history.unshift({id:id(),at:draft.updatedAt||at,kind,title:draft.title,body:draft.body,tags:structuredClone(draft.tags||[]),slides:structuredClone(draft.slides||[]),contentMode:draft.contentMode,productAssetIds:[...(draft.productAssetIds||[])],gaps:[...(draft.gaps||[])],productVersion:draft.productVersion});
  draft.history=draft.history.slice(0,50);draft.lastHistoryAt=at;draft.lastHistoryKind=kind;
}
export function bulkDrafts(state,input) {
  if(!['archive','restore','trash'].includes(input.action))throw new InputError('草稿操作不正确');
  const drafts=selection(state.drafts,input.ids),at=now();
  for(const draft of drafts)if(input.action!=='restore'&&state.jobs.some(job=>job.draftId===draft.id&&['scheduled','blocked','publishing','uncertain'].includes(job.status)))throw new InputError('请先处理所选草稿的发布任务',409);
  if(input.action==='trash'&&drafts.some(draft=>draft.status==='published'))throw new InputError('已发布内容可以归档，不能移入回收站',409);
  for(const draft of drafts){
    if(input.action==='restore'){delete draft.archivedAt;delete draft.deletedAt;}
    else if(input.action==='archive')draft.archivedAt=at;
    else {if(draft.status==='published')throw new InputError('已发布内容可以归档，不能移入回收站',409);draft.deletedAt=at;}
    draft.revision++;draft.updatedAt=at;draft.approved=false;
  }
  return {items:drafts};
}
export function restoreDraftVersion(state,draftId,input) {
  const draft=get(state.drafts,draftId);assertDraftEditable(state,draft);
  if(input.revision!==draft.revision)throw new InputError('草稿已更新，请刷新后重试',409);
  const version=draft.history?.find(value=>(value.id||value.at)===input.versionId);
  if(!version)throw new InputError('历史版本不存在',404);
  const saved=structuredClone(version),data=validateDraft(saved);
  const assets=data.contentMode==='text'?[]:selectedProductAssets(state,saved.productAssetIds||[]).map(asset=>asset.id);
  rememberDraft(draft,{kind:'restore',force:true});
  Object.assign(draft,data,{productAssetIds:assets,gaps:saved.gaps||[],productVersion:saved.productVersion||draft.productVersion,approved:false,revision:draft.revision+1,updatedAt:now()});
  delete draft.gapReview;return draft;
}
export function editAsset(state,assetId,input) {
  const asset=get(state.productAssets,assetId);
  if('name'in input){asset.name=str(input.name,180,true);asset.metadata={...asset.metadata,renamed:true};}
  if('archived'in input){if(typeof input.archived!=='boolean')throw new InputError('素材状态不正确');if(input.archived)asset.archivedAt=now();else delete asset.archivedAt;}
  return asset;
}
export function bulkAssets(state,input) {
  if(!['archive','restore'].includes(input.action))throw new InputError('素材操作不正确');
  return {items:selection(state.productAssets,input.ids).map(asset=>editAsset(state,asset.id,{archived:input.action==='archive'}))};
}
export function rescheduleJob(state,jobId,input,date=new Date()) {
  const job=get(state.jobs,jobId),draft=get(state.drafts,job.draftId),at=new Date(input.scheduledAt);
  if(!['scheduled','blocked'].includes(job.status)||job.attempts>0)throw new InputError('此任务不能直接改期，请先核对发布结果',409);
  if(!Number.isFinite(+at)||at<=date)throw new InputError('请选择未来的发布时间');
  if(draft.revision!==job.draftRevision||!draft.approved)throw new InputError('草稿已变化，请重新确认内容',409);
  const issues=checks(draft,state.product,state.productAssets);if(issues.length)throw new InputError(issues.join('；'),409);
  Object.assign(job,{scheduledAt:at.toISOString(),status:'scheduled',error:null,reasonCode:null,updatedAt:now()});
  draft.status='scheduled';return job;
}
export function cancelGeneration(state,jobId) {
  const job=get(state.draftGenerationJobs,jobId);
  if(['queued','running'].includes(job.status))Object.assign(job,{status:'cancelled',phase:'cancelled',error:null,completedAt:now()});
  return job;
}
export function cancelDraftImages(state,draftId,batchId) {
  const draft=get(state.drafts,draftId),batch=batchId||draft.imageGeneration?.batchId;
  const jobs=state.imageJobs.filter(job=>job.draftId===draftId&&(!batch||job.batchId===batch));
  for(const job of jobs)if(['queued','generating'].includes(job.status))Object.assign(job,{status:'cancelled',error:null,completedAt:now()});
  if(draft.imageGeneration&&(!batch||draft.imageGeneration.batchId===batch))Object.assign(draft.imageGeneration,{status:'cancelled',error:null});
  return {jobs,draft};
}
