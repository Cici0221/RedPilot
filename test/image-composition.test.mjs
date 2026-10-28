import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {composeImage,validateTextOverlay} from '../app/image-composition.mjs';

const overlay=()=>({version:1,width:1024,height:1536,layers:[{id:'headline',text:'备用号，换个位置',x:72,y:110,fontSize:72,color:'#152238',fontWeight:800,align:'left',maxWidth:880,lineHeight:1.2,maxLines:4}]});
async function background(){const canvas=createCanvas(1024,1536),ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1024,1536);return canvas.encode('png');}

test('editable text renders into a fresh PNG while retaining the original background and exact layer data',async()=>{
  const source=await background(),original=Buffer.from(source),input=overlay(),result=await composeImage(source,input);
  assert.equal(result.mime,'image/png');assert.equal(result.width,1024);assert.equal(result.height,1536);assert.deepEqual(source,original);assert.notDeepEqual(result.bytes,source);
  assert.equal(result.overlay.layers[0].text,input.layers[0].text);assert.equal(input.layers[0].maxLines,4);
  const preview=await loadImage(result.bytes);assert.equal(preview.width,1024);assert.equal(preview.height,1536);
  const edited=overlay();edited.layers[0].text='改好文字，无需重新生图';const next=await composeImage(source,edited);assert.notDeepEqual(result.bytes,next.bytes);
  const canvas=createCanvas(1024,1536),ctx=canvas.getContext('2d');ctx.drawImage(preview,0,0);const pixels=ctx.getImageData(72,110,850,150).data;assert.ok([...pixels].some((value,index)=>index%4!==3&&value<180),'a title must be visibly rendered');
});

test('layer input excludes external styling, uncontrolled dimensions and invalid positions',()=>{
  for(const patch of [{width:90000},{height:0},{version:2},{layers:Array(7).fill(overlay().layers[0])}])assert.throws(()=>validateTextOverlay({...overlay(),...patch}));
  for(const patch of [{color:'url(https://example.invalid)'},{fontWeight:10000},{fontSize:0},{align:'start'},{x:-5},{x:1000},{y:1536},{maxWidth:9999},{text:'bad\u0000text'}])assert.throws(()=>validateTextOverlay({...overlay(),layers:[{...overlay().layers[0],...patch}]}));
  assert.throws(()=>validateTextOverlay({...overlay(),layers:[overlay().layers[0],overlay().layers[0]]}));
});

test('overflow and overlapping text are rejected before a publication image is produced',async()=>{
  const source=await background(),long=overlay();long.layers[0].text='字'.repeat(200);long.layers[0].maxLines=1;
  await assert.rejects(composeImage(source,long),{status:422});
  const overlap=overlay();overlap.layers.push({...overlap.layers[0],id:'copy',text:'发生重叠'});
  await assert.rejects(composeImage(source,overlap),{status:422});
  await assert.rejects(composeImage(Buffer.from('not an image'),overlay()),{status:422});
});
