'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..', 'src', 'vs');

// Execute the checked-out registry, disposal implementation, decoder, resolver,
// and Workbench cache methods. Substitute only unrelated platform/event wiring.
function load(relative, dependencies, exports) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
    .replace(/^import\b[\s\S]*?;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const js = stripTypeScriptTypes(source, { mode: 'transform' });
  return new Function(...Object.keys(dependencies), `${js}\nreturn { ${exports.join(', ')} };`)(...Object.values(dependencies));
}

class Emitter {
  constructor() {
    const emitter = new EventEmitter();
    this.event = listener => {
      emitter.on('change', listener);
      return { dispose: () => emitter.off('change', listener) };
    };
    this.fire = value => emitter.emit('change', value);
  }
}

const codes = load('base/common/keyCodes.ts', {}, ['KeyCode', 'ScanCode', 'KeyMod']);
const OperatingSystem = { Windows: 1, Macintosh: 2, Linux: 3 };
const keybindings = load('base/common/keybindings.ts', {
  ...codes, OperatingSystem, illegalArgument: value => new Error(value),
}, ['decodeKeybinding']);
const { LinkedList } = load('base/common/linkedList.ts', {}, ['LinkedList']);
const { Iterable } = load('base/common/iterator.ts', {}, ['Iterable']);
const lifecycle = load('base/common/lifecycle.ts', { Iterable }, ['DisposableStore', 'toDisposable', 'combinedDisposable']);
const { ResolvedKeybindingItem } = load('platform/keybinding/common/resolvedKeybindingItem.ts', {
  CharCode: { Caret: 94 },
}, ['ResolvedKeybindingItem']);
const { KeybindingResolver } = load('platform/keybinding/common/keybindingResolver.ts', {
  ResolvedKeybindingItem, ContextKeyExprType: { False: 0, True: 1 },
}, ['KeybindingResolver']);
const { KeybindingsRegistry } = load('platform/keybinding/common/keybindingsRegistry.ts', {
  ...keybindings, ...lifecycle, LinkedList, Emitter, Event: {}, OperatingSystem, OS: OperatingSystem.Macintosh,
  CommandsRegistry: {}, Registry: { add() {} },
}, ['KeybindingsRegistry']);

const serviceSource = fs.readFileSync(path.join(root, 'workbench/services/keybinding/browser/keybindingService.ts'), 'utf8');
function method(name) {
  const start = serviceSource.search(new RegExp(`\\t(?:private|protected) ${name}\\(`));
  assert.ok(start >= 0, `missing Workbench method ${name}`);
  let end = serviceSource.indexOf('{', start);
  let depth = 1;
  while (depth && ++end < serviceSource.length) {
    if (serviceSource[end] === '{') depth++;
    if (serviceSource[end] === '}') depth--;
  }
  return serviceSource.slice(start, end + 1);
}

const methods = stripTypeScriptTypes(`class WorkbenchProbe { ${method('updateResolver')} ${method('_getResolver')} }`, { mode: 'strip' });
const WorkbenchProbe = new Function('KeybindingsRegistry', 'KeybindingResolver', `${methods}; return WorkbenchProbe;`)(KeybindingsRegistry, KeybindingResolver);
const service = new WorkbenchProbe();
const serviceDisposables = new lifecycle.DisposableStore();
let refreshes = 0;
Object.assign(service, {
  _cachedResolver: null,
  userKeybindings: { keybindings: [] },
  _onDidUpdateKeybindings: { fire() { refreshes++; } },
  _register: disposable => serviceDisposables.add(disposable),
  _resolveKeybindingItems(items) {
    return items.map(item => new ResolvedKeybindingItem({
      getDispatchChords: () => item.keybinding.chords.map(chord => `${chord.metaKey ? 'meta+' : ''}${chord.ctrlKey ? 'ctrl+' : ''}${chord.keyCode}`),
    }, item.command, item.commandArgs, item.when, true, null, false));
  },
  _resolveUserKeybindingItems: () => [],
  _log() {},
});
const listenerSource = serviceSource.match(/this\._register\(\s*KeybindingsRegistry\.onDidChange\(\(\) => this\.updateResolver\(\)\)\s*\);/)?.[0];
assert.ok(listenerSource, 'Workbench must subscribe to actual registry changes');
assert.ok(serviceSource.indexOf('this._cachedResolver = null;') < serviceSource.indexOf(listenerSource), 'cache must be initialized before subscription');
assert.ok(serviceSource.indexOf('this.userKeybindings = this._register(') < serviceSource.indexOf(listenerSource), 'user bindings must be initialized before subscription');
new Function('KeybindingsRegistry', `return function () { ${listenerSource} };`)(KeybindingsRegistry).call(service);

