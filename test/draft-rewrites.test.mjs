import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';

const root=path.resolve(import.meta.dirname,'..');
const env={REDPILOT_AI_KEY:'test-only-rewrite-key',REDPILOT_AI_MODEL:'offline-rewrite-model',REDPILOT_AI_BASE_URL:'https://model.example/v1'};
const response=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'改写后的备用号场景',body:'产品处于开发内测阶段。使用前请核对设备与手机的联网条件。',tags:['产品开发'],gaps:[],adaptation:'根据原稿和用户要求调整表达'})}}]}));
async function fixture(t,{responder=async()=>response(),release=()=>{}}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-draft-rewrite-'));
  const credentials={email:'rewrite@example.test',password:'Test-only-'+randomBytes(18).toString('hex')};
  await configureAuth({directory,...credentials});let calls=0;
  const app=await createApp({root,directory,env,fetcher:async(...args)=>{calls++;return responder(...args);},
    linkReader:async()=>({status:'unavailable',missing:[],error:'offline fixture'}),trendReader:async()=>[],creatorReader:async()=>({status:'unavailable',notes:[]}),feishuReader:async()=>({status:'unavailable',documents:[],sources:[]}),
    xhsPublisher:{async publish(){assert.fail('rewrites must not publish');},async verify(){assert.fail('rewrites must not verify');},async checkConnection(){return {status:'unavailable'};}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  t.after(async()=>{release();await app.close();await rm(directory,{recursive:true,force:true});});
  return {store:app.store,get calls(){return calls;},async request(endpoint,data,method='POST',accountId){
    const result=await fetch(base+'/api/'+endpoint,{method,signal:AbortSignal.timeout(5000),headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json',...(accountId?{'X-RedPilot-Account':accountId}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:result.status,data:await result.json()};}};
}
function ok(result){assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
const state=async f=>ok(await f.request('state',undefined,'GET'));
const original=async(f,extra={})=>ok(await f.request('drafts',{method:'template',contentMode:'text',...extra}));
const source=async f=>ok(await f.request('inspirations',{title:'原稿参考',text:'先写具体使用场景，再说明产品使用条件。',files:[]})).item;
const rewrite=(f,draft,extra={})=>f.request('draft-generations',{rewriteDraftId:draft.id,accountId:draft.accountId,instruction:'语气更自然，保留使用条件',method:'ai',contentMode:'text',productAssetIds:[],clientRequestId:randomUUID(),...extra});
async function waitFor(fn){for(let n=0;n<200;n++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('rewrite task did not settle');}
const finished=(f,id)=>waitFor(async()=>{const job=(await state(f)).draftGenerationJobs.find(j=>j.id===id);return ['failed','completed'].includes(job?.status)&&job;});

test('rewrite sends the complete 8000-character original with a short instruction and creates a separate draft with provenance',async t=>{
  let requestBody;
  const f=await fixture(t,{responder:async(_url,options)=>{requestBody=JSON.parse(options.body);return response();}}),reference=await source(f),base=await original(f,{referenceId:reference.id});
  const body='原稿正文'.repeat(1999)+'末尾标记',saved=ok(await f.request('drafts/'+base.id,{...base,body,tags:['原稿标签']},'PUT'));
  assert.equal(body.length,8000);
  const sourceLinks=[{title:'原始来源',url:'https://s.weibo.com/weibo?q=phone',platformId:'weibo',rank:3}];
  await f.store.mutate(s=>{Object.assign(s.drafts.find(d=>d.id===saved.id),{sourceLinks,referenceIds:[reference.id,'previously-deleted-reference'],topicId:'original-topic'});});
  const before=(await state(f)).drafts.find(d=>d.id===saved.id),job=ok(await rewrite(f,before,{referenceId:reference.id})),done=await finished(f,job.id);assert.equal(done.status,'completed');
  const current=await state(f),result=current.drafts.find(d=>d.id===done.draftId),prompt=requestBody.messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.filter(part=>part.type==='text').map(part=>part.text)).join('\n');
  assert.ok(prompt.includes(body));assert.ok(prompt.includes(before.title));assert.ok(prompt.includes('原稿标签'));assert.ok(prompt.includes('语气更自然，保留使用条件'));
  assert.notEqual(result.id,before.id);assert.equal(result.rewriteDraftId,before.id);assert.equal(result.rewriteDraftRevision,before.revision);assert.deepEqual(result.referenceIds,before.referenceIds);assert.deepEqual(result.sourceLinks,sourceLinks);assert.equal(result.topicId,before.topicId);assert.equal(result.instruction,'语气更自然，保留使用条件');assert.deepEqual(current.drafts.find(d=>d.id===before.id),before);assert.equal(result.approved,false);assert.equal(current.jobs.length,0);assert.equal(f.calls,1);
});

test('rewrites reject another account, unrelated references and template fallback before invoking any model',async t=>{
  const f=await fixture(t),base=await original(f),other=ok(await f.request('accounts',{name:'其他账号',type:'personal'})),reference=await source(f),before=await state(f);
  for(const [extra,status,pattern] of [[{accountId:other.id},409,/其他账号/],[{referenceId:reference.id},409,/不属于原稿/],[{method:'template'},400,/需要 AI/],[{instruction:'字'.repeat(2001)},400,/2000/]]){
    const result=await rewrite(f,base,extra);assert.equal(result.status,status,JSON.stringify(result.data));assert.match(result.data.error,pattern);
  }
  const foreign=await f.request('draft-generations',{rewriteDraftId:base.id,accountId:other.id,instruction:'不能读取其他账号原稿',method:'ai',contentMode:'text'},'POST',other.id);
  assert.equal(foreign.status,404);
  assert.equal(f.calls,0);const after=await state(f);assert.deepEqual(after.drafts,before.drafts);assert.deepEqual(after.draftGenerationJobs,before.draftGenerationJobs);
});

test('changing the original revision while AI is pending fails the rewrite without overwriting or saving stale content',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{release,responder:async()=>{await gate;return response();}}),base=await original(f),initial=await state(f),job=ok(await rewrite(f,base));
  await waitFor(()=>f.calls===1);const updated=ok(await f.request('drafts/'+base.id,{...base,title:'生成期间手动更新'},'PUT'));release();
  const done=await finished(f,job.id),current=await state(f);assert.equal(done.status,'failed');assert.equal(done.reasonCode,'source_changed');assert.equal(done.draftId,null);assert.equal(current.drafts.length,initial.drafts.length);assert.deepEqual(current.drafts.find(d=>d.id===base.id),updated);assert.equal(current.jobs.length,0);assert.equal(f.calls,1);
});

test('deleting the original while AI is pending rejects the result instead of resurrecting it',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{release,responder:async()=>{await gate;return response();}}),base=await original(f),job=ok(await rewrite(f,base));
  await waitFor(()=>f.calls===1);ok(await f.request('drafts/'+base.id,{},'DELETE'));release();const done=await finished(f,job.id),current=await state(f);
  assert.equal(done.status,'failed');assert.equal(done.reasonCode,'source_changed');assert.equal(current.drafts.some(d=>d.id===base.id||d.rewriteDraftId===base.id),false);assert.equal(f.calls,1);
});

test('omitted rewrite reference uses the original reference and retries remain idempotent without altering old generation requests',async t=>{
  const f=await fixture(t),reference=await source(f),base=await original(f,{referenceId:reference.id}),clientRequestId=randomUUID(),job=ok(await rewrite(f,base,{clientRequestId}));
  assert.equal(job.referenceId,reference.id);assert.equal((await finished(f,job.id)).status,'completed');assert.equal(ok(await rewrite(f,base,{clientRequestId})).id,job.id);assert.equal(f.calls,1);
  const legacy=ok(await f.request('draft-generations',{method:'template',contentMode:'text',instruction:'旧调用仍可用',clientRequestId:randomUUID()}));assert.equal((await finished(f,legacy.id)).status,'completed');assert.equal(legacy.rewriteDraftId,undefined);assert.equal(f.calls,1);
});
