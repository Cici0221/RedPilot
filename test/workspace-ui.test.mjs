import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(value)});
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const node=extra=>({innerHTML:'',textContent:'',open:false,inert:false,hidden:false,dataset:{},classList:{add(){},remove(){},toggle(){}},close(){this.open=false;},querySelectorAll(){return [];},...extra});
function state(id='a'){return {workspaceAccountId:id,defaultAccountId:id,accounts:['a','b'].map((id,i)=>({id,name:i?'生活小号':'人类补丁',type:i?'personal':'official',enabled:true,archived:false,settings:{enabled:false}})),product:{name:id+'产品',facts:[],conditions:[],restrictions:[],sources:[]},productAssets:[],drafts:[],jobs:[],inspirations:[],creators:[],capabilities:{accounts:{}},events:[],imageJobs:[],draftGenerationJobs:[],operationReports:[],trendBoards:[],trendMatches:{[id]:[]}};}
function ui({handle,stored='',confirm=true}={}){
 const requests=[],messages=[],saved=new Map(stored?[['redpilot.workspace',stored]]:[]),nodes={'#app':node(),'#modal':node(),'#modal-content':node(),'#toast':node()};
 const context=vm.createContext({URL,Date,Intl,Math,AbortSignal,structuredClone,console,setTimeout:()=>1,clearTimeout(){},confirm:()=>confirm,
 localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},location:{hash:'',replace(){}},window:{scrollTo(){}},document:{querySelector:key=>nodes[key]||null,querySelectorAll:()=>[]},
 fetch:async(url,options={})=>{const request={url,headers:options.headers||{},method:options.method||'GET',body:typeof options.body==='string'?JSON.parse(options.body):options.body};requests.push(request);const result=await handle?.(request);if(result)return result;return reply(state(request.headers['X-RedPilot-Account']||'a'));}
 });vm.runInContext(definitions,context);context.initial=state();context.notify=message=>messages.push(message);vm.runInContext('S=initial;toast=notify;render=()=>{};',context);
 return {run:code=>vm.runInContext(code,context),context,requests,messages,saved,nodes};
}
test('sidebar menu unifies switching, management and logout; schedule has its own navigation',()=>{
 const view=ui(),html=view.run('accountMenuMarkup()');
 assert.match(html,/人类补丁/);assert.match(html,/生活小号/);assert.equal((html.match(/data-action="workspace-switch"/g)||[]).length,2);
 assert.match(html,/data-page="accounts"/);assert.match(html,/data-action="logout"/);
 assert.equal(view.run('labels.calendar'),'发布排期');assert.equal(view.run('labels.accounts'),undefined);
 assert.equal(view.run("workspaceRoot('calendar')"),'calendar');assert.equal(view.run("operationsAccountSelect()"),'');
 view.run("page='studio'");assert.doesNotMatch(view.run("topHead('创作工作台')"),/account-filter|operations-account/);
 assert.doesNotMatch(view.run('accounts()'),/生活小号|设为默认|账号列表|已归档<\/button>/);
});
test('requests and all local media carry the current account, including raw model uploads',async()=>{
 const view=ui({handle:request=>request.url.includes('upload-model')?reply({id:'model-a'}):undefined});
 await view.run("api('inspirations',{title:'A'},'POST')");
 view.context.model={name:'产品.glb',size:100};await view.run('uploadModelFile(model)');
 assert.deepEqual(view.requests.map(r=>r.headers['X-RedPilot-Account']),['a','a']);
 for(const path of ['/api/product-assets/a/file','/uploads/photo.png','/examples/demo.png']){view.context.path=path;assert.equal(view.run('workspaceMediaUrl(path)'),path+'?workspace=a');}
 assert.equal(view.run("workspaceMediaUrl('/uploads/a.png?size=2#image')"),'/uploads/a.png?size=2&workspace=a#image');
 assert.equal(view.run("workspaceMediaUrl('/uploads/a.png?workspace=b')"),'/uploads/a.png?workspace=b');
 assert.equal(view.run("workspaceMediaUrl('https://example.test/photo.png')"),'https://example.test/photo.png');
});
test('switch waits for draft persistence, then clears workspace UI and remembers the account',async()=>{
 const gate=defer(),view=ui();view.context.gate=gate.promise;
 view.run("flushDraftSave=async()=>{await gate};selected='old';edit={id:'old'};query='A';imagePrompt='A';productTab='assets';draftImageRequests.set('old',{});imageAssetCache.set('old',{});draftGenerationWatched.add('old');");
 const switching=view.run("switchWorkspace('b')");await Promise.resolve();assert.equal(view.requests.length,0);assert.equal(view.run('currentWorkspaceId()'),'a');
 gate.resolve();assert.equal(await switching,true);assert.equal(view.run('S.workspaceAccountId'),'b');assert.equal(view.saved.get('redpilot.workspace'),'b');
 for(const expression of ['selected','edit','draftImageContext'])assert.equal(view.run(expression),null);
 for(const expression of ['query','imagePrompt'])assert.equal(view.run(expression),'');
 assert.equal(view.run('productTab'),'facts');assert.equal(view.run('imageAssetCache.size'),0);assert.equal(view.run('draftImageRequests.size'),0);assert.equal(view.run('draftGenerationWatched.size'),0);assert.equal(view.nodes['#app'].inert,false);
});
test('late response from A is rejected after switching to B and cannot overwrite B state',async()=>{
 const gate=defer(),view=ui({handle:async request=>request.url==='/api/state'&&request.headers['X-RedPilot-Account']==='a'?(await gate.promise,reply(state('a'))):undefined});
 const stale=view.run('refresh(false)');const rejected=assert.rejects(stale,error=>error.code==='WORKSPACE_CHANGED');
 assert.equal(await view.run("switchWorkspace('b')"),true);gate.resolve();await rejected;
 assert.equal(view.run('S.workspaceAccountId'),'b');assert.equal(view.run('S.product.name'),'b产品');
});
test('unsaved product edits can cancel switching and a failed draft save keeps the old workspace',async()=>{
 const cancelled=ui({confirm:false});cancelled.run('productFormDirty=true');assert.equal(await cancelled.run("switchWorkspace('b')"),false);assert.equal(cancelled.requests.length,0);
 const failed=ui();failed.run("flushDraftSave=async()=>{throw Error('保存失败')};dirty=true;edit={id:'A'}");assert.equal(await failed.run("switchWorkspace('b')"),false);assert.equal(failed.run('currentWorkspaceId()'),'a');assert.equal(failed.run('dirty'),true);assert.equal(failed.run('edit.id'),'A');
});
test('switching is blocked until an interactive chain finishes, and failed switch preserves current data',async()=>{
 const view=ui({handle:request=>request.headers['X-RedPilot-Account']==='b'?reply({error:'暂不可用'},503):undefined});
 view.run('workspaceActions=1');assert.equal(await view.run("switchWorkspace('b')"),false);assert.equal(view.requests.length,0);
 view.run('workspaceActions=0');assert.equal(await view.run("switchWorkspace('b')"),false);assert.equal(view.run('currentWorkspaceId()'),'a');assert.equal(view.run('S.product.name'),'a产品');assert.equal(view.nodes['#app'].inert,false);
});
test('saved workspace is reused on the next visit',async()=>{
 const view=ui({stored:'b'});await view.run('refresh(false)');assert.equal(view.requests[0].headers['X-RedPilot-Account'],'b');assert.equal(view.run('chosenAccount().name'),'生活小号');
});

