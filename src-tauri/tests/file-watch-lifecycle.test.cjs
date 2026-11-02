'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const frontendPath = path.resolve(__dirname, '../../src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts');
const frontend = ts.createSourceFile(frontendPath, fs.readFileSync(frontendPath, 'utf8'), ts.ScriptTarget.Latest, true);
const contribution = frontend.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'TauriExtensionHostContribution');
const names = ['_activeWatches', '_onStartFileWatch', '_onStopFileWatch', '_clearFileWatches', '_setupTauriWatchListener', '_connect', 'dispose'];
const members = names.map(name => {
  const member = contribution.members.find(member => member.name?.getText(frontend) === name);
  assert.ok(member, `missing actual frontend member ${name}`);
  return member.getText(frontend);
});
const code = ts.transpileModule(`class WatchBridge extends Disposable { ${members.join('\n')} }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeBridge({ delayListen = false } = {}) {
  const calls = [];
  const starts = [];
  const nativeWatches = new Set();
  const unloadCallbacks = [];
  const listenGate = deferred();
  let nextNativeId = 100;
  let unlistens = 0;
  let reconnects = 0;
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.OPEN;
    close() { this.readyState = Socket.CLOSED; }
  }
  const api = {
    invoke(command, args) {
      calls.push({ command, args });
      if (command === 'watch_start') {
        const start = { ...deferred(), id: ++nextNativeId };
        starts.push(start);
        nativeWatches.add(start.id);
        return start.promise;
      }
      assert.equal(command, 'watch_stop');
      nativeWatches.delete(args.id);
      return Promise.resolve();
    },
    async listen() {
      if (delayListen) await listenGate.promise;
      return () => { unlistens++; };
    },
  };
  const Bridge = new Function('require', 'Disposable', 'WebSocket', 'window', `${code}\nreturn WatchBridge;`)(
    request => {
      assert.ok(request === '@tauri-apps/api/core' || request === '@tauri-apps/api/event');
      return api;
    },
    class { dispose() {} }, Socket,
    { addEventListener(name, callback) { assert.equal(name, 'beforeunload'); unloadCallbacks.push(callback); } },
  );
  const bridge = new Bridge();
  bridge._connected = true;
  bridge.logService = { info() {}, warn() {} };
  bridge._rejectPending = () => {};
  bridge._scheduleReconnect = () => { reconnects++; };
  for (const name of ['_providerRegistrations', '_wasmProviderRegistrations']) bridge[name] = [];
  for (const name of ['_langConfigDisposables', '_statusBarItems', '_extTerminals', '_activeProgressResolvers',
    '_webviewPanels', '_webviewViewDisposables', '_treeViews', '_modelContentListeners', '_trackedEditors',
    '_decorationTypes', '_registeredCommands']) bridge[name] = new Map();
  return {
    bridge, calls, starts, nativeWatches, unloadCallbacks, listenGate,
    get unlistens() { return unlistens; },
    get reconnects() { return reconnects; },
    start(id = 1) { return bridge._onStartFileWatch(id, ['/workspace'], '**/*.ts', true); },
    complete(index = starts.length - 1) { starts[index].resolve(starts[index].id); },
  };
}

test('normal start/stop retains the native ID and releases exactly its session', async () => {
  const h = makeBridge();
  const starting = h.start();
  assert.equal(h.bridge._activeWatches.get(1).tauriWatchId, undefined, 'pending start is cancellable synchronously');
  await tick();
  h.complete();
  await starting;
  assert.equal(h.bridge._activeWatches.get(1).tauriWatchId, 101);
  await h.bridge._onStopFileWatch(1);
  assert.equal(h.bridge._activeWatches.size, 0);
  assert.equal(h.nativeWatches.size, 0);
  assert.deepEqual(h.calls.at(-1), { command: 'watch_stop', args: { id: 101 } });
});

test('stop before the native invocation cancels creation', async () => {
  const h = makeBridge();
  const starting = h.start();
  await h.bridge._onStopFileWatch(1);
  await starting;
  assert.equal(h.starts.length, 0);
  assert.equal(h.bridge._activeWatches.size, 0);
});

test('stop while native start is pending releases its eventual result', async () => {
  const h = makeBridge();
  const starting = h.start();
  await tick();
  assert.equal(h.nativeWatches.size, 1);
  await h.bridge._onStopFileWatch(1);
  h.complete();
  await starting;
  assert.equal(h.bridge._activeWatches.size, 0);
  assert.equal(h.nativeWatches.size, 0);
});

test('reusing an ID cannot let an older pending start replace the new session', async () => {
  const h = makeBridge();
  const oldStart = h.start(7);
  await tick();
  const newStart = h.start(7);
  await tick();
  h.complete(1);
  await newStart;
  h.complete(0);
  await oldStart;
  assert.equal(h.bridge._activeWatches.get(7).tauriWatchId, 102);
  assert.deepEqual([...h.nativeWatches], [102]);
  await h.bridge._onStopFileWatch(7);
  assert.equal(h.nativeWatches.size, 0);
});

test('reusing an active ID stops its previous native session', async () => {
  const h = makeBridge();
  const first = h.start(7);
  await tick();
  h.complete();
  await first;
  const second = h.start(7);
  await tick();
  h.complete();
  await second;
  assert.deepEqual([...h.nativeWatches], [102]);
  await h.bridge._onStopFileWatch(7);
});

test('failed starts remove pending entries without deleting a newer generation', async () => {
  const h = makeBridge();
  const oldStart = h.start(7);
  await tick();
  const newStart = h.start(7);
  await tick();
  h.nativeWatches.delete(101);
  h.starts[0].reject(new Error('native start failed'));
  await oldStart;
  assert.equal(h.bridge._activeWatches.size, 1);
  h.complete(1);
  await newStart;
  assert.equal(h.bridge._activeWatches.get(7).tauriWatchId, 102);
  await h.bridge._onStopFileWatch(7);
  const failedStart = h.start(8);
  await tick();
  h.nativeWatches.delete(103);
  h.starts[2].reject(new Error('native start failed'));
  await failedStart;
  assert.equal(h.bridge._activeWatches.size, 0);
});

for (const cleanup of ['disconnect', 'dispose', 'page unload']) {
  test(`${cleanup} clears completed and pending starts, even across reconnection`, async () => {
    const h = makeBridge();
    h.bridge._connect('ws://127.0.0.1:12345');
    const first = h.start(1);
    await tick();
    h.complete();
    await first;
    const pending = h.start(2);
    await tick();
    if (cleanup === 'disconnect') h.bridge._ws.onclose();
    else if (cleanup === 'dispose') h.bridge.dispose();
    else h.unloadCallbacks[0]();
    assert.equal(h.bridge._activeWatches.size, 0);
    await tick();
    assert.ok(!h.nativeWatches.has(101), 'completed session is stopped');
    if (cleanup === 'disconnect') {
      assert.equal(h.reconnects, 1);
      h.bridge._connected = true;
    }
    h.complete(1);
    await pending;
    assert.equal(h.bridge._activeWatches.size, 0);
    assert.equal(h.nativeWatches.size, 0, 'late native response must never resurrect a cancelled session');
  });
}

test('a native event listener that completes after disposal is immediately unregistered', async () => {
  const h = makeBridge({ delayListen: true });
  const starting = h.start();
  await tick();
  h.complete();
  await tick();
  h.bridge.dispose();
  h.listenGate.resolve();
  await starting;
  await tick();
  assert.equal(h.unlistens, 1);
  assert.equal(h.bridge._tauriWatchUnlisten, undefined);
  assert.equal(h.nativeWatches.size, 0);
});
