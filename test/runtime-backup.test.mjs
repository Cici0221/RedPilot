import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {createBackup,verifyBackup,restoreBackup} from '../scripts/runtime-backup.mjs';
import {pruneBackups} from '../scripts/prune-backups.mjs';

const run=promisify(execFile),project=path.resolve(import.meta.dirname,'..');
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'redpilot-backup-')),runtime=path.join(root,'runtime'),model=path.join(root,'model.step'),env=path.join(root,'.env');
  await mkdir(path.join(runtime,'browser-sessions','private-profile'),{recursive:true});await mkdir(path.join(runtime,'uploads'));
  const modelBytes=Buffer.from('ISO-10303-21; fixture geometry END-ISO-10303-21;'),hash=createHash('sha256').update(modelBytes).digest('hex');
  await writeFile(model,modelBytes);await writeFile(env,'REDPILOT_AI_KEY=fixture-env-secret\n');
  const state={productAssets:[{id:'root-model',kind:'model',storage:'linked',sourcePath:model,sha256:hash}],workspaces:{other:{productAssets:[{id:'other-model',kind:'model',storage:'linked',sourcePath:model,sha256:hash}]}}};
  await writeFile(path.join(runtime,'state.json'),JSON.stringify(state));await writeFile(path.join(runtime,'connections.json'),'fixture-private-provider-key');await writeFile(path.join(runtime,'auth.json'),'fixture-password-hash');
  await writeFile(path.join(runtime,'browser-sessions','private-profile','Cookies'),'fixture-encrypted-cookies');await writeFile(path.join(runtime,'uploads','reference.png'),'fixture-reference');
  await symlink('unused-profile-lock',path.join(runtime,'browser-sessions','private-profile','SingletonLock'));
  t.after(()=>rm(root,{recursive:true,force:true}));return {root,runtime,model,env,state,hash,backup:path.join(root,'backup')};
}

test('portable backup copies complete private runtime and all account linked models without changing originals',async t=>{
  const f=await fixture(t),result=await createBackup({runtimeDirectory:f.runtime,outputDirectory:f.backup,envFile:f.env});
  assert.equal(result.materializedModels,2);const manifest=await verifyBackup(f.backup);assert.equal(manifest.files.length,result.files);
  assert.equal((await stat(f.backup)).mode&0o777,0o700);
  for(const file of manifest.files)assert.equal((await stat(path.join(f.backup,file.path))).mode&0o777,0o600);
  const state=JSON.parse(await readFile(path.join(f.backup,'runtime','state.json'),'utf8'));
  for(const model of [state.productAssets[0],state.workspaces.other.productAssets[0]]){assert.equal(model.storage,'managed');assert.equal(model.fileName,f.hash+'.step');assert.equal(Object.hasOwn(model,'sourcePath'),false);}
  assert.deepEqual(JSON.parse(await readFile(path.join(f.runtime,'state.json'),'utf8')),f.state);
  await assert.rejects(stat(path.join(f.runtime,'server.lock')),{code:'ENOENT'});
  assert.equal(manifest.files.some(file=>file.path.endsWith('SingletonLock')),false);
  const restored=path.join(f.root,'restored');await restoreBackup({backupDirectory:f.backup,runtimeDirectory:restored});
  assert.equal(await readFile(path.join(restored,'browser-sessions','private-profile','Cookies'),'utf8'),'fixture-encrypted-cookies');
  assert.equal(await readFile(path.join(restored,'.env'),'utf8'),'REDPILOT_AI_KEY=fixture-env-secret\n');
  assert.equal(await readFile(path.join(restored,'connections.json'),'utf8'),'fixture-private-provider-key');
  await assert.rejects(restoreBackup({backupDirectory:f.backup,runtimeDirectory:restored}),/已存在/);
  const output=await run(process.execPath,[path.join(project,'scripts','runtime-backup.mjs'),'verify','--backup',f.backup]);assert.equal(JSON.parse(output.stdout).verified,true);assert.doesNotMatch(output.stdout,/fixture-.*secret|fixture-private-provider-key|fixture-encrypted-cookies/);
});

test('running service, modified linked model and nested output prevent creation without leaving partial backups',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.runtime,'server.lock'),String(process.pid));
  await assert.rejects(createBackup({runtimeDirectory:f.runtime,outputDirectory:f.backup}),/关闭 RedPilot/);
  await rm(path.join(f.runtime,'server.lock'));await assert.rejects(createBackup({runtimeDirectory:f.runtime,outputDirectory:path.join(f.runtime,'backup')}),/运行目录之外/);
  await writeFile(f.model,'changed geometry');await assert.rejects(createBackup({runtimeDirectory:f.runtime,outputDirectory:f.backup}),/模型已改变/);
  await assert.rejects(stat(f.backup),{code:'ENOENT'});await assert.rejects(stat(path.join(f.runtime,'server.lock')),{code:'ENOENT'});
});

