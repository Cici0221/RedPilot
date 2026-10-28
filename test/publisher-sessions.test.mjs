import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPublisherSessions,sessionDirectoryName} from '../app/publisher-sessions.mjs';

async function fixture(t) {
 const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-session-test-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const records=[],sockets=[];
 class Socket {
   constructor(url){this.url=url;this.listeners={};sockets.push(this);queueMicrotask(()=>this.emit('open',{}));}
   addEventListener(event,handler){(this.listeners[event]||=[]).push(handler);}
   emit(event,payload){for(const handler of this.listeners[event]||[])handler(payload);}
   send(text){const input=JSON.parse(text);records.push({url:this.url,...input});let result={};
     if(input.method==='Target.createTarget')result={targetId:'target-'+records.length};
     if(input.method==='Target.attachToTarget')result={sessionId:'session-'+input.params.targetId};
     if(input.method==='Runtime.evaluate')result={result:{value:input.params.expression.includes('location.href')?{url:'https://creator.xiaohongshu.com/new/home',ready:'complete'}:{hello:true}}};
     queueMicrotask(()=>this.emit('message',{data:JSON.stringify({id:input.id,result})}));
   }
   close(){this.emit('close',{});}
 }
 async function prepare(id,port){const dir=path.join(directory,'browser-sessions',sessionDirectoryName(id));await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'DevToolsActivePort'),port+'\n/devtools/browser/session-'+port+'\n');return dir;}
 const manager=createPublisherSessions({directory,env:{},legacySessionId:'existing',WebSocketClass:Socket,spawnProcess:()=>{throw Error('unexpected launch');},fetcher:async()=>{throw Error('legacy bridge down');}});
 t.after(()=>manager.close());return {directory,manager,records,sockets,prepare};
}
test('account directories reject traversal and never expose account names in paths',()=>{
 assert.match(sessionDirectoryName('account-1'),/^[a-f\d]{32}$/);assert.notEqual(sessionDirectoryName('account-1'),sessionDirectoryName('account-2'));
 for(const bad of ['../other','a/b','',null,'a'.repeat(101)])assert.throws(()=>sessionDirectoryName(bad));
});
test('legacy is preserved and independent accounts never fallback to its browser',async t=>{
 const f=await fixture(t);assert.equal(await f.manager.transport('existing'),null);assert.equal(f.manager.status('existing').mode,'legacy');
 await assert.rejects(f.manager.transport('new-account'),e=>e.code==='session_closed');assert.equal(f.records.length,0);
 await assert.rejects(f.manager.openLogin('existing'),e=>e.code==='legacy_disconnected'&&e.canMigrate);assert.equal(f.sockets.length,0);
});
test('each account only operates targets created in its own Chrome session',async t=>{
 const f=await fixture(t);await f.prepare('one',9223);await f.prepare('two',9224);
 const one=await f.manager.transport('one'),two=await f.manager.transport('two');
 const first=await one('/new?url=about%3Ablank');const second=await two('/new?url=about%3Ablank');
 await assert.rejects(two('/info?target='+first.targetId),/其他账号/);
 assert.deepEqual(await one('/info?target='+first.targetId),{url:'https://creator.xiaohongshu.com/new/home',ready:'complete'});
 await assert.rejects(one('/navigate?target='+first.targetId+'&url='+encodeURIComponent('https://evil.example/')),/非小红书/);
 await two('/close?target='+second.targetId);await assert.rejects(two('/info?target='+second.targetId),/其他账号/);
 assert.equal(f.manager.status('one').active,true);assert.ok(f.records.some(x=>x.url.includes(':9223/')));assert.ok(f.records.some(x=>x.url.includes(':9224/')));
});
test('explicit legacy migration persists without copying any browser cookies',async t=>{
 const f=await fixture(t),dir=await f.prepare('existing',9225);
 const result=await f.manager.openLogin('existing',{isolated:true});assert.equal(result.mode,'isolated');assert.equal(result.migrated,true);
 assert.equal(await readFile(path.join(dir,'.redpilot-isolated'),'utf8'),'isolated\n');
 const restarted=createPublisherSessions({directory:f.directory,env:{},legacySessionId:'existing'});t.after(()=>restarted.close());
 assert.equal(restarted.status('existing').mode,'isolated');assert.equal(restarted.isLegacy('existing'),false);
 assert.equal(f.records.filter(x=>x.method==='Target.createTarget').length,1);
 assert.equal(f.records.find(x=>x.method==='Target.createTarget').params.url,'https://creator.xiaohongshu.com/');
});
test('the profile endpoint must remain a local Chromium endpoint',async t=>{
 const f=await fixture(t);const dir=await f.prepare('bad',9226);
 await writeFile(path.join(dir,'DevToolsActivePort'),'9226\nwss://outside.example/browser\n');
 await assert.rejects(f.manager.transport('bad'),e=>e.code==='session_closed');assert.equal(f.sockets.length,0);
});
