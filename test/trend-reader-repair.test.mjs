import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {fetchTrendBoards,TREND_PLATFORMS} from '../app/trend-sources.mjs';

const json=value=>new Response(JSON.stringify(value));
const platformUrl=id=>TREND_PLATFORMS.find(item=>item.id===id).url;
const ownTarget='TREND-REPAIR-OWNED-TAB';
function timing({frozen=false}={}) {
  let elapsed=0;const sleeps=[];
  return {options:{clock:()=>elapsed,sleep:async ms=>{sleeps.push(ms);if(!frozen)elapsed+=ms;}},sleeps,elapsed:()=>elapsed};
}
function transport({evaluate,info}={}) {
  let current='',reads=0;const calls=[];
  return {calls,reads:()=>reads,fetcher:async(address,init={})=>{
    const url=new URL(address);assert.equal(url.origin,'http://127.0.0.1:3456','all transport calls must remain offline bridge fixtures');
    calls.push({path:url.pathname,target:url.searchParams.get('target'),body:init.body});
    assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
    if(url.pathname==='/new'){current=url.searchParams.get('url');return json({targetId:ownTarget});}
    assert.equal(url.searchParams.get('target'),ownTarget,'never operate an existing user tab');
    if(url.pathname==='/navigate'){current=url.searchParams.get('url');return json({ok:true});}
    if(url.pathname==='/info')return json(info?.(current)||{url:current,ready:'complete'});
    if(url.pathname==='/eval'){reads++;return json({value:evaluate?.({current,script:init.body,read:reads})||{status:'unavailable',sourceUrl:current,reasonCode:'board_not_exposed',items:[]}});}
    if(url.pathname==='/click'){assert.equal(init.method,'POST');assert.equal(init.body,'#search-input');return json({ok:true});}
    if(url.pathname==='/close')return json({ok:true});
    assert.fail('unexpected transport route');
  }};
}
async function expression(platformId) {
  let script;
  const bridge=transport({evaluate:request=>{script=request.script;return {status:'needs_login',sourceUrl:request.current,items:[]};}});
  await fetchTrendBoards({platformIds:[platformId]}, {}, bridge.fetcher,timing().options);
  return script;
}

// A small read-only DOM fixture; selectors exercise the observed hierarchy rather
// than returning pre-parsed boards. No real browser, API, account or network is used.
function node(tag,{text='',attrs={},hidden=false,children=[]}={}) {
  const result={tagName:tag.toUpperCase(),attrs,hidden,children,parentElement:null,...attrs,
    get innerText(){return [text,...children.map(child=>child.innerText)].filter(Boolean).join(' ');},
    getClientRects(){return hidden?[]:[{}];},
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
    querySelectorAll(selector){const descendants=[];const visit=parent=>{for(const child of parent.children){descendants.push(child);visit(child);}};visit(this);return descendants.filter(child=>selector.split(',').some(part=>matches(child,part.trim())));},
    closest(selector){for(let current=this;current;current=current.parentElement)if(matches(current,selector))return current;return null;}
  };
  for(const child of children)child.parentElement=result;
  return result;
}
function matches(value,selector) {
  if(selector.startsWith('#'))return value.attrs.id===selector.slice(1);
  if(selector.startsWith('.'))return String(value.attrs.class||'').split(/\s+/).includes(selector.slice(1));
  const match=selector.match(/^([a-z][\w-]*)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i);
  assert.ok(match,'unsupported offline fixture selector: '+selector);
  return (!match[1]||value.tagName.toLowerCase()===match[1].toLowerCase())&&(!match[2]||Object.hasOwn(value.attrs,match[2])&&(match[3]===undefined||value.attrs[match[2]]===match[3]));
}
function dom(platformId,children=[],{page='发现 推荐',readyState='complete',activeElement=null,url=platformUrl(platformId)}={}) {
  const document=node('document',{children:[node('body',{text:page,children})]});
  document.body=document.children[0];document.readyState=readyState;document.activeElement=activeElement;
  return {URL,location:{href:url},document,getComputedStyle:value=>({display:value.hidden?'none':'block',visibility:'visible'})};
}
const badgeUrl=file=>'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/'+file;
function douyinRow({rank,title='真实话题',href='https://www.douyin.com/hot/123',badge,heat='1210.9万热度',hidden=false}={}) {
  return node('li',{hidden,children:[node('a',{attrs:href?{href}:{},children:[
    node('span',{attrs:{class:'listStyle'},text:rank===undefined?'':String(rank),children:badge?[node('img',{attrs:{src:badge}})]:[]}),
    node('h3',{text:title}),node('span',{text:heat})
  ]})]});
}
function douyinBoard(rows,{heading='抖音热榜',hidden=false}={}) {
  return node('section',{attrs:{'data-e2e':'feed-right-list-container'},hidden,children:[node('h1',{text:heading}),node('ul',{children:rows})]});
}
function genericBoard(platformId,{heading=true,rank=12,href,title='普通标题',hiddenHeading=false}={}) {
  const label=platformId==='douyin'?'抖音热榜':'搜索发现';
  const row=node('li',{children:[node('span',{attrs:{class:'rank'},text:rank===null?'':String(rank)}),node('a',{text:title,attrs:{href:href||platformUrl(platformId)+'/fixture'}})]});
  return node('section',{children:[...(heading?[node('h2',{text:label,hidden:hiddenHeading})]:[]),node('ul',{attrs:{class:'hot-list'},children:[row]})]});
}

