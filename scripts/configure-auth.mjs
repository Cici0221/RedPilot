#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAuth } from '../app/auth.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = process.env.REDPILOT_DATA_DIR || path.join(root, 'runtime');
if (process.argv.includes('--help')) {
  console.log('用法：npm run auth:configure\n依次输入邮箱与密码；密码不回显。\n自动化：--json-stdin 从标准输入读取 {email,password}，切勿将密码放入命令行参数。\n配置保存到本机 runtime/auth.json，随后重启服务。');
  process.exit(0);
}

function readHiddenJson() {
  return new Promise((resolve, reject) => {
    const raw = process.stdin.isTTY;
    if (raw) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    let value = '';
    const restore = () => { if (raw) process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', data); };
    const data = chunk => {
      if (chunk.includes('\u0003')) { restore(); reject(new Error('已取消配置')); return; }
      value += chunk;
      if (value.length > 8192) { restore(); reject(new Error('配置输入过长')); return; }
      if (value.includes('\n') || value.includes('\r')) {
        restore(); try { resolve(JSON.parse(value.trim())); } catch { reject(new Error('配置 JSON 格式不正确')); }
      }
    };
    process.stdin.on('data', data);
    process.stdin.once('end', () => { if (!value.trim()) { restore(); reject(new Error('未收到配置')); } else { restore(); try { resolve(JSON.parse(value)); } catch { reject(new Error('配置 JSON 格式不正确')); } } });
  });
}

function prompt(text, hidden = false) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) { reject(new Error('交互配置需要终端；自动化请使用 --json-stdin')); return; }
    process.stdout.write(text);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    let value = '';
    const restore = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', data); process.stdout.write('\n'); };
    const data = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') { restore(); reject(new Error('已取消配置')); return; }
        if (character === '\n' || character === '\r') { restore(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') { if (value) { value = [...value].slice(0,-1).join(''); if (!hidden) process.stdout.write('\b \b'); } continue; }
        if (character >= ' ' && value.length < 2048) { value += character; if (!hidden) process.stdout.write(character); }
      }
    };
    process.stdin.on('data', data);
  });
}

try {
  let input;
  if (process.argv.includes('--json-stdin')) {
    console.log('Ready for local auth JSON on stdin (input hidden).');
    input = await readHiddenJson();
  } else {
    input = { email: await prompt('登录邮箱：'), password: await prompt('登录密码：', true) };
  }
  await configureAuth({ directory, email: input.email, password: input.password });
  input.password = '';
  console.log('登录账号已配置。请重启 RedPilot 服务；旧会话会失效。');
} catch (error) {
  console.error(['InputError','Error'].includes(error.name) ? error.message : '配置未完成');
  process.exitCode = 1;
}
