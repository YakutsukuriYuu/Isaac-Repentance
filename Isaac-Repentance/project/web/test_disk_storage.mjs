import test from 'node:test';
import assert from 'node:assert/strict';
import {openDiskStorage,DiskStorageError} from './disk_storage.mjs';
import {prepareModFromFiles} from './mod_helpers.mjs';

const encoder=new TextEncoder();
const savePath='user/Documents/My Games/Binding of Isaac Repentance/persistentgamedata1.dat';
const reply=(value,status=200)=>new Response(status===204?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function server(){
  const state=new Map(),requests=[];let revision=0,intercept=null;
  const backend={state,requests,set intercept(value){intercept=value;},
    set(path,value){state.set(path,{...structuredClone(value),revision:`revision-${++revision}`});},
    async fetch(path,options={}){
      requests.push({path,...options});
      if(path==='/api/session')return reply({storage:'disk',token:'test-token',rootId:'portable-directory',dataPath:'/portable/userdata'});
      if(options.headers?.['X-Isaac-Token']!=='test-token')return reply({error:'token required'},403);
      if(intercept){const result=await intercept(path,options);if(result)return result;}
      if(path==='/api/mods')return reply([...state].filter(([key])=>key.startsWith('/api/storage/mods/')).map(([key,value])=>({key:key.split('/').at(-1),revision:value.revision,meta:value.meta})));
      const current=state.get(path)||{revision:'',files:[],meta:null};
      if(options.method==='PUT'){
        const value=JSON.parse(options.body);if(value.revision!==current.revision)return reply({error:'stale revision'},409);
        backend.set(path,value);return reply({revision:state.get(path).revision});
      }
      if(options.method==='DELETE'){
        if(options.headers['X-Isaac-Revision']!==current.revision)return reply({error:'stale revision'},409);
        state.delete(path);return reply(null,204);
      }
      return reply(current);
    }
  };return backend;
}
const open=backend=>openDiskStorage({fetch:backend.fetch});

test('only a missing disk endpoint falls back; failed or invalid hosts cannot hide behind browser storage',async()=>{
  assert.equal(await openDiskStorage({fetch:async()=>reply({},404)}),null);
  await assert.rejects(openDiskStorage({fetch:async()=>reply({error:'locked'},503)}),error=>error instanceof DiskStorageError&&error.status===503);
  await assert.rejects(openDiskStorage({fetch:async()=>reply({storage:'disk'})}),/协议不兼容/);
  await assert.rejects(openDiskStorage({fetch:async()=>{throw new Error('offline');}}),/offline/);
});
test('raw save and Mod data survive a fresh client; all disk requests carry the session token',async()=>{
  const backend=server(),storage=await open(backend),bytes=Uint8Array.from({length:2*1024*1024},(_,index)=>index%256);
  assert.equal((await storage.readSaves()).revision,'');
  await storage.writeSaves([{path:savePath,data:bytes}],{meta:{browserMigrationComplete:true}});
  const reopened=await open(backend),loaded=await reopened.readSaves();
  assert.deepEqual(loaded.files,[{path:savePath,data:bytes}]);assert.equal(loaded.meta.browserMigrationComplete,true);
  const mod=await prepareModFromFiles([{path:'example/main.lua',data:encoder.encode('return 1')},{path:'example/resources/test.bin',data:bytes}]);
  await storage.modStore.install(mod);
  const persisted=await reopened.modStore.get(mod.id);
  assert.deepEqual(persisted.files,mod.files);assert.equal(persisted.enabled,true);
  for(const request of backend.requests.filter(request=>request.path!=='/api/session'))assert.equal(request.headers['X-Isaac-Token'],'test-token');
});
test('two clients cannot silently overwrite a newer save; failed writes keep the original revision',async()=>{
  const backend=server(),first=await open(backend),second=await open(backend);
  await first.readSaves();await second.readSaves();
  await first.writeSaves([{path:savePath,data:Uint8Array.of(1)}]);
  for(let i=0;i<2;i++)await assert.rejects(second.writeSaves([{path:savePath,data:Uint8Array.of(2)}]),error=>error.status===409);
  assert.deepEqual((await first.readSaves()).files[0].data,Uint8Array.of(1));
});
test('settings and touch layout merge through serialized writes and remain independent of browser storage',async()=>{
  const backend=server(),storage=await open(backend);
  assert.deepEqual(await storage.readSettings(),{settings:null,touchLayout:null,meta:null,revision:''});
  await Promise.all([
    storage.writeSettings({settings:{touch:true,fullscreen:false}},{meta:{browserMigrationComplete:true}}),
    storage.writeSettings({touchLayout:{version:1,portrait:{move:{x:.1,y:.7,size:1.2,opacity:.6}}}})
  ]);
  const other=await open(backend),persisted=await other.readSettings();
  assert.equal(persisted.settings.touch,true);assert.equal(persisted.touchLayout.portrait.move.opacity,.6);assert.equal(persisted.meta.browserMigrationComplete,true);
  await other.writeSettings({settings:{touch:false}});
  await assert.rejects(storage.writeSettings({touchLayout:{version:1}}),error=>error.status===409);
  assert.equal((await other.readSettings()).touchLayout.portrait.move.opacity,.6);
});
test('Mod replacement retains enabled state, deletion is revision protected, and selection failure rolls back',async()=>{
  const backend=server(),storage=await open(backend);
  const first=await prepareModFromFiles([{path:'first/main.lua',data:encoder.encode('first')}]);
  const second=await prepareModFromFiles([{path:'second/main.lua',data:encoder.encode('second')}]);
  await storage.modStore.install(first);await storage.modStore.install(second);
  await storage.modStore.setEnabled(first.id,false);
  await assert.rejects(storage.modStore.install(first),/已安装/);
  await storage.modStore.install({...first,files:[{path:'main.lua',data:encoder.encode('updated')}],bytes:7},{replace:true});
  assert.equal((await storage.modStore.get(first.id)).enabled,false);
  assert.deepEqual((await storage.modStore.enabled()).map(mod=>mod.id),[second.id]);
  await storage.modStore.setSelection([first.id,second.id]);
  let writes=0;
  backend.intercept=(path,options)=>path.startsWith('/api/storage/mods/')&&options.method==='PUT'&&++writes===2?reply({error:'disk full'},507):null;
  await assert.rejects(storage.modStore.setSelection([]),/disk full/);
  backend.intercept=null;
  assert.ok((await storage.modStore.list()).every(mod=>mod.enabled));
  await storage.modStore.remove(first.id);assert.equal(await storage.modStore.get(first.id),null);
  const deletion=backend.requests.find(request=>request.method==='DELETE');assert.match(deletion.headers['X-Isaac-Revision'],/^revision-/);
});
test('invalid paths and malformed native bytes fail before mounting or writing files',async()=>{
  const backend=server(),storage=await open(backend);await storage.readSaves();
  await assert.rejects(storage.writeSaves([{path:'../../escape.dat',data:Uint8Array.of(1)}]),/路径/);
  assert.equal(backend.requests.filter(request=>request.method==='PUT').length,0);
  for(const base64 of ['AB==','AAB=','@@==','A===']){
    backend.set('/api/storage/saves/main',{meta:null,files:[{path:savePath,base64}]});
    await assert.rejects(storage.readSaves(),/编码/);
  }
});
test('expired session cannot report a successful save',async()=>{
  const backend=server(),storage=await open(backend);await storage.readSaves();
  backend.intercept=()=>reply({error:'invalid token'},403);
  await assert.rejects(storage.writeSaves([{path:savePath,data:Uint8Array.of(1)}]),error=>error.status===403&&/连接已失效/.test(error.message));
  assert.equal(backend.state.size,0);
});
