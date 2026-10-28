import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const clone=value=>structuredClone(value);
const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>clone(value)});
function fixture(){
  const draft=(id,title,extra={})=>({id,title,body:'独立正文 '+id,accountId:'official',contentMode:'image',productAssetIds:['cover'],tags:[],slides:[],gaps:[],referenceIds:[],sourceLinks:[],history:[],revision:1,productVersion:1,status:'draft',createdAt:'2026-10-27T00:00:00Z',updatedAt:'2026-10-27T01:00:00Z',...extra});
  const asset=(id,extra={})=>({id,name:id,kind:'image',mime:'image/png',fileUrl:'/api/product-assets/'+id+'/file',size:100,metadata:{},...extra});
  return {workspaceAccountId:'official',defaultAccountId:'official',accounts:[{id:'official',name:'人类补丁',enabled:true},{id:'secondary',name:'生活小号',enabled:true}],
    product:{name:'RingHi',brand:'人类补丁',facts:[],conditions:[],restrictions:[],sources:[],version:1},
    productAssets:[asset('cover'),asset('test-only',{metadata:{testOnly:true}}),asset('logo',{kind:'icon'})],
    drafts:[draft('d1','备用号的新安排'),draft('d2','出门少带一台手机',{contentMode:'text',productAssetIds:[],body:'工作号码和日常号码'}),draft('d3','周末旅行指南',{status:'scheduled'}),draft('d4','桌面里的小设备',{status:'published'}),draft('private','小号的私人稿',{accountId:'secondary'})],
    jobs:[{id:'schedule',draftId:'d3',accountId:'official',status:'scheduled',scheduledAt:'2026-10-28T01:00:00Z'},{id:'published',draftId:'d4',accountId:'official',status:'published',publishedAt:'2026-10-26T01:00:00Z'}],
    capabilities:{ai:true,accounts:{official:{publisher:false}}},imageProvider:{ready:false},imageJobs:[],draftGenerationJobs:[],draftChecks:{},inspirations:[],creators:[],discussions:[],events:[]};
}
function element(extra={}){return {innerHTML:'',hidden:false,textContent:'',open:false,dataset:{},classList:{add(){},remove(){},toggle(){}},close(){this.open=false;},querySelector(){return null;},querySelectorAll(){return [];},...extra};}
function ui({hash='#studio',state=fixture(),handle,storage=new Map()}={}){
  const requests=[],messages=[];
  const nodes={'#app':element(),'#modal':element(),'#modal-content':element(),'#toast':element(),'#draft-generation-status':element()};
  const context=vm.createContext({structuredClone,URL,Date,Intl,Math,AbortSignal,console,crypto:{randomUUID:()=>`request-${requests.length}`},setTimeout:()=>1,clearTimeout(){},confirm:()=>true,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    document:{querySelector:s=>nodes[s]||null,querySelectorAll:()=>[],activeElement:{id:''}},location:{hash,replace(){}},window:{scrollTo(){}},
    fetch:async(url,options={})=>{const request={url,method:options.method||'GET',headers:options.headers,body:options.body?JSON.parse(options.body):undefined};requests.push(request);const custom=await handle?.(request,state);if(custom)return custom;if(url==='/api/state')return reply(state);if(url==='/api/draft-generations'){const job={...request.body,id:'new-job',status:'running',phase:'generating'};state.draftGenerationJobs.unshift(job);return reply(job);}throw Error('Unexpected mock request '+url);}
  });
  vm.runInContext(definitions,context);context.initial=clone(state);context.notify=message=>messages.push(message);
  vm.runInContext("S=initial;workspaceId='official';accountFilter='official';toast=notify;render=()=>{};",context);
  return {run:code=>vm.runInContext(code,context),context,state,requests,messages,nodes,storage};
}

test('archive and trash are separate collections with restoration and bounded initial rendering',()=>{
  const state=fixture();state.drafts[1].archivedAt='2026-10-27';state.drafts[2].deletedAt='2026-10-27';
  for(let i=0;i<35;i++)state.drafts.push({...state.drafts[0],id:'extra-'+i,title:'草稿 '+i});
  const view=ui({state});let html=view.run('studio()');
  assert.doesNotMatch(html,/data-id="d2"|data-id="d3"/);assert.equal((html.match(/class="studio-draft-card"/g)||[]).length,24);assert.match(html,/data-action="studio-more"/);
  view.run("studioManage=true;studioFilter='archived'");html=view.run('studio()');assert.match(html,/data-id="d2"/);assert.doesNotMatch(html,/data-id="d1"|data-id="d3"/);
  view.run("studioFilter='trash'");html=view.run('studio()');assert.match(html,/data-action="draft-restore"[^>]*data-id="d3"/);assert.doesNotMatch(html,/data-action="edit"/);
});

