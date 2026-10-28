import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserExtractScript} from './xhs-page-extract.mjs';
import {creatorExtractScript,creatorSearchScript} from './xhs-creator-extract.mjs';
import {feishuDomScripts} from './feishu-reader.mjs';
import {trendDomScripts,isOfficialTrendUrl} from './trend-sources.mjs';

const DOMAINS=['xiaohongshu.com','xhslink.com','xhslink.cn','douyin.com','bilibili.com','b23.tv','weibo.com','weibo.cn','zhihu.com','baidu.com','toutiao.com'];
const INFO='({url:location.href,ready:document.readyState})';
const MAX_RESPONSE=2*1024*1024,MAX_SCRIPT=100000;
const fail=message=>Object.assign(Error(message),{status:400});
export function allowedReaderUrl(value,{blank=true}={}) {
  if(blank&&value==='about:blank')return true;
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')
    &&(DOMAINS.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain))||/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.(?:feishu\.cn|larksuite\.com)$/i.test(url.hostname));}catch{return false;}
}
export function approvedReaderScript(script,url) {
  if(typeof script!=='string'||script.length>MAX_SCRIPT||!allowedReaderUrl(url,{blank:false}))return false;
  const parsed=new URL(url);
  if(['xiaohongshu.com','www.xiaohongshu.com'].includes(parsed.hostname)) {
    if(script===browserExtractScript()||script===creatorSearchScript())return true;
    const id=parsed.pathname.match(/^\/user\/profile\/([a-f\d]{24})(?:\/|$)/i)?.[1];
    if(id&&script===creatorExtractScript(id.toLowerCase()))return true;
  }
  if(trendDomScripts().some(entry=>entry.script===script&&isOfficialTrendUrl(entry.platformId,url)))return true;
  try{return feishuDomScripts(url).includes(script);}catch{return false;}
}
function cdpConnection(endpoint,{WebSocketClass=globalThis.WebSocket}={}) {
  return new Promise((resolve,reject)=>{
    const socket=new WebSocketClass(endpoint),pending=new Map();let sequence=0,live=false;
    const stop=()=>{live=false;for(const request of pending.values()){clearTimeout(request.timer);request.reject(fail('浏览器连接已关闭'));}pending.clear();};
    const timer=setTimeout(()=>{socket.close();reject(fail('浏览器连接超时'));},5000);
    socket.addEventListener('error',()=>{clearTimeout(timer);stop();reject(fail('浏览器无法连接'));});
    socket.addEventListener('close',stop);
    socket.addEventListener('message',event=>{
      if(typeof event.data!=='string'||event.data.length>4*1024*1024){stop();socket.close();return;}
      let message;try{message=JSON.parse(event.data);}catch{return;}
      const request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);
      if(message.error)request.reject(fail('浏览器操作未完成'));else request.resolve(message.result||{});
    });
    socket.addEventListener('open',()=>{clearTimeout(timer);live=true;resolve({
      command(method,params={},sessionId){if(!live)return Promise.reject(fail('浏览器已关闭'));const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(fail('浏览器操作超时'));},20000);pending.set(id,{resolve,reject,timer});try{socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{clearTimeout(timer);pending.delete(id);reject(fail('浏览器连接已关闭'));}});},
      close(){stop();socket.close();}
    });});
  });
}
export async function launchReaderBrowser({directory,binary=process.env.REDPILOT_CHROME_BINARY||'/usr/bin/chromium',spawnProcess=spawn,connect=cdpConnection}={}) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const child=spawnProcess(binary,[`--user-data-dir=${directory}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
  let startupError=false;child.once('error',()=>{startupError=true;});
  for(let attempt=0;attempt<60&&!startupError;attempt++) {
    try {
      const [port,endpoint]=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
      if(!/^\d{2,5}$/.test(port)||Number(port)>65535||!/^\/devtools\/browser\/[A-Za-z\d_-]+$/.test(endpoint))throw Error('pending');
      const client=await connect(`ws://127.0.0.1:${port}${endpoint}`);
      return {...client,async close(){client.close();child.kill('SIGTERM');}};
    }catch{await delay(250);}
  }
  child.kill('SIGTERM');throw fail('读取浏览器启动失败，请检查 Chromium 与显示服务');
}
async function readBody(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_SCRIPT)throw fail('读取请求过大');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}

