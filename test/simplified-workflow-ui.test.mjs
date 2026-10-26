import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const listeners=source.slice(source.indexOf("document.addEventListener('click'"),source.indexOf("window.addEventListener('pageshow'"));
const clone=value=>structuredClone(value);
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>clone(value)});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});return {promise,resolve,reject};}
function fixture(){
  const settings={enabled:true,time:'09:00',timezone:'Asia/Shanghai',mode:'review',imageShare:70};
  const draft=(id,accountId='official')=>({id,accountId,title:'草稿 '+id,body:'产品事实正文',tags:['产品'],gaps:[],slides:[{title:'UNIQUE_LEGACY_STORYBOARD',body:'旧分镜正文'}],series:'UNIQUE_LEGACY_SERIES',productAssetIds:['photo'],referenceIds:['pending'],sourceLinks:[],revision:1,status:'draft',contentMode:'image',method:'ai',approved:false,productVersion:1,history:[],createdAt:'2026-10-26T01:00:00Z',updatedAt:'2026-10-26T01:00:00Z'});
  const reference=(id,uses,pool)=>({id,title:'收藏 '+id,url:'https://www.xiaohongshu.com/explore/'+id,text:'参考正文',tags:['参考'],note:'',assets:[],uses,pool,status:'ready',createdAt:'2026-10-26T01:00:00Z',linkRead:{status:'ready'}});
  const sources=[{title:'可核验来源',url:'https://example.test/source',platformId:'weibo',rank:3}];
  return {
    accounts:[{id:'official',name:'官方',type:'official',enabled:true,archived:false,settings:clone(settings),reportSettings:clone(settings)},{id:'secondary',name:'小号',type:'personal',enabled:true,archived:false,settings:clone(settings),reportSettings:clone(settings)}],
    defaultAccountId:'official',settings:clone(settings),product:{name:'产品',brand:'品牌',summary:'事实',version:1,facts:[],conditions:[],restrictions:[],sources:[]},
    productAssets:[{id:'test-photo',name:'手动测试素材',kind:'image',mime:'image/png',size:10,createdAt:'2026-10-26T02:00:00Z',fileUrl:'/media/test.png',metadata:{testOnly:true}},{id:'photo',name:'真实产品图',kind:'image',mime:'image/png',size:10,createdAt:'2026-10-26T01:00:00Z',fileUrl:'/media/product.png',metadata:{}}],
    inspirations:[reference('pending',0,true),reference('used',2,false)],drafts:[draft('d1'),draft('d2','secondary')],draftChecks:{},jobs:[],events:[],creators:[],creatorSyncs:[],analysisTasks:[],draftGenerationJobs:[],topicPool:[],discussions:[],
    capabilities:{ai:true,model:'mock-model',publisher:false,accounts:{official:{publisher:false},secondary:{publisher:false}},linkReader:true,textPublisher:false},
    trendBoards:[{platformId:'weibo',name:'微博',status:'ready',sourceUrl:'https://example.test/board',fetchedAt:'2026-10-26T01:00:00Z',items:[{id:'board-item',title:'热点主题',rank:3,url:'https://example.test/source'}]}],
    trendMatches:{official:[{id:'match-1',title:'热点主题',score:8,reason:'适合产品场景',sourceIds:['board-item'],sources,appearances:[{platformId:'weibo',rank:3,url:'https://example.test/source'}]}],secondary:[]},trendRefreshJobs:[],reportJobs:[],
    operationReports:[{id:'report-1',accountId:'official',date:'2026-10-26',status:'ready',generatedAt:'2026-10-26T01:00:00Z',metrics:[{key:'pending_review',label:'待核对',value:1,unit:'篇'}],plans:[{id:'plan-1',title:'核对产品稿',detail:'检查来源',done:false,priority:'high',blockers:['需核对事实'],sources,action:{type:'draft',id:'d1',label:'打开草稿'}}],discoveries:[{id:'discovery-1',title:'新发现',kind:'trend',detail:'参考产品场景',sources}],snapshot:{date:'2026-10-26',timezone:'Asia/Shanghai',mode:'live',asOf:'2026-10-26T01:00:00Z',generatedAt:'2026-10-26T01:00:00Z'}}],
    feishuSync:{enabled:false,status:'idle',sourceUrls:[]},feishuDocuments:[],feishuJobs:[],imageJobs:[],imageProvider:{ready:false}
  };
}
function element(extra={}){return {innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',dataset:{},classList:{add(){},remove(){},toggle(){}},querySelector(){return null;},querySelectorAll(){return [];},...extra};}
function ui({state=fixture(),handle}={}){
  const requests=[],events={},timers=new Map(),notifications=[];let timerId=0;
  const nodes={
    '#app':element(), '#modal':element({open:false,showModal(){this.open=true;},close(){this.open=false;}}), '#modal-content':element(), '#toast':element(),
    '#draft-generation-status':element(), '#save-state':element(), '[data-action="save-retry"]':element({hidden:true}), '#draft-select':element({value:'d1'}), '#account-filter':element({value:'all'})
  };
  async function fetcher(url,options={}){
    const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);
    const custom=handle?await handle(request,{state,requests,nodes}):undefined;if(custom!==undefined)return custom;
    if(url==='/api/state'&&request.method==='GET')return response(state);
    if(url==='/api/topics'&&request.method==='POST'){
      const topic={id:'topic-new',accountId:request.body.accountId,title:'统一收藏',referenceId:'topic-reference',sourceIds:['board-item']};
      state.topicPool.push(topic);state.inspirations.push({id:topic.referenceId,topicId:topic.id,accountId:topic.accountId,title:topic.title,text:'来源正文',tags:[],note:'',assets:[],uses:0,pool:false,status:'ready',sourceLinks:state.trendMatches.official[0].sources});return response(topic);
    }
    if(url==='/api/draft-generations'&&request.method==='POST'){
      const job={id:'generation-'+(state.draftGenerationJobs.length+1),...request.body,status:'queued',phase:state.inspirations.find(r=>r.id===request.body.referenceId)?.linkRead?.status==='queued'?'reading':'queued',createdAt:'2026-10-26T01:00:00Z'};state.draftGenerationJobs.unshift(job);return response(job);
    }
    const draftMatch=url.match(/^\/api\/drafts\/([^/]+)$/);
    if(draftMatch&&request.method==='PUT'){
      const index=state.drafts.findIndex(d=>d.id===draftMatch[1]),draft={...request.body,revision:state.drafts[index].revision+1,approved:false,updatedAt:'2026-10-26T02:00:00Z'};state.drafts[index]=draft;return response(draft);
    }
    if(/^\/api\/inspirations\/[^/]+$/.test(url)&&request.method==='PUT'){
      const item=state.inspirations.find(r=>url.endsWith('/'+r.id));Object.assign(item,request.body);return response(item);
    }
    throw Error('Unexpected mock request: '+request.method+' '+url);
  }
  class FormDataMock{
    constructor(form){this.entries=Object.entries(form.values||{});}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
    has(key){return this.entries.some(([name])=>name===key);}
    getAll(key){return this.entries.filter(([name])=>name===key).map(([,value])=>value);}
  }
  const context=vm.createContext({fetch:fetcher,URL,Intl,Date,Math,structuredClone,AbortSignal,FormData:FormDataMock,console,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[],activeElement:{id:''},addEventListener:(type,handler)=>{events[type]=handler;}},
    location:{hash:'',replace(url){this.redirect=url;}},window:{scrollTo(){}},confirm:()=>true,crypto:{randomUUID:()=>`request-${requests.length}`}});
  vm.runInContext(definitions,context);context.initial=clone(state);context.notify=message=>notifications.push(message);
  vm.runInContext('S=initial;toast=notify;',context);vm.runInContext(listeners,context);
  const run=code=>vm.runInContext(code,context);
  return {state,context,nodes,requests,notifications,timers,run,stubRender(){run('render=()=>{}');},async submit(form,button=element({value:'confirm'})){await events.submit({target:form,submitter:button,preventDefault(){}});return button;},input(target){events.input({target});}};
}
function beginEdit(view,id='d1'){view.context.draftId=id;view.run("page='studio';selected=draftId;edit=structuredClone(S.drafts.find(d=>d.id===draftId));dirty=false;");}

