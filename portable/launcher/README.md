# Portable project launcher

The standard-library Go launcher serves the project and writes player data beside
it. Delivered executables require neither Steam nor Python, Node or Go. A browser
supporting the game's WebAssembly JSPI and WebGL 2 remains necessary.

## Development layout

```text
Isaac-Repentance/
  Start-Game.command
  Start-Game.cmd
  project/
    project.json
    asset-manifest.json
    web/                 editable HTML, JavaScript and CSS
    core/                j835_game.mjs and j835_game.wasm
    assets/              private game executable and game resources
    launcher-binaries/   macOS and Windows launchers
  userdata/
    saves/               original .dat and options.ini bytes
    mod-data/            per-Mod game data
    mods/<id>/files/     player-imported Mod source files
    settings/            launcher and virtual-control settings
    .storage/            metadata, process lock and interrupted-write recovery
```

The executable locates `project.json` in its own directory or its parent.
`--root PATH` can explicitly select `project`. All runtime paths are relative to
that project. The development marker uses format `isaac-j835-development-v2`,
appId `isaac-j835-portable`, target `Repentance 1.7.9b.J835`, and a `core` list of
`{path,size,sha256}` records. The asset manifest contains
`{target,files:[{path,size,sha256,url}],mods:[]}`. No preinstalled Mods are allowed
in this development layout.

Web source changes become visible on browser refresh without rebuilding a
package or launcher. The core is checked against its hashes on startup;
`--verify` and `--check` additionally hash every game asset. `--check` exits
without creating user data or starting a listener. The former flat
`isaac-j835-portable-v1` package layout remains readable for older archives.

## Native storage contract

The server listens only on `127.0.0.1`. `GET /api/session` returns
`{storage:"disk",token,rootId,dataPath}`. All other API requests need the
`X-Isaac-Token` header. Cross-origin requests are rejected; no CORS access is
provided. Storage directories are never exposed through static HTTP routes.

- `GET /api/storage/{bucket}/{key}` returns
  `{revision,files:[{path,base64}],meta}`. An absent record returns an empty
  revision, empty files and null metadata.
- `PUT` to the same URL takes that snapshot and the revision last read. It
  returns `{revision}`. The revision covers current file bytes and metadata,
  so edits made outside the browser also produce a `409` conflict.
- `GET /api/mods` returns `[{key,revision,meta}]`.
- `DELETE /api/storage/mods/{id}` requires `X-Isaac-Revision` matching the record.

Buckets are `saves/main`, `settings/main`, and `mods/{workshop-or-local-id}`.
Base64 is used only for HTTP transport; files on disk contain the original bytes.
For saves, virtual `user/Documents/My Games/Binding of Isaac Repentance/` paths
map to `userdata/saves/`; virtual `data/` maps to `userdata/mod-data/`. Legacy game
versions from imported backups have separate subdirectories under `saves/legacy/`.
Settings permit `settings.json` and `touch-layout.json`. Metadata is a JSON
object up to 64 KiB.

Writes stage complete snapshots, sync file contents, then replace directories
with a recoverable transaction journal. An interrupted transaction rolls back
on the next launch. Repeated identical snapshots do not rewrite the files.
An operating-system file lock prevents two launchers from using the same user
data directory. Optimistic revisions prevent an outdated browser tab from
silently overwriting more recent data. Make manual file replacements with the
game closed, then reload the launcher.

Limits are 32 MiB / 2048 files for saves, 1 MiB / two files for settings, 256 MiB /
10000 files per Mod, and 512 MiB / 100 installed Mods. Paths, sizes, symlinks and
case collisions are checked. `os.Root` confines reads and writes to their
respective project and data roots.

## Startup and validation

- `--port 8274` chooses the loopback port. Saved data is independent of port and
  browser profile after migration.
- `--port 0` requests an available loopback port from the operating system.
- `--data-dir /absolute/path` puts all saves, Mods and settings in an explicit
  writable directory, independent of the packaged application and its updates.
- `--ready-file /absolute/path/ready.json` atomically creates a private startup
  notification after the listener and storage are ready. The destination must
  not already exist; its parent must exist and support hard links. Its fields
  are `url`, `rootId`, `packageId`, and `pid`. It contains no session token and
  is removed on graceful shutdown. Wrappers should create a private temporary
  directory, verify `/health.json` against this identity, then load `url`.
- `--no-open` starts the service without launching the browser.
- `--verify` verifies every core and asset hash before serving.
- `--check` performs verification and exits.

A busy port is reused only when app, target, package contents and canonical data
root match. A copied project never attaches to another copy's running service.
When `--ready-file` is specified, a busy port always fails: a wrapper must own
its child service. Unix SIGTERM and Ctrl+C gracefully drain active requests.
The launcher tries Chrome then Edge and prints the URL if neither opens.

An application wrapper can serve immutable resources inside its `.app` bundle
while retaining player files outside it:

```sh
isaac-launcher --root /Applications/Isaac-Repentance.app/Contents/Resources/project \
  --data-dir "$HOME/Library/Application Support/Isaac-Repentance/userdata" \
  --no-open --port 0 --ready-file /private/tmp/isaac-session/ready.json
```

The wrapper owns creation and cleanup of `/private/tmp/isaac-session`. Resource
validation and `--check` remain read-only and never create player data.

Build with Go 1.25+; this workspace pins its toolchain through
`scripts/with_go.py`. `go test -v ./...` exercises native save bytes, external edit
conflicts, Mod/settings persistence, interrupted-write recovery, process locks,
API authentication, path confinement, relocated Unicode paths, resource
integrity, live source edits, MIME types, HEAD/ranges and server identity.
Windows and macOS cross-compilation does not replace testing on those systems.
Real-game browser acceptance is performed separately.
