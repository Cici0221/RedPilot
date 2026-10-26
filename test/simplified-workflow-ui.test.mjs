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
  const html=view.nodes['#app'].innerHTML;assert.match(html,/<h1>今日工作台<\/h1>/);assert.match(html,/待核对/);assert.match(html,/核对产品稿/);assert.match(html,/新发现/);assert.match(html,/最近草稿/);
  assert.equal((html.match(/data-page="overview"/g)||[]).length,1);assert.doesNotMatch(html,/data-page="reports"/);
});

test('legacy storyboard and series remain absent from the editor',()=>{
  const view=ui();beginEdit(view);const html=view.run('studio()');
  assert.match(html,/已自动保存/);assert.match(html,/预览并排期/);assert.doesNotMatch(html,/UNIQUE_LEGACY_STORYBOARD|UNIQUE_LEGACY_SERIES|name="series"|data-slide-field|辅助分镜|内容栏目/);
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

test('moving a draft to another account keeps the edited draft visible before and after autosave',async()=>{
  const state=fixture();state.drafts.push({...clone(state.drafts[0]),id:'other-official',title:'另一篇官方草稿'});
  const gate=deferred();const view=ui({state,handle:async(request,{state})=>{
    if(request.url!=='/api/drafts/d1'||request.method!=='PUT')return;
    await gate.promise;const result={...request.body,revision:state.drafts[0].revision+1};state.drafts[0]=result;return response(result);
  }});beginEdit(view);view.run("accountFilter='official';render=()=>studio();edit.accountId='secondary';markDraftChanged()");
  const pending=view.run('flushDraftSave()');await turn();view.run("edit.body='改属期间继续输入';markDraftChanged();changeDraftMode('text')");
  assert.equal(view.run('draftCurrent().id'),'d1');assert.equal(view.run('selected'),'d1');assert.equal(view.run('edit.body'),'改属期间继续输入');
  gate.resolve();await pending;
  assert.equal(view.run('accountFilter'),'secondary');assert.equal(view.run('operationsAccountId'),'secondary');assert.equal(view.run('dirty'),false);assert.equal(view.run('draftCurrent().id'),'d1');
  view.run("edit.body='改属保存后继续输入';markDraftChanged();changeDraftMode('image')");
  assert.equal(view.run('selected'),'d1');assert.equal(view.run('edit.body'),'改属保存后继续输入');assert.equal(view.run('edit.accountId'),'secondary');assert.equal(view.run('dirty'),true);
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
