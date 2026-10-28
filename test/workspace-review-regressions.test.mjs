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


test('an already-open editor cannot save or schedule a draft moved to the recycle bin in another tab',async t=>{
  const f=await fixture(t),d=ok(await f.request('drafts',{method:'template',contentMode:'text'}));
  ok(await f.request('drafts/bulk',{ids:[d.id],action:'trash'}));
  assert.equal((await f.request(`drafts/${d.id}`,{...d,title:'来自旧标签页'},'PUT')).status,409);
  assert.equal((await f.request(`drafts/${d.id}/schedule`,{revision:d.revision,confirm:true,scheduledAt:new Date(Date.now()+3600000).toISOString()})).status,409);
  const after=await f.state();assert.equal(after.jobs.filter(job=>job.draftId===d.id).length,0);assert.equal(after.drafts.find(draft=>draft.id===d.id).title,d.title);
});

test('renaming a generated asset persists an explicit display name',async t=>{
  const f=await fixture(t),asset=ok(await f.request('product-assets/upload',{name:'AI-test.png',kind:'image',data:png.toString('base64')}));
  await f.store.mutate(s=>{s.productAssets.find(item=>item.id===asset.id).metadata.aiGenerated=true;});
  const renamed=ok(await f.request(`product-assets/${asset.id}`,{name:'通勤封面'},'PATCH'));
  assert.equal(renamed.name,'通勤封面');assert.equal(renamed.metadata.renamed,true);
});

test('a text-layer candidate that passes recheck replaces the original image if the draft has not changed',async t=>{
  let quality='rejected';const f=await fixture(t,{imageComposer:async(bytes,overlay)=>({bytes:Buffer.concat([bytes,Buffer.from('new')]),mime:'image/png',extension:'png',overlay}),qualityAssessor:async()=>({status:quality,issues:quality==='passed'?[]:['需要调整'],checks:{}})});
  const source=ok(await f.request('product-assets/upload',{kind:'image',name:'产品.png',data:png.toString('base64')})),d=ok(await f.request('drafts',{method:'template',contentMode:'image',productAssetIds:[source.id]}));
  const edited=ok(await f.request(`product-assets/${source.id}/text-overlay`,{draftId:d.id,revision:d.revision,textOverlay:{version:1,width:1024,height:1536,layers:[{id:'title',text:'封面标题',x:64,y:64,fontSize:64,maxWidth:896}]}}));
  const candidate=(await f.state()).imageJobs.find(job=>job.assetId===edited.asset.id);assert.equal(candidate.attachStatus,'quality_review');
  quality='passed';const checked=ok(await f.request(`image-jobs/${candidate.id}/recheck`,{}));
  assert.equal(checked.job.attachStatus,'attached');assert.deepEqual((await f.state()).drafts.find(draft=>draft.id===d.id).productAssetIds,[edited.asset.id]);
});

test('today metrics follow soft-delete and restore immediately without regenerating the report',async t=>{
  const f=await fixture(t),d=ok(await f.request('drafts',{method:'template',contentMode:'text'})),before=await f.state();
  const pending=state=>state.liveMetrics.find(metric=>metric.key==='pending_review').value;
  ok(await f.request('drafts/bulk',{ids:[d.id],action:'trash'}));assert.equal(pending(await f.state()),pending(before)-1);
  ok(await f.request('drafts/bulk',{ids:[d.id],action:'restore'}));assert.equal(pending(await f.state()),pending(before));
});

import {queueDraftImages,settleDraftImageBatch} from '../app/draft-images.mjs';
import {restoreDraftVersion} from '../app/workspace-actions.mjs';
const imageState=()=>({accounts:[{id:'account',enabled:true}],jobs:[],imageJobs:[],inspirations:[],product:{version:'v1',name:'产品',facts:[],conditions:[]},productAssets:[{id:'original',name:'产品图',kind:'image',mime:'image/png',size:100,metadata:{}}],drafts:[{id:'draft',accountId:'account',title:'备用号怎么放',body:'把备用号码放进设备',contentMode:'image',tags:[],slides:[],gaps:['原稿待确认事项'],productAssetIds:['original'],productVersion:'v1',revision:1,history:[],updatedAt:'2026-10-28T00:00:00Z'}]});

test('a completed but rejected image can be redone without redoing an approved sibling',()=>{
  const s=imageState(),batch=queueDraftImages(s,'draft',{revision:1,count:1});
  const rejected=batch.jobs[0];Object.assign(rejected,{status:'completed',assetId:'bad',attachStatus:'quality_review'});s.productAssets.push({id:'bad',name:'待改图',kind:'image',mime:'image/png',size:100,metadata:{aiGenerated:true,draftId:'draft',quality:{status:'rejected',issues:['字不清楚']}}});
  const retry=queueDraftImages(s,'draft',{revision:1,retryJobId:rejected.id});assert.equal(retry.jobs.length,1);assert.equal(retry.jobs[0].retryOf,rejected.id);assert.equal(retry.jobs[0].status,'queued');
});

test('image attachment records all fields needed to restore the earlier draft version',()=>{
  const s=imageState(),batch=queueDraftImages(s,'draft',{revision:1,count:1}),job=batch.jobs[0];
  s.productAssets.push({id:'finished',name:'配图',kind:'image',mime:'image/png',size:100,metadata:{aiGenerated:true,draftId:'draft',quality:{status:'passed'}}});Object.assign(job,{status:'completed',assetId:'finished'});settleDraftImageBatch(s,batch.batchId);
  const draft=s.drafts[0],history=draft.history[0];assert.deepEqual(history.gaps,['原稿待确认事项']);assert.equal(history.productVersion,'v1');
  draft.gaps=[];draft.productVersion='v2';restoreDraftVersion(s,'draft',{revision:draft.revision,versionId:history.id||history.at});assert.deepEqual(draft.gaps,['原稿待确认事项']);assert.equal(draft.productVersion,'v1');assert.deepEqual(draft.productAssetIds,['original']);
});
