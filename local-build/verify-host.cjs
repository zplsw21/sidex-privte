'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const sourceRoot = path.join(root, 'src', 'vs');
const host = require(path.join(root, 'src-tauri/extension-host/host.cjs'));
const vscode = require('vscode');
host.initialize();

// Execute the checked-out parser and frontend methods. Service doubles keep
// this check independent of the workbench build and any personal book files.
function load(relative, dependencies, exports) {
  const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8')
    .replace(/^import\b[\s\S]*?;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const js = stripTypeScriptTypes(source, { mode: 'transform' });
  return new Function(...Object.keys(dependencies), `${js}\nreturn { ${exports.join(', ')} };`)(...Object.values(dependencies));
}
const codes = load('base/common/keyCodes.ts', {}, ['KeyCode', 'ScanCode', 'KeyMod', 'KeyChord', 'KeyCodeUtils', 'ScanCodeUtils']);
const keybindings = load('base/common/keybindings.ts', {
  ...codes, OperatingSystem: { Windows: 1, Macintosh: 2, Linux: 3 }, illegalArgument: value => new Error(value),
}, ['KeyCodeChord', 'ScanCodeChord', 'Keybinding']);
const { KeybindingParser } = load('base/common/keybindingParser.ts', { ...codes, ...keybindings }, ['KeybindingParser']);

const frontend = fs.readFileSync(path.join(sourceRoot, 'workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts'), 'utf8');
function method(name) {
  const start = frontend.indexOf(`\tprivate ${name}(`);
  assert.ok(start >= 0, `missing frontend method ${name}`);
  let cursor = frontend.indexOf('{', start);
  let depth = 1;
  while (depth && ++cursor < frontend.length) {
    if (frontend[cursor] === '{') depth++;
    if (frontend[cursor] === '}') depth--;
  }
  return frontend.slice(start, cursor + 1);
}
const names = [
  '_applyBootstrap', '_registerManifestContributions', '_syncExtensionConfiguration', '_onCommandRegistered',
  '_connect', '_handleMessage', '_toWorkbenchAlignment', '_makeStatusbarEntry',
  '_onStatusBarItemShow', '_onStatusBarItemUpdate', '_onStatusBarItemHide', '_onStatusBarItemRemove',
];
const methods = stripTypeScriptTypes(`class Bridge {\n${names.map(method).join('\n')}\n}`, { mode: 'strip' });
const entries = new Map();
const commands = new Map();
const menus = new Map();
const bindings = [];
const schemas = { 'probe.existing': { type: 'number', default: 10 } };
const registeredNodes = [];
const logs = [];
const registry = {
  getConfigurationProperties: () => schemas,
  registerConfiguration(node) { registeredNodes.push(node); Object.assign(schemas, node.properties); return node; },
  deregisterConfigurations(nodes) { nodes.forEach(node => Object.keys(node.properties).forEach(key => delete schemas[key])); },
};
class WebSocketProbe {
  static OPEN = 1;
  constructor(endpoint) { this.endpoint = endpoint; this.readyState = WebSocketProbe.OPEN; }
}
const globals = {
  ...codes, ...keybindings, KeybindingParser,
  StatusbarAlignment: { LEFT: 0, RIGHT: 1 },
  Registry: { as: () => registry },
  ConfigurationExtensions: { Configuration: 'configuration' },
  toDisposable: dispose => ({ dispose }),
  CommandsRegistry: {
    getCommand: id => commands.get(id),
    registerCommand(id, handler) {
      assert.equal(commands.has(id), false, 'existing command must not be replaced');
      commands.set(id, handler);
      return { dispose: () => commands.delete(id) };
    },
  },
  MenuRegistry: {
    getCommand: id => menus.get(id),
    addCommand(command) {
      assert.equal(menus.has(command.id), false, 'existing palette metadata must not be replaced');
      menus.set(command.id, command);
      return { dispose: () => menus.delete(command.id) };
    },
  },
  ContextKeyExpr: {
    deserialize: value => value,
    and: (...clauses) => [...new Set(clauses.filter(Boolean))].join(' && ') || undefined,
  },
  isMacintosh: true,
  isWindows: false,
  KeybindingWeight: { BuiltinExtension: 300, ExternalExtension: 400 },
  KeybindingsRegistry: {
    registerKeybindingRule(rule) { bindings.push(rule); return { dispose: () => bindings.splice(bindings.indexOf(rule), 1) }; },
  },
  WebSocket: WebSocketProbe,
  window: { addEventListener() {} },
};
const Bridge = new Function(...Object.keys(globals), `${methods}\nreturn Bridge;`)(...Object.values(globals));
const bridge = new Bridge();
const configurationListeners = [];
const values = new Map([['probe.pageSize', 75]]);
Object.assign(bridge, {
  _statusBarItems: new Map(),
  _pendingCallbacks: new Map(),
  _registeredCommands: new Map(),
  _extensionConfigurationDefaults: new Map(),
  logService: { info: message => logs.push(message), warn: (...args) => assert.fail(args.join(' ')) },
  statusbarService: {
    addEntry(entry, id, alignment, priority) {
      assert.equal(entries.has(id), false, 'duplicate statusbar entry');
      const state = { entry, alignment, priority, updates: 0 };
      entries.set(id, state);
      return {
        update(value) { state.entry = value; state.updates++; },
        dispose() { entries.delete(id); },
      };
    },
  },
  _register(disposable) { this.disposables.push(disposable); return disposable; },
  disposables: [],
  _request: async (type, params) => ({ type, params }),
  configurationService: {
    getValue: key => values.get(key),
    onDidChangeConfiguration(listener) {
      configurationListeners.push(listener);
      return { dispose: () => configurationListeners.splice(configurationListeners.indexOf(listener), 1) };
    },
  },
  workspaceContextService: { getWorkspace: () => ({ folders: [] }) },
  _syncDocumentsToWasm() {},
  _syncOpenDocuments() {},
  _syncActiveEditor() {},
  _startEditorTracking() {},
  _nextId: () => 50,
  _send(message) {
    this.messages.push(message);
    if (message.type === 'setConfiguration') host.handleMessage(message);
  },
  messages: [],
});

host.on('event', event => bridge._handleMessage(event));

async function main() {
  const item = vscode.window.createStatusBarItem('probe.reader', vscode.StatusBarAlignment.Right, 20);
  item.name = 'Reading probe';
  item.text = 'Synthetic page one';
  item.tooltip = new vscode.MarkdownString('Probe tooltip');
  item.command = 'probe.next';
  assert.equal(entries.size, 0, 'hidden item must not render');
  item.show();
  assert.deepEqual(entries.get('probe.reader'), {
    entry: { name: 'Reading probe', text: 'Synthetic page one', ariaLabel: 'Reading probe', tooltip: 'Probe tooltip', command: 'probe.next' },
    alignment: 1, priority: 20, updates: 0,
  });
  item.text = 'Synthetic page two';
  assert.equal(entries.get('probe.reader').entry.text, 'Synthetic page two');
  item.show();
  assert.equal(entries.size, 1);
  assert.equal(entries.get('probe.reader').updates, 2);
  item.hide();
  assert.equal(entries.size, 0);
  item.text = 'Synthetic page three';
  assert.equal(entries.size, 0);
  item.show();
  assert.equal(entries.get('probe.reader').entry.text, 'Synthetic page three');
  item.dispose();
  assert.equal(entries.size, 0);
  assert.ok(logs.every(line => !line.includes('Synthetic page')), 'statusbar logs must omit page text');

  commands.set('probe.existingCommand', () => 'existing');
  menus.set('probe.existingCommand', { title: 'Existing title' });
  const manifest = { contributes: {
    commands: [
      { command: 'probe.next', title: 'Probe: Next', category: 'Probe', enablement: 'probe.enabled' },
      { command: 'probe.existingCommand', title: 'Do not replace' },
    ],
    keybindings: [{ command: 'probe.next', key: 'ctrl+alt+.', mac: 'ctrl+alt+.', when: 'editorTextFocus', args: { count: 2 } }],
    configuration: { title: 'Probe', type: 'object', properties: {
      'probe.pageSize': { type: 'number', default: 50 },
      'probe.existing': { type: 'number', default: 10 },
    } },
  } };
  bridge._applyBootstrap({ extensions: [], initDataJson: JSON.stringify({ extensions: [
    { packageJson: manifest },
    { packageJSON: { contributes: { commands: [{ command: 'probe.legacy', title: 'Legacy JSON casing' }] } } },
    { isBuiltin: true, packageJson: { contributes: {
      commands: [{ command: 'probe.builtin', title: 'Built-in probe', enablement: '!operationInProgress' }],
      keybindings: [
        { command: 'probe.builtin', key: 'ctrl+alt+b', when: 'editorTextFocus' },
        { command: 'probe.builtin', key: 'ctrl+alt+c' },
      ],
    } } },
  ] }) });
  const nextHandler = commands.get('probe.next');
  bridge._onCommandRegistered('probe.next');
  assert.equal(commands.get('probe.next'), nextHandler, 'host event must retain manifest command registration');
  assert.deepEqual(await nextHandler(null, { count: 3 }), {
    type: 'executeCommand', params: { command: 'probe.next', args: [{ count: 3 }] },
  });
  assert.equal(commands.get('probe.existingCommand')(), 'existing');
  assert.equal(menus.get('probe.existingCommand').title, 'Existing title');
  assert.equal(menus.get('probe.next').title, 'Probe: Next');
  assert.equal(menus.get('probe.next').precondition, 'probe.enabled');
  assert.equal(menus.get('probe.legacy').title, 'Legacy JSON casing');
  assert.equal(bindings.length, 3);
  assert.equal(bindings[0].primary, codes.KeyMod.WinCtrl | codes.KeyMod.Alt | codes.KeyCode.Period);
  assert.equal(bindings[0].when, 'probe.enabled && editorTextFocus', 'shortcut must honor command enablement');
  assert.equal(bindings[0].weight, 400);
  assert.deepEqual(bindings[0].args, { count: 2 });
  assert.equal(bindings[1].when, '!operationInProgress && editorTextFocus');
  assert.equal(bindings[1].weight, 300, 'built-in shortcuts must retain built-in priority');
  assert.equal(bindings[2].when, '!operationInProgress', 'enablement also applies without a keybinding when clause');
  assert.equal(bindings[2].weight, 301, 'manifest binding order must retain its priority offset');
  assert.equal(registeredNodes.length, 1);
  assert.deepEqual(Object.keys(registeredNodes[0].properties), ['probe.pageSize']);
  assert.equal(configurationListeners.length, 1);

  bridge._connect('ws://127.0.0.1:12345');
  bridge._ws.onopen();
  assert.equal(bridge.messages[0].type, 'initialize');
  assert.deepEqual(bridge.messages[1].params.settings, { 'probe.pageSize': 75, 'probe.existing': 10 });
  assert.equal(vscode.workspace.getConfiguration('probe').get('pageSize'), 75);
  assert.equal(vscode.workspace.getConfiguration('probe').get('existing'), 10);
  const initialMessages = bridge.messages.length;
  configurationListeners[0]({ affectsConfiguration: key => key === 'unrelated.setting' });
  assert.equal(bridge.messages.length, initialMessages, 'unrelated settings must not sync');
  values.set('probe.pageSize', 90);
  configurationListeners[0]({ affectsConfiguration: key => key === 'probe.pageSize' });
  assert.equal(vscode.workspace.getConfiguration('probe').get('pageSize'), 90);
  values.delete('probe.pageSize');
  configurationListeners[0]({ affectsConfiguration: key => key === 'probe.pageSize' });
  assert.equal(vscode.workspace.getConfiguration('probe').get('pageSize'), 50, 'reset must restore manifest default');
  bridge._connect('ws://127.0.0.1:12345');
  bridge._ws.onopen();
  assert.equal(bridge.messages.at(-1).params.settings['probe.pageSize'], 50, 'reconnect must resync settings');

  for (const disposable of bridge.disposables) disposable.dispose();
  for (const disposable of bridge._registeredCommands.values()) disposable.dispose();
  assert.equal(commands.has('probe.next'), false);
  assert.equal(commands.has('probe.legacy'), false);
  assert.equal(commands.get('probe.existingCommand')(), 'existing');
  assert.equal(menus.has('probe.next'), false);
  assert.equal(bindings.length, 0);
  assert.equal(schemas['probe.pageSize'], undefined);
  assert.equal(configurationListeners.length, 0);
  console.log('PASS: current host/statusbar bridge; manifest commands and palette titles without duplicates; actual macOS shortcut parsing; schemas/defaults; initial, live, reset and reconnect configuration sync.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
