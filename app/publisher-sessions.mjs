import {createHash} from 'node:crypto';
import {mkdir, readFile, access, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const LOGIN = 'https://creator.xiaohongshu.com/';
const MAX_MESSAGE = 4 * 1024 * 1024;
export const sessionDirectoryName = sessionId => {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw Error('账号会话标识不正确');
  return createHash('sha256').update(sessionId).digest('hex').slice(0,32);
};
const sessionError = (code, message) => Object.assign(new Error(message), {code});
const httpOrigin = value => {
  let url; try {url = new URL(value);} catch {}
  if (!url || url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('本地浏览器地址不正确');
  return url.origin;
};

// Each account uses its own on-disk Chrome profile. Login cookies are never
// copied, returned through HTTP, or mixed with another account's profile.
export function createPublisherSessions({directory, env = process.env, legacySessionId = '', fetcher = fetch, spawnProcess = spawn, WebSocketClass = globalThis.WebSocket} = {}) {
  if (!directory || !path.isAbsolute(directory)) throw Error('账号会话目录需为绝对路径');
  const sessions = new Map(), root = path.join(directory, 'browser-sessions');
  const legacyBase = () => httpOrigin(env.REDPILOT_PUBLISHER_PROXY_URL || env.REDPILOT_READER_PROXY_URL || 'http://127.0.0.1:3456');
  const migrationFile = sessionId => path.join(root,sessionDirectoryName(sessionId),'.redpilot-isolated');
  const isLegacy = sessionId => !sessionId || sessionId === legacySessionId && !existsSync(migrationFile(sessionId));
  const status = sessionId => ({sessionId:sessionId || null, mode:isLegacy(sessionId)?'legacy':'isolated', active:isLegacy(sessionId)?null:Boolean(sessions.get(sessionId)?.client?.live)});
  async function chromeBinary() {
    const candidates = [env.REDPILOT_CHROME_BINARY,
      process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      process.platform === 'linux' && '/usr/bin/google-chrome', process.platform === 'linux' && '/usr/bin/chromium',
      process.platform === 'linux' && '/usr/bin/chromium-browser',
      process.platform === 'win32' && path.join(process.env.PROGRAMFILES || 'C:\\Program Files','Google','Chrome','Application','chrome.exe')].filter(Boolean);
    for (const file of candidates) if (path.isAbsolute(file)) {try {await access(file); return file;} catch {}}
    throw sessionError('browser_missing','未找到 Chrome，请先安装 Chrome');
  }
  async function endpointFor(profileDirectory) {
    let content; try {content = await readFile(path.join(profileDirectory,'DevToolsActivePort'),'utf8');} catch {throw sessionError('session_closed','请打开此账号的登录窗口');}
    const [port, endpoint] = content.trim().split(/\r?\n/);
    if (!/^\d{2,5}$/.test(port) || Number(port) > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint || '')) throw sessionError('session_closed','账号浏览器连接尚未就绪');
    return `ws://127.0.0.1:${port}${endpoint}`;
  }
  async function connect(endpoint) {
    const ws = new WebSocketClass(endpoint), pending = new Map(); let sequence = 0, live = false;
    const failAll = () => {live = false; for (const p of pending.values()) {clearTimeout(p.timer); p.reject(sessionError('browser_disconnected','账号浏览器已断开，请重新打开登录窗口'));} pending.clear();};
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => {ws.close(); reject(sessionError('browser_timeout','连接账号浏览器超时'));}, 5000);
      ws.addEventListener('open',() => {clearTimeout(timer); live = true; resolve();},{once:true});
      ws.addEventListener('error',() => {clearTimeout(timer); reject(sessionError('browser_disconnected','账号浏览器未运行，请打开登录窗口'));},{once:true});
    });
    ws.addEventListener('close',failAll); ws.addEventListener('error',failAll);
    ws.addEventListener('message',event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE) {failAll(); ws.close(); return;}
      let message; try {message = JSON.parse(event.data);} catch {return;}
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(sessionError('browser_command','浏览器操作未完成，请重试连接')); else item.resolve(message.result || {});
    });
    return {
      get live() {return live;},
      command(method, params = {}, sessionId) {
        if (!live) return Promise.reject(sessionError('browser_disconnected','账号浏览器已断开'));
        const id = ++sequence;
        return new Promise((resolve,reject) => {
          const timer = setTimeout(() => {pending.delete(id); reject(sessionError('browser_timeout','浏览器操作超时'));},20000);
          pending.set(id,{resolve,reject,timer});
          try {ws.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));} catch {clearTimeout(timer); pending.delete(id); reject(sessionError('browser_disconnected','账号浏览器已断开'));}
        });
      },
      close() {failAll(); ws.close();}
    };
  }
  async function ensure(sessionId, {launch = false} = {}) {
    const name = sessionDirectoryName(sessionId), profileDirectory = path.join(root,name);
    let entry = sessions.get(sessionId);
    if (entry?.client?.live) return entry;
    if (entry?.connecting) return entry.connecting;
    entry ||= {profileDirectory, process:null, client:null, targets:new Map()}; sessions.set(sessionId,entry);
    entry.connecting = (async () => {
      try {entry.client = await connect(await endpointFor(profileDirectory)); entry.targets.clear(); return entry;} catch (error) {if (!launch) throw error;}
      await mkdir(profileDirectory,{recursive:true,mode:0o700});
      const binary = await chromeBinary();
      const child = spawnProcess(binary,[`--user-data-dir=${profileDirectory}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--new-window','about:blank'],{stdio:'ignore',detached:false});
      entry.process = child; let failed = false; child.once?.('error',() => {failed = true;});
      child.unref?.();
      const deadline = Date.now() + 15000;
      for (let pass = 0; pass < 30 && Date.now() < deadline; pass++) {
        if (failed) break;
        try {entry.client = await connect(await endpointFor(profileDirectory)); entry.targets.clear(); return entry;} catch {}
        await delay(250);
      }
      throw sessionError('session_start_failed','账号登录窗口未能启动，请重新打开');
    })();
    try {return await entry.connecting;} finally {entry.connecting = null;}
  }
  async function targetSession(entry,targetId) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(targetId || '')) throw Error('工作标签标识不正确');
    if (entry.targets.has(targetId)) return entry.targets.get(targetId);
    throw Error('无法操作其他账号或非本任务标签');
  }
  async function managedCall(entry,route,body,json = false) {
    const url = new URL(route,'http://localhost'), targetId = url.searchParams.get('target'), client = entry.client;
    if (url.pathname === '/new') {
      const address = url.searchParams.get('url') || 'about:blank';
      if (address !== 'about:blank' && address !== LOGIN) throw Error('新标签地址不正确');
      const {targetId} = await client.command('Target.createTarget',{url:address,background:address==='about:blank'});
      const {sessionId} = await client.command('Target.attachToTarget',{targetId,flatten:true}); entry.targets.set(targetId,sessionId);
      await client.command('Page.enable',{},sessionId); await client.command('Runtime.enable',{},sessionId);
      return {targetId};
    }
    const sessionId = await targetSession(entry,targetId);
    if (url.pathname === '/close') {await client.command('Target.closeTarget',{targetId}); entry.targets.delete(targetId); return {success:true};}
    if (url.pathname === '/navigate') {
      const address = new URL(url.searchParams.get('url'));
      if (address.protocol !== 'https:' || !['creator.xiaohongshu.com','www.xiaohongshu.com','xiaohongshu.com'].includes(address.hostname) || address.username || address.password || address.port) throw Error('拒绝非小红书页面');
      await client.command('Page.navigate',{url:address.href},sessionId); return {success:true};
    }
    if (url.pathname === '/info') {
      const result = await client.command('Runtime.evaluate',{expression:'({url:location.href,ready:document.readyState})',returnByValue:true},sessionId);
      return result.result?.value || {};
    }
    if (url.pathname === '/eval') {
      if (typeof body !== 'string' || body.length > 100000) throw Error('页面操作不正确');
      const result = await client.command('Runtime.evaluate',{expression:body,returnByValue:true,awaitPromise:true,userGesture:true},sessionId);
      if (result.exceptionDetails) throw sessionError('page_script','页面已变化，请重新核对');
      return {value:result.result?.value};
    }
    if (url.pathname === '/setFiles') {
      const input = json ? body : JSON.parse(body);
      if (input?.selector !== 'input.upload-input[type="file"]' || !Array.isArray(input.files) || input.files.length !== 1 || !path.isAbsolute(input.files[0])) throw Error('上传参数不正确');
      const {root} = await client.command('DOM.getDocument',{},sessionId);
      const {nodeIds} = await client.command('DOM.querySelectorAll',{nodeId:root.nodeId,selector:input.selector},sessionId);
      if (nodeIds?.length !== 1) throw Error('上传入口不唯一');
      await client.command('DOM.setFileInputFiles',{nodeId:nodeIds[0],files:input.files},sessionId); return {success:true};
    }
    throw Error('不支持的浏览器操作');
  }
  return {
    isLegacy,
    status,
    async transport(sessionId) {
      if (isLegacy(sessionId)) return null;
      const entry = await ensure(sessionId); return (route,body,json) => managedCall(entry,route,body,json);
    },
    async openLogin(sessionId, {isolated = false} = {}) {
      if (isolated && !sessionId) throw Error('迁移账号需要明确的账号会话标识');
      if (isolated) {
        const entry = await ensure(sessionId,{launch:true});
        await managedCall(entry,`/new?url=${encodeURIComponent(LOGIN)}`);
        await writeFile(migrationFile(sessionId),'isolated\n',{mode:0o600});
        return {...status(sessionId),opened:true,loginUrl:LOGIN,migrated:true};
      }
      if (isLegacy(sessionId)) {
        let response;
        try {response=await fetcher(`${legacyBase()}/new?url=${encodeURIComponent(LOGIN)}`,{redirect:'error',signal:AbortSignal.timeout(10000)});}
        catch {throw Object.assign(sessionError('legacy_disconnected','当前 Chrome 连接不可用，请使用独立账号窗口重新登录'),{canMigrate:Boolean(sessionId)});}
        if (!response.ok) {await response.body?.cancel().catch(()=>{});throw Object.assign(sessionError('legacy_disconnected','当前 Chrome 连接不可用，请使用独立账号窗口重新登录'),{canMigrate:Boolean(sessionId)});}
        const reader = response.body?.getReader(); if (!reader) throw Error('登录窗口未打开');
        const chunks = []; let length = 0;
        try {while(true) {const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4096){await reader.cancel();throw Error('登录窗口返回异常');}chunks.push(value);}} finally {reader.releaseLock();}
        const data = JSON.parse(Buffer.concat(chunks,length).toString('utf8')); if (!/^[A-Za-z0-9_-]{1,100}$/.test(data.targetId || '')) throw Error('登录窗口未打开');
        return {...status(sessionId), opened:true, loginUrl:LOGIN};
      }
      const entry = await ensure(sessionId,{launch:true});
      await managedCall(entry,`/new?url=${encodeURIComponent(LOGIN)}`);
      return {...status(sessionId),opened:true,loginUrl:LOGIN};
    },
    async close() {for (const entry of sessions.values()) entry.client?.close(); sessions.clear();}
  };
}
