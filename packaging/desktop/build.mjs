import {build, Platform, Arch} from 'electron-builder';
import {access, readFile, open, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let arch = process.arch, directory = false, signed = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--arch') arch = args[++i];
  else if (args[i] === '--dir') directory = true;
  else if (args[i] === '--signed') signed = true;
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!['arm64', 'x64'].includes(arch)) throw new Error('Use --arch arm64 or --arch x64.');
if (process.platform !== 'darwin') throw new Error('Build the macOS application on a macOS runner.');
await access(path.join(root, 'runtime/isaac-launcher'), constants.X_OK);
const launcher = await open(path.join(root, 'runtime/isaac-launcher'));
try {
  const header = Buffer.alloc(8);
  await launcher.read(header, 0, header.length, 0);
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007)) {
    throw new Error(`The bundled launcher does not match macOS ${arch}; rebuild it for this architecture.`);
  }
} finally { await launcher.close(); }
const project = JSON.parse(await readFile(path.join(root, 'runtime/project/project.json'), 'utf8'));
if (project.format !== 'isaac-j835-development-v2' || project.preinstalledMods !== 0) throw new Error('Stage a clean verified runtime first.');
if (signed && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD)) throw new Error('Signed builds require CSC_LINK and CSC_KEY_PASSWORD.');
if (signed && !(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)) {
  throw new Error('Signed releases require APPLE_API_KEY (file path), APPLE_API_KEY_ID and APPLE_API_ISSUER for notarization.');
}
if (!signed) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
let electronDist;
if (arch === process.arch) {
  try {
    const installed = (await readFile(path.join(root, 'node_modules/electron/dist/version'), 'utf8')).trim().replace(/^v/, '');
    const expected = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).devDependencies.electron;
    if (installed === expected) electronDist = path.join(root, 'node_modules/electron/dist');
  } catch { /* electron-builder downloads the pinned distribution on clean CI. */ }
}
const builderOptions = {
  projectDir: root,
  targets: Platform.MAC.createTarget(directory ? 'dir' : 'dmg', arch === 'arm64' ? Arch.arm64 : Arch.x64),
  publish: 'never',
  config: {
    appId: 'org.isaacports.repentance', productName: 'Isaac Repentance',
    forceCodeSigning: signed,
    artifactName: 'Isaac-Repentance-${version}-${arch}.${ext}',
    directories: {output: 'dist'},
    ...(electronDist ? {electronDist} : {}),
    files: ['main.mjs', 'runtime-server.mjs', 'package.json'],
    extraResources: [{from: 'runtime/project', to: 'runtime/project'}, {from: 'runtime/isaac-launcher', to: 'runtime/isaac-launcher'}],
    asar: true,
    mac: {
      category: 'public.app-category.games', minimumSystemVersion: '13.0',
      identity: signed ? undefined : '-', hardenedRuntime: true,
      entitlements: path.join(root, signed ? 'entitlements.mac.plist' : 'entitlements.adhoc.plist'),
      entitlementsInherit: path.join(root, signed ? 'entitlements.mac.plist' : 'entitlements.adhoc.plist'),
      binaries: ['Contents/Resources/runtime/isaac-launcher'],
      notarize: signed,
    },
    dmg: {format: 'ULFO', writeUpdateInfo: false},
  },
};
// electron-builder downloads Electron and the DMG helper from GitHub Releases.
// Retry a gateway timeout there instead of failing the installer build.
for (let attempt = 1; ; attempt++) {
  try {
    await build(builderOptions);
    break;
  } catch (error) {
    if (attempt >= 6) throw error;
    console.warn(`${error.message}; retrying (${attempt}/5) in 30s`);
    // A failed download can leave a half-written artifact that makes the next
    // attempt fail differently; start from a clean output and DMG helper cache.
    await rm(path.join(root, 'dist'), {recursive: true, force: true});
    await rm(path.join(os.homedir(), 'Library/Caches/electron-builder/dmg-builder'), {recursive: true, force: true});
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}
