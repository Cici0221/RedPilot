import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';

const root=path.resolve(import.meta.dirname,'..');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const DOC_A='https://fixture.feishu.cn/docx/WorkspaceDocumentAAAA0001';
const DOC_B='https://fixture.feishu.cn/docx/WorkspaceDocumentBBBB0002';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
const product=(name,source)=>({name,brand:name+'品牌',stage:'内测',summary:name+'专属说明',facts:[name+'功能'],conditions:['需要联网'],restrictions:[],sources:[source]});
async function waitFor(fn,label){for(let n=0;n<200;n++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail(label);}
async function fixture(t,{feishuReader=async()=>({status:'unavailable',documents:[],sources:[]}),beforeClose}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-workspace-api-'));
  const credentials={email:'workspace-test@example.test',password:'Test-only-'+randomBytes(18).toString('hex')};
  await configureAuth({directory,...credentials});
  const app=await createApp({root,directory,env:{},feishuReader,trendReader:async()=>[],linkReader:async()=>({status:'unavailable',missing:[]}),fetcher:async()=>{throw Error('Unexpected external network');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  t.after(async()=>{beforeClose?.();await app.close();await rm(directory,{recursive:true,force:true});});
  const request=async(accountId,endpoint,data,method='POST')=>{
    const response=await fetch(base+'/api/'+endpoint,{method,signal:AbortSignal.timeout(10000),headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json',...(accountId?{'X-RedPilot-Account':accountId}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,data:await response.json()};
  };
  const state=async accountId=>ok(await request(accountId,'state',undefined,'GET'));
  const first=await state(),owner=first.workspaceAccountId||first.defaultAccountId;
  const secondary=ok(await request(owner,'accounts',{name:'咖啡小号',type:'personal',notes:'咖啡与手冲教程'})).id;
  return {request,state,owner,secondary,tick:date=>app.tick(date),store:app.store,
    file:async(accountId,pathname,{query=false}={})=>{const target=new URL(pathname,base);if(query)target.searchParams.set('workspace',accountId);const response=await fetch(target,{headers:{Cookie:cookie,...(!query&&accountId?{'X-RedPilot-Account':accountId}:{})}});return {status:response.status,bytes:Buffer.from(await response.arrayBuffer())};}};
}

test('workspace state returns only selected account content while retaining the account switcher registry',async t=>{
  const f=await fixture(t),a=await f.state(f.owner),b=await f.state(f.secondary);
  assert.equal(a.workspaceAccountId,f.owner);assert.equal(b.workspaceAccountId,f.secondary);
  assert.ok(a.accounts.some(account=>account.id===f.secondary));assert.ok(b.accounts.some(account=>account.id===f.owner));
  assert.ok(a.inspirations.length>0,'legacy references remain with the original account');
  for(const key of ['inspirations','drafts','jobs','productAssets','creators','feishuDocuments','feishuJobs','imageJobs','draftGenerationJobs','topicPool','operationReports'])assert.deepEqual(b[key],[],key+' leaked to new account');
  assert.deepEqual(b.product.facts,[]);assert.deepEqual(b.product.sources,[]);assert.deepEqual(b.feishuSync.sourceUrls,[]);
  for(const state of [a,b]){assert.equal(state.workspaces,undefined);assert.equal(state.accountWorkspaces,undefined);}
  const invalid=await f.request('missing-account','state',undefined,'GET');assert.equal(invalid.status,404);
  assert.equal((await f.state()).workspaceAccountId,f.owner,'opening another workspace must not change the server default');
});

test('product edits and Feishu sources stay independent between concurrent workspace requests',async t=>{
  const f=await fixture(t);
  await Promise.all([f.request(f.owner,'product',product('通信设备',DOC_A),'PUT').then(ok),f.request(f.secondary,'product',product('咖啡设备',DOC_B),'PUT').then(ok)]);
  const [a,b]=await Promise.all([f.state(f.owner),f.state(f.secondary)]);
  assert.equal(a.product.name,'通信设备');assert.equal(b.product.name,'咖啡设备');
  assert.deepEqual(a.product.sources,[DOC_A]);assert.deepEqual(b.product.sources,[DOC_B]);
  assert.deepEqual(a.feishuSync.sourceUrls,[DOC_A]);assert.deepEqual(b.feishuSync.sourceUrls,[DOC_B]);
  assert.equal(a.feishuSync.enabled,false);assert.equal(b.feishuSync.enabled,false);
  assert.notEqual(a.product.version,b.product.version);
});

test('references deduplicate only inside their workspace and foreign ids cannot be changed or removed',async t=>{
  const f=await fixture(t);
  const a=ok(await f.request(f.owner,'inspirations',{title:'A收藏',text:'A专属正文',files:[{name:'reference.png',data:PNG}]})).item;
  const b=ok(await f.request(f.secondary,'inspirations',{title:'B收藏',text:'B专属正文',files:[{name:'reference.png',data:PNG}]})).item;
  assert.notEqual(a.id,b.id,'matching screenshot hashes must not merge references between accounts');
  assert.equal((await f.request(f.secondary,`inspirations/${a.id}`,{title:'串号修改'},'PUT')).status,404);
  assert.equal((await f.request(f.secondary,`inspirations/${a.id}`,{},'DELETE')).status,404);
  assert.equal((await f.request(f.secondary,'inspirations',{targetId:a.id,text:'错误补充'})).status,404);
  const [sa,sb]=await Promise.all([f.state(f.owner),f.state(f.secondary)]);
  assert.ok(sa.inspirations.some(item=>item.id===a.id&&item.title==='A收藏'));
  assert.ok(!sa.inspirations.some(item=>item.id===b.id));assert.deepEqual(sb.inspirations.map(item=>item.id),[b.id]);
});

test('a manual Feishu task finishing after an account switch writes only to its originating workspace',async t=>{
  const started=deferred(),finish=deferred();let requested;
  const f=await fixture(t,{beforeClose:()=>finish.resolve(),feishuReader:async input=>{requested=input.urls;started.resolve();await finish.promise;return {status:'ready',sources:[{url:DOC_A,status:'ready',complete:true}],documents:[{url:DOC_A,title:'账号A文档',text:'A独立产品资料',complete:true,sourceUrls:[DOC_A]}]};}});
  ok(await f.request(f.owner,'product',product('通信设备',DOC_A),'PUT'));
  const job=ok(await f.request(f.owner,'feishu/sync',{}));await started.promise;
  ok(await f.request(f.secondary,'product',product('咖啡设备',DOC_B),'PUT'));
  const during=await f.state(f.secondary);assert.deepEqual(during.feishuJobs,[]);assert.deepEqual(during.feishuDocuments,[]);
  finish.resolve();
  const done=await waitFor(async()=>{const s=await f.state(f.owner);return s.feishuJobs.find(item=>item.id===job.id&&item.status==='completed')&&s;},'A Feishu task did not complete in A');
  assert.deepEqual(requested,[DOC_A]);assert.equal(done.feishuDocuments[0].text,'A独立产品资料');
  const b=await f.state(f.secondary);assert.equal(b.product.name,'咖啡设备');assert.deepEqual(b.feishuSync.sourceUrls,[DOC_B]);assert.deepEqual(b.feishuJobs,[]);assert.deepEqual(b.feishuDocuments,[]);
});

test('draft creation defaults to the active workspace and rejects a foreign account or reference',async t=>{
  const f=await fixture(t);
  ok(await f.request(f.secondary,'product',product('咖啡设备',DOC_B),'PUT'));
  const foreign=ok(await f.request(f.owner,'inspirations',{title:'A参考',text:'A参考正文'})).item;
  const draft=ok(await f.request(f.secondary,'drafts',{method:'template',contentMode:'text'}));
  assert.equal(draft.accountId,f.secondary);assert.equal(draft.productVersion,(await f.state(f.secondary)).product.version);
  for(const input of [{accountId:f.owner},{referenceId:foreign.id}]){
    const rejected=await f.request(f.secondary,'drafts',{method:'template',contentMode:'text',...input});
    assert.ok([400,403,404,409].includes(rejected.status),JSON.stringify(rejected));
  }
  assert.ok(!(await f.state(f.owner)).drafts.some(item=>item.id===draft.id));
  assert.equal((await f.request(f.owner,`drafts/${draft.id}/duplicate`,{})).status,404);
  const moved=await f.request(f.secondary,`drafts/${draft.id}`,{...draft,accountId:f.owner},'PUT');
  assert.ok([400,403,409].includes(moved.status),'editing must not move a draft into another workspace by accountId');
});

test('product images and uploaded reference images require ownership in the explicitly selected workspace',async t=>{
  const f=await fixture(t);
  const asset=ok(await f.request(f.owner,'product-assets/upload',{name:'A-product.png',kind:'image',data:PNG}));
  const reference=ok(await f.request(f.owner,'inspirations',{title:'A参考图',files:[{name:'A-reference.png',data:PNG}]})).item;
  const assetPath=`/api/product-assets/${asset.id}/file`,referencePath=reference.assets[0];
  assert.equal((await f.file(f.owner,assetPath)).status,200);assert.equal((await f.file(f.secondary,assetPath)).status,404);
  assert.equal((await f.file(f.owner,assetPath,{query:true})).status,200);assert.equal((await f.file(f.secondary,assetPath,{query:true})).status,404);
  assert.equal((await f.file(f.owner,referencePath,{query:true})).status,200);assert.equal((await f.file(f.secondary,referencePath,{query:true})).status,404);
});

test('scheduled daily reports use each workspace product and contain no other account drafts',async t=>{
  const f=await fixture(t);
  const a=ok(await f.request(f.owner,'product',product('通信设备',DOC_A),'PUT'));
  const b=ok(await f.request(f.secondary,'product',product('咖啡设备',DOC_B),'PUT'));
  const draft=ok(await f.request(f.secondary,'drafts',{method:'template',contentMode:'text'}));
  await f.tick(new Date('2032-04-05T01:30:00.000Z'));
  const reports=await waitFor(async()=>{const [sa,sb]=await Promise.all([f.state(f.owner),f.state(f.secondary)]);const ra=sa.operationReports.find(r=>r.date==='2032-04-05'),rb=sb.operationReports.find(r=>r.date==='2032-04-05');return ra&&rb&&{sa,sb,ra,rb};},'daily reports did not finish for both workspaces');
  assert.equal(reports.ra.accountId,f.owner);assert.equal(reports.rb.accountId,f.secondary);
  assert.equal(reports.ra.productVersion,a.version);assert.equal(reports.rb.productVersion,b.version);
  assert.ok(reports.sa.operationReports.every(r=>r.accountId===f.owner));assert.ok(reports.sb.operationReports.every(r=>r.accountId===f.secondary));
  assert.ok(!JSON.stringify(reports.ra).includes(draft.id),'secondary draft leaked into owner report');
});
