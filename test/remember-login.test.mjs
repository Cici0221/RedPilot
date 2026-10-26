import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rename,rm,stat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../app/server.mjs';
import {configureAuth} from '../app/auth.mjs';

const root=path.resolve(import.meta.dirname,'..');
const HOUR=60*60*1000,DAY=24*HOUR,START=Date.parse('2026-10-26T01:00:00.000Z');

// Only temporary credentials/state and injected offline service readers are used.
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'redpilot-remember-'));
  const email='remember-fixture@example.test',password='Test-only-'+randomBytes(18).toString('hex');
  await configureAuth({directory,email,password});
  let clock=START,app,base;
  async function open() {
    app=await createApp({root,directory,env:{},authClock:()=>clock,
      fetcher:async()=>{throw new Error('unexpected external network call');},trendReader:async()=>[],
      linkReader:async()=>({status:'unavailable',missing:[],error:'test-only offline'}),
      creatorReader:async()=>({status:'unavailable',notes:[],error:'test-only offline'}),
      feishuReader:async()=>({status:'unavailable',documents:[],sources:[],error:'test-only offline'})});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
  }
  await open();
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  return {directory,email,password,advance:milliseconds=>{clock+=milliseconds;},
    async reopen(){await app.close();await open();},
    async request(url,{method='GET',json,cookie=''}={}) {
      const response=await fetch(base+url,{method,redirect:'manual',signal:AbortSignal.timeout(5000),headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(json===undefined?{}:{'Content-Type':'application/json'})},...(json===undefined?{}:{body:JSON.stringify(json)})});
      const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
      return {status:response.status,headers:response.headers,text,data};
    },
    async login(remember,extra={}) {return this.request('/api/auth/login',{method:'POST',json:{email,password,...(remember===undefined?{}:{remember}),...extra}});}
  };
}
function cookie(result) {assert.equal(result.status,200,'fixture login must succeed');const header=result.headers.get('set-cookie');assert.ok(header);return header.split(';')[0];}
function token(cookieValue) {return cookieValue.slice(cookieValue.indexOf('=')+1);}
async function disk(f) {try{return JSON.parse(await readFile(path.join(f.directory,'sessions.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function sessionRecords(value) {if(!value||typeof value!=='object')return [];if(typeof value.tokenHash==='string')return [value];return Object.values(value).flatMap(sessionRecords);}
async function authenticated(f,cookieValue) {return (await f.request('/api/auth/session',{cookie:cookieValue})).data.authenticated;}

test('remember=true issues an opaque 30-day HttpOnly Strict cookie and awaits private hash-only persistence',async t=>{
  const f=await fixture(t),result=await f.login(true),header=result.headers.get('set-cookie'),value=cookie(result),rawToken=token(value);
  assert.match(value,/^redpilot_session=[A-Za-z0-9_-]{43}$/);assert.match(header,/;\s*HttpOnly(?:;|$)/i);assert.match(header,/;\s*SameSite=Strict(?:;|$)/i);assert.match(header,/;\s*Max-Age=2592000(?:;|$)/i);assert.match(header,/;\s*Path=\/(?:;|$)/i);
  assert.equal(Date.parse(result.data.expiresAt),START+30*DAY);assert.equal(await authenticated(f,value),true);
  const stored=await disk(f),records=sessionRecords(stored);assert.deepEqual(Object.keys(stored).sort(),['credentialFingerprint','sessions','version']);assert.equal(stored.version,1);assert.match(stored.credentialFingerprint,/^[a-f0-9]{64}$/);assert.equal(records.length,1);assert.deepEqual(Object.keys(records[0]).sort(),['createdAt','expiresAt','tokenHash']);assert.equal(records[0].createdAt,START);assert.equal(records[0].expiresAt,START+30*DAY);assert.equal(records[0].tokenHash,createHash('sha256').update(rawToken).digest('hex'));assert.equal(JSON.stringify(stored).includes(rawToken),false);assert.equal(JSON.stringify(stored).includes(f.password),false);assert.equal((await stat(path.join(f.directory,'sessions.json'))).mode&0o777,0o600);
});

test('default and remember=false keep eight-hour sessions and do not survive a restart',async t=>{
  const f=await fixture(t),values=[];
  for(const remember of [undefined,false]) {const result=await f.login(remember);values.push(cookie(result));assert.equal(Date.parse(result.data.expiresAt),START+8*HOUR);assert.match(result.headers.get('set-cookie'),/;\s*Max-Age=28800(?:;|$)/i);assert.equal(await authenticated(f,values.at(-1)),true);}
  assert.equal(sessionRecords(await disk(f)).length,0);await f.reopen();for(const value of values)assert.equal(await authenticated(f,value),false);
});

test('nonboolean remember inputs are rejected instead of silently creating a persistent session',async t=>{
  const f=await fixture(t);
  for(const value of ['true','false',1,0,null,[],{}]) {const result=await f.login(value);assert.equal(result.status,400);assert.equal(result.headers.has('set-cookie'),false);}
  assert.equal((await f.request('/api/auth/session')).data.authenticated,false);assert.equal(sessionRecords(await disk(f)).length,0);
});

test('remembered login survives clean close/reopen and remains valid after an ordinary eight-hour session would expire',async t=>{
  const f=await fixture(t),value=cookie(await f.login(true));f.advance(8*HOUR+1);await f.reopen();assert.equal(await authenticated(f,value),true);assert.equal((await f.request('/api/state',{cookie:value})).status,200);
  await f.reopen();assert.equal(await authenticated(f,value),true);
});

test('remembered tokens expire at the original thirty-day boundary across restarts',async t=>{
  const f=await fixture(t),result=await f.login(true),value=cookie(result);f.advance(30*DAY-1);await f.reopen();assert.equal(await authenticated(f,value),true);
  assert.equal((await f.request('/api/auth/session',{cookie:value})).data.expiresAt,result.data.expiresAt,'restart must not extend the original expiry');
  f.advance(1);assert.equal(await authenticated(f,value),false);assert.equal((await f.request('/api/state',{cookie:value})).status,401);await f.reopen();assert.equal(await authenticated(f,value),false);assert.ok(sessionRecords(await disk(f)).every(record=>record.expiresAt<=START+30*DAY));
});

test('logout durably revokes only its remembered token before returning success',async t=>{
  const f=await fixture(t),first=cookie(await f.login(true)),second=cookie(await f.login(true));assert.equal(sessionRecords(await disk(f)).length,2);
  const result=await f.request('/api/auth/logout',{method:'POST',json:{},cookie:first});assert.equal(result.status,200);assert.match(result.headers.get('set-cookie'),/redpilot_session=;/);assert.match(result.headers.get('set-cookie'),/Max-Age=0(?:;|$)/i);
  const revokedHash=createHash('sha256').update(token(first)).digest('hex');assert.equal(sessionRecords(await disk(f)).some(record=>record.tokenHash===revokedHash),false);assert.equal(await authenticated(f,first),false);assert.equal(await authenticated(f,second),true);
  await f.reopen();assert.equal(await authenticated(f,first),false);assert.equal(await authenticated(f,second),true);
});

test('resetting configured credentials invalidates all prior persistent tokens on reopen',async t=>{
  const f=await fixture(t),value=cookie(await f.login(true)),newPassword='New-test-only-'+randomBytes(18).toString('hex');
  await configureAuth({directory:f.directory,email:f.email,password:newPassword});await f.reopen();assert.equal(await authenticated(f,value),false);assert.equal((await f.request('/api/state',{cookie:value})).status,401);
  assert.equal((await f.login(true)).status,401);const replacement=await f.login(true,{password:newPassword});assert.equal(replacement.status,200);assert.notEqual(cookie(replacement),value);assert.equal(await authenticated(f,cookie(replacement)),true);
});

test('forged, hashed and duplicate cookies cannot resume a remembered session',async t=>{
  const f=await fixture(t),value=cookie(await f.login(true)),hash=createHash('sha256').update(token(value)).digest('hex');await f.reopen();
  for(const fake of ['redpilot_session='+randomBytes(32).toString('base64url'),'redpilot_session='+hash,value+'; '+value,'redpilot_session=invalid']) {
    assert.equal(await authenticated(f,fake),false);assert.equal((await f.request('/api/state',{cookie:fake})).status,401);
  }
  assert.equal(await authenticated(f,value),true);
});

test('damaged, mismatched or invalid persisted sessions fail closed while allowing a fresh credential login',async t=>{
  const f=await fixture(t),value=cookie(await f.login(true)),stored=await disk(f),filename=path.join(f.directory,'sessions.json');
  const corrupt=['{truncated-json',JSON.stringify({...stored,credentialFingerprint:'0'.repeat(64)}),JSON.stringify({...stored,sessions:[{...stored.sessions[0],expiresAt:START+365*DAY}]}),JSON.stringify({...stored,sessions:[{...stored.sessions[0],createdAt:String(START)}]})];
  for(const contents of corrupt) {
    await writeFile(filename,contents,{mode:0o600});await f.reopen();assert.equal(await authenticated(f,value),false);assert.equal((await f.request('/api/state',{cookie:value})).status,401);const fresh=await f.login(true);assert.equal(fresh.status,200);assert.equal(await authenticated(f,cookie(fresh)),true);
  }
});

test('failed persistence rolls login and logout back without issuing a new cookie or silently revoking access',async t=>{
  const f=await fixture(t),value=cookie(await f.login(true)),filename=path.join(f.directory,'sessions.json'),backup=filename+'.test-backup';
  await rename(filename,backup);await mkdir(filename);
  try {
    const failedLogin=await f.login(true);assert.equal(failedLogin.status,503);assert.equal(failedLogin.headers.has('set-cookie'),false);assert.equal(await authenticated(f,value),true);
    const failedLogout=await f.request('/api/auth/logout',{method:'POST',json:{},cookie:value});assert.equal(failedLogout.status,503);assert.equal(failedLogout.headers.has('set-cookie'),false);assert.equal(await authenticated(f,value),true);
  } finally {await rm(filename,{recursive:true,force:true});await rename(backup,filename);}
  assert.equal((await f.request('/api/auth/logout',{method:'POST',json:{},cookie:value})).status,200);await f.reopen();assert.equal(await authenticated(f,value),false);
});

test('concurrent remembered-session logout requests serialize durable revocation',async t=>{
  const f=await fixture(t),value=cookie(await f.login(true));
  const results=await Promise.all([f.request('/api/auth/logout',{method:'POST',json:{},cookie:value}),f.request('/api/auth/logout',{method:'POST',json:{},cookie:value})]);
  assert.ok(results.every(result=>result.status===200));assert.equal(sessionRecords(await disk(f)).length,0);await f.reopen();assert.equal(await authenticated(f,value),false);
});

test('login/status/business JSON and static routes never expose passwords, tokens, token hashes or credential hashes',async t=>{
  const f=await fixture(t),login=await f.login(true),value=cookie(login),stored=await disk(f),authRecord=JSON.parse(await readFile(path.join(f.directory,'auth.json'),'utf8'));
  const secrets=[f.password,token(value),authRecord.salt,authRecord.hash,stored.credentialFingerprint,...sessionRecords(stored).map(record=>record.tokenHash)];
  for(const response of [login,await f.request('/api/auth/session',{cookie:value}),await f.request('/api/state',{cookie:value})]) {
    assert.equal(response.status,200);for(const secret of secrets)assert.equal(response.text.includes(secret),false);assert.doesNotMatch(response.text,/"(?:token|tokenHash|sessions|credentialFingerprint)"\s*:/);
  }
  for(const url of ['/sessions.json','/runtime/sessions.json','/auth.json','/runtime/auth.json']) {const response=await f.request(url,{cookie:value});assert.equal(response.status,404);for(const secret of secrets)assert.equal(response.text.includes(secret),false);}
});
