import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mkdir } from 'node:fs/promises';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStore } from './store.mjs';
import { createAuth } from './auth.mjs';
import { imageProviderStatus, validateImageRequest, generateImage } from './image-workbench.mjs';
import { receiveModelUpload, saveModelUpload, cleanModelUpload } from './model-uploads.mjs';
import { id, now, InputError, str, lines, sourceUrl, noteKey, validateProduct, validateDraft, contentMode, checks, templateDraft, dateParts, dailyKey } from './content.mjs';
import { aiReady, analyze, generate, imagesFor } from './ai.mjs';
import { importProductAssets, uploadProductAsset, readableAssetFile, publicAsset, selectedProductAssets, productVisionImages, runProductRender, cleanRenderError } from './product-assets.mjs';
import { accountById, createAccount, updateAccount, setDefaultAccount, archiveAccount, saveAccountSettings, syncDefaultSettings } from './accounts.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_BODY = 30*1024*1024;
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf'};
function requireItem(array,key) { const item = array.find(x=>x.id===key); if(!item) throw new InputError('记录不存在',404); return item; }
function json(res, data, status=200) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req, limit=MAX_BODY) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('需要 JSON 请求',415);
  if(Number(req.headers['content-length'])>limit){req.resume();throw new InputError('请求体过大',413);}
  const chunks=[];let size=0; for await(const c of req) {size+=c.length;if(size>limit)throw new InputError('请求体过大',413);chunks.push(c);}
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
export async function createApp({root=ROOT,directory=process.env.REDPILOT_DATA_DIR || path.join(root,'runtime'),env=process.env,fetcher=fetch,renderRunner,authClock}={}) {
  const auth=await createAuth({directory,clock:authClock,secureCookies:env.REDPILOT_COOKIE_SECURE==='true'});
  const store=await createStore(root,directory,{legacyBridgeAccountId:env.REDPILOT_ACCOUNT_ID || ''});
  const bridgeReady=()=>Boolean(env.REDPILOT_PUBLISH_URL&&env.REDPILOT_PUBLISH_TOKEN);
  const capabilities=()=>({ai:aiReady(env),model:env.REDPILOT_AI_MODEL||null,publisher:bridgeReady(),textPublisher:bridgeReady()&&env.REDPILOT_PUBLISH_TEXT_ENABLED==='true',
    account:accountById(store.state).bridgeAccountId||null,
    accounts:Object.fromEntries(store.state.accounts.map(account=>[account.id,{publisher:bridgeReady()&&Boolean(account.bridgeAccountId)}])),
    feishu:false,linkReader:false});
  // Persist a result-unknown state after restart; never automatically retry an interrupted write.
  await store.mutate(s=>{s.productAssets ||= [];s.productRenders ||= [];s.imageJobs ||= [];for(const j of s.imageJobs)if(['queued','generating'].includes(j.status)){j.status='failed';j.error='服务已重启，生成结果未知；未自动重试，请先核对图片服务记录';j.completedAt=now();}for(const d of s.drafts){d.contentMode ||= 'image';d.productAssetIds ||= [];if(d.contentMode==='text'){d.productAssetIds=[];d.slides=[];}}for(const r of s.productRenders)if(['queued','running'].includes(r.status)){r.status='failed';r.error='服务已重启，请重新生成';}for(const j of s.jobs){j.contentMode ||= s.drafts.find(d=>d.id===j.draftId)?.contentMode||'image';if(j.status==='publishing'){j.status='uncertain';j.error='服务重启，发布结果需要核对';}}});
  async function makeDraft(s,referenceId,instruction='',mode='综合借鉴',method='auto',accountId=s.defaultAccountId,productAssetIds,draftMode='image') {
    contentMode(draftMode);
    const account=accountById(s,accountId);
    const ref=referenceId?requireItem(s.inspirations,referenceId):null;
    const useAI=method!=='template'&&aiReady(env);
    const selected=draftMode==='text'?[]:selectedProductAssets(s,productAssetIds ?? s.productAssets.filter(a=>a.kind==='image').slice(-2).map(a=>a.id));
    const materialCatalog=selected.map(a=>({id:a.id,name:a.name,kind:a.kind,description:a.description}));
    const accountInstruction=`账号：${account.name}。账号类型：${account.type==='official'?'官方':'普通'}。账号定位与备注：${account.notes || '无'}。本次要求：${instruction}。可用自有产品素材：${JSON.stringify(materialCatalog)}。产品素材仅用于外观和品牌参考，不作为功能实测依据。`;
    const data=useAI?await generate(env,s.product,ref,accountInstruction,mode,[...(ref?await imagesFor(ref,root,directory):[]),...await productVisionImages(selected,directory)],fetcher,draftMode):templateDraft(s.product,ref,instruction,draftMode);
    if(method==='ai'&&!useAI)throw new InputError('AI 未配置，请选择本地事实模板',409);
    const draft={...data,contentMode:draftMode,id:id(),productAssetIds:selected.map(a=>a.id),accountId:account.id,referenceIds:ref?[ref.id]:[],instruction,mode,productVersion:s.product.version,status:'draft',createdAt:now(),updatedAt:now(),history:[],revision:1};
    s.drafts.unshift(draft);if(ref)ref.uses++;
    store.event(s,'generation',`[${account.name}] ${draft.method==='ai'?'AI':'本地模板'}生成：${draft.title}`);return draft;
  }
  function newJob(s,draft,scheduledAt,accountId=draft.accountId) {
    if(accountId!==draft.accountId)throw new InputError('目标账号与草稿所属账号不一致，请先修改草稿账号',409);
    const account=accountById(s,accountId);
    if(!account.enabled)throw new InputError('账号已暂停，请先启用账号',409);
    if(s.jobs.some(j=>j.draftId===draft.id&&!['cancelled','failed'].includes(j.status)))throw new InputError('该草稿已有发布任务，请先取消或核对原任务',409);
    const issues=checks(draft,s.product,s.productAssets);if(issues.length)throw new InputError(issues.join('；'),409);
    if(!draft.approved)throw new InputError('请先核对图文并标记审核通过',409);
    const j={id:id(),accountId:account.id,accountName:account.name,draftId:draft.id,draftRevision:draft.revision,contentMode:draft.contentMode,scheduledAt,status:'scheduled',createdAt:now(),idempotencyKey:id(),attempts:0,title:draft.title};
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
      if(d.contentMode==='text'&&env.REDPILOT_PUBLISH_TEXT_ENABLED!=='true'){j.status='blocked';j.error='发布端尚未确认支持文字稿原生默认配图；没有进行真实发布';return;}
      const issues=checks(d,s.product,s.productAssets);
      if(issues.length||d.revision!==j.draftRevision||!d.approved||d.accountId!==j.accountId){j.status='blocked';j.error=issues.join('；')||'草稿版本变更或尚未审核';return;}
      j.status='publishing';j.attempts++;j.account=account.bridgeAccountId;
      // Write intent before the external side effect, even if the request later fails.
      await store.save();
    }
    try {
      const sourceAssets=verify||d.contentMode==='text'?[]:await Promise.all(selectedProductAssets(s,d.productAssetIds||[]).map(async a=>({id:a.id,name:a.name,mime:a.mime,kind:a.kind,data:(await readFile(await readableAssetFile(a,directory))).toString('base64')})));
      const res=await fetcher(env.REDPILOT_PUBLISH_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.REDPILOT_PUBLISH_TOKEN}`,'Idempotency-Key':j.idempotencyKey},
        body:JSON.stringify({action:verify?'verify':'publish',idempotencyKey:j.idempotencyKey,accountId:j.account,jobId:j.id,
          post:{title:d.title,body:d.body,tags:d.tags,contentMode:d.contentMode,coverStrategy:d.contentMode==='text'?'platform_default':'custom',slides:d.contentMode==='text'?[]:d.slides,images:sourceAssets.filter(a=>a.kind==='image'),sourceAssets,brand:s.product.brand,product:s.product.name},noteUrl:j.noteUrl||null})});
      if(!res.ok)throw new Error('bridge_error');
      const result=await res.json();
      const parsed=result.noteUrl?new URL(result.noteUrl):null;
      if(result.status==='published'&&result.verified===true&&result.accountId===j.account&&parsed?.protocol==='https:'&&['www.xiaohongshu.com','xiaohongshu.com'].includes(parsed.hostname)&&/^\/(explore|discovery\/item)\/[a-f\d]{24}(?:\/|$)/i.test(parsed.pathname)) {
        j.status='published';j.noteUrl=parsed.href;j.publishedAt=now();j.error=null;d.status='published';
      } else {j.status='uncertain';j.error='发布器未返回匹配账号且经过核对的笔记链接，请核对后处理';}
    } catch {j.status='uncertain';j.error='发布器请求未完成或返回异常；为防止重复发布，不会自动重发';}
    store.event(s,'publish',`[${j.accountName}] ${j.status==='published'?'已核对发布':'待核对'}：${j.title}`);
  }
  let renderQueue=Promise.resolve(),imageQueue=Promise.resolve(),closing=false;
  function scheduleImage(jobId) {
    imageQueue=imageQueue.then(async()=>{
      if(closing)return;
      try {
        const task=await store.mutate(s=>{
          const job=requireItem(s.imageJobs,jobId);job.status='generating';job.startedAt=now();
          return {request:validateImageRequest(job,s.productAssets),sources:job.sourceAssetIds.map(key=>structuredClone(requireItem(s.productAssets,key)))};
        });
        const sourceImages=await Promise.all(task.sources.map(async a=>({name:a.name,mime:a.mime,bytes:await readFile(await readableAssetFile(a,directory))})));
        const result=await generateImage(env,{request:task.request,sourceImages},fetcher);
        await store.mutate(async s=>{
          const job=requireItem(s.imageJobs,jobId);
          const hash=createHash('sha256').update(result.bytes).digest('hex');
          let asset=s.productAssets.find(a=>a.kind==='image'&&a.sha256===hash);
          if(!asset){
            asset=await uploadProductAsset(s,directory,{name:`AI-${job.id}.${result.extension}`,kind:'image',data:result.bytes.toString('base64')});
            asset.description='AI 生成图片，需人工核对产品外观；不作为实拍或功能验证依据';
            asset.metadata={...asset.metadata,imageJobId:job.id,sourceAssetIds:job.sourceAssetIds,model:result.model,aiGenerated:true};
          }
          job.status='completed';job.assetId=asset.id;job.model=result.model;job.completedAt=now();
          store.event(s,'image','AI 图片已保存到素材库');
        });
      } catch(error) {
        await store.mutate(s=>{
          const job=requireItem(s.imageJobs,jobId);job.status='failed';job.completedAt=now();
          // Provider messages may contain secrets or local paths. Expose only errors from our validated API module.
          job.error=error instanceof InputError?error.message:'图片生成未完成，请检查图片 API 配置或稍后重试';
          store.event(s,'image','AI 图片生成失败；未自动重试');
        });
      }
    }).catch(error=>console.error('Image queue failed:',error.name));
  }
  const render=renderRunner||((args)=>runProductRender(args,root,env));
  function scheduleRender(jobId) {
    renderQueue=renderQueue.then(async()=>{
      if(closing)return;
      let source,outputPath;
      try {
        const task=await store.mutate(s=>{
          const job=requireItem(s.productRenders,jobId),asset=requireItem(s.productAssets,job.assetId);
          job.status='running';job.startedAt=now();return {job:structuredClone(job),asset:structuredClone(asset)};
        });
        source=await readableAssetFile(task.asset,directory);
        const outputDirectory=path.join(directory,'product-assets','renders');
        await mkdir(outputDirectory,{recursive:true});
        outputPath=path.join(outputDirectory,task.job.id+'.png');
        await render({modelPath:source,outputPath,preset:task.job.preset,cacheDirectory:path.join(directory,'product-assets','render-cache')});
        // Only the assigned output path may be registered; runner return values cannot read arbitrary files.
        await store.mutate(async s=>{
          const job=requireItem(s.productRenders,jobId),model=requireItem(s.productAssets,job.assetId);
          const [image]=await importProductAssets(s,directory,[outputPath],'managed',[`${model.name} · ${job.preset} 产品图`]);
          if(image.kind!=='image'||image.mime!=='image/png')throw new InputError('渲染器没有生成有效 PNG');
          image.description='根据产品3D模型生成的几何渲染图，非实拍或功能验证画面';
          image.metadata.modelAssetId=model.id;image.metadata.preset=job.preset;image.metadata.modelSha256=model.sha256;
          job.status='completed';job.completedAt=now();job.imageAssetId=image.id;job.previewUrl=`/api/product-assets/${image.id}/file`;
          model.previewAssetId=image.id;
          store.event(s,'render',`产品图已生成：${model.name}`);
        });
      } catch(error) {
        await store.mutate(s=>{
          const job=requireItem(s.productRenders,jobId);job.status='failed';job.error=cleanRenderError(error,[source,outputPath,root,directory]);job.completedAt=now();
          store.event(s,'render',`产品图生成失败：${job.error}`);
        });
      }
    }).catch(error=>console.error('Render queue failed:',error.name));
  }
  const publicState=()=>({...store.state,imageProvider:imageProviderStatus(env),productAssets:store.state.productAssets.map(a=>publicAsset(a,store.state)),
    capabilities:capabilities(),draftChecks:Object.fromEntries(store.state.drafts.map(d=>[d.id,checks(d,store.state.product,store.state.productAssets)]))});
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
          const mix=account.contentMix;
          const draftMode=mix.imageCount<Math.round((mix.total+1)*setting.imageShare/100)?'image':'text';
          const d=await makeDraft(s,ref?.id,'轮换具体场景，避免与近期草稿和已发布内容重复。近期标题：'+s.drafts.filter(x=>x.accountId===account.id).slice(0,15).map(x=>x.title).join('；'),'综合借鉴','auto',account.id,undefined,draftMode);
          mix.total++;if(draftMode==='image')mix.imageCount++;
          account.dailyHistory.push({date:key,draftId:d.id,contentMode:draftMode});account.dailyHistory=account.dailyHistory.slice(-365);
          const duplicate=s.drafts.some(x=>x.accountId===account.id&&x.id!==d.id&&x.title.replace(/\s/g,'')===d.title.replace(/\s/g,''));
          if(duplicate)d.gaps.push('与该账号已有草稿标题重复，请改写选题');
          const issues=checks(d,s.product,s.productAssets);
          if(issues.length||setting.mode==='review'){store.event(s,'review',`[${account.name}] 待人工核对：${d.title}${issues.length?'（'+issues.join('；')+'）':''}`);}
          else {d.approved=true;newJob(s,d,date.toISOString());}
        }catch{store.event(s,'blocked',`[${account.name}] 每日生成失败，请检查模型配置或补充资料`);}
      }
      syncDefaultSettings(s);
      for(const j of s.jobs.filter(j=>j.status==='scheduled'&&new Date(j.scheduledAt)<=date))await dispatch(s,j);
    });} finally {ticking=false;}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const host=req.headers.host||'';
      if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))throw new InputError('仅允许本机访问',403);
      const url=new URL(req.url,`http://${host}`), pathname=decodeURIComponent(url.pathname);
      if(pathname==='/api/auth/session'&&req.method==='GET')return json(res,auth.status(req));
      if(['/api/auth/login','/api/auth/logout'].includes(pathname)&&req.method==='POST') {
        if(req.headers.origin!==`http://${host}`)throw new InputError('请求来源不匹配，请刷新登录页',403);
        const input=await body(req,16384);
        if(pathname==='/api/auth/logout'){auth.logout(req,res);return json(res,{ok:true});}
        return json(res,await auth.login(req,res,input));
      }
      const publicFiles=['/login','/login.html','/login.js','/style.css','/fonts/InstrumentSans-Bold.ttf','/fonts/GeistMono-Regular.ttf'];
      const publicFile=['GET','HEAD'].includes(req.method)&&publicFiles.includes(pathname);
      if(!publicFile&&!auth.session(req)) {
        if(pathname.startsWith('/api/'))return json(res,{error:'请先登录',code:'AUTH_REQUIRED'},401);
        res.writeHead(302,{Location:'/login','Cache-Control':'no-store'});return res.end();
      }
      if(publicFile&&['/login','/login.html'].includes(pathname)&&auth.session(req)){
        res.writeHead(302,{Location:'/','Cache-Control':'no-store'});return res.end();
      }
      if(pathname.startsWith('/api/')) {
        if(req.method==='GET'&&pathname==='/api/state')return json(res,publicState());
        if(req.method==='GET'&&pathname==='/api/health')return json(res,{ok:true});
        const media=pathname.match(/^\/api\/product-assets\/([^/]+)\/(file|preview)$/);
        if(media&&['GET','HEAD'].includes(req.method)) {
          const asset=requireItem(store.state.productAssets,media[1]);
          let filename,mime;
          if(media[2]==='preview') {
            if(asset.previewAssetId){const preview=requireItem(store.state.productAssets,asset.previewAssetId);filename=await readableAssetFile(preview,directory);mime=preview.mime;}
            else if(asset.previewName&&/^[a-f\d-]+\.png$/.test(asset.previewName)){filename=path.join(directory,'product-assets','previews',asset.previewName);mime='image/png';}
            else throw new InputError('此素材暂无预览',404);
          } else {filename=await readableAssetFile(asset,directory);mime=asset.mime;}
          const info=await stat(filename);
          const download=media[2]==='file'&&(url.searchParams.has('download')||['model','brochure','icon'].includes(asset.kind));
          res.writeHead(200,{'Content-Type':mime,'Content-Length':info.size,'Cache-Control':'no-store',
            'Content-Disposition':`${download?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`});
          if(req.method==='HEAD')return res.end();
          await pipeline(createReadStream(filename),res);return;
        }
        if(!['POST','PUT','DELETE'].includes(req.method))throw new InputError('接口不存在',404);
        if(req.headers.origin!==`http://${host}`)throw new InputError('请求来源不匹配，请刷新本地页面',403);
        if(req.method==='POST'&&pathname==='/api/product-assets/upload-model') {
          let upload,committed=false;
          try {
            upload=await receiveModelUpload(req,directory,url.searchParams.get('name'));
            // The session may have expired or been revoked during a long upload.
            if(!auth.session(req))throw new InputError('登录已失效，请重新登录后上传',401);
            const result=await store.mutate(async s=>{
              const item=await saveModelUpload(s,directory,upload);
              store.event(s,'materials',`3D 模型已保存：${item.name}`);return publicAsset(item,s);
            });
            committed=true;return json(res,result);
          } catch(error) {
            res.shouldKeepAlive=false;req.resume();throw error;
          } finally {if(upload)await cleanModelUpload(upload,directory,store.state,committed);}
        }
        const b=await body(req);
        const result=await store.mutate(async s=>{
          if(req.method==='POST'&&pathname==='/api/image-jobs') {
            const request=validateImageRequest(b,s.productAssets);
            if(!imageProviderStatus(env).ready)throw new InputError('尚未配置 OpenAI 图片 API，请在服务器环境中配置密钥后重启',409);
            if(s.imageJobs.some(j=>['queued','generating'].includes(j.status)))throw new InputError('已有图片生成任务，请等待完成',409);
            const job={...request,id:id(),status:'queued',createdAt:now()};s.imageJobs.unshift(job);return job;
          }
          if(req.method==='POST'&&pathname==='/api/product-assets/import') {
            const items=await importProductAssets(s,directory,b.paths,b.mode||'managed',Array.isArray(b.names)?b.names:[]);
            store.event(s,'materials',`产品素材导入：${items.length} 项`);return {items:items.map(a=>publicAsset(a,s))};
          }
          if(req.method==='POST'&&pathname==='/api/product-assets/upload') {
            const item=await uploadProductAsset(s,directory,b);store.event(s,'materials',`产品素材已保存：${item.name}`);return publicAsset(item,s);
          }
          const renderRoute=pathname.match(/^\/api\/product-assets\/([^/]+)\/render$/);
          if(renderRoute&&req.method==='POST') {
            const asset=requireItem(s.productAssets,renderRoute[1]);
            if(!publicAsset(asset,s).renderable)throw new InputError('此素材不是可渲染的完整 STEP 模型');
            if(!['studio','front','angle'].includes(b.preset))throw new InputError('渲染角度不正确');
            if(s.productRenders.some(j=>j.assetId===asset.id&&['queued','running'].includes(j.status)))throw new InputError('该模型正在渲染，请等待完成',409);
            const job={id:id(),assetId:asset.id,status:'queued',preset:b.preset,createdAt:now()};s.productRenders.unshift(job);return job;
          }
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
          if(req.method==='POST'&&pathname==='/api/drafts'){return makeDraft(s,b.referenceId,str(b.instruction||'',2000),str(b.mode||'综合借鉴',80),b.method||'auto',b.accountId||s.defaultAccountId,b.productAssetIds,b.contentMode);}
          m=pathname.match(/^\/api\/drafts\/([^/]+)(?:\/(approve|schedule|duplicate))?$/);
          if(m){const d=requireItem(s.drafts,m[1]);
            if(m[2]==='duplicate'&&req.method==='POST'){const target=accountById(s,b.accountId||(accountById(s,d.accountId,true).archived?s.defaultAccountId:d.accountId));const copy={...structuredClone(d),accountId:target.id,id:id(),status:'draft',approved:false,history:[],revision:1,createdAt:now(),updatedAt:now()};s.drafts.unshift(copy);return copy;}
            if(s.jobs.some(j=>j.draftId===d.id&&!['cancelled','failed'].includes(j.status)))throw new InputError('请先取消排期；已发布或待核对的稿件可复制为新草稿',409);
            if(req.method==='DELETE'){s.drafts=s.drafts.filter(x=>x.id!==d.id);return {ok:true};}
            if(req.method==='PUT'){const account=accountById(s,b.accountId||d.accountId),validated=validateDraft({...b,contentMode:b.contentMode??d.contentMode});const data={...validated,productAssetIds:validated.contentMode==='text'?[]:selectedProductAssets(s,b.productAssetIds??d.productAssetIds??[]).map(a=>a.id),accountId:account.id};d.history.unshift({at:d.updatedAt,title:d.title,body:d.body,slides:d.slides,tags:d.tags,contentMode:d.contentMode,productAssetIds:d.productAssetIds});d.history=d.history.slice(0,20);Object.assign(d,data,{productVersion:s.product.version,approved:false,revision:d.revision+1,updatedAt:now()});return d;}
            if(m[2]==='approve'&&req.method==='POST'){const issues=checks(d,s.product,s.productAssets);if(issues.length)throw new InputError(issues.join('；'),409);d.approved=true;return d;}
            if(m[2]==='schedule'&&req.method==='POST'){const at=new Date(b.scheduledAt);if(!Number.isFinite(at.valueOf())||at<=new Date())throw new InputError('请选择未来的发布时间');return newJob(s,d,at.toISOString(),b.accountId||d.accountId);}
          }
          m=pathname.match(/^\/api\/jobs\/([^/]+)\/(cancel|retry|verify)$/);
          if(m&&req.method==='POST'){const j=requireItem(s.jobs,m[1]);
            if(m[2]==='cancel'){if(['publishing','uncertain','published'].includes(j.status))throw new InputError('当前任务需要先核对发布结果，不能直接取消',409);j.status='cancelled';const d=requireItem(s.drafts,j.draftId);d.status='draft';return j;}
            if(m[2]==='retry'){if(j.status!=='blocked'||j.attempts>0)throw new InputError('只有从未提交的阻塞任务才能重新入队',409);j.status='scheduled';j.error=null;return j;}
            if(m[2]==='verify'){if(j.status!=='uncertain')throw new InputError('只有待核对任务可查询发布结果',409);await dispatch(s,j,true);return j;}
          }
          throw new InputError('接口不存在',404);
        });if(req.method==='POST'&&/^\/api\/product-assets\/[^/]+\/render$/.test(pathname))scheduleRender(result.id);if(req.method==='POST'&&pathname==='/api/image-jobs')scheduleImage(result.id);return json(res,result);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new InputError('请求不支持',405);
      let filename;
      if(pathname.startsWith('/uploads/')) {if(!/^\/uploads\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(pathname))throw new InputError('文件不存在',404);filename=path.join(directory,'uploads',path.basename(pathname));}
      else if(pathname==='/examples/inspirations/assets/tayumon-profile.jpg')filename=path.join(root,pathname);
      else if(pathname.startsWith('/fonts/')){if(!['/fonts/InstrumentSans-Bold.ttf','/fonts/GeistMono-Regular.ttf'].includes(pathname))throw new InputError('字体不存在',404);filename=path.join(root,'assets',pathname);}
      else { const relative=pathname==='/'?'index.html':pathname==='/login'?'login.html':pathname.slice(1);filename=path.resolve(root,'public',relative);if(!filename.startsWith(path.join(root,'public')+path.sep))throw new InputError('文件不存在',404);}
      const info=await stat(filename);if(!info.isFile())throw new InputError('文件不存在',404);
      const ext=path.extname(filename);res.writeHead(200,{'Content-Type':MIME[ext]|| (ext==='.webp'?'image/webp':'application/octet-stream'),'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:await readFile(filename));
    }catch(err){if(!res.headersSent)json(res,{error:err.status?err.message:err.code==='ENOENT'?'文件不存在':'操作未完成，请检查本地服务日志'},err.status|| (err.code==='ENOENT'?404:500));else res.end();if(!err.status&&err.code!=='ENOENT')console.error('RedPilot request failed:',err.name);}
  });
  return {server,store,tick, async close(){closing=true;await Promise.all([renderQueue,imageQueue]);await new Promise(resolve=>server.close(resolve));auth.close();await store.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await createApp();const port=Number(process.env.PORT||4317);
  app.server.on('error',async e=>{console.error(e.code==='EADDRINUSE'?'端口已占用，请设置 PORT 后重试':e.message);await app.store.close();process.exit(1);});
  app.server.listen(port,'127.0.0.1',()=>console.log(`RedPilot｜薯航\nLocal: http://localhost:${port}\n运行数据仅保存在本机 runtime/；关闭服务会暂停排期执行。`));
  const timer=setInterval(()=>app.tick().catch(e=>console.error('Scheduler failed:',e.name)),15000);timer.unref();
  const shutdown=async()=>{clearInterval(timer);await app.close();process.exit(0);};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
