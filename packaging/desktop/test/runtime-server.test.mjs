import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, rm, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateReady, isGameURL, startRuntime} from '../runtime-server.mjs';

test('accepts only a complete ephemeral loopback ready record', () => {
  const valid = {url: 'http://127.0.0.1:49152/', rootId: 'root', packageId: 'package', pid: 123};
  assert.deepEqual(validateReady(valid), valid);
  for (const url of ['https://example.com/', 'http://localhost:80/', 'http://127.0.0.1/', 'http://user:pass@127.0.0.1:80/', 'http://127.0.0.1:123/a', 'http://127.0.0.1:123/?x']) {
    assert.throws(() => validateReady({...valid, url}));
  }
  for (const field of ['pid', 'rootId', 'packageId']) assert.throws(() => validateReady({...valid, [field]: null}));
});

test('renderer network scope cannot escape its own launcher origin', () => {
  const origin = 'http://127.0.0.1:49152';
  assert.equal(isGameURL(origin + '/api/session', origin), true);
  assert.equal(isGameURL('http://127.0.0.1:49153/assets/a', origin), false);
  assert.equal(isGameURL('https://example.com', origin), false);
  assert.equal(isGameURL('file:///etc/passwd', origin), false);
  assert.equal(isGameURL('invalid', origin), false);
});

async function fixture(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isaac-desktop-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'runtime'));
  await writeFile(path.join(root, 'runtime/isaac-launcher'), `#!${process.execPath}\n${body}`, {mode: 0o755});
  return {runtimeDir: path.join(root, 'runtime'), dataDir: path.join(root, 'userdata'), logsDir: path.join(root, 'logs')};
}

test('child handshake is tied to its own PID and disk identity, and cleaned up on stop', async t => {
  const options = await fixture(t, `
    const http = require('node:http'), fs = require('node:fs');
    const argv = process.argv.slice(2), arg = name => argv[argv.indexOf(name) + 1];
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({rootId:'test-root',packageId:'test-package',storage:'disk'}));
    });
    server.listen(0, '127.0.0.1', () => fs.writeFileSync(arg('--ready-file'), JSON.stringify({
      url:'http://127.0.0.1:' + server.address().port + '/',rootId:'test-root',packageId:'test-package',pid:process.pid
    })));
    process.on('SIGTERM', () => server.close());
  `);
  let unexpected = false;
  const runtime = await startRuntime({...options, onUnexpectedExit: () => { unexpected = true; }});
  t.after(() => runtime.stop());
  assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(runtime.rootId, 'test-root');
  assert.equal((await fetch(new URL('health.json', runtime.url))).status, 200);
  await runtime.stop();
  assert.equal(unexpected, false);
  assert.deepEqual((await readdir(options.dataDir)).filter(name => name.startsWith('.startup-')), []);
  assert.throws(() => process.kill(runtime.child.pid, 0), /ESRCH/);
});

test('startup failure terminates a child that never publishes readiness', async t => {
  const options = await fixture(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(startRuntime({...options, timeoutMs: 80}), /启动超时/);
  assert.deepEqual((await readdir(options.dataDir)).filter(name => name.startsWith('.startup-')), []);
});

test('another process cannot substitute its own ready record', async t => {
  const options = await fixture(t, `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    fs.writeFileSync(argv[argv.indexOf('--ready-file')+1], JSON.stringify({
      url:'http://127.0.0.1:12345/',rootId:'r',packageId:'p',pid:process.pid+1
    }));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(startRuntime(options), /进程信息不一致/);
});
