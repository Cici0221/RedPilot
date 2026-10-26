import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const URL_ONE='https://example.feishu.cn/docx/ProductOne';
const URL_TWO='https://example.feishu.cn/docx/ProductTwo';
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body)});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const element=(extra={})=>({innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',dataset:{},classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},...extra});
function fixture(){return {
  product:{name:'已保存名称',brand:'品牌',stage:'内测',summary:'已保存说明',facts:[],conditions:[],restrictions:[],sources:[URL_ONE]},
  productAssets:[],accounts:[],inspirations:[],drafts:[],feishuDocuments:[],feishuJobs:[],
  feishuSync:{enabled:false,status:'ready',sourceUrls:[URL_ONE],lastSyncAt:'2026-10-26T01:00:00Z'},capabilities:{feishu:true}
};}
function ui({state=fixture(),sourceValues=[URL_ONE],handle}={}){
  const requests=[],notifications=[];
  const inputs=sourceValues.map(value=>element({name:'sources',value}));
  const name=element({value:'尚未保存的新名称'}),summary=element({value:'尚未保存的新说明'});
  const form=element({id:'product-form',sourceInputs:inputs,querySelectorAll:selector=>selector.includes('sources')?inputs:[],querySelector:selector=>selector.includes('name')?name:selector.includes('summary')?summary:null,reportValidity:()=>true,checkValidity:()=>true});
  const nodes={'#product-form':form,'#feishu-sync-button':element(),'#feishu-side-status':element(),'#app':element({innerHTML:'KEEP_PRODUCT_FORM'}),'#modal':element({open:false}),'#toast':element()};
  class FormDataMock{constructor(value){this.entries=[['name',name.value],['summary',summary.value],...value.sourceInputs.map(input=>['sources',input.value])];}getAll(key){return this.entries.filter(([name])=>name===key).map(([,value])=>value);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}
  const context=vm.createContext({URL,Intl,Date,Math,structuredClone,AbortSignal,FormData:FormDataMock,console,setTimeout:()=>1,clearTimeout(){},
    location:{hash:'#product',replace(){}},window:{scrollTo(){},matchMedia:()=>({matches:false})},
    document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:selector=>selector.includes('sources')?inputs:[],activeElement:null},
    fetch:async(url,options={})=>{
      const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);
      const custom=await handle?.(request,state);if(custom!==undefined)return custom;
      if(url==='/api/state'&&request.method==='GET')return response(state);
      if(url==='/api/feishu/sync'&&request.method==='POST'){
        state.feishuSync.status='syncing';state.feishuSync.sourceUrls=request.body.sourceUrls;
        state.feishuJobs=[{id:'manual-sync',status:'queued',reason:'manual'}];return response(state.feishuJobs[0]);
      }
      throw Error('Unexpected request: '+request.method+' '+url);
    }});
  vm.runInContext(definitions,context);context.initial=structuredClone(state);context.notify=message=>notifications.push(message);
  vm.runInContext("S=initial;page='product';productTab='facts';toast=notify;",context);
  return {state,context,requests,notifications,nodes,inputs,name,summary,run:code=>vm.runInContext(code,context)};
}

test('product sources expose one direct sync action and only the two useful product tabs',()=>{
  const view=ui(),html=view.run('product()');
  assert.equal((html.match(/data-action="product-tab"/g)||[]).length,2);
  assert.equal((html.match(/id="product-source-list"/g)||[]).length,1);
  assert.equal((html.match(/data-action="feishu-sync"/g)||[]).length,1);
  assert.doesNotMatch(html,/data-tab="feishu"|feishu-settings-form|自动同步|同步频率|下次同步|自动已关闭/);
  assert.match(html,/type="button"[^>]*>飞书同步|>飞书同步<\/button>/);
});

test('sync uses current source inputs directly and leaves other unsaved product edits intact',async()=>{
  const view=ui({sourceValues:[' '+URL_TWO+' ','',URL_ONE,URL_TWO]});
  view.context.button={dataset:{action:'feishu-sync'}};
  await view.run('action(button)');
  const writes=view.requests.filter(request=>request.method!=='GET');
  assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/feishu/sync');assert.equal(writes[0].method,'POST');
  assert.deepEqual(writes[0].body,{sourceUrls:[URL_TWO,URL_ONE]});
  assert.equal(view.run('productTab'),'facts');assert.equal(view.nodes['#app'].innerHTML,'KEEP_PRODUCT_FORM');
  assert.equal(view.name.value,'尚未保存的新名称');assert.equal(view.summary.value,'尚未保存的新说明');
  assert.deepEqual(view.inputs.map(input=>input.value),[' '+URL_TWO+' ','',URL_ONE,URL_TWO]);
  assert.equal(view.nodes['#feishu-sync-button'].disabled,true);
});

test('double click submits one job and keeps the sync button disabled while the request is pending',async()=>{
  const gate=deferred();
  const view=ui({handle:request=>request.method==='POST'?gate.promise:undefined});
  view.context.button=view.nodes['#feishu-sync-button'];view.context.button.dataset={action:'feishu-sync'};
  const first=view.run('action(button)');
  assert.equal(view.nodes['#feishu-sync-button'].disabled,true);
  await view.run('action(button)');
  assert.equal(view.requests.filter(request=>request.method==='POST').length,1);
  view.state.feishuSync.status='syncing';view.state.feishuJobs=[{id:'manual-sync',status:'queued'}];
  gate.resolve(response(view.state.feishuJobs[0]));await first;
  assert.equal(view.nodes['#feishu-sync-button'].disabled,true);
});

test('a failed submission restores the button and can be retried without opening another page',async()=>{
  let attempts=0;
  const view=ui({handle:request=>request.method==='POST'&&++attempts===1?response({error:'暂时无法读取'},503):undefined});
  await view.run('syncFeishuSources()').catch(()=>{});
  assert.equal(view.nodes['#feishu-sync-button'].disabled,false);
  assert.equal(view.run('feishuSubmitting'),false);
  await view.run('syncFeishuSources()');
  assert.equal(view.requests.filter(request=>request.method==='POST').length,2);
  assert.equal(view.run('productTab'),'facts');assert.equal(view.nodes['#app'].innerHTML,'KEEP_PRODUCT_FORM');
});

test('polling never starts a new sync and updates only status after a manual job',async()=>{
  const view=ui();await view.run('pollFeishuSync()');assert.equal(view.requests.length,0);
  view.run("S.feishuSync.status='syncing';S.feishuJobs=[{id:'manual-sync',status:'running'}]");
  view.state.feishuSync.status='ready';view.state.feishuJobs=[{id:'manual-sync',status:'completed'}];
  await view.run('pollFeishuSync()');
  assert.deepEqual(view.requests.map(request=>[request.method,request.url]),[['GET','/api/state']]);
  assert.equal(view.nodes['#feishu-sync-button'].disabled,false);
  assert.equal(view.nodes['#app'].innerHTML,'KEEP_PRODUCT_FORM');
  assert.equal(view.name.value,'尚未保存的新名称');
  assert.doesNotMatch(view.nodes['#feishu-side-status'].innerHTML,/自动已关闭/);
});


test('expired login clears the page without masking the authentication error during sync cleanup',async()=>{
  const view=ui({handle:request=>request.method==='POST'?response({error:'登录已过期'},401):undefined});
  await assert.rejects(view.run('syncFeishuSources()'),error=>error.code==='AUTH_REQUIRED');
  assert.equal(view.run('S'),null);assert.equal(view.run('authRedirecting'),true);
  assert.equal(view.run('feishuSubmitting'),false);assert.equal(view.nodes['#app'].hidden,true);
  assert.equal(view.nodes['#app'].innerHTML,'');
  assert.deepEqual(view.requests.map(request=>[request.method,request.url]),[['POST','/api/feishu/sync']]);
});
