import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const anchors=html=>[...html.matchAll(/<a\b([^>]*)>/g)].map(([,attrs])=>Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,decode(value)])));
const officialSource='https://creator.xiaohongshu.com/new/inspiration';
const snapshot='2026-10-26T01:00:00Z';
function ui(){
  const context=vm.createContext({URL,URLSearchParams,Intl,Date,Math,structuredClone,AbortSignal,setTimeout,clearTimeout,console,
    document:{querySelector:()=>null,querySelectorAll:()=>[]},location:{hash:''},window:{scrollTo(){}}});
  vm.runInContext(definitions,context);
  vm.runInContext("S={accounts:[{id:'official',name:'官方',enabled:true,archived:false}],defaultAccountId:'official',inspirations:[],topicPool:[],trendBoards:[],trendMatches:{official:[]}};",context);
  return {context,run:code=>vm.runInContext(code,context)};
}
function topicBoard(title='趣味知识科普'){
  return {platformId:'xiaohongshu',name:'小红书',kind:'topics',boardName:'经典话题',sourceUrl:officialSource,status:'partial',stale:false,fetchedAt:snapshot,
    items:[{id:'xhs-topic',title,url:'https://www.xiaohongshu.com/search_result?keyword='+encodeURIComponent(title),heatText:'25.4万人参与 · 63亿次浏览'}]};
}
function setBoard(view,board){view.context.board=board;view.run('S.trendBoards=[board]');}
function assertSearch(link,keyword){
  const url=new URL(link.href);assert.equal(url.origin,'https://www.xiaohongshu.com');assert.equal(url.pathname,'/search_result');
  assert.equal(url.searchParams.get('keyword'),keyword);assert.deepEqual([...url.searchParams.keys()],['keyword']);assert.equal(url.hash,'');
  assert.equal(link.target,'_blank');assert.ok(link.rel.split(/\s+/).includes('noopener'));assert.ok(link.rel.split(/\s+/).includes('noreferrer'));
}

test('classic topic card shows actual statistics and actions without invented rank or unavailable banner',()=>{
  const view=ui();setBoard(view,topicBoard());const html=view.run('trendBoardMarkup(board,0)');
  assert.match(html,/经典话题/);assert.match(html,/25\.4万人参与 · 63亿次浏览/);assert.match(html,/已读取/);
  assert.match(html,/data-action="operation-topic"/);assert.match(html,/data-action="operation-create"/);
  assert.doesNotMatch(html,/class="trend-rank"|网页未提供|暂无榜单|暂无话题|trend-board-error/);
  assert.equal(anchors(html).find(link=>link.href===officialSource)?.target,'_blank');
});

test('topic title searches the exact escaped keyword in a new tab while keeping the official source link',()=>{
  const view=ui(),keyword='手机 AI + 电池? # & / 中文 % <img src=x> 😀';setBoard(view,topicBoard(keyword));
  const html=view.run('trendBoardMarkup(board,0)'),links=anchors(html),titleLink=links.find(link=>link.class==='trend-item-title');
  assertSearch(titleLink,keyword);assert.doesNotMatch(html,/<img src=x>/);assert.ok(links.some(link=>link.href===officialSource));
  assert.equal(view.context.board.sourceUrl,officialSource);
});

