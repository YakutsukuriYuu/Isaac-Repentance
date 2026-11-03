import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {join,basename} from 'node:path';
import {crc32,readModZip,prepareModFromFiles,prepareModFromZip,validateModPath,mountMods,MAX_MOD_BYTES} from './mod_helpers.mjs';
const enc=new TextEncoder(),data=value=>enc.encode(value);
function archive(entries,{flags=0x800}={}){
  const local=[],central=[];let offset=0;
  for(const entry of entries){
    const name=data(entry.path),bytes=typeof entry.data==='string'?data(entry.data):entry.data||new Uint8Array(),method=entry.method||0,raw=method===8?deflateRawSync(bytes):bytes;
    const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50);lh.writeUInt16LE(20,4);lh.writeUInt16LE(flags,6);lh.writeUInt16LE(method,8);lh.writeUInt32LE(crc32(bytes),14);lh.writeUInt32LE(raw.length,18);lh.writeUInt32LE(bytes.length,22);lh.writeUInt16LE(name.length,26);
    const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(0x314,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(flags,8);cd.writeUInt16LE(method,10);cd.writeUInt32LE(crc32(bytes),16);cd.writeUInt32LE(raw.length,20);cd.writeUInt32LE(bytes.length,24);cd.writeUInt16LE(name.length,28);cd.writeUInt32LE(((entry.mode||0x81a4)<<16)>>>0,38);cd.writeUInt32LE(offset,42);
    local.push(lh,name,raw);central.push(cd,name);offset+=lh.length+name.length+raw.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return new Uint8Array(Buffer.concat([...local,cd,end]));
}
const main={path:'main.lua',data:'local m = RegisterMod("Demo", 1)'};
const metadata={path:'metadata.xml',data:'<metadata><name>Demo &amp; friends</name><directory>demo</directory><id>123456</id><version>1.2</version></metadata>'};
const records=items=>items.map(file=>({...file,data:typeof file.data==='string'?data(file.data):file.data}));

test('stored and deflated ZIP bytes round trip, including binary assets',async()=>{
  const assets=[main,metadata,{path:'resources/gfx/test.png',data:Uint8Array.from({length:10000},(_,i)=>i%251),method:8}];
  const out=await readModZip(archive(assets));
  assert.deepEqual(out.map(f=>f.path),assets.map(f=>f.path));assert.deepEqual(out[2].data,assets[2].data);
  const mod=await prepareModFromZip(archive(assets));assert.equal(mod.id,'123456');assert.equal(mod.name,'Demo & friends');assert.equal(mod.folder,'demo_123456');assert.equal(mod.version,'1.2');assert.equal(mod.fileCount,3);
});
test('folder imports strip one or several wrapper folders and preserve asset paths',async()=>{
  const mod=await prepareModFromFiles(records([main,metadata,{path:'resources/gfx/foo.png',data:'foo'}].map(f=>({...f,path:'download/demo/'+f.path}))));
  assert.deepEqual(mod.files.map(f=>f.path),['main.lua','metadata.xml','resources/gfx/foo.png']);assert.equal(mod.id,'123456');
});
test('generic local identity is stable across content updates',async()=>{
  const a=await prepareModFromFiles(records([{path:'my mod/main.lua',data:'v1'}]));
  const b=await prepareModFromFiles(records([{path:'my mod/main.lua',data:'v2'}]));
  assert.match(a.id,/^local-[0-9a-f]{24}$/);assert.equal(a.id,b.id);
});
test('unpublished metadata id zero receives a distinct local identity',async()=>{
  const a=await prepareModFromFiles(records([main,{path:'metadata.xml',data:'<metadata><directory>first</directory><id>0</id></metadata>'}]));
  const b=await prepareModFromFiles(records([main,{path:'metadata.xml',data:'<metadata><directory>second</directory><id>0</id></metadata>'}]));
  assert.match(a.id,/^local-/);assert.notEqual(a.id,b.id);
});
test('Mac metadata junk and disable.it are not mounted',async()=>{
  const mod=await prepareModFromFiles(records([main,{path:'.DS_Store',data:'junk'},{path:'__MACOSX/._a',data:'junk'},{path:'disable.it',data:''}]));
  assert.deepEqual(mod.files.map(f=>f.path),['main.lua']);
});
test('resource-only Mod with metadata imports',async()=>{
  const mod=await prepareModFromFiles(records([metadata,{path:'resources/gfx/isaac.png',data:'png'}]));assert.equal(mod.fileCount,2);
});
test('folder of unrelated files and multiple Mods is rejected',async()=>{
  await assert.rejects(()=>prepareModFromFiles(records([{path:'readme.txt',data:'nothing'}])),/根目录/);
  await assert.rejects(()=>prepareModFromFiles(records([{path:'one/main.lua',data:'one'},{path:'two/main.lua',data:'two'}])),/每次导入一个/);
});
test('traversal, absolute, Windows, non-normalized, and excessively deep paths rejected',()=>{
  for(const name of ['../main.lua','/main.lua','a\\main.lua','C:/main.lua','a/../main.lua','a//main.lua','a./main.lua','CON.txt','cafe\u0301/main.lua',Array(26).fill('a').join('/')])assert.throws(()=>validateModPath(name),/路径不合法/);
});
test('case and directory/file collisions rejected before output',async()=>{
  for(const items of [[main,{path:'MAIN.LUA',data:'x'}],[main,{path:'Foo/a',data:'x'},{path:'foo/b',data:'x'}],[main,{path:'x',data:'x'},{path:'x/a',data:'x'}]])await assert.rejects(()=>prepareModFromFiles(records(items)),/冲突|重名/);
});
test('ZIP traversal, symlink, encryption, unsupported compression and filename mismatch rejected',async()=>{
  await assert.rejects(()=>readModZip(archive([{path:'../main.lua',data:'x'}])),/路径不合法/);
  await assert.rejects(()=>readModZip(archive([{...main,mode:0xa1ff}])),/符号链接/);
  await assert.rejects(()=>readModZip(archive([main],{flags:1})),/加密/);
  await assert.rejects(()=>readModZip(archive([{...main,method:12}])),/Store/);
  const mismatch=archive([main]);mismatch[30]='M'.charCodeAt(0);await assert.rejects(()=>readModZip(mismatch),/文件名信息/);
});
test('CRC corruption, truncation, duplicate offsets and huge declared expansion rejected',async()=>{
  const corrupt=archive([main]);corrupt[30+main.path.length]^=1;await assert.rejects(()=>readModZip(corrupt),/校验失败/);
  await assert.rejects(()=>readModZip(corrupt.subarray(0,corrupt.length-1)),/有效的 ZIP/);
  const huge=archive([{...main,method:8}]),view=new DataView(huge.buffer);const cd=view.getUint32(huge.length-6,true);view.setUint32(cd+24,MAX_MOD_BYTES+1,true);view.setUint32(22,MAX_MOD_BYTES+1,true);await assert.rejects(()=>readModZip(huge),/超过/);
  const alias=archive([main,main]);await assert.rejects(()=>readModZip(alias),/重复/);
});
test('wrong advertised deflate output is bounded during decompression',async()=>{
  const zip=archive([{path:'main.lua',data:'x'.repeat(100000),method:8}]),view=new DataView(zip.buffer);const cd=view.getUint32(zip.length-6,true);view.setUint32(cd+24,1,true);view.setUint32(22,1,true);await assert.rejects(()=>readModZip(zip),/超过声明/);
});
test('mount creates only selected Mod directories with exact read-only bytes',async()=>{
  const mod=await prepareModFromFiles(records([main,metadata]));const writes=[];const FS={mkdirTree(){},createDataFile(dir,name,bytes,read,write,own){writes.push({path:dir+'/'+name,bytes,read,write,own});}};
  mountMods(FS,[mod]);assert.equal(writes.length,2);assert.equal(writes[0].path,'/game/mods/demo_123456/main.lua');assert.equal(writes[0].write,false);assert.deepEqual(writes[0].bytes,data(main.data));
});
const workshop='/Users/yakutsukuriyuu/Library/Application Support/Steam/steamapps/workshop/content/250900';
async function folderFiles(dir,prefix=basename(dir)){
  const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),relative=prefix+'/'+entry.name;
    assert.equal((await lstat(path)).isSymbolicLink(),false);if(entry.isDirectory())out.push(...await folderFiles(path,relative));else out.push({path:relative,data:new Uint8Array(await readFile(path))});}return out;
}
test('actual EID and GoodTrip fixtures are recognized without hardcoded preload', {skip:!existsSync(workshop+'/836319872')},async()=>{
  for(const id of ['836319872','1630477831']){const files=await folderFiles(workshop+'/'+id);const mod=await prepareModFromFiles(files);assert.equal(mod.id,id);assert.ok(mod.files.some(f=>f.path==='main.lua'));assert.ok(mod.bytes>100000);const zipped=await prepareModFromZip(archive(files.map(f=>({...f,method:8}))));assert.equal(zipped.id,id);assert.equal(zipped.bytes,mod.bytes);assert.deepEqual(zipped.files.map(f=>f.path),mod.files.map(f=>f.path));}
});
test('real browser IndexedDB persists enable/update/remove atomically', {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),source=await readFile(new URL('./mod_helpers.mjs',import.meta.url));
  const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/mod_helpers.mjs'?'text/javascript':'text/html');res.end(req.url==='/mod_helpers.mjs'?source:'<!doctype html><title>Mod storage test</title>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result=await page.evaluate(async()=>{
      const {openModStore,prepareModFromFiles}=await import('/mod_helpers.mjs');const store=await openModStore();const mod=await prepareModFromFiles([{path:'demo/main.lua',data:new TextEncoder().encode('v1')}]);
      if((await store.list()).length!==0)throw new Error('Fresh store not empty');await store.install(mod);await store.setEnabled(mod.id,false);
      let duplicate=false;try{await store.install(mod);}catch{duplicate=true;}if(!duplicate)throw new Error('Duplicate silently replaced');
      await store.install({...mod,files:[{path:'main.lua',data:new TextEncoder().encode('v2')}],bytes:2},{replace:true});store.close();
      const reopened=await openModStore(),saved=await reopened.get(mod.id);if(saved.enabled!==false||new TextDecoder().decode(saved.files[0].data)!=='v2')throw new Error('Persistence lost');
      if((await reopened.enabled()).length!==0)throw new Error('Disabled mod returned');await reopened.setEnabled(mod.id,true);if((await reopened.enabled()).length!==1)throw new Error('Enabled mod missing');await reopened.remove(mod.id);if((await reopened.list()).length!==0)throw new Error('Delete failed');if(await reopened.get(mod.id)!==null)throw new Error('Orphan remains');const second=await prepareModFromFiles([{path:'second/main.lua',data:new TextEncoder().encode('v1')}]);
      await reopened.install(mod);await reopened.install(second);await reopened.setSelection([second.id]);
      const selections=await reopened.list();if(selections.find(item=>item.id===mod.id).enabled||!selections.find(item=>item.id===second.id).enabled)throw new Error('Bulk selection failed');
      await reopened.setSelection([mod.id,second.id]);
      const original=IDBObjectStore.prototype.put;let writes=0,rejected=false;
      IDBObjectStore.prototype.put=function(...args){if(this.name==='mods'&&++writes===2)throw new DOMException('simulated full storage','QuotaExceededError');return original.apply(this,args);};
      try{await reopened.setSelection([]);}catch{rejected=true;}finally{IDBObjectStore.prototype.put=original;}
      if(!rejected||(await reopened.list()).some(item=>!item.enabled))throw new Error('Bulk selection did not roll back atomically');
      reopened.close();return true;
    });assert.equal(result,true);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