test('source creation goes through unified collection directly into a draft job',async()=>{
  const view=ui();view.stubRender();view.run("page='trends';operationsAccountId='official'");
  await view.run("createOperationDraft('match','match-1')");
  assert.deepEqual(view.requests.filter(r=>r.method==='POST').map(r=>r.url),['/api/topics','/api/draft-generations']);
  const input=view.requests.find(r=>r.url==='/api/draft-generations').body;
  assert.equal(input.referenceId,'topic-reference');assert.equal(input.accountId,'official');assert.equal(input.method,'ai');assert.equal(input.contentMode,'image');
  assert.deepEqual(input.productAssetIds,['photo']);assert.equal(view.run('page'),'studio');assert.equal(view.run("S.inspirations.find(r=>r.id==='topic-reference').topicId"),'topic-new');
  assert.doesNotMatch(view.run("operationItemActions('match',trendMatches()[0])"),/讨论|operation-discuss/);
});

test('a report reference can generate directly without another collection or discussion',async()=>{
  const state=fixture();state.operationReports[0].discoveries[0].sources=[{title:'已有收藏',kind:'reference',id:'pending',url:'#reference/pending'}];
  const view=ui({state});view.stubRender();await view.run("createOperationDraft('discovery','discovery-1','report-1')");
  assert.deepEqual(view.requests.filter(r=>r.method==='POST').map(r=>r.url),['/api/draft-generations']);assert.equal(view.requests[0].body.referenceId,'pending');
});

test('collection primary action continues into reading and generation while save-only stops at collection',async()=>{
  for(const action of ['generate','save']){
    const view=ui({handle:(request,{state})=>{
      if(request.url!=='/api/inspirations'||request.method!=='POST')return;
      const item={id:'link-new',...request.body,title:'读取中的收藏',assets:[],tags:[],uses:0,pool:false,linkRead:{status:'queued'}};state.inspirations.push(item);return response({item,merged:false});
    }});view.stubRender();view.run("page='library';upload()");
    const modal=view.nodes['#modal-content'].innerHTML;assert.match(modal,/收藏并生成/);assert.match(modal,/仅收藏/);assert.match(modal,/<details class="reference-manual-fields">/);
    const form=element({id:'upload-form',dataset:{target:''},values:{'ref-url':'https://www.xiaohongshu.com/explore/new','ref-note':'一句要求'}}),button=element({value:action});
    await view.submit(form,button);
    assert.deepEqual(view.requests.filter(r=>r.method==='POST').map(r=>r.url),action==='generate'?['/api/inspirations','/api/draft-generations']:['/api/inspirations']);
    assert.equal(view.nodes['#modal'].open,false);assert.equal(button.disabled,false);
    if(action==='generate'){const job=view.run('S.draftGenerationJobs[0]');assert.equal(job.phase,'reading');assert.equal(job.referenceId,'link-new');assert.equal(job.instruction,'一句要求');assert.match(view.notifications.at(-1),/读取链接/);}
    assert.equal(view.requests.some(r=>/analyze|discussions/.test(r.url)),false);
  }
});

test('collection filters and daily inclusion use the same references',async()=>{
  const view=ui();view.stubRender();
  const unused=view.run("page='library';filter='unused';library()");assert.match(unused,/data-id="pending"/);assert.doesNotMatch(unused,/data-id="used"/);
  const pool=view.run("filter='pool';library()");assert.match(pool,/data-reference-pool="pending" checked/);assert.doesNotMatch(pool,/data-id="used"/);assert.match(pool,/用于每日自动创作/);assert.match(pool,/待创作/);
  const checkbox=element({dataset:{referencePool:'pending'},checked:false});view.context.checkbox=checkbox;await view.run('toggleReferencePool(checkbox)');
  assert.deepEqual(view.requests[0].body,{pool:false});assert.equal(view.run("S.inspirations.find(r=>r.id==='pending').pool"),false);assert.equal(checkbox.disabled,false);
  assert.doesNotMatch(pool,/data-page="topics"|待分析<|已分析</);
});

test('failed daily inclusion changes restore the checkbox and preserve collection',async()=>{
  const view=ui({handle:request=>request.method==='PUT'?response({error:'保存失败'},500):undefined});view.stubRender();
  const checkbox=element({dataset:{referencePool:'pending'},checked:false});view.context.checkbox=checkbox;await view.run('toggleReferencePool(checkbox)');
  assert.equal(checkbox.checked,true);assert.equal(checkbox.disabled,false);assert.equal(view.run("S.inspirations.find(r=>r.id==='pending').pool"),true);assert.match(view.notifications.at(-1),/保存失败/);
});

test('overview and the old report route render one daily workspace',async()=>{
  const view=ui();view.run("reportDate='2026-10-26'");await view.run("nav('reports')");
  assert.equal(view.run('page'),'overview');assert.equal(view.context.location.hash,'overview');
  const html=view.nodes['#app'].innerHTML;assert.match(html,/<h1>今日工作台<\/h1>/);assert.match(html,/待核对/);assert.match(html,/核对产品稿/);assert.match(html,/新发现/);assert.doesNotMatch(html,/最近草稿/);
  assert.equal((html.match(/data-page="overview"/g)||[]).length,1);assert.doesNotMatch(html,/data-page="reports"/);
});

test('internal source checks, legacy storyboard and series stay out of the editor',async()=>{
  const view=ui();view.state.drafts[0].gaps=['UNIQUE_INTERNAL_SOURCE_CHECK'];view.context.initial=clone(view.state);view.run('S=initial');beginEdit(view);const html=view.run('studio()');
  assert.match(html,/已自动保存/);assert.match(html,/预览并排期/);assert.doesNotMatch(html,/UNIQUE_INTERNAL_SOURCE_CHECK|待补资料|补充内容|name="gaps"|UNIQUE_LEGACY_STORYBOARD|UNIQUE_LEGACY_SERIES|name="series"|data-slide-field|辅助分镜|内容栏目/);
  view.stubRender();view.run("edit.title='修改实际发布的标题';markDraftChanged()");await view.run('flushDraftSave()');
  assert.deepEqual(view.requests.find(request=>request.method==='PUT').body.gaps,['UNIQUE_INTERNAL_SOURCE_CHECK']);
});

test('source checks appear only at publication confirmation and carry explicit owner acknowledgement',async()=>{
  for(const reviewed of [false,true]){
    const state=fixture();state.drafts[0].gaps=['确认当前产品功能边界'];
    const view=ui({state,handle:request=>request.url==='/api/drafts/d1/schedule'?response({id:'job'}):undefined});view.stubRender();beginEdit(view);
    await view.run("schedule('d1')");const html=view.nodes['#modal-content'].innerHTML;
    assert.match(html,/发布前核对/);assert.match(html,/确认当前产品功能边界/);assert.match(html,/name="reviewGaps" type="checkbox" required/);assert.doesNotMatch(html,/name="gaps"|补充内容/);
    const form=element({id:'schedule-form',dataset:{id:'d1',account:'official',revision:'1'},values:{scheduledAt:'2026-10-27T19:30',...(reviewed?{reviewGaps:'on'}:{})}});
    await view.submit(form);assert.equal(view.requests.find(request=>request.url.endsWith('/schedule')).body.reviewGaps,reviewed);
  }
  const view=ui();beginEdit(view);assert.equal(view.run('scheduleGapReview(edit)'),'');
  view.run("edit.gaps=['已核对资料'];edit.gapReview={draftRevision:1,productVersion:1,gaps:['已核对资料']}");assert.equal(view.run('scheduleGapReview(edit)'),'');
  view.run('edit.revision=2');assert.match(view.run('scheduleGapReview(edit)'),/已核对资料/);
});

