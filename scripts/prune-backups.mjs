#!/usr/bin/env node
import {readdir,lstat,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBackup} from './runtime-backup.mjs';

export async function pruneBackups(directory,keep=7) {
  if(!Number.isInteger(keep)||keep<1||keep>365)throw Error('保留数量不正确');
  const verified=[];
  for(const name of await readdir(directory)) {
    if(!/^redpilot-\d{8}T\d{6}Z$/.test(name))continue;
    const target=path.join(directory,name),info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())continue;
    try {const manifest=await verifyBackup(target);if(!manifest.missingLinkedAssets?.length&&Number.isFinite(Date.parse(manifest.createdAt)))verified.push({target,createdAt:manifest.createdAt});}catch{}
  }
  verified.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));let removed=0;
  for(const item of verified.slice(keep)){await rm(item.target,{recursive:true});removed++;}
  return {retained:Math.min(keep,verified.length),removed};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),directory=args[args.indexOf('--directory')+1],keep=Number(args[args.indexOf('--keep')+1]||7);
  if(!args.includes('--directory')||!directory)throw Error('请指定 --directory');
  pruneBackups(path.resolve(directory),keep).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('备份清理未完成');process.exitCode=1;});
}
