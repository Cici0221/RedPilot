import {id, now, InputError} from './content.mjs';

export const WORKSPACE_ARRAY_KEYS = Object.freeze([
  'inspirations','drafts','jobs','events','creators','creatorSyncs','analysisTasks',
  'productAssets','productRenders','imageJobs','draftGenerationJobs','topicPool',
  'discussions','operationReports','reportJobs','feishuDocuments','feishuJobs'
]);
export const WORKSPACE_KEYS = Object.freeze(['product','feishuSync',...WORKSPACE_ARRAY_KEYS]);
export const SHARED_WORKSPACE_KEYS = Object.freeze(['accounts','trendBoards','trendRefreshJobs','trendSchedule','schemaVersion','workspaceVersion']);

function account(root, accountId) {
  const value=root.accounts?.find(item=>item.id===accountId);
  if(!value)throw new InputError('账号不存在',404);
  return value;
}
function blankWorkspace(owner) {
  return {
    product:{name:'',brand:owner.name||'',stage:'',summary:'',facts:[],conditions:[],restrictions:[],sources:[],version:id(),updatedAt:now()},
    feishuSync:{enabled:false,nextSyncAt:null,sourceMode:'product',sourceUrls:[],status:'idle',lastAttemptAt:null,lastSyncAt:null,lastError:null,configVersion:id()},
    ...Object.fromEntries(WORKSPACE_ARRAY_KEYS.map(key=>[key,[]]))
  };
}
export function ensureWorkspace(root, accountId) {
  const owner=account(root,accountId);
  root.accountWorkspaces ||= {};
  let workspace=Object.hasOwn(root.accountWorkspaces,accountId)?root.accountWorkspaces[accountId]:null;
  if(!workspace||typeof workspace!=='object')workspace=root.accountWorkspaces[accountId]=blankWorkspace(owner);
  // Only fill missing fields: existing documents, settings and arrays stay intact.
  for(const key of WORKSPACE_ARRAY_KEYS)workspace[key] ||= [];
  if(!workspace.product)workspace.product=blankWorkspace(owner).product;
  if(!workspace.feishuSync)workspace.feishuSync=blankWorkspace(owner).feishuSync;
  return workspace;
}

