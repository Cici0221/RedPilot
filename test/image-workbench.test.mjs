import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageProviderStatus, validateImageRequest, generateImage } from '../app/image-workbench.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', 'base64');
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64');
const env = { REDPILOT_IMAGE_API_KEY: 'fixture-image-key', REDPILOT_AI_KEY: 'fixture-text-key' };
const request = { mode: 'generate', prompt: '蓝白简约的产品背景，保留留白' };
const assets = [
  { id: 'png', kind: 'image', mime: 'image/png', size: PNG.length },
  { id: 'jpg', kind: 'image', mime: 'image/jpeg', size: JPEG.length },
  { id: 'webp', kind: 'image', mime: 'image/webp', size: WEBP.length },
  { id: 'icon', kind: 'icon', mime: 'image/svg+xml' },
  { id: 'pdf', kind: 'brochure', mime: 'application/pdf' },
  { id: 'model', kind: 'model', mime: 'model/step' }
];
const response = bytes => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
const run = (fetcher, options = {}, configuration = env) => generateImage(configuration, { request, ...options }, fetcher);
const failStatus = status => error => error.status === status;

test('image configuration exposes only readiness and its own model, including safe main-provider fallback', () => {
  assert.deepEqual(imageProviderStatus({}), { ready: false, model: 'gpt-image-2.5-sunburst' });
  assert.deepEqual(imageProviderStatus({ REDPILOT_AI_KEY: 'text-only', REDPILOT_AI_MODEL: 'text-model' }), { ready: true, model: 'gpt-image-2.5-sunburst' });
  assert.deepEqual(imageProviderStatus({ REDPILOT_AI_KEY: 'text-only', REDPILOT_AI_BASE_URL: 'https://text.example/v1' }), { ready: false, model: 'gpt-image-2.5-sunburst' });
  assert.deepEqual(imageProviderStatus({ OPENAI_API_KEY: 'test-key', REDPILOT_IMAGE_MODEL: 'custom-image' }), { ready: true, model: 'custom-image' });
  assert.deepEqual(Object.keys(imageProviderStatus(env)).sort(), ['model', 'ready']);
});

test('request validation normalizes only supported fields and sizes', () => {
  assert.deepEqual(validateImageRequest({ prompt: '  原创产品场景  ', ignored: 'extra' }, assets), {
    mode: 'generate', prompt: '原创产品场景', sourceAssetIds: [], size: '1024x1536'
  });
  for (const size of ['1024x1024', '1024x1536', '1536x1024']) {
    assert.equal(validateImageRequest({ ...request, size }, assets).size, size);
  }
  assert.equal(validateImageRequest({ ...request, prompt: '字'.repeat(4000) }, assets).prompt.length, 4000);
});

test('request validation rejects bad mode, prompt, size and source combinations', () => {
  for (const input of [null, [], {}, { prompt: '' }, { prompt: ' ' }, { prompt: 1 },
    { ...request, prompt: '字'.repeat(4001) }, { ...request, mode: 'unknown' },
    { ...request, size: 'auto' }, { ...request, sourceAssetIds: ['png'] },
    { ...request, mode: 'edit' }, { ...request, mode: 'edit', sourceAssetIds: 'png' },
    { ...request, mode: 'edit', sourceAssetIds: ['png', 'png'] },
    { ...request, mode: 'edit', sourceAssetIds: Array(5).fill('png') }]) {
    assert.throws(() => validateImageRequest(input, assets), failStatus(400));
  }
});

test('only existing raster image assets can be used for editing', () => {
  for (const sourceAssetIds of [['missing'], ['icon'], ['pdf'], ['model']]) {
    assert.throws(() => validateImageRequest({ ...request, mode: 'edit', sourceAssetIds }, assets), failStatus(400));
  }
  const edit = { ...request, mode: 'edit', sourceAssetIds: ['png', 'jpg', 'webp'] };
  assert.deepEqual(validateImageRequest(edit, assets).sourceAssetIds, edit.sourceAssetIds);
  assert.throws(() => validateImageRequest(edit, assets.map(a => a.id === 'png' ? { ...a, size: 20 * 1024 * 1024 + 1 } : a)), failStatus(400));
});

