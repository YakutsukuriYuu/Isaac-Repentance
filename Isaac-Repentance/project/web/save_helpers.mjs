/** Native .dat exchange, plus import/export for legacy browser backups. */
export const SAVE_FORMAT='isaac-j835-save-backup';
export const SAVE_TARGET='Repentance 1.7.9b.J835';
export const MAX_SAVE_BYTES=32*1024*1024;
export const MAX_BACKUP_BYTES=48*1024*1024;
export const MAX_SAVE_FILES=2048;
const HEX=/^[0-9a-f]{64}$/;
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const USER_ROOT=/^user\/Documents\/My Games\/Binding of Isaac (?:Repentance|Afterbirth\+|Afterbirth|Rebirth)\//;
const SAVE_EXT=/\.(?:dat|ini|json|cfg|sav|bin|save|txt)$/i;
const NATIVE_ROOT='user/Documents/My Games/Binding of Isaac Repentance/';
const NATIVE_NAME=/^(persistentgamedata|gamestate)([123])\.dat$/;

export function validateSavePath(path){
  if(typeof path!=='string'||path.length>512||path!==path.normalize('NFC')||
      /[\\:\u0000-\u001f\u007f<>"|?*]/.test(path))throw new Error('存档文件路径不合法。');
  const segments=path.split('/');
  if(segments.length<3||segments.length>16||segments.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)))
    throw new Error('存档文件路径不合法。');
  const basename=segments.at(-1);
  if(!SAVE_EXT.test(basename)||/^(?:log|debug|crash)(?:[._-]|$)/i.test(basename))
    throw new Error(`备份中包含非存档文件：${path}`);
  if(segments[0]==='user'){
    if(!USER_ROOT.test(path)||!/\.(?:dat|ini)$/i.test(basename))throw new Error(`不支持的游戏存档路径：${path}`);
  }else if(segments[0]!=='data')throw new Error('备份只能包含游戏存档和 Mod 配置。');
  return path;
}
export function bytesToBase64(bytes){
  let result='';
  for(let i=0;i<bytes.length;i+=0x6000)result+=btoa(String.fromCharCode(...bytes.subarray(i,i+0x6000)));
  return result;
}
function base64ToBytes(value,size){
  if(typeof value!=='string'||value.length!==4*Math.ceil(size/3)||!BASE64.test(value))
    throw new Error('存档内容编码或长度不正确。');
  const decoded=atob(value);
  if(decoded.length!==size)throw new Error('存档文件长度不符。');
  const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
  if(bytesToBase64(bytes)!==value)throw new Error('存档内容编码不规范。');
  return bytes;
}
export async function sha256(bytes){
  if(!globalThis.crypto?.subtle)throw new Error('当前浏览器无法校验存档，请通过本机启动器在 Chrome 或 Edge 打开。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
function validateMods(mods){
  if(!Array.isArray(mods)||mods.length>100||mods.some(id=>typeof id!=='string'||!/^(?:\d{1,20}|local-[0-9a-f]{24})$/.test(id))||new Set(mods).size!==mods.length)
    throw new Error('备份中的 Mod 选择不合法。');
  return [...mods];
}
/** Native Repentance save files selected by the player, mapped to the local
 * non-SteamCloud paths used by this runtime. No file is applied until review. */
export async function parseNativeSaves(input,selectedMods=[]){
  const source=Array.from(input);
  if(!source.length||source.length>32)throw new Error('请选择 1–32 个忏悔存档文件。');
  const files=[],seen=new Set();let bytes=0;
  for(const file of source){
    const name=typeof file.name==='string'?file.name.toLowerCase():'';
    if(/^(?:rep\+|rep_beta_)/.test(name))
      throw new Error('这是忏悔+或测试版存档；当前项目运行普通忏悔 1.7.9b，请选择普通忏悔的 .dat 文件。');
    const basename=name.replace(/^rep_/,'');
    if(!NATIVE_NAME.test(basename)&&name!=='options.ini')
      throw new Error(`无法识别存档 ${file.name}。请选择普通忏悔的 rep_persistentgamedata1–3.dat、rep_gamestate1–3.dat（也支持无 rep_ 前缀）或 options.ini。`);
    if(!Number.isSafeInteger(file.size)||file.size<1||(bytes+=file.size)>MAX_SAVE_BYTES)
      throw new Error('存档为空或总大小超过 32 MiB。');
    if(seen.has(basename))throw new Error(`同一存档被重复选择：${basename}`);
    seen.add(basename);
    const data=new Uint8Array(await file.arrayBuffer());
    if(data.length!==file.size)throw new Error('读取存档时长度发生变化。');
    // The original sub_00524320 reader accepts GSR revisions 131–146. Check
    // recognized headers only; this is not a full validity or integrity test.
    if(basename.startsWith('gamestate')){
      const header=String.fromCharCode(...data.subarray(0,16));
      const revision=/^ISAACNG_GSR(\d+)/.exec(header);
      if(revision&&(Number(revision[1])<131||Number(revision[1])>146))
        throw new Error(`该续局存档使用版本 ${Number(revision[1])}，当前普通忏悔支持 131–146；请选择兼容的 gamestate 存档。`);
    }
    files.push({path:NATIVE_ROOT+basename,data,sha256:await sha256(data)});
  }
  return {files,bytes,selectedMods:validateMods(selectedMods),createdAt:'',native:true};
}
export async function parseBackup(text){
  if(typeof text!=='string'||text.length>MAX_BACKUP_BYTES)throw new Error('备份文件过大。');
  let value;try{value=JSON.parse(text);}catch{throw new Error('这不是有效的 JSON 存档备份。');}
  if(!value||value.format!==SAVE_FORMAT||value.version!==1||value.target!==SAVE_TARGET)
    throw new Error('请选择此忏悔便携版导出的 v1 存档备份。');
  const selectedMods=validateMods(value.selectedMods);
  if(!Array.isArray(value.files)||!value.files.length||value.files.length>MAX_SAVE_FILES)
    throw new Error('备份中的文件数量不合法。');
  const files=[],seen=new Set();let bytes=0;
  for(const entry of value.files){
    if(!entry||typeof entry!=='object')throw new Error('备份文件记录不合法。');
    const path=validateSavePath(entry.path),key=path.toLowerCase();
    if(seen.has(key))throw new Error(`备份中有重复文件：${path}`);seen.add(key);
    if(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>MAX_SAVE_BYTES||
        (bytes+=entry.size)>MAX_SAVE_BYTES)throw new Error('备份的存档数据超过 32 MiB。');
    if(typeof entry.sha256!=='string'||!HEX.test(entry.sha256))throw new Error('备份缺少有效文件校验值。');
    const data=base64ToBytes(entry.base64,entry.size);
    if(await sha256(data)!==entry.sha256)throw new Error(`文件校验失败，备份可能已损坏：${path}`);
    files.push({path,data,sha256:entry.sha256});
  }
  return {files,bytes,selectedMods,createdAt:typeof value.createdAt==='string'?value.createdAt:''};
}
function maybeStat(FS,path){
  try{return FS.lstat(path);}catch(error){if(error?.code==='ENOENT'||error?.errno===44)return null;throw error;}
}
function assertDirectory(FS,path,create){
  const stat=maybeStat(FS,path);
  if(!stat){if(create){FS.mkdir(path);return;}throw new Error(`存档目录不存在：${path}`);}
  if(FS.isLink(stat.mode)||!FS.isDir(stat.mode))throw new Error(`存档目录包含链接或非目录：${path}`);
}
function destination(FS,path,create){
  validateSavePath(path);assertDirectory(FS,'/game',false);
  const parts=path.split('/');let at='/game';
  for(const part of parts.slice(0,-1)){at+='/'+part;assertDirectory(FS,at,create);}
  at+='/'+parts.at(-1);const stat=maybeStat(FS,at);
  if(stat&&(FS.isLink(stat.mode)||!FS.isFile(stat.mode)))throw new Error(`目标不是普通存档文件：${path}`);
  return {path:at,stat};
}
/** Return the game's original bytes, ready for an individual .dat download.
 * Steam Cloud uses rep_ names; local non-cloud saves omit that prefix. Only
 * the filename differs: neither this function nor import rewrites the data.
 * Headers alone cannot distinguish every Repentance/Repentance+ save version,
 * so byte-preserving exchange does not claim cross-version conversion. */
export function collectNativeSaves(FS){
  let directory='/game';
  for(const part of ['',...NATIVE_ROOT.slice(0,-1).split('/')]){
    // After EXIT_RUNTIME, constructing an Emscripten ENOENT may itself call
    // native strerror. Enumerate existing names instead of probing missing
    // paths, so an unsynced save can still be downloaded after game shutdown.
    if(part){if(!FS.readdir(directory).includes(part))return [];directory+='/'+part;}
    const stat=maybeStat(FS,directory);
    if(!stat)return [];
    if(FS.isLink(stat.mode)||!FS.isDir(stat.mode))throw new Error(`存档目录包含链接或非目录：${directory}`);
  }
  const files=[],names=new Set(FS.readdir(directory));let bytes=0;
  for(let slot=1;slot<=3;slot++)for(const kind of ['persistentgamedata','gamestate']){
    const localName=`${kind}${slot}.dat`,path=NATIVE_ROOT+localName;
    if(!names.has(localName))continue;
    const fullPath='/game/'+path,stat=maybeStat(FS,fullPath);
    if(!stat)continue;
    if(FS.isLink(stat.mode)||!FS.isFile(stat.mode))throw new Error(`目标不是普通存档文件：${path}`);
    if(stat.size===0)continue;
    if(!Number.isSafeInteger(stat.size)||stat.size<0||(bytes+=stat.size)>MAX_SAVE_BYTES)
      throw new Error('存档大小不合法或总大小超过 32 MiB。');
    const data=new Uint8Array(FS.readFile(fullPath));
    if(data.length!==stat.size)throw new Error('读取存档时长度发生变化。');
    files.push({path,data,slot,kind,localName,steamName:'rep_'+localName});
  }
  return files;
}
export function collectSaveFiles(FS,{allowEmpty=false}={}){
  const files=[];let total=0;
  function walk(dir,depth){
    if(depth>16)throw new Error('存档目录层级过深。');
    for(const name of FS.readdir(dir).sort()){
      if(name==='.'||name==='..')continue;
      const file=dir+'/'+name,stat=FS.lstat(file);
      if(FS.isLink(stat.mode))throw new Error('存档目录含符号链接，无法安全导出。');
      if(FS.isDir(stat.mode)){walk(file,depth+1);continue;}
      if(!FS.isFile(stat.mode))continue;
      const path=file.slice('/game/'.length);
      try{validateSavePath(path);}catch{continue;}
      if(files.length>=MAX_SAVE_FILES||(total+=stat.size)>MAX_SAVE_BYTES)throw new Error('存档数据超过导出上限（32 MiB / 2048 个文件）。');
      files.push({path,data:new Uint8Array(FS.readFile(file))});
    }
  }
  for(const root of ['/game/user','/game/data']){assertDirectory(FS,root,false);walk(root,0);}
  if(!files.length&&!allowEmpty)throw new Error('尚无可导出的游戏存档。请先进入游戏并保存。');
  return files;
}
export async function createBackup(FS,selectedMods){
  const raw=collectSaveFiles(FS),files=[];
  for(const file of raw)files.push({path:file.path,size:file.data.length,sha256:await sha256(file.data),base64:bytesToBase64(file.data)});
  return {format:SAVE_FORMAT,version:1,target:SAVE_TARGET,createdAt:new Date().toISOString(),selectedMods:validateMods(selectedMods),files};
}
/** Apply only validated bytes; caller persists and invokes rollback on failure. */
export function applyBackup(FS,backup){
  const previous=[];let oldBytes=0;
  // Preflight every destination before changing any file. Missing parents may
  // be created here, but existing save data remains untouched until the loop.
  for(const file of backup.files){
    const target=destination(FS,file.path,true);
    if(target.stat&&(oldBytes+=target.stat.size)>MAX_SAVE_BYTES)throw new Error('待覆盖的现有存档超过安全恢复上限。');
    previous.push({path:target.path,data:target.stat?new Uint8Array(FS.readFile(target.path)):null});
  }
  let written=0;
  const rollback=()=>{
    for(let i=written-1;i>=0;i--){const old=previous[i];if(old.data===null){if(maybeStat(FS,old.path))FS.unlink(old.path);}else FS.writeFile(old.path,old.data);}
  };
  try{for(let i=0;i<backup.files.length;i++){written=i+1;FS.writeFile(previous[i].path,backup.files[i].data);}}
  catch(error){rollback();throw error;}
  return rollback;
}
