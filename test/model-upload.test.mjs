import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { configureAuth } from '../app/auth.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const STEP = Buffer.from("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('RedPilot fixture'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
const STL = Buffer.from('solid fixture\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid fixture\n');
const OBJ = Buffer.from('o fixture\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
function glb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{}] }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const output = Buffer.alloc(20 + padded.length);
  output.write('glTF', 0, 'ascii'); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  return output;
}
function binarySTL() {
  const output = Buffer.alloc(134); output.write('RedPilot binary STL fixture', 0, 'ascii'); output.writeUInt32LE(1, 80);
  output.writeFloatLE(1, 92); output.writeFloatLE(1, 108); output.writeFloatLE(1, 124);
  return output;
}
function blend() {
  const output = Buffer.alloc(36); output.write('BLENDER-v400', 0, 'ascii'); output.write('ENDB', 12, 'ascii'); return output;
}
async function fixture(t, { renderRunner } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpilot-model-upload-'));
  const runtime = path.join(directory, 'runtime'), source = path.join(directory, 'source'); await mkdir(source);
  const credentials = { email: 'fixture@example.test', password: 'Test-only-' + randomBytes(18).toString('hex') };
  await configureAuth({ directory: runtime, ...credentials });
  let app = await createApp({ trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory: runtime, env: {}, renderRunner });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`, cookie;
  async function login() {
    const result = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(result.status, 200, 'fixture login failed'); cookie = result.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await login();
  function headers({ authenticated = true, origin = base, type = 'application/octet-stream' } = {}) {
    return { ...(authenticated ? { Cookie: cookie } : {}), ...(origin === null ? {} : { Origin: origin }), 'Content-Type': type };
  }
  return {
    runtime, source, get store() { return app.store; },
    async reopen() {
      await app.close(); app = await createApp({ trendReader: async () => [], linkReader: async () => ({ status: 'unavailable', missing: [], error: 'test-only offline reader' }), root, directory: runtime, env: {}, renderRunner });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`; await login();
    },
    async request(url, data, method = 'POST') {
      const result = await fetch(base + '/api/' + url, { method, headers: headers({ type: 'application/json' }), ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: result.status, data: await result.json() };
    },
    async upload(name, bytes, options = {}) {
      const result = await fetch(base + '/api/product-assets/upload-model?name=' + encodeURIComponent(name), { method: 'POST', headers: headers(options), body: bytes });
      return { status: result.status, data: await result.json() };
    },
    async native(name, { body, contentLength, chunked = false, ...options } = {}) {
      return new Promise(resolve => {
        const request = http.request(base + '/api/product-assets/upload-model?name=' + encodeURIComponent(name), {
          method: 'POST', headers: { ...headers(options), ...(contentLength === undefined ? {} : { 'Content-Length': contentLength }), ...(chunked ? { 'Transfer-Encoding': 'chunked' } : {}) }
        }, result => {
          const chunks = []; result.on('data', c => chunks.push(c)); result.on('end', () => {
            const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch {}
            resolve({ status: result.statusCode, data, text });
          });
        });
        request.setTimeout(3000, () => request.destroy(Error('test request timed out')));
        request.on('error', error => resolve({ networkError: error.code || error.message }));
        if (body) request.write(body); request.end();
      });
    },
    beginInterruptedUpload(name) {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const request = http.request(base + '/api/product-assets/upload-model?name=' + encodeURIComponent(name), {
        method: 'POST', headers: { ...headers(), 'Content-Length': STEP.length + 1000 }
      }, result => { result.resume(); result.on('end', () => finish({ status: result.statusCode })); });
      request.on('error', error => finish({ networkError: error.code }));
      request.setTimeout(3000, () => request.destroy());
      request.write(STEP.subarray(0, 50));
      return { abort() { request.destroy(); }, done };
    },
    async file(url) {
      const result = await fetch(base + url, { headers: { Cookie: cookie } });
      return { status: result.status, bytes: Buffer.from(await result.arrayBuffer()) };
    }
  };
}
const state = async f => (await f.request('state', undefined, 'GET')).data;
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function parts(f) {
  const files = await readdir(f.runtime, { recursive: true, withFileTypes: true });
  return files.filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name)).filter(filename => filename.endsWith('.part') || filename.includes(path.sep + 'staging' + path.sep));
}
async function waitUntil(check, message) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
function noPaths(asset, f) {
  const serialized = JSON.stringify(asset);
  assert.equal(serialized.includes(f.runtime), false); assert.equal(serialized.includes(f.source), false);
  for (const field of ['sourcePath', 'fileName', 'previewName']) assert.equal(field in asset, false);
}

