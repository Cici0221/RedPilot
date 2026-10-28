import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexDocument,productForAI} from '../app/feishu.mjs';
import {rankedTrends,sameTrendEvent,buildReport} from '../app/editorial.mjs';

const folder='https://fixture.feishu.cn/drive/folder/FoldFixtureProduct0000001';
const doc=(index,text)=>({url:'https://fixture.feishu.cn/docx/DocumentFixture'+index,title:'工程文档 '+index,text,complete:true,stale:false,sourceUrls:[folder],readAt:'2026-10-28T01:00:00Z',chunks:indexDocument(text)});
const product={name:'RingHi',summary:'手机与通信',facts:['备用号'],sources:[folder],version:1,restrictions:['不承诺实测结果']};
const account={id:'official',name:'人类补丁',notes:'手机与通信',reportSettings:{timezone:'Asia/Shanghai'}};
const board=(platformId,fetchedAt,title='手机双卡通信',extra={})=>({platformId,boardName:'热榜',status:'ready',stale:false,fetchedAt,items:[{id:platformId,title,rank:2,url:platformId==='weibo'?'https://s.weibo.com/weibo?q=phone':'https://www.baidu.com/s?wd=phone'}],...extra});

test('retrieval includes relevant tail passages while respecting total and per-document budgets including separators',()=>{
  const documents=Array.from({length:4},(_,index)=>doc(index,('背景工程信息'+index+'。').repeat(1800)+'\n\n蓝牙配对流程：长按侧键，指示灯闪烁后连接。'));
  const context=productForAI({product,feishuDocuments:documents},'蓝牙配对流程怎么操作？');
  assert.equal(context.syncedSourceCount,4);
  assert.ok(context.syncedSources.every(source=>source.text.includes('蓝牙配对流程')));
  assert.ok(context.syncedSources.every(source=>source.text.length<=8000&&source.contextTruncated));
  assert.ok(context.syncedSources.reduce((total,source)=>total+source.text.length,0)<=24000);
  assert.deepEqual(context.restrictions,product.restrictions);
  assert.ok(context.syncedSources.every(source=>source.complete===true&&source.stale===false));
});

test('indexed offsets resolve exactly back to source text across blank lines, headings and overlap',()=>{
  const text='  开始说明  \n\n\n# 连接方式\n'+('连接设备。').repeat(500)+'\n## 短信同步\n短信记录。';
  const chunks=indexDocument(text);assert.ok(chunks.length>4);
  for(const chunk of chunks)assert.equal(text.slice(chunk.offset,chunk.offset+chunk.text.length),chunk.text);
  assert.ok(chunks.some(chunk=>chunk.text.includes('短信同步')));
});

test('a partially selected final chunk is still marked truncated even when every chunk index was selected',()=>{
  const document=doc(1,'甲'.repeat(7600));
  const [source]=productForAI({product,feishuDocuments:[document]}).syncedSources;
  assert.equal(source.segments.length,document.chunks.length);assert.equal(source.text.length,8000);assert.equal(source.contextTruncated,true);
});

test('trend freshness follows the requested snapshot time and never treats future or 36-hour-old observations as current',()=>{
  const state={product,trendBoards:[board('baidu','2026-10-26T01:00:00Z')]};
  const sameDay=rankedTrends(state,account,{asOf:'2026-10-26T02:00:00Z'})[0];assert.equal(sameDay.stale,false);assert.equal(sameDay.platformCount,1);
  assert.equal(rankedTrends(state,account,{asOf:'2026-10-28T02:00:00Z'})[0].stale,true);
  assert.equal(rankedTrends(state,account,{asOf:'2026-10-25T02:00:00Z'})[0].stale,true);
  state.trendBoards[0].stale=true;assert.equal(rankedTrends(state,account,{asOf:'2026-10-26T02:00:00Z'})[0].stale,true);
});

test('account brand words alone do not recommend unrelated headlines and dismissed stories stay out',()=>{
  const state={product:{name:'RingHi',summary:'备用号短信同步',facts:[]},trendBoards:[board('baidu','2026-10-28T00:00:00Z','人类知识的未来')]};
  assert.equal(rankedTrends(state,account,{asOf:'2026-10-28T01:00:00Z'})[0].score,0);
  assert.deepEqual(rankedTrends(state,{...account,dismissedTrends:['人类知识的未来']},{asOf:'2026-10-28T01:00:00Z'}),[]);
});

test('related headlines with different quantities are separate events even when one contains the other',()=>{
  assert.equal(sameTrendEvent('某品牌手机销量突破20万台','某品牌手机销量突破20万台，下一目标30万台'),false);
  assert.equal(sameTrendEvent('手机双卡通信怎么选？','手机双卡通信怎么选'),true);
});

test('a report does not borrow the later headline from a future appearance of the same story',()=>{
  const state={product,drafts:[],jobs:[],draftGenerationJobs:[],inspirations:[],topicPool:[],discussions:[],creators:[],operationReports:[],feishuJobs:[],trendBoards:[board('weibo','2026-10-28T02:00:00Z','手机双卡通信怎么选择，今天最新进展'),board('baidu','2026-10-28T00:30:00Z','手机双卡通信怎么选择')]};
  const report=buildReport(state,account,'2026-10-28',{asOf:'2026-10-28T01:00:00Z'}),trend=report.discoveries.find(item=>item.kind==='trend');
  assert.equal(trend.title,'手机双卡通信怎么选择');assert.equal(trend.sources.length,1);assert.equal(trend.sources[0].platformId,'baidu');
});