test('observed Douyin board reads SVG top three and numeric places, preserving gaps, titles, heat and original URLs',async()=>{
  const script=await expression('douyin');
  const rows=[douyinRow({title:'无序号置顶',badge:badgeUrl('up.svg')}),...[1,2,3].map(rank=>douyinRow({title:'榜单 '+rank,badge:badgeUrl('hot_top'+rank+'.svg'),href:'https://www.douyin.com/hot/'+rank+'?from=official'})),douyinRow({rank:4,title:'榜单 4',href:'https://www.douyin.com/hot/4'}),douyinRow({rank:7,title:'榜单 7',href:'https://www.douyin.com/hot/7',heat:'998万热度'})];
  const result=runInNewContext(script,dom('douyin',[douyinBoard(rows)]));
  assert.equal(result.status,'partial');assert.deepEqual(Array.from(result.items,item=>item.rank),[1,2,3,4,7]);
  assert.deepEqual(Array.from(result.items,item=>item.title),['榜单 1','榜单 2','榜单 3','榜单 4','榜单 7']);
  assert.equal(result.items[0].url,'https://www.douyin.com/hot/1?from=official');assert.equal(result.items[0].heatText,'1210.9万热度');assert.equal(result.items.at(-1).heatText,'998万热度');
  assert.equal(result.items.some(item=>item.title==='无序号置顶'),false);
});

test('Douyin skips untrusted badges, unranked or foreign/missing links and never invents rankings or URLs',async()=>{
  const script=await expression('douyin');
  const rows=[douyinRow({badge:'https://douyinstatic.com.evil.example/hot_top1.svg'}),douyinRow({badge:'http://lf-douyin-pc-web.douyinstatic.com/hot_top2.svg'}),douyinRow({badge:badgeUrl('hot_top9.svg')}),douyinRow({rank:4,href:null}),douyinRow({rank:5,href:'https://evil.example/hot/5'}),douyinRow({rank:6,hidden:true}),douyinRow({rank:8,title:'唯一合法条目',href:'https://www.douyin.com/hot/8'})];
  const result=runInNewContext(script,dom('douyin',[douyinBoard(rows)]));
  assert.equal(result.items.length,1);assert.equal(result.items[0].rank,8);assert.equal(result.items[0].title,'唯一合法条目');assert.equal(result.items[0].url,'https://www.douyin.com/hot/8');
});

