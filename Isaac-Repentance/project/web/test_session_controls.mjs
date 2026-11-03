/* Real Wasm lifecycle and customized touch inputs. Uses fresh browser profiles;
 * source game files and the user's browser profile are never changed. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
// Node resolves the web-game compatibility link to the canonical web folder.
// Reports and development fixtures still belong to the outer workspace.
const sourceDirectory=path.dirname(fileURLToPath(import.meta.url));
const canonicalWeb=path.basename(sourceDirectory)==='web'&&path.basename(path.dirname(sourceDirectory))==='project';
const root=path.resolve(process.env.PROJECT_ROOT||path.join(sourceDirectory,canonicalWeb?'../../..':'..'));
const output=path.resolve(process.env.REPORT_DIR||path.join(root,'reports/session-controls'));
const gameURL=new URL(process.env.GAME_URL||'http://127.0.0.1:8274/');
assert(['localhost','127.0.0.1','[::1]'].includes(gameURL.hostname));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'/Users/yakutsukuriyuu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const sha=data=>createHash('sha256').update(data).digest('hex');
const saveRoot='/game/user/Documents/My Games/Binding of Isaac Repentance/';
const layoutKey='isaacJ835.touchLayout.v1';
const fixtureId='9999902001';
await mkdir(output,{recursive:true});
const fixture=path.join(output,'session-fixture');await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'metadata.xml'),`<metadata><name>Session persistence fixture</name><id>${fixtureId}</id><version>1</version></metadata>`);
await writeFile(path.join(fixture,'main.lua'),'RegisterMod("Session persistence fixture", 1)\n');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--mute-audio']});
const report={success:false,browser:browser.version(),url:gameURL.href,checks:[],errors:[],externalRequests:[],screens:[],physicalMobileTested:false};
let context,page;
const pass=value=>{report.checks.push(value);console.log('PASS',value);};
async function ready(){await page.waitForFunction(()=>window.isaacReport?.phase==='idle'&&!document.querySelector('#start').disabled,null,{timeout:30000});}
async function fresh(){
  context=await browser.newContext({viewport:{width:1280,height:800},hasTouch:true,acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(String(error)));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==gameURL.origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(gameURL.href,{waitUntil:'domcontentloaded'});await ready();
}
async function nav(name){
  if(await page.locator('#launcher').isHidden())await page.locator('#open-menu').click();
  if(!await page.locator(`[data-nav="${name}"]:visible`).count())await page.locator('[data-nav="home"]:visible').first().click();
  await page.locator(`[data-nav="${name}"]:visible`).first().click();
}
async function frames(count){
  const initial=await page.evaluate(()=>window.isaacGame?.isaacState.frames||0);
  await page.waitForFunction(target=>window.isaacReport.phase==='failed'||(window.isaacGame?.isaacState.frames||0)>=target,initial+count,{timeout:180000,polling:30});
  assert.equal(await page.evaluate(()=>window.isaacReport.phase),'running',(await snapshot()).native);
}
async function key(code,held=6,settle=90){await page.keyboard.down(code);await frames(held);await page.keyboard.up(code);await frames(settle);}
async function snapshot(){return page.evaluate(saveRoot=>{
  let native='';try{native=window.isaacGame.FS.readFile(saveRoot+'log.txt',{encoding:'utf8'});}catch{}
  return {report:window.isaacReport,native,frames:window.isaacGame?.isaacState.frames,paused:window.isaacGame?.isaacState.paused,keys:window.isaacGame?Array.from(window.isaacGame.isaacInput):[],settings:localStorage.getItem('isaacJ835.settings'),layout:localStorage.getItem('isaacJ835.touchLayout.v1')};
},saveRoot);}
async function shot(name){await page.screenshot({path:path.join(output,name+'.png'),fullPage:!await page.locator('#touch-layout-editor').isVisible()});report.screens.push(name+'.png');}
async function saveDigests(){return page.evaluate(async root=>{
  const files={};for(const name of ['persistentgamedata1.dat','gamestate1.dat']){const data=window.isaacGame.FS.readFile(root+name);files[name]={size:data.length,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('')};}return files;
},saveRoot);}
async function saveQuitNative(){await key('Escape');await key('ArrowDown',6,10);await key('Enter',6,120);}
async function customizeLive(){
  await nav('settings');const before=await snapshot();assert(before.paused);
  await page.locator('#edit-touch-layout').click();await page.locator('#touch-layout-editor').waitFor({state:'visible'});
  // Selectors are shared with the editor's accessible controls and finalized by
  // its implementation before this test is executed.
  const move=page.locator('#touch-layout-editor [data-stick="move"]');
  await move.click();const rect=await move.boundingBox();assert(rect);
  await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+85,rect.y+rect.height/2-35,{steps:10});await page.mouse.up();
  await page.locator('#touch-layout-size').evaluate(element=>{element.value='125';element.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.locator('#touch-layout-opacity').evaluate(element=>{element.value='45';element.dispatchEvent(new Event('input',{bubbles:true}));});
  await shot('01-touch-editor');
  const editing=await snapshot();assert.equal(editing.frames,before.frames);assert(editing.keys.every(value=>value===0));
  await page.locator('#touch-layout-save').click();assert(await page.locator('#touch-layout-editor').isHidden());
  report.savedLayout=await page.evaluate(key=>localStorage.getItem(key),layoutKey);assert(report.savedLayout);const layout=JSON.parse(report.savedLayout);assert.equal(layout.landscape.move.size,1.25);assert.equal(layout.landscape.move.opacity,0.45);
  await nav('home');await page.locator('#resume').click();await frames(10);
  const visual=await page.locator('#touch [data-stick="move"]').evaluate(element=>({opacity:getComputedStyle(element).opacity,box:{x:element.getBoundingClientRect().x,y:element.getBoundingClientRect().y,width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}}));
  assert.equal(Number(visual.opacity),0.45);report.customizedMove=visual;
  pass('Live touch editor pauses game, produces no game input, and saves drag/size/opacity changes');
  const cdp=await context.newCDPSession(page);
  const left=await page.locator('#touch [data-stick="move"]').boundingBox(),right=await page.locator('#touch [data-stick="shoot"]').boundingBox();assert(left&&right);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:left.x+left.width*.88,y:left.y+left.height*.5,id:1},{x:right.x+right.width*.5,y:right.y+right.height*.15,id:2}]});
  await frames(12);assert.equal(await page.evaluate(()=>window.isaacGame.isaacInput[68]),1);assert.equal(await page.evaluate(()=>window.isaacGame.isaacInput[265]),1);
  await shot('02-customized-touch-game');
  await page.keyboard.down('d');await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await frames(4);
  assert.equal(await page.evaluate(()=>window.isaacGame.isaacInput[68]),1);assert.equal(await page.evaluate(()=>window.isaacGame.isaacInput[265]),0);
  await page.keyboard.up('d');await frames(4);assert.equal(await page.evaluate(()=>window.isaacGame.isaacInput.some(Boolean)),false);
  await cdp.detach();pass('Customized hitboxes support simultaneous moving/shooting and release independently of keyboard');
}
try{
  if(process.env.RECOVERY_ONLY!=='1'){
  await fresh();await nav('settings');await page.locator('#touch-enabled').uncheck();await page.locator('#touch-enabled').check();
  await nav('mods');await page.locator('#import-mod-folder').setInputFiles(fixture);await page.waitForFunction(id=>window.isaacReport.installedMods.some(mod=>mod.id===id&&mod.enabled),fixtureId);
  await nav('home');await page.locator('#start').click();await frames(120);
  for(let index=0;index<4;index++)await key('Enter');await frames(90);
  const first=await snapshot(),seed=[...first.native.matchAll(/RNG Start Seed: [A-Z0-9 ]+ \((\d+)\) \[New,/g)].at(-1)?.[1];assert(seed);report.seed=seed;
  await customizeLive();await saveQuitNative();
  report.savedBeforeStop=await saveDigests();await nav('settings');
  const reloadEvent=page.waitForNavigation({waitUntil:'domcontentloaded'});await page.locator('#stop').click();await reloadEvent;await ready();
  assert(await page.evaluate(()=>window.isaacReport.previousSessionEndedAt));assert(await page.locator('#reload').isHidden());assert(await page.locator('#start').isVisible());assert.equal(await page.locator('#import-save').isDisabled(),false);assert.equal(await page.locator('#import-mod-folder').isDisabled(),false);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),layoutKey),report.savedLayout);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('isaacJ835.settings')).touch),true);
  assert.deepEqual(await page.evaluate(()=>window.isaacReport.installedMods.map(({id,enabled})=>({id,enabled}))),[{id:fixtureId,enabled:true}]);
  await shot('03-automatic-return-home');pass('Normal stop automatically returns to ready home with editable imports and no extra restart click');
  pass('Automatic return retains touch settings/layout and installed Mod selection');
  let release;const gate=new Promise(resolve=>release=resolve),routeHandler=route=>gate.then(()=>route.continue());await page.route('**/assets/**',routeHandler);
  await page.locator('#start').click();await page.waitForFunction(()=>window.isaacGame?.FS.analyzePath('/game/user/Documents/My Games/Binding of Isaac Repentance/gamestate1.dat').exists,null,{timeout:180000});
  assert.deepEqual(await saveDigests(),report.savedBeforeStop);release();await page.unroute('**/assets/**',routeHandler);await frames(120);
  for(let index=0;index<3;index++)await key('Enter');await frames(90);
  const second=await snapshot(),continued=[...second.native.matchAll(/RNG Start Seed: [A-Z0-9 ]+ \((\d+)\) \[Continue,/g)].at(-1)?.[1];assert.equal(continued,seed);
  await shot('04-continued-after-stop');pass('Second start restores byte-identical saves and native Continue resumes the same seed');
  }else{
    report.recoveryOnly=true;await fresh();await page.locator('#start').click();await frames(120);for(let index=0;index<4;index++)await key('Enter');await frames(60);
  }
  await saveQuitNative();await nav('settings');
  report.preFailure=await saveDigests();let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  await page.evaluate(()=>{const FS=window.isaacGame.FS;FS.syncfs=(populate,callback)=>setTimeout(()=>callback(new Error('Simulated browser save failure')),0);});
  await page.locator('#stop').click();await page.waitForFunction(()=>window.isaacReport.phase==='failed',null,{timeout:30000});await page.waitForTimeout(350);
  assert.equal(navigations,0);assert(await page.locator('#reload').isVisible());assert.deepEqual(await saveDigests(),report.preFailure);
  await nav('saves');await page.locator('#save-kind').selectOption('gamestate');report.beforeRecovery=await snapshot();report.recoveryButton=await page.locator('#export-save').evaluate(e=>({disabled:e.disabled,text:e.textContent,info:document.querySelector('#export-save-info').textContent,status:document.querySelector('#status').textContent,mode:document.body.dataset.mode}));await shot('05-before-recovery');await writeFile(path.join(output,'checkpoint.json'),JSON.stringify(report,null,2));const event=page.waitForEvent('download',{timeout:10000});event.catch(()=>{});await page.locator('#export-save').click({timeout:5000});const download=await event,file=path.join(output,'save-after-persistence-failure.dat');await download.saveAs(file);
  assert.equal(sha(await readFile(file)),report.preFailure['gamestate1.dat'].sha256);await shot('05-save-failure-recovery');pass('Save failure prevents automatic reload and still allows exact native .dat recovery');
  await page.locator('.save-advanced summary').click();const backupEvent=page.waitForEvent('download',{timeout:10000});backupEvent.catch(()=>{});await page.locator('#export-backup').click({timeout:5000});const backupDownload=await backupEvent,backupFile=path.join(output,'backup-after-persistence-failure.json');await backupDownload.saveAs(backupFile);const backup=JSON.parse(await readFile(backupFile,'utf8'));assert.equal(backup.format,'isaac-j835-save-backup');for(const [name,file] of Object.entries(report.preFailure)){const entry=backup.files.find(entry=>entry.path.endsWith('/'+name));assert(entry);assert.equal(sha(Buffer.from(entry.base64,'base64')),file.sha256);}pass('Legacy JSON backup also recovers exact native bytes after a persistence failure');
  await context.close();context=null;
  await fresh();let blocked=0;await page.route('**/j835_game.mjs',route=>{blocked++;return route.abort('failed');});
  await page.locator('#start').click();await page.waitForFunction(()=>window.isaacReport.phase==='failed',null,{timeout:30000});await page.waitForTimeout(350);
  assert.equal(blocked,1);assert(await page.locator('#reload').isVisible());assert(await page.locator('#start').isHidden());await shot('06-start-failure-retry');
  pass('A startup failure exposes retry without an automatic reload loop');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.success=true;
}catch(error){report.error=error.stack||String(error);console.error(error);process.exitCode=1;try{report.failure=await snapshot();await shot('failure');}catch{}}
finally{if(context)await context.close();await browser.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');}
