import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBoards,rankedTrends,editorialSources,addTopic} from '../app/editorial.mjs';

const sourceUrl='https://creator.xiaohongshu.com/new/inspiration';
const fetchedAt='2026-10-26T09:00:00.000Z';
const account={id:'official',name:'数码手机',notes:'手机通信、出境旅行'};
const topic=(title='手机通信技巧',extra={})=>({title,url:'https://www.xiaohongshu.com/search_result?keyword='+encodeURIComponent(title),heatText:'35.4万人参与 · 16.5亿次浏览',...extra});
const board=(extra={})=>({platformId:'xiaohongshu',kind:'topics',sourceUrl,status:'partial',fetchedAt,boardName:'注入错误榜名',items:[topic()],...extra});
const xhs=boards=>boards.find(item=>item.platformId==='xiaohongshu');
const state=(boards=normalizeBoards([board()]))=>({trendBoards:boards,product:{name:'手机通信设备',summary:'通信与旅行',facts:['备用号码'],sources:[]},topicPool:[],inspirations:[],drafts:[]});

test('verified classic topics retain official text and order without accepting invented ranks',()=>{
  const first=topic('高颜值巧克力',{rank:99}),second=topic('手机通信技巧',{rank:1});
  const result=xhs(normalizeBoards([board({items:[first,second,first]})]));
  assert.equal(result.kind,'topics');assert.equal(result.boardName,'经典话题');assert.equal(result.sourceUrl,sourceUrl);
  assert.equal(result.fetchedAt,fetchedAt);assert.equal(result.stale,false);assert.equal(result.status,'partial');
  assert.deepEqual(result.items.map(item=>item.title),[first.title,second.title]);
  assert.ok(result.items.every(item=>!Object.hasOwn(item,'rank')));
  assert.equal(result.items[0].heatText,first.heatText);assert.equal(result.items[0].url,first.url);
});

test('only the exact Xiaohongshu creator source can declare unranked topics',()=>{
  const invalid=[
    board({platformId:'weibo',sourceUrl:'https://s.weibo.com/top/summary',items:[{title:'伪话题',url:'https://s.weibo.com/weibo?q=test'}]}),
    board({sourceUrl:'https://www.xiaohongshu.com/explore'}),
    board({sourceUrl:sourceUrl+'?ranked=true'}),
    board({sourceUrl:sourceUrl+'#hot'}),
    board({sourceUrl:'https://creator.xiaohongshu.com.evil.example/new/inspiration'}),
    board({sourceUrl:'http://creator.xiaohongshu.com/new/inspiration'}),
    board({sourceUrl:'https://creator.xiaohongshu.com:8443/new/inspiration'})
  ];
  for(const input of invalid){
    const result=normalizeBoards([input]).find(item=>item.platformId===input.platformId);
    assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'invalid_source');assert.deepEqual(result.items,[]);
  }
});

test('topics cannot masquerade as a ranked creator board, and ordinary boards still require valid ranks',()=>{
  const disguised=board({items:[topic('伪排名',{rank:1})]});delete disguised.kind;
  const result=xhs(normalizeBoards([disguised]));
  assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'invalid_source');
  const ordinary={platformId:'xiaohongshu',sourceUrl:'https://www.xiaohongshu.com/explore',status:'partial',items:[topic('缺排名'),topic('零排名',{rank:0}),topic('空排名',{rank:null}),topic('有效排名',{rank:7})]};
  const actual=xhs(normalizeBoards([ordinary]));
  assert.deepEqual(actual.items.map(item=>[item.title,item.rank]),[['有效排名',7]]);assert.equal(actual.kind,undefined);
});

test('topic entries reject foreign destinations and bound the accepted window',()=>{
  const input=[topic('恶意外链',{url:'https://evil.example/'}),...Array.from({length:40},(_,index)=>topic('真实话题'+index))];
  const result=xhs(normalizeBoards([board({items:input})]));
  assert.equal(result.items.length,30);assert.equal(result.items[0].title,'真实话题0');assert.equal(result.items.at(-1).title,'真实话题29');
  assert.equal(result.status,'partial');
});