test('only actual draft edits schedule autosave, not an unsent rewrite request',()=>{
  const view=ui();beginEdit(view);
  const inDraftForm=selector=>selector==='#draft-form'?{}:null;
  view.input(element({id:'draft-rewrite-instruction',name:'',value:'尚未发送的改写要求',closest:inDraftForm}));
  assert.equal(view.run('dirty'),false);assert.equal(view.timers.size,0);
  view.input(element({id:'title',name:'title',value:'更新标题',closest:inDraftForm}));
  assert.equal(view.run('dirty'),true);assert.equal(view.run('edit.title'),'更新标题');assert.equal([...view.timers.values()].filter(timer=>timer.delay===900).length,1);assert.equal(view.requests.length,0);
});

test('autosave serializes requests and saves newer input after an older response',async()=>{
  const saves=[];let active=0,maxActive=0;
  const view=ui({handle:async(request,{state})=>{
    if(request.method!=='PUT'||request.url!=='/api/drafts/d1')return;
    const gate=deferred();saves.push({request,gate});active++;maxActive=Math.max(maxActive,active);
    try{await gate.promise;const result={...request.body,revision:state.drafts[0].revision+1,updatedAt:'2026-10-26T02:00:00Z'};state.drafts[0]=result;return response(result);}finally{active--;}
  }});view.stubRender();beginEdit(view);
  view.run("edit.title='第一轮输入';markDraftChanged()");const first=view.run('flushDraftSave()');await turn();
  assert.equal(saves.length,1);view.run("edit.title='更新后的输入';markDraftChanged()");const joined=view.run('flushDraftSave()');await turn();assert.equal(saves.length,1);
  saves[0].gate.resolve();await turn();assert.equal(saves.length,2);assert.equal(saves[1].request.body.title,'更新后的输入');assert.equal(saves[1].request.body.revision,2);assert.equal(view.run('dirty'),true);assert.equal(view.run('edit.title'),'更新后的输入');
  saves[1].gate.resolve();await Promise.all([first,joined]);
  assert.equal(maxActive,1);assert.equal(view.run('dirty'),false);assert.equal(view.run('edit.title'),'更新后的输入');assert.equal(view.run('edit.revision'),3);assert.equal(view.run('S.drafts[0].title'),'更新后的输入');assert.equal(view.nodes['#save-state'].textContent,'已自动保存');
});

test('draft editing stays in the current workspace with no cross-account picker',()=>{
  const state=fixture();state.drafts.push({...clone(state.drafts[0]),id:'secondary-draft',accountId:'secondary',title:'小号内容'});
  const view=ui({state});beginEdit(view);view.run("workspaceId='official'");
  const html=view.run('studio()');assert.doesNotMatch(html,/<select[^>]+(?:id="draft-account"|id="account-filter")/);assert.doesNotMatch(html,/小号内容/);assert.equal(view.run('generationAccountId()'),'official');
});

test('state requests started before a save cannot roll back its saved draft',async()=>{
  const old=fixture(),gate=deferred();let first=true;
  const view=ui({handle:async request=>{if(request.url==='/api/state'&&first){first=false;await gate.promise;return response(old);}}});view.stubRender();beginEdit(view);
  const stale=view.run('refresh(false)');await turn();view.run("edit.title='保存后的新标题';markDraftChanged()");await view.run('flushDraftSave()');
  gate.resolve();assert.equal(await stale,false);assert.equal(view.run('S.drafts[0].title'),'保存后的新标题');assert.equal(view.run('S.drafts[0].revision'),2);
  assert.equal(await view.run('refresh(false)'),true);assert.equal(view.run('S.drafts[0].title'),'保存后的新标题');
});

test('account-owned references show their own generation status in the all-account library',()=>{
  const state=fixture();state.inspirations[0].accountId='secondary';state.draftGenerationJobs=[{id:'secondary-job',accountId:'secondary',referenceId:'pending',status:'running',phase:'generating',draftId:'d2'}];
  const view=ui({state});view.run("page='library';accountFilter='all'");
  assert.equal(view.run('generationAccountId()'),'official');assert.equal(view.run("referenceGenerationJob('pending').id"),'secondary-job');
  assert.match(view.run('referenceGenerateButton(S.inspirations[0])'),/ disabled>生成草稿…/);
  const completed=view.run("S.draftGenerationJobs[0].status='completed';referenceGenerateButton(S.inspirations[0])");assert.match(completed,/data-action="generation-open"/);assert.match(completed,/data-id="secondary-job"/);assert.match(completed,/打开草稿/);
});

test('automatic publication images exclude tests and all adjusted model-preview descendants',()=>{
  const state=fixture(),image=(id,name,metadata={},extra={})=>({id,name,kind:'image',mime:'image/png',createdAt:'2026-10-26T03:00:00Z',metadata,...extra});
  state.productAssets.unshift(image('model-preview','MODEL PREVIEW',{modelAssetId:'cad'}),image('model-adjusted','MODEL ADJUSTED',{adjustedFromAssetId:'model-preview'}),image('model-twice','MODEL TWICE',{adjustedFromAssetId:'model-adjusted'}),image('test-adjusted','TEST DERIVED HIDDEN',{adjustedFromAssetId:'test-photo'}),image('test-ai','AI TEST DERIVED HIDDEN',{sourceAssetIds:['test-photo']}),image('server-preview','SERVER MODEL PREVIEW',{}, {imageRole:'modelPreview',publishable:false,automatic:false}),image('finished','成品封面',{usage:'publication',sourceAssetIds:['model-preview']},{imageRole:'publication',publishable:true,automatic:true}),image('manual-only','手动选图',{}, {publishable:true,automatic:false}));
  const view=ui({state});assert.deepEqual(Array.from(view.run('recentPhotoIds()')),['finished','photo']);assert.equal(view.run('defaultWorkbenchImage().id'),'finished');
  for(const id of ['model-preview','model-adjusted','model-twice','test-photo','test-adjusted','test-ai','server-preview']){view.context.assetId=id;assert.equal(view.run('publishableImageAsset(productAsset(assetId))'),false,id);}
  assert.equal(view.run("publishableImageAsset(productAsset('finished'))"),true);assert.equal(view.run("workbenchImages().some(a=>a.id==='model-preview')"),true);
  assert.deepEqual(Array.from(view.run("draftPhotos({productAssetIds:['model-twice','test-adjusted','finished']}).map(a=>a.id)")),['finished']);
  const picker=view.run("assetPicker(['model-twice'],'draft')");assert.doesNotMatch(picker,/手动测试素材|TEST DERIVED HIDDEN/);assert.match(picker,/模型预览 · 仅参考/);assert.match(picker,/value="model-preview" disabled/);assert.match(picker,/移除不可用配图/);
});

test('no eligible publication image leaves defaults empty rather than falling back to a model preview',()=>{
  const state=fixture();state.productAssets=state.productAssets.filter(a=>a.id==='test-photo');state.productAssets.push({id:'model-preview',name:'模型图',kind:'image',mime:'image/png',metadata:{modelAssetId:'cad'}});
  const view=ui({state});assert.deepEqual(Array.from(view.run('recentPhotoIds()')),[]);assert.equal(view.run('defaultWorkbenchImage()'),undefined);assert.match(view.run('assetPicker()'),/请选择或生成配图/);
});

