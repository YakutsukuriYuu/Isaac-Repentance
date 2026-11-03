/** Portable launcher storage. The transport uses JSON; files on disk keep their
 * original bytes. A revision conflict is never retried over somebody else's data. */
import {MAX_SAVE_BYTES,MAX_SAVE_FILES,validateSavePath,bytesToBase64} from './save_helpers.mjs';
import {MAX_MOD_BYTES,MAX_MOD_FILE_BYTES,MAX_MOD_FILES,MAX_INSTALLED_MOD_BYTES,MAX_INSTALLED_MODS,validateModPath} from './mod_helpers.mjs';

const utf8=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
const ID=/^(?:[1-9]\d{0,19}|local-[0-9a-f]{24})$/;
const BASE64_ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LIMITS={saves:{bytes:MAX_SAVE_BYTES,fileBytes:MAX_SAVE_BYTES,files:MAX_SAVE_FILES,path:validateSavePath},
  settings:{bytes:1024*1024,fileBytes:1024*1024,files:32,path:validateModPath},
  mods:{bytes:MAX_MOD_BYTES,fileBytes:MAX_MOD_FILE_BYTES,files:MAX_MOD_FILES,path:validateModPath}};
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const clone=value=>value===undefined?undefined:structuredClone(value);
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function metadata(value){
  if(value===null||value===undefined)return null;
  if(!object(value))throw new Error('本地数据的元信息格式不正确。');
  const json=JSON.stringify(value);
  if(encoder.encode(json).length>65536)throw new Error('本地数据的元信息超过 64 KiB。');
  return JSON.parse(json);
}
function serial(){let tail=Promise.resolve();return task=>{const next=tail.then(task);tail=next.catch(()=>{});return next;};}
function validBase64(value){
  // A repeated-group regular expression can exhaust the JS regexp stack for
  // large Mod assets. Check its alphabet and final unused bits in linear time.
  if(value.length%4)return false;
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
  const content=value.slice(0,value.length-padding);
  if(/[^A-Za-z0-9+/]/.test(content)||padding&&!content)return false;
  if(padding){const last=BASE64_ALPHABET.indexOf(content.at(-1));if(last<0||last&(padding===2?15:3))return false;}
  return true;
}
function checkFiles(files,bucket,encoded=false){
  const limits=LIMITS[bucket];
  if(!Array.isArray(files)||files.length>limits.files)throw new Error('本地文件数量超过上限。');
  const paths=new Set(),directories=new Map();let total=0;
  for(const file of files){
    if(!object(file))throw new Error('本地文件记录无效。');
    limits.path(file.path);const key=file.path.toLowerCase();
    if(paths.has(key))throw new Error(`本地文件路径重复：${file.path}`);paths.add(key);
    const parts=file.path.split('/');
    for(let i=1;i<parts.length;i++){
      const name=parts.slice(0,i).join('/'),folded=name.toLowerCase(),previous=directories.get(folded);
      if(previous&&previous!==name)throw new Error(`本地目录大小写冲突：${name}`);directories.set(folded,name);
    }
    let size;
    if(encoded){
      if(typeof file.base64!=='string'||file.base64.length>4*Math.ceil(limits.fileBytes/3)||!validBase64(file.base64))throw new Error(`本地文件编码无效：${file.path}`);
      size=file.base64.length/4*3-(file.base64.endsWith('==')?2:file.base64.endsWith('=')?1:0);
    }else{
      if(!(file.data instanceof Uint8Array))throw new Error(`本地文件内容不是字节数组：${file.path}`);
      size=file.data.byteLength;
    }
    if(size>limits.fileBytes||(total+=size)>limits.bytes)throw new Error('本地文件大小超过上限。');
  }
  for(const path of paths)if(directories.has(path))throw new Error(`本地文件与目录重名：${path}`);
  return total;
}
function decodeFiles(files,bucket){
  checkFiles(files,bucket,true);
  return files.map(file=>{
    const decoded=atob(file.base64),data=Uint8Array.from(decoded,char=>char.charCodeAt(0));
    return {path:file.path,data};
  });
}
function encodeFiles(files,bucket){checkFiles(files,bucket);return files.map(({path,data})=>({path,base64:bytesToBase64(data)}));}
function validID(id){if(typeof id!=='string'||!ID.test(id))throw new Error('Mod 标识不合法。');return id;}
function modMeta(value,id){
  if(!object(value)||value.id!==id||typeof value.name!=='string'||typeof value.folder!=='string'||value.folder.includes('/')||
     typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>MAX_MOD_BYTES||
     !Number.isSafeInteger(value.fileCount)||value.fileCount<1||value.fileCount>MAX_MOD_FILES)throw new Error(`本地 Mod 元信息损坏：${id}`);
  validateModPath(value.folder);return metadata(value);
}
export class DiskStorageError extends Error{
  constructor(message,status){super(message);this.name='DiskStorageError';this.status=status;}
}

