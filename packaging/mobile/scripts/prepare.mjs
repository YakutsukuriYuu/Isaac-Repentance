import {build} from 'esbuild';
import {readFile, writeFile, access, copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const platform = process.argv[2];
if (!['android', 'ios', 'web'].includes(platform)) throw new Error('Usage: npm run prepare:native -- android|ios|web');
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const buildNumber = Number(process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 1);
if (!/^\d+\.\d+\.\d+$/.test(packageVersion) || !Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2100000000) throw new Error('Invalid application version or build number');
const run = (...args) => {
  const result = spawnSync(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', ...args], {stdio: 'inherit', env: {...process.env, CI: '1'}});
  if (result.status !== 0) throw new Error(`Capacitor ${args.join(' ')} failed`);
};
const exists = async file => { try { await access(file); return true; } catch { return false; } };
for (const name of ['index.html', 'app.mjs', 'asset-manifest.json', 'j835_game.mjs', 'j835_game.wasm']) {
  if (!await exists(`www/${name}`)) throw new Error(`Missing staged game file: www/${name}. Run the release staging command first.`);
}
await build({entryPoints: ['src/bootstrap.mjs'], outfile: 'www/native-bootstrap.mjs', bundle: true, format: 'esm', target: ['chrome137', 'safari27'], external: ['./app.mjs'], legalComments: 'eof', sourcemap: false});
let html = await readFile('www/index.html', 'utf8');
if (!html.includes('src="./app.mjs"') && !html.includes('src="./native-bootstrap.mjs"')) throw new Error('Cannot locate the launcher entry script');
html = html.replace('src="./app.mjs"', 'src="./native-bootstrap.mjs"');
await writeFile('www/index.html', html);
if (platform === 'web') process.exit(0);
if (!await exists(platform)) run('add', platform);
run('sync', platform);
if (platform === 'android') {
  const manifest = 'android/app/src/main/AndroidManifest.xml';
  let xml = await readFile(manifest, 'utf8');
  if (!xml.includes('android:largeHeap=')) xml = xml.replace('<application\n', '<application\n        android:largeHeap="true"\n');
  if (!xml.includes('android:screenOrientation=')) xml = xml.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:screenOrientation="sensorLandscape"');
  // Existing HTML file pickers use the platform document picker. Private app
  // data stays in Documents; shared exports use the plugin's cache provider.
  await writeFile(manifest, xml);
  const config = JSON.parse(await readFile('capacitor.config.json', 'utf8'));
  const activity = `android/app/src/main/java/${config.appId.replaceAll('.', '/')}/MainActivity.java`;
  await writeFile(activity, `package ${config.appId};\n\nimport android.os.Bundle;\nimport androidx.core.view.WindowCompat;\nimport androidx.core.view.WindowInsetsCompat;\nimport androidx.core.view.WindowInsetsControllerCompat;\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {\n    private void hideSystemBars() {\n        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());\n        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);\n        controller.hide(WindowInsetsCompat.Type.systemBars());\n    }\n    @Override public void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        hideSystemBars();\n    }\n    @Override public void onWindowFocusChanged(boolean hasFocus) {\n        super.onWindowFocusChanged(hasFocus);\n        if (hasFocus) hideSystemBars();\n    }\n}\n`);
  const gradle = 'android/app/build.gradle';
  let text = await readFile(gradle, 'utf8');
  text = text.replace(/versionCode \d+/, `versionCode ${buildNumber}`).replace(/versionName "[^"]+"/, `versionName "${packageVersion}"`);
  const signing = `\n// Release signing is supplied only through the CI environment.\nandroid {\n    signingConfigs {\n        release {\n            if (System.getenv('ANDROID_KEYSTORE_PATH')) {\n                storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))\n                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')\n                keyAlias System.getenv('ANDROID_KEY_ALIAS')\n                keyPassword System.getenv('ANDROID_KEY_PASSWORD')\n            }\n        }\n    }\n    buildTypes { release {\n        if (System.getenv('ANDROID_KEYSTORE_PATH')) signingConfig signingConfigs.release\n    } }\n}\n`;
  if (!text.includes('// Release signing is supplied only')) text += signing;
  await writeFile(gradle, text);
  const properties = 'android/gradle.properties';
  await writeFile(properties, (await readFile(properties, 'utf8')).replace(/^org\.gradle\.jvmargs=.*$/m, 'org.gradle.jvmargs=-Xmx4096m'));
  const wrapper = 'android/gradle/wrapper/gradle-wrapper.properties';
  let wrapperText = await readFile(wrapper, 'utf8');
  if (!wrapperText.includes('gradle-8.14.3-')) throw new Error('Review the pinned Gradle version and checksum before updating Capacitor');
  wrapperText = wrapperText.replace('gradle-8.14.3-all.zip', 'gradle-8.14.3-bin.zip').replace(/^distributionSha256Sum=.*\n?/m, '');
  await writeFile(wrapper, wrapperText.trimEnd() + '\ndistributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531\n');
} else {
  const plist = 'ios/App/App/Info.plist';
  const result = spawnSync('python3', ['-c', `import plistlib\np=${JSON.stringify(plist)}\nwith open(p,'rb') as f: d=plistlib.load(f)\nd['UISupportedInterfaceOrientations']=['UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight']\nd['UISupportedInterfaceOrientations~ipad']=d['UISupportedInterfaceOrientations']\nd['UIFileSharingEnabled']=True\nd['LSSupportsOpeningDocumentsInPlace']=True\nd['UIStatusBarHidden']=True\nd['UIRequiredDeviceCapabilities']=['arm64']\nd['UIViewControllerBasedStatusBarAppearance']=False\nwith open(p,'wb') as f: plistlib.dump(d,f)\n`], {stdio: 'inherit'});
  if (result.status !== 0) throw new Error('Cannot configure native iOS Info.plist');
  const project = 'ios/App/App.xcodeproj/project.pbxproj';
  let text = await readFile(project, 'utf8');
  text = text.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, 'IPHONEOS_DEPLOYMENT_TARGET = 27.0;');
  text = text.replace(/CURRENT_PROJECT_VERSION = [0-9.]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`).replace(/MARKETING_VERSION = [0-9.]+;/g, `MARKETING_VERSION = ${packageVersion};`);
  if (!text.includes('/* PrivacyInfo.xcprivacy in Resources */')) {
    const reference = '49534141435052495641435931', buildFile = '49534141435052495641435932';
    text = text.replace('/* Begin PBXBuildFile section */', `/* Begin PBXBuildFile section */\n\t\t${buildFile} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${reference} /* PrivacyInfo.xcprivacy */; };`);
    text = text.replace('/* Begin PBXFileReference section */', `/* Begin PBXFileReference section */\n\t\t${reference} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; name = PrivacyInfo.xcprivacy; path = App/PrivacyInfo.xcprivacy; sourceTree = SOURCE_ROOT; };`);
    const before = text;
    text = text.replace(/(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/, `$1\n\t\t\t\t${buildFile} /* PrivacyInfo.xcprivacy in Resources */,`);
    if (text === before) throw new Error('Cannot attach the iOS privacy manifest to app resources');
  }
  await writeFile(project, text);
  await copyFile('PrivacyInfo.xcprivacy', 'ios/App/App/PrivacyInfo.xcprivacy');
  // Capacitor derives this platform from the Xcode deployment target on later
  // syncs, but emits .v27 with a 5.9 tools manifest. The enum requires 6.4;
  // the string initializer supports the same target with the pinned template.
  const swiftPackage = 'ios/App/CapApp-SPM/Package.swift';
  if (await exists(swiftPackage)) {
    const manifest = await readFile(swiftPackage, 'utf8');
    if (!/platforms: \[\.iOS\(/.test(manifest)) throw new Error('Review the generated Swift Package deployment target');
    await writeFile(swiftPackage, manifest.replace(/platforms: \[[^\n]+\],/, 'platforms: [.iOS("27.0")],'));
  }
}
console.log(`Prepared ${platform}: bundled game resources, native DAT storage and Chinese launcher.`);
