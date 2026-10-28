import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';
import { randomBytes } from 'node:crypto';
import { noteKey, dailyKey } from '../app/content.mjs';
const root = path.resolve(import.meta.dirname,'..');
async function fixture(t, env = {}, fetcher) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-test-'));
  const credentials = { email: 'fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory, ...credentials });
  const app = await createApp({ feishuReader: async () => ({ status: 'unavailable', documents: [], sources: [], error: 'test-only offline' }), trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory, env, fetcher });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.equal(login.status, 200, 'fixture login failed');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'fixture session cookie missing');
  const upload = await fetch(base + '/api/product-assets/upload', {
    method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-product.png', kind: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' })
  });
  assert.equal(upload.status, 200, 'fixture product image upload failed');
  await app.store.mutate(s => {
    const image = s.productAssets.find(asset => asset.kind === 'image');
    for (const draft of s.drafts) draft.productAssetIds = [image.id];
  });
  return { ...app, tick:async date=>{await app.tick(date);await app.drainDraftGenerations();}, base, cookie, directory, async request(url, data, method = 'POST', extra = {}) {
    const response = await fetch(base + '/api/' + url, {
      method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...extra },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    return { status: response.status, data: await response.json() };
  } };
}
async function getState(f){return (await f.request('state',undefined,'GET')).data;}
async function approve(f){const d=(await getState(f)).drafts[0];const r=await f.request(`drafts/${d.id}/approve`,{});assert.equal(r.status,200,JSON.stringify(r));return d;}
async function enqueue(f,d){const r=await f.request(`drafts/${d.id}/schedule`,{scheduledAt:new Date(Date.now()+3600000).toISOString()});assert.equal(r.status,200,JSON.stringify(r));await f.store.mutate(s=>{s.jobs[0].scheduledAt=new Date(Date.now()-60000).toISOString();});return r.data;}
const bridgeEnv={REDPILOT_PUBLISH_URL:'https://publisher.example/publish',REDPILOT_PUBLISH_TOKEN:'test-token',REDPILOT_ACCOUNT_ID:'test-account'};
const aiEnv={REDPILOT_AI_KEY:'test-key',REDPILOT_AI_MODEL:'test-vision',REDPILOT_AI_BASE_URL:'https://model.example/v1'};
const noteUrl='https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
const fakeImage={name:'tiny.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='};
test('initial state truthfully declares disconnected integrations and no published jobs',async t=>{const f=await fixture(t);const s=await getState(f);assert.equal(s.capabilities.ai,false);assert.equal(s.capabilities.publisher,false);assert.equal(s.jobs.length,0);assert.equal(s.settings.enabled,false);assert.equal(s.product.name,'SimHelper');assert.ok(s.inspirations[0].assets.length);assert.ok(!(JSON.stringify(s).includes('test-token')));const r=await fetch(f.base+'/',{headers:{Cookie:f.cookie}});assert.equal(r.status,200);assert.match(await r.text(),/RedPilot/);});
test('rejects cross-origin mutations and unapproved hosts',async t=>{const f=await fixture(t);const r=await f.request('drafts',{},'POST',{Origin:'https://evil.example'});assert.equal(r.status,403);const attack=await new Promise(resolve=>{import('node:http').then(({request})=>{const req=request(f.base+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.end();});});assert.equal(attack,403);const invalid=await f.request('inspirations',{title:'x',url:'javascript:alert(1)',files:[]});assert.equal(invalid.status,400);});
test('a URL-only reference is retained and cannot be analyzed as if fetched',async t=>{const f=await fixture(t,aiEnv,()=>{throw Error('must not fetch');});const r=await f.request('inspirations',{title:'收藏',url:'https://www.xiaohongshu.com/explore/6a95c0ff000000002902de44',files:[]});assert.equal(r.status,200);assert.equal(r.data.item.status,'needs_source');const analysis=await f.request(`inspirations/${r.data.item.id}/analyze`,{});assert.equal(analysis.status,409);assert.match(analysis.data.error,/尚未读取网页/);});
test('deduplicates note IDs with differing token parameters and screenshot hashes',async t=>{const f=await fixture(t);const r=await f.request('inspirations',{title:'截图组',url:noteUrl+'?xsec_token=one',files:[fakeImage]});assert.equal(r.status,200);const key=r.data.item.id;assert.equal(r.data.merged,true);const second=await f.request('inspirations',{title:'另一个标题',url:noteUrl+'?xsec_token=two',files:[fakeImage,fakeImage],text:'新正文'});assert.equal(second.data.item.id,key);assert.equal(second.data.item.hashes.length,1);assert.equal(second.data.item.assets.length,1);assert.equal(second.data.item.analysis,null);const r3=await f.request('inspirations',{title:'相同截图',files:[fakeImage]});assert.equal(r3.data.item.id,key);assert.equal((await getState(f)).inspirations.length,2);const img=await fetch(f.base+second.data.item.assets[0],{headers:{Cookie:f.cookie}});assert.equal(img.headers.get('content-type'),'image/png');});
test('invalid image signatures and upload groups are rejected without creating records',async t=>{const f=await fixture(t);for(const files of [[{name:'evil.png',data:Buffer.from('<svg onload="alert(1)">').toString('base64')}],Array(7).fill(fakeImage)]){const r=await f.request('inspirations',{title:'bad',files});assert.equal(r.status,400);}assert.equal((await getState(f)).inspirations.length,2);});
test('template creation, editing and version history persist across store reopening',async t=>{const f=await fixture(t);const r=await f.request('drafts',{method:'template',instruction:'写一个开会场景'});assert.equal(r.status,200);assert.equal(r.data.method,'template');assert.match(r.data.adaptation,/尚未用 AI/);const updated={...r.data,title:'今天的通信小麻烦'};const saved=await f.request(`drafts/${r.data.id}`,updated,'PUT');assert.equal(saved.data.history.length,1);assert.equal(saved.data.revision,2);const disk=JSON.parse(await readFile(path.join(f.directory,'state.json')));assert.equal(disk.accountWorkspaces[disk.defaultAccountId].drafts[0].title,updated.title);const {createStore}=await import('../app/store.mjs');await f.store.close();const reopened=await createStore(root,f.directory);assert.equal(reopened.state.drafts[0].history[0].title,r.data.title);await reopened.close();});
test('changed product facts invalidate approvals and block existing schedules',async t=>{const f=await fixture(t,bridgeEnv,()=>{throw Error('must not publish');});const d=await approve(f);await enqueue(f,d);const s=await getState(f);const changed=await f.request('product',{...s.product,summary:'更新后的产品说明'},'PUT');assert.equal(changed.status,200);assert.equal((await getState(f)).drafts[0].approved,false);await f.tick();const state=await getState(f);assert.equal(state.jobs[0].status,'blocked');assert.match(state.jobs[0].error,/产品资料已更新/);});
test('parallel scheduling produces a single task and locks scheduled drafts',async t=>{const f=await fixture(t);const d=await approve(f);const at=new Date(Date.now()+3600000).toISOString();const rs=await Promise.all([f.request(`drafts/${d.id}/schedule`,{scheduledAt:at}),f.request(`drafts/${d.id}/schedule`,{scheduledAt:at})]);assert.deepEqual(rs.map(x=>x.status).sort(),[200,409]);assert.equal((await getState(f)).jobs.length,1);const edited=await f.request(`drafts/${d.id}`,d,'PUT');assert.equal(edited.status,409);});
test('missing publisher blocks rather than marking a scheduled post as published',async t=>{const f=await fixture(t);const d=await approve(f);await enqueue(f,d);await f.tick();const s=await getState(f);assert.equal(s.jobs[0].status,'blocked');assert.equal(s.jobs[0].attempts,0);assert.match(s.jobs[0].error,/没有进行真实发布/);const retry=await f.request(`jobs/${s.jobs[0].id}/retry`,{});assert.equal(retry.status,200);});
test('an ambiguous publishing response never automatically resubmits the note',async t=>{let calls=0;const f=await fixture(t,bridgeEnv,async()=>{calls++;throw Error('network');});const d=await approve(f);await enqueue(f,d);await f.tick();await f.tick();const j=(await getState(f)).jobs[0];assert.equal(j.status,'uncertain');assert.equal(calls,1);const retry=await f.request(`jobs/${j.id}/retry`,{});assert.equal(retry.status,409);const cancel=await f.request(`jobs/${j.id}/cancel`,{});assert.equal(cancel.status,409);});
test('only verified XHS note links complete a publish, using persistent idempotency',async t=>{const actions=[];const f=await fixture(t,bridgeEnv,async(url,req)=>{const payload=JSON.parse(req.body);actions.push({payload,key:req.headers['Idempotency-Key']});return new Response(JSON.stringify(actions.length===1?{status:'pending'}:{status:'published',verified:true,noteUrl,accountId:payload.accountId}),{status:200});});const d=await approve(f);await enqueue(f,d);await f.tick();let j=(await getState(f)).jobs[0];assert.equal(j.status,'uncertain');const verified=await f.request(`jobs/${j.id}/verify`,{});assert.equal(verified.data.status,'published');assert.equal(actions[0].key,actions[1].key);assert.equal(actions[1].payload.action,'verify');assert.equal(actions[0].payload.post.slides.length,0);assert.equal((await getState(f)).drafts[0].status,'published');});
test('rejects unverified or foreign result links',async t=>{const f=await fixture(t,bridgeEnv,async()=>new Response(JSON.stringify({status:'published',verified:true,noteUrl:'https://evil.example/explore/abc'})));const d=await approve(f);await enqueue(f,d);await f.tick();assert.equal((await getState(f)).jobs[0].status,'uncertain');});
test('daily generation runs once per configured local day, respects review mode',async t=>{let calls=0;const f=await fixture(t,aiEnv,async(url,req)=>{calls++;const payload=JSON.parse(req.body);assert.equal(payload.store,false);assert.ok(payload.messages[1].content.some(x=>x.type==='image_url'));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'备用号，先聊聊你的需求',body:'SimHelper 正在开发内测。SIM 必须移入设备，设备连接 Wi-Fi，手机需互联网。你最想先测试什么？',tags:['产品开发'],series:'一起打磨',slides:[{headline:'你的备用号在忙什么？',body:'需求征集，开发内测'}],gaps:[],adaptation:'学习问题先行'})}}]}));});await f.request('settings',{enabled:true,mode:'review',time:'10:00',timezone:'Asia/Shanghai'},'PUT');await f.tick(new Date('2026-10-25T02:01:00Z'));await f.tick(new Date('2026-10-25T03:00:00Z'));const s=await getState(f);assert.equal(calls,1);assert.equal(s.drafts.length,2);assert.equal(s.jobs.length,0);assert.equal(s.lastDailyKey,'2026-10-25');assert.equal(s.drafts[0].method,'ai');});
test('AI analysis validates structured output and does not expose secret config',async t=>{const f=await fixture(t,aiEnv,async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({topic:'问题先行',titlePattern:'生活问句',visual:'深色大字',structure:['从问题到方案'],adaptation:'用自有产品图解',observations:['截图1的大字封面'],inferences:[],unknown:['完整正文']})}}]})));const s=await getState(f);const result=await f.request(`inspirations/${s.inspirations[0].id}/analyze`,{});assert.equal(result.status,200);assert.equal(result.data.method,'ai');assert.deepEqual(result.data.analysis.unknown,['完整正文']);assert.ok(!JSON.stringify(await getState(f)).includes('test-key'));});
test('invalid settings cannot enable automation and DST uses IANA timezones',async t=>{const f=await fixture(t);const bad=await f.request('settings',{enabled:true,time:'25:70',mode:'automatic',timezone:'moon'} ,'PUT');assert.equal(bad.status,400);assert.equal((await getState(f)).settings.enabled,false);assert.equal(dailyKey(new Date('2026-10-25T01:00:00Z'),'America/Chicago'),'2026-10-24');assert.equal(noteKey(noteUrl+'?xsec_token=abc'),noteKey(noteUrl));});

