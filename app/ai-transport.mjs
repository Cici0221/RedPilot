import {InputError} from './content.mjs';

const DEFAULT_BASE='https://api.openai.com/v1';
const DEFAULT_RESPONSE_LIMIT=1048576;

export function normalizeWireApi(value){
  if(value===undefined)return 'chat';
  if(typeof value==='string'&&['chat','responses'].includes(value.trim()))return value.trim();
  throw new InputError('请选择有效的 AI 接口协议：Chat Completions 或 Responses');
}

function responseContent(item){
  if(item?.type==='text'&&typeof item.text==='string')return {type:'input_text',text:item.text};
  if(item?.type==='image_url'&&typeof item.image_url?.url==='string'){
    const image={type:'input_image',image_url:item.image_url.url};
    if(item.image_url.detail!==undefined)image.detail=item.image_url.detail;
    return image;
  }
  throw new InputError('AI 图片输入格式不正确');
}

export function createAIRequest({baseUrl=DEFAULT_BASE,key,model,wireApi='chat',system,prompt,images=[],maxOutputTokens,timeoutMs=90000,signal}){
  const protocol=normalizeWireApi(wireApi);
  if(typeof baseUrl!=='string'||!baseUrl.trim()||typeof key!=='string'||!key||typeof model!=='string'||!model||typeof system!=='string'||typeof prompt!=='string'||!Array.isArray(images))throw new InputError('AI 请求配置不正确');
  let body;
  if(protocol==='responses'){
    body={model,store:false,stream:true,max_output_tokens:maxOutputTokens??8192,instructions:system,input:[{role:'user',content:[{type:'input_text',text:prompt},...images.map(responseContent)]}],text:{format:{type:'json_object'}}};
  }else{
    body={model,store:false,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:[{type:'text',text:prompt},...images]}]};
    if(maxOutputTokens!==undefined)body.max_completion_tokens=maxOutputTokens;
  }
  return {url:baseUrl.trim().replace(/\/+$/,'')+(protocol==='responses'?'/responses':'/chat/completions'),options:{method:'POST',redirect:'error',signal:signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs),signal]) : AbortSignal.timeout(timeoutMs),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)}};
}

function invalid(){return new InputError('模型未返回完整有效的 JSON，请检查模型及接口协议',502);}
const timeoutFailure=()=>new InputError('AI 请求超时，未保存生成结果',504);
const isTimeout=error=>error?.status===504||['TimeoutError','AbortError'].includes(error?.name);

async function readBounded(response,maxBytes){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw invalid();
  const declared=Number(response.headers?.get('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes){await response.body?.cancel().catch(()=>{});throw invalid();}
  const reader=response.body?.getReader();if(!reader)throw invalid();
  const chunks=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel().catch(()=>{});throw invalid();}chunks.push(value);}
  }catch(error){if(isTimeout(error))throw timeoutFailure();throw invalid();}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks,size).toString('utf8');
}

function parseJSON(value){try{return JSON.parse(value);}catch{throw invalid();}}

function completedStream(text){
  let completed=null,terminal=false;
  for(const block of text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n\n')){
    const lines=block.split('\n'),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();
    const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(!data||data==='[DONE]')continue;
    const item=parseJSON(data),type=item?.type||event;
    if(type==='error'||type==='response.failed'||type==='response.incomplete'||item?.error)throw invalid();
    if(type==='response.completed'){
      if(terminal||item?.response?.status!=='completed')throw invalid();
      completed=item.response;terminal=true;
    }else if(terminal)throw invalid();
  }
  if(!completed)throw invalid();
  return completed;
}

function responsesText(payload){
  if(!payload||payload.status!=='completed'||payload.error||payload.incomplete_details)throw invalid();
  const messages=Array.isArray(payload.output)?payload.output.filter(item=>item?.type==='message'):[];
  if(messages.some(item=>item.status!==undefined&&item.status!=='completed'))throw invalid();
  const contents=messages.flatMap(item=>Array.isArray(item.content)?item.content:[]);
  if(contents.some(item=>item?.type==='refusal'))throw invalid();
  const texts=contents.filter(item=>item?.type==='output_text');
  if(texts.some(item=>typeof item.text!=='string'))throw invalid();
  const text=texts.map(item=>item.text).join('');
  if(text)return text;
  if(typeof payload.output_text==='string'&&payload.output_text)return payload.output_text;
  throw invalid();
}

export async function readAIResponse(response,{wireApi='chat',maxBytes=DEFAULT_RESPONSE_LIMIT}={}){
  const protocol=normalizeWireApi(wireApi);
  try{
    const text=await readBounded(response,maxBytes);
    let result;
    if(protocol==='responses'){
      const contentType=response.headers?.get('content-type')||'';
      const stream=/text\/event-stream/i.test(contentType)||/^\s*(?::|event:|data:)/.test(text);
      result=parseJSON(responsesText(stream?completedStream(text):parseJSON(text)));
    }else{
      const payload=parseJSON(text),choice=payload?.choices?.[0],message=choice?.message;
      if(payload?.error||message?.refusal||choice?.finish_reason&&choice.finish_reason!=='stop')throw invalid();
      if(typeof message?.content!=='string')throw invalid();
      result=parseJSON(message.content);
    }
    if(!result||typeof result!=='object'||Array.isArray(result))throw invalid();
    return result;
  }catch(error){if(isTimeout(error))throw timeoutFailure();throw invalid();}
}
