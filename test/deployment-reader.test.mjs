import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReaderBridge,allowedReaderUrl,approvedReaderScript} from '../app/deployment-reader.mjs';
import {browserExtractScript} from '../app/xhs-page-extract.mjs';
import {creatorExtractScript,creatorSearchScript} from '../app/xhs-creator-extract.mjs';
import {feishuDomScripts} from '../app/feishu-reader.mjs';
import {trendDomScripts} from '../app/trend-sources.mjs';

test('deployment reader accepts only official destinations and exact built-in visible-DOM scripts',()=>{
  for(const url of ['about:blank','https://www.xiaohongshu.com/explore','https://creator.xiaohongshu.com/new/inspiration','https://tenant.feishu.cn/docx/abcdefghijk','https://www.zhihu.com/hot'])assert.equal(allowedReaderUrl(url),true,url);
  for(const url of ['file:///etc/passwd','http://127.0.0.1:4317/','https://127.0.0.1/','https://weibo.com.evil.example/','https://weibo.com@evil.example/','https://weibo.com:444/','https://evil.example/','javascript:alert(1)'])assert.equal(allowedReaderUrl(url),false,url);
  assert.equal(approvedReaderScript(browserExtractScript(),'https://www.xiaohongshu.com/explore'),true);
  assert.equal(approvedReaderScript(creatorSearchScript(),'https://www.xiaohongshu.com/search_result?keyword=hello'),true);
  const id='0123456789abcdef01234567';assert.equal(approvedReaderScript(creatorExtractScript(id),`https://www.xiaohongshu.com/user/profile/${id}`),true);
  for(const script of feishuDomScripts('https://tenant.feishu.cn/docx/abcdefghijk'))assert.equal(approvedReaderScript(script,'https://tenant.feishu.cn/docx/abcdefghijk'),true);
  for(const script of ['document.cookie','localStorage.getItem("session")','window.__INITIAL_STATE__','fetch("https://evil.example")',browserExtractScript()+';document.cookie'])assert.equal(approvedReaderScript(script,'https://www.xiaohongshu.com/explore'),false);
  assert.equal(approvedReaderScript(browserExtractScript(),'https://evil.example/'),false);
  assert.equal(approvedReaderScript(feishuDomScripts('https://tenant.feishu.cn/docx/abcdefghijk')[0],'https://tenant.feishu.cn/docx/different123'),false);
  const topic=trendDomScripts().find(entry=>entry.platformId==='zhihu');assert.equal(approvedReaderScript(topic.script,'https://www.zhihu.com/hot'),true);assert.equal(approvedReaderScript(topic.script,'https://www.baidu.com/'),false);
});

test('bridge owns only its tabs, rejects browser cross-origin access and never exposes arbitrary eval or cookies',async t=>{
  const calls=[],locations=new Map();let next=0;
  const client={async command(method,params={},sessionId){calls.push({method,params,sessionId});if(method==='Target.createTarget'){const targetId='target-'+ ++next;locations.set('session-'+targetId,'about:blank');return {targetId};}if(method==='Target.attachToTarget')return {sessionId:'session-'+params.targetId};if(method==='Page.navigate'){locations.set(sessionId,params.url);return {};}if(method==='Runtime.evaluate')return {result:{value:params.expression==='({url:location.href,ready:document.readyState})'?{url:locations.get(sessionId),ready:'complete'}:{status:'ready',title:'可见正文'}}};return {};},async close(){}};
  const bridge=createReaderBridge({client,maxTabs:2});await new Promise(resolve=>bridge.server.listen(0,'127.0.0.1',resolve));t.after(()=>bridge.close());const base='http://127.0.0.1:'+bridge.server.address().port;
  const get=route=>fetch(base+route),post=(route,body,headers={})=>fetch(base+route,{method:'POST',body,headers});
  let response=await get('/new?url='+encodeURIComponent('https://www.xiaohongshu.com/explore'));assert.equal(response.status,200);const {targetId}=await response.json();
  response=await post('/eval?target='+targetId,browserExtractScript());assert.equal(response.status,200);assert.equal((await response.json()).value.title,'可见正文');
  const before=calls.length;response=await post('/eval?target='+targetId,'document.cookie');assert.equal(response.status,400);assert.ok(calls.slice(before).every(call=>call.params.expression!=='document.cookie'));
  assert.equal((await post('/eval?target='+targetId,browserExtractScript(),{Origin:'https://evil.example'})).status,400);
  assert.equal((await get('/info?target=someone-elses-tab')).status,400);
  assert.equal((await get('/navigate?target='+targetId+'&url='+encodeURIComponent('file:///etc/passwd'))).status,400);
  locations.set('session-'+targetId,'https://evil.example/');assert.equal((await post('/eval?target='+targetId,browserExtractScript())).status,400);
  assert.equal((await get('/close?target='+targetId)).status,200);assert.equal((await get('/info?target='+targetId)).status,400);
  assert.ok(calls.some(call=>call.method==='Target.closeTarget'&&call.params.targetId===targetId));
  assert.ok(calls.every(call=>!['Network.getAllCookies','Storage.getCookies','Network.getCookies'].includes(call.method)));
});


test('reader health detects a disconnected Chromium session',async t=>{
  let live=true;
  const client={async command(method){assert.equal(method,'Browser.getVersion');if(!live)throw Error('disconnected');return {product:'Chrome/fixture'};},async close(){}};
  const bridge=createReaderBridge({client});await new Promise(resolve=>bridge.server.listen(0,'127.0.0.1',resolve));t.after(()=>bridge.close());
  const endpoint='http://127.0.0.1:'+bridge.server.address().port+'/health';
  let result=await fetch(endpoint);assert.equal(result.status,200);assert.deepEqual(await result.json(),{ready:true});
  live=false;result=await fetch(endpoint);assert.equal(result.status,503);assert.deepEqual(await result.json(),{ready:false});
});