test('draft gaps require explicit publication review and invalid review inputs leave no approval or job',async t=>{
  const f=await fixture(t),gap='核对当前设备与手机的联网条件';
  await f.store.mutate(s=>{s.drafts[0].gaps=[gap];});
  const d=(await getState(f)).drafts[0],route=`drafts/${d.id}/schedule`,scheduledAt=new Date(Date.now()+3600000).toISOString();
  const approval=await f.request(`drafts/${d.id}/approve`,{});
  assert.equal(approval.status,409);assert.match(approval.data.error,/联网条件/);
  const unreviewed=await f.request(route,{scheduledAt,confirm:true,revision:d.revision});
  assert.equal(unreviewed.status,409);assert.match(unreviewed.data.error,/联网条件/);
  for(const input of [{confirm:false,reviewGaps:true},{reviewGaps:true},{confirm:true,reviewGaps:'true'},{confirm:true,reviewGaps:1},{confirm:true,reviewGaps:null}]){
    const result=await f.request(route,{scheduledAt,revision:d.revision,...input});
    assert.equal(result.status,400,JSON.stringify(result.data));
  }
  const state=await getState(f),saved=state.drafts.find(item=>item.id===d.id);
  assert.deepEqual(saved.gaps,[gap]);assert.equal(saved.gapReview,undefined);assert.notEqual(saved.approved,true);assert.equal(state.jobs.length,0);
});

