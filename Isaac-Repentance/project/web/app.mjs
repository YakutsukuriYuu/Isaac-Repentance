import {MAX_BACKUP_BYTES,parseBackup,parseNativeSaves,collectNativeSaves,collectSaveFiles,createBackup,applyBackup,createSaveChangeTracker} from './save_helpers.mjs';
import {openModStore,prepareModFromZip,prepareModFromFiles,mountMods} from './mod_helpers.mjs';
import {openDiskStorage} from './disk_storage.mjs';
import {createTouchControls} from './touch_controls.mjs';
import {createTouchLayout,TOUCH_LAYOUT_KEY} from './touch_layout.mjs';
import {createFpsMetrics} from './fps_metrics.mjs';

const $=id=>document.getElementById(id);
const AUTO_SAVE_ERROR='自动保存失败，请打开菜单导出存档，并查看运行日志。';
const keys=new Uint8Array(349),inputSources=new Map();
const mouse={x:-1,y:-1,buttons:new Array(8).fill(0)};
const logs=[];
let game,savePromise,saveTimer,saveChanges=null,persistentReady=false,pendingImport=null,previousMods=null,ending=false;
let modStore,installedMods=[],storageReady=false,busy=false,capabilityReady=false;
let consoleOpening=false,consoleClosing=false,consoleOpeningFrame=0,consoleGeneration=0,consoleSending=false,consolePulse=0;
let consoleKeyboardInset=-1;
const fpsMetrics=createFpsMetrics();
let fpsEligible=false,fpsLastPaint=0,fpsWasEnabled=null;
window.isaacReport={phase:'initializing',logs,frames:0,mods:[],installedMods:[]};
$('start').disabled=true;
function log(value){const line=String(value);logs.push(line);if(logs.length>2000)logs.shift();$('log').textContent=logs.slice(-160).join('\n');$('log').scrollTop=$('log').scrollHeight;}
function status(value,error=false){$('status').textContent=value;$('status-dock').dataset.error=String(error);}
function message(id,value){const element=$(id);if(element&&element.textContent!==value)element.textContent=value;}
function isIdle(){return window.isaacReport.phase==='idle';}
function isRunning(){return window.isaacReport.phase==='running';}
const selectedMods=()=>installedMods.filter(mod=>mod.enabled).map(mod=>mod.id);
function readSettings(){try{return JSON.parse(localStorage.getItem('isaacJ835.settings')||'{}');}catch{return {};}}
let diskStorage=null,diskSettings=null,storageError=null,settingsWrite=Promise.resolve(),currentLayout;
try{
  diskStorage=await openDiskStorage();
  if(diskStorage)diskSettings=await diskStorage.readSettings();
}catch(error){storageError=error;log(error);}
try{currentLayout=JSON.parse(localStorage.getItem(TOUCH_LAYOUT_KEY)||'null');}catch{currentLayout=null;}
if(diskSettings?.revision)currentLayout=diskSettings.touchLayout;
const settings=diskSettings?.revision?(diskSettings.settings||{}):readSettings();
window.isaacReport.storage=diskStorage?{mode:'disk',path:diskStorage.session.dataPath,rootId:diskStorage.session.rootId}:{mode:storageError?'unavailable':'browser'};
$('touch-enabled').checked=typeof settings.touch==='boolean'?settings.touch:(globalThis.IsaacNative?.isNative===true||matchMedia('(pointer:coarse)').matches);
$('start-fullscreen').checked=settings.fullscreen===true;
if(globalThis.IsaacNative?.isNative){$('fullscreen').hidden=true;$('start-fullscreen').closest('label').hidden=true;}
$('console-enabled').checked=settings.console===true;
const fpsSettings=settings.fps||{};
$('fps-enabled').checked=typeof fpsSettings.enabled==='boolean'?fpsSettings.enabled:true;
$('fps-mode').value=fpsSettings.mode==='detailed'?'detailed':'simple';
$('fps-opacity').value=String(typeof fpsSettings.opacity==='number'&&Number.isFinite(fpsSettings.opacity)?Math.max(20,Math.min(100,fpsSettings.opacity)):85);
function settingsValue(){return {touch:$('touch-enabled').checked,fullscreen:$('start-fullscreen').checked,console:$('console-enabled').checked,
  fps:{enabled:$('fps-enabled').checked,mode:$('fps-mode').value,opacity:Number($('fps-opacity').value)}};}
function persistSettings(layout=currentLayout){
  const value=settingsValue();
  const write=settingsWrite.catch(()=>{}).then(async()=>{
    if(storageError)throw storageError;
    if(diskStorage)await diskStorage.writeSettings({settings:value,touchLayout:layout});
    currentLayout=layout;
    try{localStorage.setItem('isaacJ835.settings',JSON.stringify(value));localStorage.setItem(TOUCH_LAYOUT_KEY,JSON.stringify(layout));}
    catch(error){if(!diskStorage)throw error;log(error);}
  });
  settingsWrite=write;return write;
}
function rememberSettings(){persistSettings().catch(error=>{log(error);status(`设置保存失败：${error.message||error}`);});}
function setInput(source,codes){if(codes.length)inputSources.set(source,new Set(codes));else inputSources.delete(source);keys.fill(0);for(const set of inputSources.values())for(const code of set)keys[code]=1;}
const touch=createTouchControls({root:$('touch'),onKeys:setInput});
const touchLayout=createTouchLayout({root:$('touch'),editor:$('touch-layout-editor'),
  initialValue:currentLayout,onSave:value=>persistSettings(value),listenToStorage:!diskStorage,
  onOpen:()=>{clearInput();pauseHost(true);},
  onClose:()=>{clearInput();updateTouch();},
  onError:error=>{log(error);status(`按键布局保存失败：${error.message||error}`);}});
