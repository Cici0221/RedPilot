import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';

const root=path.resolve(import.meta.dirname,'..');
const source={title:'手机通信话题',url:'https://s.weibo.com/weibo?q=phone',platformId:'weibo',rank:3,fetchedAt:'2026-10-26T01:00:00.000Z',stale:false};
async function fixture(t,{env={},modelResponder}={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-unified-flow-'));
  const credentials={email:'unified-flow@example.test',password:'Test-only-'+randomBytes(18).toString('hex')};
  await configureAuth({directory,...credentials});let app,base,cookie,externalCalls=0,reads=0;
  async function open(){
    app=await createApp({root,directory,env,fetcher:async(...args)=>{externalCalls++;if(modelResponder)return modelResponder(...args);throw Error('real external service forbidden');},
      linkReader:async()=>{reads++;return {status:'unavailable',missing:[],error:'offline fixture'};},
      trendReader:async()=>[],creatorReader:async()=>({status:'unavailable',notes:[]}),feishuReader:async()=>({status:'unavailable',documents:[],sources:[]})});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
    const result=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
    assert.equal(result.status,200);cookie=result.headers.get('set-cookie').split(';')[0];
  }
  await open();t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  return {get store(){return app.store;},get calls(){return {external:externalCalls,reads};},tick:date=>app.tick(date),async reopen(){await app.close();await open();},
    async request(url,data,method='POST',accountId){const result=await fetch(base+'/api/'+url,{method,signal:AbortSignal.timeout(5000),headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json',...(accountId?{'X-RedPilot-Account':accountId}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:result.status,data:await result.json()};}};
}
function ok(result){assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
const state=async(f,accountId)=>ok(await f.request('state',undefined,'GET',accountId));
async function topic(f,extra={},accountId){return ok(await f.request('topics',{title:'手机通信话题',sources:[source],sourceIds:['observed-row'],...extra},'POST',accountId));}
async function draft(f,extra={}){return ok(await f.request('drafts',{method:'template',contentMode:'text',...extra}));}
const future=()=>new Date(Date.now()+3600000).toISOString();
async function waitFor(fn){for(let i=0;i<100;i++){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('fixture task did not finish');}

test('saving a topic creates one usable collection with preserved source evidence and no synthetic full-article claim',async t=>{
  const f=await fixture(t),before=await state(f),saved=await topic(f),after=await state(f),reference=after.inspirations.find(r=>r.id===saved.referenceId);
  assert.ok(reference);assert.equal(after.inspirations.length,before.inspirations.length+1);assert.equal(reference.topicId,saved.id);assert.equal(reference.accountId,before.defaultAccountId);assert.equal(reference.kind,'topic');assert.equal(reference.pool,true);assert.equal(reference.status,'ready');assert.equal(reference.url,'');assert.equal(reference.linkRead,undefined);assert.match(reference.text,/未读取来源全文/);assert.deepEqual(reference.sourceLinks,[source]);assert.deepEqual(reference.sourceIds,['observed-row']);assert.deepEqual(f.calls,{external:0,reads:0});
});

test('same-account saves merge source evidence without duplicating or overwriting edited collections',async t=>{
  const f=await fixture(t),first=await topic(f);
  ok(await f.request('inspirations/'+first.referenceId,{title:'我的收藏标题',pool:false,tags:['自选标签']},'PUT'));
  await f.store.mutate(s=>{const reference=s.inspirations.find(r=>r.id===first.referenceId);reference.text='我补充的真实正文';reference.userFields.text=true;reference.note='我的备注';});
  const secondSource={title:'百度同题',url:'https://www.baidu.com/s?wd=phone',platformId:'baidu',rank:5};
  const second=await topic(f,{sources:[secondSource],sourceIds:['another-row']});
  assert.equal(second.id,first.id);assert.equal(second.referenceId,first.referenceId);
  const current=await state(f),reference=current.inspirations.find(r=>r.id===first.referenceId);assert.equal(current.topicPool.length,1);assert.equal(current.inspirations.filter(r=>r.topicId===first.id).length,1);assert.equal(reference.title,'我的收藏标题');assert.equal(reference.text,'我补充的真实正文');assert.equal(reference.note,'我的备注');assert.equal(reference.pool,false);assert.deepEqual(reference.tags,['自选标签']);assert.deepEqual(reference.sourceLinks,[source,secondSource]);
});

test('merging new topic sources invalidates stale analysis while unchanged re-saves preserve current analysis',async t=>{
  const f=await fixture(t),saved=await topic(f),analysis={topic:'已完成的拆解'};
  await f.store.mutate(s=>{Object.assign(s.inspirations.find(r=>r.id===saved.referenceId),{analysis,analysisFingerprint:'old-analysis',status:'analyzed',method:'ai'});});
  const extra={title:'补充来源',url:'https://www.baidu.com/s?wd=phone',platformId:'baidu',rank:5};await topic(f,{sources:[extra]});
  let reference=(await state(f)).inspirations.find(r=>r.id===saved.referenceId);assert.equal(reference.analysis,null);assert.equal(reference.analysisFingerprint,null);assert.equal(reference.method,null);assert.equal(reference.status,'ready');assert.match(reference.text,/补充来源/);
  await f.store.mutate(s=>{Object.assign(s.inspirations.find(r=>r.id===saved.referenceId),{analysis,analysisFingerprint:'new-analysis',status:'analyzed',method:'ai'});});await topic(f,{sources:[extra]});
  reference=(await state(f)).inspirations.find(r=>r.id===saved.referenceId);assert.deepEqual(reference.analysis,analysis);assert.equal(reference.analysisFingerprint,'new-analysis');assert.equal(reference.status,'analyzed');
});

test('topic migration is lossless and idempotent, preserving timestamps, legacy records and pool choices',async t=>{
  const f=await fixture(t),initial=await state(f),legacy={id:'legacy-topic',accountId:initial.defaultAccountId,title:'旧选题',sources:[source],sourceIds:['legacy-source'],pool:false,status:'used',createdAt:'2026-10-20T02:00:00.000Z',updatedAt:'2026-10-21T02:00:00.000Z',legacyExtra:{keep:true}};
  await f.store.mutate(s=>{s.topicPool.push(legacy);});await f.reopen();const once=await state(f),saved=once.topicPool.find(r=>r.id===legacy.id),reference=once.inspirations.find(r=>r.id===saved.referenceId);
  assert.deepEqual({...saved,referenceId:undefined},{...legacy,referenceId:undefined});assert.equal(reference.createdAt,legacy.createdAt);assert.equal(reference.pool,false);assert.deepEqual(reference.sourceLinks,[source]);assert.equal(reference.accountId,legacy.accountId);
  await f.reopen();const twice=await state(f);assert.deepEqual(twice.topicPool,once.topicPool);assert.equal(twice.inspirations.filter(r=>r.topicId===legacy.id).length,1);assert.equal(twice.inspirations.find(r=>r.topicId===legacy.id).id,reference.id);
});

test('deleted linked collections stay deleted after restart and explicit re-saving can restore the topic',async t=>{
  const f=await fixture(t),saved=await topic(f);ok(await f.request('inspirations/'+saved.referenceId,{},'DELETE'));await f.reopen();assert.equal((await state(f)).inspirations.some(r=>r.topicId===saved.id),false);
  const restored=await topic(f);assert.equal(restored.id,saved.id);assert.notEqual(restored.referenceId,saved.referenceId);assert.equal((await state(f)).inspirations.filter(r=>r.topicId===saved.id).length,1);
});

test('the same topic stays distinct across accounts and private references cannot cross generation or discussion boundaries',async t=>{
  const f=await fixture(t),own=await topic(f),other=ok(await f.request('accounts',{name:'另一个账号',type:'personal'})),second=await topic(f,{accountId:other.id},other.id);
  assert.notEqual(second.referenceId,own.referenceId);assert.notEqual(second.id,own.id);
  const current=await state(f),otherState=await state(f,other.id);assert.equal(current.inspirations.find(r=>r.id===own.referenceId).accountId,current.defaultAccountId);assert.equal(otherState.inspirations.find(r=>r.id===second.referenceId).accountId,other.id);
  assert.equal(current.inspirations.some(r=>r.id===second.referenceId),false);assert.equal(otherState.inspirations.some(r=>r.id===own.referenceId),false);
  const generation=await f.request('draft-generations',{accountId:other.id,referenceId:own.referenceId,method:'template',contentMode:'text'},'POST',other.id);assert.equal(generation.status,404);
  const discussion=await f.request('discussions',{accountId:other.id,title:'不能借用',sources:[{title:'其他账号收藏',url:'#reference/'+own.referenceId}]},'POST',other.id);assert.equal(discussion.status,404);assert.equal((await state(f,other.id)).draftGenerationJobs.length,0);assert.equal((await state(f)).draftGenerationJobs.length,0);assert.deepEqual(f.calls,{external:0,reads:0});
});

test('direct source creation uses the existing durable queue and retains provenance without a discussion',async t=>{
  const f=await fixture(t),saved=await topic(f),initial=await state(f);
  const queued=ok(await f.request('draft-generations',{accountId:initial.defaultAccountId,referenceId:saved.referenceId,method:'template',contentMode:'text'}));
  const complete=await waitFor(async()=>{const s=await state(f);return s.draftGenerationJobs.find(j=>j.id===queued.id&&j.status==='completed')&&s;});
  const generated=complete.drafts.find(d=>d.generationJobId===queued.id);assert.ok(generated);assert.deepEqual(generated.referenceIds,[saved.referenceId]);assert.deepEqual(generated.sourceLinks,[source]);assert.equal(generated.topicId,saved.id);assert.equal(generated.discussionId,undefined);assert.equal(complete.discussions.length,initial.discussions.length);assert.equal(complete.topicPool.find(item=>item.id===saved.id).status,'used');assert.equal(complete.inspirations.find(item=>item.id===saved.referenceId).uses,1);assert.deepEqual(f.calls,{external:0,reads:0});
});

test('daily generation excludes another account’s private source collections',async t=>{
  let modelInput='';
  const f=await fixture(t,{env:{REDPILOT_AI_KEY:'test-only-unified-key',REDPILOT_AI_MODEL:'offline-model',REDPILOT_AI_BASE_URL:'https://model.example/v1'},modelResponder:async(_url,options)=>{modelInput=options.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'先核对备用号使用条件',body:'产品处于开发内测阶段，使用前请核对设备和手机的联网条件。',tags:['产品开发'],gaps:[],adaptation:'离线夹具'})}}]}));}}),saved=await topic(f),other=ok(await f.request('accounts',{name:'每日小号',type:'personal'}));
  await f.store.mutate(s=>{s.inspirations=s.inspirations.filter(r=>r.id===saved.referenceId);s.feishuSync.enabled=false;s.trendSchedule.enabled=false;for(const account of s.accounts){account.reportSettings.enabled=false;account.settings.enabled=account.id===other.id;account.settings.mode='review';account.settings.imageShare=0;account.settings.time='09:00';account.settings.timezone='Asia/Shanghai';}});
  ok(await f.request('product',(await state(f)).product,'PUT',other.id));
  const before=(await state(f)).drafts.length,otherBefore=(await state(f,other.id)).drafts.length;await f.tick(new Date('2030-01-02T01:00:00Z'));const current=await state(f,other.id);assert.equal(current.drafts.length,otherBefore+1);assert.equal((await state(f)).drafts.length,before);const generated=current.drafts.find(d=>d.accountId===other.id);assert.ok(generated);assert.deepEqual(generated.referenceIds,[]);assert.equal(current.jobs.length,0);assert.equal(modelInput.includes(saved.referenceId),false);assert.equal(modelInput.includes(source.url),false);assert.deepEqual(f.calls,{external:1,reads:0});
});