test('modify-images saves current input and opens current-image options without leaving the draft or submitting AI',async()=>{
  const state=fixture();state.productAssets.push({id:'second-photo',name:'第二张配图',kind:'image',mime:'image/png',fileUrl:'/media/second.png',metadata:{}});state.drafts[0].productAssetIds=['photo','second-photo'];
  const view=ui({state});view.stubRender();beginEdit(view);view.run("slide=1;edit.body='正在输入的正文';markDraftChanged()");
  await view.run('editDraftImages()');
  assert.equal(view.run('page'),'studio');assert.equal(view.run('selected'),'d1');assert.equal(view.run('edit.body'),'正在输入的正文');assert.equal(view.run('dirty'),false);
  assert.equal(view.nodes['#modal'].open,true);assert.match(view.nodes['#modal-content'].innerHTML,/second-photo|second\.png/);assert.deepEqual(view.requests.map(request=>request.url),['/api/drafts/d1']);assert.equal(view.state.drafts[0].body,'正在输入的正文');
});

test('a draft containing only model previews opens generation without making an AI request',async()=>{
  const state=fixture();state.productAssets.push({id:'model-preview',name:'模型图',kind:'image',mime:'image/png',metadata:{modelAssetId:'cad'}});state.drafts[0].productAssetIds=['model-preview'];
  const view=ui({state});view.stubRender();beginEdit(view);await view.run('editDraftImages()');
  assert.equal(view.run('page'),'studio');assert.equal(view.nodes['#modal'].open,true);assert.doesNotMatch(view.nodes['#modal-content'].innerHTML,/value="model-preview"|data-id="model-preview"/);assert.equal(view.requests.length,0);
});

test('a draft-specific cover stays available to its draft without becoming a new-draft default',async()=>{
  const state=fixture();state.productAssets.unshift({id:'draft-cover',name:'专属成品封面',kind:'image',mime:'image/png',createdAt:'2026-10-26T03:00:00Z',imageRole:'publication',publishable:true,automatic:false,metadata:{usage:'publication',draftId:'d1'}});state.drafts[0].productAssetIds=['draft-cover'];
  const view=ui({state});view.stubRender();beginEdit(view);assert.deepEqual(Array.from(view.run('recentPhotoIds()')),['photo']);assert.equal(view.run('defaultWorkbenchImage().id'),'photo');assert.deepEqual(Array.from(view.run("draftPhotos(S.drafts[0]).map(a=>a.id)")),['draft-cover']);
  assert.equal(view.run("workbenchImages().some(a=>a.id==='test-photo')"),false);assert.equal(view.run("workbenchImages().some(a=>a.id==='draft-cover')"),true);
  await view.run('editDraftImages()');assert.equal(view.run('page'),'studio');assert.equal(view.nodes['#modal'].open,true);assert.match(view.nodes['#modal-content'].innerHTML,/draft-cover/);assert.equal(view.requests.length,0);
});

test('studio keeps image creation beside the current draft without global image tabs or the product icon picker',()=>{
  const state=fixture();state.productAssets.push({id:'logo',name:'ICON_LIST_SHOULD_NOT_RENDER',kind:'icon',mime:'image/png',metadata:{}});
  state.imageJobs=[{id:'unrelated-job',draftId:'d2',batchId:'other-batch',status:'completed',assetId:'test-photo',prompt:'GLOBAL_TEST_JOB_SHOULD_NOT_RENDER'}];
  const view=ui({state});beginEdit(view);const html=view.run('studio()');
  assert.doesNotMatch(html,/data-page="studio\/images"|class="asset-picker"|ICON_LIST_SHOULD_NOT_RENDER|GLOBAL_TEST_JOB_SHOULD_NOT_RENDER/);
  assert.match(html,/id="draft-form"/);assert.match(html,/配图/);assert.match(html,/预览并排期/);
});

test('draft image jobs are scoped to the draft and its newest batch',()=>{
  const state=fixture();state.imageJobs=[
    {id:'old',draftId:'d1',batchId:'old-batch',status:'completed',createdAt:'2026-10-26T01:00:00Z'},
    {id:'new-2',draftId:'d1',batchId:'new-batch',index:1,status:'queued',createdAt:'2026-10-26T02:00:00Z'},
    {id:'unrelated',draftId:'d2',batchId:'other-batch',status:'generating',createdAt:'2026-10-26T03:00:00Z'},
    {id:'new-1',draftId:'d1',batchId:'new-batch',index:0,status:'generating',createdAt:'2026-10-26T02:00:00Z'},
    {id:'legacy-test',status:'completed',assetId:'test-photo',createdAt:'2026-10-26T04:00:00Z'}
  ];
  const view=ui({state});beginEdit(view);
  assert.deepEqual(Array.from(view.run('draftImageJobs().map(job=>job.id)')),['new-1','new-2']);
  assert.deepEqual(Array.from(view.run("draftImageJobs('d2').map(job=>job.id)")),['unrelated']);
});

test('retrying one image keeps the other slots and their failure actions in the current image set',()=>{
  const state=fixture();state.imageJobs=[
    {id:'first-failed',draftId:'d1',batchId:'original',setId:'set',index:0,status:'failed',createdAt:'2026-10-26T01:00:00Z'},
    {id:'second-failed',draftId:'d1',batchId:'original',setId:'set',index:1,status:'failed',createdAt:'2026-10-26T01:00:00Z'},
    {id:'third-completed',draftId:'d1',batchId:'original',setId:'set',index:2,status:'completed',createdAt:'2026-10-26T01:00:00Z'},
    {id:'first-retry',draftId:'d1',batchId:'retry',setId:'set',index:0,status:'generating',createdAt:'2026-10-26T02:00:00Z'}
  ];const view=ui({state});beginEdit(view);
  assert.deepEqual(Array.from(view.run('draftImageJobs().map(job=>job.id)')),['first-retry','second-failed','third-completed']);
});

test('editing a cover keeps failed and conflicting content images actionable until a whole new set replaces them',()=>{
  const state=fixture();state.imageJobs=[
    {id:'original-cover',draftId:'d1',batchId:'original',setId:'original',index:0,status:'completed',attachStatus:'attached',attachMode:'replaceSet',createdAt:'2026-10-26T01:00:00Z'},
    {id:'body-failed',draftId:'d1',batchId:'original',setId:'original',index:1,status:'failed',attachMode:'replaceSet',createdAt:'2026-10-26T01:00:00Z'},
    {id:'body-conflict',draftId:'d1',batchId:'original',setId:'original',index:2,status:'completed',attachStatus:'conflict',attachMode:'replaceSet',createdAt:'2026-10-26T01:00:00Z'},
    {id:'edited-cover',draftId:'d1',batchId:'cover-edit',setId:'cover-edit',index:0,status:'completed',attachStatus:'attached',attachMode:'replaceAsset',createdAt:'2026-10-26T02:00:00Z'},
    {id:'another-draft-failure',draftId:'d2',batchId:'other',setId:'other',index:0,status:'failed',attachMode:'replaceSet',createdAt:'2026-10-26T03:00:00Z'}
  ];const view=ui({state});beginEdit(view);
  assert.deepEqual(Array.from(view.run('draftImageIssues().map(job=>job.id)')).sort(),['body-conflict','body-failed']);
  const markup=view.run('draftImageProgress()');assert.match(markup,/data-action="draft-image-retry"[^>]*data-id="body-failed"/);assert.match(markup,/data-action="draft-image-adopt"[^>]*data-id="body-conflict"/);assert.doesNotMatch(markup,/another-draft-failure/);
  view.run("S.imageJobs.push({id:'body-retry',draftId:'d1',batchId:'retry',setId:'original',index:1,status:'generating',attachMode:'retrySlot',createdAt:'2026-10-26T03:00:00Z'})");
  assert.deepEqual(Array.from(view.run('draftImageIssues().map(job=>job.id)')),['body-conflict']);
  view.run("S.imageJobs.push({id:'new-full-set',draftId:'d1',batchId:'new',setId:'new',index:0,status:'queued',attachMode:'replaceSet',createdAt:'2026-10-26T04:00:00Z'})");
  assert.deepEqual(Array.from(view.run('draftImageIssues()')),[]);assert.doesNotMatch(view.run('draftImageProgress()'),/data-id="body-failed"|data-id="body-conflict"/);
});

