# macOS application

This Electron shell bundles the verified offline runtime. It starts its own Go
launcher on an ephemeral loopback port and opens an isolated Chromium window.
It does not require an installed browser or the development server on port 8274.
The pinned Electron 45 runtime requires macOS 13 or later.

## Build

The release staging script must first write `runtime/project` and the Go launcher
for the selected architecture to `runtime/isaac-launcher` (executable).

```sh
npm ci
npm test
node build.mjs --arch arm64
# Intel Mac:
node build.mjs --arch x64
# Application bundle only, for a smoke test:
node build.mjs --arch arm64 --dir
```

After `npm run setup`, `node test/smoke.mjs` runs actual gameplay in a disposable
data directory, checks native `.dat` bytes on normal close, and verifies Continue
after an app restart. Set `ISAAC_SMOKE_EXECUTABLE` to the packaged executable
inside `Isaac Repentance.app/Contents/MacOS` to test a built app. Reports and
screenshots are written to the ignored `.test-results` directory.

Output is under `dist`. The default build uses an ad-hoc signature; it is a test
distribution, not a Developer ID signed and notarized release. `--signed`
requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (a temporary `.p8` path),
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Keep those values in CI secrets.

## Local data

The application stores original `.dat` bytes, imported Mods and preferences in
`~/Library/Application Support/Isaac-Repentance/userdata`. Updates replace app
resources without replacing this directory. Each app uses a disk-store lock;
a second launch focuses the existing window. Startup uses a private ready-file
handshake and validates the matching storage identity before displaying the game.

`ISAAC_USER_DATA_DIR=/absolute/temporary/path npm start` runs an isolated test
instance. Never set this to another live player's data directory for testing.
Run `npm run setup` once before `npm start` to download the pinned Electron
runtime. Electron 45 does not download its executable during `npm ci`.
On normal close, the wrapper awaits `window.isaacHost.flushForExit()` and stops
the launcher only after those writes complete. A failed save leaves the window
open for recovery. This does not create a native run save that the game has not
written; use the game's Save & Quit to preserve a current run.

The application checks JSPI at runtime. Successful packaging does not establish
gameplay performance on every supported Mac architecture.
