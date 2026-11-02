'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const host = require('../extension-host/host.cjs');
const vscode = require('vscode');

function createWebview(kind) {
  if (kind === 'editor panel') {
    const panel = vscode.window.createWebviewPanel('resource-test', 'Resource test', 1, { enableScripts: true });
    return {
      webview: panel.webview,
      matches: event => event.type === 'webviewHtmlUpdate' && event.panelId === panel._panelId,
      dispose: () => panel.dispose(),
    };
  }

  const viewId = 'resource-test.sidebar';
  const webviewHandle = 'resource-test-sidebar';
  let view;
  const registration = vscode.window.registerWebviewViewProvider(viewId, {
    resolveWebviewView(resolvedView) { view = resolvedView; },
  });
  host._handleResolveWebviewView(1, { viewId, webviewHandle });
  assert.ok(view, 'the real host resolves the registered sidebar provider');
  return {
    webview: view.webview,
    matches: event => event.type === 'webviewViewHtmlUpdate' && event.webviewHandle === webviewHandle,
    dispose() {
      host._handleWebviewViewDispose(2, { webviewHandle });
      registration.dispose();
    },
  };
}

for (const kind of ['editor panel', 'sidebar view']) {
  test(`${kind} loads local CSS and JavaScript through the actual host`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex-webview-resources-'));
    const target = createWebview(kind);
    const events = [];
    const onEvent = event => { if (target.matches(event)) events.push(event); };
    host.on('event', onEvent);
    try {
      const paths = [
        ['ordinary path', 'extensions/git-graph/media'],
        ['Application Support', 'Library/Application Support/SideX/extensions/mhutchie.git-graph/media'],
        ['Unicode', '扩展/提交图/media'],
        ['literal percent', 'extensions/100%/media'],
        ['hash', 'extensions/branch#1/media'],
        ['question mark', 'extensions/branch?1/media'],
        ['single quote', "extensions/user's-extension/media"],
        ['parentheses', 'extensions/git-graph (copy)/media'],
      ];
      for (const [name, relative] of paths) {
        await t.test(name, () => {
          const media = path.join(directory, relative);
          fs.mkdirSync(media, { recursive: true });
          const css = '#commitGraph { color: rgb(1, 2, 3); }';
          const script = 'globalThis.webviewFixture = "loaded";';
          fs.writeFileSync(path.join(media, 'out.min.css'), css);
          fs.writeFileSync(path.join(media, 'out.min.js'), script);
          const resourceUrl = file => {
            const filePath = path.join(media, file);
            const resource = target.webview.asWebviewUri(vscode.Uri.file(filePath));
            assert.equal(resource.path, filePath, 'URI path keeps its filesystem semantics');
            assert.equal(resource.fsPath, filePath);
            const url = new URL(resource.toString());
            assert.equal(decodeURIComponent(url.pathname), filePath, 'URL round-trips literal path characters');
            assert.equal(url.search, '');
            assert.equal(url.hash, '');
            return resource.toString();
          };

          const before = events.length;
          target.webview.html = `<link rel="stylesheet" href="${resourceUrl('out.min.css')}"><script nonce="fixture" src="${resourceUrl('out.min.js')}"></script>`;
          assert.equal(events.length, before + 1);
          const html = events.at(-1).html;
          assert.ok(html.includes(`<style>${css}</style>`), 'CSS must reach the emitted HTML');
          assert.ok(html.includes(`<script>${script}</script>`), 'JavaScript must reach the emitted HTML');
          assert.ok(!html.includes('vscode-resource.vscode-cdn.net'), 'local assets must not remain network requests');
          const context = {};
          vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
          assert.equal(context.webviewFixture, 'loaded');
        });
      }

      await t.test('HTTP and HTTPS resources pass through unchanged', () => {
        for (const scheme of ['http', 'https']) {
          const uri = vscode.Uri.parse(`${scheme}://example.com/assets/out.min.js?version=1#source`);
          assert.equal(target.webview.asWebviewUri(uri), uri);
        }
      });
    } finally {
      host.off('event', onEvent);
      target.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
