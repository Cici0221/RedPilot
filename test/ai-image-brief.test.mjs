import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generate} from '../app/ai.mjs';

const env={REDPILOT_AI_KEY:'fixture-image-brief-key',REDPILOT_AI_MODEL:'fixture-copy-model',REDPILOT_AI_BASE_URL:'https://provider.example/v1'};
const product={name:'测试产品',stage:'工程内测',facts:['管理备用号码'],conditions:['设备需要联网'],restrictions:['不承诺正式发售']};
const reference={id:'reference-current',title:'可见问题式封面',text:'参考正文',assets:['/uploads/visible-cover.png'],scope:'账号主页可见封面卡片'};
const image={type:'image_url',image_url:{url:'data:image/png;base64,fixture'}};
const copy={title:'备用号码怎么安排',body:'测试产品仍在工程内测。设备需要联网。',tags:['产品开发'],gaps:['还需实机验证'],adaptation:'借鉴问题先行结构'};
const brief={basis:'reference',referenceId:reference.id,layout:'大标题与产品分区',palette:'白底与深色文字',typography:'粗标题和简短副标题',productTreatment:'用自有产品替换竞品，保持真实轮廓'};
const reply=value=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{headers:{'Content-Type':'application/json'}});
async function run({value={...copy,imageBrief:brief},source=reference,mode='image',imageContents=[image],onRequest}={}){
  let calls=0;
  const draft=await generate(env,product,source,'固定创作要求','学习封面排版',imageContents,async(url,options)=>{
    calls++;onRequest?.(JSON.parse(options.body),url);return reply(value);
  },mode);
  assert.equal(calls,1,'visual planning must reuse the copy request');return draft;
}

test('image drafts retain a bounded visual brief tied to the actual visible reference',async()=>{
  const original=structuredClone(brief);
  const draft=await run({onRequest:request=>{
    const prompt=request.messages[1].content[0].text;
    assert.match(prompt,/独立配图任务/);assert.match(prompt,/只作为产品外观参考/);
    assert.match(prompt,/账号主页截图/);assert.match(prompt,/附件前1张是参考截图/);assert.match(prompt,/后续附件是自有产品外观图/);assert.match(prompt,/仅有文字或未读取链接时不能猜测图像风格/);
    assert.match(prompt,/不能要求或冒用竞品图片、logo、硬件外形或功能/);
    assert.doesNotMatch(prompt,/实际配图使用已选自有产品原图|不强制文字卡/);
    assert.equal(request.messages[1].content[1].image_url.url,image.image_url.url);
  }});
  assert.deepEqual(draft.imageBrief,brief);assert.deepEqual(brief,original);
  assert.deepEqual(draft.gaps,copy.gaps);assert.equal(draft.body,copy.body);
  assert.deepEqual(draft.slides,[]);assert.equal(draft.series,'');
});

test('invalid visual planning never discards valid copy or invents a reference provenance',async()=>{
  for(const value of [undefined,null,'not-a-brief',[],{}, {...brief,basis:'unknown'}, {...brief,referenceId:'another-reference'}, {...brief,layout:'字'.repeat(221)}, {...brief,palette:3}, {...brief,typography:''}, {...brief,productTreatment:'bad\u0000content'}]){
    const draft=await run({value:{...copy,imageBrief:value}});
    assert.equal(Object.hasOwn(draft,'imageBrief'),false);assert.equal(draft.title,copy.title);assert.deepEqual(draft.gaps,copy.gaps);
  }
  assert.equal(Object.hasOwn(await run({imageContents:[]}), 'imageBrief'),false);
  for(const source of [{...reference,assets:[]},{...reference,assets:undefined},{...reference,id:undefined}]){
    assert.equal(Object.hasOwn(await run({source}),'imageBrief'),false);
  }
});

test('original designs need no screenshot and discard arbitrary reference ids',async()=>{
  const draft=await run({source:{id:'text-source',text:'仅可见正文',assets:[]},value:{...copy,imageBrief:{...brief,basis:'original',referenceId:'foreign-id',layout:' 字'.repeat(110).trim()}}});
  assert.equal(draft.imageBrief.basis,'original');assert.equal(draft.imageBrief.referenceId,null);
  assert.equal(draft.imageBrief.layout.length,219);assert.equal(draft.body,copy.body);
});

test('text drafts omit visual plans even when a provider returns one',async()=>{
  const draft=await run({mode:'text',value:{...copy,imageBrief:brief,slides:[{headline:'not-published'}]},onRequest:request=>{
    assert.match(request.messages[1].content[0].text,/不返回 imageBrief/);
    assert.match(request.messages[1].content[0].text,/原生默认配图/);
  }});
  assert.equal(draft.contentMode,'text');assert.deepEqual(draft.slides,[]);
  assert.equal(Object.hasOwn(draft,'imageBrief'),false);assert.equal(draft.body,copy.body);
});

test('article-specific image pages retain only bounded valid structure and fall back without discarding the draft',async()=>{
  const pages=[{role:'steps',headline:'准备好备用号',copy:[],layout:'上方标题，下方产品'},{role:'steps',headline:'放进设备',copy:['按正文介绍实际操作']},{role:'comparison',headline:'选择适合自己的方式',copy:[]}];
  const draft=await run({value:{...copy,imageBrief:{...brief,pages}}});
  assert.equal(draft.imageBrief.pages.length,3);assert.equal(draft.imageBrief.pages[0].role,'cover');assert.deepEqual(draft.imageBrief.pages[1].copy,pages[1].copy);
  for(const invalid of [[],Array(7).fill(pages[0]),[{...pages[0],role:'invented'}],[{...pages[0],headline:'字'.repeat(45)}],[{...pages[0],copy:['bad\u0000text']}],[{...pages[0],copy:Array(3).fill('太多')}]] ) {
    const next=await run({value:{...copy,imageBrief:{...brief,pages:invalid}}});assert.ok(next.imageBrief);assert.equal(Object.hasOwn(next.imageBrief,'pages'),false);assert.equal(next.title,copy.title);
  }
});
