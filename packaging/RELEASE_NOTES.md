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
