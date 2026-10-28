#!/usr/bin/env node
import {createReadStream} from 'node:fs';
import {access,chmod,copyFile,lstat,mkdir,open,readFile,readdir,realpath,rename,rm,unlink,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCHEMA=1, MAX_MANIFEST=16*1024*1024;
const ephemeral=new Set(['server.lock','SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort']);
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const safePath=value=>typeof value==='string'&&value.length>0&&value.length<4096&&!value.includes('\\')&&!path.posix.isAbsolute(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\u0000-\u001f]/.test(value);
const exists=async file=>{try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
async function hashFile(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function filesAt(root,{skipTemporary=false}={}) {
  const files=[];
  async function walk(directory,relative='') {
    for(const name of (await readdir(directory)).sort()) {
      if(skipTemporary&&(ephemeral.has(name)||name==='state.json.tmp'))continue;
      const relativeFile=relative?relative+'/'+name:name,file=path.join(directory,name),info=await lstat(file);
      if(!safePath(relativeFile))throw Error('文件路径不受支持');
      if(info.isSymbolicLink())throw Error('备份目录不能包含符号链接');
      if(info.isDirectory())await walk(file,relativeFile);
      else if(info.isFile())files.push({path:relativeFile,size:info.size});
      else throw Error('备份目录包含不可复制的特殊文件');
    }
  }
  const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw Error('需要真实目录');
  await walk(root);return files;
}
async function privateCopy(source,destination){
  if(!(await lstat(source)).isFile())throw Error('来源必须是普通文件');
  await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await copyFile(source,destination);await chmod(destination,0o600);
}
async function lockStopped(runtimeDirectory){
  const lock=path.join(runtimeDirectory,'server.lock');
  if(await exists(lock)) {
    const pid=Number(await readFile(lock,'utf8'));
    if(!Number.isSafeInteger(pid)||pid<=0)throw Error('无法确认运行状态，请先关闭 RedPilot');
    try{process.kill(pid,0);throw Error('请先关闭 RedPilot 再备份');}catch(error){if(error.code!=='ESRCH')throw error;}
    await unlink(lock);
  }
  let file;try{file=await open(lock,'wx',0o600);}catch{throw Error('服务正在启动，请关闭后重试备份');}
  await file.writeFile(String(process.pid));await file.close();
  return async()=>{if(await readFile(lock,'utf8').catch(()=>null)===String(process.pid))await unlink(lock);};
}
function linkedAssets(state){
  const result=[];
  const visit=value=>{if(!value||typeof value!=='object')return;if(value.storage==='linked'&&typeof value.sourcePath==='string')result.push(value);for(const child of Object.values(value))visit(child);};visit(state);return result;
}

/** A portable, private, offline directory backup. It never reads credentials into output. */
export async function createBackup({runtimeDirectory,outputDirectory,envFile,allowMissingLinked=false}={}) {
  const source=await realpath(path.resolve(runtimeDirectory)),destination=path.resolve(outputDirectory);
  const destinationParent=await realpath(path.dirname(destination));
  if(inside(source,destination)||inside(source,destinationParent))throw Error('备份请保存到运行目录之外');
  if(await exists(destination))throw Error('备份目录已存在，请使用新目录');
  const unlock=await lockStopped(source),staging=path.join(destinationParent,'.redpilot-backup-'+randomUUID());
  try {
    await mkdir(staging,{mode:0o700});const runtime=path.join(staging,'runtime');await mkdir(runtime,{mode:0o700});
    const originals=await filesAt(source,{skipTemporary:true});
    for(const file of originals) {
      const input=path.join(source,file.path),output=path.join(runtime,file.path),before=await hashFile(input);
      await privateCopy(input,output);
      if(before!==await hashFile(input)||before!==await hashFile(output))throw Error('运行资料仍在变化，请关闭浏览器后重新备份');
    }
    const stateFile=path.join(runtime,'state.json'),state=JSON.parse(await readFile(stateFile,'utf8'));
    let materialized=0;const missingLinkedAssets=[];
    for(const asset of linkedAssets(state)) {
      let filename;try{filename=await realpath(asset.sourcePath);}catch(error){if(!allowMissingLinked||error.code!=='ENOENT')throw error;missingLinkedAssets.push({id:asset.id,sourcePath:asset.sourcePath,sha256:asset.sha256||null});continue;}
      const info=await lstat(filename);
      if(!info.isFile()||info.size>1024**3)throw Error('关联的模型无法备份，请检查源文件');
      const hash=await hashFile(filename);
      if(asset.sha256&&hash!==asset.sha256)throw Error('关联模型已改变，请重新导入模型后再备份');
      const extension=path.extname(filename).toLowerCase();if(!/^\.[a-z\d]{1,10}$/.test(extension))throw Error('关联模型格式不受支持');
      const fileName=hash+extension,target=path.join(runtime,'product-assets','files',fileName);
      await privateCopy(filename,target);if(hash!==await hashFile(target)||hash!==await hashFile(filename))throw Error('模型仍在变化，请稍后重试');
      asset.storage='managed';asset.fileName=fileName;delete asset.sourcePath;materialized++;
    }
    await writeFile(stateFile,JSON.stringify(state,null,2),{mode:0o600});
    if(envFile)await privateCopy(path.resolve(envFile),path.join(staging,'config','app.env'));
    const records=await filesAt(staging),files=[];
    for(const file of records)files.push({...file,sha256:await hashFile(path.join(staging,file.path))});
    const manifest={schemaVersion:SCHEMA,createdAt:new Date().toISOString(),materializedModels:materialized,missingLinkedAssets,files};
    await writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    await verifyBackup(staging);await rename(staging,destination);
    return {directory:destination,files:files.length,bytes:files.reduce((sum,file)=>sum+file.size,0),materializedModels:materialized,missingLinkedModels:missingLinkedAssets.length};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}finally{await unlock();}
}

export async function verifyBackup(backupDirectory) {
  const root=path.resolve(backupDirectory),manifestFile=path.join(root,'manifest.json'),info=await lstat(manifestFile);
  if(!info.isFile()||info.size>MAX_MANIFEST)throw Error('备份清单不可用');
  const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
  if(manifest.schemaVersion!==SCHEMA||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>100000)throw Error('备份清单格式不正确');
  const names=new Set();
  for(const file of manifest.files) {
    if(!safePath(file.path)||file.path==='manifest.json'||(!file.path.startsWith('runtime/')&&file.path!=='config/app.env')||names.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f\d]{64}$/.test(file.sha256))throw Error('备份清单含无效路径或重复文件');
    names.add(file.path);
  }
  if(!names.has('runtime/state.json'))throw Error('备份缺少运行数据');
  const actual=(await filesAt(root)).filter(file=>file.path!=='manifest.json');
  if(actual.length!==names.size||actual.some(file=>!names.has(file.path)))throw Error('备份文件与清单不一致');
  for(const file of manifest.files) {
    const filename=path.join(root,file.path),stat=await lstat(filename);
    if(stat.size!==file.size||await hashFile(filename)!==file.sha256)throw Error('备份校验失败，文件已改变或不完整');
  }
  const state=JSON.parse(await readFile(path.join(root,'runtime','state.json'),'utf8'));
  const missing=linkedAssets(state).map(asset=>({id:asset.id,sourcePath:asset.sourcePath,sha256:asset.sha256||null}));
  if(JSON.stringify(missing)!==JSON.stringify(manifest.missingLinkedAssets||[]))throw Error('备份仍包含未声明的外部模型引用');
  return manifest;
}

/** Restore only into a new directory: an existing installation is never overwritten. */
export async function restoreBackup({backupDirectory,runtimeDirectory}={}) {
  const source=path.resolve(backupDirectory),destination=path.resolve(runtimeDirectory),manifest=await verifyBackup(source);
  if(await exists(destination))throw Error('恢复目标已存在，请使用新目录');
  const parent=await realpath(path.dirname(destination));if(inside(source,parent))throw Error('恢复目录不能放在备份内部');
  const staging=path.join(parent,'.redpilot-restore-'+randomUUID());
  try {
    await mkdir(staging,{mode:0o700});
    for(const file of manifest.files) {
      if(file.path==='runtime/.env'&&manifest.files.some(record=>record.path==='config/app.env'))continue;
      const relative=file.path==='config/app.env'?'.env':file.path.slice('runtime/'.length);
      if(ephemeral.has(path.basename(relative)))continue;
      const output=path.join(staging,relative);await privateCopy(path.join(source,file.path),output);
      if(file.sha256!==await hashFile(output))throw Error('恢复校验失败');
    }
    await rename(staging,destination);return {directory:destination,files:manifest.files.length};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}

async function cli(args) {
  const command=args.shift(),options={};
  while(args.length){const name=args.shift();if(name==='--allow-missing-linked'){options[name]=true;continue;}if(!['--runtime','--output','--backup','--env-file'].includes(name)||!args.length)throw Error('参数不正确');options[name]=args.shift();}
  if(command==='create'&&options['--runtime']&&options['--output'])return createBackup({runtimeDirectory:options['--runtime'],outputDirectory:options['--output'],envFile:options['--env-file'],allowMissingLinked:options['--allow-missing-linked']===true});
  if(command==='verify'&&options['--backup']){const manifest=await verifyBackup(options['--backup']);return {verified:true,files:manifest.files.length,missingLinkedModels:manifest.missingLinkedAssets?.length||0};}
  if(command==='restore'&&options['--backup']&&options['--runtime'])return restoreBackup({backupDirectory:options['--backup'],runtimeDirectory:options['--runtime']});
  throw Error('用法：create --runtime 目录 --output 新备份目录 [--env-file 文件]；verify --backup 备份目录；restore --backup 备份目录 --runtime 新目录');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error instanceof SyntaxError?'运行数据或备份清单格式不正确':error.code?'备份操作未完成，请检查目录和文件权限':error.message);process.exitCode=1;});
