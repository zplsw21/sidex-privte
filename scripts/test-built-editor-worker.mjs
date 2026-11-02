// Run with: node --experimental-vm-modules scripts/test-built-editor-worker.mjs
// Load the actual production worker bundle without window/document, then exercise
// the same initialization, model synchronization and diff RPC used by the editor.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(typeof vm.SourceTextModule, 'function', 'Use --experimental-vm-modules');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const workerDirectory = path.join(root, 'dist/workers');
const candidates = process.argv[2] ? [] : (await readdir(workerDirectory))
	.filter(name => /^editorWebWorkerMain-.*\.js$/.test(name));
if (!process.argv[2]) {
	assert.equal(candidates.length, 1, 'Expected one built editor worker');
}
const workerPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(workerDirectory, candidates[0]);
const requests = new Map();
const context = vm.createContext({
	console,
	URL,
	URLSearchParams,
	TextEncoder,
	TextDecoder,
	performance,
	crypto: webcrypto,
	navigator: { userAgent: 'Mozilla/5.0 (Macintosh) WorkerSmoke', language: 'en-US' },
	location: { href: 'tauri://localhost/workers/editor.js', origin: 'tauri://localhost', protocol: 'tauri:' },
	_VSCODE_NLS_LANGUAGE: 'en',
	_VSCODE_NLS_MESSAGES: [],
	_VSCODE_FILE_ROOT: 'tauri://localhost/',
	__SIDEX_TAURI__: true,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	queueMicrotask,
	addEventListener() {},
	removeEventListener() {},
	importScripts() { throw new Error('importScripts is unavailable in module workers'); },
	postMessage(message) {
		if (message.type === 1) {
			const pending = requests.get(message.seq);
			if (!pending) return;
			requests.delete(message.seq);
			clearTimeout(pending.timeout);
			message.err ? pending.reject(message.err) : pending.resolve(structuredClone(message.res));
		}
	}
});
context.self = context;
assert.equal(vm.runInContext('typeof window', context), 'undefined');
assert.equal(vm.runInContext('typeof document', context), 'undefined');
const modules = new Map();
async function loadModule(url) {
	if (modules.has(url)) return modules.get(url);
	const module = new vm.SourceTextModule(await readFile(fileURLToPath(url), 'utf8'), {
		context,
		identifier: url,
		initializeImportMeta(meta) { meta.url = url; },
		async importModuleDynamically(specifier, referencingModule) {
			const dependency = await loadModule(new URL(specifier, referencingModule.identifier).href);
			if (dependency.status !== 'evaluated') await dependency.evaluate();
			return dependency;
		}
	});
	modules.set(url, module);
	await module.link((specifier, referencingModule) =>
		loadModule(new URL(specifier, referencingModule.identifier).href));
	return module;
}
await (await loadModule(pathToFileURL(workerPath).href)).evaluate();
assert.equal(typeof context.onmessage, 'function');
context.onmessage({ data: '-please-ignore-' });
let sequence = 0;
async function rpc(method, args = []) {
	const req = String(++sequence);
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			requests.delete(req);
			reject(new Error(`Timed out waiting for ${method}`));
		}, 5000);
		requests.set(req, { resolve, reject, timeout });
		context.onmessage({ data: { type: 0, vsWorker: 1, req, channel: 'default', method, args } });
	});
}
await rpc('$initialize', [1]);
assert.equal(await rpc('$ping'), 'pong');
const cases = [
	{ name: 'replacement', original: ['first', 'const answer = 41;', 'last'], modified: ['first', 'const answer = 42;', 'last'], range: [2, 3, 2, 3] },
	{ name: 'insertion', original: ['alpha', 'omega'], modified: ['alpha', 'beta', 'omega'], range: [2, 2, 2, 3] },
	{ name: 'deletion', original: ['alpha', 'beta', 'omega'], modified: ['alpha', 'omega'], range: [2, 3, 2, 2] },
	{ name: 'identical', original: ['same', 'content'], modified: ['same', 'content'] },
	{ name: 'Unicode and CRLF', original: ['标题', 'value = "旧";', '末尾😀'], modified: ['标题', 'value = "新";', '末尾😀'], eol: '\r\n', range: [2, 3, 2, 3] }
];
for (const algorithm of ['advanced', 'legacy']) {
	for (const test of cases) {
		const originalUrl = 'git:/smoke.ts?ref=HEAD';
		const modifiedUrl = 'file:///smoke.ts';
		for (const [url, lines] of [[originalUrl, test.original], [modifiedUrl, test.modified]]) {
			await rpc('$acceptNewModel', [{ url, lines, EOL: test.eol ?? '\n', versionId: 1 }]);
		}
		const result = await rpc('$computeDiff', [originalUrl, modifiedUrl,
			{ ignoreTrimWhitespace: false, maxComputationTimeMs: 5000, computeMoves: false }, algorithm]);
		assert.ok(result, `${algorithm}: ${test.name} returned a result`);
		assert.equal(result.quitEarly, false, `${algorithm}: ${test.name} completed`);
		assert.equal(result.identical, !test.range, `${algorithm}: ${test.name} identity`);
		assert.deepEqual(result.changes.map(change => change.slice(0, 4)), test.range ? [test.range] : [],
			`${algorithm}: ${test.name} line ranges`);
		await rpc('$acceptRemovedModel', [originalUrl]);
		await rpc('$acceptRemovedModel', [modifiedUrl]);
		console.log(`PASS ${algorithm}: ${test.name}`);
	}
}
console.log(`PASS production worker import, initialization, ping and 10 real diff cases (${path.relative(root, workerPath)})`);
