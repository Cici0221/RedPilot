import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReport} from '../app/editorial.mjs';

const day='2026-10-26',asOf=day+'T01:00:00.000Z',createdAt=day+'T00:00:00.000Z';
function fixture(timezone='Asia/Shanghai') {
  const account={id:'own',name:'通信官方号',notes:'手机备用号与通信',reportSettings:{timezone}};
  const state={product:{name:'RingHi',summary:'手机通信设备',facts:['备用号'],version:'v1',stage:'内测',sources:[]},productAssets:[],drafts:[],jobs:[],draftGenerationJobs:[],inspirations:[],topicPool:[],discussions:[],creators:[],trendBoards:[],operationReports:[],feishuJobs:[]};
  return {state,account,build:()=>buildReport(state,account,day,{asOf})};
}
function draft(id,extra={}) {return {id,accountId:'own',title:'通信场景',body:'当前为内测。',contentMode:'text',productVersion:'v1',status:'draft',approved:false,referenceIds:[],createdAt,...extra};}
function metric(report,key) {return report.metrics.find(item=>item.key===key)?.value;}

test('morning report counts later schedules and only account records already present at its cutoff',()=>{
  const {state,build}=fixture();state.drafts.push(draft('review'),draft('foreign',{accountId:'other'}),draft('not-yet-created',{createdAt:day+'T02:00:00.000Z'}));
  state.jobs.push(
    {id:'evening',accountId:'own',draftId:'review',status:'scheduled',scheduledAt:day+'T11:30:00.000Z',createdAt},
    {id:'published',accountId:'own',status:'published',scheduledAt:day+'T00:30:00.000Z',publishedAt:day+'T00:35:00.000Z',noteUrl:'https://www.xiaohongshu.com/explore/000000000000000000000001',createdAt},
    {id:'failed',accountId:'own',draftId:'review',status:'failed',createdAt},
    {id:'cancelled',accountId:'own',status:'cancelled',scheduledAt:day+'T10:00:00.000Z',createdAt},
    {id:'foreign-job',accountId:'other',status:'failed',createdAt},
    {id:'future-record',accountId:'own',status:'failed',createdAt:day+'T02:00:00.000Z'}
  );
  const report=build();assert.equal(metric(report,'scheduled_today'),2);assert.equal(metric(report,'published_today'),1);assert.equal(metric(report,'pending_review'),1);assert.equal(metric(report,'publishing_issues'),1);
  const evening=report.plans.find(plan=>plan.jobId==='evening');assert.match(evening.detail,/19:30/);assert.equal(evening.action.id,'evening');assert.equal(evening.action.route,'#queue');
  assert.equal(report.plans[0].priority,'high');assert.equal(report.plans[0].action.id,'failed');assert.ok(report.plans[0].blockers.length);
  assert.doesNotMatch(JSON.stringify(report),/foreign-job|future-record|not-yet-created/);assert.equal(report.snapshot.draftCount,1);assert.equal(report.snapshot.jobCount,4);
});

test('only the latest identical generation attempt remains actionable and unsafe raw errors never appear',()=>{
  const {state,build}=fixture();state.draftGenerationJobs.push(
    {id:'old-failure',accountId:'own',requestFingerprint:'retried',status:'failed',createdAt},
    {id:'new-success',accountId:'own',requestFingerprint:'retried',status:'completed',createdAt:day+'T00:10:00.000Z'},
    {id:'timeout',accountId:'own',status:'failed',reasonCode:'ai_timeout',error:'private provider response /secret sk-fake',createdAt},
    {id:'other-failure',accountId:'other',status:'failed',createdAt}
  );
  const report=build();assert.equal(metric(report,'generation_issues'),1);assert.equal(report.plans.find(plan=>plan.kind==='generation').action.id,'timeout');assert.match(report.plans[0].blockers[0],/超时/);assert.doesNotMatch(JSON.stringify(report),/private provider|sk-fake|old-failure|other-failure/);
});

test('new references and creator findings require account ownership, existing use or an explicit direction match',()=>{
  const {state,build}=fixture();state.creators.push({id:'creator',name:'真实博主',createdAt});
  state.inspirations.push(
    {id:'phone',title:'手机备用号',text:'真实参考正文',createdAt,creatorIds:['creator']},
    {id:'used',title:'一条已使用的参考',text:'正文',createdAt},
    {id:'irrelevant',title:'拿铁拉花',text:'咖啡',createdAt},
    {id:'foreign',accountId:'other',title:'手机备用号',text:'他人账号参考',createdAt},
    {id:'future',title:'手机',createdAt:day+'T02:00:00.000Z'}
  );state.drafts.push(draft('existing',{referenceIds:['used']}));
  const report=build();assert.equal(metric(report,'new_references'),2);assert.deepEqual(report.discoveries.map(item=>item.referenceId).sort(),['phone','used']);
  const creator=report.discoveries.find(item=>item.referenceId==='phone');assert.equal(creator.kind,'creator');assert.equal(creator.creatorId,'creator');assert.equal(creator.action.route,'#reference/phone');assert.equal(creator.sources[0].url,'#reference/phone');
  assert.equal(report.snapshot.referenceCount,2);assert.doesNotMatch(JSON.stringify(report),/拿铁拉花|他人账号参考/);
});

