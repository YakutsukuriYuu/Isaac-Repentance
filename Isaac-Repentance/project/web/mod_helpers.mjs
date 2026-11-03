/** Local Mod imports. Archives never execute JavaScript and are not uploaded. */
export const MAX_MOD_BYTES=256*1024*1024;
export const MAX_MOD_FILE_BYTES=128*1024*1024;
export const MAX_MOD_FILES=10000;
export const MAX_INSTALLED_MOD_BYTES=512*1024*1024;
export const MAX_INSTALLED_MODS=100;
const utf8=new TextDecoder('utf-8',{fatal:true});
const enc=new TextEncoder();
const crcTable=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c;}
export function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function validateModPath(path){
  if(typeof path!=='string'||!path||path.length>512||path!==path.normalize('NFC')||/[\\:\u0000-\u001f\u007f<>"|?*]/.test(path))throw new Error(`Mod 文件路径不合法：${String(path).slice(0,100)}`);
  const parts=path.split('/');
  if(parts.length>24||parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new Error(`Mod 文件路径不合法：${path}`);
  return path;
}
function ignored(path){return path.split('/').some(p=>p==='__MACOSX'||p==='.git'||p==='.DS_Store'||p.startsWith('._'));}
function checkPaths(entries){
  const paths=new Set(),directories=new Map();
  for(const {path} of entries){
    validateModPath(path);const folded=path.toLowerCase();
    if(paths.has(folded))throw new Error(`Mod 包含重复或大小写冲突的文件：${path}`);
    paths.add(folded);
    const parts=path.split('/');
    for(let i=1;i<parts.length;i++){
      const dir=parts.slice(0,i).join('/'),key=dir.toLowerCase(),previous=directories.get(key);
      if(previous&&previous!==dir)throw new Error(`Mod 目录大小写冲突：${dir}`);
      directories.set(key,dir);
    }
  }
  for(const path of paths)if(directories.has(path))throw new Error(`Mod 的文件与目录重名：${path}`);
}
function decodeName(bytes){try{return utf8.decode(bytes);}catch{throw new Error('ZIP 文件名不是 UTF-8，请用 UTF-8 文件名重新压缩。');}}
async function inflate(raw,size){
  if(typeof DecompressionStream!=='function')throw new Error('此浏览器不支持 ZIP 解压，请改为导入文件夹。');
  let stream;try{stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));}catch{throw new Error('此浏览器不支持 ZIP 的 Deflate 格式，请改为导入文件夹。');}
  const reader=stream.getReader(),output=new Uint8Array(size);let count=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;if(count+value.length>size)throw new Error('ZIP 解压长度超过声明值。');output.set(value,count);count+=value.length;}
    if(count!==size)throw new Error('ZIP 解压后的文件长度不符。');
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return output;
}
/** Strict classic ZIP reader: stored/deflated only; no Zip64, links or encryption. */
export async function readModZip(input){
  if(typeof input?.size==='number'&&input.size>MAX_MOD_BYTES)throw new Error('ZIP 文件超过 256 MiB。');
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input instanceof ArrayBuffer?input:await input.arrayBuffer());
  if(bytes.length>MAX_MOD_BYTES)throw new Error('ZIP 文件超过 256 MiB。');
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),length=bytes.length;
  function bounds(p,n){if(!Number.isSafeInteger(p)||p<0||n<0||p+n>length)throw new Error('ZIP 文件被截断或结构损坏。');}
  function u16(p){bounds(p,2);return dv.getUint16(p,true);}function u32(p){bounds(p,4);return dv.getUint32(p,true);}
  let end=-1;
  for(let p=length-22;p>=Math.max(0,length-65557);p--)if(u32(p)===0x06054b50&&p+22+u16(p+20)===length){end=p;break;}
  if(end<0)throw new Error('请选择有效的 ZIP 文件（暂不支持 RAR / 7z）。');
  const count=u16(end+10),centralSize=u32(end+12),centralStart=u32(end+16);
  if(u16(end+4)||u16(end+6)||u16(end+8)!==count)throw new Error('暂不支持分卷 ZIP。');
  if(count===65535||centralSize===0xffffffff||centralStart===0xffffffff)throw new Error('暂不支持 Zip64，请使用普通 ZIP。');
  if(!count||count>MAX_MOD_FILES+1000)throw new Error('ZIP 文件数量超过上限或为空。');
  if(centralStart+centralSize!==end)throw new Error('ZIP 中央目录不合法。');
  let p=centralStart,total=0;const records=[],ranges=[];
  for(let i=0;i<count;i++){
    bounds(p,46);if(u32(p)!==0x02014b50)throw new Error('ZIP 中央目录损坏。');
    const flags=u16(p+8),method=u16(p+10),crc=u32(p+16),packed=u32(p+20),size=u32(p+24),nameLength=u16(p+28),extra=u16(p+30),comment=u16(p+32),offset=u32(p+42);
    if(flags&~(0x800|8|6))throw new Error('暂不支持加密或特殊编码的 ZIP。');
    if(method!==0&&method!==8)throw new Error('ZIP 仅支持 Store / Deflate 压缩。');
    if(u16(p+34)||size===0xffffffff||packed===0xffffffff||offset===0xffffffff)throw new Error('暂不支持分卷 ZIP 或 Zip64。');
    const unixType=(u32(p+38)>>>16)&0xf000;
    if(unixType&&unixType!==0x8000&&unixType!==0x4000)throw new Error('ZIP 包含符号链接或特殊文件。');
    bounds(p+46,nameLength+extra+comment);
    if(p+46+nameLength+extra+comment>end)throw new Error('ZIP 中央目录越界。');
    const nameBytes=bytes.subarray(p+46,p+46+nameLength),name=decodeName(nameBytes),directory=name.endsWith('/');
    const path=directory?name.slice(0,-1):name;validateModPath(path);
    if(unixType===0x4000&&!directory)throw new Error('ZIP 目录标记不一致。');
    bounds(offset,30);if(u32(offset)!==0x04034b50)throw new Error('ZIP 本地文件头损坏。');
    if(u16(offset+6)!==flags||u16(offset+8)!==method)throw new Error('ZIP 的文件头信息不一致。');
    const localNameLength=u16(offset+26),localExtra=u16(offset+28),start=offset+30+localNameLength+localExtra;
    bounds(offset+30,localNameLength+localExtra);bounds(start,packed);
    if(start+packed>centralStart||offset>=centralStart)throw new Error('ZIP 文件数据越界。');
    const localName=bytes.subarray(offset+30,offset+30+localNameLength);
    if(localNameLength!==nameLength||localName.some((b,j)=>b!==nameBytes[j]))throw new Error('ZIP 的文件名信息不一致。');
    if(!(flags&8)&&(u32(offset+14)!==crc||u32(offset+18)!==packed||u32(offset+22)!==size))throw new Error('ZIP 的文件长度或校验信息不一致。');
    if(size>MAX_MOD_FILE_BYTES||(total+=size)>MAX_MOD_BYTES)throw new Error('Mod 超过 256 MiB 或单个文件超过 128 MiB。');
    if(method===0&&packed!==size)throw new Error('ZIP 未压缩文件的长度不符。');
    if(directory&&size)throw new Error('ZIP 目录不能包含文件内容。');
    ranges.push([offset,start+packed]);
    if(!directory&&!ignored(path))records.push({path,start,packed,size,method,crc});
    p+=46+nameLength+extra+comment;
  }
  if(p!==end||records.length>MAX_MOD_FILES)throw new Error('ZIP 文件数量或目录长度不合法。');
  ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])throw new Error('ZIP 文件数据相互重叠。');
  checkPaths(records);
  const files=[];
  for(const r of records){
    const raw=bytes.subarray(r.start,r.start+r.packed),data=r.method===0?raw.slice():await inflate(raw,r.size);
    if(crc32(data)!==r.crc)throw new Error(`ZIP 文件校验失败：${r.path}`);
    files.push({path:r.path,data});
  }
  return files;
}
function xmlText(xml,tag){
  const value=xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'))?.[1]||'';
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,s=>{
    const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(named[s])return named[s];
    const code=s[2].toLowerCase()==='x'?parseInt(s.slice(3,-1),16):Number(s.slice(2,-1));return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';
  }).trim();
}
async function identity(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join('');}
function folderName(value){return value.normalize('NFC').replace(/[\\/:\u0000-\u001f\u007f<>"|?*]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,90)||'mod';}
/** Files may be File objects from a folder picker or explicit {path,data} inputs. */
export async function prepareModFromFiles(input,{name=''}={}){
  const source=Array.from(input);if(!source.length||source.length>MAX_MOD_FILES)throw new Error('请选择一个 Mod 文件夹（最多 10000 个文件）。');
  const files=[];let total=0;
  for(const file of source){
    const path=file.path||file.webkitRelativePath||file.name;validateModPath(path);
    if(file.symlink||file.type==='symlink')throw new Error('Mod 不能包含符号链接。');
    if(ignored(path))continue;
    const declared=file.data?.byteLength??file.size;
    if(declared>MAX_MOD_FILE_BYTES||declared+total>MAX_MOD_BYTES)throw new Error('Mod 超过 256 MiB 或单个文件超过 128 MiB。');
    const data=file.data instanceof Uint8Array?file.data:new Uint8Array(file.data instanceof ArrayBuffer?file.data:await file.arrayBuffer());
    if(data.length>MAX_MOD_FILE_BYTES||(total+=data.length)>MAX_MOD_BYTES)throw new Error('Mod 超过 256 MiB 或单个文件超过 128 MiB。');
    files.push({path,data});
  }
  checkPaths(files);if(!files.length)throw new Error('Mod 文件夹中没有可导入的文件。');
  let root='';
  while(files.every(file=>file.path.includes('/')&&file.path.split('/')[0]===files[0].path.split('/')[0])){
    root=files[0].path.split('/')[0];for(const file of files)file.path=file.path.slice(root.length+1);
  }
  const entry=files.find(file=>file.path.toLowerCase()==='main.lua');
  const metadata=files.find(file=>file.path.toLowerCase()==='metadata.xml');
  if(!entry&&!(metadata&&files.some(file=>/^(?:resources|content)\//i.test(file.path))))throw new Error('找不到 Mod 根目录：需要 main.lua，或 metadata.xml 与 resources / content。请每次导入一个 Mod。');
  if(metadata&&metadata.data.length>1024*1024)throw new Error('Mod metadata.xml 超过 1 MiB。');
  let xml='';if(metadata)try{xml=utf8.decode(metadata.data);}catch{throw new Error('metadata.xml 不是 UTF-8 文本。');}
  const title=(xmlText(xml,'name')||name.replace(/\.zip$/i,'')||root||'本地 Mod').slice(0,200);
  const directory=xmlText(xml,'directory')||root||title;
  const workshop=xmlText(xml,'id');
  const id=/^[1-9]\d{0,19}$/.test(workshop)?workshop:`local-${await identity(directory.toLowerCase())}`;
  const base=folderName(directory),folder=base.toLowerCase().endsWith('_'+id)?base:base+'_'+id;
  validateModPath(folder);
  const kept=files.filter(file=>file.path.toLowerCase()!=='disable.it');
  return {id,name:title,folder,version:xmlText(xml,'version').slice(0,80),description:xmlText(xml,'description').slice(0,4000),files:kept,bytes:kept.reduce((n,f)=>n+f.data.length,0),fileCount:kept.length,enabled:true};
}
export async function prepareModFromZip(input,{name=input?.name||''}={}){return prepareModFromFiles(await readModZip(input),{name});}
function metadata(mod){const {files,...value}=mod;return value;}
function requestResult(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function transactionDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Mod 存储操作已取消。'));tx.onerror=()=>{};});}
/** IndexedDB separates small listing metadata from the file blobs. */
export async function openModStore(indexedDB=globalThis.indexedDB){
  if(!indexedDB)throw new Error('浏览器没有可用的 Mod 存储。');
  const opening=indexedDB.open('isaac-j835-mods',1);
  opening.onupgradeneeded=()=>{opening.result.createObjectStore('mods',{keyPath:'id'});opening.result.createObjectStore('files',{keyPath:'id'});};
  const db=await requestResult(opening);db.onversionchange=()=>db.close();
  async function list(){return requestResult(db.transaction('mods').objectStore('mods').getAll());}
  async function get(id){const tx=db.transaction(['mods','files']);const [mod,record]=await Promise.all([requestResult(tx.objectStore('mods').get(id)),requestResult(tx.objectStore('files').get(id))]);return mod?{...mod,files:record?.files||[]}:null;}
  return {
    list,get,
    async enabled(){const mods=await list();return Promise.all(mods.filter(mod=>mod.enabled).map(mod=>get(mod.id)));},
    async install(mod,{replace=false}={}){
      const tx=db.transaction(['mods','files'],'readwrite'),done=transactionDone(tx);let result,error;
      const request=tx.objectStore('mods').getAll();
      request.onsuccess=()=>{
        const all=request.result,old=all.find(item=>item.id===mod.id),others=all.filter(item=>item.id!==mod.id);
        if(old&&!replace)error=new Error('此 Mod 已安装。请确认替换后重新导入。');
        else if(others.some(item=>item.folder.toLowerCase()===mod.folder.toLowerCase()))error=new Error('Mod 安装目录与另一个 Mod 冲突。');
        else if(others.length>=MAX_INSTALLED_MODS||others.reduce((n,item)=>n+item.bytes,mod.bytes)>MAX_INSTALLED_MOD_BYTES)error=new Error('已安装 Mod 超过上限（100 个 / 512 MiB）。');
        if(error){tx.abort();return;}
        const now=new Date().toISOString();result={...metadata(mod),enabled:old?.enabled??mod.enabled,installedAt:old?.installedAt||now,updatedAt:now};
        tx.objectStore('mods').put(result);tx.objectStore('files').put({id:mod.id,files:mod.files});
      };
      try{await done;}catch(e){throw error||e;}return result;
    },
    async setSelection(ids){
      const selected=new Set(ids),tx=db.transaction('mods','readwrite'),done=transactionDone(tx);let failure;
      const request=tx.objectStore('mods').getAll();request.onsuccess=()=>{
        try{for(const mod of request.result)if(mod.enabled!==selected.has(mod.id))tx.objectStore('mods').put({...mod,enabled:selected.has(mod.id)});}
        catch(error){failure=error;tx.abort();}
      };
      try{await done;}catch(error){throw failure||error;}
    },
    async setEnabled(id,enabled){
      const tx=db.transaction('mods','readwrite'),done=transactionDone(tx);let missing=false;
      const request=tx.objectStore('mods').get(id);request.onsuccess=()=>{if(!request.result){missing=true;tx.abort();return;}tx.objectStore('mods').put({...request.result,enabled:!!enabled});};
      try{await done;}catch(error){throw missing?new Error('此 Mod 已被删除。'):error;}
    },
    async remove(id){const tx=db.transaction(['mods','files'],'readwrite'),done=transactionDone(tx);tx.objectStore('mods').delete(id);tx.objectStore('files').delete(id);await done;},
    close(){db.close();}
  };
}
export function mountMods(FS,mods){
  FS.mkdirTree('/game/mods');const folders=new Set();
  for(const mod of mods){
    validateModPath(mod.folder);if(mod.folder.includes('/'))throw new Error('Mod 安装目录不合法。');
    const key=mod.folder.toLowerCase();if(folders.has(key))throw new Error('Mod 安装目录冲突。');folders.add(key);checkPaths(mod.files);
    for(const file of mod.files){const target=`/game/mods/${mod.folder}/${file.path}`,cut=target.lastIndexOf('/');FS.mkdirTree(target.slice(0,cut));FS.createDataFile(target.slice(0,cut),target.slice(cut+1),file.data,true,false,true);}
  }
}
