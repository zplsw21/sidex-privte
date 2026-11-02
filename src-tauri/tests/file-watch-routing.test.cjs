'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const host = require('../extension-host/host.cjs');
const vscode = require('vscode');

// Load the checked-out VS Code glob implementation and its real dependencies.
// No alternative glob library or matcher double stands in for production code.
const modules = new Map();
function loadTypeScript(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', '__filename', '__dirname', code)(
    request => request.startsWith('.')
      ? loadTypeScript(path.resolve(path.dirname(file), request.replace(/\.js$/, '.ts')))
      : require(request),
    module, module.exports, file, path.dirname(file),
  );
  return module.exports;
}
const { match: matchGlob } = loadTypeScript(path.join(root, 'src/vs/base/common/glob.ts'));
const { isAbsolute } = loadTypeScript(path.join(root, 'src/vs/base/common/path.ts'));

const frontendPath = path.join(root, 'src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts');
const frontend = ts.createSourceFile(frontendPath, fs.readFileSync(frontendPath, 'utf8'), ts.ScriptTarget.Latest, true);
const contribution = frontend.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'TauriExtensionHostContribution');
const methodNames = ['_onStartFileWatch', '_onStopFileWatch', '_setupTauriWatchListener'];
const methods = methodNames.map(name => {
  const method = contribution.members.find(member => member.name?.getText(frontend) === name);
  assert.ok(method, `missing actual frontend method ${name}`);
  return method.getText(frontend);
});
const bridgeCode = ts.transpileModule(`class WatchBridge { ${methods.join('\n')} }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function makeBridge() {
  let nativeId = 100;
  let listener;
  const calls = [];
  const messages = [];
  const api = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === 'watch_start') return ++nativeId;
    },
    async listen(name, callback) {
      assert.equal(name, 'watch-batch');
      listener = callback;
      return () => { listener = undefined; };
    },
  };
  const Bridge = new Function('require', 'matchGlob', 'isAbsolute', `${bridgeCode}\nreturn WatchBridge;`)(request => {
    assert.ok(request === '@tauri-apps/api/core' || request === '@tauri-apps/api/event');
    return api;
  }, matchGlob, isAbsolute);
  const bridge = new Bridge();
  bridge._activeWatches = new Map();
  bridge._connected = true;
  bridge.logService = { info() {}, warn() {} };
  bridge._nextId = () => messages.length + 1;
  bridge._send = message => messages.push(message);
  return {
    bridge, calls, messages,
    batch(watchId, events) {
      assert.ok(listener, 'production method installed the native listener');
      listener({ payload: { watch_id: watchId, events } });
    },
  };
}

test('file watchers preserve recipient, base, literal names and VS glob semantics', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex-watch-routing-'));
  const workspace = path.join(directory, 'workspace');
  const endpointBase = path.join(workspace, '.noConfigDebugAdapterEndpoints');
  fs.mkdirSync(endpointBase, { recursive: true });
  const originalFolders = host._workspaceFolders;
  host._workspaceFolders = [workspace];
  const disposables = [];
  const starts = [];
  const onHostEvent = message => {
    if (message.type === 'startFileWatch') starts.push(message);
  };
  host.on('event', onHostEvent);
  const change = (file, kind = 'modified') => ({ path: file, kind, is_dir: false });
  const createWatcher = pattern => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    disposables.push(watcher);
    return watcher;
  };
  try {
    await t.test('RelativePattern watches its base and future directories without a home fallback', () => {
      createWatcher(new vscode.RelativePattern(endpointBase, 'endpoint.txt'));
      assert.deepEqual(starts.at(-1).paths, [endpointBase]);
      assert.equal(starts.at(-1).base, endpointBase);
      assert.equal(starts.at(-1).recursive, false);

      const missing = path.join(workspace, 'future', 'nested');
      createWatcher(new vscode.RelativePattern(missing, '*.ts'));
      assert.deepEqual(starts.at(-1).paths, [workspace]);
      assert.equal(starts.at(-1).base, missing);
      assert.equal(starts.at(-1).recursive, true);

      host._workspaceFolders = [];
      const count = starts.length;
      createWatcher('**/*.ts');
      assert.equal(starts.length, count, 'empty workspaces must not watch process.cwd()');
      host._workspaceFolders = [workspace];
    });

    await t.test('host rejects foreign watcher IDs, other filenames and out-of-base paths', () => {
      const watcher = createWatcher(new vscode.RelativePattern(endpointBase, 'endpoint.txt'));
      const watcherId = starts.at(-1).watcherId;
      const observed = [];
      watcher.onDidCreate(uri => observed.push(['created', uri.fsPath]));
      watcher.onDidChange(uri => observed.push(['modified', uri.fsPath]));
      watcher.onDidDelete(uri => observed.push(['deleted', uri.fsPath]));
      const endpoint = path.join(endpointBase, 'endpoint.txt');
      const rejected = [
        path.join(directory, 'unrelated-large.db'),
        path.join(endpointBase + '-sibling', 'endpoint.txt'),
        endpointBase + '/../other/endpoint.txt',
        path.join(endpointBase, 'other.txt'),
        path.join(endpointBase, 'nested', 'endpoint.txt'),
        path.join(endpointBase, 'endpoint.txt.bak'),
      ];
      host._handleFileWatchEvent(1, { watcherId, events: rejected.map(file => change(file)) });
      host._handleFileWatchEvent(2, { watcherId: Number.MAX_SAFE_INTEGER, events: [change(endpoint)] });
      assert.deepEqual(observed, []);

      const other = createWatcher(new vscode.RelativePattern(endpointBase, 'endpoint.txt'));
      let otherCalls = 0;
      other.onDidChange(() => otherCalls++);
      const kinds = ['created', 'modified', 'deleted', 'renamed_to', 'renamed_from'];
      host._handleFileWatchEvent(3, { watcherId, events: kinds.map(kind => change(endpoint, kind)) });
      assert.deepEqual(observed.map(([kind]) => kind), ['created', 'modified', 'deleted', 'created', 'deleted']);
      assert.ok(observed.every(([, file]) => file === endpoint));
      assert.equal(otherCalls, 0, 'even identical patterns must not receive another watcher ID');

      // Older untagged bridge messages also cannot turn a literal into match-all.
      host._handleFileWatchEvent(4, { events: [change(path.join(endpointBase, 'other.txt'))] });
      assert.equal(observed.length, 5);
      assert.equal(host._matchGlob('dir/endpoint.txt', 'dir/endpoint.txt.bak'), false);
      watcher.dispose();
      host._handleFileWatchEvent(5, { watcherId, events: [change(endpoint)] });
      assert.equal(observed.length, 5);

      host._workspaceFolders = [workspace, endpointBase];
      const multiRootWatcher = createWatcher('endpoint.txt');
      let multiRootCalls = 0;
      multiRootWatcher.onDidChange(() => multiRootCalls++);
      host._handleFileWatchEvent(6, { watcherId: starts.at(-1).watcherId, events: [change(endpoint)] });
      assert.equal(multiRootCalls, 1, 'any containing workspace root can match a literal');
      host._workspaceFolders = [workspace];

      const absoluteWatcher = createWatcher(endpoint);
      let absoluteCalls = 0;
      absoluteWatcher.onDidChange(() => absoluteCalls++);
      host._handleFileWatchEvent(7, { watcherId: starts.at(-1).watcherId, events: [change(endpoint), change(endpoint + '.bak')] });
      assert.equal(absoluteCalls, 1, 'an absolute string literal must retain exact matching');
      const outside = path.join(directory, 'outside.txt');
      const outsideWatcher = createWatcher(outside);
      let outsideCalls = 0;
      outsideWatcher.onDidChange(() => outsideCalls++);
      host._handleFileWatchEvent(8, { watcherId: starts.at(-1).watcherId, events: [change(outside)] });
      assert.equal(outsideCalls, 0, 'absolute strings remain restricted to the workspace');
    });

    await t.test('native batches route only to their owner and apply exact canonical patterns', async () => {
      const { bridge, calls, messages, batch } = makeBridge();
      await bridge._onStartFileWatch(11, [endpointBase], 'endpoint.txt', false, endpointBase);
      await bridge._onStartFileWatch(12, [endpointBase], 'endpoint.txt', false, endpointBase);
      await bridge._onStartFileWatch(13, [workspace], '**/.prettierrc{,.json}', true, '');
      await bridge._onStartFileWatch(14, [workspace], '**/*.{ts,tsx}', true, '');
      const endpoint = path.join(endpointBase, 'endpoint.txt');
      batch(999, [change(endpoint)]);
      batch(101, [change(path.join(directory, 'unrelated-large.db')), change(path.join(endpointBase, 'other.txt'))]);
      assert.deepEqual(messages, [], 'global Rust watcher batches must not be broadcast');
      batch(101, [change(endpoint)]);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].params.watcherId, 11);
      assert.deepEqual(messages[0].params.events, [change(endpoint)]);

      const dotConfigs = [path.join(workspace, '.prettierrc'), path.join(workspace, '.config/.prettierrc.json')];
      batch(103, [...dotConfigs.map(file => change(file)), change(path.join(workspace, '.prettierrc.yaml')),
        change(path.join(directory, '.prettierrc'))]);
      assert.deepEqual(messages.at(-1).params.events.map(event => event.path), dotConfigs);
      const hiddenTs = path.join(workspace, '.hidden/index.ts');
      batch(104, [change(hiddenTs), change(path.join(workspace, 'index.tsx')), change(path.join(workspace, 'index.js'))]);
      assert.deepEqual(messages.at(-1).params.events.map(event => event.path), [hiddenTs, path.join(workspace, 'index.tsx')]);

      await bridge._onStartFileWatch(16, [workspace], endpoint, true, '');
      batch(105, [change(endpoint), change(endpoint + '.bak')]);
      assert.equal(messages.at(-1).params.watcherId, 16);
      assert.deepEqual(messages.at(-1).params.events, [change(endpoint)]);
      await bridge._onStartFileWatch(17, [workspace], path.join(workspace, '**/*.ts'), true, '');
      batch(106, [change(hiddenTs), change(path.join(workspace, 'index.js'))]);
      assert.deepEqual(messages.at(-1).params.events, [change(hiddenTs)]);
      const beforeOutside = messages.length;
      const outside = path.join(directory, 'outside.txt');
      await bridge._onStartFileWatch(18, [workspace], outside, true, '');
      batch(107, [change(outside)]);
      assert.equal(messages.length, beforeOutside, 'absolute native patterns cannot escape the workspace');

      const count = messages.length;
      await bridge._onStopFileWatch(11);
      assert.deepEqual(calls.at(-1), { command: 'watch_stop', args: { id: 101 } });
      batch(101, [change(endpoint)]);
      assert.equal(messages.length, count, 'stopped native watches must not forward delayed batches');
      const callCount = calls.length;
      await bridge._onStartFileWatch(15, [], '**/*', true);
      assert.equal(calls.length, callCount);
      bridge._connected = false;
      batch(102, [change(endpoint)]);
      assert.equal(messages.length, count);
    });
  } finally {
    disposables.forEach(disposable => disposable.dispose());
    host.off('event', onHostEvent);
    host._workspaceFolders = originalFolders;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
