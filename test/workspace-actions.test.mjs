import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bulkDrafts,bulkAssets,rememberDraft,restoreDraftVersion,rescheduleJob,cancelGeneration,cancelDraftImages} from '../app/workspace-actions.mjs';
import {publicOrigin,requestOrigin} from '../app/deployment-origin.mjs';

const draft=()=>({id:'draft',title:'标题',body:'正文',tags:['话题'],slides:[],contentMode:'text',productAssetIds:[],gaps:[],productVersion:'v1',revision:1,approved:true,updatedAt:'2026-10-28T00:00:00Z',history:[]});
const state=()=>({drafts:[draft()],jobs:[],product:{version:'v1'},productAssets:[]});
test('bulk draft actions preserve content, reject active publications and restore soft-deleted drafts',()=>{
  const s=state(),body=s.drafts[0].body;
  bulkDrafts(s,{ids:['draft'],action:'archive'});assert.ok(s.drafts[0].archivedAt);
  bulkDrafts(s,{ids:['draft'],action:'trash'});assert.ok(s.drafts[0].deletedAt);
  bulkDrafts(s,{ids:['draft'],action:'restore'});assert.equal(s.drafts[0].deletedAt,undefined);assert.equal(s.drafts[0].archivedAt,undefined);assert.equal(s.drafts[0].body,body);
  s.jobs.push({draftId:'draft',status:'uncertain'});assert.throws(()=>bulkDrafts(s,{ids:['draft'],action:'trash'}),/发布任务/);
});
test('history combines typing into one undo point and restores the full snapshot with a new revision',()=>{
  const s=state(),d=s.drafts[0];rememberDraft(d,{at:'2026-10-28T00:01:00Z'});d.title='改名';rememberDraft(d,{at:'2026-10-28T00:01:10Z'});d.body='改正文';assert.equal(d.history.length,1);
  const saved=d.history[0];restoreDraftVersion(s,d.id,{revision:1,versionId:saved.id});assert.equal(d.title,'标题');assert.equal(d.body,'正文');assert.deepEqual(d.tags,['话题']);assert.equal(d.revision,2);assert.equal(d.approved,false);assert.equal(d.history[0].body,'改正文');
  assert.throws(()=>restoreDraftVersion(s,d.id,{revision:1,versionId:saved.id}),/草稿已更新/);
});
test('archiving assets retains their identity for existing drafts',()=>{
  const s=state();s.productAssets=[{id:'image',name:'原图',fileName:'kept.png'}];bulkAssets(s,{ids:['image'],action:'archive'});assert.ok(s.productAssets[0].archivedAt);assert.equal(s.productAssets[0].fileName,'kept.png');bulkAssets(s,{ids:['image'],action:'restore'});assert.equal(s.productAssets[0].archivedAt,undefined);
});
test('calendar rescheduling rejects past times, changed content and uncertain submission',()=>{
  const s=state(),date=new Date('2026-10-28T00:00:00Z');s.jobs=[{id:'job',draftId:'draft',draftRevision:1,status:'blocked',attempts:0}];
  const job=rescheduleJob(s,'job',{scheduledAt:'2026-10-29T01:00:00Z'},date);assert.equal(job.status,'scheduled');assert.equal(job.scheduledAt,'2026-10-29T01:00:00.000Z');
  assert.throws(()=>rescheduleJob(s,'job',{scheduledAt:'2026-10-27T00:00:00Z'},date),/未来/);s.drafts[0].revision++;assert.throws(()=>rescheduleJob(s,'job',{scheduledAt:'2026-10-29T00:00:00Z'},date),/草稿已变化/);job.status='uncertain';assert.throws(()=>rescheduleJob(s,'job',{scheduledAt:'2026-10-29T00:00:00Z'},date),/核对发布结果/);
});
test('cancel stops only unfinished work and leaves completed images intact',()=>{
  const s=state();s.draftGenerationJobs=[{id:'copy',status:'running'}];s.imageJobs=[{id:'one',draftId:'draft',batchId:'batch',status:'generating'},{id:'two',draftId:'draft',batchId:'batch',status:'completed',assetId:'kept'}];s.drafts[0].imageGeneration={batchId:'batch',status:'generating'};
  cancelGeneration(s,'copy');cancelDraftImages(s,'draft','batch');assert.equal(s.draftGenerationJobs[0].status,'cancelled');assert.equal(s.imageJobs[0].status,'cancelled');assert.equal(s.imageJobs[1].assetId,'kept');assert.equal(s.imageJobs[1].status,'completed');
});
test('public deployment accepts only the configured HTTPS host while retaining loopback access',()=>{
  const origin=publicOrigin('https://redpilot.example');assert.equal(requestOrigin('redpilot.example',origin),origin);assert.equal(requestOrigin('localhost:4319',origin),'http://localhost:4319');
  for(const url of ['http://redpilot.example','https://user:secret@redpilot.example','https://redpilot.example/path'])assert.throws(()=>publicOrigin(url));
  for(const host of ['evil.example','redpilot.example.evil.test','redpilot.example:9999'])assert.throws(()=>requestOrigin(host,origin));
});