$('edit-touch-layout').onclick=()=>touchLayout.open();
function updateTouch(){touchLayout.setControlEnabled('key-96',$('console-enabled').checked);touch.setEnabled($('touch-enabled').checked&&document.body.dataset.mode==='game'&&isRunning());updateConsoleInput();}
$('touch-enabled').onchange=()=>{rememberSettings();updateTouch();};
$('start-fullscreen').onchange=rememberSettings;
$('console-enabled').onchange=()=>{rememberSettings();updateTouch();};
function gamePresent(timestamp,eligible){
  fpsEligible=eligible===true&&isRunning()&&!document.hidden&&document.body.dataset.mode==='game'&&!game?.isaacState.paused;
  fpsMetrics.record(timestamp,fpsEligible);
}
function interruptFpsSampling(){fpsMetrics.breakSampling();fpsEligible=false;fpsLastPaint=0;window.isaacReport.performance={...fpsMetrics.snapshot({detailed:$('fps-mode').value==='detailed'}),sampling:false};}
function paintFps(force=false){
  const enabled=$('fps-enabled').checked,visible=enabled&&isRunning()&&document.body.dataset.mode==='game';
  if($('fps-panel').hidden===visible)$('fps-panel').hidden=!visible;
  if(!visible)return;
  const now=performance.now();if(!force&&now-fpsLastPaint<500)return;fpsLastPaint=now;
  const detailed=$('fps-mode').value==='detailed',metrics=fpsMetrics.snapshot({detailed}),number=value=>value===null?'—':value.toFixed(1);
  message('fps-current',number(fpsEligible?metrics.currentFps:null));
  if(detailed){
    message('fps-average',number(metrics.averageFps));message('fps-low-1',number(metrics.low1Fps));message('fps-low-01',number(metrics.low01Fps));
    message('fps-frametime',number(fpsEligible?metrics.frameTimeMs:null));
    message('fps-sample-note',!fpsEligible?(metrics.sampleCount?'暂停统计':'等待进入游戏'):metrics.sampleCount<100?'采样中…':metrics.sampleCount<1000?'0.1% Low 采样中…':'最近 60 秒游玩');
  }
  window.isaacReport.performance={...metrics,sampling:fpsEligible};
}
function updateFpsSettings(){
  const enabled=$('fps-enabled').checked,mode=$('fps-mode').value,opacity=Number($('fps-opacity').value);
  if(fpsWasEnabled!==enabled){fpsMetrics.reset();interruptFpsSampling();fpsWasEnabled=enabled;}
  $('fps-panel').dataset.mode=mode;$('fps-details').hidden=mode!=='detailed';$('fps-panel').style.opacity=String(opacity/100);
  $('fps-opacity-value').value=`${opacity}%`;
  $('fps-mode').disabled=!storageReady||!enabled;$('fps-opacity').disabled=!storageReady||!enabled;
  if(game?.isaacState)game.isaacState.onPresent=enabled?gamePresent:null;
  paintFps(true);
}
$('fps-enabled').onchange=()=>{updateFpsSettings();rememberSettings();};
$('fps-mode').onchange=()=>{updateFpsSettings();rememberSettings();};
$('fps-opacity').oninput=updateFpsSettings;
$('fps-opacity').onchange=()=>{updateFpsSettings();rememberSettings();};
function clearInput(){inputSources.clear();keys.fill(0);touch.clear();mouse.x=mouse.y=-1;mouse.buttons.fill(0);consoleGeneration++;consoleOpening=consoleClosing=false;if(game?.isaacTextInput)game.isaacTextInput.length=0;}
function updateConsoleInput(){
  const open=!!game?.isaacState?.consoleOpen;
  if(open)consoleOpening=false;
  if(!open)consoleClosing=false;
  if(consoleOpening&&(game.isaacState.frames||0)-consoleOpeningFrame>120)consoleOpening=false;
  const visible=isRunning()&&document.body.dataset.mode==='game'&&$('console-enabled').checked&&$('touch-enabled').checked&&!consoleClosing&&(open||consoleOpening);
  const panel=$('console-input-panel');
  if(panel.hidden===visible){panel.hidden=!visible;if(!visible&&panel.contains(document.activeElement))$('console-command').blur();}
  const submitDisabled=consoleSending||!open;
  if($('console-submit').disabled!==submitDisabled)$('console-submit').disabled=submitDisabled;
  const viewport=window.visualViewport;
  const inset=visible&&viewport?Math.max(0,innerHeight-viewport.height-viewport.offsetTop):0;
  if(inset!==consoleKeyboardInset){consoleKeyboardInset=inset;document.documentElement.style.setProperty('--console-keyboard-offset',`${inset}px`);}
}
for(const type of ['resize','scroll'])window.visualViewport?.addEventListener(type,updateConsoleInput);
async function consoleFrames(count,generation=consoleGeneration){
  const target=(game?.isaacState.frames||0)+count,deadline=performance.now()+5000;
  while(isRunning()&&document.body.dataset.mode==='game'&&generation===consoleGeneration&&performance.now()<deadline){
    if((game.isaacState.frames||0)>=target)return true;
    await new Promise(requestAnimationFrame);
  }
  return false;
}
async function consoleKey(code){
  const source=`console-key-${++consolePulse}`;
  try{setInput(source,[code]);return await consoleFrames(3);}
  finally{setInput(source,[]);}
}
$('touch').querySelector('[data-key="96"]').addEventListener('pointerdown',event=>{
  if(!isRunning()||!$('console-enabled').checked||!$('touch-enabled').checked||(event.pointerType==='mouse'&&event.button!==0))return;
  consoleOpening=!game.isaacState.consoleOpen;consoleClosing=false;consoleOpeningFrame=game.isaacState.frames||0;
  updateConsoleInput();$('console-command').focus({preventScroll:true});
  // Keep the opening key sampled even if the soft keyboard resizes the viewport.
  void consoleKey(96);
});
$('console-close').onclick=async()=>{
  consoleGeneration++;consoleOpening=false;consoleClosing=true;game.isaacTextInput.length=0;
  updateConsoleInput();$('game-canvas').focus();await consoleKey(256);updateConsoleInput();
};
$('console-command').addEventListener('keydown',event=>{
  if(event.code==='Escape'&&!event.isComposing){event.preventDefault();$('console-close').click();}
});
$('console-command-form').onsubmit=async event=>{
  event.preventDefault();if(consoleSending||!isRunning()||!game.isaacState.consoleOpen)return;
  const input=$('console-command'),command=input.value.trim();
  if(!command)return;
  if(command.length>256||/[^\x20-\x7e]/.test(command)){message('console-command-status','请输入不超过 256 个字符的英文命令，可包含数字和符号。');return;}
  const generation=consoleGeneration;consoleSending=true;input.readOnly=true;updateConsoleInput();
  try{
    game.isaacTextInput.push(...Array.from(command,char=>char.charCodeAt(0)));
    const deadline=performance.now()+5000;
    while(game.isaacTextInput.length){
      if(performance.now()>deadline||!await consoleFrames(1,generation)||!game.isaacState.consoleOpen)throw new Error('命令未发送，请重新打开控制台后重试。');
    }
    if(generation!==consoleGeneration||!game.isaacState.consoleOpen)return;
    if(await consoleKey(257)){input.value='';message('console-command-status','命令已提交，请查看游戏控制台输出。');}
  }catch(error){if(generation===consoleGeneration){game.isaacTextInput.length=0;message('console-command-status',error.message||String(error));}}
  finally{consoleSending=false;input.readOnly=false;updateConsoleInput();}
};
function pauseHost(paused){
  if(paused)interruptFpsSampling();
  if(!game?.isaacState)return;
  game.isaacState.paused=paused;
  if(!paused)game.isaacState.resumeFrame?.();
  const audio=game.isaacAudioContext;
  if(audio&&audio.state!=='closed')(paused?audio.suspend():audio.resume()).catch(log);
}
function mode(value){
  document.body.dataset.mode=value;
  $('launcher').hidden=value==='game';$('game-view').hidden=value!=='game';
  clearInput();updateTouch();
  if(isRunning())pauseHost(value!=='game'||document.hidden);
  paintFps(true);
}
function navigate(page){
  for(const section of document.querySelectorAll('[data-page]'))section.hidden=section.dataset.page!==page;
  for(const button of document.querySelectorAll('[data-nav]'))button.setAttribute('aria-current',button.dataset.nav===page?'page':'false');
  if(isRunning())mode('menu');
  if(page==='saves')updateSaveExport();
  document.querySelector(`[data-page="${page}"] h2`)?.focus({preventScroll:true});
}
for(const button of document.querySelectorAll('[data-nav]'))button.onclick=()=>navigate(button.dataset.nav);
$('open-menu').onclick=()=>{navigate('home');mode('menu');status('游戏已暂停。准备好后继续游戏。');};
$('resume').onclick=()=>{if(isRunning()){mode('game');$('game-canvas').focus();const failed=!!window.isaacReport.saveError;status(failed?AUTO_SAVE_ERROR:'',failed);}};
function requestFullscreen(){
  if(globalThis.IsaacNative?.isNative)return;
  if(document.fullscreenElement)return document.exitFullscreen?.().catch(log);
  const result=document.documentElement.requestFullscreen?.();
  if(!result){status('已使用铺满窗口显示；此浏览器未提供系统全屏。');return;}
  result.catch(error=>{log(error);status('无法进入系统全屏，仍可在当前窗口游玩。');});
}
$('fullscreen').onclick=requestFullscreen;
function updateStart(){
  const locked=!isIdle()||busy;
  for(const id of ['touch-enabled','start-fullscreen','edit-touch-layout','fps-enabled'])$(id).disabled=!storageReady;
  updateFpsSettings();
  $('console-enabled').disabled=!storageReady||locked;
  $('start').disabled=!capabilityReady||!storageReady||locked||!!(pendingImport&&!$('import-confirm').checked);
  $('start').hidden=!isIdle();$('resume').hidden=!isRunning();
  for(const id of ['import-save','import-confirm','cancel-import','import-mod-zip','import-mod-folder'])$(id).disabled=locked;
  for(const input of $('mod-list').querySelectorAll('input,button'))input.disabled=locked;
  $('stop').disabled=!isRunning()||ending;
  $('export-backup').disabled=!persistentReady;
  updateSaveExport();
  if($('reload'))$('reload').hidden=window.isaacReport.phase!=='failed';
}
function capabilityCheck(){
  const missing=[],wasm=globalThis.WebAssembly;
  if(location.protocol==='file:')missing.push('请先运行 Start-Game.command 或 Start-Game.cmd，再打开本机地址');
  if(typeof wasm?.validate!=='function'||!wasm.validate(new Uint8Array([0,97,115,109,1,0,0,0])))missing.push('WebAssembly');
  if(typeof wasm?.Suspending!=='function'||typeof wasm?.promising!=='function')missing.push('WebAssembly JSPI');
  let gl;try{gl=document.createElement('canvas').getContext('webgl2');}catch{}
  if(!gl)missing.push('WebGL 2');gl?.getExtension('WEBGL_lose_context')?.loseContext();
  if(!diskStorage)try{if(!window.indexedDB)missing.push('本地存储');}catch{missing.push('本地存储');}
  const ok=!missing.length;
  const native=globalThis.IsaacNative?.isNative;
  const advice=native?(globalThis.IsaacNative.platform==='ios'?'请更新到支持这些功能的 iOS / iPadOS 版本。':'请更新系统的 Android System WebView。'):'请使用支持这些功能的 Chrome 或 Edge。';
  $('compatibility').textContent=ok?(diskStorage?(native?'已准备就绪 · 存档、Mod 和设置保存在此应用的本地文件中。':'已准备就绪 · 存档、Mod 和设置保存在项目的 userdata 文件夹。'):'已准备就绪 · 存档和 Mod 保存在当前浏览器。'):`当前运行环境缺少：${missing.join('；')}。${advice}`;
  $('compatibility').dataset.supported=String(ok);window.isaacReport.capabilities={passed:ok,missing};return ok;
}
function formatSize(bytes){return bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;}
function renderMods(){
  $('mod-list').replaceChildren();
  if(!installedMods.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='还没有安装 Mod。导入一个 ZIP 或 Mod 文件夹，开始你的收藏。';$('mod-list').append(empty);}
  for(const mod of installedMods){
    const row=document.createElement('article');row.className='mod-card';row.dataset.id=mod.id;
    const label=document.createElement('label');label.className='mod-choice';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.mod=mod.id;checkbox.checked=mod.enabled;
    checkbox.setAttribute('aria-label',`启用 ${mod.name}`);
    const info=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');
    name.textContent=mod.name;detail.textContent=[mod.version?`v${mod.version}`:'',`${mod.fileCount} 个文件`,formatSize(mod.bytes)].filter(Boolean).join(' · ');
    info.append(name,detail);label.append(checkbox,info);
    const remove=document.createElement('button');remove.type='button';remove.className='button-quiet';remove.textContent='移除';remove.setAttribute('aria-label',`移除 ${mod.name}`);
    checkbox.onchange=()=>modMutation(async()=>{await modStore.setEnabled(mod.id,checkbox.checked);message('mod-status','启用设置已保存，将在启动游戏时生效。');});
    remove.onclick=()=>modMutation(async()=>{await modStore.remove(mod.id);message('mod-status',`已移除 ${mod.name}；此 Mod 的存档数据保留。`);});
    row.append(label,remove);$('mod-list').append(row);
  }
  message('mod-count',`${installedMods.length} 个已安装 · ${selectedMods().length} 个启用`);
  window.isaacReport.installedMods=installedMods.map(({id,name,enabled})=>({id,name,enabled}));updateStart();
}
async function refreshMods(){installedMods=await modStore.list();renderMods();updateImportSummary();}
async function modMutation(action){
  if(!isIdle()||busy)return;
  busy=true;updateStart();
  try{await action();await refreshMods();}catch(error){
    log(error);try{await refreshMods();}catch(refreshError){log(refreshError);renderMods();}
    message('mod-status',`操作失败：${error.message||error}`);
  }
  finally{busy=false;updateStart();}
}
async function importMod(kind,input){
  const files=Array.from(input.files||[]);if(!files.length)return;
  await modMutation(async()=>{
    message('mod-status','正在读取并检查 Mod…');
    const mod=kind==='zip'?await prepareModFromZip(files[0]):await prepareModFromFiles(files);
    const existed=installedMods.some(item=>item.id===mod.id);
    const installed=await modStore.install(mod,{replace:true});
    if(pendingImport&&!pendingImport.native)await modStore.setEnabled(mod.id,pendingImport.selectedMods.includes(mod.id));
    message('mod-status',`${mod.name} 已${existed?'更新':'导入'}。${pendingImport&&!pendingImport.native?'已按存档备份设置启用状态。':installed.enabled?'已启用，下次启动游戏时加载。':'当前已停用，可勾选后启用。'}`);
  });input.value='';updateImportSummary();
}
$('import-mod-zip').onchange=()=>importMod('zip',$('import-mod-zip'));
$('import-mod-folder').onchange=()=>importMod('folder',$('import-mod-folder'));
async function chooseMods(ids){await modStore.setSelection(ids);await refreshMods();}
function updateImportSummary(){
  if(!pendingImport)return;
  const absent=pendingImport.selectedMods.filter(id=>!installedMods.some(mod=>mod.id===id));
  const modNote=pendingImport.native?'文件内容将原样写入，按文件名恢复到对应槽位。续局前请准备好相同的 Mod。':absent.length?`尚未安装 ${absent.length} 个备份中的 Mod（${absent.join('、')}），可先到 Mod 页面导入；缺少 Mod 可能影响续局。`:'备份中的 Mod 均已安装；以模组管理页当前的启用选择为准。';
  $('import-summary').textContent=`已读取 ${pendingImport.label}：${pendingImport.files.length} 个文件，${formatSize(pendingImport.bytes)}。${modNote}确认后在主页开始游戏时导入。`;
  $('import-confirm-label').textContent=pendingImport.native?'确认覆盖所选的同名存档文件。其他文件保留。':`确认覆盖${diskStorage?'项目':'此浏览器'}中的同名存档和 Mod 配置。其他文件保留。`;
}
async function clearPendingImport(restore=true){
  if(restore&&previousMods)await chooseMods(previousMods);
  pendingImport=null;previousMods=null;window.isaacReport.importPending=null;
  $('import-confirm').checked=false;$('import-review').hidden=true;$('import-save').value='';updateStart();
}
$('cancel-import').onclick=()=>modMutation(()=>clearPendingImport());
$('import-confirm').onchange=updateStart;
$('import-save').onchange=async()=>{
  const files=Array.from($('import-save').files||[]);if(!files.length||!isIdle()||busy)return;
  busy=true;updateStart();
  try{
    await clearPendingImport();status('正在校验存档…');
    const json=files.length===1&&/\.json$/i.test(files[0].name);
    if(json&&files[0].size>MAX_BACKUP_BYTES)throw new Error('备份文件超过 48 MiB。');
    const backup=json?await parseBackup(await files[0].text()):await parseNativeSaves(files,selectedMods());
    previousMods=backup.native?null:selectedMods();pendingImport={...backup,label:files.map(file=>file.name).join('、')};
    if(!backup.native)await chooseMods(backup.selectedMods);
    window.isaacReport.importPending={fileName:pendingImport.label,files:backup.files.length,bytes:backup.bytes};
    updateImportSummary();$('import-review').hidden=false;status('存档已准备好，请确认导入，然后回到主页开始游戏。');
  }catch(error){
    try{await clearPendingImport();}catch(restoreError){log(restoreError);pendingImport=null;previousMods=null;window.isaacReport.importPending=null;$('import-review').hidden=true;}
    log(error);status(`存档导入失败：${error.message||error}`);
  }
  finally{busy=false;updateStart();}
};
function browserSync(populate){return new Promise((resolve,reject)=>game.FS.syncfs(populate,error=>error?reject(error):resolve()));}
async function syncfs(populate,{force=true}={}){
  if(!populate&&!force&&saveChanges&&!saveChanges.dirty)return;
  // Captured before the synchronous snapshot, acknowledged only on successful
  // commit. Native writes made during the await remain dirty for the next save.
  const generation=saveChanges?.generation;
  if(!diskStorage){
    await browserSync(populate);
    if(!populate&&generation!==undefined)saveChanges.acknowledge(generation);
    return;
  }
  if(populate){
    const stored=await diskStorage.readSaves();
    if(!stored.revision&&!stored.files.length){
      // Read the old browser mounts once; never sync them back or clear them.
      // The native directory becomes authoritative after this first commit.
      let legacy=[];
      if(globalThis.indexedDB){
        game.FS.mount(game.IDBFS,{},'/game/user');game.FS.mount(game.IDBFS,{},'/game/data');
        try{await browserSync(true);legacy=collectSaveFiles(game.FS,{allowEmpty:true});}
        finally{game.FS.unmount('/game/user');game.FS.unmount('/game/data');}
      }
      applyBackup(game.FS,{files:legacy});
      await diskStorage.writeSaves(legacy,{meta:{browserMigrationComplete:true,migratedAt:new Date().toISOString()}});
      window.isaacReport.migratedSaveFiles=legacy.length;
      if(legacy.length)log(`已将 ${legacy.length} 个旧浏览器存档文件复制到项目；浏览器原数据保留。`);
    }else applyBackup(game.FS,stored);
  }else{
    await diskStorage.writeSaves(collectSaveFiles(game.FS,{allowEmpty:true}));
    if(generation!==undefined)saveChanges.acknowledge(generation);
  }
}
function persist({force=true}={}){
  // A background/export request needs a fresh snapshot after an earlier save;
  // sharing that earlier promise could omit writes made while it was in flight.
  if(savePromise)return force?savePromise.then(()=>persist({force:true})):savePromise;
  savePromise=syncfs(false,{force}).finally(()=>{savePromise=null;});return savePromise;
}
window.isaacHost={async flushForExit(){
  clearInput();pauseHost(true);
  if(savePromise)await savePromise;
  if(persistentReady)await persist();
  await settingsWrite;
}};
function configureDebugConsole(FS,enabled){
  const folder='/game/user/Documents/My Games/Binding of Isaac Repentance',path=folder+'/options.ini';
  let source='';
  try{for(const byte of FS.readFile(path))source+=String.fromCharCode(byte);}
  catch(error){if(error.errno!==44&&error.code!=='ENOENT')throw error;}
  // Work byte-for-byte so unrelated settings, comments and encoding survive.
  const newline=source.includes('\r\n')?'\r\n':'\n',value=enabled?'1':'0';
  const section=/^\[Options\][ \t]*\r?$/im.exec(source);
  if(section){
    const start=section.index+section[0].length;
    const next=/^\[/m.exec(source.slice(start)),end=next?start+next.index:source.length;
    let body=source.slice(start,end);
    const key=/^([ \t]*EnableDebugConsole[ \t]*=[ \t]*)[^\r\n]*/gim;
    if(key.test(body)){key.lastIndex=0;body=body.replace(key,(_,prefix)=>prefix+value);}
    else body+=(body.endsWith('\n')?'':newline)+'EnableDebugConsole='+value+newline;
    source=source.slice(0,start)+body+source.slice(end);
  }else source+=(source&&!source.endsWith('\n')?newline:'')+'[Options]'+newline+'EnableDebugConsole='+value+newline;
  FS.mkdirTree(folder);FS.writeFile(path,Uint8Array.from(source,char=>char.charCodeAt(0)));
}
async function autoSave({force=false}={}){
  if(!persistentReady||ending)return false;
  try{
    await persist({force});window.isaacReport.savedAt=new Date().toISOString();
    if(window.isaacReport.saveError){delete window.isaacReport.saveError;status('');}
    return true;
  }catch(error){
    log(error);window.isaacReport.saveError=error.message||String(error);
    status(AUTO_SAVE_ERROR,true);return false;
  }
}
function selectedNativeSave(){
  return collectNativeSaves(game.FS).find(file=>String(file.slot)===$('save-slot').value&&file.kind===$('save-kind').value);
}
function updateSaveExport(){
  $('export-save').disabled=true;
  if(!persistentReady){message('export-save-info',`启动游戏后可导出${diskStorage?'项目':'当前浏览器'}中的存档。`);return;}
  try{
    const file=selectedNativeSave();
    message('export-save-info',file?`${$('save-steam-name').checked?file.steamName:file.localName} · ${formatSize(file.data.length)}`:`存档 ${$('save-slot').value} 还没有${$('save-kind').value==='gamestate'?'可继续的当前局':'进度文件'}。`);
    $('export-save').disabled=!file;
  }catch(error){message('export-save-info',error.message||String(error));}
}
for(const id of ['save-slot','save-kind','save-steam-name'])$(id).onchange=updateSaveExport;
async function downloadFile(data,filename,type){
  if(globalThis.IsaacNative?.isNative)return await globalThis.IsaacNative.exportFile(data,filename,type);
  const url=URL.createObjectURL(new Blob([data],{type}));
  const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function persistBeforeExport(){
  try{await persist();return true;}
  catch(error){log(error);return false;}
}
$('export-save').onclick=async()=>{
  if(!persistentReady)return;$('export-save').disabled=true;
  try{
    const persisted=await persistBeforeExport(),file=selectedNativeSave();
    if(!file)throw new Error('所选槽位尚无此存档，请先在游戏中保存。');
    const filename=$('save-steam-name').checked?file.steamName:file.localName;
    await downloadFile(file.data,filename,'application/octet-stream');
    Object.assign(window.isaacReport,{exportedAt:new Date().toISOString(),exportedFiles:1,exportedName:filename,exportedFormat:'native-dat'});
    status(`已导出 ${filename}，内容为原版 .dat 存档。${persisted?'':'存储写入失败，请妥善保留下载的文件。'}`);
  }catch(error){log(error);status(`存档导出失败：${error.message||error}`);}
  finally{updateStart();}
};
$('export-backup').onclick=async()=>{
  if(!persistentReady)return;$('export-backup').disabled=true;
  try{
    const persisted=await persistBeforeExport(),backup=await createBackup(game.FS,window.isaacReport.mods.map(mod=>mod.id));
    const filename=`isaac-j835-save-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    await downloadFile(JSON.stringify(backup),filename,'application/json');
    Object.assign(window.isaacReport,{exportedAt:new Date().toISOString(),exportedFiles:backup.files.length,exportedName:filename,exportedFormat:'json-backup'});status(`已导出完整备份，包含 ${backup.files.length} 个存档文件。${persisted?'':'存储写入失败，请妥善保留下载的文件。'}`);
  }catch(error){log(error);status(`存档导出失败：${error.message||error}`);}
  finally{updateStart();}
};
const keyCodes={ArrowUp:265,ArrowDown:264,ArrowLeft:263,ArrowRight:262,Enter:257,Escape:256,Space:32,Tab:258,Backspace:259,ControlLeft:341,ControlRight:345,ShiftLeft:340,ShiftRight:344,AltLeft:342,AltRight:346,Backquote:96,Comma:44,Period:46,Slash:47,Semicolon:59,Quote:39,BracketLeft:91,Backslash:92,BracketRight:93,Minus:45,Equal:61};
function keyCode(event){return keyCodes[event.code]??(/^Key[A-Z]$/.test(event.code)?event.code.charCodeAt(3):/^Digit[0-9]$/.test(event.code)?event.code.charCodeAt(5):/^F([1-9]|1[0-9]|2[0-5])$/.test(event.code)?289+Number(event.code.slice(1)):null);}
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{
  if(!isRunning()||document.body.dataset.mode!=='game')return;
  const key=keyCode(event);
  // A key held before focusing the command field must still be released there.
  if(type==='keyup'&&key!==null)setInput(`keyboard-${key}`,[]);
  if(event.target.closest?.('input,textarea,select,[contenteditable="true"]')||event.isComposing)return;
  if(type==='keydown'&&game.isaacState.consoleOpen&&event.code!=='Backquote'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&event.key.length===1){
    const character=event.key.charCodeAt(0);
    if(character>=32&&character<=126){game.isaacTextInput.push(character);event.preventDefault();}
  }
  if(key!==null){setInput(`keyboard-${key}`,type==='keydown'?[key]:[]);event.preventDefault();}
});
window.addEventListener('blur',clearInput);
document.addEventListener('visibilitychange',()=>{clearInput();if(isRunning())pauseHost(document.hidden||document.body.dataset.mode!=='game');if(document.hidden)autoSave({force:true});});
// Native wrappers deliver lifecycle events even when the WebView's visibility
// state does not change. Resume to the launcher menu, keeping gameplay paused.
window.addEventListener('isaac:native-state',event=>{
  clearInput();
  if(event.detail?.isActive===false){
    if(isRunning()){$('open-menu').click();pauseHost(true);}
    autoSave({force:true});
  }
});
window.addEventListener('isaac:native-back',()=>{
  clearInput();
  if(isRunning())$('open-menu').click();
  else navigate('home');
});
const canvas=$('game-canvas');
function updateMouse(event){
  if(event.pointerType==='touch')return;
  const rect=canvas.getBoundingClientRect(),scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
  mouse.x=(event.clientX-rect.left-(rect.width-canvas.width*scale)/2)/scale;mouse.y=(event.clientY-rect.top-(rect.height-canvas.height*scale)/2)/scale;
  mouse.buttons[0]=(event.buttons&1)?1:0;mouse.buttons[1]=(event.buttons&2)?1:0;mouse.buttons[2]=(event.buttons&4)?1:0;
}
for(const type of ['pointermove','pointerdown','pointerup'])canvas.addEventListener(type,event=>{updateMouse(event);if(type==='pointerdown')canvas.focus();});
for(const type of ['pointerleave','pointercancel'])canvas.addEventListener(type,()=>{mouse.x=mouse.y=-1;mouse.buttons.fill(0);});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
$('stop').onclick=async()=>{
  if(!isRunning()||ending)return;
  ending=true;clearInterval(saveTimer);clearInput();
  window.isaacReport.phase='stopping';updateStart();mode('loading');status('正在结束游戏…');
  game.isaacState.stopRequested=true;game.isaacState.paused=false;game.isaacState.resumeFrame?.();
};
if($('reload'))$('reload').onclick=()=>location.reload();
$('start').onclick=async()=>{
  if($('start').disabled)return;
  window.isaacReport.phase='loading';updateStart();mode('loading');
  if($('start-fullscreen').checked&&!document.fullscreenElement)requestFullscreen();
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  let audioContext;if(AudioContext){audioContext=new AudioContext();audioContext.resume().catch(log);}
  let returnToMenu=false;
  try{
    await settingsWrite;
    const mods=await modStore.enabled();
    window.isaacReport.mods=mods.map(({id,name})=>({id,name}));
    status('正在加载游戏程序…');
    const [{default:createGame},manifest]=await Promise.all([import('./j835_game.mjs'),fetch('./asset-manifest.json').then(r=>{if(!r.ok)throw new Error(`资源清单 HTTP ${r.status}`);return r.json();})]);
    game=await createGame({noInitialRun:true,canvas,print:log,printErr:log,onAbort:reason=>{window.isaacReport.abort=String(reason);},onExit:code=>{window.isaacReport.exitCode=code;},
      isaacInput:keys,isaacTextInput:[],isaacMouse:mouse,isaacState:{frames:0,paused:false,consoleOpen:false,consolePhase:0,onPresent:$('fps-enabled').checked?gamePresent:null},isaacAudioContext:audioContext,
      isaacGLChecks:new URL(location.href).searchParams.get('glchecks')||'release',isaacMaxFrames:Number(new URL(location.href).searchParams.get('frames')||0)});
    window.isaacGame=game;
    game.FS.mkdirTree('/game/user');game.FS.mkdirTree('/game/mods');game.FS.mkdirTree('/game/data');
    if(!diskStorage){game.FS.mount(game.IDBFS,{},'/game/user');game.FS.mount(game.IDBFS,{},'/game/data');}
    await syncfs(true);
    if(pendingImport){
      status('正在导入并保存存档…');const rollback=applyBackup(game.FS,pendingImport);
      try{await syncfs(false);}catch(error){rollback();try{await syncfs(false);}catch(restoreError){log(restoreError);}throw error;}
      Object.assign(window.isaacReport,{importedAt:new Date().toISOString(),importedFiles:pendingImport.files.length,importPending:null});
      $('import-review').hidden=true;pendingImport=null;previousMods=null;
    }
    configureDebugConsole(game.FS,$('console-enabled').checked);await syncfs(false);
    saveChanges=createSaveChangeTracker(game.FS);
    persistentReady=true;updateStart();
    const files=manifest.files,total=files.reduce((sum,file)=>sum+file.size,0);let loaded=0;
    for(let i=0;i<files.length;i++){
      const file=files[i];status(`正在加载游戏资源 ${Math.round(loaded/total*100)}%`);
      const response=await fetch(file.url);if(!response.ok)throw new Error(`读取 ${file.path} 失败：HTTP ${response.status}`);
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength!==file.size)throw new Error(`资源长度不符：${file.path}`);
      const target='/game/'+file.path,cut=target.lastIndexOf('/');game.FS.mkdirTree(target.slice(0,cut));game.FS.createDataFile(target.slice(0,cut),target.slice(cut+1),bytes,true,false,true);
      loaded+=file.size;$('progress').value=loaded/total;await new Promise(resolve=>setTimeout(resolve,0));
    }
    mountMods(game.FS,mods);mods.length=0;
    fpsMetrics.reset();interruptFpsSampling();
    game.FS.chdir('/game');status('');window.isaacReport.phase='running';updateStart();mode('game');canvas.focus();
    saveTimer=setInterval(autoSave,15000);
    const monitor=setInterval(()=>{window.isaacReport.frames=game.isaacState.frames||0;updateConsoleInput();paintFps();},100);
    try{await game.callMain(['/game/isaac-ng.exe.unpacked.exe','/game']);}finally{clearInterval(monitor);}
    if(window.isaacReport.exitCode&&window.isaacReport.exitCode!==0)throw new Error(`游戏退出码 ${window.isaacReport.exitCode}`);
    ending=true;clearInterval(saveTimer);clearInput();
    // callMain has now flushed the native streams. Drain any earlier autosave,
    // then take a fresh snapshot; reusing that earlier promise can miss bytes.
    if(savePromise)await savePromise.catch(log);
    try{await syncfs(false);}
    catch(error){log(error);throw new Error('存档未能写入保存位置。当前数据已保留，请先导出存档，再重试启动。');}
    await settingsWrite;
    window.isaacReport.savedAt=new Date().toISOString();window.isaacReport.phase='stopped';
    returnToMenu=true;status('正在返回开始界面…');
  }catch(error){window.isaacReport.phase='failed';window.isaacReport.error=error.stack||String(error);log(error.stack||error);status(`运行失败：${error.message||error}`);}
  finally{
    clearInterval(saveTimer);clearInput();
    if(audioContext&&audioContext.state!=='closed')await audioContext.close().catch(log);
    if(returnToMenu){
      try{sessionStorage.setItem('isaacJ835.exitNotice',window.isaacReport.savedAt);}catch(error){log(error);}
      // A fresh document releases the entire old Wasm instance and all native
      // bindings. The player returns directly to an editable, idle launcher.
      location.reload();
    }else{mode('menu');navigate('home');updateStart();}
  }
};
mode('menu');navigate('home');capabilityReady=capabilityCheck();if(!capabilityReady)status($('compatibility').textContent);updateStart();
try{
  const endedAt=sessionStorage.getItem('isaacJ835.exitNotice');sessionStorage.removeItem('isaacJ835.exitNotice');
  if(endedAt){window.isaacReport.previousSessionEndedAt=endedAt;if(capabilityReady)status('已结束游戏，可以调整设置或开始游戏。');}
}catch(error){log(error);}
try{
  if(storageError)throw storageError;
  modStore=diskStorage?diskStorage.modStore:await openModStore();
  if(diskStorage){
    message('mod-storage-note','导入后保存在项目的 userdata/mods 中，随整个文件夹一起移动。');
    message('mod-transfer-note','Mod 文件与启用设置保存在项目中；移除 Mod 会保留它的存档。');
    message('save-storage-note','直接导入、导出原版忏悔的 .dat 文件。游戏生成的存档会自动写入 userdata/saves。');
    message('save-location','保存位置：userdata/saves（位于当前游戏文件夹内）');
    if(!diskSettings?.meta?.browserMigrationComplete){
      status('正在迁移旧浏览器中的 Mod 和设置…');
      if(globalThis.indexedDB){
        const previous=await openModStore();
        try{
          const installed=new Set((await modStore.list()).map(mod=>mod.id));
          for(const mod of await previous.list())if(!installed.has(mod.id))await modStore.install(await previous.get(mod.id));
        }finally{previous.close();}
      }
      await diskStorage.writeSettings({settings:settingsValue(),touchLayout:currentLayout},{meta:{...diskSettings?.meta,browserMigrationComplete:true}});
      status('本地文件已准备好。开始游戏时会接入项目存档。');
    }
  }
  await refreshMods();storageReady=true;window.isaacReport.phase='idle';updateStart();
}
catch(error){log(error);window.isaacReport.phase='failed';window.isaacReport.error=error.stack||String(error);status(`无法打开本地存储：${error.message||error}`);updateStart();}