test('failed, empty and invalid topic refreshes keep the source identity and original timestamp of the snapshot',()=>{
  const previous=normalizeBoards([board({scope:'官方经典话题；无榜单排名'})]),before=xhs(previous);
  for(const raw of [[],[board({status:'needs_login',reasonCode:'needs_login',items:[]})],[board({items:[]})],[board({sourceUrl:'https://evil.example/'})]]){
    const result=xhs(normalizeBoards(raw,previous));
    assert.equal(result.kind,'topics');assert.equal(result.boardName,'经典话题');assert.equal(result.sourceUrl,sourceUrl);
    assert.equal(result.scope,before.scope);assert.equal(result.fetchedAt,before.fetchedAt);assert.equal(result.stale,true);assert.deepEqual(result.items,before.items);
  }
  const rankedPrevious=normalizeBoards([{platformId:'xiaohongshu',boardName:'真实搜索榜',sourceUrl:'https://www.xiaohongshu.com/explore',status:'partial',items:[topic('有排名',{rank:9})]}]);
  const ranked=xhs(normalizeBoards([board({items:[]})],rankedPrevious));
  assert.equal(ranked.boardName,'真实搜索榜');assert.equal(ranked.kind,undefined);assert.equal(ranked.items[0].rank,9);
});

test('a topic reader failure without a saved snapshot keeps the attempted topic source identity',()=>{
  for(const previous of [[],normalizeBoards([])]){
    const result=xhs(normalizeBoards([board({status:'needs_login',reasonCode:'needs_login',items:[]})],previous));
    assert.equal(result.kind,'topics');assert.equal(result.boardName,'经典话题');assert.equal(result.sourceUrl,sourceUrl);
    assert.equal(result.status,'needs_login');assert.equal(result.stale,false);assert.equal(result.fetchedAt,null);assert.deepEqual(result.items,[]);
  }
});

test('a failed refresh records its actual official login source separately from the preserved topic snapshot',()=>{
  const previous=normalizeBoards([board()]);
  const failed=normalizeBoards([{platformId:'xiaohongshu',sourceUrl:'https://www.xiaohongshu.com/explore',status:'needs_login',reasonCode:'needs_login',items:[]}],previous);
  const result=xhs(failed);
  assert.equal(result.sourceUrl,sourceUrl);assert.equal(result.kind,'topics');assert.equal(result.boardName,'经典话题');
  assert.equal(result.attemptedSourceUrl,'https://www.xiaohongshu.com/explore');assert.equal(result.reasonCode,'needs_login');assert.equal(result.stale,true);
  assert.equal(result.fetchedAt,xhs(previous).fetchedAt);assert.deepEqual(result.items,xhs(previous).items);
  const creatorFailure=xhs(normalizeBoards([board({status:'needs_login',reasonCode:'needs_login',items:[]})],previous));
  assert.equal(creatorFailure.attemptedSourceUrl,sourceUrl);
  const recovered=xhs(normalizeBoards([board()],failed));
  assert.equal(recovered.stale,false);assert.ok(!Object.hasOwn(recovered,'attemptedSourceUrl'));assert.equal(recovered.reasonCode,undefined);
});

test('failure attempts never preserve a previous login destination or publish an untrusted attempted URL',()=>{
  const previous=normalizeBoards([board()]);xhs(previous).attemptedSourceUrl='https://www.xiaohongshu.com/explore';
  const badUrls=['https://creator.xiaohongshu.com.evil.example/new/inspiration','http://creator.xiaohongshu.com/new/inspiration','https://user:secret@creator.xiaohongshu.com/new/inspiration','https://creator.xiaohongshu.com:8443/new/inspiration','https://www.weibo.com/login'];
  for(const url of badUrls){
    const result=xhs(normalizeBoards([board({status:'needs_login',sourceUrl:url,items:[]})],previous));
    assert.equal(result.sourceUrl,sourceUrl);assert.equal(result.reasonCode,'invalid_source');assert.ok(!Object.hasOwn(result,'attemptedSourceUrl'));
  }
  assert.ok(!Object.hasOwn(xhs(normalizeBoards([],previous)),'attemptedSourceUrl'));
});