test('invalid source requests do not leave partial topic or collection records',async t=>{
  const f=await fixture(t),before=await state(f);const result=await topicRequest();assert.equal(result.status,400);const after=await state(f);assert.deepEqual(after.topicPool,before.topicPool);assert.deepEqual(after.inspirations,before.inspirations);
  function topicRequest(){return f.request('topics',{title:'非法来源',sources:[{title:'来源',url:'https://evil.example/private'}]});}
});

test('optimistic draft saves reject stale versions atomically and preserve the winning revision/history',async t=>{
  const f=await fixture(t),original=await draft(f);const changes=await Promise.all(['版本甲','版本乙'].map(title=>f.request('drafts/'+original.id,{...original,title},'PUT')));
  assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);const winner=changes.find(r=>r.status===200).data,current=(await state(f)).drafts.find(d=>d.id===original.id);assert.equal(current.title,winner.title);assert.equal(current.revision,original.revision+1);assert.equal(current.history.length,1);assert.equal(current.history[0].title,original.title);
  const old=await f.request('drafts/'+original.id,{...original,title:'覆盖失败'},'PUT');assert.equal(old.status,409);assert.deepEqual((await state(f)).drafts.find(d=>d.id===original.id),current);
});

test('invalid version types fail without editing; old clients without revision remain compatible',async t=>{
  const f=await fixture(t),original=await draft(f);
  for(const revision of [null,0,-1,'1',1.5])assert.equal((await f.request('drafts/'+original.id,{...original,revision,title:'不应修改'},'PUT')).status,400);
  const legacy={...original,title:'兼容旧保存'};delete legacy.revision;const saved=ok(await f.request('drafts/'+original.id,legacy,'PUT'));assert.equal(saved.title,legacy.title);assert.equal(saved.revision,2);
});