test('an explicit incomplete backup preserves runtime and reports missing models without pretending to contain them',async t=>{
  const f=await fixture(t);await rm(f.model);
  await assert.rejects(createBackup({runtimeDirectory:f.runtime,outputDirectory:f.backup}),{code:'ENOENT'});
  const result=await createBackup({runtimeDirectory:f.runtime,outputDirectory:f.backup,allowMissingLinked:true});assert.equal(result.missingLinkedModels,2);
  const manifest=await verifyBackup(f.backup);assert.equal(manifest.missingLinkedAssets.length,2);
  const restored=path.join(f.root,'restored');await restoreBackup({backupDirectory:f.backup,runtimeDirectory:restored});
  assert.deepEqual(JSON.parse(await readFile(path.join(restored,'state.json'),'utf8')),f.state);
  manifest.missingLinkedAssets=[];await writeFile(path.join(f.backup,'manifest.json'),JSON.stringify(manifest));await assert.rejects(verifyBackup(f.backup),/未声明/);
});

test('checksums, unexpected files, symlinks and traversal manifests block restore',async t=>{
  const f=await fixture(t);await createBackup({runtimeDirectory:f.runtime,outputDirectory:f.backup});
  const secret=path.join(f.backup,'runtime','connections.json'),original=await readFile(secret);await writeFile(secret,'tampered');
  await assert.rejects(restoreBackup({backupDirectory:f.backup,runtimeDirectory:path.join(f.root,'restore-failed')}),/校验失败/);await writeFile(secret,original);
  await writeFile(path.join(f.backup,'extra'),'extra');await assert.rejects(verifyBackup(f.backup),/清单不一致/);await rm(path.join(f.backup,'extra'));
  await rm(secret);await symlink(f.env,secret);await assert.rejects(verifyBackup(f.backup),/符号链接/);await rm(secret);await writeFile(secret,original);
  const manifestFile=path.join(f.backup,'manifest.json'),manifest=JSON.parse(await readFile(manifestFile,'utf8'));manifest.files[0].path='../external.env';await writeFile(manifestFile,JSON.stringify(manifest));await assert.rejects(verifyBackup(f.backup),/无效路径/);
});

test('deployment definition keeps runtime outside images and includes browser, display and Chinese rendering dependencies',async()=>{
  const docker=await readFile(path.join(project,'deploy','Dockerfile'),'utf8'),compose=await readFile(path.join(project,'deploy','compose.yaml'),'utf8');
  assert.match(docker,/chromium.*xvfb.*fonts-noto-cjk/);assert.match(docker,/USER node/);assert.doesNotMatch(docker,/COPY\s+(?:\.\s|runtime|\.env)/);
  assert.match(compose,/127\.0\.0\.1:.*4317/);assert.match(compose,/REDPILOT_ISOLATED_BROWSER: \"true\"/);assert.match(compose,/healthz/);assert.match(compose,/stop_grace_period: 2m/);assert.match(compose,/REDPILOT_RUNTIME_DIR/);assert.doesNotMatch(compose,/privileged|no-sandbox|SYS_ADMIN/);
  const https=await readFile(path.join(project,'deploy','compose.https.yaml'),'utf8'),caddy=await readFile(path.join(project,'deploy','Caddyfile'),'utf8');
  assert.match(https,/caddy:2-alpine/);assert.match(https,/443:443/);assert.match(https,/caddy_data:/);assert.match(caddy,/reverse_proxy redpilot:4317/);assert.match(caddy,/REDPILOT_DOMAIN/);
});

test('retention removes only verified old backups and always keeps seven usable copies',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'history');await mkdir(directory);
  for(let day=1;day<=9;day++) {
    const folder=path.join(directory,`redpilot-203001${String(day).padStart(2,'0')}T030000Z`);await createBackup({runtimeDirectory:f.runtime,outputDirectory:folder});
    const file=path.join(folder,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));manifest.createdAt=`2030-01-${String(day).padStart(2,'0')}T03:00:00Z`;await writeFile(file,JSON.stringify(manifest));
  }
  const invalid=path.join(directory,'redpilot-20200101T030000Z');await mkdir(invalid);await writeFile(path.join(invalid,'keep-this'),'not a verified backup');
  assert.deepEqual(await pruneBackups(directory,7),{retained:7,removed:2});await assert.rejects(stat(path.join(directory,'redpilot-20300101T030000Z')),{code:'ENOENT'});
  assert.ok((await stat(path.join(directory,'redpilot-20300109T030000Z'))).isDirectory());assert.equal(await readFile(path.join(invalid,'keep-this'),'utf8'),'not a verified backup');
});
