'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshot(directory, prefix = '') {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `unexpected resource symlink: ${relative}`);
      return entry.isDirectory()
        ? Object.entries(snapshot(absolute, relative))
        : [[relative, hash(fs.readFileSync(absolute))]];
    }));
}

async function worker(hostDirectory) {
  const before = snapshot(hostDirectory);
  const host = require(path.join(hostDirectory, 'host.cjs'));
  const cjs = require('vscode');
  const esm = await import('vscode');
  const direct = await import(pathToFileURL(path.join(hostDirectory, 'node_modules/vscode/index.mjs')).href);
  assert.equal(esm.default, direct.default, 'loader and direct ESM import share the same shim');
  assert.equal(esm.default, cjs, 'ESM default and CJS use the same shim');
  const keys = Object.keys(cjs).filter(key => key !== 'default' && key !== '__esModule');
  assert.ok(keys.length > 100, 'exercise the actual full shim export set');
  for (const key of keys) {
    assert.equal(esm[key], cjs[key], `named export identity: ${key}`);
    assert.equal(direct[key], cjs[key], `direct named export identity: ${key}`);
  }
  for (const key of ['commands', 'window', 'workspace', 'Position', 'StatusBarAlignment']) {
    assert.ok(esm[key], `required extension API export: ${key}`);
  }
  const position = new esm.Position(3, 7);
  assert.equal(position.line, 3);
  assert.equal(position.character, 7);

  const events = [];
  host.on('event', event => events.push(event));
  const receiver = { prefix: 'synthetic' };
  const command = esm.commands.registerCommand('probe.esmBridge', function (count) {
    return `${this.prefix}:${count + 1}`;
  }, receiver);
  assert.equal(await cjs.commands.executeCommand('probe.esmBridge', 4), 'synthetic:5');
  assert.ok(events.some(event => event.type === 'commandRegistered' && event.commandId === 'probe.esmBridge'));
  command.dispose();
  assert.equal((await esm.commands.getCommands()).includes('probe.esmBridge'), false);

  const item = esm.window.createStatusBarItem('probe.esmStatus', esm.StatusBarAlignment.Right, 9);
  item.text = 'Synthetic status one';
  item.command = 'probe.esmBridge';
  assert.equal(events.some(event => event.type.startsWith('statusBarItem')), false);
  item.show();
  item.text = 'Synthetic status two';
  item.hide();
  item.dispose();
  const status = events.filter(event => event.type.startsWith('statusBarItem'));
  assert.deepEqual(status.map(event => event.type), [
    'statusBarItemShow', 'statusBarItemUpdate', 'statusBarItemHide', 'statusBarItemRemove',
  ]);
  assert.equal(status[0].text, 'Synthetic status one');
  assert.equal(status[0].alignment, esm.StatusBarAlignment.Right);
  assert.equal(status[0].priority, 9);
  assert.equal(status[1].text, 'Synthetic status two');
  assert.ok(status.every(event => event.id === 'probe.esmStatus'));

  assert.deepEqual(snapshot(hostDirectory), before, 'host startup/import/API calls preserve every resource byte');
  console.log(JSON.stringify({ pass: true, directory: hostDirectory, namedExports: keys.length,
    checks: ['CJS/ESM/direct import identity', 'every named export', 'Position constructor',
      'command receiver/return/disposal', 'statusbar show/update/hide/remove', 'all resource hashes stable'] }));
}

async function main() {
  if (process.argv[2] === '--worker') return worker(process.argv[3]);
  const root = path.resolve(__dirname, '..');
  const hostDirectory = path.join(root, 'src-tauri/extension-host');
  const node = process.execPath;
  const baseline = snapshot(hostDirectory);
  const esmText = fs.readFileSync(path.join(hostDirectory, 'node_modules/vscode/index.mjs'), 'utf8');
  assert.ok(esmText.includes('const _require = createRequire(import.meta.url);'));
  assert.equal(esmText.includes(root), false, 'generated ESM must not embed the checkout path');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex esm-中文-'));
  try {
    const relocated = path.join(temporary, '应用资源 extension-host');
    fs.cpSync(hostDirectory, relocated, { recursive: true });
    assert.deepEqual(snapshot(relocated), baseline, 'relocation initially preserves resources');
    for (const directory of [hostDirectory, hostDirectory, relocated, relocated]) {
      const result = spawnSync(node, [__filename, '--worker', directory], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, SIDEX_EXTENSION_HOST: 'false' },
        timeout: 20000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      assert.equal(result.error, undefined, 'worker launches successfully');
      assert.equal(result.status, 0, 'worker smoke passes');
      assert.deepEqual(snapshot(directory), baseline, 'repeated or relocated startup preserves every resource byte');
    }
    const metadata = {
      checkedAt: new Date().toISOString(),
      command: `${node} local-build/verify-esm-shim.cjs`,
      platform: `${process.platform} ${process.arch} ${os.release()}`,
      node: process.version,
      nodeExecutable: node,
      hostSha256: baseline['host.cjs'],
      generatedEsmSha256: baseline['node_modules/vscode/index.mjs'],
      allExtensionHostResources: baseline,
      startups: 4,
      result: 'PASS: original and relocated startup/API behavior; all resource bytes unchanged',
    };
    fs.writeFileSync(path.join(__dirname, 'esm-shim-smoke-meta.json'), JSON.stringify(metadata, null, 2) + '\n');
    console.log(JSON.stringify(metadata, null, 2));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