test('raw STEP upload creates a managed, private-path-free model that remains readable after restart', async t => {
  const f = await fixture(t);
  const uploaded = ok(await f.upload('设备外壳.step', STEP));
  assert.equal(uploaded.kind, 'model'); assert.equal(uploaded.storage, 'managed');
  assert.equal(uploaded.sourceLabel, '上传模型/设备外壳.step');
  assert.equal(uploaded.renderable, true); assert.equal(uploaded.size, STEP.length);
  assert.equal(uploaded.sha256, createHash('sha256').update(STEP).digest('hex'));
  noPaths(uploaded, f);
  assert.deepEqual((await f.file(uploaded.fileUrl)).bytes, STEP);
  assert.deepEqual(await parts(f), []);
  await f.reopen();
  assert.equal((await state(f)).productAssets.find(a => a.id === uploaded.id).storage, 'managed');
  assert.deepEqual((await f.file(uploaded.fileUrl)).bytes, STEP);
});

test('the raw stream supports the allowed model formats and only STEP or STP are renderable', async t => {
  const f = await fixture(t);
  for (const [name, bytes, renderable] of [
    ['fixture.stp', STEP, true], ['facet.stl', STL, false], ['binary.stl', binarySTL(), false],
    ['scene.glb', glb(), false], ['mesh.obj', OBJ, false], ['scene.blend', blend(), false]
  ]) {
    const result = ok(await f.upload(name, bytes));
    assert.equal(result.kind, 'model', name); assert.equal(result.storage, 'managed', name);
    assert.equal(result.renderable, renderable, name); noPaths(result, f);
  }
  assert.deepEqual(await parts(f), []);
});

test('chunked uploads without Content-Length use the streaming path and enforce non-empty content', async t => {
  const f = await fixture(t);
  const result = await f.native('chunked.step', { chunked: true, body: STEP });
  const asset = ok(result); assert.deepEqual((await f.file(asset.fileUrl)).bytes, STEP);
  const empty = await f.native('empty.step', { chunked: true });
  assert.equal(empty.status, 413);
  assert.equal((await state(f)).productAssets.length, 1);
  assert.deepEqual(await parts(f), []);
});

test('repeated raw uploads deduplicate by SHA256 without creating extra managed models', async t => {
  const f = await fixture(t);
  const first = ok(await f.upload('first.step', STEP));
  const second = ok(await f.upload('second.step', STEP));
  assert.equal(second.id, first.id);
  assert.equal((await state(f)).productAssets.length, 1);
  assert.deepEqual(await parts(f), []);
});

test('uploading a linked model upgrades it in place while retaining its preview and renderability', async t => {
  const calls = [];
  const f = await fixture(t, { renderRunner: async args => { calls.push(args); assert.deepEqual(await readFile(args.modelPath), STEP); await writeFile(args.outputPath, PNG); return args.outputPath; } });
  const filename = path.join(f.source, 'original.step'); await writeFile(filename, STEP);
  ok(await f.request('product-assets/import', { paths: [filename], mode: 'linked' }));
  const linked = (await state(f)).productAssets.find(a => a.kind === 'model');
  await f.store.mutate(s => { s.productAssets.find(a => a.id === linked.id).metadata.provenance = 'source-model'; });
  const render = ok(await f.request(`product-assets/${linked.id}/render`, { preset: 'angle' }));
  await waitUntil(async () => (await state(f)).productRenders.find(j => j.id === render.id)?.status === 'completed', 'linked model rendering failed');
  const prior = (await state(f)).productAssets.find(a => a.id === linked.id);
  const previewId = f.store.state.productAssets.find(a => a.id === linked.id).previewAssetId;
  assert.ok(previewId, 'linked model render did not create a preview asset');
  const uploaded = ok(await f.upload('uploaded.step', STEP));
  assert.equal(uploaded.id, linked.id); assert.equal(uploaded.storage, 'managed');
  assert.equal(uploaded.sourceLabel, '上传模型/uploaded.step'); assert.equal(uploaded.previewUrl, prior.previewUrl);
  const stored = f.store.state.productAssets.find(a => a.id === linked.id);
  assert.equal('sourcePath' in stored, false); assert.equal(stored.previewAssetId, previewId);
  assert.equal(stored.metadata.provenance, 'source-model');
  assert.deepEqual((await f.file(uploaded.previewUrl)).bytes, PNG);
  await rename(filename, path.join(f.source, 'moved.step'));
  assert.deepEqual((await f.file(uploaded.fileUrl)).bytes, STEP);
  const next = ok(await f.request(`product-assets/${linked.id}/render`, { preset: 'front' }));
  await waitUntil(async () => (await state(f)).productRenders.find(j => j.id === next.id)?.status === 'completed', 'managed model rendering failed');
  assert.equal(calls.length, 2); assert.notEqual(calls[1].modelPath, filename);
  assert.ok(calls[1].modelPath.startsWith(f.runtime));
  assert.equal((await state(f)).productAssets.filter(a => a.kind === 'model').length, 1);
  assert.deepEqual(await parts(f), []);
});