test('topic matches retain topic provenance and do not imply zero, NaN or real-time heat ranks',()=>{
  const result=rankedTrends(state(),account)[0];
  assert.ok(result.score>0);assert.equal(result.bestRank,null);assert.equal(result.platformCount,0);
  assert.equal(result.sources[0].kind,'topics');assert.equal(result.appearances[0].kind,'topics');
  assert.equal(result.appearances[0].boardName,'经典话题');
  assert.ok(!Object.hasOwn(result.sources[0],'rank'));assert.ok(!Object.hasOwn(result.appearances[0],'rank'));
  assert.ok(!JSON.stringify(result).includes('NaN'));
});

test('a topic shared with a ranked board uses only the ranked appearance for heat comparison',()=>{
  const boards=normalizeBoards([board(),{platformId:'weibo',sourceUrl:'https://s.weibo.com/top/summary',status:'ready',fetchedAt,items:[{title:'手机通信技巧',url:'https://s.weibo.com/weibo?q=phone',rank:8}]}]);
  const result=rankedTrends(state(boards),account)[0];
  assert.equal(result.bestRank,8);assert.equal(result.platformCount,1);assert.equal(result.appearances.length,2);
  assert.equal(result.sources.find(item=>item.platformId==='xiaohongshu').kind,'topics');
  assert.equal(result.sources.find(item=>item.platformId==='weibo').rank,8);
  const stale=state(normalizeBoards([],boards)),old=rankedTrends(stale,account)[0];
  assert.equal(old.stale,true);assert.equal(old.bestRank,8);assert.equal(old.platformCount,0);
});

test('collecting a verified topic preserves its type in the saved collection and strips forged rank data',()=>{
  const s=state(),match=rankedTrends(s,account)[0];
  const forged={...match.sources[0],rank:1},source=editorialSources(s,[forged],account.id)[0];
  assert.equal(source.kind,'topics');assert.ok(!Object.hasOwn(source,'rank'));
  const saved=addTopic(s,account,{matchId:match.id});
  assert.equal(saved.sources[0].kind,'topics');assert.ok(!Object.hasOwn(saved.sources[0],'rank'));
  assert.equal(s.inspirations[0].sourceLinks[0].kind,'topics');assert.equal(s.inspirations[0].sourceLinks[0].url,match.sources[0].url);
  s.trendBoards=[];
  assert.equal(editorialSources(s,[source],account.id)[0].kind,'topics','saved evidence survives later refreshes');
  assert.throws(()=>editorialSources(s,[source],'other-account'),/尚未验证/);
});

test('unverified topic classification is rejected even for otherwise official URLs',()=>{
  const s=state();
  for(const source of [
    {title:'未经读取的话题',url:topic('未经读取的话题').url,platformId:'xiaohongshu',kind:'topics'},
    {title:'手机通信技巧',url:topic().url,kind:'topics'},
    {title:'微博词条',url:'https://s.weibo.com/weibo?q=test',platformId:'weibo',kind:'topics'}
  ])assert.throws(()=>editorialSources(s,[source],account.id),/尚未验证/);
  const source=editorialSources(s,[{title:'手机通信技巧',url:topic().url,platformId:'xiaohongshu',rank:1}],account.id)[0];
  assert.equal(source.kind,'topics');assert.ok(!Object.hasOwn(source,'rank'),'omitting kind cannot turn known classic topics into ranked trends');
});
