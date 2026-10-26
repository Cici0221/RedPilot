import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const fixture=()=>({accounts:[{id:'official',name:'官方'},{id:'secondary',name:'小号'}],defaultAccountId:'official',creators:[],inspirations:[],discussions:[],drafts:[],draftGenerationJobs:[]});
const response=value=>({ok:true,status:200,json:async()=>value});
function ui(fetcher,{fastTimeout=false}={}){
  const nodes={'#app':{innerHTML:'',hidden:false},'#modal':{open:false,close(){this.open=false;}},'#modal-content':{innerHTML:''},'#draft-generation-status':{innerHTML:''}};
  const context=vm.createContext({fetch:fetcher,URL,Intl,Date,structuredClone,console,setTimeout,clearTimeout,AbortSignal:fastTimeout?{timeout:()=>AbortSignal.timeout(5)}:AbortSignal,
    document:{querySelector:s=>nodes[s]||null,querySelectorAll:()=>[],activeElement:{id:''}},location:{hash:'',replace(url){this.redirect=url;}},window:{scrollTo(){}},confirm:()=>true});
  vm.runInContext(definitions,context);
  context.initial=fixture();vm.runInContext('S=initial;render=()=>{}',context);
  return {context,nodes,run:code=>vm.runInContext(code,context)};
}

test('late stale state responses cannot erase a newer running job',async()=>{
  const releases=[];const view=ui(()=>new Promise(resolve=>releases.push(resolve)));
  const old=view.run('refresh(false)'),newer=view.run('refresh(false)');
  const next=fixture();next.draftGenerationJobs=[{id:'new-job',status:'running',phase:'generating'}];
  releases[1](response(next));assert.equal(await newer,true);
  releases[0](response(fixture()));assert.equal(await old,false);
  assert.equal(view.run('S.draftGenerationJobs[0].id'),'new-job');
});

test('a failed newer request does not discard a valid earlier response',async()=>{
  const pending=[];const view=ui(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
  const earlier=view.run('refresh(false)'),failed=view.run('refresh(false)');
  const failure=assert.rejects(failed,/offline/);pending[1].reject(Error('offline'));await failure;
  const next=fixture();next.draftGenerationJobs=[{id:'saved-job',status:'completed'}];pending[0].resolve(response(next));
  assert.equal(await earlier,true);assert.equal(view.run('S.draftGenerationJobs[0].id'),'saved-job');
});

test('a pending response cannot restore private state after an expired login',async()=>{
  const releases=[];const view=ui(()=>new Promise(resolve=>releases.push(resolve)));
  const pending=view.run('refresh(false)'),expired=view.run('refresh(false)');
  const failure=assert.rejects(expired,/请先登录/);releases[1]({status:401});await failure;
  releases[0](response(fixture()));assert.equal(await pending,false);
  assert.equal(view.run('S'),null);assert.equal(view.context.location.redirect,'/login');assert.equal(view.nodes['#app'].hidden,true);
});

test('timed out polling releases its flag and keeps a retryable task',async()=>{
  const view=ui((_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),{fastTimeout:true});
  view.run("S.draftGenerationJobs=[{id:'waiting',status:'running',phase:'generating'}]");
  const keepAlive=setTimeout(()=>{},1000);
  try{await view.run('pollDraftGenerations()');}finally{clearTimeout(keepAlive);}
  assert.equal(view.run('draftGenerationPolling'),false);assert.equal(view.run('S.draftGenerationJobs[0].status'),'running');
  assert.match(view.nodes['#draft-generation-status'].innerHTML,/状态读取超时/);assert.match(view.nodes['#draft-generation-status'].innerHTML,/重试同步/);
});

test('generation follows the current workspace across every page',()=>{
  const view=ui(async()=>response(fixture()));
  assert.equal(view.run("workspaceId='secondary';page='library';accountFilter='official';generationAccountId()"),'secondary');
  assert.equal(view.run("page='trends';operationsAccountId='official';generationAccountId()"),'secondary');
  assert.equal(view.run("page='library';accountFilter='all';generationAccountId()"),'secondary');
});

test('old standalone routes resolve inside their new workspaces',()=>{
  const view=ui(async()=>response(fixture()));
  for(const [old,nested,root] of [['trends','library/trends','library'],['creators','library/creators','library'],['images','studio','studio'],['calendar','calendar','calendar']]){
    view.context.destination=old;view.run('nav(destination)');assert.equal(view.context.location.hash,nested);assert.equal(view.run('workspaceRoot()'),root);
    view.context.destination=nested;view.run('nav(destination)');assert.equal(view.run('page'),old==='images'?'studio':old);
  }
});
