// Run with: node --experimental-vm-modules scripts/test-worker-nls.mjs
// Exercise actual NLS loader, worker bootstrap source and extension-host iframe.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

assert.equal(typeof vm.SourceTextModule, 'function', 'Use --experimental-vm-modules');
const root = fileURLToPath(new URL('..', import.meta.url));
const sources = Object.fromEntries(await Promise.all([
	['loader', 'src/nls-loader.ts'],
	['nls', 'src/vs/nls.ts'],
	['bootstrap', 'src/vs/platform/webWorker/browser/webWorkerServiceImpl.ts'],
	['host', 'src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts'],
	['iframe', 'src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html']
].map(async ([name, file]) => [name, await readFile(path.join(root, file), 'utf8')])));
const transpile = code => ts.transpileModule(code, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const quietConsole = { log() {}, warn() {}, error: console.error };
const workerTranslation = '中文："双引号"、\'单引号\'、`反引号`\n${globalThis.__injected = true} {0} </script> 😀';
const translations = { 'fixture.indexed': '主线程翻译', 'fixture.worker': workerTranslation };
const entries = [
	{ key: 'fixture.indexed', msg: 'Main thread translation' },
	{ key: 'fixture.missing', msg: 'Fallback remains' }
];

async function evaluateModule(code, context, importModuleDynamically) {
	const module = new vm.SourceTextModule(code, { context, importModuleDynamically });
	await module.link(() => { throw new Error('Unexpected static import'); });
	await module.evaluate();
	return module.namespace;
}

async function loadLocale(indexed) {
	const storage = new Map([
		['vscode.nls.locale', 'zh-cn'],
		['vscode.nls.languagePackExtensionId', 'fixture.language-pack']
	]);
	const context = vm.createContext({
		console: quietConsole,
		localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
		fetch: async url => {
			assert.equal(url, '/nls.messages.json');
			return { ok: indexed, headers: { get: () => 'application/json' }, json: async () => entries };
		}
	});
	const loader = await evaluateModule(transpile(sources.loader), context, async specifier => {
		assert.equal(specifier, '@tauri-apps/api/core');
		const module = new vm.SyntheticModule(['invoke'], function () {
			this.setExport('invoke', async command => {
				if (command === 'get_env') return '/fixture-home';
				assert.equal(command, 'read_file');
				return JSON.stringify({ contents: { fixture: translations } });
			});
		}, { context });
		await module.link(() => {});
		await module.evaluate();
		return module;
	});
	await loader.loadNlsMessages();
	const nls = await evaluateModule(transpile(sources.nls), context);
	assert.equal(context._VSCODE_NLS_LANGUAGE, 'zh-cn');
	assert.equal(context._VSCODE_NLS_TRANSLATIONS['fixture.worker'], workerTranslation);
	assert.equal(nls.localize('fixture.worker', 'Worker fallback', '参数'), workerTranslation.replace('{0}', '参数'));
	assert.equal(nls.localize('remoteExplorer', 'Remote Explorer'), '远程资源管理器');
	if (indexed) {
		assert.equal(nls.localize(0, 'Main thread fallback'), '主线程翻译');
		assert.equal(nls.localize(1, 'Wrong fallback'), 'Fallback remains');
		assert.equal(nls.localize2(0, 'Main thread translation').value, '主线程翻译');
	} else {
		assert.equal(nls.localize('fixture.missing', 'Fallback remains'), 'Fallback remains');
	}
	console.log(`PASS actual locale loader: ${indexed ? 'indexed messages retained with key dictionary' : 'key-mode translations and fallback'}`);
	return context;
}

const main = await loadLocale(true);
await loadLocale(false);
const english = vm.createContext({
	console: quietConsole,
	localStorage: { getItem: key => key === 'vscode.nls.locale' ? 'en' : null }
});
await (await evaluateModule(transpile(sources.loader), english)).loadNlsMessages();
assert.equal(english._VSCODE_NLS_TRANSLATIONS, undefined);
assert.equal(english._VSCODE_NLS_MESSAGES, undefined);
const englishNls = await evaluateModule(transpile(sources.nls), english);
assert.equal(englishNls.localize('fixture.worker', 'Worker fallback'), 'Worker fallback');
console.log('PASS actual English locale loader: no language pack required and fallback retained');

function findNode(source, predicate) {
	const tree = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
	let found;
	function visit(node) {
		if (!found && predicate(node, tree)) found = node;
		if (!found) ts.forEachChild(node, visit);
	}
	visit(tree);
	assert.ok(found, 'Expected source node was found');
	return found.getText(tree);
}

const bootstrapFunction = findNode(sources.bootstrap,
	node => ts.isFunctionDeclaration(node) && node.name?.text === 'getWorkerBootstrapUrl');
const hostPayloadCall = findNode(sources.host, (node, tree) =>
	ts.isCallExpression(node) && node.expression.getText(tree).includes('iframe.contentWindow!.postMessage') &&
	node.arguments[0]?.getText(tree).includes('nls:'));

function blobEnvironment(extra = {}) {
	const blobs = new Map();
	class CapturingURL extends URL {
		static createObjectURL(blob) {
			const url = `blob:worker-nls-${blobs.size}`;
			blobs.set(url, blob);
			return url;
		}
	}
	const context = vm.createContext({ console: quietConsole, URL: CapturingURL, URLSearchParams, Blob, ...extra });
	context.self = context;
	return { context, blobs };
}

async function verifyWorkerBlob(blob, expectedImport, expectReady = false, locale = main) {
	const messages = [];
	const context = vm.createContext({ postMessage: message => messages.push(message) });
	assert.equal(vm.runInContext('typeof window', context), 'undefined');
	assert.equal(vm.runInContext('typeof document', context), 'undefined');
	let imports = 0;
	await evaluateModule(await blob.text(), context, async specifier => {
		assert.equal(specifier, expectedImport);
		assert.equal(context._VSCODE_NLS_TRANSLATIONS?.['fixture.worker'], locale._VSCODE_NLS_TRANSLATIONS?.['fixture.worker']);
		assert.equal(context._VSCODE_NLS_LANGUAGE, locale._VSCODE_NLS_LANGUAGE);
		assert.equal(context._VSCODE_NLS_MESSAGES?.[0], locale._VSCODE_NLS_MESSAGES?.[0]);
		assert.equal(context.__injected, undefined, 'Translation text must remain data');
		const module = new vm.SourceTextModule(transpile(sources.nls), { context });
		await module.link(() => {});
		await module.evaluate();
		assert.equal(module.namespace.localize('fixture.worker', 'Fallback', '参数'),
			locale._VSCODE_NLS_TRANSLATIONS ? workerTranslation.replace('{0}', '参数') : 'Fallback');
		assert.equal(module.namespace.localize(0, 'Fallback'), locale._VSCODE_NLS_MESSAGES?.[0] ?? 'Fallback');
		imports++;
		return module;
	});
	assert.equal(imports, 1);
	assert.equal(context.__injected, undefined);
	assert.equal(messages.some(message => message.type === 'vscode-worker-ready'), expectReady);
}

for (const locale of [main, english]) {
for (const label of ['editorWorkerService', 'TextMateWorker']) {
	const environment = blobEnvironment({
		origin: 'tauri://localhost',
		_VSCODE_NLS_TRANSLATIONS: locale._VSCODE_NLS_TRANSLATIONS,
		_VSCODE_FILE_ROOT: 'tauri://localhost/',
		__SIDEX_TAURI__: true,
		getNLSMessages: () => locale._VSCODE_NLS_MESSAGES,
		getNLSLanguage: () => locale._VSCODE_NLS_LANGUAGE,
		coalesce: values => values.filter(value => value !== undefined && value !== null),
		COI: { addSearchParam() {} }
	});
	vm.runInContext(transpile(bootstrapFunction), environment.context);
	const url = environment.context.getWorkerBootstrapUrl(label, 'tauri://localhost/workers/fixture.js', undefined);
	await verifyWorkerBlob(environment.blobs.get(url), 'tauri://localhost/workers/fixture.js', true, locale);
	console.log(`PASS actual ${label} blob: ${locale === main ? 'Chinese dictionary and indexed values preserved, escaping safe' : 'undefined NLS values and English fallback'}`);
}
}

const script = sources.iframe.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);
const cspHash = createHash('sha256').update(script).digest('base64');
assert.ok(sources.iframe.includes(`'sha256-${cspHash}'`), 'Iframe CSP matches the exact inline script');
for (const locale of [main, english]) {
	const parentMessages = [];
	const workers = [];
	const iframeEnvironment = blobEnvironment({
	document: { location: { href: 'tauri://localhost/iframe.html?parentOrigin=tauri%3A%2F%2Flocalhost&vscodeWebWorkerExtHostId=fixture' } },
	location: { hostname: 'localhost' },
	window: { origin: 'tauri://localhost', parent: { postMessage: message => parentMessages.push(message) } },
	Worker: class {
		constructor(url, options) { this.url = url; this.options = options; workers.push(this); }
		postMessage() {}
	}
});
vm.runInContext(script, iframeEnvironment.context);
assert.equal(parentMessages[0].type, 'vscode.bootstrap.nls');
const payloadEnvironment = vm.createContext({
	_VSCODE_NLS_TRANSLATIONS: locale._VSCODE_NLS_TRANSLATIONS,
	_VSCODE_FILE_ROOT: 'tauri://localhost/',
	getNLSMessages: () => locale._VSCODE_NLS_MESSAGES,
	getNLSLanguage: () => locale._VSCODE_NLS_LANGUAGE,
	event: { data: parentMessages[0] },
	extensionHostWorkerMainDescriptor: {},
	iframe: { contentWindow: { postMessage(message) { payloadEnvironment.payload = structuredClone(message); } } },
	host: { _webWorkerService: { getWorkerUrl: () => 'tauri://localhost/workers/extension-host.js' } }
});
vm.runInContext(transpile(`(function () { ${hostPayloadCall}; }).call(host);`), payloadEnvironment);
const payload = payloadEnvironment.payload;
assert.equal(payload.data.nls.translations?.['fixture.worker'], locale._VSCODE_NLS_TRANSLATIONS?.['fixture.worker']);
iframeEnvironment.context.onmessage({ origin: 'https://unexpected.invalid', data: payload });
assert.equal(workers.length, 0, 'Untrusted origin cannot bootstrap a worker');
iframeEnvironment.context.onmessage({ origin: 'tauri://localhost', data: payload });
assert.equal(workers.length, 1);
assert.equal(workers[0].options.type, 'module');
await verifyWorkerBlob(iframeEnvironment.blobs.get(workers[0].url), 'tauri://localhost/workers/extension-host.js', false, locale);
console.log(`PASS actual extension-host payload → iframe → worker: ${locale === main ? 'Chinese dictionary' : 'undefined NLS and English fallback'}, CSP SHA256 ${cspHash}`);
}
