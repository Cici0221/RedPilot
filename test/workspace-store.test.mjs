import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../app/store.mjs';
import {createAccount,setDefaultAccount} from '../app/accounts.mjs';

const root=path.resolve(import.meta.dirname,'..');
const account=(id,name)=>({id,name,type:'personal',enabled:true,archived:false,settings:{enabled:false,time:'10:00',timezone:'Asia/Shanghai',mode:'review',imageShare:70}});
const fixtureState=()=>({
  schemaVersion:3,accounts:[account('official','人类补丁'),account('personal','小号')],defaultAccountId:'official',
  product:{name:'RingHi',brand:'人类补丁',stage:'内测',summary:'官方产品事实',facts:['官方事实'],conditions:[],restrictions:[],sources:['https://example.feishu.cn/docx/Official'],version:'product-v1'},
  inspirations:[{id:'shared-old-ref',title:'旧的无归属收藏',assets:['/uploads/source.png']},{id:'personal-ref',accountId:'personal',title:'小号收藏',assets:[]}],
  drafts:[{id:'official-draft',accountId:'official',referenceIds:['shared-old-ref'],productAssetIds:['official-asset']},{id:'personal-draft',accountId:'personal',referenceIds:['shared-old-ref'],productAssetIds:['used-shared-asset'],history:[]}],
  jobs:[{id:'personal-job',draftId:'personal-draft',accountId:'personal',status:'scheduled'}],
  productAssets:[{id:'official-asset',name:'未被小号引用的官方图片'},{id:'used-shared-asset',name:'旧小号稿已引用的图片',previewAssetId:'preview-asset'},{id:'preview-asset',name:'预览图'}],
  creators:[{id:'official-creator',name:'旧关注博主'}],creatorSyncs:[],analysisTasks:[],
  feishuSync:{enabled:false,sourceMode:'product',sourceUrls:['https://example.feishu.cn/docx/Official'],status:'ready',configVersion:'feishu-v1'},
  feishuDocuments:[{id:'doc-official',text:'官方文档正文',url:'https://example.feishu.cn/docx/Official'}],feishuJobs:[],
  events:[{id:'official-event',message:'旧记录'}],trendBoards:[{platformId:'bilibili',items:[{title:'公共热点'}]}],trendRefreshJobs:[],trendSchedule:{enabled:true,time:'09:00',timezone:'Asia/Shanghai'}
});
async function fixture(t,initial=fixtureState()){
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-workspace-store-'));
  await writeFile(path.join(directory,'state.json'),JSON.stringify(initial));
  let store=await createStore(root,directory);
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  return {get store(){return store;},directory,async reopen(){await store.close();store=await createStore(root,directory);}};
}
const ids=items=>items.map(item=>item.id);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('legacy unowned materials remain in the original default account, with only actual draft dependencies copied',async t=>{
  const {store}=await fixture(t);
  assert.equal(store.state.workspaceAccountId,'official');
  assert.equal(store.state.product.name,'RingHi');
  assert.deepEqual(ids(store.state.drafts),['official-draft']);
  assert.deepEqual(ids(store.state.feishuDocuments),['doc-official']);
  const own=store.run('personal',s=>structuredClone(s));
  assert.equal(own.workspaceAccountId,'personal');assert.equal(own.defaultAccountId,'personal');
  assert.equal(own.product.name,'');assert.deepEqual(own.product.facts,[]);assert.deepEqual(own.product.sources,[]);
  assert.deepEqual(ids(own.drafts),['personal-draft']);assert.deepEqual(ids(own.jobs),['personal-job']);
  assert.deepEqual(new Set(ids(own.inspirations)),new Set(['personal-ref','shared-old-ref']));
  assert.deepEqual(new Set(ids(own.productAssets)),new Set(['used-shared-asset','preview-asset']));
  assert.equal(own.inspirations.find(item=>item.id==='shared-old-ref').accountId,'personal');
  assert.deepEqual(own.feishuDocuments,[]);assert.deepEqual(own.creators,[]);assert.deepEqual(own.events,[]);
  assert.equal(own.feishuSync.enabled,false);assert.deepEqual(own.feishuSync.sourceUrls,[]);
  assert.deepEqual(own.trendBoards,store.state.trendBoards);
  assert.equal('accountWorkspaces' in own,false);
  assert.equal(store.rootState.product,undefined);
  assert.equal(store.rootState.schemaVersion,4);
  await store.run('personal',()=>store.mutate(s=>{
    s.inspirations.find(item=>item.id==='shared-old-ref').title='小号副本修改';
    s.productAssets.find(item=>item.id==='used-shared-asset').name='小号素材改名';
  }));
  assert.equal(store.state.inspirations.find(item=>item.id==='shared-old-ref').title,'旧的无归属收藏');
  assert.equal(store.state.productAssets.find(item=>item.id==='used-shared-asset').name,'旧小号稿已引用的图片');
});