test('confirm and schedule approves exactly the submitted version in one transaction without publishing',async t=>{
  const f=await fixture(t),original=await draft(f);assert.equal(original.approved,false);
  const job=ok(await f.request('drafts/'+original.id+'/schedule',{confirm:true,revision:original.revision,scheduledAt:future()}));const current=await state(f),saved=current.drafts.find(d=>d.id===original.id);
  assert.equal(saved.approved,true);assert.equal(saved.approvalKind,'owner');assert.equal(saved.status,'scheduled');assert.equal(job.draftRevision,original.revision);assert.equal(job.accountId,original.accountId);assert.equal(job.attempts,0);assert.equal(job.status,'scheduled');assert.deepEqual(f.calls,{external:0,reads:0});
});

test('combined scheduling rejects missing, invalid and stale revisions without setting owner approval',async t=>{
  const f=await fixture(t),original=await draft(f);const route='drafts/'+original.id+'/schedule';
  for(const input of [{confirm:true},{confirm:true,revision:null},{confirm:true,revision:'1'},{confirm:'true',revision:1}])assert.equal((await f.request(route,{scheduledAt:future(),...input})).status,400);
  const saved=ok(await f.request('drafts/'+original.id,{...original,title:'已更新'},'PUT'));
  assert.equal((await f.request(route,{scheduledAt:future(),confirm:true,revision:original.revision})).status,409);const current=await state(f);assert.equal(current.jobs.length,0);assert.equal(current.drafts.find(d=>d.id===original.id).approved,false);assert.equal(current.drafts.find(d=>d.id===original.id).revision,saved.revision);
});

