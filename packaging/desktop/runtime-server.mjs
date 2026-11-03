import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {readFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export function validateReady(value) {
  if (!value || typeof value.url !== 'string' || typeof value.rootId !== 'string' || !value.rootId ||
      typeof value.packageId !== 'string' || !value.packageId || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error('本地游戏服务返回的信息无效。');
  }
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
      url.username || url.password || url.search || url.hash) throw new Error('本地游戏服务地址无效。');
  return {...value, url: url.href};
}

export function isGameURL(candidate, origin) {
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

export async function startRuntime({runtimeDir, dataDir, logsDir, timeoutMs = 45000, onUnexpectedExit = () => {}}) {
  await mkdir(dataDir, {recursive: true, mode: 0o700});
  await mkdir(logsDir, {recursive: true, mode: 0o700});
  const readyDir = await mkdtemp(path.join(dataDir, '.startup-'));
  const readyPath = path.join(readyDir, 'ready.json');
  const log = createWriteStream(path.join(logsDir, 'launcher.log'), {flags: 'a', mode: 0o600});
  log.on('error', () => {}); // A log error must not replace the original startup failure.
  const child = spawn(path.join(runtimeDir, 'isaac-launcher'), [
    '--root', path.join(runtimeDir, 'project'), '--data-dir', dataDir,
    '--no-open', '--port', '0', '--ready-file', readyPath,
  ], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  child.stdout.pipe(log, {end: false});
  child.stderr.pipe(log, {end: false});
  let exited = false, failure, stopping = false, ready = false, stopPromise;
  const ended = new Promise(resolve => {
    child.once('error', error => { failure = error; exited = true; resolve(); });
    child.once('exit', (code, signal) => {
      exited = true;
      failure ||= new Error(`本地游戏服务已退出（${signal || code}）。`);
      resolve();
      if (ready && !stopping) onUnexpectedExit(failure);
    });
  });
  const stop = () => stopPromise ||= (async () => {
    stopping = true;
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([ended, delay(4000, undefined, {ref: false})]);
      if (!exited) { child.kill('SIGKILL'); await ended; }
    }
    log.end();
    await rm(readyDir, {recursive: true, force: true});
  })();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw failure;
      let record;
      try { record = JSON.parse(await readFile(readyPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (record) {
        const info = validateReady(record);
        if (info.pid !== child.pid) throw new Error('本地游戏服务的进程信息不一致。');
        const response = await fetch(new URL('health.json', info.url), {redirect: 'error', signal: AbortSignal.timeout(5000)});
        if (!response.ok) throw new Error(`本地游戏服务检查失败：${response.status}`);
        const health = await response.json();
        if (health.rootId !== info.rootId || health.packageId !== info.packageId || health.storage !== 'disk') {
          throw new Error('本地游戏服务或存档目录不一致。');
        }
        ready = true;
        return {...info, child, stop};
      }
      await delay(50);
    }
    throw new Error('本地游戏服务启动超时，请查看 launcher.log。');
  } catch (error) { await stop(); throw error; }
}