const period = codes.KeyMod.CtrlCmd | codes.KeyCode.Period;
const comma = codes.KeyMod.CtrlCmd | codes.KeyCode.Comma;
const baseline = KeybindingsRegistry.registerKeybindingRule({ id: 'editor.action.quickFix', weight: 100, primary: period });
const dispatch = `meta+${codes.KeyCode.Period}`;
const secondaryDispatch = `meta+${codes.KeyCode.Comma}`;
const context = { getValue: () => true };
const warm = service._getResolver();
assert.equal(warm.resolve(context, [], dispatch).commandId, 'editor.action.quickFix');

const snapshots = [];
const observer = KeybindingsRegistry.onDidChange(() => snapshots.push(KeybindingsRegistry.getDefaultKeybindings().map(item => item.command)));
const before = refreshes;
const extension = KeybindingsRegistry.registerKeybindingRule({
  id: 'extension.getNextPage', weight: 400, primary: period, secondary: [comma], args: { next: true },
});
assert.equal(refreshes, before + 1, 'one completed registration should produce one refresh');
assert.equal(service._cachedResolver, null, 'late binding must invalidate warmed Workbench cache');
const replaced = service._getResolver();
assert.notEqual(replaced, warm);
assert.deepEqual(replaced.resolve(context, [], dispatch), {
  kind: 2, commandId: 'extension.getNextPage', commandArgs: { next: true }, isBubble: false,
});
assert.equal(replaced.resolve(context, [], secondaryDispatch).commandId, 'extension.getNextPage');
assert.equal(snapshots.length, 1);
assert.equal(snapshots[0].filter(command => command === 'extension.getNextPage').length, 2, 'registration event must see both primary and secondary');

extension.dispose();
assert.equal(refreshes, before + 2, 'disposal should produce one refresh after all binding removals');
assert.equal(service._cachedResolver, null);
assert.equal(snapshots.length, 2);
assert.equal(snapshots[1].includes('extension.getNextPage'), false, 'disposal event must see a fully cleared registry cache');
assert.equal(KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Macintosh).some(item => item.command === 'extension.getNextPage'), false);
const restored = service._getResolver();
assert.equal(restored.resolve(context, [], dispatch).commandId, 'editor.action.quickFix');
assert.equal(restored.resolve(context, [], secondaryDispatch).kind, 0, 'secondary binding must also be removed');
extension.dispose();
assert.equal(refreshes, before + 2, 'repeated disposal should not trigger a second event');

const extensionRefreshes = refreshes;
KeybindingsRegistry.setExtensionKeybindings([{ id: 'extension.platformBinding', weight: 401, keybinding: keybindings.decodeKeybinding(period, OperatingSystem.Macintosh) }]);
assert.equal(refreshes, extensionRefreshes + 1, 'extension replacement should produce one refresh');
assert.equal(service._cachedResolver, null);
assert.equal(service._getResolver().resolve(context, [], dispatch).commandId, 'extension.platformBinding');
assert.equal(snapshots.at(-1).includes('extension.platformBinding'), true, 'replacement event must observe new extension bindings');
KeybindingsRegistry.setExtensionKeybindings([]);
assert.equal(refreshes, extensionRefreshes + 2, 'clearing extensions should produce one refresh');
assert.equal(service._cachedResolver, null);
assert.equal(service._getResolver().resolve(context, [], dispatch).commandId, 'editor.action.quickFix');
assert.equal(snapshots.at(-1).includes('extension.platformBinding'), false, 'clearing event must observe removal');

observer.dispose();
serviceDisposables.dispose();
baseline.dispose();
console.log('PASS: current registry + Workbench cache methods + real KeybindingResolver; late primary/secondary shortcuts replace Quick Fix; disposal restores it and notifies once; extension replacement/clear each refresh once.');
