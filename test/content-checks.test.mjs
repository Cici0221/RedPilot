import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checks} from '../app/content.mjs';

const product={version:'current',stage:'开发内测'};
const draft=body=>({title:'产品进展',body:'开发内测。'+body,contentMode:'text',productVersion:'current',gaps:[],slides:[]});
const claims=body=>checks(draft(body),product).filter(value=>value.startsWith('请核对宣传表述'));

test('explicit release and compatibility limitations are not treated as positive promises',()=>{
  assert.deepEqual(claims('目前仍是工程样机，并非正式发售。也不代表双卡同时在线。暂未正式发售。'),[]);
  assert.deepEqual(claims('不承诺“零延迟”。无法保证永不漏接。不支持全机型。'),[]);
});

test('positive claims, questions and repeated claims still need evidence',()=>{
  for(const body of ['正式发售。','是否零延迟？','不支持双卡同时在线，但正式发售。','不是零延迟。实测零延迟。','不承诺永久免费，但100%可靠。']) assert.equal(claims(body).length,1,body);
  assert.match(claims('零延迟，永不漏接，零延迟。')[0],/零延迟、永不漏接$/);
});

test('double negatives do not bypass promise review',()=>{
  for(const body of ['并非不支持双卡同时在线。','不是不承诺零延迟。','不是未正式发售。','不代表不保证永不漏接。','不保证不是零延迟。']) assert.equal(claims(body).length,1,body);
});

test('disclaimers do not remove version, missing-photo or fact-gap checks',()=>{
  const value={...draft('并非正式发售。'),contentMode:'image',productVersion:'old',gaps:['需要核对实机结果']};
  assert.deepEqual(checks(value,product),['产品资料已更新，请重新生成或核对后保存草稿','请至少选择一张真实产品图作为主图','需要核对实机结果']);
});
