/** Real isolated Electron gameplay, native .dat persistence and relaunch check. */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {_electron} from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.test-results');
await mkdir(out, {recursive: true});
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'isaac-electron-smoke-'));
const report = {success: false, dataDir, checks: [], errors: [], externalRequests: []};
const packaged = process.env.ISAAC_SMOKE_EXECUTABLE;
const executablePath = packaged || createRequire(import.meta.url)('electron');
report.packaged = Boolean(packaged);
report.executablePath = executablePath;
let application, page;
const pass = text => { report.checks.push(text); console.log('PASS', text); };
async function launch() {
  application = await _electron.launch({executablePath, args: packaged ? [] : [root],
    env: {...process.env, ISAAC_USER_DATA_DIR: dataDir}, timeout: 60000});
  page = await application.firstWindow({timeout: 60000});
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('blob:http://127.0.0.1:')) report.externalRequests.push(url);
  });
  await page.waitForFunction(() => window.isaacReport?.phase === 'idle' && !document.querySelector('#start').disabled, null, {timeout: 60000});
  assert.equal(await page.evaluate(() => typeof WebAssembly.Suspending), 'function');
  assert.equal(await page.evaluate(() => typeof WebAssembly.promising), 'function');
  assert.equal(await page.evaluate(() => window.isaacReport.storage.mode), 'disk');
  assert.deepEqual(await page.evaluate(() => window.isaacReport.installedMods), []);
  return page.url();
}
async function frames(count) {
  const before = await page.evaluate(() => window.isaacGame?.isaacState.frames || 0);
  await page.waitForFunction(target => window.isaacReport.phase === 'failed' || (window.isaacGame?.isaacState.frames || 0) >= target,
    before + count, {timeout: 180000});
  assert.equal(await page.evaluate(() => window.isaacReport.phase), 'running', await page.evaluate(() => window.isaacReport.error || ''));
}
async function key(code, settle = 60) { await page.keyboard.down(code); await frames(6); await page.keyboard.up(code); await frames(settle); }
async function nativeLog() {
  return page.evaluate(() => window.isaacGame.FS.readFile('/game/user/Documents/My Games/Binding of Isaac Repentance/log.txt', {encoding: 'utf8'}));
}
async function diskHashes() {
  const values = {};
  for (const name of ['persistentgamedata1.dat', 'gamestate1.dat']) {
    const bytes = await readFile(path.join(dataDir, 'userdata/saves', name));
    values[name] = {size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  }
  return values;
}
async function closeNormally() {
  const closed = application.waitForEvent('close', {timeout: 30000});
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  application = null;
}
try {
  report.firstURL = await launch();
  report.versions = await application.evaluate(() => process.versions);
  pass('Bundled Electron supports JSPI and opens its own disk-backed runtime with no installed Mods');
  await page.locator('[data-nav="settings"]:visible').first().click();
  await page.locator('#start-fullscreen').uncheck();
  await page.locator('#touch-enabled').uncheck();
  await page.locator('[data-nav="home"]:visible').first().click();
  await page.locator('#start').click();
  await frames(120);
  for (let i = 0; i < 4; i++) await key('Enter', 90);
  await frames(90);
  report.seed = [...(await nativeLog()).matchAll(/RNG Start Seed: [A-Z0-9 ]+ \((\d+)\) \[New,/g)].at(-1)?.[1];
  assert(report.seed, 'The native game must enter an actual run');
  const start = await page.evaluate(() => ({frames: window.isaacGame.isaacState.frames, time: performance.now()}));
  await frames(180);
  const end = await page.evaluate(() => ({frames: window.isaacGame.isaacState.frames, time: performance.now()}));
  report.shortSampleFPS = 1000 * (end.frames - start.frames) / (end.time - start.time);
  await page.screenshot({path: path.join(out, 'room.png')});
  pass('The real offline game enters and renders a playable room');
  await key('Escape'); await key('ArrowDown', 10); await key('Enter', 120);
  report.nativeSaves = await page.evaluate(async () => {
    const result = {};
    for (const name of ['persistentgamedata1.dat', 'gamestate1.dat']) {
      const bytes = window.isaacGame.FS.readFile('/game/user/Documents/My Games/Binding of Isaac Repentance/' + name);
      result[name] = {size: bytes.length, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')};
    }
    return result;
  });
  await closeNormally();
  assert.deepEqual(await diskHashes(), report.nativeSaves);
  pass('Closing the app flushes original native .dat bytes to its writable data directory');
  report.secondURL = await launch();
  await page.locator('#start').click(); await frames(120);
  for (let i = 0; i < 3; i++) await key('Enter', 90);
  await frames(60);
  report.continuedSeed = [...(await nativeLog()).matchAll(/RNG Start Seed: [A-Z0-9 ]+ \((\d+)\) \[Continue,/g)].at(-1)?.[1];
  assert.equal(report.continuedSeed, report.seed);
  pass('A fresh app process with a new loopback port continues the same native saved run');
  await closeNormally();
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.success = true;
} catch (error) {
  report.error = error.stack || String(error); console.error(error); process.exitCode = 1;
  try { report.state = await page.evaluate(() => window.isaacReport); await page.screenshot({path: path.join(out, 'failure.png')}); } catch {}
} finally {
  if (application) await application.close().catch(() => {});
  await writeFile(path.join(out, 'smoke.json'), JSON.stringify(report, null, 2) + '\n');
}
