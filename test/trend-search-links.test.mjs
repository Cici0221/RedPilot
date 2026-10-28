import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const anchors=html=>[...html.matchAll(/<a\b([^>]*)>/g)].map(([,attrs])=>Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,decode(value)])));
const keyword='手机 AI + 电池? # & / 中文 % 😀';
const platforms=[
  ['xiaohongshu','www.xiaohongshu.com','/search_result','keyword'],
  ['douyin','www.douyin.com','/search/','path'],
  ['bilibili','search.bilibili.com','/all','keyword'],
  ['weibo','s.weibo.com','/weibo','q'],
  ['zhihu','www.zhihu.com','/search','q'],
  ['baidu','www.baidu.com','/s','wd'],
  ['toutiao','www.toutiao.com','/search/','keyword']
];
function ui(){
  const context=vm.createContext({URL,URLSearchParams,Intl,Date,Math,structuredClone,AbortSignal,setTimeout,clearTimeout,console,
    document:{querySelector:()=>null,querySelectorAll:()=>[]},location:{hash:''},window:{scrollTo(){}}});
  vm.runInContext(definitions,context);
  vm.runInContext("S={accounts:[{id:'official',name:'官方',enabled:true,archived:false}],defaultAccountId:'official',inspirations:[],topicPool:[],trendBoards:[],trendMatches:{official:[]}};",context);
  return {context,run:code=>vm.runInContext(code,context)};
}
function assertNewTab(anchor){assert.equal(anchor.target,'_blank');assert.ok(anchor.rel.split(/\s+/).includes('noopener'));assert.ok(anchor.rel.split(/\s+/).includes('noreferrer'));}

test('all seven platform searches encode the complete keyword without injecting URL parameters',()=>{
  const view=ui();view.context.keyword=keyword;
  for(const [id,host,path,param] of platforms){
    view.context.platform=id;const url=new URL(view.run('trendSearchUrl(platform,keyword)'));
    assert.equal(url.protocol,'https:');assert.equal(url.hostname,host);assert.equal(url.hash,'');assert.equal(url.username,'');assert.equal(url.password,'');
    if(param==='path'){
      assert.equal(url.pathname.slice(0,path.length),path);assert.equal(decodeURIComponent(url.pathname.slice(path.length)),keyword);
      assert.equal(url.pathname.split('/').length,3);assert.equal(url.searchParams.get('type'),'general');assert.equal([...url.searchParams].length,1);
    }else{
      assert.equal(url.pathname,path);assert.equal(url.searchParams.get(param),keyword);
      const expected=id==='zhihu'?['q','type']:[param];assert.deepEqual([...url.searchParams.keys()].sort(),expected.sort());
      if(id==='zhihu')assert.equal(url.searchParams.get('type'),'content');
    }
  }
});

test('unsupported platforms and empty keywords produce no search destination',()=>{
  const view=ui();
  for(const value of ['unknown','__proto__','constructor','https://evil.test']){view.context.platform=value;assert.equal(view.run("trendSearchUrl(platform,'手机')"),'');}
  for(const value of ['', '   ',null,undefined]){view.context.keyword=value;assert.equal(view.run("trendSearchUrl('baidu',keyword)"),'');}
});

test('a platform item title opens search in a new tab rather than its original detail URL',()=>{
  const view=ui();view.context.item={id:'video',title:keyword,url:'https://www.bilibili.com/video/BV-original'};
  const html=view.run("trendItemTitle(item,'bilibili')"),links=anchors(html);assert.equal(links.length,1);assertNewTab(links[0]);
  const url=new URL(links[0].href);assert.equal(url.hostname,'search.bilibili.com');assert.equal(url.searchParams.get('keyword'),keyword);
  assert.doesNotMatch(html,/BV-original/);assert.equal(view.context.item.url,'https://www.bilibili.com/video/BV-original');
});

test('each platform appearance opens its own keyword search without changing provenance',()=>{
  const view=ui();view.context.item={id:'match',title:keyword,appearances:platforms.map(([platformId],index)=>({platformId,rank:index+1,url:'https://original.test/'+platformId,stale:index===0,fetchedAt:'2026-10-26T01:00:00Z'}))};
  const before=JSON.stringify(view.context.item);const links=anchors(view.run('trendAppearanceChips(item)'));assert.equal(links.length,platforms.length);
  for(let i=0;i<links.length;i++){assertNewTab(links[i]);assert.equal(new URL(links[i].href).hostname,platforms[i][1]);}
  assert.equal(JSON.stringify(view.context.item),before);
});

test('recommendations use a current source and retain old search links only in the heat view',()=>{
  const view=ui();const sources=[
    {platformId:'unknown',url:'https://unknown.test/topic',stale:false},
    {platformId:'weibo',url:'https://weibo.com/original',stale:true},
    {platformId:'zhihu',url:'https://www.zhihu.com/question/original',stale:false},
    {platformId:'baidu',url:'https://www.baidu.com/s?wd=original',stale:false}
  ];
  view.context.item={id:'match',title:keyword,score:6,sourceIds:[],sources,appearances:sources};
  view.run('S.trendMatches.official=[item]');
  const titleLink=()=>anchors(view.run('trendMatchMarkup()').match(/<h3>([\s\S]*?)<\/h3>/)[1])[0];
  const first=titleLink();assertNewTab(first);assert.equal(new URL(first.href).hostname,'www.zhihu.com');
  view.run('item.sources.forEach(source=>source.stale=true)');
  assert.doesNotMatch(view.run('trendMatchMarkup()'),/<h3>/,'stale topics do not remain recommendations');
  view.run("trendOrder='heat';item.sources.forEach((source,index)=>source.rank=index+1)");
  assert.equal(new URL(titleLink().href).hostname,'s.weibo.com');
});

test('search navigation does not replace original links used by collection and source attribution',()=>{
  const view=ui();view.context.item={id:'entry',title:'产品主题',url:'https://www.zhihu.com/question/original',rank:4};
  view.context.board={platformId:'zhihu',name:'知乎',status:'ready',boardName:'热榜',fetchedAt:'2026-10-26T01:00:00Z'};
  view.run('const originalSource=trendItemSource(item,board);');
  assert.equal(view.run('originalSource.url'),view.context.item.url);
  const sourceLink=anchors(view.run('operationSources([originalSource])'))[0];assert.equal(sourceLink.href,view.context.item.url);
  view.run("trendItemTitle(item,'zhihu')");assert.equal(view.run('originalSource.url'),view.context.item.url);
});