test('new accounts start empty and independent, while shared public trends and registry stay visible',async t=>{
  const {store}=await fixture(t);
  const created=await store.mutate(s=>createAccount(s,{name:'新的小号'}));
  await store.run(created.id,()=>store.mutate(s=>{
    assert.deepEqual(s.inspirations,[]);assert.deepEqual(s.productAssets,[]);assert.deepEqual(s.feishuDocuments,[]);
    assert.equal(s.accounts.length,3);assert.equal(s.trendBoards[0].platformId,'bilibili');
    s.product.facts.push('小号事实');s.inspirations.unshift({id:'new-ref'});s.feishuSync.sourceUrls=['https://example.feishu.cn/docx/Personal'];
  }));
  assert.equal(store.state.product.facts.includes('小号事实'),false);
  assert.equal(store.state.inspirations.some(item=>item.id==='new-ref'),false);
  assert.equal(store.state.feishuSync.sourceUrls[0],'https://example.feishu.cn/docx/Official');
  assert.equal(store.accountIds().includes(created.id),true);
  assert.throws(()=>store.run('missing-account',()=>{}),error=>error.status===404);
});

test('queued mutations and delayed background continuations keep their originating account context',async t=>{
  const {store}=await fixture(t),gate=deferred(),entered=deferred();
  const first=store.run('official',()=>store.mutate(async s=>{
    entered.resolve();await gate.promise;s.events.unshift({id:'a-work'});
    assert.equal(store.state.workspaceAccountId,'official');
  }));
  await entered.promise;
  const second=store.run('personal',()=>store.mutate(s=>{
    assert.equal(s.workspaceAccountId,'personal');assert.equal(store.state.workspaceAccountId,'personal');s.events.unshift({id:'b-work'});
  }));
  const continuation=store.run('personal',()=>gate.promise.then(()=>store.mutate(s=>{s.events.unshift({id:'b-delayed'});})));
  gate.resolve();await Promise.all([first,second,continuation]);
  assert.equal(store.state.events.some(item=>item.id.startsWith('b-')),false);
  assert.deepEqual(store.run('personal',s=>ids(s.events)),['b-delayed','b-work']);
});

test('a rejected mutation rolls back both workspaces and retained views resolve the restored state',async t=>{
  const {store}=await fixture(t),officialView=store.state,personalView=store.run('personal',s=>s);
  await assert.rejects(store.run('personal',()=>store.mutate(s=>{
    s.product.summary='must rollback';s.events.push({id:'rollback-event'});s.accounts[0].name='must rollback';
    throw new Error('expected failure');
  })),/expected failure/);
  assert.equal(personalView.product.summary,'');assert.deepEqual(personalView.events,[]);
  assert.equal(officialView.accounts[0].name,'人类补丁');assert.equal(officialView.product.summary,'官方产品事实');
  await store.run('personal',()=>store.mutate(s=>{s.product.summary='saved later';}));
  assert.equal(personalView.product.summary,'saved later');assert.equal(officialView.product.summary,'官方产品事实');
});

test('workspace changes and manual Feishu state survive restart without copying data to a new default account',async t=>{
  const f=await fixture(t);
  await f.store.run('personal',()=>f.store.mutate(s=>{
    s.product.summary='小号独立资料';s.feishuSync.sourceUrls=['https://example.feishu.cn/docx/Personal'];
    s.feishuDocuments.push({id:'doc-personal',text:'小号正文'});s.events.push({id:'saved-event'});s.settings.time='13:30';
  }));
  await f.store.mutate(s=>setDefaultAccount(s,'personal'));
  assert.equal(f.store.rootState.defaultAccountId,'personal');
  const raw=JSON.parse(await readFile(path.join(f.directory,'state.json'),'utf8'));
  assert.equal(raw.product,undefined);assert.equal(raw.accountWorkspaces.official.product.name,'RingHi');
  await f.reopen();
  assert.equal(f.store.state.workspaceAccountId,'personal');assert.equal(f.store.state.product.summary,'小号独立资料');
  assert.equal(f.store.state.settings.time,'13:30');assert.deepEqual(ids(f.store.state.feishuDocuments),['doc-personal']);
  assert.deepEqual(f.store.run('official',s=>ids(s.feishuDocuments)),['doc-official']);
  assert.equal(f.store.run('official',s=>s.product.name),'RingHi');
  assert.equal(f.store.rootState.schemaVersion,4);assert.equal(f.store.rootState.workspaceVersion,1);
});
