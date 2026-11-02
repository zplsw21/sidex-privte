// Execute the current transport, readiness handshake and editor fallback sources.
// OS Worker delivery is controlled; the actual diff algorithm is covered by
// test-built-editor-worker.mjs. No application source is replaced by a copy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const files = {
  common: new URL('../src/vs/base/common/worker/webWorker.ts', import.meta.url),
  platform: new URL('../src/vs/platform/webWorker/browser/webWorkerServiceImpl.ts', import.meta.url),
  editor: new URL('../src/vs/editor/browser/services/editorWorkerService.ts', import.meta.url),
};
const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, url]) => {
  const source = await readFile(url, 'utf8');
  return [key, ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true)];
})));
function extract(file, names) {
  const source = sources[file];
  return names.map(name => {
    const node = source.statements.find(node => node.name?.text === name ||
      (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name)));
    assert.ok(node, `missing actual ${name} in ${file}`);
    return node.getText(source).replace(/^export /, '');
  }).join('\n');
}
function execute(context, code, names) {
  const javascript = ts.transpileModule(`${code}\nObject.assign(globalThis, { ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, experimentalDecorators: true },
  }).outputText;
  vm.runInContext(javascript, context);
}
class Disposable {
  disposables = new Set();
  _store = { isDisposed: false };
  _register(item) { this.disposables.add(item); return item; }
  dispose() { this._store.isDisposed = true; for (const item of this.disposables) item.dispose(); this.disposables.clear(); }
}
class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function environment() {
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    console: { warn() {}, error() {}, info() {} },
    Disposable, Emitter,
    Event: { None: () => ({ dispose() {} }) },
    CharCode: { DollarSign: '$'.charCodeAt(0) },
    strings: { isUpperAsciiLetter: code => code >= 65 && code <= 90 },
    isWeb: true,
    onUnexpectedError() {},
    transformErrorForSerialization: error => ({ $isError: true, name: error.name, message: error.message, stack: error.stack }),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    self: {},
    createTrustedTypesPolicy: () => undefined,
    toDisposable: dispose => ({ dispose }),
    queueMicrotask,
  });
  execute(context, extract('common', [
    'DEFAULT_CHANNEL', 'INITIALIZE', 'WORKER_INITIALIZATION_TIMEOUT_MS', 'WorkerTransportError', 'MessageType',
    'RequestMessage', 'ReplyMessage', 'SubscribeEventMessage', 'EventMessage', 'UnsubscribeEventMessage',
    'WebWorkerProtocol', 'WebWorkerClient', 'propertyIsEvent', 'propertyIsDynamicEvent',
  ]), ['WebWorkerProtocol', 'WebWorkerClient', 'WorkerTransportError']);
  context.logOnceWebWorkerWarning = () => {};
  execute(context, extract('platform', ['WORKER_READY_TIMEOUT_MS', 'whenESMWorkerReady', 'WebWorker']), ['whenESMWorkerReady', 'WebWorker']);
  let localWorkers = 0;
  let syncedManagers = [];
  const fallbackCalls = [];
  let fallbackError;
  Object.assign(context, {
    EditorWorker: class {
      constructor() { localWorkers++; }
      $ping() { return 'pong'; }
      $computeDiff(...args) {
        fallbackCalls.push({ worker: this, args });
        if (fallbackError) throw fallbackError;
        return { identical: true, quitEarly: false, changes: [], moves: [] };
      }
      dispose() { this.disposed = true; }
    },
    WorkerTextModelSyncClient: class {
      constructor(proxy) { this.proxy = proxy; syncedManagers.push(this); }
      ensureSyncedResources(resources) { this.resources = resources; }
      dispose() { this.disposed = true; }
    },
    EditorWorkerHost: { setChannel(worker, host) { worker.setChannel('editorWorkerHost', host); } },
    IModelService() {}, IWebWorkerService() {}, canceled: () => new Error('cancelled'),
  });
  execute(context, extract('editor', ['SynchronousWorkerClient', 'EditorWorkerClient']), ['EditorWorkerClient']);
  const computeDiff = sources.editor.statements.find(node => node.name?.text === 'EditorWorkerService')
    .members.find(node => node.name?.text === 'computeDiff');
  assert.ok(computeDiff, 'missing actual EditorWorkerService.computeDiff');
  execute(context, `class DiffService extends Disposable { ${computeDiff.getText(sources.editor)} }`, ['DiffService']);
  class HardwareWorker {
    listeners = new Set();
    terminated = false;
    posted = [];
    replyInitialize = true;
    throwOnPost = false;
    postMessage(message) {
      this.posted.push(message);
      if (this.throwOnPost) throw new Error('postMessage could not clone payload');
      if (message === '-please-ignore-') return;
      if ((message.method === '$initialize' && this.replyInitialize) || message.method === '$ping') {
        queueMicrotask(() => this.onmessage?.({ data: { type: 1, vsWorker: message.vsWorker, seq: message.req, res: message.method === '$ping' ? 'pong' : undefined } }));
      }
    }
    addEventListener(type, listener) { assert.equal(type, 'error'); this.listeners.add(listener); }
    removeEventListener(type, listener) { this.listeners.delete(listener); }
    terminate() { this.terminated = true; }
    ready() { this.onmessage?.({ data: { type: 'vscode-worker-ready' } }); }
    error(message = 'Worker crashed') {
      const event = { message };
      this.onerror?.(event);
      for (const listener of this.listeners) listener(event);
    }
    reply(method, result, error) {
      const message = this.posted.findLast(message => message?.method === method);
      assert.ok(message, `no request for ${method}`);
      this.onmessage?.({ data: { type: 1, vsWorker: message.vsWorker, seq: message.req, res: result, err: error } });
    }
  }
  function pipeline(ready) {
    const transport = new context.WebWorker(ready, 1);
    const client = new context.WebWorkerClient(transport);
    const editor = new context.EditorWorkerClient({}, false, {}, { createWorkerClient: () => client });
    const diffService = new context.DiffService();
    const acquiredResources = [];
    diffService._workerWithResources = (resources, forceLargeModels) => {
      acquiredResources.push({ resources, forceLargeModels });
      return editor.workerWithSyncedResources(resources, forceLargeModels);
    };
    diffService._register(editor);
    return { transport, client, editor, diffService, acquiredResources };
  }
  return {
    context, timers, HardwareWorker, pipeline, fallbackCalls,
    set fallbackError(error) { fallbackError = error; },
    get localWorkers() { return localWorkers; },
    get syncedManagers() { return syncedManagers; },
    expireStartupTimers() {
      const due = [...timers.values()].filter(timer => timer.delay === 30_000);
      assert.ok(due.length, 'expected bounded startup timer');
      for (const timer of due) timer.callback();
    },
  };
}

async function expectFallback(env, editor) {
  const worker = await editor.workerWithSyncedResources(['file:///fixture.ts']);
  assert.equal(env.localWorkers, 1, 'the actual editor client reached its local fallback');
  assert.equal(await worker.$ping(), 'pong');
  assert.deepEqual(env.syncedManagers.at(-1).resources, ['file:///fixture.ts']);
  editor.dispose();
}

test('ready rejection rejects initialize and reaches the actual editor fallback', async () => {
  const env = environment();
  const { editor } = env.pipeline(Promise.reject(new Error('Failed to import worker module')));
  await expectFallback(env, editor);
  assert.equal(env.timers.size, 0);
});

test('native error before ready is propagated through the readiness promise', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { editor } = env.pipeline(env.context.whenESMWorkerReady(hardware));
  const pending = expectFallback(env, editor);
  hardware.error('Worker module import failed');
  await pending;
  assert.equal(hardware.terminated, true);
  assert.equal(env.timers.size, 0);
});

test('native worker error during initialization reaches fallback and terminates transport', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  hardware.replyInitialize = false;
  const { editor } = env.pipeline(Promise.resolve(hardware));
  const pending = expectFallback(env, editor);
  await flush();
  hardware.error();
  await pending;
  assert.equal(hardware.terminated, true);
});

test('postMessage clone failure rejects initialize instead of leaving the RPC pending', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  hardware.throwOnPost = true;
  const { editor } = env.pipeline(Promise.resolve(hardware));
  await expectFallback(env, editor);
  assert.equal(hardware.terminated, true);
});

test('missing ready signal times out only startup and reaches fallback', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { editor } = env.pipeline(env.context.whenESMWorkerReady(hardware));
  const pending = expectFallback(env, editor);
  env.expireStartupTimers();
  await pending;
  assert.equal(hardware.terminated, true);
});

test('ready without initialize reply has a bounded handshake', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  hardware.replyInitialize = false;
  const { editor } = env.pipeline(Promise.resolve(hardware));
  const pending = expectFallback(env, editor);
  await flush();
  env.expireStartupTimers();
  await pending;
  assert.equal(hardware.terminated, true);
});

test('healthy ready, initialize and ping use native worker and clear startup timers', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { client } = env.pipeline(env.context.whenESMWorkerReady(hardware));
  const ping = client.proxy.$ping();
  hardware.ready();
  assert.equal(await ping, 'pong');
  assert.equal(env.localWorkers, 0);
  assert.equal(env.timers.size, 0);
  client.dispose();
});

test('worker failure rejects pending calls and later calls immediately', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { client } = env.pipeline(Promise.resolve(hardware));
  await client.proxy.$ping();
  const pending = client.proxy.$computeDiff();
  await flush();
  const failed = assert.rejects(pending, /Worker crashed/);
  hardware.error();
  await failed;
  await assert.rejects(client.proxy.$ping(), /Worker crashed/);
  client.dispose();
});

test('successful startup imposes no timeout on a long document diff RPC', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { client } = env.pipeline(Promise.resolve(hardware));
  await client.proxy.$ping();
  let settled = false;
  const pending = client.proxy.$computeDiff().then(value => { settled = true; return value; });
  await flush();
  assert.equal(env.timers.size, 0, 'no global RPC timer survives initialization');
  assert.equal(settled, false);
  hardware.reply('$computeDiff', 'long calculation completed');
  assert.equal(await pending, 'long calculation completed');
  client.dispose();
});

test('fallback discards mirror synchronization tied to the failed worker', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { editor } = env.pipeline(Promise.resolve(hardware));
  await editor.workerWithSyncedResources(['file:///before.ts']);
  const previous = env.syncedManagers[0];
  hardware.error();
  const fallback = await editor.workerWithSyncedResources(['file:///after.ts']);
  assert.equal(await fallback.$ping(), 'pong');
  assert.equal(previous.disposed, true);
  assert.equal(env.localWorkers, 1);
  assert.equal(env.syncedManagers.length, 2);
  assert.deepEqual(env.syncedManagers[1].resources, ['file:///after.ts']);
  editor.dispose();
});

for (const synchronizedBeforeFailure of [false, true]) {
  test(`concurrent ${synchronizedBeforeFailure ? 'runtime' : 'startup'} failures share the replacement worker and mirror models`, async () => {
    const env = environment();
    const hardware = new env.HardwareWorker();
    hardware.replyInitialize = synchronizedBeforeFailure;
    const { editor } = env.pipeline(Promise.resolve(hardware));
    if (synchronizedBeforeFailure) {
      await editor.workerWithSyncedResources(['file:///before.ts']);
      hardware.error();
    }
    const pending = [
      editor.workerWithSyncedResources(['file:///original.ts']),
      editor.workerWithSyncedResources(['file:///modified.ts']),
    ];
    if (!synchronizedBeforeFailure) {
      await flush();
      hardware.error();
    }
    const [originalWorker, modifiedWorker] = await Promise.all(pending);
    assert.equal(env.localWorkers, 1, 'only one fallback replaces the failed transport');
    assert.equal(originalWorker, modifiedWorker, 'both requests return the same worker');
    assert.notEqual(originalWorker.disposed, true, 'the replacement remains live');
    assert.equal(env.syncedManagers.at(-1).proxy, originalWorker, 'returned worker receives the mirror models');
    assert.equal(env.syncedManagers.length, synchronizedBeforeFailure ? 2 : 1);
    if (synchronizedBeforeFailure) assert.equal(env.syncedManagers[0].disposed, true);
    assert.deepEqual(env.syncedManagers.at(-1).resources, ['file:///modified.ts']);
    editor.dispose();
    assert.equal(env.timers.size, 0);
  });
}

const original = new URL('file:///original.ts');
const modified = new URL('file:///modified.ts');
const diffOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 5000, computeMoves: false };
function requestDiff(diffService) {
  return diffService.computeDiff(original, modified, diffOptions, 'advanced');
}
function assertDiffInFlight(hardware, count = 1) {
  assert.equal(hardware.posted.filter(message => message?.method === '$computeDiff').length, count,
    'the real computeDiff method must reach its RPC after successful initialization and ping');
}

test('actual computeDiff retries an interrupted RPC on the synchronized fallback', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { diffService, acquiredResources } = env.pipeline(Promise.resolve(hardware));
  const pending = requestDiff(diffService);
  await flush();
  assertDiffInFlight(hardware);
  hardware.error();
  assert.deepEqual(structuredClone(await pending), { identical: true, quitEarly: false, changes: [], moves: [] });
  assert.equal(env.localWorkers, 1);
  assert.equal(env.fallbackCalls.length, 1);
  assert.equal(acquiredResources.length, 2, 'retry resynchronizes the same original and modified models');
  for (const acquisition of acquiredResources) {
    assert.deepEqual(Array.from(acquisition.resources), [original, modified]);
    assert.equal(acquisition.forceLargeModels, true);
  }
  assert.equal(env.syncedManagers[0].disposed, true);
  assert.equal(env.syncedManagers[1].proxy, env.fallbackCalls[0].worker);
  assert.deepEqual(env.fallbackCalls[0].args, [original.toString(), modified.toString(), diffOptions, 'advanced']);
  diffService.dispose();
});

test('concurrent interrupted computeDiff RPCs share one fallback with synchronized models', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { diffService, acquiredResources } = env.pipeline(Promise.resolve(hardware));
  const pending = [requestDiff(diffService), requestDiff(diffService)];
  await flush();
  assertDiffInFlight(hardware, 2);
  hardware.error();
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.identical && !result.quitEarly));
  assert.equal(env.localWorkers, 1);
  assert.equal(env.fallbackCalls.length, 2);
  assert.equal(env.fallbackCalls[0].worker, env.fallbackCalls[1].worker);
  assert.equal(env.syncedManagers.length, 2);
  assert.equal(env.syncedManagers[1].proxy, env.fallbackCalls[1].worker);
  assert.equal(acquiredResources.length, 4);
  diffService.dispose();
});

test('remote algorithm exceptions, including a matching error name, are not retried', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  const { diffService, acquiredResources } = env.pipeline(Promise.resolve(hardware));
  const pending = requestDiff(diffService);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.message, 'algorithm failure');
    assert.ok(!(error instanceof env.context.WorkerTransportError));
    return true;
  });
  await flush();
  assertDiffInFlight(hardware);
  hardware.reply('$computeDiff', undefined, { $isError: true, name: 'WorkerTransportError', message: 'algorithm failure' });
  await rejected;
  assert.equal(acquiredResources.length, 1);
  assert.equal(env.localWorkers, 0);
  assert.equal(env.fallbackCalls.length, 0);
  diffService.dispose();
});

for (const transportFailsBeforeDisposal of [false, true]) {
  test(`disposing an in-flight diff ${transportFailsBeforeDisposal ? 'after transport failure' : 'normally'} does not reacquire a worker`, async () => {
    const env = environment();
    const hardware = new env.HardwareWorker();
    const { diffService, acquiredResources } = env.pipeline(Promise.resolve(hardware));
    const pending = requestDiff(diffService);
    const rejected = assert.rejects(pending, transportFailsBeforeDisposal ? /cancelled/ : /Worker disposed/);
    await flush();
    assertDiffInFlight(hardware);
    if (transportFailsBeforeDisposal) hardware.error();
    diffService.dispose();
    await rejected;
    assert.equal(acquiredResources.length, 1);
    assert.equal(env.localWorkers, 0);
    assert.equal(env.fallbackCalls.length, 0);
    assert.equal(env.timers.size, 0);
  });
}

test('a failing fallback RPC is attempted once and its error propagates', async () => {
  const env = environment();
  const fallbackError = new env.context.WorkerTransportError({ message: 'replacement failed too' });
  env.fallbackError = fallbackError;
  const hardware = new env.HardwareWorker();
  const { diffService, acquiredResources } = env.pipeline(Promise.resolve(hardware));
  const pending = requestDiff(diffService);
  const rejected = assert.rejects(pending, error => error === fallbackError);
  await flush();
  assertDiffInFlight(hardware);
  hardware.error();
  await rejected;
  assert.equal(acquiredResources.length, 2);
  assert.equal(env.fallbackCalls.length, 1);
  assert.equal(env.localWorkers, 1);
  diffService.dispose();
});


test('disposing during initialization rejects without resurrecting a local fallback', async () => {
  const env = environment();
  const hardware = new env.HardwareWorker();
  hardware.replyInitialize = false;
  const { editor } = env.pipeline(Promise.resolve(hardware));
  const pending = editor.workerWithSyncedResources(['file:///disposed.ts']);
  await flush();
  const cancelled = assert.rejects(pending, /cancelled/);
  editor.dispose();
  await cancelled;
  assert.equal(env.localWorkers, 0);
  assert.equal(env.timers.size, 0);
});