test('collection and creation receive an unranked topic source even if a legacy item contains rank',()=>{
  const view=ui(),board=topicBoard();board.items[0].rank=1;setBoard(view,board);
  const subject=view.run("operationSubject('board','xhs-topic')"),source=subject.sources[0];
  assert.equal(source.kind,'topics');assert.equal(source.platformId,'xiaohongshu');assert.equal(source.boardName,'经典话题');
  assert.equal(source.url,board.items[0].url);assert.equal(source.fetchedAt,snapshot);assert.equal(Object.hasOwn(source,'rank'),false);
  view.context.topicSource=source;
  const references=view.run('operationSources([topicSource])');assert.match(references,/经典话题/);assert.doesNotMatch(references,/#1|#undefined|#null/);
  assert.equal(anchors(references)[0].href,source.url);
});

test('source chips distinguish classic topics from real board positions without null ranks',()=>{
  const view=ui();view.context.item={title:'知识主题',appearances:[{platformId:'xiaohongshu',kind:'topics',rank:null,fetchedAt:snapshot},{platformId:'zhihu',rank:7,fetchedAt:snapshot}]};
  const html=view.run('trendAppearanceChips(item)');assert.match(html,/小红书 · 经典话题/);assert.match(html,/知乎 #7/);
  assert.doesNotMatch(html,/#null|#undefined|#0/);assertSearch(anchors(html)[0],'知识主题');
});

test('account matching includes topics, while global heat view keeps only genuine ranked sources',()=>{
  const view=ui();view.context.matches=[
    {id:'classic',title:'经典知识主题',score:9,appearances:[{platformId:'xiaohongshu',kind:'topics'}]},
    {id:'ranked',title:'真实热搜主题',score:5,appearances:[{platformId:'weibo',rank:3}]},
    {id:'mixed',title:'同时上榜主题',score:4,appearances:[{platformId:'xiaohongshu',kind:'topics'},{platformId:'zhihu',rank:6}]}
  ];
  view.run("S.trendMatches.official=matches;trendOrder='match'");let html=view.run('trendMatchMarkup()');assert.match(html,/经典知识主题/);assert.match(html,/真实热搜主题/);
  view.run("trendOrder='heat'");html=view.run('trendMatchMarkup()');assert.doesNotMatch(html,/经典知识主题/);assert.match(html,/真实热搜主题/);assert.match(html,/同时上榜主题/);
  assert.equal(view.run('trendPlatformCount(matches[0])'),0);assert.equal(view.run('trendBestRank(matches[0])'),Infinity);
});

test('failed refresh retains classic topic content and original snapshot time, clearly marked stale',()=>{
  const view=ui(),board={...topicBoard(),status:'needs_login',reasonCode:'needs_login',stale:true,error:'请登录后刷新'};setBoard(view,board);
  const html=view.run('trendBoardMarkup(board,0)');assert.match(html,/趣味知识科普/);assert.match(html,/经典话题/);assert.match(html,/旧快照/);assert.match(html,/10\/26 09:00/);assert.match(html,/需登录/);
  assert.doesNotMatch(html,/class="trend-rank"|网页未提供/);assert.equal(view.run('trendBoardAvailable(board)'),false);
  const source=view.run("operationSubject('board','xhs-topic').sources[0]");assert.equal(source.kind,'topics');assert.equal(source.stale,true);assert.equal(source.fetchedAt,snapshot);
});

test('login and verification links target the failed page without changing cached topic provenance',()=>{
  const view=ui(),attemptedSourceUrl='https://www.xiaohongshu.com/explore';
  for(const [status,label] of [['needs_login','打开来源登录'],['blocked','打开来源验证'],['unavailable','来源 ↗']]){
    setBoard(view,{...topicBoard(),status,stale:true,attemptedSourceUrl});
    const html=view.run('trendBoardMarkup(board,0)'),footer=html.match(/<div class="trend-board-footer">([\s\S]*?)<\/div>/)[1];
    assert.match(footer,new RegExp(label));assert.equal(anchors(footer)[0].href,status==='unavailable'?officialSource:attemptedSourceUrl);
    assert.equal(view.context.board.sourceUrl,officialSource);assert.match(html,/经典话题/);assert.match(html,/趣味知识科普/);
    const provenance=view.run("operationSubject('board','xhs-topic').sources[0]");
    assert.equal(provenance.url,view.context.board.items[0].url);assert.equal(provenance.fetchedAt,snapshot);assert.equal(provenance.kind,'topics');
  }
});

test('empty topics use the topic empty state and ranked boards retain their official position',()=>{
  const view=ui();setBoard(view,{...topicBoard(),status:'unavailable',items:[]});let html=view.run('trendBoardMarkup(board,0)');
  assert.match(html,/暂无话题/);assert.doesNotMatch(html,/暂无榜单条目/);
  setBoard(view,{platformId:'weibo',name:'微博',boardName:'微博热搜',status:'ready',sourceUrl:'https://s.weibo.com/top/summary',fetchedAt:snapshot,items:[{id:'ranked',title:'真实排名',rank:12,url:'https://s.weibo.com/weibo?q=test'}]});
  html=view.run('trendBoardMarkup(board,0)');assert.match(html,/<span class="trend-rank">12<\/span>/);
  assert.equal(view.run("operationSubject('board','ranked').sources[0].rank"),12);
});
