import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { id, now } from './content.mjs';
export async function createStore(root, directory) {
  await mkdir(path.join(directory, 'uploads'), {recursive:true});
  const lockPath = path.join(directory, 'server.lock');
  const acquire = async () => { const f = await open(lockPath, 'wx', 0o600); await f.writeFile(String(process.pid)); await f.close(); };
  try { await acquire(); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(await readFile(lockPath, 'utf8'));
    try { process.kill(pid, 0); throw new Error('数据目录已有运行中的 RedPilot，请勿同时启动两个服务'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await unlink(lockPath); await acquire();
  }
  const filename = path.join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') { await unlink(lockPath); throw new Error('保存的数据无法读取，已保留原文件，请恢复备份'); }
    const plan = JSON.parse(await readFile(path.join(root, 'docs/launch-plan.json'), 'utf8'));
    const refs = JSON.parse(await readFile(path.join(root, 'examples/inspirations/index.json'), 'utf8')).items;
    const draft = JSON.parse(await readFile(path.join(root, 'examples/drafts/inspiration-demo-001.json'), 'utf8'));
    const product = { name:'SimHelper', brand:'人类补丁', stage:plan.product_facts.stage, summary:plan.product_facts.architecture,
      facts:plan.product_facts.documented_capabilities, conditions:plan.product_facts.conditions,
      restrictions:plan.product_facts.unsupported_promises, sources:plan.sources.filter(s=>s.kind==='product').map(s=>s.url), version:id(), updatedAt:now() };
    state = { schemaVersion:1, product, settings:{enabled:false,time:'10:00',timezone:'Asia/Shanghai',mode:'automatic'}, lastDailyKey:null,
      inspirations:refs.map(r=>({ id:r.id,title:r.title,url:r.source_url || r.profile_url,tags:r.tags,note:'',text:'',pool:true,
        assets:r.asset ? ['/examples/inspirations/assets/tayumon-profile.jpg']:[], hashes:r.asset_sha256?[r.asset_sha256]:[],
        status:'analyzed',scope:r.analysis_scope || r.available_evidence.join('、'),analysis:r.analysis,method:'editorial_seed',createdAt:now(),uses:0 })),
      drafts:[{ id:draft.id,title:draft.selected_title,body:draft.body,tags:draft.tags,series:'通信小麻烦',
        slides:draft.slides.map(s=>({headline:Array.isArray(s.headline)?s.headline.join('\n'):s.headline,body:Array.isArray(s.body)?s.body.join('\n'):''})),
        gaps:[],method:'editorial_seed',referenceIds:draft.reference_ids,adaptation:draft.adaptation,productVersion:product.version,
        status:'draft',createdAt:now(),updatedAt:now(),history:[],revision:1 }], jobs:[], events:[] };
  }
  let queue = Promise.resolve();
  async function save() {
    const tmp = filename+'.tmp'; await writeFile(tmp, JSON.stringify(state,null,2), {mode:0o600}); await rename(tmp,filename);
  }
  await save();
  return { get state(){return state;}, directory, save,
    mutate(fn) { const task = queue.then(async()=>{ const backup = structuredClone(state); try { const result = await fn(state); await save(); return result; } catch(err) { state=backup; throw err; } }); queue=task.catch(()=>{}); return task; },
    event(s,type,message) { s.events.unshift({id:id(),type,message,at:now()}); s.events=s.events.slice(0,200); },
    async close() { await queue; await unlink(lockPath).catch(()=>{}); }
  };
}
