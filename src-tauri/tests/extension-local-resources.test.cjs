'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const modules = new Map();
function loadTypeScript(relative) {
  const file = path.resolve(root, relative);
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

const { URI } = loadTypeScript('src/vs/base/common/uri.ts');
const { FileAccess } = loadTypeScript('src/vs/base/common/network.ts');
const { extUri } = loadTypeScript('src/vs/base/common/resources.ts');
const semverModule = import(pathToFileURL(path.join(root, 'src/vs/base/common/semver/semver.js')).href);
const sourcePath = process.env.SIDEX_LOCAL_RESOURCE_SOURCE || path.join(root,
  'src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts');
const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
const service = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WebExtensionsScannerService');
const method = service.members.find(member => member.name?.getText(source) === 'scanInstalledExtensions');
assert.ok(method, 'test executes the actual installed extension scanner');
const methodCode = ts.transpileModule(`class Scanner { ${method.getText(source)} }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const defaultProfile = URI.file(path.join(os.tmpdir(), 'sidex-test-profiles/default/extensions.json'));
const alternateProfile = URI.file(path.join(os.tmpdir(), 'sidex-test-profiles/alternate/extensions.json'));

function setTauri(t, marker) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__SIDEX_TAURI__');
  if (marker === undefined) delete globalThis.__SIDEX_TAURI__;
  else globalThis.__SIDEX_TAURI__ = marker;
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, '__SIDEX_TAURI__', previous);
    else delete globalThis.__SIDEX_TAURI__;
  });
}

function webExtension(id, version = '1.0.0', options = {}) {
  return {
    identifier: { id }, version,
    location: URI.parse(`https://open-vsx.example/unpkg/${id}/${version}/extension`),
    metadata: {}, valid: true, ...options,
  };
}

async function makeScanner({ installed = [], application = [], native = [], failure } = {}) {
  const calls = [], imports = [], reads = [], converted = [], warnings = [], infos = [];
  const Scanner = new Function('require', 'URI', 'semver', `${methodCode}\nreturn Scanner;`)(request => {
    imports.push(request);
    assert.equal(request, '@tauri-apps/api/core');
    return {
      async invoke(command) {
        calls.push(command);
        assert.equal(command, 'list_installed_extensions');
        if (failure) throw failure;
        return native;
      },
    };
  }, URI, await semverModule);
  const scanner = new Scanner();
  scanner.uriIdentityService = { extUri };
  scanner.userDataProfilesService = { defaultProfile: { extensionsResource: defaultProfile } };
  scanner.logService = { warn: (...args) => warnings.push(args), info: message => infos.push(message) };
  scanner.readInstalledExtensions = async profile => {
    reads.push(profile);
    return [...(extUri.isEqual(profile, defaultProfile) ? application : installed)];
  };
  scanner.toScannedExtension = async (extension, isBuiltin) => {
    assert.equal(isBuiltin, false);
    converted.push(extension);
    return {
      identifier: extension.identifier, manifest: { version: extension.version },
      location: extension.location, isValid: extension.valid, metadata: extension.metadata,
    };
  };
  return { scan: (profile = alternateProfile, options) => scanner.scanInstalledExtensions(profile, options),
    calls, imports, reads, converted, warnings, infos };
}

