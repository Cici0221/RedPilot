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
    fetch:async(url,options={})=>{const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);const custom=await handle?.(request,state);if(custom)return custom;if(url==='/api/state')return reply(state);if(url==='/api/draft-generations'){const job={...request.body,id:'new-job',status:'running',phase:'generating'};state.draftGenerationJobs.unshift(job);return reply(job);}throw Error('Unexpected mock request '+url);}
  });
  vm.runInContext(definitions,context);context.initial=clone(state);context.notify=message=>messages.push(message);
  vm.runInContext("S=initial;workspaceId='official';accountFilter='official';toast=notify;render=()=>{};",context);
  return {run:code=>vm.runInContext(code,context),context,state,requests,messages,nodes,storage};
}

test('studio opens a browsable draft library without selecting or editing the first draft',()=>{
  const view=ui(),html=view.run('studio()');
  assert.doesNotMatch(html,/id="draft-form"|id="draft-select"|id="studio-images"|小号的私人稿/);
  for(const title of ['备用号的新安排','出门少带一台手机','周末旅行指南','桌面里的小设备'])assert.ok(html.includes(title));
  assert.match(html,/data-action="edit"[^>]*data-id="d1"/);assert.match(html,/data-action="generate"/);
  assert.equal(view.run('selected'),null);assert.equal(view.run('edit'),null);
});

test('draft cards use account-scoped real cover images and do not treat logos or tests as covers',()=>{
  const state=fixture();state.drafts[0].productAssetIds=['test-only','logo','cover'];const view=ui({state}),html=view.run('studio()');
  assert.match(html,/\/api\/product-assets\/cover\/file\?workspace=official/);
  assert.doesNotMatch(html,/<img\b[^>]*src="[^"]*(?:test-only|logo)\/file/);
  assert.match(html,/文字/);assert.doesNotMatch(html,/参考图仅供|如何使用|请选择草稿后/);
});

test('library search finds titles and body text without exposing unrelated cards',()=>{
  const view=ui();view.run("studioQuery='工作号码'");let html=view.run('studio()');
  assert.match(html,/出门少带一台手机/);assert.doesNotMatch(html,/data-id="d1"|data-id="d3"/);
  view.run("studioQuery='备用号'");html=view.run('studio()');assert.match(html,/备用号的新安排/);assert.doesNotMatch(html,/data-id="d2"/);
  view.run("studioQuery='完全不匹配的内容'");html=view.run('studio()');assert.doesNotMatch(html,/data-action="edit"/);assert.match(html,/无|没有/);
});

test('library filters distinguish drafts, scheduled content and published content',()=>{
  const view=ui();
  for(const [filter,visible,hidden] of [['draft',['d1','d2'],['d3','d4']],['scheduled',['d3'],['d1','d2','d4']],['published',['d4'],['d1','d2','d3']]]){
    view.context.filterValue=filter;view.run('studioFilter=filterValue');const html=view.run('studio()');
    for(const id of visible)assert.ok(html.includes(`data-id="${id}"`),filter+' includes '+id);
    for(const id of hidden)assert.ok(!html.includes(`data-id="${id}"`),filter+' excludes '+id);
  }
});

test('opening a card has a stable independent route and the editor has no draft picker',async()=>{
  const view=ui();assert.equal(await view.run("nav('draft/d2')"),true);
  assert.equal(view.context.location.hash,'draft/d2');assert.equal(view.run('studioView'),'draft');assert.equal(view.run('selected'),'d2');
  const html=view.run('studio()');assert.match(html,/id="draft-form"/);assert.match(html,/出门少带一台手机/);assert.doesNotMatch(html,/id="draft-select"/);assert.match(html,/返回草稿/);
});

test('refreshing an explicit draft URL preserves its identity, while invalid draft URLs never open another draft',async()=>{
  const explicit=ui({hash:'#draft/d2'});assert.equal(explicit.run('selected'),'d2');assert.equal(explicit.run('studioView'),'draft');assert.match(explicit.context.location.hash,/draft\/d2$/);assert.match(explicit.run('studio()'),/出门少带一台手机/);
  const invalid=ui();await invalid.run("nav('draft/missing')");const html=invalid.run('studio()');assert.doesNotMatch(html,/id="draft-form"/);assert.equal(invalid.run('edit'),null);
  await invalid.run("nav('draft/private')");assert.doesNotMatch(invalid.run('studio()'),/id="draft-form"|小号的私人稿/);
});

