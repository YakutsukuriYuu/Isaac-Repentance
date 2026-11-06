## 0.1.9 — Actually enable the game's controller

- 0.1.8 wrote the virtual sticks and a Bluetooth pad into an XInput state, but this port skipped controller startup and read only the keyboard. The sticks no longer wrote keys, so neither control did anything.
- The game now keeps its original XInput startup. DirectInput and the Windows device-notification thread are still skipped, because a web view has neither. Keyboard play is unchanged.
- Re-sign the unsigned IPA before installing.

## 0.1.8 — Drive the game's own controller from touch and gamepads

- The on-screen sticks now feed the game's XInput controller instead of keyboard keys. The left stick moves and the right stick shoots, including light pressure. Bomb, active item, card, drop, map, pause and confirm use the game's default controller bindings.
- A connected Bluetooth or MFi gamepad writes that same controller. The keyboard is unchanged. With virtual controls off and no gamepad connected, the game stays on keyboard only.
- This replaces the Wasm core. Re-sign the unsigned IPA before installing.

## 0.1.7 — Stop iOS waiting on each draw

- A normal room submits about 30 draws. On iOS, WebKit waits inside the vertex upload when that buffer still has a draw in flight, so the frame itself took about 27 ms (high 20s to mid 30s FPS). Each draw now gets fresh buffer storage; the previous draw keeps its old copy. The picture does not change, and the WebGL pixel probe still passes.
- The extra Metal frame used to request 60 Hz shared the GPU with the game and could stall the game thread. It is gone. The scene still asks for 60 Hz, and the game screen still does not bounce.
- This replaces the Wasm core. Low Power Mode and heat can still refuse 60 Hz. Re-sign the unsigned IPA before installing.

## 0.1.6 — Scroll the settings page and stop the iOS frame-rate jump

- The settings sheet is taller than a phone in landscape, and the iOS web view had scrolling turned off, so the last controls could not be reached by touch. The launcher is now the only scrollport, with space under the fixed status line. The game screen still does not scroll or bounce.
- The 0.1.5 timer woke `requestAnimationFrame` with `performance.now()` and cancelled the display callback. The game ignores a timestamp that arrives early and waits for another frame, so presents alternated between about 40 and 60 FPS. That timer is removed.
- An idle display link is easy for ProMotion to ignore, so the scene now presents a tiny transparent frame at a fixed 60 Hz. The Wasm core, Android refresh hint, and game speed are unchanged. Low Power Mode and heat can still refuse the request. Re-sign the unsigned IPA before installing.

## 0.1.5 — Keep the iOS game loop on a 60 Hz grid

- ProMotion can deliver `requestAnimationFrame` at a power-saving tier near 48 Hz. The game waits on that callback, so the loop cannot present faster than it, which shows up as about 45 FPS. Drawing work is not the cap: a desktop frame was already about 2.4 ms.
- On iOS the launcher now also wakes that wait with a 60 Hz timer. A faster display callback still wins, and `cancelAnimationFrame` cancels both. The native scene asks for a 60–120 Hz range with 60 preferred, instead of an exact 60 Hz hint iOS can ignore.
- This does not change the Wasm core, Android refresh hint, or game speed. Low Power Mode and thermal limits can still refuse the display request. Re-sign the unsigned IPA before installing.

## 0.1.4 — Lift the iOS ProMotion frame-rate cap

- iOS builds were capped near 45 FPS on ProMotion devices. iOS 15+ throttles
  web-content `requestAnimationFrame` in WKWebView to a power-saving refresh
  tier (observed near 45 Hz), so the game could not present at 60 FPS no matter
  how the browser pacing scheduled frames. The browser pacing loop in
  `web_loop.c` was separately verified robust under jitter and variable refresh
  and is unchanged.
- The iOS packaging now sets `CADisableMinimumFrameDurationOnPhone` in
  Info.plist, which lifts that default cap so the WebView is supplied frames at
  the device refresh rate, and anchors the scene to a steady 60 Hz preference
  through an idle `CADisplayLink` (`CAFrameRateRange` min/max/preferred = 60).
  This is the iOS counterpart to the existing Android `preferredRefreshRate`
  hint; both are display preferences, so thermal and battery policy still win.
