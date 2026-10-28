import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';

const root=path.resolve(import.meta.dirname,'..');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64');
const copy=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'新的草稿',body:'产品介绍',tags:[],gaps:[]})}}]}));
async function fixture(t,options={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-improvements-')),credentials={email:'fixture@example.test',password:randomUUID()};await configureAuth({directory,...credentials});
  const app=await createApp({root,directory,env:{},trendReader:async()=>[],feishuReader:async()=>({documents:[],status:'unavailable'}),xhsPublisher:{close(){}},...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)}),cookie=login.headers.get('set-cookie').split(';')[0];
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const request=async(endpoint,data,method=data===undefined?'GET':'POST',headers={})=>{const response=await fetch(origin+'/api/'+endpoint,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(3000)});return {status:response.status,headers:response.headers,data:response.status===304?null:await response.json()};};
  return {...app,request,state:async()=>ok(await request('state'))};
}
const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
async function waitFor(read){for(let n=0;n<200;n++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('task did not finish');}

test('daily AI does not hold the write lock and cancellation discards late output',async t=>{
  let release,started=false;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const f=await fixture(t,{env:{REDPILOT_AI_KEY:'fixture',REDPILOT_AI_MODEL:'fixture',REDPILOT_AI_BASE_URL:'https://fixture.example/v1'},fetcher:async()=>{started=true;await gate;return copy();}});
  await f.store.mutate(s=>{s.inspirations=[];s.accounts[0].settings={enabled:true,mode:'review',imageShare:0,time:'00:00',timezone:'Asia/Shanghai'};s.accounts[0].reportSettings.enabled=false;s.trendSchedule.enabled=false;});
  await f.tick(new Date());await waitFor(()=>started);
  const s=await f.state(),job=s.draftGenerationJobs[0];assert.equal(job.status,'running');
  const saved=ok(await f.request('product',{...s.product,summary:'生成中仍然可以保存'},'PUT'));assert.equal(saved.summary,'生成中仍然可以保存');
  ok(await f.request(`draft-generations/${job.id}/cancel`,{}));release();await f.drainDraftGenerations();
  const after=await f.state();assert.equal(after.draftGenerationJobs[0].status,'cancelled');assert.equal(after.drafts.length,s.drafts.length);
});
test('draft soft delete and full history restoration work through the authenticated API',async t=>{
  const f=await fixture(t),d=ok(await f.request('drafts',{method:'template',contentMode:'text'}));
  const changed=ok(await f.request('drafts/'+d.id,{...d,title:'人工修改标题'},'PUT'));
  const restored=ok(await f.request('drafts/'+d.id+'/restore',{revision:changed.revision,versionId:changed.history[0].id||changed.history[0].at}));assert.equal(restored.title,d.title);assert.equal(restored.revision,3);
  ok(await f.request('drafts/bulk',{ids:[d.id],action:'trash'}));assert.ok((await f.state()).drafts.find(x=>x.id===d.id).deletedAt);
  ok(await f.request('drafts/bulk',{ids:[d.id],action:'restore'}));assert.equal((await f.state()).drafts.find(x=>x.id===d.id).deletedAt,undefined);
});
test('unchanged state responds 304 and a mutation invalidates the cache',async t=>{
  const f=await fixture(t),first=await f.request('state'),etag=first.headers.get('etag');assert.ok(etag);assert.equal((await f.request('state',undefined,'GET',{'If-None-Match':etag})).status,304);
  ok(await f.request('drafts',{method:'template',contentMode:'text'}));assert.equal((await f.request('state',undefined,'GET',{'If-None-Match':etag})).status,200);
});
test('text-layer edits save a new asset, preserve original bytes and keep failed quality out of the draft',async t=>{
  const f=await fixture(t,{imageComposer:async(bytes,overlay)=>({bytes:Buffer.concat([bytes,Buffer.from('new')]),mime:'image/png',extension:'png',overlay}),qualityAssessor:async()=>({status:'rejected',issues:['文字遮挡主体'],checks:{composition:'fail'}})});
  const source=ok(await f.request('product-assets/upload',{kind:'image',name:'产品.png',data:png.toString('base64')})),d=ok(await f.request('drafts',{method:'template',contentMode:'image',productAssetIds:[source.id]}));
  const result=ok(await f.request(`product-assets/${source.id}/text-overlay`,{draftId:d.id,revision:d.revision,textOverlay:{version:1,width:1024,height:1536,layers:[{id:'title',text:'标题',x:64,y:64,fontSize:64,maxWidth:896}]}}));
  assert.notEqual(result.asset.id,source.id);assert.equal(result.asset.publishable,false);assert.deepEqual(result.draft.productAssetIds,[source.id]);const state=await f.state();assert.equal(state.productAssets.find(a=>a.id===source.id).name,source.name);assert.equal(state.imageJobs[0].attachStatus,'quality_review');
});
test('overdue schedule never submits blindly after restart and can be rescheduled',async t=>{
  const f=await fixture(t),d=ok(await f.request('drafts',{method:'template',contentMode:'text'}));
  await f.store.mutate(s=>{const draft=s.drafts.find(x=>x.id===d.id);draft.approved=true;draft.gaps=[];s.jobs.push({id:'overdue',draftId:d.id,accountId:d.accountId,draftRevision:d.revision,status:'scheduled',attempts:0,scheduledAt:'2020-01-01T00:00:00Z'});});
  await f.tick(new Date());let current=await f.state();assert.equal(current.jobs.find(x=>x.id==='overdue').reasonCode,'overdue');
  const moved=ok(await f.request('jobs/overdue',{scheduledAt:new Date(Date.now()+86400000).toISOString()},'PATCH'));assert.equal(moved.status,'scheduled');assert.equal(moved.reasonCode,null);
});
