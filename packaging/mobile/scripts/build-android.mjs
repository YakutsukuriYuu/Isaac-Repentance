import {spawnSync} from 'node:child_process';
import {mkdir, copyFile, access, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const run = (file, args, cwd = '.', attempts = 1, delaySeconds = 30) => {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(file, args, {cwd, stdio: 'inherit'});
    if (result.status === 0) return;
    const failure = `${file} failed (${result.status ?? result.error?.message})`;
    // The Gradle wrapper downloads its distribution from GitHub Releases on a
    // fresh CI job. Retry a gateway timeout instead of failing the installer.
    if (attempt >= attempts) throw new Error(failure);
    console.warn(`${failure}; retrying (${attempt}/${attempts - 1}) in ${delaySeconds}s`);
    spawnSync('sleep', [String(delaySeconds)]);
  }
};
run(process.execPath, ['scripts/prepare.mjs', 'android']);
const signed = !!process.env.ANDROID_KEYSTORE_PATH;
if (signed && ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'].some(name => !process.env[name])) throw new Error('Incomplete Android release signing environment');
if (process.env.REQUIRE_SIGNING === '1' && !signed) throw new Error('Release signing is required, but ANDROID_KEYSTORE_PATH is missing');
if (signed) await access(process.env.ANDROID_KEYSTORE_PATH);
const type = signed ? 'release' : 'debug';
const {version} = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error('Unsafe app version');
const suffix = signed ? 'android' : 'android-debug';
run(process.env.GRADLE_EXECUTABLE || (process.platform === 'win32' ? 'gradlew.bat' : './gradlew'), ['--no-daemon', signed ? 'assembleRelease' : 'assembleDebug'], 'android', 10);
await mkdir('output', {recursive: true});
await copyFile(`android/app/build/outputs/apk/${type}/app-${type}.apk`, `output/Isaac-Repentance-${version}-${suffix}.apk`);
console.log(signed ? 'Created release-signed APK.' : 'Created debug-signed test APK. Configure a persistent release keystore before distributing updates.');
