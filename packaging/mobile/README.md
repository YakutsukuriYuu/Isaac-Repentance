# Isaac Repentance mobile applications

This application bundles the Chinese launcher, the pinned J835 WebAssembly
runtime and all game assets. It has no runtime dependency on the development
computer, a Steam installation or the private build-input download endpoint.
Players do not import game resources after installation. Mods remain optional
player imports; no player saves, imported Mods or settings are packaged.

## Build

Node 22 or newer is required. Versions of Capacitor, its plugins and esbuild are
locked in `package-lock.json`.

From the repository root, stage the verified private runtime input:

```sh
python3 packaging/scripts/runtime_inputs.py stage --project .release-build/input/project --target mobile --output packaging/mobile/www
cd packaging/mobile
npm ci
npm run build:android
# or, on a Mac with Xcode 27 or newer:
npm run build:ios
```

The source of `--project` can also be the maintained local
`Isaac-Repentance/project` directory. The staging step must run after web edits.
`npm run prepare:native -- android|ios` creates native projects from the pinned
Capacitor templates and applies the maintained configuration. The generated
`android`, `ios`, `www`, `.build` and `output` directories are excluded from Git.
Preparation is repeatable. `npm run prepare:native -- web` bundles only the native
bootstrap without creating a native project.

The app version comes from `package.json`. `BUILD_NUMBER`, or GitHub Actions'
`GITHUB_RUN_NUMBER`, supplies Android's version code and iOS's build number;
local builds default to 1.

Android needs JDK 21, Android SDK platform 36, and the build tools selected by
the pinned Gradle plugin. The default artifact is a debug-signed testing APK at
`output/Isaac-Repentance-android-debug.apk`. For consistent installable updates,
provide a persistent release keystore through these environment variables:

- `ANDROID_KEYSTORE_PATH`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release artifact is `output/Isaac-Repentance-android-release.apk`. Set
`REQUIRE_SIGNING=1` to reject an accidental unsigned/debug release. The Android
runtime uses System WebView; it must support WebAssembly JSPI and WebGL 2. The
launcher performs capability detection before starting a game.

The default iOS output is `output/Isaac-Repentance-ios-unsigned.ipa`, built for
physical devices. It must be re-signed with the chosen sideloading method before
installation. It is not a simulator application and is not presented as a
directly installable signed release. The minimum deployment target is iOS 27.

For a signed iOS export, install the intended signing material on the build
runner and provide `APPLE_TEAM_ID` plus `IOS_EXPORT_OPTIONS_PLIST`. Optionally
provide `IOS_PROVISIONING_PROFILE_SPECIFIER` and `IOS_CODE_SIGN_IDENTITY` for
manual signing. Xcode's exported files are written to `output/ios-signed`.
`REQUIRE_SIGNING=1` requires this signing path. Certificate/key material does not
belong in this repository.

## Native storage and lifecycle

`src/bootstrap.mjs` is loaded before the existing `app.mjs`. It supplies the
existing disk-storage HTTP protocol through a native Filesystem adapter, so the
launcher keeps its existing validation, Mod management and native DAT import
and export behavior. An unavailable native store is an error; the app does not
silently switch to browser IndexedDB.

Android stores `userdata` in the app-private data directory, without requesting
shared external-storage permissions. iOS stores it in the application's
Documents directory and enables Files access. Uninstalling the application can
remove this data; use the built-in DAT export to transfer it.

Each save is published as a complete generation under
`userdata/saves/main/g-<sequence>-<revision>/files/`. Its subpaths preserve the
original game paths, including
`user/Documents/My Games/Binding of Isaac Repentance/persistentgamedata1.dat`.
These are real binary DAT files. `commit.json` contains the file inventory,
checksums and revision; it does not contain encoded save contents. Settings and
Mods use the same transaction mechanism in their own directories.

The commit record is published only after all files finish writing. Interrupted
uncommitted generations are ignored; the next successful write removes them.
The newest two committed generations are retained, allowing recovery from the
previous complete version. Corruption in an already published generation is
reported instead of silently losing newer progress. Unchanged snapshots do not
create another generation. Stale revisions cannot overwrite newer data.

DAT export writes original bytes into the native cache and opens the system
share dialog, so normal Steam-compatible filenames can be saved or shared.
The application pause/resume and Android back-button events go through the
launcher's native lifecycle hooks. Touch controls default to enabled only when
there is no saved preference. Native games still determine when a new DAT save
is generated; background handling persists files that already exist.

## Verification scope

`npm test` exercises the real launcher storage client against a filesystem
adapter backed by temporary binary files: restart persistence, interrupted
writes, commit interruption, revision conflicts, Mod removal/reinstall, bounded
generation retention, path validation and corruption errors.

Native project generation and payload copying can be checked without a device.
A successful APK/IPA compilation does not establish sustained game performance,
memory headroom or lifecycle reliability on physical devices. The current core
starts with 896 MiB of Wasm memory and loads about 1.08 GB of resource files;
iPhone/iPad and Android WebView gameplay still require device testing.
