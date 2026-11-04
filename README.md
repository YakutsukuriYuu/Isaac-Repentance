# Isaac Repentance

An offline application shell for the Repentance **1.7.9b.J835** WebAssembly runtime.
Project names and source documentation use English. The launcher interface uses Simplified Chinese.

This repository builds complete Android APK, iOS IPA, and macOS DMG installers. The
game resources and the authenticated, precompiled Wasm core are separate private
build inputs. They are downloaded and verified during a release build, then
embedded in the installer. Players do not need Steam, a local development server,
or a first-run game download. No player saves or preinstalled Mods are shipped.

The public repository does **not** contain the original game executable, game
archives, compiled game logic, personal saves, credentials, or signing keys. The
current release workflow packages a pinned, previously built Wasm core; it does
not regenerate that core from the original Windows executable. Core development
remains a separate build step, followed by an explicit private-input/lock update.

## Layout

```text
.github/workflows/          Source validation and complete-installer builds
Isaac-Repentance/project/
  web/                     Shared launcher, input, Mods, native DAT handling
  licenses/                Third-party notices
portable/launcher/         Embedded Go server for desktop applications
packaging/
  runtime.lock.json        Exact private archive and core checksums
  mobile/                  Capacitor Android/iOS shell and native storage bridge
  desktop/                 Electron application and DMG builder
  scripts/                 Private-input fetch, staging, signing and verification
  tests/                   Private-input and final-installer regression tests
```

Generated native projects, assets, dependencies, build products and runtime data
are ignored. Keep the original development workspace and its `userdata` separate
from this source export.

## Build on GitHub

Download complete installers from
[the latest Release](https://github.com/YakutsukuriYuu/Isaac-Repentance/releases/latest).
Release downloads do not require a GitHub login and do not expire after seven days.
See the [current release notes](packaging/RELEASE_NOTES.md) for the 0.1.1 mobile
performance changes and their validation scope.

See [GitHub setup](packaging/GITHUB_SETUP.md) for resource storage,
credentials, signing, and the first Actions run.

1. Store the private runtime archive outside this public source repository.
2. Set repository secret `ISAAC_RUNTIME_URL` and, for a private GitHub Release
   asset, `ISAAC_RUNTIME_TOKEN` with read access to that resource repository.
   Configure the persistent Android signing secrets described in the setup guide;
   automatic Releases require a release-signed APK.
3. Open **Actions → Build complete installers → Run workflow** and choose a target.
4. With target `all`, download the complete installers from **Releases** after all
   platforms succeed. Single-platform runs upload only Actions artifacts.
5. After the first successful build, set repository variable
   `ISAAC_BUILD_ON_PUSH=true` to build automatically on pushes to `main`.
   Successful full builds publish `build-<workflow run number>` Releases.
   Version tags matching `v*` also trigger builds and publish under that version tag.

Source tests run on pushes and pull requests without private inputs. Installer
builds never run for pull requests. Artifacts in this public repository are
publicly downloadable by users with the required GitHub access; their public
distribution is intentional. Raw input archives and signing material are not
uploaded as artifacts. The publisher uploads APK, IPA, ARM64/x64 DMGs and a SHA-256
checksum file to a draft, verifies the uploads, then makes the Release public.

## Installation and runtime requirements

| Platform | Runtime | Default build | Distribution signing |
| --- | --- | --- | --- |
| Android | System WebView with JSPI and WebGL 2 | Debug-signed test APK | Persistent Android keystore |
| iOS/iPadOS | iOS/iPadOS 27+ WKWebView | Unsigned **device** IPA for later re-signing | Apple certificate + device-appropriate profile |
| macOS | Bundled Electron; macOS 13+ | Ad hoc signed DMG, ARM64 or x64 | Developer ID + notarization |

An unsigned IPA cannot be installed directly. Re-sign it with the intended
sideloading method, or supply signing credentials to obtain a signed export.
Android's default test signing key is not stable across fresh CI runners; use a
persistent release key before distributing updates. An ad hoc Mac build is for
testing and may require an explicit Gatekeeper override on another Mac.

The game uses JSPI, WebGL 2, an initial 896 MiB Wasm memory, and substantial resource
memory. A successful build proves packaging, not sustained mobile gameplay.
Physical iPhone/iPad/Android memory, background recovery, audio and Mod behavior
must be tested. See [validation status](packaging/VALIDATION.md) for actual evidence.

## Saves and Mods

The original game creates ordinary Repentance `.dat` bytes. Application storage
persists those bytes automatically; import/export keeps them compatible with the
PC version. Steam Cloud synchronization is not implemented. The original game's
**Save & Quit** is needed to preserve a current run before ending a session.

Desktop saves live below the application's writable user-data directory, outside
the signed `.app`. Mobile saves use native Documents storage with atomic committed
generations of raw files. See [mobile storage](packaging/mobile/README.md). Native
export opens the system share/save dialog; no JSON conversion of `.dat` is used.

Mods are imported by the player. Lua Mod support depends on the port's implemented
game APIs. Native DLL and REPENTOGON extensions are not made compatible by packaging.

## Local builds

Install Node 24 and Python 3.11+. Desktop also needs Go 1.27.3; Android needs JDK 21
and the Android SDK; iOS needs macOS and Xcode 27. Dependencies are lockfile-pinned.

```sh
# Use environment secrets, never paste a token into this command or commit it.
python3 packaging/scripts/runtime_inputs.py fetch --output .release-build/input

# Mobile (run one platform's final command on its supported build host)
python3 packaging/scripts/runtime_inputs.py stage --project .release-build/input/project --target mobile --output packaging/mobile/www
cd packaging/mobile
npm ci
npm run build:android
# Or: npm run build:ios
```

For an existing marked stage, add `--replace`. Native generation runs inside the
build scripts; generated `android/` and `ios/` folders do not need to be committed.
See [desktop build instructions](packaging/desktop/README.md) for macOS.

## Updating private inputs

In the development workspace, explicitly select and validate the new core before
creating a new private archive:

```sh
python3 packaging/scripts/runtime_inputs.py pack --project Isaac-Repentance/project --output .release-inputs/isaac-j835-runtime-v2.tar.gz
```

This updates `packaging/runtime.lock.json`. Upload the new archive privately and
change the download secret together with the lock update. Every download, archive
member, game asset and core file is checked. A mismatch fails the build instead of
substituting another version or searching Steam.

## Source export

The development workspace can produce a reviewable upload folder:

```sh
python3 packaging/scripts/export_source.py --output dist/github-source
```

The export uses an explicit file allowlist and includes `source-export.json`.
Upload the exported directory, not the whole local development workspace. The
export is a snapshot; keep editing the canonical source files, then create a new
export when needed.
