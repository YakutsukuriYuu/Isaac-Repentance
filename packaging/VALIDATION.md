# Packaging validation

This file distinguishes source preparation, package compilation, and real gameplay.
The current game target is Repentance 1.7.9b.J835. No mobile performance claim is
implied by generating a native project or an installer.

## Automated checks

- Private-input packing/extraction: exact hashes, complete inventory, no user data,
  no links or path traversal, safe HTTPS redirects, failure-preserving stage replacement.
- Portable Go launcher: external writable native saves, read-only resource folder,
  random loopback port, atomic ready notification, process lock and clean shutdown.
- Native mobile storage: raw DAT bytes, restart persistence, revision conflicts,
  interrupted writes, committed generations, Mod install/remove and retention.
- Desktop shell: child process lifecycle, ready notifications, navigation isolation,
  save flush before closing and startup failures.
- Final APK/IPA: bundled bootstrap, core and all game resources verified against
  pinned metadata. This is not a native-device gameplay test.

## Platform status

GitHub acceptance on 2026-11-03: [complete installer run 41649039937](https://github.com/YakutsukuriYuu/Isaac-Repentance/actions/runs/41649039937)
completed successfully for Android, iOS, macOS ARM64 and macOS Intel x64.

- Android: actual APK compilation, complete payload validation and artifact upload passed.
- iOS: Xcode **27.1** produced an unsigned device IPA; all 35 game/core files were
  verified inside it before upload.
- Both macOS architectures: DMG compilation, read-only mounting, resource/core
  checksums, strict code-signature checks, embedded launcher verification and upload passed.
- [Source validation run 41648096762](https://github.com/YakutsukuriYuu/Isaac-Repentance/actions/runs/41648096762)
  passed on the independent Linux runner.

Local acceptance on 2026-11-03:

- A freshly exported source checkout passed all nine source-validation groups
  without game inputs, local toolchains, node_modules or private Mod fixtures.
- The complete ARM64 DMG was built (1,213,406,290 bytes). Its actual packaged app
  ran the offline game, entered a room, saved through the original game, flushed
  byte-identical `.dat` files on close, and continued seed `326312118` after a new
  application process and a new loopback port. No JavaScript errors or external
  game requests were observed.
- The ARM64 app passed `codesign --verify --deep --strict`; the DMG passed
  `hdiutil verify`. The bundle contains no player data or preinstalled Mods.
- Android and iOS native projects were generated and synchronized with the full
  runtime. Repeated generation was checked; iOS project/plist syntax was checked.
- The complete debug-signed Android APK was built (1,088,342,420 bytes), checked
  with `apksigner verify --verbose` (v2 signature), and passed verification of all
  35 game/core files in the actual APK. Its package ID is
  `io.github.yakutsukuriyuu.isaacrepentance`, minSDK 24, targetSDK 36. Runtime
  capability checks still require a JSPI/WebGL 2 capable System WebView.
- Intel Mac gameplay, distribution signing/notarization, and physical mobile
  gameplay have not been validated by these local checks.

Detailed local acceptance results are generated under ignored report directories.
The desktop real-game smoke test is `packaging/desktop/test/smoke.mjs`.
The iOS binary build requires Xcode 27; the development Mac has only Command Line
Tools, so device-IPA compilation was performed on GitHub. The private-resource
download secret has been configured and verified by the complete build above.

Physical iPhone 17/iPad mini 7 and Android gameplay, peak memory, long sessions,
audio recovery and background persistence remain device acceptance tasks.