test('generation uses the official JSON endpoint with explicit model, one PNG and a timeout', async () => {
  let calls = 0;
  const result = await run(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-image-key');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    const payload=JSON.parse(init.body);
    assert.deepEqual({...payload,prompt:request.prompt}, { model: 'gpt-image-2.5-sunburst', prompt: request.prompt, n: 1, size: '1024x1536', output_format: 'png' });
    assert.ok(payload.prompt.includes(request.prompt));assert.match(payload.prompt,/成品图片/);assert.match(payload.prompt,/本次没有产品来源图/);
    return response(PNG);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { bytes: PNG, mime: 'image/png', extension: 'png', model: 'gpt-image-2.5-sunburst', size: '1024x1536' });
});

test('editing sends multipart references with no local paths or manual boundary header', async () => {
  const edit = validateImageRequest({ ...request, mode: 'edit', sourceAssetIds: ['png', 'webp'] }, assets);
  await run(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.headers['Content-Type'], undefined);
    for (const [name, value] of Object.entries({ model: 'gpt-image-2.5-sunburst', n: '1', size: '1024x1536', output_format: 'png' })) {
      assert.equal(init.body.get(name), value);
    }
    assert.ok(init.body.get('prompt').includes(request.prompt));assert.match(init.body.get('prompt'),/轮廓、长宽厚比例/);
    const images = init.body.getAll('image[]');
    assert.equal(images.length, 2);
    assert.equal(images[0].name, 'product.png');
    assert.equal(images[1].name, 'second.webp');
    assert.equal(images[0].type, 'image/png');
    assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), PNG);
    return response(PNG);
  }, { request: edit, sourceImages: [
    { bytes: PNG, mime: 'image/png', name: '/private/local/product.png' },
    { bytes: WEBP, mime: 'image/webp', name: 'C:\\private\\second.webp' }
  ] });
});

test('finished-art prompts preserve exact user copy while requiring readable layout, material and lighting quality',async()=>{
  const prompt='封面标题：“卡放家里，手机照常用”\n副标题：“工程内测”\n用暖灰色背景，不要蓝白色；竖版，下方留白。';
  await run(async(_url,init)=>{
    const sent=JSON.parse(init.body).prompt;
    assert.ok(sent.includes(prompt),'the full user brief and verbatim Chinese copy must remain intact');
    assert.match(sent,/用户明确指定的配色/);assert.match(sent,/逐字准确/);assert.match(sent,/未指定文字时不添加文字/);
    assert.match(sent,/缩略图仍能辨识/);assert.match(sent,/真实接触阴影和一致透视/);assert.match(sent,/合理反射/);assert.match(sent,/不擅自补标语、价格、销量或宣传承诺/);
    assert.match(sent,/不凭文字捏造品牌产品实物/);assert.match(sent,/不发明产品结构、配件、通信功能或应用界面/);
    return response(PNG);
  },{request:{...request,prompt}});
});

test('reference edits lock real product geometry and rebuild rough CAD presentation instead of copying preview quality',async()=>{
  const edit={...request,mode:'edit',sourceAssetIds:['png'],prompt:'保留产品外形，制作小红书蓝白封面，标题：“备用号怎么安放？”'};
  await run(async(_url,init)=>{
    const sent=init.body.get('prompt');
    assert.ok(sent.includes(edit.prompt));assert.match(sent,/第1张优先用于识别主体/);assert.match(sent,/开孔、按键、接口、屏幕位置、标志/);
    assert.match(sent,/不拼接不同产品，不补造背面或内部结构/);assert.match(sent,/保留未要求修改的内容/);
    assert.match(sent,/模型预览或CAD图，只取几何与比例/);assert.match(sent,/不复制灰模材质、网格感、锯齿、生硬阴影/);assert.match(sent,/重新制作成品级光影和画面/);
    assert.match(sent,/不额外添加信号条、通话画面、功能图标或连接示意/);assert.doesNotMatch(sent,/\/private\/local/);
    assert.equal(init.body.getAll('image[]').length,1);return response(PNG);
  },{request:edit,sourceImages:[{bytes:PNG,mime:'image/png',name:'/private/local/product.png'}]});
});

test('provider accepts validated JPEG and WebP bytes without trusting output names', async () => {
  for (const [bytes, mime, extension] of [[JPEG, 'image/jpeg', 'jpg'], [WEBP, 'image/webp', 'webp']]) {
    const result = await run(async () => response(bytes));
    assert.equal(result.mime, mime);
    assert.equal(result.extension, extension);
    assert.deepEqual(result.bytes, bytes);
  }
});