test('declared empty and over-1GB lengths are rejected before any body or staging file is required', async t => {
  const f = await fixture(t);
  for (const contentLength of [0, 1024 ** 3 + 1]) {
    const result = await f.native('oversized.step', { contentLength });
    assert.equal(result.status, 413, JSON.stringify(result));
  }
  assert.equal((await state(f)).productAssets.length, 0);
  assert.deepEqual(await parts(f), []);
});

test('raw uploads reject JSON, text and multipart content types without leaving records or partial files', async t => {
  const f = await fixture(t);
  for (const type of ['application/json', 'text/plain', 'multipart/form-data; boundary=test']) {
    const result = await f.upload('model.step', STEP, { type });
    assert.equal(result.status, 415);
  }
  assert.equal((await state(f)).productAssets.length, 0); assert.deepEqual(await parts(f), []);
});

test('model file names cannot contain paths, control characters, unsupported suffixes or external-dependency glTF', async t => {
  const f = await fixture(t);
  for (const name of ['../model.step', 'folder/model.step', 'folder\\model.step', '/absolute.step', 'bad\r\nname.step', 'bad\0name.step', 'part.step\n', '\rpart.step', 'x'.repeat(181) + '.step', 'scene.gltf', 'model.exe', 'model.step.exe', '']) {
    const bytes = name.endsWith('.gltf') ? Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"external.bin"}]}') : STEP;
    assert.equal((await f.upload(name, bytes)).status, 400, JSON.stringify(name));
  }
  assert.equal((await state(f)).productAssets.length, 0); assert.deepEqual(await parts(f), []);
});

test('strict extension and signature checks reject disguised STEP, OBJ, BLEND, STL and malformed GLB', async t => {
  const f = await fixture(t);
  const wrongVersion = glb(); wrongVersion.writeUInt32LE(99, 4);
  const wrongLength = glb(); wrongLength.writeUInt32LE(wrongLength.length + 4, 8);
  const invalidCount = binarySTL(); invalidCount.writeUInt32LE(2, 80);
  for (const [name, bytes] of [
    ['fake.step', Buffer.from('not a STEP file')], ['incomplete.stp', Buffer.from('ISO-10303-21;\nHEADER;\nDATA;\n')],
    ['fake.obj', Buffer.from('a text file with no vertices or face')], ['fake.blend', Buffer.from('BLENDER')],
    ['fake.stl', Buffer.alloc(100, 0x41)], ['count.stl', invalidCount], ['fake.glb', Buffer.from('glTF')],
    ['version.glb', wrongVersion], ['length.glb', wrongLength]
  ]) assert.equal((await f.upload(name, bytes)).status, 400, name);
  assert.equal((await state(f)).productAssets.length, 0); assert.deepEqual(await parts(f), []);
});

test('valid authentication and same-origin headers are required before a model stream is stored', async t => {
  const f = await fixture(t);
  const anonymous = await f.upload('model.step', STEP, { authenticated: false });
  assert.equal(anonymous.status, 401); assert.equal(anonymous.data.code, 'AUTH_REQUIRED');
  assert.equal((await f.upload('model.step', STEP, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.upload('model.step', STEP, { origin: null })).status, 403);
  assert.equal((await state(f)).productAssets.length, 0); assert.deepEqual(await parts(f), []);
});

test('an interrupted model stream cleans its partial file and leaves existing asset records intact', async t => {
  const f = await fixture(t);
  const existing = ok(await f.upload('saved.step', STEP));
  const request = f.beginInterruptedUpload('interrupted.step');
  try {
    await waitUntil(async () => (await parts(f)).some(filename => filename.endsWith('.part')), 'test upload never opened a staging file');
  } finally { request.abort(); }
  await request.done;
  await waitUntil(async () => (await parts(f)).length === 0, 'aborted upload left staging files');
  const s = await state(f);
  assert.equal(s.productAssets.length, 1); assert.equal(s.productAssets[0].id, existing.id);
  assert.deepEqual((await f.file(existing.fileUrl)).bytes, STEP);
});


test('large OBJ uploads find positive face indices beyond the first and last 64KiB', async t => {
  const f = await fixture(t);
  const vertices = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n'.repeat(4000);
  const comments = '# trailing padding\n'.repeat(5000);
  assert.ok(Buffer.byteLength(vertices) > 65536);
  assert.ok(Buffer.byteLength(comments) > 65536);
  const bytes = Buffer.from('o complete-mesh\n' + vertices + 'f 1 2 3\n' + comments);
  const result = ok(await f.upload('large-geometry.obj', bytes));
  assert.equal(result.kind, 'model'); assert.equal(result.storage, 'managed');
  assert.deepEqual((await f.file(result.fileUrl)).bytes, bytes);
  assert.deepEqual(await parts(f), []);
});

test('OBJ upload accepts legal negative face indices', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('o relative-indices\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
  const result = ok(await f.upload('negative-indices.obj', bytes));
  assert.equal(result.kind, 'model');
  assert.deepEqual((await f.file(result.fileUrl)).bytes, bytes);
  assert.deepEqual(await parts(f), []);
});
