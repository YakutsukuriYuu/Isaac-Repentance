/**
 * Serve packed game assets from the app bundle instead of keeping them resident.
 *
 * All 33 archives used to be copied into the Emscripten filesystem, which cost
 * roughly 1 GB and pushed the iOS web process past its per-process memory
 * limit. Here each archive becomes a MEMFS node whose contents object is lazy:
 * MEMFS streams it byte by byte through `get(i)`, so Emscripten keeps doing the
 * heap writes while this module fetches only the block the game asks for.
 */
export function installLazyPack(FS, dir, files, options = {}) {
  const blockSize = options.blockSize || 1024 * 1024;
  const maxBytes = options.maxBytes || 24 * 1024 * 1024;
  const cache = new Map();
  let cachedBytes = 0;
  const stats = { blocks: 0, bytes: 0, touched: [] };
  globalThis.__lazyStats = stats;

  function readBlock(file, index) {
    const key = `${file.name}#${index}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    stats.blocks += 1;
    if (stats.touched.length < 24) stats.touched.push(`${file.name}@${index * blockSize}`);
    const start = index * blockSize;
    const end = Math.min(start + blockSize, file.size) - 1;
    const expected = end - start + 1;
    let text = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = new XMLHttpRequest();
      request.open('GET', file.url, false);
      request.setRequestHeader('Range', `bytes=${start}-${end}`);
      // Text with a byte-preserving charset works with synchronous requests;
      // a binary response type does not outside a web worker.
      request.overrideMimeType('text/plain; charset=x-user-defined');
      request.send(null);
      if (request.status !== 206 && request.status !== 200) {
        throw new Error(`资源读取失败 ${request.status}：${file.name}`);
      }
      text = request.responseText;
      // A truncated reply would silently shift every later byte in the file.
      if (text.length === expected) break;
      if (attempt === 2) throw new Error(`资源读取长度不符 ${text.length}/${expected}：${file.name}`);
    }
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
    cache.set(key, bytes);
    cachedBytes += bytes.length;
    stats.bytes += bytes.length;
    while (cachedBytes > maxBytes && cache.size > 1) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).length;
      cache.delete(oldest);
    }
    return bytes;
  }

  function readRange(file, start, end) {
    const from = Math.max(0, start);
    const to = Math.min(end, file.size);
    if (stats.touched.length < 30) stats.touched.push(`${file.name} ${from}+${Math.max(0, to - from)}`);
    if (to <= from) return new Uint8Array(0);
    // Fast path: a read inside one block is served as a view, with no copy.
    const firstIndex = Math.floor(from / blockSize);
    const first = readBlock(file, firstIndex);
    const within = from - firstIndex * blockSize;
    if (within + (to - from) <= first.length) return first.subarray(within, within + (to - from));
    const out = new Uint8Array(to - from);
    out.set(first.subarray(within), 0);
    let at = from + (first.length - within);
    let written = first.length - within;
    while (at < to) {
      const blockIndex = Math.floor(at / blockSize);
      const block = readBlock(file, blockIndex);
      const offset = at - blockIndex * blockSize;
      const take = Math.min(to - at, block.length - offset);
      if (take <= 0) break;
      out.set(block.subarray(offset, offset + take), written);
      at += take;
      written += take;
    }
    return out;
  }

  function lazyContents(file) {
    // This Emscripten build streams MEMFS reads with `contents.subarray(...)`,
    // so the object has to expose that instead of a plain typed array.
    return {
      length: file.size,
      subarray(start, end) {
        return readRange(file, start, end);
      },
      get(index) {
        const blockIndex = Math.floor(index / blockSize);
        const block = readBlock(file, blockIndex);
        return block[index - blockIndex * blockSize];
      },
    };
  }

  FS.mkdirTree(dir);
  for (const file of files) {
    const path = `${dir}/${file.name}`;
    // Create through the documented API, then swap in the lazy contents object.
    FS.createDataFile(dir, file.name, new Uint8Array(0), true, false, true);
    const node = FS.lookupPath(path).node;
    node.contents = lazyContents(file);
    node.usedBytes = file.size;
  }
  return { size: files.reduce((total, file) => total + file.size, 0), cacheBytes: () => cachedBytes };
}
