import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { id, now, InputError, str } from './content.mjs';

export const MAX_MODEL_UPLOAD = 1024 ** 3;
const MODEL_MIMES = { '.step':'model/step', '.stp':'model/step', '.stl':'model/stl',
  '.glb':'model/gltf-binary', '.obj':'text/plain', '.blend':'application/octet-stream' };

function modelName(input) {
  if (typeof input === 'string' && /[\\/\u0000-\u001f\u007f]/.test(input)) throw new InputError('模型文件名不能包含路径或控制字符');
  const name = str(input, 180, true);
  if (name === '.' || name === '..') throw new InputError('模型文件名不能包含路径或控制字符');
  const extension = path.extname(name).toLowerCase();
  if (!MODEL_MIMES[extension]) throw new InputError('支持 STEP、STP、STL、GLB、OBJ 和 BLEND 模型文件');
  return { name, extension, mime:MODEL_MIMES[extension] };
}

async function validObj(filename) {
  let pending='',truncated=false,vertex=false,face=false;
  const number='[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const vertexLine=new RegExp(`^v\\s+${number}\\s+${number}\\s+${number}(?:\\s|$)`);
  const index='[-+]?[1-9]\\d*(?:\\/[-+\\d/]*)?';
  const faceLine=new RegExp(`^f\\s+${index}\\s+${index}\\s+${index}(?:\\s|$)`);
  const inspect=line=>{const text=line.trimStart();vertex ||= vertexLine.test(text);face ||= faceLine.test(text);};
  for await(const chunk of createReadStream(filename)) {
    const lines=(pending+chunk.toString('utf8')).split('\n');pending=lines.pop();
    for(const line of lines){if(truncated){truncated=false;continue;}inspect(line);}
    if(vertex&&face)return true;
    // Retain only a bounded line prefix, even for a malformed file with no newlines.
    if(pending.length>4096){if(!truncated)inspect(pending);pending='';truncated=true;}
  }
  if(!truncated)inspect(pending);
  return vertex&&face;
}

async function validateModel(filename, extension, size) {
  const file = await open(filename, 'r');
  const head = Buffer.alloc(Math.min(size, 65536)), tail = Buffer.alloc(Math.min(size, 65536));
  try { await file.read(head, 0, head.length, 0); await file.read(tail, 0, tail.length, size - tail.length); }
  finally { await file.close(); }
  const text = head.toString('utf8'), end = tail.toString('utf8');
  let valid = false;
  if (['.step','.stp'].includes(extension)) {
    valid = /^\uFEFF?\s*ISO-10303-21\s*;/i.test(text) && /\bHEADER\s*;/i.test(text)
      && /\bDATA\s*;/i.test(text) && /END-ISO-10303-21\s*;\s*$/i.test(end);
  } else if (extension === '.stl') {
    const triangles = head.length >= 84 ? head.readUInt32LE(80) : 0;
    valid = (triangles > 0 && 84 + 50 * triangles === size)
      || (/^\s*solid\b/i.test(text) && /\bfacet\s+normal\b/i.test(text)
        && (text.match(/\bvertex\s+[-+\d.]/gi)||[]).length >= 3 && /\bendfacet\b/i.test(text) && /\bendsolid\b[^\r\n]*\s*$/i.test(end));
  } else if (extension === '.glb') {
    valid = head.length >= 20 && head.toString('ascii',0,4) === 'glTF' && head.readUInt32LE(4) === 2
      && head.readUInt32LE(8) === size && head.readUInt32LE(12) >= 4 && head.readUInt32LE(12) % 4 === 0
      && head.readUInt32LE(12) + 20 <= size && head.toString('ascii',16,20) === 'JSON';
  } else if (extension === '.obj') {
    valid = await validObj(filename);
  } else if (extension === '.blend') {
    valid = size > 12 && /^BLENDER[_-][vV]\d{3}$/.test(head.toString('ascii',0,12));
  }
  if (!valid) throw new InputError('模型内容与文件格式不一致，或文件不完整');
}

// The request is streamed to a private staging file before taking the state lock.
// A large model is never expanded to a base64 string or buffered as a whole.
export async function receiveModelUpload(req, directory, inputName) {
  const description = modelName(inputName);
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream'
    || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw new InputError('模型需要以原始文件上传',415);
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) <= 0 || Number(declared) > MAX_MODEL_UPLOAD)) {
    throw new InputError('模型文件不能为空，且不能超过 1 GB',413);
  }
  const staging = path.join(directory,'product-assets','staging');
  await mkdir(staging,{recursive:true,mode:0o700});
  const filePath = path.join(staging,`model-${id()}.part`);
  let file, size = 0;
  const hash = createHash('sha256');
  try {
    file = await open(filePath,'wx',0o600);
    for await (const chunk of req.iterator({destroyOnReturn:false})) {
      size += chunk.length;
      if (size > MAX_MODEL_UPLOAD) throw new InputError('模型文件不能超过 1 GB',413);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const {bytesWritten} = await file.write(chunk,offset,chunk.length-offset);
        if (!bytesWritten) throw new Error('write_failed');
        offset += bytesWritten;
      }
    }
    if (!size) throw new InputError('模型文件不能为空',413);
    if (declared !== undefined && size !== Number(declared)) throw new InputError('模型上传不完整，请重新上传');
    await file.close(); file = null;
    await validateModel(filePath,description.extension,size);
    return {...description,filePath,size,sha256:hash.digest('hex')};
  } catch (error) {
    if (file) await file.close().catch(()=>{});
    await unlink(filePath).catch(()=>{});
    if (error instanceof InputError) throw error;
    throw new InputError(req.aborted ? '模型上传已中断，请重新上传' : '模型未保存，请检查磁盘空间后重试',req.aborted ? 400 : 500);
  }
}

export async function saveModelUpload(state, directory, upload) {
  const existing = state.productAssets.find(a=>a.kind==='model' && a.sha256===upload.sha256);
  const base = path.join(directory,'product-assets','files');
  await mkdir(base,{recursive:true});
  // Identical managed content keeps its filename and provenance. Explicit upload
  // upgrades a linked model in place, preserving its ID, metadata and preview.
  const fileName = existing?.storage==='managed' ? existing.fileName : upload.sha256 + upload.extension;
  if (!/^[a-f\d]{64}\.(step|stp|stl|glb|obj|blend)$/.test(fileName||'')) throw new InputError('已保存的模型文件无效',409);
  await rename(upload.filePath,path.join(base,fileName));
  upload.installedFileName = fileName;
  if (existing?.storage==='managed') return existing;
  const asset = existing || {id:id(),name:upload.name,originalName:upload.name,kind:'model',createdAt:now(),metadata:{}};
  Object.assign(asset,{storage:'managed',fileName,mime:upload.mime,size:upload.size,sha256:upload.sha256,
    sourceLabel:'上传模型/'+upload.name,description:'用户上传的3D模型；渲染结果为几何示意，不代表实机验证'});
  delete asset.sourcePath;
  if (!existing) state.productAssets.push(asset);
  return asset;
}

export async function cleanModelUpload(upload, directory, state, committed) {
  await unlink(upload.filePath).catch(()=>{});
  if (!committed && upload.installedFileName && !state.productAssets.some(a=>a.storage==='managed' && a.fileName===upload.installedFileName)) {
    await unlink(path.join(directory,'product-assets','files',upload.installedFileName)).catch(()=>{});
  }
}
