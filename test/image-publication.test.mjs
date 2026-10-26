import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';
import {checks,imageRole,isPublishableImage,isAutomaticImage} from '../app/content.mjs';
import {publicAsset} from '../app/product-assets.mjs';

const root=path.resolve(import.meta.dirname,'..');
const asset=(id,metadata={})=>({id,kind:'image',name:id+'.png',metadata});
const product={version:'v1',stage:'开发内测'};
const draft=ids=>({title:'备用号使用条件',body:'产品处于开发内测阶段。',contentMode:'image',productVersion:'v1',productAssetIds:ids,gaps:[]});

test('legacy model previews and adjusted descendants remain excluded, while ordinary uploaded render photos remain usable',()=>{
  const manual=asset('渲染图1'),legacy=asset('legacy',{modelAssetId:'model'}),adjusted=asset('adjusted',{adjustedFromAssetId:legacy.id}),again=asset('again',{adjustedFromAssetId:adjusted.id}),all=[manual,legacy,adjusted,again];
  assert.equal(imageRole(manual,all),'image');assert.equal(isPublishableImage(manual,all),true);assert.equal(isAutomaticImage(manual,all),true);
  for(const image of [legacy,adjusted,again]){assert.equal(imageRole(image,all),'modelPreview');assert.equal(isPublishableImage(image,all),false);assert.equal(isAutomaticImage(image,all),false);}
  const exposed=publicAsset(again,{productAssets:all});assert.equal(exposed.imageRole,'modelPreview');assert.equal(exposed.publishable,false);assert.equal(exposed.automatic,false);
});

test('publication output can use model geometry as reference but cannot erase test provenance or an explicit preview flag',()=>{
  const preview=asset('preview',{modelAssetId:'model',previewOnly:true}),finished=asset('finished',{adjustedFromAssetId:preview.id,usage:'publication'}),cropped=asset('cropped',{adjustedFromAssetId:finished.id}),testImage=asset('test',{testOnly:true}),testChild=asset('test-child',{adjustedFromAssetId:testImage.id,usage:'publication'}),testAI=asset('test-ai',{sourceAssetIds:[testImage.id],usage:'publication'}),conflict=asset('conflict',{previewOnly:true,usage:'publication'}),all=[preview,finished,cropped,testImage,testChild,testAI,conflict];
  for(const image of [finished,cropped]){assert.equal(imageRole(image,all),'publication');assert.equal(isAutomaticImage(image,all),true);}
  for(const image of [testImage,testChild,testAI]){assert.equal(imageRole(image,all),'test');assert.equal(isPublishableImage(image,all),false);}
  assert.equal(imageRole(conflict,all),'modelPreview');
  testImage.metadata.adjustedFromAssetId=testChild.id;assert.equal(imageRole(testChild,all),'test');
  assert.equal(isPublishableImage({id:'icon',kind:'icon',metadata:{usage:'publication'}},all),false);
});

test('publishing checks reject every selected test or preview image even when a valid cover is also selected',()=>{
  const good=asset('good'),preview=asset('preview',{modelAssetId:'model'}),testImage=asset('test',{testOnly:true}),all=[good,preview,testImage];
  assert.deepEqual(checks(draft([good.id]),product,all),[]);
  assert.ok(checks(draft([good.id,preview.id]),product,all).some(value=>/模型预览图不能直接发布/.test(value)));
  assert.ok(checks(draft([good.id,testImage.id]),product,all).some(value=>/测试图片不能用于发布/.test(value)));
  assert.ok(checks(draft([preview.id]),product,all).some(value=>/产品图.*主图/.test(value)));
  assert.deepEqual(checks({...draft([preview.id,testImage.id]),contentMode:'text'},product,all),[]);
});

test('draft-specific covers remain explicitly publishable but never become automatic images for another draft',()=>{
  const manual=asset('product-photo'),dedicated=asset('cover',{usage:'publication',draftId:'original-draft'}),adjusted=asset('cover-crop',{adjustedFromAssetId:dedicated.id}),nonReusable=asset('one-off',{usage:'publication',reusable:false}),all=[manual,dedicated,adjusted,nonReusable];
  assert.equal(isAutomaticImage(manual,all),true);
  for(const image of [dedicated,adjusted,nonReusable]){assert.equal(isPublishableImage(image,all),true);assert.equal(isAutomaticImage(image,all),false);}
  assert.deepEqual(all.filter(image=>isAutomaticImage(image,all)).slice(-2).map(image=>image.id),[manual.id]);
  assert.deepEqual(checks({...draft([dedicated.id]),id:'original-draft'},product,all),[]);
  assert.equal(publicAsset(dedicated,{productAssets:all}).automatic,false);
});