test('publication review preserves original gaps, persists its exact version, and is not inherited by a duplicate',async t=>{
  const f=await fixture(t),gaps=['核对工程内测阶段','核对联网条件'];
  await f.store.mutate(s=>{s.drafts[0].gaps=gaps;});
  const initial=await getState(f),d=initial.drafts[0],scheduledAt=new Date(Date.now()+3600000).toISOString();
  const scheduled=await f.request(`drafts/${d.id}/schedule`,{scheduledAt,confirm:true,reviewGaps:true,revision:d.revision});
  assert.equal(scheduled.status,200,JSON.stringify(scheduled.data));
  const current=await getState(f),saved=current.drafts.find(item=>item.id===d.id);
  assert.deepEqual(saved.gaps,gaps);assert.equal(saved.gapReview.draftRevision,d.revision);assert.equal(saved.gapReview.productVersion,initial.product.version);
  assert.deepEqual(saved.gapReview.gaps,gaps);assert.ok(Number.isFinite(Date.parse(saved.gapReview.reviewedAt)));assert.equal(saved.approved,true);
  assert.deepEqual(current.draftChecks[d.id],[]);
  const copy=await f.request(`drafts/${d.id}/duplicate`,{});
  assert.equal(copy.status,200);assert.equal(copy.data.gapReview,undefined);assert.deepEqual(copy.data.gaps,gaps);assert.equal(copy.data.approved,false);
  const stateWithCopy=await getState(f);assert.ok(stateWithCopy.draftChecks[copy.data.id].includes(gaps[0]));
  const disk=JSON.parse(await readFile(path.join(f.directory,'state.json'),'utf8'));
  assert.deepEqual(disk.accountWorkspaces[disk.defaultAccountId].drafts.find(item=>item.id===d.id).gapReview,saved.gapReview);
  const {createStore}=await import('../app/store.mjs');await f.store.close();const reopened=await createStore(root,f.directory);
  assert.deepEqual(reopened.state.drafts.find(item=>item.id===d.id).gapReview,saved.gapReview);await reopened.close();
});

