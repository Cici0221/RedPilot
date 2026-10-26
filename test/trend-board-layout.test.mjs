import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const platformIds=['xiaohongshu','douyin','bilibili','weibo','zhihu','baidu','toutiao'];
const cardIndexes=html=>[...html.matchAll(/data-board-index="(\d+)"/g)].map(match=>Number(match[1]));
const columns=html=>[...html.matchAll(/<div class="trend-board-column">([\s\S]*?)<\/div>/g)].map(match=>cardIndexes(match[1]));

function ui(singleColumn=false){
  const context=vm.createContext({URL,URLSearchParams,Intl,Date,Math,structuredClone,AbortSignal,setTimeout,clearTimeout,console,
    document:{querySelector:()=>null,querySelectorAll:()=>[]},location:{hash:''},
    window:{scrollTo(){},matchMedia:query=>{assert.equal(query,'(max-width:600px)');return {matches:singleColumn};}}});
  vm.runInContext(definitions,context);
  vm.runInContext(`S={trendBoards:[]};trendBoardMarkup=(board,index)=>'<section data-board-index="'+index+'" data-board-key="'+trendBoardKey(board,index)+'"></section>';`,context);
  return {context,run:code=>vm.runInContext(code,context)};
}

test('desktop boards stack in independent columns in their existing platform positions',()=>{
  const view=ui();view.context.boards=platformIds.map(platformId=>({platformId}));
  const html=view.run('trendBoardGridMarkup(boards,false)');
  assert.deepEqual(columns(html),[[0,2,4,6],[1,3,5]]);
});

test('single-column boards keep the original platform and keyboard reading order',()=>{
  const view=ui();view.context.boards=platformIds.map(platformId=>({platformId}));
  const html=view.run('trendBoardGridMarkup(boards,true)');
  assert.deepEqual(cardIndexes(html),[0,1,2,3,4,5,6]);
  assert.doesNotMatch(html,/trend-board-column/);
});

test('each board renders exactly once for odd, even and single-board lists',()=>{
  const view=ui();
  for(const count of [1,2,3,6,7]){
    view.context.boards=platformIds.slice(0,count).map(platformId=>({platformId}));
    for(const singleColumn of [false,true]){
      const indexes=cardIndexes(view.run(`trendBoardGridMarkup(boards,${singleColumn})`));
      assert.equal(indexes.length,count);
      assert.deepEqual(indexes.sort((a,b)=>a-b),Array.from({length:count},(_,index)=>index));
    }
  }
});

test('column grouping preserves original indexes used by fallback expansion keys',()=>{
  const view=ui();view.context.boards=Array.from({length:7},()=>({}));
  for(const singleColumn of [false,true]){
    const html=view.run(`trendBoardGridMarkup(boards,${singleColumn})`);
    const cards=[...html.matchAll(/data-board-index="(\d+)" data-board-key="([^"]+)"/g)];
    assert.equal(cards.length,7);
    for(const [,index,key] of cards)assert.equal(key,':'+index);
    assert.equal(new Set(cards.map(match=>match[2])).size,7);
  }
});

test('default layout follows the mobile breakpoint and empty lists render one empty state',()=>{
  for(const singleColumn of [false,true]){
    const view=ui(singleColumn);view.context.boards=platformIds.map(platformId=>({platformId}));
    view.run('S.trendBoards=boards');
    const html=view.run('trendBoardGridMarkup()');
    assert.deepEqual(cardIndexes(html),singleColumn?[0,1,2,3,4,5,6]:[0,2,4,6,1,3,5]);
    const empty=view.run('trendBoardGridMarkup([],true)');
    assert.match(empty,/暂无热榜数据/);
    assert.equal((empty.match(/class="empty"/g)||[]).length,1);
    assert.doesNotMatch(empty,/trend-board-column|data-board-index/);
  }
});
