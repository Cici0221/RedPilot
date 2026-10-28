import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
import {assessImageQuality} from '../app/image-quality.mjs';
import {callAI} from '../app/ai.mjs';
import {generateImage} from '../app/image-workbench.mjs';

const env={REDPILOT_AI_KEY:'quality-fixture-secret',REDPILOT_AI_MODEL:'vision-fixture',REDPILOT_AI_BASE_URL:'https://vision.example/v1'};
const overlay={version:1,width:1024,height:1536,layers:[{id:'headline',text:'换手机前，先想想备用号',x:72,y:110,fontSize:72,color:'#152238',fontWeight:800,align:'left',maxWidth:880,lineHeight:1.2,maxLines:4}]};
async function image(size=1024){const canvas=createCanvas(size,size),ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,size,size);return {bytes:await canvas.encode('png'),mime:'image/png'};}
const verdict=(patch={})=>({checks:{productIdentity:'pass',typography:'pass',composition:'pass',unexpectedContent:'pass'},observedText:['换手机前，先想想备用号'],confidence:0.92,issues:[],...patch});
const response=value=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));

test('quality checks receive the actual finished raster and own references, with exact OCR comparison',async()=>{
  const finished=await image(),reference=await image();let requests=0;
  const quality=await assessImageQuality(env,{image:finished,sourceImages:[reference],overlay,job:{role:'cover',headline:'换手机前'}},async(url,options)=>{
    requests++;assert.equal(url,'https://vision.example/v1/chat/completions');const request=JSON.parse(options.body),parts=request.messages[1].content;
    assert.match(parts[0].text,/不要把预期文案当作OCR结果/);assert.equal(parts.length,3);assert.equal(parts.at(-1).image_url.url,`data:image/png;base64,${finished.bytes.toString('base64')}`);
    return response(verdict());
  });
  assert.equal(requests,1);assert.equal(quality.status,'passed');assert.match(quality.imageHash,/^[a-f\d]{64}$/);assert.deepEqual(quality.issues,[]);
});

test('a pass claim cannot hide missing text or product geometry failures',async()=>{
  const finished=await image();
  const typo=await assessImageQuality(env,{image:finished,overlay},async()=>response(verdict({observedText:['换手机后，先想想备用号']})));
  assert.equal(typo.status,'rejected');assert.equal(typo.checks.typography,'fail');assert.match(typo.issues[0],/错字/);
  const shape=await assessImageQuality(env,{image:finished,sourceImages:[finished],overlay},async()=>response(verdict({checks:{...verdict().checks,productIdentity:'fail'},issues:['产品多出一个接口']})));
  assert.equal(shape.status,'rejected');assert.match(shape.issues[0],/接口/);
});

test('missing capability, incomplete replies and uncertain judgements remain candidates, never approved',async()=>{
  const finished=await image();
  assert.equal((await assessImageQuality({}, {image:finished,overlay},async()=>assert.fail('must not call'))).status,'unavailable');
  for(const result of [{},verdict({confidence:0.3}),verdict({checks:{...verdict().checks,composition:'unknown'}}),verdict({checks:{...verdict().checks,typography:'not_applicable'}})]){
    assert.equal((await assessImageQuality(env,{image:finished,overlay},async()=>response(result))).status,'unavailable');
  }
  const failed=await assessImageQuality(env,{image:finished,overlay},async()=>{throw Error(env.REDPILOT_AI_KEY);});assert.equal(failed.status,'unavailable');assert.equal(JSON.stringify(failed).includes(env.REDPILOT_AI_KEY),false);
});

test('tiny images fail locally without billing a vision call',async()=>{
  const result=await assessImageQuality(env,{image:await image(32),overlay},async()=>assert.fail('tiny images must fail locally'));
  assert.equal(result.status,'rejected');assert.match(result.issues[0],/分辨率/);
});

test('pre-cancelled AI and image requests never call the provider',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(callAI(env,'test',[],async()=>assert.fail('cancelled'),{signal:controller.signal}),{status:499});
  await assert.rejects(generateImage({}, {request:{mode:'generate',prompt:'test'}},async()=>assert.fail('cancelled'),{signal:controller.signal}),{status:499});
});

test('cancelling in-flight copy and image requests reaches the fetch signal and never becomes a timeout',async()=>{
  for(const type of ['copy','image']) {
    const controller=new AbortController();let requestedSignal;
    const fetcher=async(url,{signal})=>{requestedSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));};
    const pending=type==='copy'?callAI(env,'test',[],fetcher,{signal:controller.signal}):generateImage({REDPILOT_IMAGE_API_KEY:'fixture-secret',REDPILOT_IMAGE_MODEL:'fixture-image',REDPILOT_IMAGE_BASE_URL:'https://image.example/v1'},{request:{mode:'generate',prompt:'test',size:'1024x1536'}},fetcher,{signal:controller.signal});
    assert.ok(requestedSignal);controller.abort();assert.equal(requestedSignal.aborted,true);
    await assert.rejects(pending,{status:499});
  }
});
