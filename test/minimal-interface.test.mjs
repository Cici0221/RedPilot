import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const listeners=source.slice(source.indexOf("document.addEventListener('click'"),source.indexOf("window.addEventListener('pageshow'"));
const clone=value=>structuredClone(value);
const reply=value=>({ok:true,status:200,json:async()=>clone(value)});
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const attributes=html=>Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,decode(value)]));
const elements=(html,tag)=>[...html.matchAll(new RegExp('<'+tag+'\\b[^>]*>','g'))].map(match=>attributes(match[0]));

function fixture(){
  const reportSettings={enabled:true,time:'09:00',timezone:'Asia/Shanghai',lastDailyKey:null};
  const settings={enabled:false,time:'10:00',timezone:'Asia/Shanghai',mode:'automatic',imageShare:70};
  const account=(id,name)=>({id,name,type:id==='official'?'official':'personal',enabled:true,archived:false,settings:clone(settings),reportSettings:clone(reportSettings)});
  const metrics=[
    ['scheduled_today','今日排期',0,'#accounts/calendar'],['published_today','今日已发布',0,'#accounts/calendar'],['pending_review','待核对草稿',2,'#studio'],
    ['publishing_issues','发布待处理',0,'#accounts/calendar'],['generation_issues','生成待处理',0,'#studio'],['related_new','关联新收藏',3,'#library']
  ].map(([key,label,value,route])=>({key,label,value,route,unit:'项',detail:'METRIC_DETAIL_SHOULD_NOT_RENDER'}));
  return {
    accounts:[account('official','官方账号'),account('secondary','小号')],defaultAccountId:'official',settings,
    product:{name:'产品',brand:'品牌',summary:'产品事实',version:1,facts:[],conditions:[],restrictions:[],sources:[]},
    productAssets:[],inspirations:[{id:'saved-reference',title:'已收藏来源',text:'来源正文',url:'https://example.test/source',tags:[],assets:[],uses:0,status:'ready',linkRead:{status:'ready'}}],
    drafts:[],draftChecks:{},jobs:[],events:[],creators:[],creatorSyncs:[],analysisTasks:[],draftGenerationJobs:[],topicPool:[],discussions:[],
    capabilities:{ai:true,model:'mock-model',publisher:false,accounts:{official:{publisher:false},secondary:{publisher:false}},linkReader:true,textPublisher:false},
    trendBoards:[],trendMatches:{official:[],secondary:[]},trendRefreshJobs:[],reportJobs:[],
    operationReports:[{id:'report-secondary',accountId:'secondary',date:'2026-10-26',status:'ready',generatedAt:'2026-10-26T01:00:00Z',metrics,plans:[],discoveries:[{id:'source-discovery',title:'可继续创作的发现',kind:'reference',detail:'用自己的产品事实解释这个场景',sources:[{kind:'reference',id:'saved-reference',title:'已收藏来源',url:'#reference/saved-reference'}]}],snapshot:{date:'2026-10-26',timezone:'Asia/Shanghai',mode:'live',asOf:'2026-10-26T01:00:00Z'}}],
    feishuSync:{enabled:false,status:'idle',sourceUrls:[]},feishuDocuments:[],feishuJobs:[],imageJobs:[],imageProvider:{ready:false}
  };
}
function node(extra={}){return {innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',dataset:{},classList:{add(){},remove(){},toggle(){}},querySelector(){return null;},querySelectorAll(){return [];},...extra};}
function ui(state=fixture()){
  const events={},requests=[],nodes={'#app':node(),'#modal':node({open:false,showModal(){this.open=true;},close(){this.open=false;}}),'#modal-content':node(),'#toast':node(),'#draft-generation-status':node()};
  class FormDataMock{
    constructor(form){this.entries=Object.entries(form.values||{});}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
    has(key){return this.entries.some(([name])=>name===key);}
    getAll(key){return this.entries.filter(([name])=>name===key).map(([,value])=>value);}
  }
  const context=vm.createContext({URL,Intl,Date,Math,structuredClone,AbortSignal,FormData:FormDataMock,console,crypto:{randomUUID:()=>`mock-${requests.length}`},setTimeout:()=>1,clearTimeout(){},confirm:()=>true,
    document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[],activeElement:{id:''},addEventListener:(type,handler)=>{events[type]=handler;}},location:{hash:'',replace(){}},window:{scrollTo(){}},
    fetch:async(url,options={})=>{
      const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);
      if(url==='/api/state'&&request.method==='GET')return reply(state);
      if(/^\/api\/accounts\/[^/]+\/settings$/.test(url)&&request.method==='PUT'){
        const account=state.accounts.find(item=>url===`/api/accounts/${item.id}/settings`);account.settings={...account.settings,...request.body};return reply(account.settings);
      }
      if(url==='/api/product'&&request.method==='PUT'){Object.assign(state.product,request.body);return reply(state.product);}
      if(url==='/api/draft-generations'&&request.method==='POST'){
        const job={id:'new-generation',...request.body,status:'queued',phase:'queued'};state.draftGenerationJobs.push(job);return reply(job);
      }
      throw Error('Unexpected mock request: '+request.method+' '+url);
    }});
  vm.runInContext(definitions,context);context.initial=clone(state);vm.runInContext('S=initial;',context);vm.runInContext(listeners,context);
  return {state,nodes,requests,context,run:code=>vm.runInContext(code,context),async submit(form){await events.submit({target:form,submitter:node(),preventDefault(){}});}};
}

