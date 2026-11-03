/** Native storage transport for the existing disk_storage.mjs protocol.
 * File payloads are native binary files. JSON manifests contain only metadata.
 * A generation becomes visible only after its commit record is published.
 */
const encoder = new TextEncoder();
const MOD_ID = /^(?:[1-9]\d{0,19}|local-[0-9a-f]{24})$/;
const GENERATION = /^g-(\d{1,15})-([0-9a-f-]{36})$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({revision: '', files: [], meta: null});
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const fail = (message, status = 500) => Object.assign(new Error(message), {status});
function serial() { let tail = Promise.resolve(); return operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; }; }
function decode(base64) {
  if (typeof base64 !== 'string' || base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) throw fail('Invalid native file encoding', 400);
  let binary; try { binary = atob(base64); } catch { throw fail('Invalid native file encoding', 400); }
  if (btoa(binary) !== base64) throw fail('Noncanonical native file encoding', 400);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function missing(error) {
  return ['ENOENT', 'OS-PLUG-FILE-0008'].includes(error?.code) || /(?:does not exist|not exist|no such file|not found)/i.test(error?.message || '');
}

export async function createNativeStorage({filesystem, directory = 'DOCUMENTS', validateSavePath, validateModPath}) {
  const fs = filesystem, queue = serial(), root = 'userdata', token = crypto.randomUUID();
  const native = path => ({path, directory});
  const mkdir = path => fs.mkdir({...native(path), recursive: true}).catch(error => { if (!/exist/i.test(error.message || '')) throw error; });
  const readJSON = async path => JSON.parse((await fs.readFile({...native(path), encoding: 'utf8'})).data);
  const writeJSON = (path, value) => fs.writeFile({...native(path), encoding: 'utf8', data: JSON.stringify(value), recursive: true});
  const remove = path => fs.rmdir({...native(path), recursive: true});
  await mkdir(root);
  let installation;
  try { installation = await readJSON(`${root}/installation.json`); }
  catch (error) {
    if (!missing(error)) throw error;
    installation = {version: 1, id: crypto.randomUUID()};
    await writeJSON(`${root}/installation.pending`, installation);
    await fs.rename({from: `${root}/installation.pending`, to: `${root}/installation.json`, directory, toDirectory: directory});
  }
  if (installation?.version !== 1 || !/^[0-9a-f-]{36}$/.test(installation.id)) throw fail('Native installation identity is damaged');
  const rootUri = (await fs.getUri(native(root))).uri;
  const session = {storage: 'disk', token, rootId: installation.id, dataPath: rootUri, native: true};

  function recordPath(bucket, key) {
    if (!['saves', 'settings', 'mods'].includes(bucket) || (bucket === 'mods' ? !MOD_ID.test(key) : key !== 'main')) throw fail('Invalid native storage key', 400);
    return `${root}/${bucket}/${key}`;
  }
  function checkPath(path, bucket) {
    try { (bucket === 'saves' ? validateSavePath : validateModPath)(path); }
    catch (error) { throw fail(error.message, 400); }
    return path;
  }
  async function directories(path) {
    try { return (await fs.readdir(native(path))).files; }
    catch (error) { if (missing(error)) return []; throw error; }
  }
  async function latest(bucket, key) {
    const location = recordPath(bucket, key), generations = [], incomplete = [];
    for (const entry of await directories(location)) {
      if (entry.type !== 'directory' || !GENERATION.test(entry.name)) continue;
      const path = `${location}/${entry.name}`;
      let value; try { value = await readJSON(`${path}/commit.json`); }
      catch (error) { if (missing(error)) { incomplete.push(path); continue; } throw fail(`Native commit is damaged: ${bucket}/${key}`); }
      if (value?.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
          value.sequence !== Number(GENERATION.exec(entry.name)[1]) || typeof value.revision !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(value.revision) || !Array.isArray(value.files) || typeof value.deleted !== 'boolean') throw fail('Invalid native commit record');
      generations.push({...value, location: path});
    }
    generations.sort((a, b) => b.sequence - a.sequence);
    if (generations.length > 1 && generations[0].sequence === generations[1].sequence) throw fail('Concurrent native commits detected', 409);
    return {current: generations[0] || null, generations, incomplete};
  }
  async function read(bucket, key) {
    const {current} = await latest(bucket, key);
    if (!current || current.deleted) return empty();
    const files = [];
    for (const entry of current.files) {
      checkPath(entry.path, bucket);
      const {data} = await fs.readFile(native(`${current.location}/files/${entry.path}`));
      if (typeof data !== 'string') throw fail('Native storage returned a nonbinary file');
      const bytes = decode(data);
      if (bytes.length !== entry.size || await digest(bytes) !== entry.sha256) throw fail(`Native file is damaged: ${entry.path}`);
      files.push({path: entry.path, base64: data});
    }
    return {revision: current.revision, files, meta: current.meta};
  }
  async function validate(body, bucket) {
    if (!object(body) || typeof body.revision !== 'string' || !Array.isArray(body.files) || !(body.meta === null || object(body.meta))) throw fail('Invalid native snapshot', 400);
    if (encoder.encode(JSON.stringify(body.meta)).length > 65536) throw fail('Native metadata is too large', 400);
    const limit = bucket === 'mods' ? {total: 256 * 1048576, file: 128 * 1048576, count: 10000} : bucket === 'saves' ? {total: 32 * 1048576, file: 32 * 1048576, count: 2048} : {total: 1048576, file: 1048576, count: 32};
    if (body.files.length > limit.count) throw fail('Too many native files', 400);
    let total = 0; const names = new Set(), files = [];
    for (const file of body.files) {
      if (!object(file)) throw fail('Invalid native file', 400);
      checkPath(file.path, bucket);
      const name = file.path.toLowerCase();
      if (names.has(name)) throw fail('Duplicate native file path', 400);
      names.add(name);
      if (typeof file.base64 !== 'string' || file.base64.length > Math.ceil(limit.file / 3) * 4) throw fail('Native file is too large', 400);
      const bytes = decode(file.base64);
      if (bytes.length > limit.file || (total += bytes.length) > limit.total) throw fail('Native snapshot is too large', 400);
      files.push({path: file.path, size: bytes.length, sha256: await digest(bytes)});
    }
    for (const name of names) { const parts = name.split('/'); for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) throw fail('Native file/directory conflict', 400); }
    return files;
  }
  async function commit(bucket, key, body, deleted = false) {
    const files = await validate(body, bucket), {current, generations, incomplete} = await latest(bucket, key);
    const previous = current && !current.deleted ? current.revision : '';
    if (body.revision !== previous) throw fail('Native data changed since it was read', 409);
    for (const orphan of incomplete) await remove(orphan).catch(() => {});
    if (!deleted && current && !current.deleted && JSON.stringify(files) === JSON.stringify(current.files) && JSON.stringify(body.meta) === JSON.stringify(current.meta)) return {revision: previous};
    const revision = crypto.randomUUID(), sequence = (current?.sequence || 0) + 1;
    const location = `${recordPath(bucket, key)}/g-${sequence}-${revision}`;
    await mkdir(location);
    // A failed/terminated write has no commit.json, so readers keep the prior
    // complete generation. Every binary must finish before publishing metadata.
    for (const file of body.files) await fs.writeFile({...native(`${location}/files/${file.path}`), data: file.base64, recursive: true});
    const value = {version: 1, revision, sequence, files, meta: body.meta, deleted};
    await writeJSON(`${location}/commit.pending`, value);
    await fs.rename({from: `${location}/commit.pending`, to: `${location}/commit.json`, directory, toDirectory: directory});
    // Keep the previous committed snapshot as a recovery copy. Cleanup failure
    // never changes a successful commit into an apparent save failure.
    for (const old of generations.slice(1)) await remove(old.location).catch(() => {});
    return {revision};
  }
  async function listMods() {
    const mods = [];
    for (const entry of await directories(`${root}/mods`)) {
      if (entry.type !== 'directory' || !MOD_ID.test(entry.name)) continue;
      const {current} = await latest('mods', entry.name);
      if (current && !current.deleted) mods.push({key: entry.name, revision: current.revision, meta: current.meta});
    }
    return mods;
  }
  async function handle(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, 'https://localhost/');
    const method = (options.method || input?.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || input?.headers);
    if (url.pathname === '/api/session' && method === 'GET') return jsonResponse(session);
    if (headers.get('X-Isaac-Token') !== token) return jsonResponse({error: 'Native session expired'}, 401);
    if (url.pathname === '/api/mods' && method === 'GET') return jsonResponse(await listMods());
    const match = /^\/api\/storage\/(saves|settings|mods)\/([^/]+)$/.exec(url.pathname);
    if (!match) return jsonResponse({error: 'Unknown native endpoint'}, 404);
    const [, bucket, key] = match; recordPath(bucket, key);
    if (method === 'GET') return jsonResponse(await read(bucket, key));
    if (method === 'PUT') {
      let body; try { body = JSON.parse(options.body ?? await input.text()); } catch { throw fail('Invalid native request', 400); }
      return jsonResponse(await commit(bucket, key, body));
    }
    if (method === 'DELETE' && bucket === 'mods') {
      await commit(bucket, key, {revision: headers.get('X-Isaac-Revision') || '', files: [], meta: null}, true);
      return new Response(null, {status: 204});
    }
    return jsonResponse({error: 'Native method not allowed'}, 405);
  }
  return {session, fetch: (input, options) => queue(async () => {
    try { return await handle(input, options); }
    catch (error) { return jsonResponse({error: error.message || String(error)}, error.status || 500); }
  })};
}