test('bulk trash filters another account and undo restores only the captured workspace selection',async()=>{
  const view=ui({handle:(r,state)=>{if(r.url==='/api/drafts/bulk'){for(const d of state.drafts.filter(d=>r.body.ids.includes(d.id))){if(r.body.action==='trash')d.deletedAt='2026-10-28';else delete d.deletedAt;}return reply({updated:r.body.ids});}}});
  await view.run("updateDraftCollection(['d1','private'],'trash')");
  assert.deepEqual(view.requests.find(r=>r.url==='/api/drafts/bulk').body,{ids:['d1'],action:'trash'});assert.equal(view.run('studioDraftItems().some(d=>d.id==="d1")'),false);assert.match(view.nodes['#toast'].innerHTML,/撤销/);
  await view.run("handleUsabilityAction({dataset:{action:'collection-undo'}})");assert.equal(view.run('studioDraftItems().some(d=>d.id==="d1")'),true);
  view.run("undoAction={scope:'drafts',ids:['d1'],workspace:'secondary'}");const before=view.requests.length;await view.run("handleUsabilityAction({dataset:{action:'collection-undo'}})");assert.equal(view.requests.length,before);
});

test('generated assets group by draft, hide background layers and preserve explicit rename',()=>{
  const state=fixture();state.productAssets.push({id:'background',kind:'image',name:'internal-background',metadata:{internal:true}},{id:'generated',kind:'image',name:'AI-uuid.png',metadata:{aiGenerated:true,draftId:'d1'}},{id:'renamed',kind:'image',name:'我的封面',metadata:{aiGenerated:true,draftId:'d1',renamed:true}},{id:'archived',kind:'image',name:'archive-only',archivedAt:'2026-10-27',metadata:{}});
  const view=ui({state});view.run("assetFilter='generated'");const html=view.run('assetLibrary()');assert.match(html,/asset-draft-group/);assert.match(html,/备用号的新安排/);assert.match(html,/我的封面/);assert.doesNotMatch(html,/internal-background|archive-only|>AI-uuid.png</);
  view.run("assetQuery='我的封面'");assert.equal(view.run('assetLibraryItems().length'),1);view.run("assetQuery='';assetFilter='all';assetView='archived'");assert.equal(view.run('assetLibraryItems()[0].id'),'archived');
});

test('generation and image batches expose stop controls and use recorded elapsed time',()=>{
  const view=ui();view.run("beginStudioCreation({accountId:'official'},{jobId:'running'});S.draftGenerationJobs=[{id:'running',status:'running',phase:'generating',createdAt:new Date(Date.now()-65000).toISOString()}]");
  const html=view.run('studioCreationMarkup()');assert.match(html,/generation-cancel/);assert.match(html,/1 分 5 秒/);
  view.run("selected='d1';edit=structuredClone(S.drafts[0]);S.imageJobs=[{id:'ij',draftId:'d1',status:'generating',batchId:'batch',createdAt:new Date().toISOString()}]");assert.match(view.run('draftImageProgress()'),/draft-images-cancel/);
  view.run("S.draftGenerationJobs[0].status='cancelled'");assert.match(view.run('studioCreationMarkup()'),/aria-busy="false"/);assert.match(view.run('studioCreationMarkup()'),/已停止/);
});

test('rewrite stays on its current draft and sends its current revision and image identities',async()=>{
  const view=ui({hash:'#draft/d1'});view.run('studio()');view.nodes['#draft-rewrite-instruction']=element({value:'简短一点'});
  await view.run("submitDraftRewrite('d1')");const request=view.requests.find(r=>r.url==='/api/draft-generations');
  assert.equal(request.body.rewriteDraftId,'d1');assert.equal(request.body.revision,1);assert.deepEqual(request.body.productAssetIds,['cover']);assert.equal(view.run('selected'),'d1');assert.equal(view.run('studioView'),'draft');assert.equal(view.run('edit.productAssetIds[0]'),'cover');assert.match(view.run('draftRewriteMarkup(edit)'),/generation-cancel/);
});

test('today uses live statistics and tasks while historical reports remain snapshots',()=>{
  const view=ui();view.run("reportDate=todayReportDate();S.operationReports=[{id:'today',accountId:'official',date:reportDate,metrics:[{value:1}],plans:[{id:'old'}],discoveries:[]}];S.liveMetrics=[{value:9}];S.livePlans=[{id:'live',key:'draft:d1',title:'打开草稿',action:{type:'draft',id:'d1'}}]");
  assert.equal(view.run('currentDisplayReport().metrics[0].value'),9);assert.match(view.run('reportPlanMarkup(currentDisplayReport())'),/data-live-plan="draft:d1"/);
  view.run("reportDate='2020-01-01';S.operationReports[0].date=reportDate");assert.equal(view.run('currentDisplayReport().metrics[0].value'),1);
});

