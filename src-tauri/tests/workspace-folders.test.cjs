'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const hostPath = path.resolve(__dirname, '../extension-host/host.cjs');
function loadHost() {
  if (!process.env.SIDEX_WORKSPACE_HOST_SOURCE) return require(hostPath);
  // Execute an unchanged pre-fix snapshot with the real host's dependency paths.
  const snapshot = new Module(hostPath, module);
  snapshot.filename = hostPath;
  snapshot.paths = Module._nodeModulePaths(path.dirname(hostPath));
  snapshot._compile(fs.readFileSync(process.env.SIDEX_WORKSPACE_HOST_SOURCE, 'utf8'), hostPath);
  return snapshot.exports;
}
const host = loadHost();
const vscode = require('vscode');
let requestId = 0;
function initialize(workspaceFolders) {
  const params = workspaceFolders === undefined ? {} : { workspaceFolders };
  const reply = host.handleMessage({ id: ++requestId, type: 'initialize', params });
  assert.ok(reply.result?.capabilities.includes('commands'));
  return reply;
}
function describe(folders) {
  return folders.map(folder => ({
    path: folder.uri.fsPath, scheme: folder.uri.scheme, name: folder.name, index: folder.index,
    isUri: vscode.Uri.isUri(folder.uri),
  }));
}
function expected(...paths) {
  return paths.map((folder, index) => ({ path: folder, scheme: 'file', name: path.basename(folder), index, isUri: true }));
}

test('initialize emits folder deltas after updating the workspace and ignores unchanged sets', () => {
  const original = [...host._workspaceFolders];
  initialize([]);
  const root = path.join(os.tmpdir(), 'sidex-workspace-fixtures');
  const alpha = path.join(root, '项目 alpha');
  const beta = path.join(root, 'beta');
  const gamma = path.join(root, 'gamma');
  const observed = [];
  const listener = vscode.workspace.onDidChangeWorkspaceFolders(event => {
    // Keep assertions outside the listener: EventEmitter reports listener errors.
    observed.push({ added: describe(event.added), removed: describe(event.removed), current: describe(vscode.workspace.workspaceFolders) });
  });
  try {
    initialize([alpha, beta]);
    assert.deepEqual(observed, [{ added: expected(alpha, beta), removed: [], current: expected(alpha, beta) }]);
    initialize([alpha, beta]);
    initialize();
    assert.equal(observed.length, 1, 'identical or absent folder updates do not notify');

    initialize([beta, alpha]);
    assert.equal(observed.length, 1, 'a reorder changes indices without an add/remove event');
    assert.deepEqual(describe(vscode.workspace.workspaceFolders), expected(beta, alpha));

    initialize([beta, gamma]);
    assert.deepEqual(observed.at(-1), {
      added: [expected(beta, gamma)[1]], removed: [expected(beta, alpha)[1]], current: expected(beta, gamma),
    });
    assert.equal(observed.length, 2);

    initialize([gamma]);
    assert.deepEqual(observed.at(-1), { added: [], removed: [expected(beta, gamma)[0]], current: expected(gamma) });
    initialize([]);
    assert.deepEqual(observed.at(-1), { added: [], removed: expected(gamma), current: [] });
    assert.equal(observed.length, 4);
    initialize([]);
    assert.equal(observed.length, 4);
  } finally {
    listener.dispose();
    initialize(original);
  }
});

test('workspace folder listeners preserve thisArg, disposable registration and independent lifetimes', () => {
  const original = [...host._workspaceFolders];
  initialize([]);
  const receiver = { calls: [] };
  const disposables = [];
  let otherCalls = 0;
  const first = vscode.workspace.onDidChangeWorkspaceFolders(function (event) {
    this.calls.push({ receiver: this, event });
  }, receiver, disposables);
  const second = vscode.workspace.onDidChangeWorkspaceFolders(() => { otherCalls++; });
  try {
    assert.deepEqual(disposables, [first]);
    initialize([path.join(os.tmpdir(), 'first-workspace')]);
    assert.equal(receiver.calls.length, 1);
    assert.equal(receiver.calls[0].receiver, receiver);
    assert.equal(otherCalls, 1);
    disposables.pop().dispose();
    first.dispose();
    initialize([]);
    assert.equal(receiver.calls.length, 1, 'a disposed listener receives no further events');
    assert.equal(otherCalls, 2, 'disposing one listener leaves the other active');
    second.dispose();
    initialize([path.join(os.tmpdir(), 'second-workspace')]);
    assert.equal(otherCalls, 2);
  } finally {
    first.dispose();
    second.dispose();
    initialize(original);
  }
});

test('a star extension activated before initialize discovers a real Git repository on the first workspace event', async () => {
  const original = [...host._workspaceFolders];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex-workspace-folders-'));
  const extensionPath = path.join(directory, 'startup-listener');
  const repository = path.join(directory, '项目 repository');
  const extensionId = 'fixture.startup-repository-listener';
  let exports;
  try {
    initialize([]);
    fs.mkdirSync(extensionPath);
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    fs.writeFileSync(path.join(extensionPath, 'package.json'), JSON.stringify({
      publisher: 'fixture', name: 'startup-repository-listener', version: '1.0.0',
      main: './extension.cjs', activationEvents: ['*'],
    }));
    fs.writeFileSync(path.join(extensionPath, 'extension.cjs'), `
      const vscode = require('vscode');
      const { execFileSync } = require('node:child_process');
      exports.activate = context => {
        let repositories = [];
        let scans = 0;
        const scan = () => {
          scans++;
          repositories = (vscode.workspace.workspaceFolders || []).filter(folder => {
            try {
              return execFileSync('git', ['-C', folder.uri.fsPath, 'rev-parse', '--is-inside-work-tree'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
            } catch { return false; }
          }).map(folder => folder.uri.fsPath);
        };
        scan();
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(scan));
        return {
          get repositories() { return repositories.slice(); },
          get scans() { return scans; },
          deactivate() { context.subscriptions.forEach(subscription => subscription.dispose()); },
        };
      };
    `);
    const loaded = host.handleMessage({ id: ++requestId, type: 'loadExtension', params: { extensionPath } });
    assert.equal(loaded.result?.extensionId, extensionId);
    host.handleMessage({ id: ++requestId, type: 'activateByEvent', params: { event: '*' } });
    exports = await host._activationPromises.get(extensionId);
    assert.ok(exports, 'the real activation path loads the startup extension');
    assert.equal(host._extensions.get(extensionId).activated, true);
    assert.deepEqual(exports.repositories, []);
    assert.equal(exports.scans, 1, 'startup activation initially sees an empty workspace');

    initialize([repository]);
    assert.deepEqual(exports.repositories, [repository], 'the first workspace update triggers a repository rescan');
    assert.equal(exports.scans, 2);
    initialize([repository]);
    assert.equal(exports.scans, 2, 'repeating initialize does not repeat the repository scan');
    initialize([]);
    assert.deepEqual(exports.repositories, []);
    assert.equal(exports.scans, 3);
  } finally {
    exports?.deactivate();
    host._extensions.delete(extensionId);
    host._activationPromises.delete(extensionId);
    host._failedExtensions.delete(extensionId);
    delete require.cache[path.join(extensionPath, 'extension.cjs')];
    initialize(original);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
