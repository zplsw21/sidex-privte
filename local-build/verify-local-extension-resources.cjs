'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const Schemas = { file: 'file', vscodeRemote: 'vscode-remote', http: 'http', https: 'https', data: 'data', tauri: 'tauri' };
const uri = scheme => ({ scheme, toString: () => `${scheme}://local/resource` });
function loadMethod(relative, className, methodName, bindings) {
  const source = ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(s => ts.isClassDeclaration(s) && s.name.text === className);
  const method = declaration.members.find(m => m.name?.getText(source) === methodName);
  assert.ok(method, `source method exists: ${methodName}`);
  const js = ts.transpileModule(`class Probe { ${method.getText(source)} }; return Probe;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

async function main() {
  const calls = [];
  const Loader = loadMethod('src/vs/platform/extensionResourceLoader/browser/extensionResourceLoaderService.ts',
    'ExtensionResourceLoaderService', 'readExtensionResource', {
      Schemas,
      FileAccess: { uriToBrowserUri: value => value.scheme === 'file' ? uri('sidex-asset') : value },
      fetch: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, text: async () => 'native resource' };
      },
    });
  const loader = Object.assign(new Loader(), {
    _fileService: { readFile: async () => ({ value: { toString: () => 'provider resource' } }) },
    isExtensionGalleryResource: async () => false,
  });
  assert.equal(await loader.readExtensionResource(uri('file')), 'native resource');
  assert.equal(calls.at(-1).url, 'sidex-asset://local/resource');
  for (const scheme of ['http', 'https', 'data', 'tauri']) {
    assert.equal(await loader.readExtensionResource(uri(scheme)), 'native resource');
    assert.ok(calls.at(-1).url.startsWith(`${scheme}:`));
  }
  const previousCalls = calls.length;
  assert.equal(await loader.readExtensionResource(uri('vscode-userdata')), 'provider resource');
  assert.equal(calls.length, previousCalls, 'unrelated file providers retain their route');
  loader.isExtensionGalleryResource = async () => true;
  loader.getExtensionGalleryRequestHeaders = async () => ({ 'X-Probe': 'header' });
  await loader.readExtensionResource(uri('https'));
  assert.deepEqual(calls.at(-1).options, { headers: { 'X-Probe': 'header' }, mode: 'cors' });

  const Manager = loadMethod('src/vs/workbench/services/extensionManagement/common/extensionManagementService.ts',
    'ExtensionManagementService', 'installFromLocation', { Schemas });
  const routes = [];
  const server = name => ({ extensionManagementService: { installFromLocation: async (location, profile) => {
    routes.push({ name, location, profile }); return name;
  } } });
  const profile = uri('vscode-userdata');
  const services = { webExtensionManagementServer: server('web') };
  const manager = Object.assign(new Manager(), {
    extensionManagementServerService: services,
    userDataProfileService: { currentProfile: { extensionsResource: profile } },
  });
  const hadFlag = Object.hasOwn(globalThis, '__SIDEX_TAURI__');
  const previousFlag = globalThis.__SIDEX_TAURI__;
  try {
    delete globalThis.__SIDEX_TAURI__;
    await assert.rejects(manager.installFromLocation(uri('file')), /Local extension management server is not found/);
    globalThis.__SIDEX_TAURI__ = true;
    assert.equal(await manager.installFromLocation(uri('file')), 'web');
    assert.equal(routes.at(-1).profile, profile, 'local SideX installs persist to the selected profile');
    services.localExtensionManagementServer = server('local');
    assert.equal(await manager.installFromLocation(uri('file')), 'local', 'native local server retains priority');
    delete services.localExtensionManagementServer;
    services.remoteExtensionManagementServer = server('remote');
    assert.equal(await manager.installFromLocation(uri('vscode-remote')), 'remote');
    delete services.remoteExtensionManagementServer;
    await assert.rejects(manager.installFromLocation(uri('vscode-remote')), /Remote extension management server is not found/);
    assert.equal(await manager.installFromLocation(uri('https')), 'web');
    delete services.webExtensionManagementServer;
    await assert.rejects(manager.installFromLocation(uri('file')), /Web extension management server is not found/);
  } finally {
    if (hadFlag) globalThis.__SIDEX_TAURI__ = previousFlag;
    else delete globalThis.__SIDEX_TAURI__;
  }
  console.log('PASS: actual source methods preserve web/native/remote routing and load local SideX resources through sidex-asset.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