test('daily workspace has useful report controls but no report settings or unrelated blank-draft entry',()=>{
  const view=ui();view.run("page='overview';workspaceId='secondary';operationsAccountId='secondary';reportDate='2026-10-26';render()");
  const html=view.nodes['#app'].innerHTML;
  assert.match(html,/data-action="report-generate"/);assert.match(html,/id="report-date"/);assert.match(html,/09:00/);assert.match(html,/北京时间/);
  assert.doesNotMatch(html,/data-action="report-settings"|日报设置|data-action="generate"|新建草稿/);
  assert.doesNotMatch(html,/workspace-card|local-label|本机存储/);
  assert.match(html,/data-action="logout"/);assert.match(html,/data-page="studio"/);
  view.run("page='studio'");assert.match(view.run('studio()'),/data-action="generate"/);
});

test('saved report tasks show only actionable titles without review counts or internal notes',()=>{
  const state=fixture(),report=state.operationReports[0];
  report.plans=[{id:'draft-review',title:'核对草稿：备用号',done:false,priority:'high',detail:'有 4 项需要核对，处理后再排期。',blockers:['产品资料已更新，请重新生成或核对后保存草稿','三份 syncedSources 均标记 complete=false','尚无完整实机验证'],sources:[{title:'PLAN_INTERNAL_SOURCE',url:'https://example.test/plan-internal'}],action:{type:'draft',id:'draft-1',label:'打开草稿'}}];
  const original=clone(report.plans),view=ui(state);view.run("page='overview';workspaceId='secondary';operationsAccountId='secondary';reportDate='2026-10-26';render()");
  const html=view.nodes['#app'].innerHTML;
  assert.match(html,/核对草稿：备用号/);assert.match(html,/data-report-plan="draft-review"/);assert.match(html,/0 \/ 1/);
  assert.doesNotMatch(html,/查看核对项|report-plan-details|report-blockers|有 4 项需要核对|处理后再排期|产品资料已更新|syncedSources|complete=false|实机验证|PLAN_INTERNAL_SOURCE|>优先</);
  const action=elements(html,'button').find(button=>button['data-report-action']&&JSON.parse(button['data-report-action']).id==='draft-1');
  assert.ok(action);assert.equal(action['data-account-id'],'secondary');assert.match(html,/可继续创作的发现/);assert.match(html,/href="#reference\/saved-reference"/);
  assert.deepEqual(state.operationReports[0].plans,original);
});