test('history restoration sends the current revision and stable version id',async()=>{
  const state=fixture();state.drafts[0].history=[{at:'2026-10-26T00:00:00Z',title:'上一版标题',body:'上一版正文',tags:['旧话题'],productAssetIds:['cover']}];
  const view=ui({hash:'#draft/d1',state,handle:(r)=>r.url==='/api/drafts/d1/restore'?reply({id:'d1'}):undefined});view.run('studio();modal=(title,sub,markup)=>{globalThis.historyHTML=markup}');view.run("draftHistoryModal('d1')");assert.match(view.context.historyHTML,/上一版正文|旧话题/);assert.match(view.context.historyHTML,/history-thumbnails/);
  await view.run("handleUsabilityAction({dataset:{action:'draft-history-restore',id:'d1',versionId:'2026-10-26T00:00:00Z'}})");assert.deepEqual(view.requests.find(r=>r.url.endsWith('/restore')).body,{revision:1,versionId:'2026-10-26T00:00:00Z'});
});

test('text controls require a clean layer and quality-review candidates cannot become main images',()=>{
  const view=ui({hash:'#draft/d1'});view.run('studio()');assert.doesNotMatch(view.run('studioImageMarkup()'),/draft-text-overlay/);
  view.run("S.productAssets[0].metadata={textOverlay:{version:1,layers:[]},backgroundAssetId:'bg'}");assert.match(view.run('studioImageMarkup()'),/draft-text-overlay|手机预览/);
  view.run("S.productAssets[0].metadata.quality={status:'rejected'};S.imageJobs=[{id:'bad',draftId:'d1',status:'completed',assetId:'cover',attachStatus:'quality_review'}]");assert.equal(view.run('draftPhotos(edit).length'),0);const html=view.run('draftImageProgress()');assert.match(html,/image-quality-recheck/);assert.doesNotMatch(html,/draft-image-adopt/);
});

test('state ETags are conditional, unchanged responses skip repaint and do not cross workspaces',async()=>{
  let hits=0;const view=ui({handle:(r,state)=>{if(r.url!=='/api/state')return;hits++;if(hits===1)return {...reply(state),headers:{get:()=> '"official-v1"'}};if(hits===2)return {status:304,ok:false,json:()=>{throw Error('304 body must not be read')}};return reply({...state,workspaceAccountId:'secondary'});}});
  view.run('globalThis.renders=0;render=()=>renders++');await view.run('refresh()');await view.run('refresh()');assert.equal(view.requests[1].headers['If-None-Match'],'"official-v1"');assert.equal(view.run('renders'),1);
  view.run("workspaceId='secondary';workspaceEpoch++");await view.run("api('state',undefined,'GET')");assert.equal(view.requests[2].headers['If-None-Match'],undefined);
});

test('reschedule opens only mutable tasks and preserves Beijing input format',()=>{
  const view=ui();view.run('modal=(title,sub,markup)=>{globalThis.dialogHTML=markup}');view.run("jobRescheduleModal('schedule')");assert.match(view.context.dialogHTML,/job-reschedule-form|北京时间/);view.context.dialogHTML='unchanged';view.run("jobRescheduleModal('published')");assert.equal(view.context.dialogHTML,'unchanged');
  assert.equal(view.run("calendarInputISO('2026-10-29T09:15')"),'2026-10-29T01:15:00.000Z');
});

test('clipboard image import stays scoped to the collection dialog',()=>{
  const paste=source.slice(source.indexOf("document.addEventListener('paste'"),source.indexOf("document.addEventListener('dragover'"));assert.match(paste,/upload-form/);assert.match(paste,/clipboardData/);assert.match(paste,/addFiles\(files\)/);assert.match(paste,/preventDefault/);
});

test('account login stays in the bottom menu and opens the specified isolated account',async()=>{
  const view=ui({handle:r=>r.url==='/api/accounts/official/open-login'?reply({status:'opened'}):undefined});
  const html=view.run('accountMenuMarkup()');assert.match(html,/account-open-login/);assert.doesNotMatch(html,/账号管理/);
  await view.run("performAction({dataset:{action:'account-open-login',id:'official'}})");
  const request=view.requests.find(r=>r.url.endsWith('/open-login'));assert.equal(request.headers['X-RedPilot-Account'],'official');assert.equal(request.method,'POST');assert.equal(request.body.isolated,true);
});

test('performance shows only observed counters with their real reporting period and has no made-up zeros',()=>{
  const view=ui();assert.doesNotMatch(view.run('performanceMarkup()'),/<strong>|今日浏览/);
  view.run("S.performance={workspaceAccountId:'official',accountId:'123456',period:{start:'2026-10-20',end:'2026-10-26'},summary:{views:1234,likes:0,impressions:null,comments:null,collects:5}}");
  const html=view.run('performanceMarkup()');assert.match(html,/2026-10-20 — 2026-10-26/);assert.match(html,/1,234/);assert.match(html,/赞/);assert.doesNotMatch(html,/曝光|评论/);assert.equal((html.match(/<strong>/g)||[]).length,3);
  view.run("S.performance.workspaceAccountId='secondary'");assert.equal(view.run('performanceMarkup()'),'');
});