test('retrying an uncertain submission reuses its original request identity and payload after editing',async()=>{
  const state=fixture();let firstSubmission=true;
  const view=ui({state,handle:(request,{state})=>{
    if(request.url!=='/api/drafts/d1/images'||request.method!=='POST')return;
    if(firstSubmission){firstSubmission=false;state.imageJobs.push({id:'accepted-once',draftId:'d1',batchId:'batch',index:0,status:'queued',clientRequestId:request.body.clientRequestId,createdAt:'2026-10-26T01:00:00Z'});return response({error:'结果尚未确认'},502);}
    return response({batchId:'batch',jobs:state.imageJobs});
  }});view.stubRender();beginEdit(view);await assert.rejects(view.run('submitDraftImages()'),/结果尚未确认/);
  view.run("edit.body='请求不确定期间修改的正文';markDraftChanged()");await view.run("handleDraftImageAction('submit-retry')");
  const submissions=view.requests.filter(request=>request.url.endsWith('/images'));assert.equal(submissions.length,2);assert.deepEqual(submissions[1].body,submissions[0].body);assert.equal(view.state.imageJobs.length,1);assert.equal(view.run('draftImageRequests.size'),0);assert.equal(view.state.drafts[0].body,'请求不确定期间修改的正文');
});

test('a retry resolved by polling during autosave cannot fall back to a fresh default generation',async()=>{
  const gate=deferred(),state=fixture();
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    await gate.promise;const result={...request.body,revision:2};state.drafts[0]=result;return response(result);
  }});view.stubRender();beginEdit(view);
  view.run("draftImageRequests.set('d1',{payload:{revision:1,count:1,instruction:'只生成封面',clientRequestId:'uncertain-request'},context:{draftId:'d1',revision:1,replaceAssetId:''},error:'结果不确定'});edit.body='重试前的新正文';markDraftChanged()");
  const pending=view.run("handleDraftImageAction('submit-retry')");await turn();
  state.imageJobs.push({id:'already-accepted',draftId:'d1',batchId:'old-request',setId:'old-request',index:0,status:'queued',clientRequestId:'uncertain-request',createdAt:'2026-10-26T01:00:00Z'});
  await view.run('pollDraftImages(true)');assert.equal(view.run('draftImageRequests.size'),0);gate.resolve();await pending;
  assert.equal(view.requests.some(request=>request.method==='POST'&&request.url.endsWith('/images')),false);assert.equal(state.imageJobs.length,1);assert.equal(state.drafts[0].body,'重试前的新正文');assert.equal(view.run('draftImageSubmitting'),false);
});

test('definitive generation rejection clears pending retry and refreshes the saved draft',async()=>{
  const view=ui({handle:(request,{state})=>{
    if(request.url!=='/api/drafts/d1/images')return;
    state.drafts[0]={...state.drafts[0],revision:2,title:'服务器上的新版本'};return response({error:'稿件已更新'},409);
  }});view.stubRender();beginEdit(view);
  await assert.rejects(view.run('submitDraftImages()'),/稿件已更新/);
  assert.equal(view.run('draftImageRequests.size'),0);assert.equal(view.run('edit.revision'),2);assert.equal(view.run('edit.title'),'服务器上的新版本');assert.equal(view.run('draftImageSubmitting'),false);assert.equal(view.requests.some(request=>request.url==='/api/state'),true);
});

test('double-clicking generation while autosave is pending submits only one image request',async()=>{
  const saveGate=deferred(),imageGate=deferred(),state=fixture();
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url==='/api/drafts/d1'&&request.method==='PUT'){await saveGate.promise;const draft={...request.body,revision:2};state.drafts[0]=draft;return response(draft);}
    if(request.url==='/api/drafts/d1/images'){
      await imageGate.promise;const job={id:'once',draftId:'d1',batchId:'batch',setId:'batch',index:0,status:'queued',clientRequestId:request.body.clientRequestId,createdAt:'2026-10-26T01:00:00Z'};state.imageJobs.push(job);return response({batchId:'batch',jobs:[job]});
    }
  }});view.stubRender();beginEdit(view);view.run("edit.body='点击前新正文';markDraftChanged()");
  const first=view.run('submitDraftImages()'),second=view.run('submitDraftImages()');await turn();saveGate.resolve();await turn();
  assert.equal(view.requests.filter(request=>request.url.endsWith('/images')).length,1);imageGate.resolve();await Promise.all([first,second]);assert.equal(state.imageJobs.length,1);assert.equal(view.run('draftImageSubmitting'),false);
});

test('switching a text draft to images starts empty rather than borrowing unrelated recent pictures',()=>{
  const state=fixture();state.drafts[0].contentMode='text';state.drafts[0].productAssetIds=[];state.drafts[0].slides=[];
  const view=ui({state});view.stubRender();beginEdit(view);view.run("changeDraftMode('image')");
  assert.equal(view.run('edit.contentMode'),'image');assert.deepEqual(Array.from(view.run('edit.productAssetIds')),[]);assert.equal(view.run('dirty'),true);
});

test('capturing an image destination waits for autosave and uses the saved revision',async()=>{
  const gate=deferred(),view=ui({handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    await gate.promise;const result={...request.body,revision:2};state.drafts[0]=result;return response(result);
  }});view.stubRender();beginEdit(view);view.run("edit.body='生图应使用的新正文';markDraftChanged()");
  const pending=view.run("captureDraftImageContext('photo')");await turn();assert.equal(view.requests.length,1);assert.equal(view.requests[0].body.body,'生图应使用的新正文');
  gate.resolve();const destination=await pending;assert.equal(destination.draftId,'d1');assert.equal(destination.revision,2);assert.equal(destination.replaceAssetId,'photo');assert.equal(view.run('dirty'),false);
});

test('an unsuccessful autosave prevents capturing an image destination',async()=>{
  const view=ui({handle:request=>request.method==='PUT'?response({error:'保存暂不可用'},503):undefined});view.stubRender();beginEdit(view);view.run("edit.body='保留输入';markDraftChanged()");
  await assert.rejects(view.run("captureDraftImageContext('photo')"),/保存暂不可用/);
  assert.equal(view.run('dirty'),true);assert.equal(view.run('edit.body'),'保留输入');assert.equal(view.requests.some(request=>request.url.endsWith('/images')),false);
});

test('image state synchronization adopts completed images only while the editor is clean',()=>{
  const view=ui();beginEdit(view);view.run("S.drafts[0]={...S.drafts[0],revision:2,productAssetIds:['new-image']};edit.body='未保存的正文';markDraftChanged();syncDraftImageState()");
  assert.equal(view.run('edit.body'),'未保存的正文');assert.equal(view.run('edit.revision'),1);assert.deepEqual(Array.from(view.run('edit.productAssetIds')),['photo']);
  view.run('dirty=false;draftSavePromise=new Promise(()=>{});syncDraftImageState()');assert.equal(view.run('edit.revision'),1);
  view.run('draftSavePromise=null;syncDraftImageState()');assert.equal(view.run('edit.revision'),2);assert.deepEqual(Array.from(view.run('edit.productAssetIds')),['new-image']);
});