test('product editing omits internal rule fields and saving visible copy preserves source context',async()=>{
  const state=fixture();state.product.conditions=['内部事实前提'];state.product.restrictions=['内部事实边界'];
  const view=ui(state),html=view.run('productFacts()');
  assert.doesNotMatch(html,/品牌 \/ 团队|name="brand"|使用条件|未验证承诺|name="conditions"|name="restrictions"|name="stage"|当前产品阶段|内部事实前提|内部事实边界/);
  assert.match(html,/产品名称/);assert.match(html,/产品一句话说明/);assert.match(html,/资料来源/);
  view.run('render=()=>{}');
  await view.submit(node({id:'product-form',values:{name:'新产品名',summary:'新介绍',facts:'一项卖点',sources:'https://example.test/product'}}));
  const saved=view.requests.find(request=>request.url==='/api/product'&&request.method==='PUT');
  assert.equal(saved.body.summary,'新介绍');assert.deepEqual(saved.body.facts,['一项卖点']);assert.equal(saved.body.brand,'品牌');
  assert.deepEqual(saved.body.conditions,['内部事实前提']);assert.deepEqual(saved.body.restrictions,['内部事实边界']);
});

test('home omits stored sync notices and housekeeping plans while retaining publication work and matching counts',()=>{
  const state=fixture(),report=state.operationReports[0];
  report.status='partial';report.issues=['共用产品资料同步尚未完整完成，旧快照不会被当作新实测依据'];
  report.plans=[
    {id:'draft-review',key:'draft:1',kind:'review',title:'处理这篇草稿',done:false,action:{type:'draft',id:'1',route:'#draft/1',label:'打开草稿'}},
    {id:'sync',key:'sync:feishu',kind:'sync',title:'核对产品资料同步',done:true,action:{type:'product',route:'#product'}},
    {id:'product',key:'product:v1',kind:'source',title:'例行产品资料检查',done:false,action:{type:'product',route:'#product'}}
  ];
  const view=ui(state);view.run("page='overview';workspaceId='secondary';reportDate='2026-10-26'");
  const html=view.run('reports()');
  assert.doesNotMatch(html,/资料待确认|共用产品资料同步|旧快照不会|report-issues|部分资料|核对产品资料同步|例行产品资料检查/);
  assert.match(html,/处理这篇草稿/);assert.match(html,/0 \/ 1/);assert.match(html,/可继续创作的发现/);
  assert.equal(report.issues.length,1);assert.equal(report.plans.length,3);
});

test('operations never duplicate the global workspace account switcher',()=>{
  const state=fixture();state.accounts=state.accounts.slice(0,1);const view=ui(state);
  assert.doesNotMatch(view.run('operationsAccountSelect()'),/<select\b/);
  view.run("S.accounts.push({id:'archived',name:'历史账号',archived:true,enabled:false})");
  assert.doesNotMatch(view.run('operationsAccountSelect()'),/<select\b/);
  view.context.second=fixture().accounts[1];view.run("S.accounts.push(second);operationsAccountId='secondary'");
  const html=view.run('operationsAccountSelect()');assert.equal(html,'');assert.match(view.run('accountMenuMarkup()'),/小号/);assert.doesNotMatch(view.run('accountMenuMarkup()'),/历史账号/);
});

test('report metrics keep three core cards and surface nonzero issue routes without verbose definitions',async()=>{
  const view=ui(),markup=()=>view.run('reportMetricsMarkup(S.operationReports[0])');
  const quiet=markup();assert.equal((quiet.match(/class="report-metric"/g)||[]).length,3);
  for(const label of ['今日排期','今日已发布','待核对草稿'])assert.match(quiet,new RegExp(label));
  assert.doesNotMatch(quiet,/发布待处理|生成待处理|关联新收藏|METRIC_DETAIL/);
  view.run("S.operationReports[0].metrics.find(item=>item.key==='publishing_issues').value=1;S.operationReports[0].metrics.find(item=>item.key==='generation_issues').value=2");
  const issue=markup();assert.match(issue,/发布待处理/);assert.match(issue,/生成待处理/);assert.doesNotMatch(issue,/关联新收藏|METRIC_DETAIL/);assert.equal((issue.match(/class="report-metric"/g)||[]).length,3);
  const issueButtons=[...issue.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match=>match[0]);
  for(const [label,route,page] of [['发布待处理','#accounts/calendar','calendar'],['生成待处理','#studio','studio']]){
    const markup=issueButtons.find(button=>button.includes(label));assert.ok(markup,label);const button=attributes(markup);
    assert.equal(button['data-action'],'report-action');assert.equal(JSON.parse(button['data-report-action']).route,route);assert.equal(button['data-account-id'],'secondary');
    view.context.metricAction=JSON.parse(button['data-report-action']);view.run('render=()=>{}');await view.run("openReportAction(metricAction,'secondary')");
    assert.equal(view.run('page'),page);assert.equal(view.run('accountFilter'),'secondary');
  }
});

