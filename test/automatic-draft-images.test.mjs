import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';

const root=path.resolve(import.meta.dirname,'..');
const env={REDPILOT_AI_KEY:'fixture-copy-key',REDPILOT_AI_MODEL:'fixture-copy',REDPILOT_AI_BASE_URL:'https://copy.example/v1',REDPILOT_IMAGE_API_KEY:'fixture-images-key',REDPILOT_IMAGE_BASE_URL:'https://images.example/v1',REDPILOT_IMAGE_MODEL:'fixture-image',REDPILOT_PUBLISH_URL:'https://publish.example/v3',REDPILOT_PUBLISH_TOKEN:'fixture-bridge-token'};
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function crc32(bytes){let crc=-1;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^-1)>>>0;}
function chunk(type,bytes){const name=Buffer.from(type),out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);name.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([name,bytes])),out.length-4);return out;}
function png(color){const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,color,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
const copyResponse=index=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'备用号安排'+index,body:'SimHelper 当前处于工程内测。SIM 必须移入设备，设备连接 Wi-Fi，手机需要互联网。',tags:['产品开发'],gaps:[],adaptation:'学习问题先行结构'})}}]}));
const imageResponse=index=>new Response(JSON.stringify({data:[{b64_json:png(90+index).toString('base64')}]}));
const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
async function waitUntil(read,message){for(let i=0;i<250;i++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail(message);}
async function fixture(t,{onImage,release=()=>{}}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-auto-images-'));
  const credentials={email:'auto-images@example.test',password:'Fixture-'+randomBytes(18).toString('hex')};await configureAuth({directory,...credentials});
  const calls={copy:0,image:0,publish:0,imageRequests:[]};
  const app=await createApp({root,directory,env,fetcher:async(url,options)=>{
    if(url.startsWith('https://copy.example/')){calls.copy++;return copyResponse(calls.copy);}
    if(url.startsWith('https://images.example/')){const index=++calls.image;calls.imageRequests.push({url,body:options.body});const custom=await onImage?.(index,options);return custom||imageResponse(index);}
    if(url.startsWith('https://publish.example/')){calls.publish++;return new Response(JSON.stringify({status:'pending'}));}
    throw Error('unexpected fixture network destination');
  },trendReader:async()=>[],feishuReader:async()=>({status:'unavailable',documents:[],sources:[]}),linkReader:async()=>({status:'unavailable',missing:[]}),xhsPublisher:{async publish(){calls.publish++;throw Error('unexpected native publish');},async verify(){throw Error('unexpected native verify');},async close(){}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  t.after(async()=>{release();await app.close();await rm(directory,{recursive:true,force:true});});
  async function request(endpoint,data,method='POST'){const response=await fetch(base+'/api/'+endpoint,{method,headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,data:await response.json()};}
  const state=async()=>ok(await request('state',undefined,'GET'));
  const source=ok(await request('product-assets/upload',{name:'自有产品原图.png',kind:'image',data:png(10).toString('base64')}));
  return {calls,request,state,source,store:app.store,tick:date=>app.tick(date)};
}
async function create(f,extra={}){const input={method:'ai',contentMode:'image',productAssetIds:[f.source.id],instruction:randomUUID(),clientRequestId:randomUUID(),...extra};return {input,job:ok(await f.request('draft-generations',input))};}
async function completeCopy(f,id){return waitUntil(async()=>{const s=await f.state(),job=s.draftGenerationJobs.find(j=>j.id===id);return job?.status==='completed'?{state:s,job,draft:s.drafts.find(d=>d.id===job.draftId)}:false;},'copy task did not complete');}
async function completeImages(f,batchId){return waitUntil(async()=>{const s=await f.state(),jobs=s.imageJobs.filter(j=>j.batchId===batchId);return jobs.length===3&&jobs.every(j=>!['queued','generating'].includes(j.status))?{state:s,jobs}:false;},'image batch did not finish');}

test('AI image drafts queue real images, release the copy queue and never attach bare product references as finished artwork',async t=>{
  const pending=gate(),f=await fixture(t,{release:pending.resolve,onImage:async index=>{if(index===1)await pending.promise;}}),created=await create(f);
  const copied=await completeCopy(f,created.job.id);await waitUntil(async()=>f.calls.image===1,'first image request did not begin');
  assert.deepEqual(copied.draft.productAssetIds,[]);assert.deepEqual(copied.draft.imageSourceAssetIds,[f.source.id]);
  assert.equal(copied.job.imageBatchId,copied.draft.imageGeneration.batchId);assert.equal(copied.state.imageJobs.filter(j=>j.batchId===copied.job.imageBatchId).length,3);
  const text=await create(f,{contentMode:'text'}),textCopy=await completeCopy(f,text.job.id);
  assert.equal(textCopy.draft.contentMode,'text');assert.deepEqual(textCopy.draft.productAssetIds,[]);assert.deepEqual(textCopy.draft.imageSourceAssetIds,[]);assert.equal(textCopy.job.imageBatchId,null);assert.equal(f.calls.copy,2);assert.equal(f.calls.image,1);
  pending.resolve();const completed=await completeImages(f,copied.job.imageBatchId),draft=completed.state.drafts.find(d=>d.id===copied.draft.id);
  assert.equal(f.calls.image,3);assert.equal(draft.imageGeneration.status,'completed');assert.equal(draft.productAssetIds.length,3);assert.ok(!draft.productAssetIds.includes(f.source.id));
  assert.ok(completed.jobs.every(j=>j.attachStatus==='attached'&&j.draftId===draft.id));
  for(const id of draft.productAssetIds){const asset=completed.state.productAssets.find(a=>a.id===id);assert.equal(asset.metadata.aiGenerated,true);assert.equal(asset.metadata.draftId,draft.id);}
  assert.equal(ok(await f.request('draft-generations',created.input)).id,created.job.id);assert.equal((await f.state()).imageJobs.length,3);assert.equal(f.calls.copy,2);assert.equal(f.calls.image,3);assert.equal(f.calls.publish,0);
});

test('failed image generation remains explicit and does not retry text or silently fall back to source photos',async t=>{
  const f=await fixture(t,{onImage:index=>index===2?new Response('private upstream message',{status:500}):undefined}),created=await create(f),copied=await completeCopy(f,created.job.id),completed=await completeImages(f,copied.job.imageBatchId);
  const draft=completed.state.drafts.find(d=>d.id===copied.draft.id);
  assert.equal(draft.imageGeneration.status,'failed');assert.ok(draft.imageGeneration.error);assert.equal(completed.jobs.filter(j=>j.status==='failed').length,1);
  assert.equal(completed.state.draftGenerationJobs.find(j=>j.id===created.job.id).status,'completed');assert.equal(f.calls.copy,1);assert.equal(f.calls.image,3);assert.ok(!draft.productAssetIds.includes(f.source.id));assert.equal(draft.productAssetIds.length,2);
  await f.tick(new Date());assert.equal(f.calls.copy,1);assert.equal(f.calls.image,3);assert.equal(f.calls.publish,0);assert.doesNotMatch(JSON.stringify(completed.state),/private upstream message|fixture-images-key/);
});

test('two copied drafts keep their own queued image batches while an earlier image request is pending',async t=>{
  const pending=gate(),f=await fixture(t,{release:pending.resolve,onImage:async index=>{if(index===1)await pending.promise;}}),first=await create(f),firstCopy=await completeCopy(f,first.job.id);
  await waitUntil(async()=>f.calls.image===1,'first image request did not begin');
  const second=await create(f),secondCopy=await completeCopy(f,second.job.id);assert.notEqual(firstCopy.draft.id,secondCopy.draft.id);assert.notEqual(firstCopy.job.imageBatchId,secondCopy.job.imageBatchId);assert.equal((await f.state()).imageJobs.length,6);assert.equal(f.calls.copy,2);
  pending.resolve();await completeImages(f,firstCopy.job.imageBatchId);const completed=await completeImages(f,secondCopy.job.imageBatchId);
  for(const id of [firstCopy.draft.id,secondCopy.draft.id]){const draft=completed.state.drafts.find(d=>d.id===id);assert.equal(draft.imageGeneration.status,'completed');assert.equal(draft.productAssetIds.length,3);assert.ok(draft.productAssetIds.every(assetId=>completed.state.productAssets.find(a=>a.id===assetId).metadata.draftId===id));}
  assert.equal(new Set(completed.state.drafts.filter(d=>[firstCopy.draft.id,secondCopy.draft.id].includes(d.id)).flatMap(d=>d.productAssetIds)).size,6);assert.equal(f.calls.image,6);assert.equal(f.calls.publish,0);
});

test('a changed draft keeps later image results available without replacing the newer text or images',async t=>{
  const pending=gate(),f=await fixture(t,{release:pending.resolve,onImage:async index=>{if(index===1)await pending.promise;}}),created=await create(f),copied=await completeCopy(f,created.job.id);
  await waitUntil(async()=>f.calls.image===1,'first image request did not begin');
  const edited=ok(await f.request('drafts/'+copied.draft.id,{...copied.draft,body:'用户修改后的内测正文',productAssetIds:[f.source.id]},'PUT'));assert.equal(edited.revision,2);
  pending.resolve();const completed=await completeImages(f,copied.job.imageBatchId),draft=completed.state.drafts.find(d=>d.id===copied.draft.id);
  assert.equal(draft.body,'用户修改后的内测正文');assert.deepEqual(draft.productAssetIds,[f.source.id]);assert.equal(draft.revision,2);assert.equal(draft.imageGeneration.status,'failed');assert.ok(completed.jobs.every(j=>j.status==='completed'&&j.attachStatus==='conflict'&&j.assetId));assert.equal(f.calls.copy,1);assert.equal(f.calls.image,3);
});

test('daily automatic posts wait for the complete image batch and never publish a partially failed set',async t=>{
  const pending=gate(),f=await fixture(t,{release:pending.resolve,onImage:async index=>{if(index===1)await pending.promise;return index===2?new Response('fixture image failure',{status:500}):undefined;}});
  await f.store.mutate(s=>{s.accounts[0].settings={enabled:true,time:'00:00',timezone:'Asia/Shanghai',mode:'automatic',imageShare:100};s.accounts[0].bridgeAccountId='fixture-external-account';s.accounts[0].reportSettings.enabled=false;s.trendSchedule.enabled=false;});
  await f.tick(new Date());await waitUntil(async()=>f.calls.image===1,'daily image generation did not begin');
  const current=await f.state(),draft=current.drafts.find(d=>d.imageGeneration?.dailyKey);assert.ok(draft);assert.deepEqual(draft.productAssetIds,[]);assert.equal(current.jobs.length,0);assert.equal(f.calls.publish,0);
  pending.resolve();const completed=await completeImages(f,draft.imageGeneration.batchId);assert.equal(completed.state.drafts.find(d=>d.id===draft.id).imageGeneration.status,'failed');
  await f.tick(new Date());assert.equal((await f.state()).jobs.length,0);assert.equal(f.calls.publish,0);assert.equal(f.calls.copy,1);assert.equal(f.calls.image,3);
});

test('provider echoes and repeated pages cannot become an automatically published finished set',async t=>{
  for(const scenario of ['source-echo','duplicate-pages'])await t.test(scenario,async t=>{
    const f=await fixture(t,{onImage:()=>scenario==='source-echo'?new Response(JSON.stringify({data:[{b64_json:png(10).toString('base64')}]})):imageResponse(1)});
    await f.store.mutate(s=>{s.accounts[0].settings={enabled:true,time:'00:00',timezone:'Asia/Shanghai',mode:'automatic',imageShare:100};s.accounts[0].bridgeAccountId='fixture-external-account';s.accounts[0].reportSettings.enabled=false;s.trendSchedule.enabled=false;});
    await f.tick(new Date());
    const draft=await waitUntil(async()=>{const s=await f.state();return s.drafts.find(d=>d.imageGeneration?.dailyKey);},'daily image draft was not created');
    const completed=await completeImages(f,draft.imageGeneration.batchId),saved=completed.state.drafts.find(d=>d.id===draft.id);
    assert.equal(saved.imageGeneration.status,'failed');assert.equal(completed.jobs.filter(j=>j.status==='failed').length,scenario==='source-echo'?3:2);assert.ok(!saved.productAssetIds.includes(f.source.id));
    assert.equal(new Set(saved.productAssetIds).size,saved.productAssetIds.length);assert.equal(saved.productAssetIds.length,scenario==='source-echo'?0:1);
    await f.tick(new Date());assert.equal((await f.state()).jobs.length,0);assert.equal(f.calls.publish,0);assert.equal(f.calls.copy,1);assert.equal(f.calls.image,3);
  });
});