test('replacing a chosen image preserves its position and the other pictures',async()=>{
  const state=fixture();for(const id of ['second','third','replacement'])state.productAssets.push({id,name:id,kind:'image',mime:'image/png',fileUrl:'/media/'+id+'.png',metadata:{}});state.drafts[0].productAssetIds=['photo','second','third'];
  const view=ui({state});view.stubRender();beginEdit(view);await view.run("commitDraftImage('replacement',{draftId:'d1',revision:1,replaceAssetId:'second'})");
  assert.deepEqual(view.state.drafts[0].productAssetIds,['photo','replacement','third']);assert.equal(view.requests.filter(request=>request.method==='PUT').length,1);assert.equal(view.state.drafts[0].approved,false);
});

test('an image finishing after switching drafts is committed only to the captured draft',async()=>{
  const gate=deferred(),state=fixture();state.productAssets.push({id:'new-image',name:'新图',kind:'image',mime:'image/png',fileUrl:'/media/new.png',metadata:{}});
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    await gate.promise;const result={...request.body,revision:2};state.drafts[0]=result;return response(result);
  }});view.stubRender();beginEdit(view);
  const pending=view.run("commitDraftImage('new-image',{draftId:'d1',revision:1,replaceAssetId:'photo'})");await turn();beginEdit(view,'d2');
  gate.resolve();await pending;assert.deepEqual(view.state.drafts[0].productAssetIds,['new-image']);assert.deepEqual(view.state.drafts[1].productAssetIds,['photo']);
  assert.equal(view.run('selected'),'d2');assert.equal(view.run('edit.id'),'d2');assert.deepEqual(Array.from(view.run('edit.productAssetIds')),['photo']);
});

test('typing during an image replacement survives the response and the following autosave',async()=>{
  const gate=deferred(),state=fixture();let firstWrite=true;
  state.productAssets.push({id:'new-image',name:'新图',kind:'image',mime:'image/png',fileUrl:'/media/new.png',metadata:{}});
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    if(firstWrite){firstWrite=false;await gate.promise;}
    if(request.body.revision!==state.drafts[0].revision)return response({error:'稿件版本已变化'},409);
    const result={...request.body,revision:state.drafts[0].revision+1};state.drafts[0]=result;return response(result);
  }});view.stubRender();beginEdit(view);
  const pending=view.run("commitDraftImage('new-image',{draftId:'d1',revision:1,replaceAssetId:'photo'})");await turn();view.run("edit.body='替换期间继续写的正文';markDraftChanged()");
  gate.resolve();await pending;assert.equal(view.run('edit.body'),'替换期间继续写的正文');assert.equal(view.run('dirty'),true);
  await view.run('flushDraftSave()');assert.equal(view.state.drafts[0].body,'替换期间继续写的正文');assert.deepEqual(view.state.drafts[0].productAssetIds,['new-image']);assert.equal(view.run('dirty'),false);
});

test('switching drafts while replacement is saving also waits for text typed during that save',async()=>{
  const gate=deferred(),state=fixture();let firstWrite=true;
  state.productAssets.push({id:'new-image',name:'新图',kind:'image',mime:'image/png',fileUrl:'/media/new.png',metadata:{}});
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    if(firstWrite){firstWrite=false;await gate.promise;}
    if(request.body.revision!==state.drafts[0].revision)return response({error:'稿件版本已变化'},409);
    const result={...request.body,revision:state.drafts[0].revision+1};state.drafts[0]=result;return response(result);
  }});view.stubRender();beginEdit(view);
  const replacing=view.run("commitDraftImage('new-image',{draftId:'d1',revision:1,replaceAssetId:'photo'})");await turn();view.run("edit.body='切稿前必须保存的正文';markDraftChanged()");
  const switching=view.run("switchDraftSelection('d2')");await turn();assert.equal(view.run('selected'),'d1');gate.resolve();await Promise.all([replacing,switching]);
  assert.equal(view.state.drafts[0].body,'切稿前必须保存的正文');assert.deepEqual(view.state.drafts[0].productAssetIds,['new-image']);assert.equal(view.run('selected'),'d2');assert.equal(view.run('dirty'),false);
});

test('autosave merges a verified background image attachment and retries without losing local text',async()=>{
  const state=fixture();let firstWrite=true;
  const view=ui({state,handle:(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    if(firstWrite){firstWrite=false;state.drafts[0]={...state.drafts[0],revision:2,productAssetIds:['generated-cover']};state.imageJobs.push({id:'completed-image',draftId:'d1',draftRevision:1,attachStatus:'attached',status:'completed',assetId:'generated-cover'});return response({error:'稿件版本已变化'},409);}
    if(request.body.revision!==state.drafts[0].revision)return response({error:'稿件版本已变化'},409);
  }});view.stubRender();beginEdit(view);view.run("edit.body='本地正在编辑的新正文';markDraftChanged()");
  await view.run('flushDraftSave()');
  const writes=view.requests.filter(request=>request.method==='PUT');assert.equal(writes.length,2);assert.equal(writes[1].body.revision,2);assert.equal(writes[1].body.body,'本地正在编辑的新正文');assert.deepEqual(writes[1].body.productAssetIds,['generated-cover']);
  assert.equal(view.state.drafts[0].body,'本地正在编辑的新正文');assert.deepEqual(view.state.drafts[0].productAssetIds,['generated-cover']);assert.equal(view.run('dirty'),false);
});

test('autosave does not hide content conflicts or overwrite a locally edited image order',async()=>{
  for(const conflict of ['remote-body','local-images','unverified-images']){
    const state=fixture();const view=ui({state,handle:(request,{state})=>{
      if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
      state.drafts[0]={...state.drafts[0],revision:2,productAssetIds:['generated-cover'],...(conflict==='remote-body'?{body:'另一窗口修改的正文'}:{})};
      if(conflict!=='unverified-images')state.imageJobs.push({id:'completed-image',draftId:'d1',draftRevision:1,attachStatus:'attached',status:'completed',assetId:'generated-cover'});
      return response({error:'稿件版本已变化'},409);
    }});view.stubRender();beginEdit(view);view.run("edit.body='本地不能丢的内容';markDraftChanged()");if(conflict==='local-images')view.run("edit.productAssetIds=['local-choice']");
    await assert.rejects(view.run('flushDraftSave()'),/稿件版本已变化/);
    assert.equal(view.requests.filter(request=>request.method==='PUT').length,1,conflict);assert.equal(view.run('edit.body'),'本地不能丢的内容',conflict);assert.equal(view.run('dirty'),true,conflict);
    if(conflict==='local-images')assert.deepEqual(Array.from(view.run('edit.productAssetIds')),['local-choice']);
    if(conflict==='remote-body')assert.equal(view.state.drafts[0].body,'另一窗口修改的正文');
  }
});

test('adopting an older generated image preserves text typed while adoption is in flight',async()=>{
  const gate=deferred(),state=fixture();state.drafts[0].revision=4;state.productAssets.push({id:'generated-cover',name:'已生成图片',kind:'image',mime:'image/png',fileUrl:'/media/generated.png',metadata:{}});
  state.imageJobs.push({id:'old-generation',draftId:'d1',draftRevision:1,attachStatus:'conflict',status:'completed',assetId:'generated-cover'});
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url==='/api/drafts/d1/images/old-generation/adopt'){
      await gate.promise;state.drafts[0]={...state.drafts[0],revision:5,productAssetIds:['photo','generated-cover']};state.imageJobs[0].attachStatus='attached';state.imageJobs[0].attachedRevision=5;
      return response({draft:state.drafts[0],job:state.imageJobs[0]});
    }
    if(request.url==='/api/drafts/d1'&&request.method==='PUT'&&request.body.revision!==state.drafts[0].revision)return response({error:'稿件版本已变化'},409);
  }});view.stubRender();beginEdit(view);
  const pending=view.run("handleDraftImageAction('adopt','old-generation')");await turn();view.run("edit.body='采用图片时继续写的正文';markDraftChanged()");gate.resolve();await pending;
  await view.run('flushDraftSave()');assert.equal(view.state.drafts[0].body,'采用图片时继续写的正文');assert.deepEqual(view.state.drafts[0].productAssetIds,['photo','generated-cover']);assert.equal(view.run('dirty'),false);
});