test('explicit image credentials retain priority over main-provider fallback, even with different services', async () => {
  const differentServices = { REDPILOT_IMAGE_BASE_URL: 'https://images.example/v1', REDPILOT_AI_BASE_URL: 'https://text.example/v1' };
  for (const [configuration, expected] of [
    [{ ...env, OPENAI_API_KEY: 'fixture-openai', ...differentServices }, 'fixture-image-key'],
    [{ REDPILOT_IMAGE_API_KEY: ' ', OPENAI_API_KEY: 'fixture-openai', REDPILOT_AI_KEY: 'wrong', ...differentServices }, 'fixture-openai']
  ]) {
    await run(async (_url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${expected}`);
      return response(PNG);
    }, {}, configuration);
  }
});

test('main-provider key is reused only for matching normalized service URLs without changing the image model', async () => {
  for (const configuration of [
    { REDPILOT_AI_KEY: 'fixture-main-key' },
    { REDPILOT_AI_KEY: 'fixture-main-key', REDPILOT_IMAGE_API_KEY: ' ', OPENAI_API_KEY: ' ', REDPILOT_AI_MODEL: 'text-model', REDPILOT_AI_BASE_URL: 'https://API.OpenAI.com:443/v1///', REDPILOT_IMAGE_BASE_URL: ' https://api.openai.com/v1/ ' },
    { REDPILOT_AI_KEY: 'fixture-main-key', REDPILOT_AI_BASE_URL: 'https://shared.example/api/v1/', REDPILOT_IMAGE_BASE_URL: 'https://SHARED.example:443/api/v1', REDPILOT_IMAGE_MODEL: 'custom-image' }
  ]) {
    assert.deepEqual(Object.keys(imageProviderStatus(configuration)).sort(), ['model', 'ready']);
    assert.equal(imageProviderStatus(configuration).ready, true);
    const result = await run(async (url, init) => {
      assert.equal(url, configuration.REDPILOT_IMAGE_MODEL ? 'https://shared.example/api/v1/images/generations' : 'https://api.openai.com/v1/images/generations');
      assert.equal(init.headers.Authorization, 'Bearer fixture-main-key');
      assert.equal(JSON.parse(init.body).model, configuration.REDPILOT_IMAGE_MODEL || 'gpt-image-2.5-sunburst');
      return response(PNG);
    }, {}, configuration);
    assert.equal(result.model, configuration.REDPILOT_IMAGE_MODEL || 'gpt-image-2.5-sunburst');
    assert.equal(JSON.stringify(imageProviderStatus(configuration)).includes(configuration.REDPILOT_AI_KEY), false);
  }
});

test('main-provider credentials never reach a different or invalid image service and invalid config stays safe to inspect', async () => {
  const mainKey = 'fixture-main-key-never-cross-services';
  const bases = [
    { REDPILOT_IMAGE_BASE_URL: 'https://images.example/v1' },
    { REDPILOT_AI_BASE_URL: 'https://text.example/v1' },
    { REDPILOT_AI_BASE_URL: 'https://shared.example/v1', REDPILOT_IMAGE_BASE_URL: 'https://shared.example/v2' },
    { REDPILOT_AI_BASE_URL: 'https://shared.example/v1', REDPILOT_IMAGE_BASE_URL: 'https://shared.example:8443/v1' },
    { REDPILOT_AI_BASE_URL: 'https://localhost/v1', REDPILOT_IMAGE_BASE_URL: 'http://localhost/v1' }
  ];
  for (const invalid of ['not-url', 'http://images.example/v1', 'http://localhost/v1', 'http://127.0.0.1/v1', 'https://127.0.0.1/v1', 'https://shared.example:8443/v1', 'https://user:password@images.example/v1', 'https://images.example/v1?key=secret', 'https://images.example/v1#fragment', 'https://images.example/v1?', 'https://images.example/v1#', 'https://images.ex\nample/v1']) {
    bases.push({ REDPILOT_AI_BASE_URL: invalid, REDPILOT_IMAGE_BASE_URL: invalid });
  }
  let calls = 0;
  for (const base of bases) {
    const configuration = { REDPILOT_AI_KEY: mainKey, ...base };
    assert.deepEqual(imageProviderStatus(configuration), { ready: false, model: 'gpt-image-2.5-sunburst' });
    await assert.rejects(run(async () => { calls++; assert.fail('main-provider key was sent to an unapproved service'); }, {}, configuration), error => error.status === 409 && !error.message.includes(mainKey));
  }
  assert.equal(calls, 0);
});

test('custom base URL and model are used, while credential-bearing or insecure addresses are rejected', async () => {
  await run(async (url, init) => {
    assert.equal(url, 'https://images.example/v1/images/generations');
    assert.equal(JSON.parse(init.body).model, 'custom-image-model');
    return response(PNG);
  }, {}, { ...env, REDPILOT_IMAGE_BASE_URL: 'https://images.example/v1/', REDPILOT_IMAGE_MODEL: 'custom-image-model' });
  for (const base of ['not-url', 'http://images.example/v1', 'https://user:password@images.example/v1', 'https://images.example/v1?key=secret', 'https://images.example/v1#fragment']) {
    await assert.rejects(run(async () => assert.fail('invalid URL was fetched'), {}, { ...env, REDPILOT_IMAGE_BASE_URL: base }), failStatus(409));
  }
  await run(async url => { assert.equal(url, 'http://127.0.0.1:4321/v1/images/generations'); return response(PNG); }, {}, { ...env, REDPILOT_IMAGE_BASE_URL: 'http://127.0.0.1:4321/v1' });
});

test('source bytes must match selected references, declared MIME and raster signatures before fetch', async () => {
  const edit = { ...request, mode: 'edit', sourceAssetIds: ['png'] };
  for (const sourceImages of [[], [{ bytes: PNG.toString('base64'), mime: 'image/png' }],
    [{ bytes: PNG, mime: 'image/jpeg' }], [{ bytes: Buffer.from('<svg/>'), mime: 'image/png' }],
    [{ bytes: PNG.subarray(0, 20), mime: 'image/png' }],
    [{ bytes: Buffer.alloc(20 * 1024 * 1024 + 1), mime: 'image/png' }]]) {
    await assert.rejects(run(async () => assert.fail('invalid reference was sent'), { request: edit, sourceImages }), failStatus(400));
  }
});

test('returned URLs are never downloaded, including when there is no base64 result', async () => {
  let calls = 0;
  await assert.rejects(run(async () => {
    calls++;
    return new Response(JSON.stringify({ data: [{ url: 'https://untrusted.example/generated.png' }] }));
  }), failStatus(502));
  assert.equal(calls, 1);
});

test('invalid result format, base64 and disguised non-image data are rejected', async () => {
  for (const body of ['<html>upstream error</html>', JSON.stringify({}),
    JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }] }),
    JSON.stringify({ data: [{ b64_json: 'bad!encoding' }] }),
    JSON.stringify({ data: [{ b64_json: PNG.toString('base64').replace(/=$/, '') }] }),
    JSON.stringify({ data: [{ b64_json: Buffer.from('<script>bad()</script>').toString('base64') }] }),
    JSON.stringify({ data: [{ b64_json: Buffer.from('RIFF0000WEBP').toString('base64') }] })]) {
    await assert.rejects(run(async () => new Response(body)), failStatus(502));
  }
  const damaged = Buffer.from(WEBP);
  damaged.writeUInt32LE(1, 4);
  await assert.rejects(run(async () => response(damaged)), failStatus(502));
});

test('oversized declared and streamed responses are cancelled before parsing', async () => {
  let cancelled = false;
  const tooLarge = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(30 * 1024 * 1024) } });
  await assert.rejects(run(async () => tooLarge()), failStatus(502));
  assert.equal(cancelled, true);
  let sent = 0;
  cancelled = false;
  await assert.rejects(run(async () => new Response(new ReadableStream({
    pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; }
  }))), failStatus(502));
  assert.equal(cancelled, true);
  assert.ok(sent < 31, 'the stream was not bounded');
});

test('decoded image size is bounded independently of JSON size', async () => {
  const bytes = Buffer.alloc(20 * 1024 * 1024 + 1);
  await assert.rejects(run(async () => response(bytes)), failStatus(502));
});

test('HTTP, network and timeout errors never expose provider bodies, prompts or credentials', async () => {
  const sensitive = 'fixture-provider-secret-and-original-prompt';
  for (const fetcher of [async () => new Response(sensitive, { status: 401 }), async () => { throw new Error(sensitive); }]) {
    await assert.rejects(run(fetcher), error => error.status === 502 && !error.message.includes(sensitive) && !error.message.includes(env.REDPILOT_IMAGE_API_KEY));
  }
  await assert.rejects(run(async () => { throw new DOMException(sensitive, 'TimeoutError'); }), error => error.status === 504 && !error.message.includes(sensitive));
});