/** Private deployment bridge: only exact built-in DOM scripts run; no arbitrary JS, cookie or storage APIs. */
export function createReaderBridge({client,maxTabs=8}={}) {
  const tabs=new Map();
  const command=(tab,method,params)=>client.command(method,params,tab.sessionId);
  const info=async tab=>{const result=await command(tab,'Runtime.evaluate',{expression:INFO,returnByValue:true});return result.result?.value||{};};
  const checkedInfo=async tab=>{const current=await info(tab);if(!allowedReaderUrl(current.url))throw fail('页面离开官方来源，已停止读取');return current;};
  const server=createServer(async(req,res)=>{
    const reply=(status,data)=>{const text=JSON.stringify(data);if(Buffer.byteLength(text)>MAX_RESPONSE){res.writeHead(413,{'Content-Type':'application/json'});res.end('{"error":"读取结果过大"}');return;}res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(text);};
    try {
      if(req.headers.origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='none')throw fail('仅允许服务器本地读取');
      const host=req.headers.host||'';if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))throw fail('读取器地址不正确');
      const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname;
      if(route==='/health'&&req.method==='GET'){try{await client.command('Browser.getVersion');return reply(200,{ready:true});}catch{return reply(503,{ready:false});}}
      if(route==='/new'&&req.method==='GET') {
        const address=url.searchParams.get('url')||'about:blank';if(!allowedReaderUrl(address)||address.length>12000)throw fail('仅支持官方页面');if(tabs.size>=maxTabs)throw fail('读取窗口已满');
        const {targetId}=await client.command('Target.createTarget',{url:'about:blank',background:true});
        try {
          const {sessionId}=await client.command('Target.attachToTarget',{targetId,flatten:true}),tab={targetId,sessionId};tabs.set(targetId,tab);
          await command(tab,'Page.enable',{});await command(tab,'Runtime.enable',{});if(address!=='about:blank')await command(tab,'Page.navigate',{url:address});
          return reply(200,{targetId});
        }catch(error){tabs.delete(targetId);await client.command('Target.closeTarget',{targetId}).catch(()=>{});throw error;}
      }
      const key=url.searchParams.get('target'),tab=tabs.get(key);if(!tab)throw fail('不能操作非读取器创建的窗口');
      if(route==='/close'&&req.method==='GET'){await client.command('Target.closeTarget',{targetId:tab.targetId});tabs.delete(key);return reply(200,{success:true});}
      if(route==='/navigate'&&req.method==='GET'){const address=url.searchParams.get('url');if(!allowedReaderUrl(address)||address.length>12000)throw fail('仅支持官方页面');await command(tab,'Page.navigate',{url:address});return reply(200,{success:true});}
      const current=await checkedInfo(tab);
      if(route==='/info'&&req.method==='GET')return reply(200,current);
      if(route==='/eval'&&req.method==='POST') {
        const script=await readBody(req);if(!approvedReaderScript(script,current.url))throw fail('只允许已登记的页面读取');
        const result=await command(tab,'Runtime.evaluate',{expression:script,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw fail('页面读取未完成');
        const after=await checkedInfo(tab);if(after.url!==current.url)throw fail('页面在读取时已变化');return reply(200,{value:result.result?.value??null});
      }
      if(route==='/click'&&req.method==='POST') {
        const selector=await readBody(req);if(!isOfficialTrendUrl('xiaohongshu',current.url)||!/^#search-input$|^\.classic-topics-container \.d-tabs-header:nth-child\([1-6]\)$/.test(selector))throw fail('不支持此页面操作');
        const script=`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||!node.getClientRects().length)return false;node.click();return true;})()`;
        const result=await command(tab,'Runtime.evaluate',{expression:script,returnByValue:true,userGesture:true});return reply(200,{value:result.result?.value===true});
      }
      if(route==='/scroll'&&req.method==='GET'&&url.searchParams.get('direction')==='bottom') {
        if(!/^https:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/[a-f\d]{24}(?:[/?#]|$)/i.test(current.url))throw fail('不支持此页面滚动');
        await command(tab,'Runtime.evaluate',{expression:'window.scrollTo(0,document.documentElement.scrollHeight)',returnByValue:true});return reply(200,{success:true});
      }
      throw fail('读取接口不存在');
    }catch(error){reply(error.status||503,{error:error.status?error.message:'浏览器读取暂不可用'});}
  });
  return {server,async close(){for(const tab of tabs.values())await client.command('Target.closeTarget',{targetId:tab.targetId}).catch(()=>{});tabs.clear();await new Promise(resolve=>server.close(resolve));await client.close?.();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const directory=path.join(process.env.REDPILOT_DATA_DIR||path.resolve('runtime'),'reader-browser');
  const client=await launchReaderBrowser({directory}),bridge=createReaderBridge({client});
  bridge.server.listen(Number(process.env.REDPILOT_READER_PORT||3456),'127.0.0.1');
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await bridge.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
