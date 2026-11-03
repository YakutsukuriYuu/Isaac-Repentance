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

globalThis.IsaacNative = Object.freeze({
  isNative: true,
  platform: Capacitor.getPlatform(),
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