function crc32(buffer){let crc=-1;for(const byte of buffer){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^-1)>>>0;}
function chunk(type,bytes){const name=Buffer.from(type),output=Buffer.alloc(bytes.length+12);output.writeUInt32BE(bytes.length,0);name.copy(output,4);bytes.copy(output,8);output.writeUInt32BE(crc32(Buffer.concat([name,bytes])),output.length-4);return output;}
function png(color){const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,...color]))),chunk('IEND',Buffer.alloc(0))]);}
const generated=png([10,20,30]);
const env={REDPILOT_AI_KEY:'test-only-publication-text-key',REDPILOT_AI_MODEL:'offline-text',REDPILOT_AI_BASE_URL:'https://text.example/v1',REDPILOT_IMAGE_API_KEY:'test-only-publication-image-key',REDPILOT_IMAGE_MODEL:'offline-image',REDPILOT_IMAGE_BASE_URL:'https://image.example/v1'};
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-publication-')),credentials={email:'publication@example.test',password:'Test-only-'+randomBytes(18).toString('hex')};let calls=0;
  await configureAuth({directory,...credentials});
  const app=await createApp({root,directory,env,fetcher:async url=>{calls++;if(url.includes('/images/'))return new Response(JSON.stringify({data:[{b64_json:generated.toString('base64')}]}));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'备用号使用条件',body:'产品正在开发内测，使用前请核对联网条件。',tags:[],gaps:[],adaptation:'离线测试'})}}]}));},
    renderRunner:async({outputPath})=>writeFile(outputPath,png([120,120,120])),linkReader:async()=>({status:'unavailable',missing:[],error:'offline'}),trendReader:async()=>[],creatorReader:async()=>({status:'unavailable',notes:[]}),feishuReader:async()=>({status:'unavailable',documents:[],sources:[]}),
    xhsPublisher:{async publish(){assert.fail('publication eligibility tests cannot publish');},async verify(){assert.fail('publication eligibility tests cannot verify');},async checkConnection(){return {status:'unavailable'};}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  return {directory,store:app.store,tick:date=>app.tick(date),get calls(){return calls;},async request(endpoint,data,method='POST'){const result=await fetch(base+'/api/'+endpoint,{method,signal:AbortSignal.timeout(5000),headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:result.status,data:await result.json()};}};
}
const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
const state=async f=>ok(await f.request('state',undefined,'GET'));
const upload=(f,name,color,extra={})=>f.request('product-assets/upload',{name,kind:'image',data:png(color).toString('base64'),...extra}).then(ok);
async function waitFor(fn){for(let n=0;n<160;n++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('fixture task did not finish');}

test('manual adjustment persists model preview provenance and cannot clear it through upload metadata',async t=>{
  const f=await fixture(t),preview=await upload(f,'preview.png',[100,100,100]);await f.store.mutate(s=>{s.productAssets.find(a=>a.id===preview.id).metadata.modelAssetId='model';});
  const adjusted=await upload(f,'adjusted.png',[101,101,101],{sourceAssetId:preview.id,metadata:{usage:'publication',previewOnly:false}});
  assert.equal(adjusted.metadata.previewOnly,true);assert.equal(adjusted.metadata.adjustedFromAssetId,preview.id);assert.equal(adjusted.publishable,false);
  await f.store.mutate(s=>{s.productAssets=s.productAssets.filter(a=>a.id!==preview.id);});assert.equal((await state(f)).productAssets.find(a=>a.id===adjusted.id).publishable,false);
});

test('new 3D renders are preview-only and default draft selection excludes them and test assets',async t=>{
  const f=await fixture(t),manual=await upload(f,'渲染图1.png',[200,200,200]),testImage=await upload(f,'test.png',[201,201,201]);
  await f.store.mutate(s=>{s.productAssets.find(a=>a.id===testImage.id).metadata.testOnly=true;});
  const filename=path.join(f.directory,'source.step');await writeFile(filename,"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;");
  const model=ok(await f.request('product-assets/import',{paths:[filename],mode:'linked'})).items[0],job=ok(await f.request('product-assets/'+model.id+'/render',{preset:'studio'}));
  const rendered=await waitFor(async()=>{const current=await state(f),record=current.productRenders.find(r=>r.id===job.id);return record?.status==='completed'&&current.productAssets.find(a=>a.id===record.imageAssetId);});
  assert.equal(rendered.metadata.previewOnly,true);assert.equal(rendered.imageRole,'modelPreview');assert.equal(rendered.publishable,false);assert.equal(rendered.automatic,false);
  const created=ok(await f.request('drafts',{method:'template',contentMode:'image'}));assert.deepEqual(created.productAssetIds,[manual.id]);assert.equal(f.calls,0);
  const selected=ok(await f.request('drafts/'+created.id,{...created,productAssetIds:[manual.id,rendered.id,testImage.id]},'PUT'));
  const blocked=await f.request('drafts/'+selected.id+'/schedule',{confirm:true,revision:selected.revision,scheduledAt:new Date(Date.now()+3600000).toISOString()});assert.equal(blocked.status,409);assert.match(blocked.data.error,/测试图片/);assert.match(blocked.data.error,/模型预览/);assert.equal((await state(f)).jobs.length,0);
});

test('daily automatic generation excludes legacy model preview adjustment chains',async t=>{
  const f=await fixture(t),manual=await upload(f,'渲染图2.png',[210,210,210]),preview=await upload(f,'legacy.png',[211,211,211]),adjusted=await upload(f,'old-adjusted.png',[212,212,212]);
  await f.store.mutate(s=>{s.productAssets.find(a=>a.id===preview.id).metadata.modelAssetId='model';s.productAssets.find(a=>a.id===adjusted.id).metadata.adjustedFromAssetId=preview.id;s.inspirations=[];s.feishuSync.enabled=false;s.trendSchedule.enabled=false;for(const a of s.accounts){a.reportSettings.enabled=false;a.settings={...a.settings,enabled:true,mode:'review',imageShare:100,time:'09:00',timezone:'Asia/Shanghai'};}});
  await f.tick(new Date('2030-01-02T01:00:00Z'));const created=(await state(f)).drafts.find(d=>d.method==='ai');assert.ok(created);assert.deepEqual(created.productAssetIds,[]);assert.deepEqual(created.imageSourceAssetIds,[manual.id]);const finished=await waitFor(async()=>{const current=await state(f);return current.imageJobs.length===3&&current.imageJobs.every(job=>!['queued','generating'].includes(job.status))?current:false;});for(const job of finished.imageJobs)assert.deepEqual(job.sourceAssetIds,[manual.id]);assert.ok(!finished.drafts.find(d=>d.id===created.id).productAssetIds.includes(manual.id));assert.equal(f.calls,4);assert.equal(finished.jobs.length,0);
});

test('AI image output is a publication asset while test-derived AI output stays blocked',async t=>{
  for(const testOnly of [false,true]){
    const f=await fixture(t),preview=await upload(f,'geometry.png',[220,220,220]);await f.store.mutate(s=>{Object.assign(s.productAssets.find(a=>a.id===preview.id).metadata,{modelAssetId:'model',previewOnly:true,...(testOnly?{testOnly:true}:{})});});
    const job=ok(await f.request('image-jobs',{mode:'edit',prompt:'制作正式产品封面，保留产品外观',sourceAssetIds:[preview.id],size:'1024x1024'}));
    const result=await waitFor(async()=>{const current=await state(f),record=current.imageJobs.find(j=>j.id===job.id);assert.notEqual(record.status,'failed',record.error);return record.status==='completed'&&current.productAssets.find(a=>a.id===record.assetId);});
    assert.equal(result.metadata.usage,'publication');assert.equal(result.metadata.aiGenerated,true);assert.deepEqual(result.metadata.sourceAssetIds,[preview.id]);assert.equal(result.imageRole,testOnly?'test':'publication');assert.equal(result.publishable,!testOnly);assert.equal(result.automatic,!testOnly);assert.equal(f.calls,1);
  }
});