test('returning to the library waits for autosave and does not leave the previous draft selected',async()=>{
  const view=ui();await view.run("nav('draft/d1')");view.run("studio();dirty=true;edit.body='最后修改';flushDraftSave=async()=>{S.drafts.find(d=>d.id===edit.id).body=edit.body;dirty=false;};");
  assert.equal(await view.run("nav('studio')"),true);assert.equal(view.run('S.drafts.find(d=>d.id==="d1").body'),'最后修改');assert.equal(view.run('studioView'),'list');assert.equal(view.run('selected'),null);assert.equal(view.run('edit'),null);assert.doesNotMatch(view.run('studio()'),/id="draft-form"/);
});

test('a failed save keeps the draft route, editor and unsaved copy intact',async()=>{
  const view=ui();await view.run("nav('draft/d1')");view.run("studio();dirty=true;edit.body='不可丢失的修改';flushDraftSave=async()=>{throw Error('保存失败')};");
  assert.equal(await view.run("nav('studio')"),false);assert.equal(view.run('studioView'),'draft');assert.equal(view.run('edit.body'),'不可丢失的修改');assert.match(view.context.location.hash,/draft\/d1$/);
});

test('returning to the library while generating never auto-opens the background result',async()=>{
  const view=ui();await view.run("enqueueDraftGeneration({instruction:'这一次的新稿'})");assert.equal(view.run('studioView'),'generation');assert.doesNotMatch(view.run('studio()'),/id="draft-form"/);
  await view.run("nav('studio')");assert.equal(view.run('studioView'),'list');assert.match(view.run('studio()'),/这一次的新稿|生成草稿/);
  view.state.drafts.unshift({...clone(view.state.drafts[0]),id:'generated',title:'后台完成的新稿'});Object.assign(view.state.draftGenerationJobs[0],{status:'completed',draftId:'generated'});
  await view.run('pollDraftGenerations(true)');assert.equal(view.run('studioView'),'list');assert.equal(view.run('edit'),null);assert.equal(view.run('selected'),null);assert.doesNotMatch(view.run('studio()'),/id="draft-form"/);
});

test('switching accounts from an editor resets the route to that account library',async()=>{
  const view=ui();await view.run("nav('draft/d1')");view.run('studio()');view.context.other={...fixture(),workspaceAccountId:'secondary',drafts:[fixture().drafts.at(-1)]};
  view.run("applyWorkspaceState('secondary',other)");assert.equal(view.run('studioView'),'list');assert.equal(view.run('edit'),null);assert.equal(view.run('selected'),null);assert.doesNotMatch(view.context.location.hash,/draft\/d1/);const html=view.run('studio()');assert.match(html,/小号的私人稿/);assert.doesNotMatch(html,/备用号的新安排/);
});

test('background refresh repaints the library if the currently open draft no longer exists',async()=>{
  const view=ui();await view.run("nav('draft/d1')");view.nodes['#app'].innerHTML=view.run('studio()');
  view.context.paint=()=>{view.nodes['#app'].innerHTML=view.run('studio()');};view.run('render=paint');
  view.state.drafts=view.state.drafts.filter(d=>d.id!=='d1');await view.run('refresh(false)');
  assert.equal(view.run('studioView'),'list');assert.equal(view.run('edit'),null);assert.doesNotMatch(view.nodes['#app'].innerHTML,/id="draft-form"|id="studio-images"/);assert.match(view.nodes['#app'].innerHTML,/出门少带一台手机/);
});

test('a creation waiting for the old save cannot clear a draft explicitly opened in the meantime',async()=>{
  const view=ui();await view.run("nav('draft/d1')");view.run('studio()');let release;view.context.saveGate=new Promise(resolve=>{release=resolve;});
  view.run('flushDraftSave=async()=>{await saveGate}');
  const pending=view.run("enqueueDraftGeneration({instruction:'后台继续生成'})");
  await view.run("nav('draft/d2')");view.run('studio()');release();await pending;
  assert.equal(view.run('studioView'),'draft');assert.equal(view.run('selected'),'d2');assert.equal(view.run('edit.id'),'d2');assert.match(view.context.location.hash,/draft\/d2$/);assert.equal(view.state.draftGenerationJobs.length,1);
});
