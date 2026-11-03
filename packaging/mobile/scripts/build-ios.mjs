import {spawnSync} from 'node:child_process';
import {mkdir, cp, access, readFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'darwin') throw new Error('iOS builds require macOS and full Xcode 27 or later');
const run = (file, args) => {
  const result = spawnSync(file, args, {stdio: 'inherit'});
  if (result.status !== 0) throw new Error(`${file} failed (${result.status ?? result.error?.message})`);
};
const exists = async file => { try { await access(file); return true; } catch { return false; } };
run(process.execPath, ['scripts/prepare.mjs', 'ios']);
const project = await exists('ios/App/App.xcworkspace/contents.xcworkspacedata') ? ['-workspace', 'ios/App/App.xcworkspace'] : ['-project', 'ios/App/App.xcodeproj'];
const common = [...project, '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS', 'IPHONEOS_DEPLOYMENT_TARGET=27.0'];
await mkdir('output', {recursive: true});
if (process.env.IOS_EXPORT_OPTIONS_PLIST) {
  if (!process.env.APPLE_TEAM_ID) throw new Error('APPLE_TEAM_ID is required for a signed iOS export');
  await access(process.env.IOS_EXPORT_OPTIONS_PLIST);
  const signing = [`DEVELOPMENT_TEAM=${process.env.APPLE_TEAM_ID}`];
  if (process.env.IOS_PROVISIONING_PROFILE_SPECIFIER) signing.push('CODE_SIGN_STYLE=Manual', `PROVISIONING_PROFILE_SPECIFIER=${process.env.IOS_PROVISIONING_PROFILE_SPECIFIER}`);
  if (process.env.IOS_CODE_SIGN_IDENTITY) signing.push(`CODE_SIGN_IDENTITY=${process.env.IOS_CODE_SIGN_IDENTITY}`);
  run('xcodebuild', [...common, '-archivePath', '.build/Isaac.xcarchive', ...signing, 'archive']);
  run('xcodebuild', ['-exportArchive', '-archivePath', '.build/Isaac.xcarchive', '-exportPath', 'output/ios-signed', '-exportOptionsPlist', process.env.IOS_EXPORT_OPTIONS_PLIST]);
  console.log('Created signed iOS export in output/ios-signed.');
} else {
  if (process.env.REQUIRE_SIGNING === '1') throw new Error('Signed iOS export requested, but IOS_EXPORT_OPTIONS_PLIST is missing');
  run('xcodebuild', [...common, '-derivedDataPath', '.build/ios', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'build']);
  const built = '.build/ios/Build/Products/Release-iphoneos/App.app';
  await access(`${built}/App`);
  const contents = await readFile(`${built}/public/asset-manifest.json`, 'utf8');
  if (!JSON.parse(contents).files?.length) throw new Error('The built iOS app has no game assets');
  await rm('.build/ipa', {recursive: true, force: true});
  await mkdir('.build/ipa/Payload', {recursive: true});
  await cp(built, '.build/ipa/Payload/App.app', {recursive: true});
  const output = path.resolve('output/Isaac-Repentance-ios-unsigned.ipa');
  await rm(output, {force: true});
  const result = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', 'Payload', output], {cwd: '.build/ipa', stdio: 'inherit'});
  if (result.status !== 0) throw new Error('Cannot package the device IPA');
  console.log('Created unsigned device IPA. Re-sign it with your sideloading method before installation; it is not a directly installable signed release.');
}