function migrateLegacyData(root) {
  const defaultId=root.defaultAccountId,validIds=new Set(root.accounts.map(value=>value.id));
  const old=Object.fromEntries(WORKSPACE_KEYS.map(key=>[key,root[key]]));
  root.accountWorkspaces ||= {};
  for(const owner of root.accounts)ensureWorkspace(root,owner.id);
  const defaultWorkspace=ensureWorkspace(root,defaultId);
  if(old.product)defaultWorkspace.product=structuredClone(old.product);
  if(old.feishuSync)defaultWorkspace.feishuSync=structuredClone(old.feishuSync);
  const records=Object.fromEntries(WORKSPACE_ARRAY_KEYS.map(key=>[key,new Map((old[key]||[]).filter(item=>item?.id).map(item=>[item.id,item]))]));
  const explicitOwner=item=>validIds.has(item?.accountId)?item.accountId:validIds.has(item?.metadata?.accountId)?item.metadata.accountId:null;
  function ownerOf(item) {
    const explicit=explicitOwner(item);if(explicit)return explicit;
    for(const [field,collection] of [['draftId','drafts'],['referenceId','inspirations'],['creatorId','creators'],['assetId','productAssets']]) {
      const linked=records[collection].get(item?.[field]),owner=explicitOwner(linked);
      if(owner)return owner;
    }
    return defaultId;
  }
  function add(key,item,accountId) {
    const list=ensureWorkspace(root,accountId)[key];
    if(item?.id&&list.some(value=>value.id===item.id))return;
    const copy=structuredClone(item);
    if(copy&&typeof copy==='object'){
      copy.accountId=accountId;
      if(key==='inspirations'&&Array.isArray(copy.accountIds))copy.accountIds=[accountId];
    }
    list.push(copy);
  }
  for(const key of WORKSPACE_ARRAY_KEYS)for(const item of old[key]||[]) {
    const owners=key==='inspirations'&&!explicitOwner(item)&&Array.isArray(item.accountIds)?item.accountIds.filter(value=>validIds.has(value)):[];
    for(const owner of owners.length?[...new Set(owners)]:[ownerOf(item)])add(key,item,owner);
  }
  // Earlier versions shared the material library. Keep only materials actually
  // referenced by an existing account's drafts/jobs, as independent records.
  for(const owner of root.accounts) {
    const workspace=ensureWorkspace(root,owner.id);
    const references=new Set(),assets=new Set();
    const collect=value=>{
      if(!value||typeof value!=='object')return;
      for(const key of ['referenceIds'])for(const entry of value[key]||[])references.add(entry);
      if(value.referenceId)references.add(value.referenceId);
      for(const key of ['productAssetIds','sourceAssetIds'])for(const entry of value[key]||[])assets.add(entry);
      for(const key of ['assetId','imageAssetId','replaceAssetId'])if(value[key])assets.add(value[key]);
    };
    for(const draft of workspace.drafts){collect(draft);for(const revision of draft.history||[])collect(revision);}
    for(const key of ['draftGenerationJobs','imageJobs','productRenders','analysisTasks','topicPool','discussions'])for(const value of workspace[key]){
      collect(value);collect(value.request);
      for(const source of value.sources||[])if(source.kind==='reference'&&source.id)references.add(source.id);
    }
    for(const refId of references){const reference=records.inspirations.get(refId);if(reference)add('inspirations',reference,owner.id);}
    for(const asset of workspace.productAssets)assets.add(asset.id);
    for(const assetId of assets) {
      const material=records.productAssets.get(assetId);if(!material)continue;
      add('productAssets',material,owner.id);
      if(material.previewAssetId)assets.add(material.previewAssetId);
      if(material.metadata?.modelAssetId)assets.add(material.metadata.modelAssetId);
      for(const linked of material.metadata?.sourceAssetIds||[])assets.add(linked);
    }
  }
  for(const key of WORKSPACE_KEYS)delete root[key];
}

export function migrateWorkspaces(root) {
  if(root.workspaceVersion!==1)migrateLegacyData(root);
  for(const owner of root.accounts)ensureWorkspace(root,owner.id);
  root.trendBoards ||= [];root.trendRefreshJobs ||= [];
  root.workspaceVersion=1;root.schemaVersion=Math.max(4,Number(root.schemaVersion)||0);
  // Settings belong to account records; avoid stale legacy top-level aliases.
  delete root.settings;delete root.lastDailyKey;
  return root;
}

// A plain object with accessors remains structured-cloneable. Each getter resolves
// the current root so a previously obtained view survives a transaction rollback.
export function workspaceView(getRoot, accountId) {
  ensureWorkspace(getRoot(),accountId);
  const view={};
  for(const key of SHARED_WORKSPACE_KEYS)Object.defineProperty(view,key,{enumerable:true,
    get:()=>getRoot()[key],set:value=>{getRoot()[key]=value;}});
  for(const key of WORKSPACE_KEYS)Object.defineProperty(view,key,{enumerable:true,
    get:()=>ensureWorkspace(getRoot(),accountId)[key],set:value=>{ensureWorkspace(getRoot(),accountId)[key]=value;}});
  Object.defineProperties(view,{
    workspaceAccountId:{enumerable:true,get:()=>accountId},
    defaultAccountId:{enumerable:true,get:()=>accountId,set:value=>{account(getRoot(),value);getRoot().defaultAccountId=value;}},
    settings:{enumerable:true,get:()=>account(getRoot(),accountId).settings,set:value=>{account(getRoot(),accountId).settings=value;}},
    lastDailyKey:{enumerable:true,get:()=>account(getRoot(),accountId).lastDailyKey,set:value=>{account(getRoot(),accountId).lastDailyKey=value;}}
  });
  return view;
}
