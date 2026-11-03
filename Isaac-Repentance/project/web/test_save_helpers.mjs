import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SAVE_FORMAT,SAVE_TARGET,MAX_SAVE_BYTES,parseBackup,parseNativeSaves,createBackup,applyBackup,collectSaveFiles,collectNativeSaves,validateSavePath,bytesToBase64,sha256} from './save_helpers.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'isaac-save-transfer-'));
const map=name=>{assert(name==='/game'||name.startsWith('/game/'));return path.join(root,name.slice('/game'.length));};
const FS={lstat:name=>fs.lstatSync(map(name)),readdir:name=>fs.readdirSync(map(name)),
  isDir:mode=>(mode&0o170000)===0o040000,isFile:mode=>(mode&0o170000)===0o100000,isLink:mode=>(mode&0o170000)===0o120000,
  mkdir:name=>fs.mkdirSync(map(name)),writeFile:(name,data)=>fs.writeFileSync(map(name),data),
  readFile:name=>new Uint8Array(fs.readFileSync(map(name))),unlink:name=>fs.unlinkSync(map(name))};
const user='user/Documents/My Games/Binding of Isaac Repentance/';
const game='/game/'+user+'gamestate1.dat',config='/game/data/external item descriptions/save1.dat';
let checks=0;
function write(name,data){fs.mkdirSync(path.dirname(map(name)),{recursive:true});fs.writeFileSync(map(name),data);}
function check(name,test){test();checks++;console.log('PASS',name);}
async function asyncCheck(name,test){await test();checks++;console.log('PASS',name);}
try{
  check('native export with no save directory returns an empty list',()=>assert.deepEqual(collectNativeSaves(FS),[]));
  write(game,new Uint8Array([0,255,1,2,3,128,0]));
  write('/game/'+user+'options.ini','[Options]\nLanguage=2\n');
  write(config,'{"Language":"zh_cn","Version":"3.2"}');
  write('/game/'+user+'log.txt','must not export log');
  write('/game/data/external item descriptions/main.lua','must not export code');
  write('/game/data/external item descriptions/icon.png','must not export image');
  write('/game/data/external item descriptions/resources.a','must not export archive');
  const backup=await createBackup(FS,['836319872','1630477831']);
  check('export includes exact game/config bytes, excludes log/code/resources',()=>{
    assert.equal(backup.files.length,3);assert.equal(backup.format,SAVE_FORMAT);assert.equal(backup.target,SAVE_TARGET);
    assert.deepEqual(backup.files.map(f=>f.path).sort(),[user+'gamestate1.dat',user+'options.ini','data/external item descriptions/save1.dat'].sort());
  });
  const parsed=await parseBackup(JSON.stringify(backup));
  check('binary and UTF-8 JSON roundtrip preserves exact bytes',()=>{
    for(const file of parsed.files)assert.deepEqual(file.data,FS.readFile('/game/'+file.path));
    assert.deepEqual(parsed.selectedMods,['836319872','1630477831']);
  });
  await asyncCheck('corrupted file fails SHA256 before import',async()=>{
    const bad=structuredClone(backup);bad.files[0].base64=bytesToBase64(new Uint8Array(bad.files[0].size));
    await assert.rejects(parseBackup(JSON.stringify(bad)),/校验失败/);
  });
  await asyncCheck('local Mod identifiers roundtrip with older workshop backups',async()=>{
    const selected=['836319872','local-0123456789abcdef01234567'];
    const local=await createBackup(FS,selected);
    assert.deepEqual((await parseBackup(JSON.stringify(local))).selectedMods,selected);
  });
  await asyncCheck('native PC save import normalizes Steam prefix and keeps exact bytes',async()=>{
    const bytes=Uint8Array.of(0,255,128,7);
    const native=await parseNativeSaves([new File([bytes],'rep_persistentgamedata1.dat'),new File(['[Options]\nLanguage=0'],'options.ini')],['836319872']);
    assert.equal(native.files[0].path,user+'persistentgamedata1.dat');
    assert.deepEqual(native.files[0].data,bytes);
    assert.equal(native.files[0].sha256,await sha256(bytes));
    assert.deepEqual(native.selectedMods,['836319872']);
  });
  await asyncCheck('native imports reject ambiguous duplicates, unrelated files and empty data',async()=>{
    await assert.rejects(parseNativeSaves([new File(['x'],'rep_gamestate1.dat'),new File(['y'],'gamestate1.dat')]),/重复/);
    for(const file of [new File(['x'],'main.lua'),new File(['x'],'persistentgamedata4.dat'),new File([],'gamestate1.dat')])
      await assert.rejects(parseNativeSaves([file]));
  });
  await asyncCheck('native import identifies named newer editions and incompatible run revisions',async()=>{
    for(const name of ['rep+persistentgamedata1.dat','rep+gamestate1.dat','rep+_persistentgamedata1.dat','rep_beta_persistentgamedata1.dat'])
      await assert.rejects(parseNativeSaves([new File(['x'],name)]),/忏悔\+或测试版/);
    for(const revision of [130,147,149])
      await assert.rejects(parseNativeSaves([new File([`ISAACNG_GSR0${revision}\0\0`],'rep_gamestate1.dat')]),/续局存档使用版本/);
    for(const revision of [131,146]){
      const bytes=new TextEncoder().encode(`ISAACNG_GSR0${revision}\0\0binary\0\xff`);
      assert.deepEqual((await parseNativeSaves([new File([bytes],'rep_gamestate1.dat')])).files[0].data,bytes);
    }
  });
  await asyncCheck('six native slots export and reimport byte-for-byte with Steam or local filenames',async()=>{
    const original=FS.readFile(game),written=[],expected=[];
    try{
      for(let slot=1;slot<=3;slot++)for(const kind of ['persistentgamedata','gamestate']){
        const localName=`${kind}${slot}.dat`,data=Uint8Array.of(slot,kind.length,0,255,128,13,10);
        const target='/game/'+user+localName;write(target,data);written.push(target);
        expected.push({path:user+localName,data,slot,kind,localName,steamName:'rep_'+localName});
      }
      for(const target of ['/game/'+user+'20261103.persistentgamedata1.dat','/game/'+user+'rep_persistentgamedata2.dat',
        '/game/user/Documents/My Games/Binding of Isaac Repentance+/persistentgamedata1.dat',
        '/game/user/Documents/My Games/Binding of Isaac Afterbirth+/persistentgamedata1.dat']){
        write(target,'excluded');written.push(target);
      }
      assert.deepEqual(collectNativeSaves(FS),expected);
      for(const naming of ['steamName','localName']){
        const incoming=await parseNativeSaves(expected.map(file=>new File([file.data],file[naming])));
        for(let i=0;i<incoming.files.length;i++){
          assert.equal(incoming.files[i].path,expected[i].path);
          assert.equal(incoming.files[i].sha256,await sha256(expected[i].data));
        }
        const undo=applyBackup(FS,incoming);
        assert.deepEqual(collectNativeSaves(FS),expected);undo();
      }
      const detached=collectNativeSaves(FS);detached[0].data.fill(7);
      assert.deepEqual(FS.readFile('/game/'+expected[0].path),expected[0].data);
    }finally{for(const target of written)FS.unlink(target);write(game,original);}
  });
  check('native export rejects a linked native file and skips unrelated Mod links',()=>{
    const linked='/game/'+user+'persistentgamedata2.dat';
    fs.symlinkSync(map(game),map(linked));
    try{assert.throws(()=>collectNativeSaves(FS),/普通存档/);}finally{FS.unlink(linked);}
    const modLink='/game/data/linkedmod';fs.symlinkSync(path.dirname(map(config)),map(modLink));
    try{assert.equal(collectNativeSaves(FS).length,1);}finally{FS.unlink(modLink);}
  });
  check('native export never probes missing paths after the native runtime exits',()=>{
    const exitedFS={...FS,lstat(name){
      if(!fs.existsSync(map(name)))throw new Error('native strerror unavailable after runtime exit');
      return FS.lstat(name);
    }};
    assert.equal(collectNativeSaves(exitedFS).length,1);
    const directory=path.dirname(map(game)),temporary=directory+'-temporary';
    fs.renameSync(directory,temporary);
    try{assert.deepEqual(collectNativeSaves(exitedFS),[]);}finally{fs.renameSync(temporary,directory);}
  });
  check('empty run files do not block valid native slot exports',()=>{
    const progress='/game/'+user+'persistentgamedata1.dat',empty='/game/'+user+'gamestate2.dat';
    const bytes=Uint8Array.of(0,255,128,17);write(progress,bytes);write(empty,new Uint8Array());
    try{
      const exported=collectNativeSaves(FS);
      assert.deepEqual(exported.find(file=>file.localName==='persistentgamedata1.dat').data,bytes);
      assert.equal(exported.some(file=>file.localName==='gamestate2.dat'),false);
    }finally{FS.unlink(progress);FS.unlink(empty);}
  });
  await asyncCheck('malformed, oversized, duplicate and unsupported documents reject',async()=>{
    for(const mutate of [
      b=>b.version=2,b=>b.target='Repentance+',b=>b.files=[],b=>b.selectedMods=['836319872','836319872'],
      b=>b.files[0].size=MAX_SAVE_BYTES+1,b=>b.files[0].base64='%%%%',
      b=>b.files.push({...b.files[0]}),
      b=>b.files.push({...b.files[0],path:b.files[0].path.toUpperCase().replace('DATA/','data/')}),
    ]){const bad=structuredClone(backup);mutate(bad);await assert.rejects(parseBackup(JSON.stringify(bad)));}
    await assert.rejects(parseBackup('{not json}'));
  });
  check('paths reject traversal, absolute roots, scripts and cross-platform aliases',()=>{
    for(const name of ['../game/user/save1.dat','/game/data/x/save1.dat','data/x/../../resources/a.dat',
      'data/x\\save1.dat','data/x/C:save1.dat','data//x/save1.dat','data/x/./save1.dat',
      'data/x/main.lua','data/x/module.wasm','data/x/resources.a','data/x/log.txt',
      'data/x/save1.dat.','data/x/save1.dat ','user/secret.json','mods/x/save1.dat','data/x/\u0000save1.dat'])
      assert.throws(()=>validateSavePath(name),name);
  });
  write(game,'old game');write(config,'old config');write('/game/'+user+'unrelated.dat','keep me');
  const rollback=applyBackup(FS,parsed);
  check('import writes whitelisted files and preserves unrelated saves',()=>{
    for(const file of parsed.files)assert.deepEqual(FS.readFile('/game/'+file.path),file.data);
    assert.equal(Buffer.from(FS.readFile('/game/'+user+'unrelated.dat')).toString(),'keep me');
  });
  rollback();
  check('caller rollback restores pre-import bytes',()=>{
    assert.equal(Buffer.from(FS.readFile(game)).toString(),'old game');
    assert.equal(Buffer.from(FS.readFile(config)).toString(),'old config');
  });
  let writes=0;
  const failing={...FS,writeFile(name,data){if(++writes===2)throw new Error('simulated storage failure');FS.writeFile(name,data);}};
  check('partial write failure rolls back already changed files',()=>{
    assert.throws(()=>applyBackup(failing,parsed),/simulated storage failure/);
    assert.equal(Buffer.from(FS.readFile(game)).toString(),'old game');
    assert.equal(Buffer.from(FS.readFile(config)).toString(),'old config');
  });
  const newData=Uint8Array.of(9,8,7);
  const withNew={...parsed,files:[...parsed.files,{path:'data/newmod/save1.dat',data:newData}]};
  const undoNew=applyBackup(FS,withNew);undoNew();
  check('rollback removes newly imported files',()=>assert.equal(fs.existsSync(map('/game/data/newmod/save1.dat')),false));
  fs.symlinkSync(path.dirname(map(config)),map('/game/data/linkedmod'));
  check('export refuses symlink traversal',()=>assert.throws(()=>collectSaveFiles(FS),/符号链接/));
  check('import rejects linked directory before writes',()=>assert.throws(()=>applyBackup(FS,{files:[{path:'data/linkedmod/save1.dat',data:newData}]}),/链接/));
  fs.unlinkSync(map('/game/data/linkedmod'));
  fs.symlinkSync(map(game),map('/game/data/external item descriptions/linked.dat'));
  check('import rejects linked destination file',()=>assert.throws(()=>applyBackup(FS,{files:[{path:'data/external item descriptions/linked.dat',data:newData}]}),/普通存档/));
  await asyncCheck('noncanonical base64 padding rejects even equivalent bytes',async()=>{
    const bytes=Uint8Array.of(0),value={format:SAVE_FORMAT,version:1,target:SAVE_TARGET,selectedMods:[],files:[{path:'data/x/save1.dat',size:1,sha256:await sha256(bytes),base64:'AB=='}]};
    await assert.rejects(parseBackup(JSON.stringify(value)),/编码不规范/);
  });
  console.log(JSON.stringify({passed:true,checks,scope:'Save exchange safety and byte preservation; real browser/game import validation is separate.'}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