test('a matching hot topic keeps only source positions actually observed before this local-day cutoff',()=>{
  const {state,build}=fixture();const item={title:'手机双卡通信',rank:7,url:'https://www.baidu.com/s?wd=phone'};
  state.trendBoards.push(
    {platformId:'baidu',status:'ready',boardName:'热搜榜',stale:false,fetchedAt:day+'T00:30:00.000Z',items:[{...item,id:'real'}]},
    {platformId:'weibo',status:'ready',boardName:'热搜榜',stale:false,fetchedAt:day+'T02:00:00.000Z',items:[{...item,id:'future',rank:1,url:'https://s.weibo.com/weibo?q=phone'}]},
    {platformId:'zhihu',status:'unavailable',stale:true,fetchedAt:'2026-10-25T01:00:00.000Z',items:[{...item,id:'stale',url:'https://www.zhihu.com/question/12345'}]}
  );
  const report=build(),hot=report.discoveries.find(item=>item.kind==='trend');assert.ok(hot);assert.deepEqual(hot.sources.map(source=>[source.platformId,source.rank,source.url]),[['baidu',7,item.url]]);assert.equal(report.snapshot.readableBoardCount,1);assert.match(hot.scoreMethod,/规则/);
});

test('regenerating today preserves completed item IDs even after their original blocker is resolved',()=>{
  const {state,build}=fixture();state.jobs.push({id:'failed',accountId:'own',status:'failed',createdAt});
  const first=build(),item=first.plans.find(plan=>plan.jobId==='failed');item.done=true;state.operationReports.push(first);state.jobs[0].status='cancelled';
  const next=build(),retained=next.plans.find(plan=>plan.id===item.id);assert.equal(next.id,first.id);assert.equal(retained.done,true);assert.equal(retained.retained,true);assert.equal(metric(next,'publishing_issues'),0);
});

test('historical reports never reconstruct mutable backlog or future discoveries without a saved snapshot',()=>{
  const {state,account}=fixture();state.drafts.push(draft('today'));state.inspirations.push({id:'today-ref',title:'手机',createdAt});
  const historical=buildReport(state,account,'2026-10-25',{asOf});assert.deepEqual(historical.metrics,[]);assert.deepEqual(historical.plans,[]);assert.deepEqual(historical.discoveries,[]);assert.equal(historical.snapshot.mode,'historical');assert.match(historical.issues[0],/无法.*还原/);
  historical.plans=[{id:'prior-plan',key:'prior',done:true,title:'历史待办',sources:[]}];state.operationReports.push(structuredClone(historical));assert.deepEqual(buildReport(state,account,'2026-10-25',{asOf}),historical);
  const future=buildReport(state,account,'2026-10-27',{asOf});assert.equal(future.snapshot.mode,'future');assert.deepEqual(future.metrics,[]);assert.deepEqual(future.discoveries,[]);
});

test('report day and scheduled times use the account timezone rather than UTC',()=>{
  const {state,account}=fixture('America/New_York');const cutoff='2026-10-26T03:30:00.000Z';
  state.jobs.push({id:'tonight',accountId:'own',status:'scheduled',scheduledAt:'2026-10-26T03:45:00.000Z',createdAt:'2026-10-26T01:00:00.000Z'});
  const report=buildReport(state,account,'2026-10-25',{asOf:cutoff});assert.equal(report.snapshot.mode,'live');assert.equal(report.timezone,'America/New_York');assert.equal(metric(report,'scheduled_today'),1);assert.equal(report.snapshot.asOf,cutoff);
});

test('failed shared product sync gives an actionable fixed blocker with only real document counts',()=>{
  const {state,build}=fixture();state.feishuSync={status:'partial',lastAttemptAt:createdAt};state.feishuJobs=[{id:'sync',createdAt,completedAt:createdAt,documentCount:3}];
  const report=build(),plan=report.plans.find(item=>item.kind==='sync');assert.equal(plan.priority,'high');assert.equal(plan.action.route,'#product');assert.match(plan.detail,/3 份文档/);assert.ok(plan.blockers.length);assert.equal(report.method,'verified-data-rules');
});