- Packaging-only change. The pinned Wasm core, game resources, saves and the
  Android/macOS builds are unchanged. This removes a software frame-rate cap;
  sustained on-device FPS still depends on the device and scene and has not been
  benchmarked on a physical iPhone in this release.

## 0.1.3 — Remove per-frame GPU waits from WebGL queries

- The game asks for renderbuffer parameters and framebuffer completeness every
  frame. In Chrome and Android WebView each answer waits for the GPU process to
  finish all queued work, so the CPU and GPU could not overlap. The Wasm core
  now replays answers the browser already returned for the same objects.
- Framebuffer completeness is replayed only for an identical attachment set
  whose images are unchanged. Texture uploads, renderbuffer storage, attachment
  changes and deletions force a real query. Only COMPLETE results are replayed.
- Strict GL diagnostics (`?glchecks=strict`) disable the cache.

Mac Chrome measurements (real starting room, movement and shooting):

| Measurement | 0.1.2 | 0.1.3 |
| --- | ---: | ---: |
| Synchronous query share of main-thread CPU (4x CPU throttle) | 47% | 0.2% |
| Busy time per frame, unthrottled | 10.2 ms | 2.4 ms |
| Queries answered by the browser per 900 frames | all (~22,000) | 32 |

Throttled FPS varied between runs by more than the difference between builds,
so no FPS gain is claimed from them. These are desktop measurements, not phone
measurements; no Android or iOS device benchmark was run. Game speed, frame
pacing, saves and resources are unchanged.

## 0.1.2 — Reduce guest dispatch overhead

- Enable the existing translated-function lookup cache and dense import-slot
  lookup in the Wasm core. Repeated targets use exact-key cache hits; collisions,
  changed registrations and unknown targets retain the original fallback.
- Enable indexed GL token dispatch instead of scanning the 73-entry registry
  for every typed graphics call. Keep stack, argument and memory validation.
  This path relies on the current single-CPU, single-thread Wasm runtime.
- Cache the alpha-test uniform values already submitted to each shader program.
  Relinking, deletion and direct guest writes invalidate the corresponding cache.

This is a follow-up to a user report of 43.1 average FPS and substantial slow
frames on Android. These changes remove confirmed redundant work; that report
alone does not identify the dominant bottleneck or establish a regression from
0.1.1. No device benchmark was run, and no measured FPS gain or stable 60 FPS is
claimed. Compilation and installer integrity checks are separate from gameplay
performance. Frame counting, game speed and the previous buffering policy remain
unchanged.

## 0.1.1 — Mobile performance update

- Reuse three frames of GPU streaming buffers. Reserve a complete draw before
  uploading attributes; share compatible interleaved vertex uploads and cache
  shader adapter uniform locations, including relink/delete invalidation.
- Use a production Wasm profile with optional GL diagnostics instead of per-frame
  synchronous GL error queries. Preserve guest memory, pointer and stack guards.
- Release the WebGL drawing buffer after presentation; keep explicit diagnostic
  and buffer-preservation overrides available to core developers.
- Skip unchanged automatic saves before scanning or encoding files. Preserve
  raw DAT files, retry failed commits, and force a fresh snapshot on background,
  export and exit. Writable memory maps retain conservative full-save behavior.
- Remove gameplay backdrop blur and coalesce virtual-stick visual updates while
  applying input immediately. Clear held controls on display/layout changes.
- Request a 60 FPS display cadence on Android with OS-version guards and
  same-resolution fallback modes. System power, thermal and user policies apply.
- Avoid sorting Low-FPS samples in the simple overlay and avoid redundant DOM
  updates. Detailed statistics continue to include slow frames.

This update was prepared by code analysis and compilation, without a new device
benchmark campaign. It does not claim a measured FPS gain or universal 60 FPS.
JSPI and WebGL 2 are still required; the original fixed guest-memory layout and
resource-loading architecture are unchanged.