/** null means this host has no disk bridge. A broken bridge is an error, so the
 * player is never silently switched to a different save location. */
export async function openDiskStorage({fetch:fetchImpl=globalThis.fetch}={}){
  const sessionResponse=await fetchImpl('/api/session',{cache:'no-store',credentials:'same-origin',redirect:'error'});
  if(sessionResponse.status===404)return null;
  if(!sessionResponse.ok)throw new DiskStorageError(`无法连接本地存储：HTTP ${sessionResponse.status}`,sessionResponse.status);
  let session;try{session=await sessionResponse.json();}catch{throw new Error('本地启动器返回了无效的存储信息。');}
  if(session?.storage!=='disk'||typeof session.token!=='string'||!session.token||typeof session.rootId!=='string'||!session.rootId||typeof session.dataPath!=='string')throw new Error('本地启动器的存储协议不兼容。');
  const headers=()=>({'X-Isaac-Token':session.token});
  async function request(path,{method='GET',body,extraHeaders={}}={}){
    const response=await fetchImpl(path,{method,headers:{...headers(),...(body===undefined?{}:{'Content-Type':'application/json'}),...extraHeaders},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',credentials:'same-origin',redirect:'error'});
    if(!response.ok){
      let detail='';try{detail=(await response.json()).error||'';}catch{}
      if(response.status===409)throw new DiskStorageError('本地文件已被另一个窗口或程序修改。为保留两边数据，本次没有覆盖；请先导出当前存档，再重新打开游戏。',409);
      if(response.status===401||response.status===403)throw new DiskStorageError('本地启动器连接已失效，请重新打开游戏页面。',response.status);
      throw new DiskStorageError(`本地存储操作失败：${detail||`HTTP ${response.status}`}`,response.status);
    }
    if(response.status===204)return null;
    try{return await response.json();}catch{throw new Error('本地启动器返回了无效的数据。');}
  }
  async function read(bucket,key){
    const value=await request(`/api/storage/${bucket}/${key}`);
    if(!object(value)||typeof value.revision!=='string'||value.revision.length>256||!Array.isArray(value.files))throw new Error('本地数据快照格式无效。');
    const files=decodeFiles(value.files,bucket),meta=metadata(value.meta);
    if(!value.revision&&(files.length||meta!==null))throw new Error('本地数据缺少修订信息。');
    return {revision:value.revision,files,meta};
  }
  async function write(bucket,key,previous,files,meta){
    if(!previous)throw new Error('写入前必须先读取本地数据。');
    const cleanMeta=metadata(meta),result=await request(`/api/storage/${bucket}/${key}`,{method:'PUT',body:{revision:previous.revision,files:encodeFiles(files,bucket),meta:cleanMeta}});
    if(!object(result)||typeof result.revision!=='string'||!result.revision)throw new Error('本地启动器没有确认文件已保存。');
    return {revision:result.revision,files:files.map(({path,data})=>({path,data:data.slice()})),meta:cleanMeta};
  }
  const saveQueue=serial(),settingsQueue=serial(),modQueue=serial();let saveState=null,settingsState=null;
  function settingsValue(snapshot){
    const parse=name=>{
      const file=snapshot.files.find(file=>file.path===name);if(!file)return null;
      let value;try{value=JSON.parse(utf8.decode(file.data));}catch{throw new Error(`本地设置文件无法读取：${name}`);}
      if(!object(value))throw new Error(`本地设置文件格式无效：${name}`);return value;
    };
    return {settings:parse('settings.json'),touchLayout:parse('touch-layout.json'),meta:clone(snapshot.meta),revision:snapshot.revision};
  }
  async function listEntries(){
    const entries=await request('/api/mods');
    if(!Array.isArray(entries)||entries.length>MAX_INSTALLED_MODS)throw new Error('本地 Mod 列表格式无效。');
    let total=0;const ids=new Set(),folders=new Set();
    return entries.map(entry=>{
      validID(entry?.key);if(ids.has(entry.key)||typeof entry.revision!=='string'||!entry.revision)throw new Error('本地 Mod 列表包含重复或无效项目。');ids.add(entry.key);
      const meta=modMeta(entry.meta,entry.key),folder=meta.folder.toLowerCase();
      if(folders.has(folder))throw new Error('本地 Mod 安装目录冲突。');folders.add(folder);
      if((total+=meta.bytes)>MAX_INSTALLED_MOD_BYTES)throw new Error('本地 Mod 总大小超过 512 MiB。');
      return {key:entry.key,revision:entry.revision,meta};
    });
  }
  async function getSnapshot(id){
    validID(id);const snapshot=await read('mods',id);if(!snapshot.revision)return null;
    const meta=modMeta(snapshot.meta,id),bytes=snapshot.files.reduce((sum,file)=>sum+file.data.length,0);
    if(meta.bytes!==bytes||meta.fileCount!==snapshot.files.length)throw new Error(`本地 Mod 文件数量或大小与记录不符：${meta.name}`);
    return {...snapshot,meta};
  }
  const modStore={
    listEntries:()=>modQueue(listEntries),
    list:()=>modQueue(async()=>(await listEntries()).map(entry=>entry.meta)),
    get:id=>modQueue(async()=>{const snapshot=await getSnapshot(id);return snapshot?{...snapshot.meta,files:snapshot.files}:null;}),
    enabled:()=>modQueue(async()=>{
      const mods=[];for(const entry of await listEntries())if(entry.meta.enabled){const snapshot=await getSnapshot(entry.key);if(!snapshot)throw new Error('Mod 已在另一个窗口中被移除，请刷新列表后重试。');mods.push({...snapshot.meta,files:snapshot.files});}return mods;
    }),
    install:(mod,{replace=false}={})=>modQueue(async()=>{
      validID(mod?.id);const bytes=checkFiles(mod.files,'mods');
      const all=await listEntries(),others=all.filter(entry=>entry.key!==mod.id),old=await getSnapshot(mod.id);
      if(old&&!replace)throw new Error('此 Mod 已安装。请确认替换后重新导入。');
      if(others.length>=MAX_INSTALLED_MODS||others.reduce((total,entry)=>total+entry.meta.bytes,bytes)>MAX_INSTALLED_MOD_BYTES)throw new Error('已安装 Mod 超过上限（100 个 / 512 MiB）。');
      if(others.some(entry=>entry.meta.folder.toLowerCase()===mod.folder.toLowerCase()))throw new Error('Mod 安装目录与另一个 Mod 冲突。');
      const now=new Date().toISOString(),{files,...inputMeta}=mod;
      const meta=modMeta({...inputMeta,bytes,fileCount:files.length,enabled:old?.meta.enabled??mod.enabled,
        installedAt:old?.meta.installedAt||now,updatedAt:now},mod.id);
      const saved=await write('mods',mod.id,old||{revision:''},files,meta);return saved.meta;
    }),
    setEnabled:(id,enabled)=>modQueue(async()=>{
      const snapshot=await getSnapshot(id);if(!snapshot)throw new Error('此 Mod 已被删除。');
      await write('mods',id,snapshot,snapshot.files,{...snapshot.meta,enabled:!!enabled});
    }),
    setSelection:ids=>modQueue(async()=>{
      if(!Array.isArray(ids)||ids.length>MAX_INSTALLED_MODS)throw new Error('Mod 选择无效。');for(const id of ids)validID(id);
      const selected=new Set(ids),changed=[];
      try{
        for(const entry of await listEntries())if(entry.meta.enabled!==selected.has(entry.key)){
          const old=await getSnapshot(entry.key);if(!old)throw new Error('Mod 已在另一个窗口中被移除。');
          const saved=await write('mods',entry.key,old,old.files,{...old.meta,enabled:selected.has(entry.key)});changed.push({key:entry.key,old,saved});
        }
      }catch(error){
        let rollbackFailed=false;
        for(const entry of changed.reverse())try{await write('mods',entry.key,entry.saved,entry.old.files,entry.old.meta);}catch{rollbackFailed=true;}
        if(rollbackFailed)throw new Error(`${error.message} 部分 Mod 的选择未能恢复，请重新检查 Mod 列表。`,{cause:error});throw error;
      }
    }),
    remove:id=>modQueue(async()=>{
      const snapshot=await getSnapshot(id);if(!snapshot)return;
      await request(`/api/storage/mods/${id}`,{method:'DELETE',extraHeaders:{'X-Isaac-Revision':snapshot.revision}});
    }),
    close(){}
  };
  return {
    session,modStore,
    readSaves:()=>saveQueue(async()=>{saveState=await read('saves','main');return clone(saveState);}),
    writeSaves:(files,options={})=>saveQueue(async()=>{
      saveState=await write('saves','main',saveState,files,own(options,'meta')?options.meta:saveState?.meta);return {revision:saveState.revision};
    }),
    readSettings:()=>settingsQueue(async()=>{settingsState=await read('settings','main');return settingsValue(settingsState);}),
    writeSettings:(value,options={})=>settingsQueue(async()=>{
      if(!settingsState)throw new Error('写入前必须先读取本地设置。');
      if(!object(value))throw new Error('本地设置内容无效。');
      const files=new Map(settingsState.files.map(file=>[file.path,file]));
      for(const [key,path] of [['settings','settings.json'],['touchLayout','touch-layout.json']])if(own(value,key)){
        if(value[key]===null)files.delete(path);
        else{if(!object(value[key]))throw new Error('本地设置内容无效。');files.set(path,{path,data:encoder.encode(JSON.stringify(value[key],null,2)+'\n')});}
      }
      settingsState=await write('settings','main',settingsState,[...files.values()],own(options,'meta')?options.meta:settingsState.meta);return settingsValue(settingsState);
    })
  };
}
