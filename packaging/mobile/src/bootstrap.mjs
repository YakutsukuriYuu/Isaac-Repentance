import {Capacitor} from '@capacitor/core';
import {Filesystem, Directory} from '@capacitor/filesystem';
import {App} from '@capacitor/app';
import {Share} from '@capacitor/share';
import {createNativeStorage} from './native_storage.mjs';
import {validateSavePath, bytesToBase64} from '../www/save_helpers.mjs';
import {validateModPath} from '../www/mod_helpers.mjs';

if (!Capacitor.isNativePlatform()) throw new Error('The mobile bundle must run in its native application.');
const fetchOriginal = globalThis.fetch.bind(globalThis);
let storage, failure;
try {
  // Android DATA is app-private and does not need legacy external-storage
  // permissions. iOS Documents also exposes the native files through Files.
  storage = await createNativeStorage({filesystem: Filesystem, directory: Capacitor.getPlatform() === 'ios' ? Directory.Documents : Directory.Data, validateSavePath, validateModPath});
} catch (error) { failure = error; }

// Install before app.mjs initializes. An unavailable native store returns an
// explicit error, never a 404 that could select browser-only persistence.
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    if (failure) return Promise.resolve(new Response(JSON.stringify({error: failure.message || String(failure)}), {status: 503, headers: {'Content-Type': 'application/json'}}));
    return storage.fetch(input, options);
  }
  return fetchOriginal(input, options);
};

function bytesFromBase64(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const folderPicks = new Map();
let folderPickId = 0;
globalThis.isaacModFolderResult = payload => {
  const pending = folderPicks.get(payload?.id);
  if (!pending) return;
  folderPicks.delete(payload.id);
  if (payload.cancelled) pending.resolve(null);
  else if (payload.error) pending.reject(new Error(payload.error));
  else pending.resolve(payload);
};
globalThis.IsaacNative = Object.freeze({
  isNative: true,
  platform: Capacitor.getPlatform(),
  async pickModFolder() {
    if (Capacitor.getPlatform() !== 'ios' || !globalThis.webkit?.messageHandlers?.isaacPickModFolder) {
      throw new Error('此系统不能直接选择文件夹，请把 Mod 打成 ZIP 再导入。');
    }
    const id = `mod-folder-${++folderPickId}`;
    const picked = await new Promise((resolve, reject) => {
      folderPicks.set(id, {resolve, reject});
      globalThis.webkit.messageHandlers.isaacPickModFolder.postMessage({id});
    });
    if (!picked) return null;
    const records = [];
    try {
      for (const path of picked.files || []) {
        const result = await Filesystem.readFile({path: `isaac-mod-import/${picked.token}/${path}`, directory: Directory.Cache});
        records.push({path, data: bytesFromBase64(result.data)});
      }
    } finally {
      await Filesystem.rmdir({path: `isaac-mod-import/${picked.token}`, directory: Directory.Cache, recursive: true}).catch(() => {});
    }
    return records;
  },
  async exportFile(data, filename, type) {
    if (typeof filename !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(filename)) throw new Error('导出文件名无效。');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const path = `isaac-exports/${filename}`;
    await Filesystem.writeFile({path, directory: Directory.Cache, data: bytesToBase64(bytes), recursive: true});
    const {uri} = await Filesystem.getUri({path, directory: Directory.Cache});
    await Share.share({title: filename, files: [uri], dialogTitle: '导出存档'});
  }
});

await App.addListener('appStateChange', ({isActive}) => {
  window.dispatchEvent(new CustomEvent('isaac:native-state', {detail: {isActive}}));
});
await App.addListener('backButton', () => {
  window.dispatchEvent(new CustomEvent('isaac:native-back'));
});
await import('./app.mjs');
