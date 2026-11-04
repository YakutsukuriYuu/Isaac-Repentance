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
