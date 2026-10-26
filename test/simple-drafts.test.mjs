import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generate} from '../app/ai.mjs';
import {templateDraft,validateDraft} from '../app/content.mjs';

const product={name:'RingHi',brand:'测试公司',stage:'工程内测',summary:'备用号通信设备',facts:['设备需要联网'],conditions:['手机需互联网'],restrictions:[]};
const env={REDPILOT_AI_KEY:'test-only-simple-drafts',REDPILOT_AI_MODEL:'test-only-model',REDPILOT_AI_BASE_URL:'https://model.example/v1'};

test('new image and text templates contain no storyboard or fixed series',()=>{
  for(const mode of ['image','text']) {const draft=templateDraft(product,null,'说明设备使用条件',mode);assert.deepEqual(draft.slides,[]);assert.equal(draft.series,'');assert.match(draft.body,/工程内测/);assert.match(draft.body,/手机需互联网/);}
});

test('legacy series and storyboard values remain editable without imposing a category on new drafts',()=>{
  const base={title:'备用号使用需求',body:'工程内测。',tags:['通信'],contentMode:'image'};
  assert.equal(validateDraft(base).series,'');assert.deepEqual(validateDraft(base).slides,[]);
  const legacy={series:'旧稿自定义栏目',slides:[{headline:'旧辅助策划',body:'保留资料'}]};assert.deepEqual(validateDraft({...base,...legacy}),{...base,...legacy,gaps:[]});
});

test('AI drafts keep actual copy separate from design briefs and discard unsolicited storyboards or fixed series',async()=>{
  let calls=0;
  for(const mode of ['image','text']) {
    const draft=await generate(env,product,{title:'参考',text:'可见正文'},'写具体使用场景','综合借鉴',[],async(_url,options)=>{
      calls++;const prompt=JSON.parse(options.body).messages[1].content.find(item=>item.type==='text').text;
      assert.doesNotMatch(prompt,/"slides"\s*:|"series"\s*:|通信小麻烦或接通实验或一起打磨/);assert.match(prompt,/不生成辅助分镜或固定栏目/);assert.equal(/"imageBrief"\s*:/.test(prompt),mode==='image');assert.match(prompt,/设备需要联网/);assert.match(prompt,/当前阶段/);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'备用号使用需求',body:'当前处于工程内测，设备需要联网。',tags:['通信'],series:'一起打磨',slides:[{headline:'正式发售，零延迟',body:'不应进入新稿'}],gaps:['需要实机验证'],adaptation:'借鉴问题先行结构'})}}]}));
    },mode);
    assert.equal(draft.contentMode,mode);assert.deepEqual(draft.slides,[]);assert.equal(draft.series,'');assert.equal(draft.title,'备用号使用需求');assert.deepEqual(draft.gaps,['需要实机验证']);assert.equal(draft.method,'ai');
  }
  assert.equal(calls,2);
});