test('switching to text while an image replacement is in flight remains a text-only draft',async()=>{
  const gate=deferred(),state=fixture();let firstWrite=true;state.productAssets.push({id:'new-image',name:'新图',kind:'image',mime:'image/png',fileUrl:'/media/new.png',metadata:{}});
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    if(firstWrite){firstWrite=false;await gate.promise;}
    if(request.body.revision!==state.drafts[0].revision)return response({error:'稿件版本已变化'},409);
    const result={...request.body,revision:state.drafts[0].revision+1};state.drafts[0]=result;return response(result);
  }});view.stubRender();beginEdit(view);
  const pending=view.run("commitDraftImage('new-image',{draftId:'d1',revision:1,replaceAssetId:'photo'})");await turn();view.run("changeDraftMode('text')");gate.resolve();await pending;await view.run('flushDraftSave()');
  assert.equal(view.state.drafts[0].contentMode,'text');assert.deepEqual(view.state.drafts[0].productAssetIds,[]);assert.deepEqual(view.state.drafts[0].slides,[]);assert.equal(view.run('edit.contentMode'),'text');
});

test('polling current-draft images preserves dirty text and never rerenders the complete editor',async()=>{
  const state=fixture();state.imageJobs=[{id:'image-job',draftId:'d1',batchId:'batch',index:0,status:'generating',createdAt:'2026-10-26T01:00:00Z'}];
  const view=ui({state});beginEdit(view);view.nodes['#studio-images']=element();view.run("render=()=>{throw Error('whole editor rerendered')};edit.body='正在输入，光标要保留';markDraftChanged()");
  await view.run('pollDraftImages()');assert.equal(view.requests.filter(request=>request.url==='/api/state').length,1);assert.equal(view.run('edit.body'),'正在输入，光标要保留');assert.equal(view.run('dirty'),true);assert.match(view.nodes['#studio-images'].innerHTML,/配图/);
});

test('a crop saved after changing drafts keeps its source lineage and replaces the original image in place',async()=>{
  const gate=deferred(),state=fixture();state.productAssets.push({id:'second',name:'第二张',kind:'image',mime:'image/png',fileUrl:'/media/second.png',metadata:{}});state.drafts[0].productAssetIds=['photo','second'];
  const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/product-assets/upload')return;
    await gate.promise;const asset={id:'cropped',name:request.body.name,kind:'image',mime:'image/png',fileUrl:'/media/cropped.png',metadata:{adjustedFromAssetId:request.body.sourceAssetId}};state.productAssets.push(asset);return response(asset);
  }});view.stubRender();beginEdit(view);view.context.File=File;view.context.FileReader=class{readAsDataURL(){this.result='data:image/png;base64,cG5n';this.onload();}};
  view.nodes['#image-crop-canvas']=element({toBlob(callback){callback(new Blob(['png'],{type:'image/png'}));}});
  view.run("draftImageContext={draftId:'d1',revision:1,replaceAssetId:'second'};imageSourceId='second';cropReady=true;drawWorkbenchCanvas=async()=>true");
  const pending=view.run('saveDraftImageCrop()');await turn();beginEdit(view,'d2');view.run("imageSourceId='photo'");gate.resolve();await pending;
  assert.equal(view.requests.find(request=>request.url==='/api/product-assets/upload').body.sourceAssetId,'second');
  assert.deepEqual(view.state.drafts[0].productAssetIds,['photo','cropped']);assert.deepEqual(view.state.drafts[1].productAssetIds,['photo']);assert.equal(view.run('selected'),'d2');assert.equal(view.run('edit.id'),'d2');
});

test('opening crop preserves the source ratio so portrait covers do not immediately lose their edges',async()=>{
  for(const [width,height,ratio] of [[1024,1536,'2:3'],[1200,1600,'3:4'],[1024,1024,'1:1'],[1600,1200,'4:3']]){
    const view=ui();beginEdit(view);const draws=[];view.context.sourceImage={naturalWidth:width,naturalHeight:height};view.run('loadWorkbenchImage=async()=>sourceImage');
    const canvas=element({getContext(){return {fillRect(){},drawImage(...args){draws.push(args);}};}});view.nodes['#image-crop-canvas']=canvas;view.nodes['#crop-dimensions']=element();view.nodes['#crop-save']=element({disabled:true});view.nodes['#crop-error']=element({hidden:true});
    await view.run("openDraftImageCrop('photo')");
    assert.equal(view.run('cropSettings.ratio'),ratio);assert.equal(view.run('page'),'studio');assert.equal(view.nodes['#modal'].open,true);assert.equal(view.nodes['#crop-save'].disabled,false);
    const [,x,y,drawWidth,drawHeight]=draws.at(-1);assert.equal(x,0,ratio);assert.equal(y,0,ratio);assert.equal(drawWidth,canvas.width,ratio);assert.equal(drawHeight,canvas.height,ratio);
  }
});

test('stale image destinations and non-publication assets cannot overwrite a draft',async()=>{
  for(const scenario of ['stale','test','preview']){
    const state=fixture();state.productAssets.push({id:'preview',name:'模型预览',kind:'image',mime:'image/png',metadata:{modelAssetId:'model'}});
    if(scenario==='stale')state.drafts[0].revision=2;
    const view=ui({state});view.stubRender();beginEdit(view);
    const target=scenario==='stale'?'photo':scenario==='test'?'test-photo':'preview';view.context.targetId=target;
    await assert.rejects(view.run("commitDraftImage(targetId,{draftId:'d1',revision:1,replaceAssetId:'photo'})"),/稿件已修改|请选择产品照片或成品配图/);
    assert.equal(view.requests.filter(request=>request.method==='PUT').length,0,scenario);assert.deepEqual(view.state.drafts[0].productAssetIds,['photo'],scenario);
  }
});

test('replacing an image with another already attached image cannot create duplicate slides',async()=>{
  const state=fixture();state.productAssets.push({id:'second',name:'第二张',kind:'image',mime:'image/png',fileUrl:'/media/second.png',metadata:{}});state.drafts[0].productAssetIds=['photo','second'];
  const view=ui({state});view.stubRender();beginEdit(view);
  await assert.rejects(view.run("commitDraftImage('photo',{draftId:'d1',revision:1,replaceAssetId:'second'})"),/已在稿件中/);
  assert.equal(view.requests.some(request=>request.method==='PUT'),false);assert.deepEqual(view.state.drafts[0].productAssetIds,['photo','second']);
});

test('image controls reorder and remove by identity without duplicating or dropping other images',async()=>{
  const state=fixture();for(const id of ['second','third'])state.productAssets.push({id,name:id,kind:'image',mime:'image/png',fileUrl:'/media/'+id+'.png',metadata:{}});state.drafts[0].productAssetIds=['photo','second','third'];
  const view=ui({state});view.stubRender();beginEdit(view);
  await view.run("mutateDraftImage('left','third')");assert.deepEqual(Array.from(view.run('draftPhotos(edit).map(asset=>asset.id)')),['photo','third','second']);
  await view.run("mutateDraftImage('first','second')");assert.deepEqual(Array.from(view.run('draftPhotos(edit).map(asset=>asset.id)')),['second','photo','third']);
  await view.run("mutateDraftImage('right','second')");assert.deepEqual(Array.from(view.run('draftPhotos(edit).map(asset=>asset.id)')),['photo','second','third']);
  await view.run("mutateDraftImage('remove','second')");assert.deepEqual(Array.from(view.run('draftPhotos(edit).map(asset=>asset.id)')),['photo','third']);
  await view.run('flushDraftSave()');assert.deepEqual(view.state.drafts[0].productAssetIds,['photo','third']);
});

