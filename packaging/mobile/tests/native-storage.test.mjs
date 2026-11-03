import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNativeStorage} from '../src/native_storage.mjs';
import {openDiskStorage} from '../../../Isaac-Repentance/project/web/disk_storage.mjs';
import {validateSavePath, bytesToBase64} from '../../../Isaac-Repentance/project/web/save_helpers.mjs';
import {validateModPath} from '../../../Isaac-Repentance/project/web/mod_helpers.mjs';

const SAVE = 'user/Documents/My Games/Binding of Isaac Repentance/persistentgamedata1.dat';
const DAT = Uint8Array.from([0x49, 0x53, 0x41, 0x41, 0x43, 0, 255, 128, 13, 10, 42]);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isaac-native-storage-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const native = value => { const result = path.resolve(root, value); if (!result.startsWith(root + path.sep)) throw new Error('Escape'); return result; };
  const fault = {write: null, rename: false};
  const filesystem = {
    mkdir: ({path: file, recursive}) => fs.mkdir(native(file), {recursive}),
    rmdir: ({path: file, recursive}) => fs.rm(native(file), {recursive}),
    readFile: async ({path: file, encoding}) => ({data: (await fs.readFile(native(file))).toString(encoding === 'utf8' ? 'utf8' : 'base64')}),
    writeFile: async ({path: file, data, encoding, recursive}) => {
      if (fault.write?.(file)) throw new Error('Injected storage failure');
      if (recursive) await fs.mkdir(path.dirname(native(file)), {recursive: true});
      await fs.writeFile(native(file), Buffer.from(data, encoding === 'utf8' ? 'utf8' : 'base64'));
      return {uri: `file://${native(file)}`};
    },
    rename: async ({from, to}) => {
      if (fault.rename && to.endsWith('/commit.json')) throw new Error('Injected commit interruption');
      await fs.rename(native(from), native(to));
    },
    getUri: async ({path: file}) => ({uri: `file://${native(file)}`}),
    readdir: async ({path: file}) => ({files: (await fs.readdir(native(file), {withFileTypes: true})).map(entry => ({name: entry.name, type: entry.isDirectory() ? 'directory' : 'file'}))})
  };
  const connect = async () => {
    const transport = await createNativeStorage({filesystem, validateSavePath, validateModPath});
    return {transport, store: await openDiskStorage({fetch: transport.fetch})};
  };
  return {root, filesystem, fault, connect};
}

test('native DAT bytes survive process recreation; settings and Mod APIs reuse the existing client', async t => {
  const fixtureValue = await fixture(t), {store} = await fixtureValue.connect();
  assert.equal((await store.readSaves()).revision, '');
  await store.writeSaves([{path: SAVE, data: DAT}]);
  await store.readSettings();
  await store.writeSettings({settings: {touch: true}, touchLayout: {portrait: {}}});
  const mod = {id: '836319872', name: 'Test Mod', folder: 'test-mod', enabled: true, bytes: 4, fileCount: 1, files: [{path: 'main.lua', data: Uint8Array.from([0, 255, 4, 6])}]};
  await store.modStore.install(mod);
  const restarted = (await fixtureValue.connect()).store;
  assert.deepEqual((await restarted.readSaves()).files[0].data, DAT);
  assert.equal((await restarted.readSettings()).settings.touch, true);
  assert.deepEqual((await restarted.modStore.enabled())[0].files[0].data, mod.files[0].data);
  const generations = await fs.readdir(path.join(fixtureValue.root, 'userdata/saves/main'));
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(fixtureValue.root, 'userdata/saves/main', generations[0], 'files', SAVE))), DAT);
});

test('interrupted binary write and commit publication preserve the last complete native save', async t => {
  const fixtureValue = await fixture(t), {store} = await fixtureValue.connect();
  await store.readSaves(); await store.writeSaves([{path: SAVE, data: DAT}]);
  const original = (await store.readSaves()).revision;
  fixtureValue.fault.write = file => file.includes('/files/');
  await assert.rejects(store.writeSaves([{path: SAVE, data: Uint8Array.of(99)}]), /Injected storage failure/);
  fixtureValue.fault.write = null;
  let restarted = (await fixtureValue.connect()).store;
  assert.equal((await restarted.readSaves()).revision, original);
  fixtureValue.fault.rename = true;
  await assert.rejects(restarted.writeSaves([{path: SAVE, data: Uint8Array.of(99)}]), /Injected commit interruption/);
  fixtureValue.fault.rename = false;
  restarted = (await fixtureValue.connect()).store;
  assert.deepEqual((await restarted.readSaves()).files[0].data, DAT);
  await restarted.writeSaves([{path: SAVE, data: Uint8Array.of(77)}]);
  assert.deepEqual((await restarted.readSaves()).files[0].data, Uint8Array.of(77));
});

test('stale revisions cannot overwrite a newer native generation', async t => {
  const fixtureValue = await fixture(t), a = (await fixtureValue.connect()).store, b = (await fixtureValue.connect()).store;
  await a.readSaves(); await b.readSaves();
  await a.writeSaves([{path: SAVE, data: DAT}]);
  await assert.rejects(b.writeSaves([{path: SAVE, data: Uint8Array.of(99)}]), error => error.status === 409);
  assert.deepEqual((await a.readSaves()).files[0].data, DAT);
});

test('Mod removal is durable and reinstall does not resurrect deleted metadata', async t => {
  const fixtureValue = await fixture(t), {store} = await fixtureValue.connect();
  const mod = {id: '123', name: 'Test Mod', folder: 'test-mod', enabled: true, bytes: 1, fileCount: 1, files: [{path: 'main.lua', data: Uint8Array.of(1)}]};
  await store.modStore.install(mod); await store.modStore.remove(mod.id);
  const restarted = (await fixtureValue.connect()).store;
  assert.deepEqual(await restarted.modStore.list(), []); assert.equal(await restarted.modStore.get(mod.id), null);
  await restarted.modStore.install({...mod, name: 'Reinstalled'});
  assert.equal((await restarted.modStore.list())[0].name, 'Reinstalled');
});

test('unchanged saves do not write new generations; only two complete generations are retained', async t => {
  const fixtureValue = await fixture(t), {store} = await fixtureValue.connect();
  await store.readSaves();
  for (let i = 0; i < 5; i++) await store.writeSaves([{path: SAVE, data: Uint8Array.of(i)}]);
  const before = await fs.readdir(path.join(fixtureValue.root, 'userdata/saves/main'));
  assert.equal(before.length, 2);
  await store.writeSaves([{path: SAVE, data: Uint8Array.of(4)}]);
  assert.deepEqual(await fs.readdir(path.join(fixtureValue.root, 'userdata/saves/main')), before);
});

test('native transport rejects traversal and corrupt committed binary contents', async t => {
  const fixtureValue = await fixture(t), {transport, store} = await fixtureValue.connect();
  const bad = await transport.fetch('/api/storage/saves/main', {method: 'PUT', headers: {'X-Isaac-Token': transport.session.token}, body: JSON.stringify({revision: '', files: [{path: '../../outside.dat', base64: bytesToBase64(DAT)}], meta: null})});
  assert.equal(bad.status, 400);
  await store.readSaves(); await store.writeSaves([{path: SAVE, data: DAT}]);
  const [generation] = await fs.readdir(path.join(fixtureValue.root, 'userdata/saves/main'));
  await fs.writeFile(path.join(fixtureValue.root, 'userdata/saves/main', generation, 'files', SAVE), Buffer.from([7]));
  await assert.rejects(store.readSaves(), /damaged/);
});