test('hidden or differently labelled Douyin lists are not substituted for the official hot board',async()=>{
  const script=await expression('douyin');
  for(const options of [{heading:'猜你喜欢'},{hidden:true}]){
    const result=runInNewContext(script,dom('douyin',[douyinBoard([douyinRow({rank:1})],options)]));
    assert.equal(result.items.length,0);assert.equal(result.reasonCode,'board_not_exposed');
  }
});

test('generic boards accept visible sibling headings, but reject unlabeled rows, hidden labels and missing ranks',async()=>{
  for(const platformId of ['xiaohongshu','douyin']){
    const script=await expression(platformId),result=runInNewContext(script,dom(platformId,[genericBoard(platformId)]));
    assert.equal(result.items.length,1);assert.equal(result.items[0].rank,12);assert.equal(result.items[0].title,'普通标题');
    for(const options of [{heading:false},{hiddenHeading:true},{rank:null}])assert.equal(runInNewContext(script,dom(platformId,[genericBoard(platformId,options)])).items.length,0);
  }
});

test('login words in ordinary content do not stop reading, while visible login gates and verification do',async()=>{
  for(const platformId of ['xiaohongshu','douyin']){
    const script=await expression(platformId);
    const ordinary=runInNewContext(script,dom(platformId,[],{page:'为什么扫码登录会更方便？验证码登录教程'}));
    assert.equal(ordinary.status,'unavailable');assert.equal(ordinary.reasonCode,'board_not_exposed');
    for(const gate of [node('div',{attrs:{class:'login-modal'},text:'验证码登录'}),node('div',{attrs:{role:'dialog'},text:'请先登入'})])assert.equal(runInNewContext(script,dom(platformId,[gate])).status,'needs_login');
    for(const nongate of [node('div',{attrs:{class:'login-modal'},text:'登录',hidden:true}),node('div',{attrs:{role:'dialog'},text:'选择主题'})])assert.equal(runInNewContext(script,dom(platformId,[nongate])).status,'unavailable');
    const blocked=runInNewContext(script,dom(platformId,[],{page:'请完成验证后继续浏览'}));assert.equal(blocked.status,'blocked');assert.equal(blocked.action,undefined);
  }
});

test('Xiaohongshu opens only a visible empty unfocused search field, and login placeholders remain a gate',async()=>{
  const script=await expression('xiaohongshu');
  const field=()=>node('input',{attrs:{id:'search-input',value:'',placeholder:'搜索小红书'}});
  let input=field(),result=runInNewContext(script,dom('xiaohongshu',[input]));assert.equal(result.action,'open_search');assert.equal(result.reasonCode,'board_not_loaded');
  for(const kind of ['filled','focused','hidden','login']){
    input=field();if(kind==='filled')input.value='用户输入';if(kind==='hidden')input.hidden=true;if(kind==='login')input.placeholder='登录后搜索';
    result=runInNewContext(script,dom('xiaohongshu',[input],{activeElement:kind==='focused'?input:null}));assert.equal(result.action,undefined,kind);assert.equal(result.status,kind==='login'?'needs_login':'unavailable',kind);
  }
});

test('complete-but-unhydrated boards retry within the existing budget then return actual ranked rows',async()=>{
  const clock=timing(),bridge=transport({evaluate:({current,read})=>read===1?{status:'unavailable',sourceUrl:current,reasonCode:'board_not_exposed',items:[]}:{status:'partial',sourceUrl:current,items:[{title:'延后出现的榜单项',rank:9,url:'https://www.douyin.com/hot/9?from=board'}]}});
  const [board]=await fetchTrendBoards({platformIds:['douyin']},{},bridge.fetcher,clock.options);
  assert.equal(board.status,'partial');assert.equal(board.items[0].rank,9);assert.equal(board.items[0].url,'https://www.douyin.com/hot/9?from=board');assert.equal(bridge.reads(),2);assert.deepEqual(clock.sleeps,[400]);assert.equal(bridge.calls.filter(call=>call.path==='/close').length,1);
});

