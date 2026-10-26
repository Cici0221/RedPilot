import {readFile,writeFile,rename,chmod,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {InputError,now} from './content.mjs';
import {normalizeWireApi,createAIRequest,readAIResponse} from './ai-transport.mjs';

const DEFAULT_BASE='https://api.openai.com/v1';
export const DEFAULT_TEXT_MODEL='gpt-6.1-sol';
const PROBE_IMAGE='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQy/tAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAN/z8EzmkyhsAAAAAElFTkSuQmCC';
const controls=/[\u0000-\u001f\u007f]/;
export function validateAIBase(value){
  if(typeof value!=='string'||value.length>2000||controls.test(value))throw new InputError('AI 服务地址不正确');
  let url;try{url=new URL(value.trim());}catch{throw new InputError('请输入完整的 HTTPS 服务地址');}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase(),ip=isIP(host);
  const privateV4=ip===4&&((p=>p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&(p[1]===168||p[1]===0&&(p[2]===0||p[2]===2)||p[1]===88&&p[2]===99)||p[0]===198&&(p[1]===18||p[1]===19||p[1]===51&&p[2]===100)||p[0]===203&&p[1]===0&&p[2]===113||p[0]===100&&p[1]>=64&&p[1]<=127)(host.split('.').map(Number)));
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443'||privateV4||ip===6||!host.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host))throw new InputError('服务地址需为公网 HTTPS 地址，且不能含凭据、查询参数或自定义端口');
  return url.href.replace(/\/+$/,'');
}
function modelName(value){if(typeof value!=='string'||!value.trim()||value.length>100||!/^[A-Za-z0-9._:/-]+$/.test(value.trim()))throw new InputError('请填写有效模型名称，最多100个字符');return value.trim();}
function keyValue(value){if(typeof value!=='string'||value.length>500||controls.test(value)||/\s/.test(value.trim()))throw new InputError('API 密钥格式不正确');return value.trim();}
async function readProbe(response){
  if(Number(response.headers.get('content-length'))>1048576){await response.body?.cancel().catch(()=>{});throw new Error('response_limit');}
  const reader=response.body?.getReader();if(!reader)throw new Error('empty_response');const chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel().catch(()=>{});throw new Error('response_limit');}chunks.push(value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
}
const GENERIC_RATE_ERROR='AI 服务额度或频率受限，请检查项目额度';
const RATE_ERRORS=Object.freeze({
  billing_not_active:'AI 服务计费未激活，请前往当前服务商的账单页面启用计费（billing_not_active）',
  credit_balance_exhausted:'AI 服务余额不足，请前往当前服务商的账单页面添加余额（credit_balance_exhausted）',
  project_spend_limit_exceeded:'AI 服务项目消费限额已达上限，请检查当前服务商的项目消费限额（project_spend_limit_exceeded）',
  organization_spend_limit_exceeded:'AI 服务组织消费限额已达上限，请检查当前服务商的组织消费限额（organization_spend_limit_exceeded）',
  organization_usage_limit_exceeded:'AI 服务组织用量限额已达上限，请检查当前服务商的组织用量限制（organization_usage_limit_exceeded）',
  insufficient_quota:'AI 服务额度不足，请检查当前服务商的账单余额及项目或组织限额（insufficient_quota）',
  rate_limit_exceeded:'AI 服务暂时限流，请稍后重试并降低请求频率（rate_limit_exceeded）',
  slow_down:'AI 服务暂时限流，请稍后重试并降低请求频率（slow_down）'
});
async function rateError(response){
  try{
    const payload=await readProbe(response);
    for(const value of [payload?.error?.code,payload?.error?.type])if(typeof value==='string'&&Object.hasOwn(RATE_ERRORS,value))return RATE_ERRORS[value];
  }catch{}
  return GENERIC_RATE_ERROR;
}
export async function createConnections(directory,env,fetcher=fetch){
  const filename=path.join(directory,'connections.json'),fallback={key:env.REDPILOT_AI_KEY||'',model:env.REDPILOT_AI_MODEL||DEFAULT_TEXT_MODEL,baseUrl:env.REDPILOT_AI_BASE_URL||DEFAULT_BASE,wireApi:env.REDPILOT_AI_WIRE_API};
  let saved={};try{saved=JSON.parse(await readFile(filename,'utf8'));await chmod(filename,0o600);}catch(error){if(error.code!=='ENOENT')throw new Error('服务配置无法读取，已保留原文件');}
  let revision=0,queue=Promise.resolve(),pending=null;
  const config=()=>{const value=saved.ai?{key:saved.ai.apiKey,model:saved.ai.model,baseUrl:saved.ai.baseUrl,wireApi:saved.ai.wireApi}:fallback;return {...value,wireApi:normalizeWireApi(value.wireApi)};};
  const fingerprint=c=>createHash('sha256').update(JSON.stringify(c)).digest('hex');
  const syncEnv=()=>{const c=config();env.REDPILOT_AI_KEY=c.key;env.REDPILOT_AI_MODEL=c.model;env.REDPILOT_AI_BASE_URL=c.baseUrl;env.REDPILOT_AI_WIRE_API=c.wireApi;};
  const publicAI=()=>{const c=config(),configured=Boolean(c.key&&c.model),check=saved.aiCheck?.configFingerprint===fingerprint(c)?saved.aiCheck:null;return {configured,model:c.model,baseUrl:c.baseUrl,wireApi:c.wireApi,source:saved.ai?'runtime':fallback.key?'environment':null,status:configured?check?.status||'untested':'unconfigured',checkedAt:check?.checkedAt||null,error:check?.error||null};};
  const persist=async next=>{await mkdir(directory,{recursive:true,mode:0o700});await writeFile(filename+'.tmp',JSON.stringify(next,null,2),{mode:0o600});await chmod(filename+'.tmp',0o600);await rename(filename+'.tmp',filename);saved=next;syncEnv();};
  const transaction=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
  syncEnv();
  return {
    publicAI,
    update(input){return transaction(async()=>{
      const current=config(),baseUrl=validateAIBase(input.baseUrl??current.baseUrl),model=modelName(input.model??current.model),wireApi=normalizeWireApi(input.wireApi===undefined?current.wireApi:input.wireApi);
      let supplied;if('apiKey'in input)supplied=keyValue(input.apiKey);
      if(baseUrl!==current.baseUrl&&!supplied)throw new InputError('切换服务地址时请重新填写密钥');
      const key=supplied||current.key;if(!key)throw new InputError('请填写 API 密钥',409);
      const next={...saved,ai:{apiKey:key,baseUrl,model,wireApi},aiCheck:{status:'untested',checkedAt:null,error:null}};
      await persist(next);revision++;return publicAI();
    });},
    test(){
      if(pending?.revision===revision)return pending.promise;
      const version=revision,c={...config()};if(!c.key||!c.model)throw new InputError('请先保存 AI 服务密钥和模型',409);
      const promise=(async()=>{
        let error=null;
        try{
          const base=validateAIBase(c.baseUrl);
          const request=createAIRequest({baseUrl:base,key:c.key,model:c.model,wireApi:c.wireApi,system:'This is a connection test. Return only JSON. Do not include any credentials.',prompt:'Check that you accept the attached small image. Reply with exactly this JSON object: {"ok":true}.',images:[{type:'image_url',image_url:{url:'data:image/png;base64,'+PROBE_IMAGE,detail:'low'}}],maxOutputTokens:c.wireApi==='responses'?1024:512,timeoutMs:c.wireApi==='responses'?45000:20000});
          const response=await fetcher(request.url,request.options);
          if(!response.ok){
            if(response.status===429)error=await rateError(response);
            else{await response.body?.cancel().catch(()=>{});error=response.status===401||response.status===403?'API 密钥未通过验证，请检查密钥及项目权限':response.status===404?'模型或服务地址不可用，请检查配置':`AI 服务返回 HTTP ${response.status}，连接测试未通过`;}
          }
          else{const value=await readAIResponse(response,{wireApi:c.wireApi});if(value?.ok!==true)error='模型没有返回约定的 JSON，连接测试未通过';}
        }catch{error='AI 连接或图片/JSON 测试未完成，请检查网络、模型和服务地址';}
        return transaction(async()=>{if(version!==revision)throw new InputError('AI 配置已修改，请测试新配置',409);await persist({...saved,aiCheck:{status:error?'failed':'ready',error,checkedAt:now(),configFingerprint:fingerprint(c)}});return publicAI();});
      })();
      pending={revision:version,promise};promise.finally(()=>{if(pending?.promise===promise)pending=null;}).catch(()=>{});return promise;
    },
    async close(){await queue;}
  };
}
