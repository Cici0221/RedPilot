import http from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStore } from './store.mjs';
import { id, now, InputError, str, lines, sourceUrl, noteKey, validateProduct, validateDraft, checks, templateDraft, dateParts, dailyKey } from './content.mjs';
import { aiReady, analyze, generate, imagesFor } from './ai.mjs';
import { accountById, createAccount, updateAccount, setDefaultAccount, archiveAccount, saveAccountSettings, syncDefaultSettings } from './accounts.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_BODY = 24*1024*1024;
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf'};
function requireItem(array,key) { const item = array.find(x=>x.id===key); if(!item) throw new InputError('记录不存在',404); return item; }
function json(res, data, status=200) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('需要 JSON 请求',415);
  const chunks=[];let size=0; for await(const c of req) {size+=c.length;if(size>MAX_BODY)throw new InputError('上传总大小不能超过 16MB',413);chunks.push(c);}
  try { const parsed=JSON.parse(Buffer.concat(chunks).toString()); if(!parsed || Array.isArray(parsed) || typeof parsed!=='object') throw 0; return parsed; } catch { throw new InputError('JSON 格式不正确'); }
}
function validateFile(f) {
  const name=str(f.name,200,true);const data=str(f.data,12*1024*1024,true);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new InputError('图片编码不正确');
  const buf=Buffer.from(data,'base64'); if(buf.length>8*1024*1024)throw new InputError('单张图片不能超过 8MB');
  let ext;
  if(buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='png';
  else if(buf[0]===255&&buf[1]===216&&buf[2]===255)ext='jpg';
  else if(buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP')ext='webp';
  else throw new InputError('仅支持 PNG、JPEG 和 WebP 图片');
  return {name,buf,ext,hash:createHash('sha256').update(buf).digest('hex')};
}
export async function createApp({root=ROOT,directory=process.env.REDPILOT_DATA_DIR || path.join(root,'runtime'),env=process.env,fetcher=fetch}={}) {
  const store=await createStore(root,directory,{legacyBridgeAccountId:env.REDPILOT_ACCOUNT_ID || ''});
  const bridgeReady=()=>Boolean(env.REDPILOT_PUBLISH_URL&&env.REDPILOT_PUBLISH_TOKEN);
  const capabilities=()=>({ai:aiReady(env),model:env.REDPILOT_AI_MODEL||null,publisher:bridgeReady(),
    account:accountById(store.state).bridgeAccountId||null,
    accounts:Object.fromEntries(store.state.accounts.map(account=>[account.id,{publisher:bridgeReady()&&Boolean(account.bridgeAccountId)}])),
    feishu:false,linkReader:false});
  // Persist a result-unknown state after restart; never automatically retry an interrupted write.
  await store.mutate(s=>{for(const j of s.jobs)if(j.status==='publishing'){j.status='uncertain';j.error='服务重启，发布结果需要核对';}});
  async function makeDraft(s,referenceId,instruction='',mode='综合借鉴',method='auto',accountId=s.defaultAccountId) {
    const account=accountById(s,accountId);
    const ref=referenceId?requireItem(s.inspirations,referenceId):null;
    const useAI=method!=='template'&&aiReady(env);
    const accountInstruction=`账号：${account.name}。账号类型：${account.type==='official'?'官方':'普通'}。账号定位与备注：${account.notes || '无'}。本次要求：${instruction}`;
    const data=useAI?await generate(env,s.product,ref,accountInstruction,mode,ref?await imagesFor(ref,root,directory):[],fetcher):templateDraft(s.product,ref,instruction);
    if(method==='ai'&&!useAI)throw new InputError('AI 未配置，请选择本地事实模板',409);
    const draft={...data,id:id(),accountId:account.id,referenceIds:ref?[ref.id]:[],instruction,mode,productVersion:s.product.version,status:'draft',createdAt:now(),updatedAt:now(),history:[],revision:1};
    s.drafts.unshift(draft);if(ref)ref.uses++;
    store.event(s,'generation',`[${account.name}] ${draft.method==='ai'?'AI':'本地模板'}生成：${draft.title}`);return draft;
  }
  function newJob(s,draft,scheduledAt,accountId=draft.accountId) {
    if(accountId!==draft.accountId)throw new InputError('目标账号与草稿所属账号不一致，请先修改草稿账号',409);
    const account=accountById(s,accountId);
    if(!account.enabled)throw new InputError('账号已暂停，请先启用账号',409);
    if(s.jobs.some(j=>j.draftId===draft.id&&!['cancelled','failed'].includes(j.status)))throw new InputError('该草稿已有发布任务，请先取消或核对原任务',409);
    const issues=checks(draft,s.product);if(issues.length)throw new InputError(issues.join('；'),409);
    if(!draft.approved)throw new InputError('请先核对图文并标记审核通过',409);
    const j={id:id(),accountId:account.id,accountName:account.name,draftId:draft.id,draftRevision:draft.revision,scheduledAt,status:'scheduled',createdAt:now(),idempotencyKey:id(),attempts:0,title:draft.title};
    s.jobs.push(j);draft.status='scheduled';store.event(s,'schedule',`[${account.name}] 已排期：${draft.title}`);return j;
  }
  async function dispatch(s,j,verify=false) {
    const account=accountById(s,j.accountId,true);
    if(!verify&&(!account.enabled||account.archived)){j.status='blocked';j.error='账号已暂停或归档；没有进行真实发布';return;}
    if(!bridgeReady()||(!verify&&!account.bridgeAccountId)){
      j.status=verify?'uncertain':'blocked';j.error='该账号的发布器或发布账号 ID 尚未配置；没有进行真实发布';return;
    }
    if(verify&&!j.account){j.status='uncertain';j.error='缺少首次提交时的账号标识，需要人工核对平台记录';return;}
    const d=requireItem(s.drafts,j.draftId);
    if(!verify){
      const issues=checks(d,s.product);
      if(issues.length||d.revision!==j.draftRevision||!d.approved||d.accountId!==j.accountId){j.status='blocked';j.error=issues.join('；')||'草稿版本变更或尚未审核';return;}
      j.status='publishing';j.attempts++;j.account=account.bridgeAccountId;
      // Write intent before the external side effect, even if the request later fails.
      await store.save();
    }
    try {
      const res=await fetcher(env.REDPILOT_PUBLISH_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.REDPILOT_PUBLISH_TOKEN}`,'Idempotency-Key':j.idempotencyKey},
        body:JSON.stringify({action:verify?'verify':'publish',idempotencyKey:j.idempotencyKey,accountId:j.account,jobId:j.id,
          post:{title:d.title,body:d.body,tags:d.tags,slides:d.slides,brand:s.product.brand,product:s.product.name,design:'blue-white-v1'},noteUrl:j.noteUrl||null})});
      if(!res.ok)throw new Error('bridge_error');
      const result=await res.json();
      const parsed=result.noteUrl?new URL(result.noteUrl):null;
      if(result.status==='published'&&result.verified===true&&result.accountId===j.account&&parsed?.protocol==='https:'&&['www.xiaohongshu.com','xiaohongshu.com'].includes(parsed.hostname)&&/^\/(explore|discovery\/item)\/[a-f\d]{24}(?:\/|$)/i.test(parsed.pathname)) {
        j.status='published';j.noteUrl=parsed.href;j.publishedAt=now();j.error=null;d.status='published';
      } else {j.status='uncertain';j.error='发布器未返回匹配账号且经过核对的笔记链接，请核对后处理';}
    } catch {j.status='uncertain';j.error='发布器请求未完成或返回异常；为防止重复发布，不会自动重发';}
    store.event(s,'publish',`[${j.accountName}] ${j.status==='published'?'已核对发布':'待核对'}：${j.title}`);
  }
  let ticking=false;
  async function tick(date=new Date()) {
    if(ticking)return;ticking=true;
    try {await store.mutate(async s=>{
      for(const account of s.accounts.filter(item=>item.enabled&&!item.archived)) {
        const setting=account.settings,p=dateParts(date,setting.timezone),key=dailyKey(date,setting.timezone);
        if(!setting.enabled||`${p.hour}:${p.minute}`<setting.time||account.lastDailyKey===key)continue;
        account.lastDailyKey=key;
        if(!aiReady(env)){store.event(s,'blocked',`[${account.name}] 每日任务跳过：AI 模型未配置`);continue;}
        const ref=s.inspirations.filter(r=>r.pool&&(r.analysis||r.text||r.assets.length)).sort((a,b)=>a.uses-b.uses)[0];
        try {
          const d=await makeDraft(s,ref?.id,'轮换具体场景，避免与近期草稿和已发布内容重复。近期标题：'+s.drafts.filter(x=>x.accountId===account.id).slice(0,15).map(x=>x.title).join('；'),'综合借鉴','auto',account.id);
          const duplicate=s.drafts.some(x=>x.accountId===account.id&&x.id!==d.id&&x.title.replace(/\s/g,'')===d.title.replace(/\s/g,''));
          if(duplicate)d.gaps.push('与该账号已有草稿标题重复，请改写选题');
          const issues=checks(d,s.product);
          if(issues.length||setting.mode==='review'){store.event(s,'review',`[${account.name}] 待人工核对：${d.title}${issues.length?'（'+issues.join('；')+'）':''}`);}
          else {d.approved=true;newJob(s,d,date.toISOString());}
        }catch{store.event(s,'blocked',`[${account.name}] 每日生成失败，请检查模型配置或补充资料`);}
      }
      syncDefaultSettings(s);
      for(const j of s.jobs.filter(j=>j.status==='scheduled'&&new Date(j.scheduledAt)<=date))await dispatch(s,j);
    });} finally {ticking=false;}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const host=req.headers.host||'';
      if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))throw new InputError('仅允许本机访问',403);
      const url=new URL(req.url,`http://${host}`), pathname=decodeURIComponent(url.pathname);
      if(pathname.startsWith('/api/')) {
        if(req.method==='GET'&&pathname==='/api/state')return json(res,{...store.state,capabilities:capabilities(),draftChecks:Object.fromEntries(store.state.drafts.map(d=>[d.id,checks(d,store.state.product)]))});
        if(req.method==='GET'&&pathname==='/api/health')return json(res,{ok:true});
        if(!['POST','PUT','DELETE'].includes(req.method))throw new InputError('接口不存在',404);
        if(req.headers.origin!==`http://${host}`)throw new InputError('请求来源不匹配，请刷新本地页面',403);
        const b=await body(req);
        const result=await store.mutate(async s=>{
          if(req.method==='PUT'&&pathname==='/api/product') {s.product=validateProduct(b);s.drafts.forEach(d=>{if(d.status!=='published')d.approved=false;});store.event(s,'product','产品资料已更新，未发布草稿需要重新核对');return s.product;}
          if(req.method==='PUT'&&pathname==='/api/settings') {const settings=saveAccountSettings(s,s.defaultAccountId,b);store.event(s,'settings','默认账号每日设置已更新');return settings;}
          if(req.method==='POST'&&pathname==='/api/accounts'){const account=createAccount(s,b);store.event(s,'account',`已添加账号：${account.name}`);return account;}
          const accountRoute=pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(default|archive|settings))?$/);
          if(accountRoute){const account=accountById(s,accountRoute[1]);const action=accountRoute[2];
            if(req.method==='PUT'&&!action){const result=updateAccount(s,account.id,b);store.event(s,'account',`账号已更新：${result.name}`);return result;}
            if(req.method==='POST'&&action==='default'){setDefaultAccount(s,account.id);store.event(s,'account',`默认账号：${account.name}`);return account;}
            if(req.method==='POST'&&action==='archive'){archiveAccount(s,account.id);store.event(s,'account',`账号已归档：${account.name}`);return account;}
            if(req.method==='PUT'&&action==='settings'){const settings=saveAccountSettings(s,account.id,b);store.event(s,'settings',`[${account.name}] 每日设置已更新`);return settings;}
          }
          if(req.method==='POST'&&pathname==='/api/inspirations') {
            const title=str(b.title||'未命名灵感',160,true),url=sourceUrl(b.url),note=str(b.note||'',2000),text=str(b.text||'',16000),tags=lines(b.tags||[],10);
            if(!Array.isArray(b.files)||b.files.length>6)throw new InputError('每组最多 6 张截图');
            const files=b.files.map(validateFile);if(files.reduce((n,f)=>n+f.buf.length,0)>16*1024*1024)throw new InputError('截图总大小不能超过 16MB');
            if(!url&&!files.length&&!text)throw new InputError('请提供链接、截图或正文');
            let existing=s.inspirations.find(r=>(url&&noteKey(r.url)===noteKey(url))||files.some(f=>r.hashes.includes(f.hash)));
            if(b.targetId)existing=requireItem(s.inspirations,b.targetId);
            const r=existing||{id:id(),title,url,note,text,tags,assets:[],hashes:[],pool:true,status:'saved',uses:0,createdAt:now()};
            if(new Set([...r.hashes,...files.map(f=>f.hash)]).size>6)throw new InputError('同一收藏最多保存 6 张截图');
            let added=0;for(const f of files){if(r.hashes.includes(f.hash))continue;const filename=`${f.hash}.${f.ext}`;await writeFile(path.join(directory,'uploads',filename),f.buf,{mode:0o600});r.hashes.push(f.hash);r.assets.push('/uploads/'+filename);added++;}
            const changed=added>0||Boolean(text&&text!==r.text)||Boolean(note&&note!==r.note);
            if(existing){if(text)r.text=text;if(note)r.note=note;if(!r.url)r.url=url;r.tags=[...new Set([...r.tags,...tags])];}
            if(!existing||changed){r.status=r.assets.length||r.text?'ready':'needs_source';r.analysis=null;r.method=null;}
            if(!existing||changed)r.scope=r.assets.length?'仅已上传截图与粘贴正文':r.text?'仅粘贴正文；链接未抓取':'仅保存链接；网页未读取';
            if(!existing)s.inspirations.unshift(r);
            store.event(s,'inspiration',`${existing?'合并收藏':'新增收藏'}：${r.title}`);return {item:r,merged:Boolean(existing)};
          }
          let m=pathname.match(/^\/api\/inspirations\/([^/]+)(?:\/(analyze))?$/);
          if(m){const r=requireItem(s.inspirations,m[1]);
            if(req.method==='DELETE'){s.inspirations=s.inspirations.filter(x=>x.id!==r.id);return {ok:true};}
            if(req.method==='PUT'){if('pool'in b)r.pool=Boolean(b.pool);if('title'in b)r.title=str(b.title,160,true);if('tags'in b)r.tags=lines(b.tags,10);return r;}
            if(req.method==='POST'&&m[2]){r.analysis=await analyze(env,r,await imagesFor(r,root,directory),s.product,fetcher);r.status='analyzed';r.method='ai';r.analyzedAt=now();store.event(s,'analysis',`完成参考分析：${r.title}`);return r;}
          }
          if(req.method==='POST'&&pathname==='/api/drafts'){return makeDraft(s,b.referenceId,str(b.instruction||'',2000),str(b.mode||'综合借鉴',80),b.method||'auto',b.accountId||s.defaultAccountId);}
          m=pathname.match(/^\/api\/drafts\/([^/]+)(?:\/(approve|schedule|duplicate))?$/);
          if(m){const d=requireItem(s.drafts,m[1]);
            if(m[2]==='duplicate'&&req.method==='POST'){const target=accountById(s,b.accountId||(accountById(s,d.accountId,true).archived?s.defaultAccountId:d.accountId));const copy={...structuredClone(d),accountId:target.id,id:id(),status:'draft',approved:false,history:[],revision:1,createdAt:now(),updatedAt:now()};s.drafts.unshift(copy);return copy;}
            if(s.jobs.some(j=>j.draftId===d.id&&!['cancelled','failed'].includes(j.status)))throw new InputError('请先取消排期；已发布或待核对的稿件可复制为新草稿',409);
            if(req.method==='DELETE'){s.drafts=s.drafts.filter(x=>x.id!==d.id);return {ok:true};}
            if(req.method==='PUT'){const account=accountById(s,b.accountId||d.accountId);const data={...validateDraft(b),accountId:account.id};d.history.unshift({at:d.updatedAt,title:d.title,body:d.body,slides:d.slides,tags:d.tags});d.history=d.history.slice(0,20);Object.assign(d,data,{productVersion:s.product.version,approved:false,revision:d.revision+1,updatedAt:now()});return d;}
            if(m[2]==='approve'&&req.method==='POST'){const issues=checks(d,s.product);if(issues.length)throw new InputError(issues.join('；'),409);d.approved=true;return d;}
            if(m[2]==='schedule'&&req.method==='POST'){const at=new Date(b.scheduledAt);if(!Number.isFinite(at.valueOf())||at<=new Date())throw new InputError('请选择未来的发布时间');return newJob(s,d,at.toISOString(),b.accountId||d.accountId);}
          }
          m=pathname.match(/^\/api\/jobs\/([^/]+)\/(cancel|retry|verify)$/);
          if(m&&req.method==='POST'){const j=requireItem(s.jobs,m[1]);
            if(m[2]==='cancel'){if(['publishing','uncertain','published'].includes(j.status))throw new InputError('当前任务需要先核对发布结果，不能直接取消',409);j.status='cancelled';const d=requireItem(s.drafts,j.draftId);d.status='draft';return j;}
            if(m[2]==='retry'){if(j.status!=='blocked'||j.attempts>0)throw new InputError('只有从未提交的阻塞任务才能重新入队',409);j.status='scheduled';j.error=null;return j;}
            if(m[2]==='verify'){if(j.status!=='uncertain')throw new InputError('只有待核对任务可查询发布结果',409);await dispatch(s,j,true);return j;}
          }
          throw new InputError('接口不存在',404);
        });return json(res,result);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new InputError('请求不支持',405);
      let filename;
      if(pathname.startsWith('/uploads/')) {if(!/^\/uploads\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(pathname))throw new InputError('文件不存在',404);filename=path.join(directory,'uploads',path.basename(pathname));}
      else if(pathname==='/examples/inspirations/assets/tayumon-profile.jpg')filename=path.join(root,pathname);
      else if(pathname.startsWith('/fonts/')){if(!['/fonts/InstrumentSans-Bold.ttf','/fonts/GeistMono-Regular.ttf'].includes(pathname))throw new InputError('字体不存在',404);filename=path.join(root,'assets',pathname);}
      else { const relative=pathname==='/'?'index.html':pathname.slice(1);filename=path.resolve(root,'public',relative);if(!filename.startsWith(path.join(root,'public')+path.sep))throw new InputError('文件不存在',404);}
      const info=await stat(filename);if(!info.isFile())throw new InputError('文件不存在',404);
      const ext=path.extname(filename);res.writeHead(200,{'Content-Type':MIME[ext]|| (ext==='.webp'?'image/webp':'application/octet-stream'),'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:await readFile(filename));
    }catch(err){if(!res.headersSent)json(res,{error:err.status?err.message:err.code==='ENOENT'?'文件不存在':'操作未完成，请检查本地服务日志'},err.status|| (err.code==='ENOENT'?404:500));else res.end();if(!err.status&&err.code!=='ENOENT')console.error('RedPilot request failed:',err.name);}
  });
  return {server,store,tick, async close(){await new Promise(resolve=>server.close(resolve));await store.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await createApp();const port=Number(process.env.PORT||4317);
  app.server.on('error',async e=>{console.error(e.code==='EADDRINUSE'?'端口已占用，请设置 PORT 后重试':e.message);await app.store.close();process.exit(1);});
  app.server.listen(port,'127.0.0.1',()=>console.log(`RedPilot｜薯航\nLocal: http://localhost:${port}\n运行数据仅保存在本机 runtime/；关闭服务会暂停排期执行。`));
  const timer=setInterval(()=>app.tick().catch(e=>console.error('Scheduler failed:',e.name)),15000);timer.unref();
  const shutdown=async()=>{clearInterval(timer);await app.close();process.exit(0);};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
