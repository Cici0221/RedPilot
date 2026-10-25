import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspirationUrl,supportedPageUrl,supportedImageUrl,readReferenceLink} from '../app/link-reader.mjs';

const note='https://www.xiaohongshu.com/explore/6a95c0ff000000002902de43';
const image='https://sns-webpic-qc.xhscdn.com/fixture-image';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const json=value=>new Response(JSON.stringify(value));
function transport({value={},resolved=note,media,evalError=false}={}) {
  const calls=[];
  const fetcher=async(url,options={})=>{
    calls.push({url,options});const u=new URL(url);
    assert.equal(options.redirect,'error');
    if(u.origin==='http://127.0.0.1:3456') {
      if(u.pathname==='/new')return json({targetId:'owned-test-tab'});
      assert.equal(u.searchParams.get('target'),'owned-test-tab');
      if(u.pathname==='/eval'){
        assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'text/plain; charset=utf-8');
        assert.doesNotMatch(options.body,/document\.cookie|localStorage|sessionStorage|__INITIAL_STATE/);
        if(evalError)throw Error('provider-private-error');
        return json({value:{status:'ready',kind:'note',title:'网页标题',text:'实际网页正文',author:'原作者',tags:[],imageUrls:[],missing:[],...value}});
      }
      if(u.pathname==='/info')return json({url:resolved});
      if(u.pathname==='/close')return json({ok:true});
      throw Error('unexpected proxy route');
    }
    if(media)return media(url,options);
    assert.equal(url,image);
    return new Response(Buffer.from(png,'base64'));
  };
  return {calls,fetcher};
}

test('share text extracts the full note link and upgrades official short links without dropping tokens',()=>{
  assert.equal(inspirationUrl(`标题分享！ ${note}?xsec_token=fixture-token&xsec_source=pc_search ，复制打开`),note+'?xsec_token=fixture-token&xsec_source=pc_search');
  assert.equal(inspirationUrl('分享内容 http://xhslink.com/o/fixture。'),'https://xhslink.com/o/fixture');
  for(const input of ['javascript:alert(1)','https://%','https://user:pass@www.xiaohongshu.com/explore/abc'])assert.throws(()=>inspirationUrl(input));
});

test('page and image allowlists reject private, credentialed, alternate-port and lookalike destinations',()=>{
  assert.ok(supportedPageUrl(note));assert.ok(supportedPageUrl('https://xhslink.com/o/fixture'));
  for(const input of ['https://127.0.0.1/x','https://localhost/x','http://www.xiaohongshu.com/','https://www.xiaohongshu.com.evil.test/','https://www.xiaohongshu.com:444/','https://u:p@www.xiaohongshu.com/'])assert.equal(supportedPageUrl(input),false);
  assert.ok(supportedImageUrl(image));
  for(const input of ['http://sns-webpic-qc.xhscdn.com/x','https://127.0.0.1/image','https://xhscdn.com.evil.test/x','https://u:p@ci.xiaohongshu.com/x','https://sns-webpic-qc.xhscdn.com:444/x'])assert.equal(supportedImageUrl(input),false);
});

test('unsupported page URLs never contact the browser proxy',async()=>{
  const result=await readReferenceLink({url:'https://127.0.0.1/'},{},()=>{throw Error('must not fetch');});
  assert.equal(result.status,'unavailable');
});

test('reader uses an owned tab, saves only validated image bytes and always closes the tab',async()=>{
  const t=transport({value:{imageUrls:[image]}});
  const result=await readReferenceLink({url:note},{},t.fetcher);
  assert.equal(result.status,'ready');assert.equal(result.images.length,1);assert.equal(result.images[0].data,png);
  assert.equal(result.resolvedUrl,note);assert.ok(t.calls.at(-1).url.includes('/close?target=owned-test-tab'));
  const opened=new URL(t.calls[0].url);assert.equal(opened.searchParams.get('url'),note);
});

test('login gates stay unread and do not download page images',async()=>{
  const t=transport({value:{status:'needs_login',imageUrls:[image]}});
  const result=await readReferenceLink({url:note},{},t.fetcher);
  assert.equal(result.status,'needs_login');assert.deepEqual(result.images,[]);
  assert.equal(t.calls.some(c=>c.url===image),false);assert.ok(t.calls.at(-1).url.includes('/close'));
});

test('cross-site page redirects stop before media is fetched',async()=>{
  const t=transport({resolved:'https://127.0.0.1/private',value:{imageUrls:[image]}});
  const result=await readReferenceLink({url:note},{},t.fetcher);
  assert.equal(result.status,'unavailable');assert.equal(t.calls.some(c=>c.url===image),false);
  assert.equal(t.calls.some(c=>new URL(c.url).pathname==='/eval'),false,'foreign pages must not be inspected');
});

test('media failures or unsafe image URLs keep readable text and mark missing images',async()=>{
  const t=transport({value:{imageUrls:['https://127.0.0.1/private',image]},media:async(url)=>{
    assert.equal(url,image);return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});
  }});
  const result=await readReferenceLink({url:note},{},t.fetcher);
  assert.equal(result.status,'partial');assert.equal(result.text,'实际网页正文');assert.deepEqual(result.images,[]);assert.ok(result.missing.length);
  assert.equal(t.calls.filter(c=>!c.url.startsWith('http://127.0.0.1:3456')).length,1);
});

test('oversized and non-image responses are discarded without following returned URLs',async()=>{
  for(const response of [new Response('<html>not an image</html>'),new Response('x',{headers:{'content-length':String(9*1024*1024)}})]) {
    const t=transport({value:{imageUrls:[image]},media:async()=>response});
    const result=await readReferenceLink({url:note},{},t.fetcher);
    assert.equal(result.status,'partial');assert.equal(result.images.length,0);assert.ok(result.missing.length);
  }
});

test('browser failures close only the owned tab and keep provider error details private',async()=>{
  const t=transport({evalError:true});const result=await readReferenceLink({url:note},{},t.fetcher);
  assert.equal(result.status,'unavailable');assert.doesNotMatch(JSON.stringify(result),/provider-private-error/);
  assert.ok(t.calls.at(-1).url.includes('/close?target=owned-test-tab'));
});