test('a missing ranking is bounded by eight seconds and by the frozen-clock attempt cap',async()=>{
  for(const frozen of [false,true]){
    const clock=timing({frozen}),bridge=transport();const [board]=await fetchTrendBoards({platformIds:['douyin']},{},bridge.fetcher,clock.options);
    assert.equal(board.reasonCode,'board_not_exposed');assert.equal(board.items.length,0);assert.equal(bridge.reads(),frozen?21:20);assert.equal(clock.sleeps.reduce((sum,value)=>sum+value,0),8000);assert.equal(bridge.calls.filter(call=>call.path==='/close').length,1);
  }
});

test('search expansion clicks once on the owned Xiaohongshu tab and resumes collecting ranked content',async()=>{
  const clock=timing(),bridge=transport({evaluate:({current,read})=>read<3?{status:'unavailable',sourceUrl:current,reasonCode:'board_not_loaded',action:'open_search',items:[]}:{status:'partial',sourceUrl:current,items:[{title:'搜索热榜项',rank:4,url:'https://www.xiaohongshu.com/search_result?keyword=fixture'}]}});
  const [board]=await fetchTrendBoards({platformIds:['xiaohongshu']},{},bridge.fetcher,clock.options);
  assert.equal(board.status,'partial');assert.equal(board.items[0].rank,4);assert.equal(bridge.reads(),3);
  assert.deepEqual(bridge.calls.filter(call=>call.path==='/click'),[{path:'/click',target:ownTarget,body:'#search-input'}]);assert.equal(bridge.calls.filter(call=>call.path==='/new').length,1);assert.equal(bridge.calls.filter(call=>call.path==='/close').length,1);
});

test('search actions never apply to other platforms or to foreign redirects/results',async()=>{
  const other=transport({evaluate:({current})=>({status:'unavailable',sourceUrl:current,reasonCode:'board_not_loaded',action:'open_search',items:[]})});
  await fetchTrendBoards({platformIds:['douyin']},{},other.fetcher,timing().options);assert.equal(other.calls.some(call=>call.path==='/click'),false);
  for(const stage of ['info','result']){
    const bridge=transport({info:stage==='info'?()=>({url:'https://evil.example/',ready:'complete'}):undefined,evaluate:()=>({status:'unavailable',sourceUrl:'https://evil.example/',reasonCode:'board_not_loaded',action:'open_search',items:[]})});
    const [board]=await fetchTrendBoards({platformIds:['xiaohongshu']},{},bridge.fetcher,timing().options);assert.equal(board.reasonCode,'invalid_source');assert.equal(bridge.calls.some(call=>call.path==='/click'),false);assert.equal(bridge.reads(),stage==='info'?0:1);assert.equal(bridge.calls.filter(call=>call.path==='/close').length,1);
  }
});

test('login/verification gates end polling immediately without search clicks or manufactured rows',async()=>{
  for(const status of ['needs_login','blocked']){
    const clock=timing(),bridge=transport({evaluate:({current})=>({status,sourceUrl:current,reasonCode:'board_not_loaded',action:'open_search',items:[]})});
    const [board]=await fetchTrendBoards({platformIds:['xiaohongshu']},{},bridge.fetcher,clock.options);
    assert.equal(board.status,status);assert.equal(board.items.length,0);assert.equal(bridge.reads(),1);assert.deepEqual(clock.sleeps,[]);assert.equal(bridge.calls.some(call=>call.path==='/click'),false);assert.equal(bridge.calls.filter(call=>call.path==='/close').length,1);
  }
});

test('foreign evaluated DOM is rejected before selectors, input inspection or action creation',async()=>{
  const script=await expression('xiaohongshu'),context={URL,location:{href:'https://xiaohongshu.com.evil.example/'}};
  Object.defineProperty(context,'document',{get(){assert.fail('foreign DOM must not be accessed');}});
  const result=runInNewContext(script,context);assert.equal(result.reasonCode,'invalid_source');assert.equal(result.action,undefined);assert.equal(result.items.length,0);
});