test('initial load recovers only an invalid remembered account, without swallowing other missing resources',async()=>{
 const view=ui({stored:'removed',handle:request=>request.headers['X-RedPilot-Account']==='removed'?reply({error:'当前账号不存在或已归档'},404):undefined});
 view.run('S=null');await view.run('loadInitialWorkspace()');assert.equal(view.requests.length,2);assert.equal(view.requests[1].headers['X-RedPilot-Account'],undefined);assert.equal(view.run('S.workspaceAccountId'),'a');assert.equal(view.saved.get('redpilot.workspace'),'a');
 const other=ui({stored:'b',handle:()=>reply({error:'资料不存在'},404)});other.run('S=null');await assert.rejects(other.run('loadInitialWorkspace()'),/资料不存在/);assert.equal(other.requests.length,1);assert.equal(other.saved.get('redpilot.workspace'),'b');
});
test('archive prepares the next account and switches atomically without retaining an archived page',async()=>{
 const view=ui({handle:request=>request.url==='/api/accounts/a/archive'?reply({...state().accounts[0],archived:true,enabled:false}):request.url==='/api/accounts/b/default'?reply(state('b').accounts[1]):undefined});
 view.context.archiveButton={dataset:{action:'account-archive',id:'a'},disabled:false};await view.run('action(archiveButton)');
 assert.deepEqual(view.requests.map(({url,headers})=>[url,headers['X-RedPilot-Account']]),[['/api/accounts/b/default','a'],['/api/state','b'],['/api/accounts/a/archive','a']]);
 assert.equal(view.run('currentWorkspaceId()'),'b');assert.equal(view.run('S.product.name'),'b产品');assert.equal(view.run("S.accounts.find(a=>a.id==='a').archived"),true);assert.equal(view.saved.get('redpilot.workspace'),'b');assert.equal(view.run('busy'),false);assert.equal(view.run('workspaceActions'),0);
 assert.doesNotMatch(view.run('accountMenuMarkup()'),/data-action="workspace-switch" data-id="a"/);
});
test('archive refuses to leave the current workspace if preloading or archiving fails',async()=>{
 for(const failing of ['/api/state','/api/accounts/a/archive']){
  const view=ui({handle:request=>request.url===failing?reply({error:'暂不可用'},503):request.url==='/api/accounts/b/default'?reply(state('b').accounts[1]):undefined});
  view.context.archiveButton={dataset:{action:'account-archive',id:'a'},disabled:false};await view.run('action(archiveButton)');
  assert.equal(view.run('currentWorkspaceId()'),'a');assert.equal(view.run('S.product.name'),'a产品');assert.equal(view.run("S.accounts.find(a=>a.id==='a').archived"),false);assert.equal(view.run('busy'),false);
  if(failing==='/api/state')assert.equal(view.requests.some(r=>r.url.endsWith('/archive')),false);
 }
 const single=ui();single.run('S.accounts=S.accounts.slice(0,1)');assert.doesNotMatch(single.run('accounts()'),/data-action="account-archive"/);
});
test('a stale response from the archived account cannot replace the destination workspace',async()=>{
 const gate=defer(),view=ui({handle:async request=>request.url==='/api/state'&&request.headers['X-RedPilot-Account']==='a'?(await gate.promise,reply(state())):request.url==='/api/accounts/a/archive'?reply({...state().accounts[0],archived:true}):request.url==='/api/accounts/b/default'?reply(state('b').accounts[1]):undefined});
 const stale=view.run('refresh(false)'),rejected=assert.rejects(stale,error=>error.code==='WORKSPACE_CHANGED');
 view.context.archiveButton={dataset:{action:'account-archive',id:'a'},disabled:false};await view.run('action(archiveButton)');gate.resolve();await rejected;assert.equal(view.run('S.workspaceAccountId'),'b');
});