test('draft edits, image changes, product changes, and changed gap text invalidate earlier publication review',async t=>{
  for(const change of ['body','image','product','gap'])await t.test(change,async t=>{
    const f=await fixture(t),gap='核对当前产品条件';
    await f.store.mutate(s=>{s.drafts[0].gaps=[gap];});
    let state=await getState(f),d=state.drafts[0];
    const route=`drafts/${d.id}/schedule`,input={scheduledAt:new Date(Date.now()+3600000).toISOString(),confirm:true,reviewGaps:true,revision:d.revision};
    const job=await f.request(route,input);assert.equal(job.status,200,JSON.stringify(job.data));
    assert.equal((await f.request(`jobs/${job.data.id}/cancel`,{})).status,200);
    state=await getState(f);d=state.drafts.find(item=>item.id===d.id);
    if(change==='product'){
      assert.equal((await f.request('product',{...state.product,summary:state.product.summary+' 最新核对资料'},'PUT')).status,200);
    }else if(change==='gap'){
      await f.store.mutate(s=>{s.drafts.find(item=>item.id===d.id).gaps=['新的待核对条件'];});
    }else {
      const updated={...d,...(change==='body'?{body:d.body+' 使用前核对网络。'}:{productAssetIds:[]})};
      const edit=await f.request(`drafts/${d.id}`,updated,'PUT');assert.equal(edit.status,200,JSON.stringify(edit.data));
    }
    const changed=await getState(f),current=changed.drafts.find(item=>item.id===d.id);
    assert.ok(changed.draftChecks[d.id].some(issue=>issue===gap||issue==='新的待核对条件'));
    const stale=await f.request(route,{...input,revision:current.revision,reviewGaps:false});assert.equal(stale.status,409);
    const finalState=await getState(f);assert.equal(finalState.jobs.filter(item=>item.status==='scheduled').length,0);
  });
});

test('stale review and factual publishing failures roll back review records and owner approval together',async t=>{
  const f=await fixture(t),gap='核对产品资料';
  await f.store.mutate(s=>{s.drafts[0].gaps=[gap];});
  const initial=await getState(f),d=initial.drafts[0],route=`drafts/${d.id}/schedule`,scheduledAt=new Date(Date.now()+3600000).toISOString();
  const saved=await f.request(`drafts/${d.id}`,{...d,title:'这是一个超过二十个字的测试标题需要精简后才能发布'},'PUT');assert.equal(saved.status,200);
  const stale=await f.request(route,{scheduledAt,confirm:true,reviewGaps:true,revision:d.revision});assert.equal(stale.status,409);
  const invalid=await f.request(route,{scheduledAt,confirm:true,reviewGaps:true,revision:saved.data.revision});
  assert.equal(invalid.status,409);assert.match(invalid.data.error,/标题超过 20 字/);
  const state=await getState(f),current=state.drafts.find(item=>item.id===d.id);
  assert.equal(current.gapReview,undefined);assert.equal(current.approved,false);assert.deepEqual(current.gaps,[gap]);assert.equal(state.jobs.length,0);
  const noAck=await f.request(`drafts/${d.id}/approve`,{});assert.equal(noAck.status,409);assert.match(noAck.data.error,/核对产品资料/);
});