test('Tauri uses version-matched local resources and FileAccess preserves literal path characters', async t => {
  setTauri(t, true);
  const nativePath = path.join(os.tmpdir(), "Library/Application Support/SideX/extensions/提交图 100% #?'()!");
  const installed = [
    webExtension('Mhutchie.Git-Graph', '1.30.0'),
    webExtension('fixture.http', '2.0.0', { location: URI.parse('http://gallery.example/extension') }),
    webExtension('fixture.version'), webExtension('fixture.version-build'), webExtension('fixture.missing'),
    webExtension('fixture.file', '1.0.0', { location: URI.file(path.join(os.tmpdir(), 'original/extension')) }),
    webExtension('fixture.virtual', '1.0.0', { location: URI.parse('vscode-remote://host/extension') }),
    webExtension('fixture.empty-path'),
  ];
  const native = [
    { id: 'MHUTCHIE.GIT-GRAPH', version: '1.30.0', path: nativePath },
    { id: 'fixture.http', version: '2.0.0', path: path.join(nativePath, 'http') },
    { id: 'fixture.version', version: '1.0.1', path: path.join(nativePath, 'other-version') },
    { id: 'fixture.version-build', version: '1.0.0+local', path: path.join(nativePath, 'other-build') },
    { id: 'fixture.file', version: '1.0.0', path: path.join(nativePath, 'replacement') },
    { id: 'fixture.virtual', version: '1.0.0', path: path.join(nativePath, 'virtual') },
    { id: 'fixture.empty-path', version: '1.0.0', path: '' },
  ];
  const scanner = await makeScanner({ installed, native });
  const result = await scanner.scan();
  assert.deepEqual(scanner.calls, ['list_installed_extensions'], 'read the native inventory once per scan');
  const byId = new Map(result.map(extension => [extension.identifier.id, extension]));
  const local = byId.get('Mhutchie.Git-Graph');
  assert.equal(local.location.scheme, 'file');
  assert.equal(local.location.fsPath, nativePath);
  assert.equal(byId.get('fixture.http').location.fsPath, path.join(nativePath, 'http'));
  for (const id of ['fixture.version', 'fixture.version-build', 'fixture.missing', 'fixture.file', 'fixture.virtual', 'fixture.empty-path']) {
    assert.equal(byId.get(id).location, installed.find(extension => extension.identifier.id === id).location,
      `${id} must keep its original location`);
  }
  assert.equal(installed[0].location.scheme, 'https', 'native resolution does not alter stored profile records');
  const asset = FileAccess.uriToBrowserUri(URI.joinPath(local.location, 'resources/cmd-icon-dark.svg'));
  const url = new URL(asset.toString());
  assert.equal(url.protocol, 'sidex-asset:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), path.join(nativePath, 'resources/cmd-icon-dark.svg'));
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.deepEqual(scanner.warnings, []);
});

test('native inventory failure warns and keeps scanned remote locations', async t => {
  setTauri(t, true);
  const installed = [webExtension('fixture.one'), webExtension('fixture.two')];
  const failure = new Error('native inventory unavailable');
  const scanner = await makeScanner({ installed, failure });
  const result = await scanner.scan();
  assert.deepEqual(scanner.calls, ['list_installed_extensions']);
  assert.equal(scanner.warnings.length, 1);
  assert.ok(scanner.warnings[0].includes(failure));
  assert.match(scanner.warnings[0].filter(value => typeof value === 'string').join(' '), /local extension resources/i);
  for (const extension of result) {
    assert.equal(extension.location, installed.find(input => input.identifier.id === extension.identifier.id).location);
  }
});

test('Web scans never import or invoke the Tauri inventory', async t => {
  for (const marker of [undefined, false]) {
    await t.test(`Tauri marker is ${marker}`, async subtest => {
      setTauri(subtest, marker);
      const installed = [webExtension('fixture.web')];
      const scanner = await makeScanner({ installed, failure: new Error('must not invoke native code') });
      const result = await scanner.scan();
      assert.equal(result[0].location, installed[0].location);
      assert.deepEqual(scanner.imports, []);
      assert.deepEqual(scanner.calls, []);
      assert.deepEqual(scanner.warnings, []);
    });
  }
});

test('native resource resolution preserves profile merging, version order and invalid filtering', async t => {
  setTauri(t, true);
  const installed = [
    webExtension('zeta.tool'), webExtension('alpha.tool'), webExtension('alpha.tool', '2.0.0'),
    webExtension('bad.tool', '1.0.0', { valid: false }),
    webExtension('app.stale', '9.0.0', { metadata: { isApplicationScoped: true } }),
  ];
  const application = [
    webExtension('default.only', '8.0.0'),
    webExtension('app.shared', '3.0.0', { metadata: { isApplicationScoped: true } }),
  ];
  const nativePath = path.join(os.tmpdir(), 'Library/Application Support/SideX/extensions/app.shared');
  const scanner = await makeScanner({ installed, application,
    native: [{ id: 'APP.SHARED', version: '3.0.0', path: nativePath }] });
  const filtered = await scanner.scan(alternateProfile, { skipInvalidExtensions: true });
  assert.deepEqual(filtered.map(extension => [extension.identifier.id, extension.manifest.version]), [
    ['alpha.tool', '2.0.0'], ['app.shared', '3.0.0'], ['zeta.tool', '1.0.0'],
  ]);
  assert.equal(filtered[1].location.fsPath, nativePath);
  assert.deepEqual(scanner.converted.map(extension => extension.identifier.id), ['alpha.tool', 'app.shared', 'bad.tool', 'zeta.tool']);
  assert.deepEqual(scanner.infos, ['Skipping invalid installed extension bad.tool']);
  const unfiltered = await scanner.scan(alternateProfile);
  assert.deepEqual(unfiltered.map(extension => extension.identifier.id), ['alpha.tool', 'app.shared', 'bad.tool', 'zeta.tool']);
  const defaults = await scanner.scan(defaultProfile);
  assert.deepEqual(defaults.map(extension => extension.identifier.id), ['app.shared', 'default.only']);
  assert.deepEqual(scanner.reads, [alternateProfile, defaultProfile, alternateProfile, defaultProfile, defaultProfile]);
  assert.deepEqual(scanner.calls, Array(3).fill('list_installed_extensions'));
});