test('failed saves keep input, selection and navigation until a successful retry',async()=>{
  let fail=true;
  const view=ui({handle:request=>request.method==='PUT'&&fail?response({error:'保存暂不可用'},503):undefined});view.stubRender();beginEdit(view);view.run("accountFilter='official';location.hash='studio';edit.title='不能丢的输入';markDraftChanged()");
  await assert.rejects(view.run('flushDraftSave()'),/保存暂不可用/);assert.equal(view.run('dirty'),true);assert.equal(view.run('edit.title'),'不能丢的输入');assert.match(view.nodes['#save-state'].textContent,/保存失败/);assert.equal(view.nodes['[data-action="save-retry"]'].hidden,false);
  view.context.target=element({dataset:{action:'edit',id:'d2'}});await view.run('action(target)');
  assert.equal(view.run('selected'),'d1');assert.equal(view.run('accountFilter'),'official');assert.equal(view.run('edit.title'),'不能丢的输入');assert.equal(view.context.location.hash,'studio');
  assert.equal(await view.run("switchDraftSelection('secondary',{account:true})"),false);assert.equal(view.run('accountFilter'),'official');assert.equal(view.nodes['#account-filter'].value,'official');
  fail=false;await view.run('flushDraftSave()');assert.equal(view.run('dirty'),false);assert.equal(view.run('draftSaveError'),'');assert.equal(view.run('edit.title'),'不能丢的输入');
});

test('late save acknowledgements cannot restore editor state after logout',async()=>{
  const gate=deferred();const view=ui({handle:async request=>request.method==='PUT'?(await gate.promise,response({...request.body,revision:2})):undefined});view.stubRender();beginEdit(view);view.run("edit.body='尚未返回的保存';markDraftChanged()");
  const pending=view.run('flushDraftSave()');await turn();view.run('authRequired()');gate.resolve();await pending;
  assert.equal(view.run('S'),null);assert.equal(view.run('edit'),null);assert.equal(view.nodes['#app'].hidden,true);assert.equal(view.context.location.redirect,'/login');
});

test('schedule preview waits for autosave and confirms exactly the preview revision',async()=>{
  const gate=deferred();const view=ui({handle:async(request,{state})=>{
    if(request.method==='PUT'&&request.url==='/api/drafts/d1'){await gate.promise;const result={...request.body,revision:2};state.drafts[0]=result;return response(result);}
    if(request.url==='/api/drafts/d1/schedule'){state.jobs.push({id:'publish-1',draftId:'d1',accountId:'official',title:state.drafts[0].title,status:'scheduled',scheduledAt:request.body.scheduledAt});return response(state.jobs[0]);}
  }});view.stubRender();beginEdit(view);view.run("edit.title='已保存后确认的标题';markDraftChanged()");
  const pending=view.run("schedule('d1')");await turn();assert.equal(view.nodes['#modal'].open,false);assert.equal(view.requests.filter(r=>r.url.endsWith('/schedule')).length,0);
  gate.resolve();await pending;assert.equal(view.nodes['#modal'].open,true);assert.match(view.nodes['#modal-content'].innerHTML,/data-revision="2"/);assert.match(view.nodes['#modal-content'].innerHTML,/已保存后确认的标题/);
  const error=element({hidden:true}),form=element({id:'schedule-form',dataset:{id:'d1',account:'official',revision:'2'},values:{scheduledAt:'2026-10-26T19:30'},querySelector:selector=>selector==='[data-schedule-error]'?error:null});
  await view.submit(form);const sent=view.requests.find(r=>r.url.endsWith('/schedule'));
  assert.equal(sent.body.confirm,true);assert.equal(sent.body.revision,2);assert.equal(sent.body.accountId,'official');assert.equal(view.requests.some(r=>/\/approve$/.test(r.url)),false);assert.equal(view.run('page'),'calendar');
});

test('a failed save prevents schedule confirmation and keeps the current editor',async()=>{
  const view=ui({handle:request=>request.method==='PUT'?response({error:'保留当前内容'},500):undefined});view.stubRender();beginEdit(view);view.run("edit.body='保留这一版正文';markDraftChanged()");
  const error=element({hidden:true}),form=element({id:'schedule-form',dataset:{id:'d1',account:'official',revision:'1'},values:{scheduledAt:'2026-10-26T19:30'},querySelector:selector=>selector==='[data-schedule-error]'?error:null});
  const button=await view.submit(form);assert.equal(view.requests.some(r=>r.url.endsWith('/schedule')),false);assert.equal(view.run('edit.body'),'保留这一版正文');assert.equal(view.run('dirty'),true);assert.equal(error.hidden,false);assert.match(error.textContent,/保留当前内容/);assert.equal(button.disabled,false);
});

test('confirmation waits for pending save and surfaces a stale preview without silently approving changes',async()=>{
  const gate=deferred();const view=ui({handle:async(request,{state})=>{
    if(request.url==='/api/drafts/d1'&&request.method==='PUT'){await gate.promise;const result={...request.body,revision:2};state.drafts[0]=result;return response(result);}
    if(request.url==='/api/drafts/d1/schedule')return response({error:'内容已变化，请重新预览后确认'},409);
  }});view.stubRender();beginEdit(view);view.nodes['#modal'].open=true;view.run("edit.body='预览后又修改的正文';markDraftChanged()");
  const error=element({hidden:true}),form=element({id:'schedule-form',dataset:{id:'d1',account:'official',revision:'1'},values:{scheduledAt:'2026-10-26T19:30'},querySelector:selector=>selector==='[data-schedule-error]'?error:null});
  const pending=view.submit(form);await turn();assert.equal(view.requests.some(r=>r.url.endsWith('/schedule')),false);assert.equal(view.run('busy'),true);
  gate.resolve();await pending;const sent=view.requests.find(r=>r.url.endsWith('/schedule'));assert.equal(sent.body.revision,1);assert.equal(sent.body.confirm,true);assert.equal(view.run('edit.body'),'预览后又修改的正文');assert.equal(view.nodes['#modal'].open,true);assert.equal(error.hidden,false);assert.match(error.textContent,/重新预览/);assert.equal(view.run('busy'),false);
});

test('completed generation notifies once without a persistent completion banner',()=>{
  const view=ui();view.stubRender();beginEdit(view);view.run("dirty=true;S.draftGenerationJobs=[{id:'watched',status:'completed',draftId:'d2',referenceId:'pending',accountId:'secondary'},{id:'old',status:'completed',draftId:'d1',accountId:'official'},{id:'active',status:'running',phase:'generating',referenceId:'pending',accountId:'official'}];draftGenerationWatched.add('watched');openCompletedGeneration();openCompletedGeneration()");
  assert.equal(view.notifications.filter(message=>message.includes('草稿已生成')).length,1);assert.equal(view.run('selected'),'d1');assert.equal(view.run('edit.id'),'d1');
  const markup=view.run('draftGenerationJobsMarkup()');assert.doesNotMatch(markup,/data-generation-job-id="(?:watched|old)"|草稿已生成/);assert.match(markup,/data-generation-job-id="active"/);
  view.run("dirty=false;page='library';openCompletedGeneration()");assert.equal(view.notifications.filter(message=>message.includes('草稿已生成')).length,1);assert.equal(view.run('selected'),'d1');
});