test('account connection and daily automation controls have one home in account management',()=>{
  const view=ui();
  assert.equal(view.run("knownPages.has('settings')"),false);
  assert.equal(view.run("nestedPages.settings"),'overview');
  assert.doesNotMatch(source,/function settings\(|ai-connection-form|data-page="settings"/);
  view.run("page='accounts'");const accounts=view.run('accounts()');
  for(const action of ['publisher-connect','daily']){
    const controls=elements(accounts,'button').filter(button=>button['data-action']===action);assert.deepEqual(controls.map(button=>button['data-id']),['official']);
  }
  view.run("page='calendar'");const calendar=view.run('calendar()');
  assert.doesNotMatch(calendar,/data-action="daily"|data-ai-connector|data-publisher-connector|data-feishu-connector|每日任务设置/);
  assert.match(calendar,/发布队列|暂无发布任务/);
});

test('daily automation retains the clicked account without a second account picker or cross-account save',async()=>{
  const view=ui();view.run("accountFilter='official';daily('secondary')");
  const html=view.nodes['#modal-content'].innerHTML,form=elements(html,'form').find(item=>item.id==='settings-form'),account=elements(html,'input').find(item=>item.name==='accountId');
  assert.ok(form);assert.equal(form['data-id'],'secondary');assert.ok(account);assert.equal(account.type,'hidden');assert.equal(account.value,'secondary');
  assert.doesNotMatch(html,/<select[^>]+(?:name="accountId"|id="daily-account")/);assert.match(html,/小号/);
  const before=clone(view.state.accounts[0].settings);view.run('render=()=>{}');
  await view.submit(node({id:form.id,dataset:{id:form['data-id']},values:{accountId:account.value,enabled:'on',time:'11:30',timezone:'Asia/Shanghai',mode:'review',imageShare:'80'}}));
  const writes=view.requests.filter(request=>request.method==='PUT');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/accounts/secondary/settings');assert.equal(writes[0].body.accountId,'secondary');
  assert.equal(writes[0].body.imageShare,80);assert.equal(writes[0].body.enabled,true);assert.deepEqual(view.state.accounts[0].settings,before);assert.equal(view.state.accounts[1].settings.time,'11:30');assert.equal(view.nodes['#modal'].open,false);
});

test('a report discovery still generates in the selected account with its saved source and instructions',async()=>{
  const view=ui();view.run("page='overview';workspaceId='secondary';operationsAccountId='secondary';reportDate='2026-10-26'");
  const html=view.run('reportDiscoveryMarkup(S.operationReports[0])'),button=elements(html,'button').find(item=>item['data-action']==='operation-create');
  assert.ok(button);assert.equal(button['data-kind'],'discovery');assert.equal(button['data-id'],'source-discovery');assert.equal(button['data-context'],'report-secondary');
  view.run('render=()=>{}');await view.run("createOperationDraft('discovery','source-discovery','report-secondary')");
  const posts=view.requests.filter(request=>request.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/draft-generations');
  assert.equal(posts[0].body.accountId,'secondary');assert.equal(posts[0].body.referenceId,'saved-reference');assert.equal(posts[0].body.instruction,'用自己的产品事实解释这个场景');assert.equal(view.run('page'),'studio');
});
