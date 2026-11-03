import {app, BrowserWindow, dialog, Menu, session} from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startRuntime, isGameURL} from './runtime-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Keep save locations stable across app releases and architecture changes.
const override = process.env.ISAAC_USER_DATA_DIR;
if (override && !path.isAbsolute(override)) throw new Error('ISAAC_USER_DATA_DIR must be absolute.');
app.setPath('userData', override || path.join(app.getPath('appData'), 'Isaac-Repentance'));
app.setName('Isaac Repentance');

let window, runtime, runtimePromise, quitting = false, closing = false;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (!quitting) { event.preventDefault(); void closeApplication(); }
  });
  app.on('window-all-closed', () => { if (!quitting) void closeApplication(); });
  process.on('SIGTERM', () => void closeApplication());
  process.on('SIGINT', () => void closeApplication());
  app.whenReady().then(launch).catch(async error => {
    dialog.showErrorBox('无法启动游戏', `${error.message}\n\n日志位置：${path.join(app.getPath('userData'), 'logs')}`);
    quitting = true; await runtime?.stop(); app.exit(1);
  });
}

async function closeApplication() {
  if (closing || quitting) return;
  closing = true;
  try {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      await window.webContents.executeJavaScript(`(async () => {
        if (window.isaacHost?.flushForExit) await window.isaacHost.flushForExit();
        else if (window.isaacReport?.phase === 'running') throw new Error('存档接口尚未就绪，请先在游戏菜单中结束游戏。');
      })()`);
    }
    quitting = true;
    if (!runtime && runtimePromise) runtime = await runtimePromise.catch(() => null);
    await runtime?.stop();
    if (window && !window.isDestroyed()) window.destroy();
    app.quit();
  } catch (error) {
    closing = false;
    dialog.showErrorBox('存档尚未保存', `窗口已保留，请先导出存档后再退出。\n\n${error.message}`);
  }
}

async function launch() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: 'Isaac Repentance', submenu: [{label: '退出游戏', accelerator: 'CommandOrControl+Q', click: () => void closeApplication()}]},
    {label: '编辑', submenu: [{role: 'undo', label: '撤销'}, {role: 'redo', label: '重做'}, {type: 'separator'},
      {role: 'cut', label: '剪切'}, {role: 'copy', label: '复制'}, {role: 'paste', label: '粘贴'}, {role: 'selectAll', label: '全选'}]},
    {label: '窗口', submenu: [{role: 'togglefullscreen', label: '全屏'}, {role: 'minimize', label: '最小化'}]},
  ]));
  runtimePromise = startRuntime({
    runtimeDir: app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(here, 'runtime'),
    dataDir: path.join(app.getPath('userData'), 'userdata'), logsDir: path.join(app.getPath('userData'), 'logs'),
    onUnexpectedExit: error => {
      if (quitting) return;
      dialog.showErrorBox('本地服务已停止', `请保留当前窗口并导出存档。\n\n${error.message}`);
    },
  });
  runtime = await runtimePromise;
  if (quitting) return;
  const origin = new URL(runtime.url).origin;
  // No remote content or Node APIs are exposed to the game renderer.
  const partition = 'persist:isaac-game';
  const browserSession = session.fromPartition(partition);
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
  browserSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isGameURL(details.url, origin) || details.url.startsWith('blob:' + origin + '/') || details.url === 'about:blank';
    callback({cancel: !allowed});
  });
  browserSession.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename());
    item.setSaveDialogOptions({title: '导出文件', defaultPath: path.join(app.getPath('downloads'), filename)});
  });
  window = new BrowserWindow({
    title: 'Isaac Repentance', width: 1280, height: 800, minWidth: 640, minHeight: 360,
    backgroundColor: '#191713', show: false, fullscreenable: true,
    webPreferences: {partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: true},
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); void closeApplication(); } });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => { if (!isGameURL(url, origin)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!isGameURL(url, origin)) event.preventDefault(); });
  await window.loadURL(runtime.url);
  window.show();
  const supported = await window.webContents.executeJavaScript(`typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'`);
  if (!supported) throw new Error('此应用内核缺少 WebAssembly JSPI，无法运行当前游戏核心。');
}