test('all existing scheduling checks still roll back the combined owner confirmation on failure',async t=>{
  const f=await fixture(t),original=await draft(f),route='drafts/'+original.id+'/schedule',other=ok(await f.request('accounts',{name:'其他账号',type:'personal'}));
  const cases=[
    {input:{scheduledAt:'2000-01-01T00:00:00Z'},status:400},
    {input:{accountId:other.id},status:409},
    {change:s=>{s.accounts.find(a=>a.id===original.accountId).enabled=false;},status:409},
    {change:s=>{s.drafts.find(d=>d.id===original.id).productVersion='outdated-product';},status:409},
    {change:s=>{s.drafts.find(d=>d.id===original.id).gaps=['缺少已验证事实'];},status:409},
    {change:s=>{const d=s.drafts.find(d=>d.id===original.id);d.contentMode='image';d.productAssetIds=[];},status:409}
  ];
  for(const scenario of cases){
    await f.store.mutate(s=>{Object.assign(s.drafts.find(d=>d.id===original.id),structuredClone(original));s.accounts.find(a=>a.id===original.accountId).enabled=true;scenario.change?.(s);});
    const result=await f.request(route,{scheduledAt:future(),confirm:true,revision:original.revision,...scenario.input});assert.equal(result.status,scenario.status,JSON.stringify(result.data));const current=await state(f),saved=current.drafts.find(d=>d.id===original.id);assert.equal(saved.approved,false);assert.notEqual(saved.approvalKind,'owner');assert.equal(saved.status,'draft');assert.equal(current.jobs.length,0);
  }
});

test('concurrent combined confirmations create one job and legacy approved scheduling remains compatible',async t=>{
  const f=await fixture(t),original=await draft(f),input={confirm:true,revision:original.revision,scheduledAt:future()};
  const results=await Promise.all([f.request('drafts/'+original.id+'/schedule',input),f.request('drafts/'+original.id+'/schedule',input)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await state(f)).jobs.filter(j=>j.draftId===original.id).length,1);
  const old=await draft(f);assert.equal((await f.request('drafts/'+old.id+'/schedule',{scheduledAt:future()})).status,409);ok(await f.request('drafts/'+old.id+'/approve',{}));const legacy=ok(await f.request('drafts/'+old.id+'/schedule',{scheduledAt:future()}));assert.equal(legacy.draftId,old.id);assert.equal(legacy.status,'scheduled');assert.deepEqual(f.calls,{external:0,reads:0});
});
