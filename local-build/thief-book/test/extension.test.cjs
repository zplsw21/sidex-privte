'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const extensionDirectory = path.resolve(__dirname, '..');

function fixture(t, content = 'abcdefghijkl') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex-thief-book-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bookPath = path.join(directory, 'synthetic.txt');
    fs.writeFileSync(bookPath, content);
    return { directory, bookPath, storagePath: path.join(directory, 'storage') };
}

function start(f, configuration = {}) {
    const settings = new Map(Object.entries(configuration));
    const configurationListeners = new Set();
    const set = settings.set.bind(settings);
    settings.set = (key, value) => {
        set(key, value);
        for (const listener of configurationListeners) {
            listener({ affectsConfiguration: section => section === key || key.startsWith(section + '.') });
        }
        return settings;
    };
    const commands = new Map();
    const warnings = [];
    const items = [];
    const vscode = {
        StatusBarAlignment: { Left: 1, Right: 2 },
        workspace: {
            onDidChangeConfiguration(listener) {
                configurationListeners.add(listener);
                return { dispose() { configurationListeners.delete(listener); } };
            },
            getConfiguration() {
                return {
                    get(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
                    update() { throw new Error('The extension must not write user configuration.'); },
                };
            },
        },
        commands: {
            registerCommand(id, handler) {
                commands.set(id, handler);
                return { dispose() { commands.delete(id); } };
            },
        },
        window: {
            createStatusBarItem(alignment, priority) {
                const item = {
                    alignment, priority, text: '', visible: false, showCount: 0, disposed: false,
                    show() { this.visible = true; this.showCount += 1; },
                    dispose() { this.visible = false; this.disposed = true; },
                };
                items.push(item);
                return item;
            },
            showWarningMessage(message) { warnings.push(message); },
            setStatusBarMessage() { throw new Error('SideX does not implement setStatusBarMessage.'); },
        },
    };
    const cache = new Map();
    function load(filename) {
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const compiled = vm.runInThisContext(
            '(function(require, module, exports) {' + fs.readFileSync(filename, 'utf8') + '\n})',
            { filename },
        );
        compiled(request => {
            if (request === 'vscode') return vscode;
            if (request.startsWith('.')) return load(path.resolve(path.dirname(filename), request + '.js'));
            return require(request);
        }, module, module.exports);
        return module.exports;
    }
    const subscriptions = [];
    load(path.join(extensionDirectory, 'out/extension.js')).activate({
        globalStorageUri: { fsPath: f.storagePath },
        extensionPath: extensionDirectory,
        subscriptions,
    });
    return {
        commands, settings, warnings, items, subscriptions,
        run(name) {
            assert.ok(commands.has('extension.' + name), 'command is registered');
            commands.get('extension.' + name)();
            return items[0].text;
        },
        state() { return JSON.parse(fs.readFileSync(path.join(f.storagePath, 'progress.json'), 'utf8')); },
    };
}

function settingsFor(f, extra = {}) {
    return { 'thiefBook.filePath': f.bookPath, 'thiefBook.pageSize': 4, ...extra };
}

test('manifest preserves the original identity, four commands and five settings', () => {
    const manifest = require('../package.json');
    assert.equal(manifest.publisher + '.' + manifest.name, 'C-TEAM.thief-book');
    assert.equal(manifest.version, '0.0.11');
    assert.deepEqual(manifest.contributes.commands.map(item => item.command).sort(), [
        'extension.displayCode', 'extension.getJumpingPage', 'extension.getNextPage', 'extension.getPreviousPage',
    ]);
    assert.deepEqual(Object.keys(manifest.contributes.configuration.properties).sort(), [
        'thiefBook.currPageNumber', 'thiefBook.filePath', 'thiefBook.isEnglish', 'thiefBook.lineBreak', 'thiefBook.pageSize',
    ]);
    assert.equal(manifest.dependencies, undefined);
    assert.deepEqual(manifest.contributes.keybindings, [
        { command: 'extension.getPreviousPage', key: 'ctrl+alt+,', mac: 'cmd+,', when: 'editorTextFocus' },
        { command: 'extension.getNextPage', key: 'ctrl+alt+.', mac: 'cmd+.', when: 'editorTextFocus' },
        { command: 'extension.getJumpingPage', key: 'ctrl+alt+;', mac: 'cmd+;' },
        { command: 'extension.displayCode', key: 'ctrl+m', mac: 'cmd+m' },
        { command: 'extension.displayCode', key: 'ctrl+alt+m', mac: 'ctrl+alt+m' },
    ]);
});

test('backup boss shortcut invokes the same global command and preserves reading progress', t => {
    const f = fixture(t);
    const app = start(f, settingsFor(f));
    const manifest = require('../package.json');
    const shortcut = manifest.contributes.keybindings.find(binding => binding.mac === 'ctrl+alt+m');
    assert.ok(shortcut, 'macOS Control+Option+M is contributed');
    assert.equal(shortcut.key, 'ctrl+alt+m');
    assert.equal(shortcut.when, undefined, 'boss shortcut is available outside the editor');
    assert.equal(app.run('getNextPage'), 'efgh    2/3');
    const before = fs.readFileSync(path.join(f.storagePath, 'progress.json'), 'utf8');
    assert.ok(app.commands.has(shortcut.command), 'shortcut references a registered command');
    app.commands.get(shortcut.command)();
    assert.match(app.items[0].text, /Hello/);
    assert.equal(fs.readFileSync(path.join(f.storagePath, 'progress.json'), 'utf8'), before);
    assert.equal(app.run('getJumpingPage'), 'efgh    2/3');
});

test('one persistent status item handles pages and preserves first/last page boundaries', t => {
    const f = fixture(t);
    const app = start(f, settingsFor(f));
    assert.equal(app.items.length, 1);
    assert.equal(app.items[0].visible, false);
    assert.equal(app.run('getJumpingPage'), 'abcd    1/3');
    assert.equal(app.run('getPreviousPage'), 'abcd    1/3');
    assert.equal(app.run('getNextPage'), 'efgh    2/3');
    assert.equal(app.run('getJumpingPage'), 'efgh    2/3');
    assert.equal(app.run('getNextPage'), 'ijkl    3/3');
    assert.equal(app.run('getNextPage'), 'ijkl    3/3');
    assert.equal(app.run('getPreviousPage'), 'efgh    2/3');
    assert.equal(app.items.length, 1);
    assert.equal(app.items[0].showCount, 7);
    assert.equal(app.items[0].visible, true);
    assert.deepEqual(app.warnings, []);
    for (const subscription of app.subscriptions) subscription.dispose();
    assert.equal(app.items[0].disposed, true);
    assert.equal(app.commands.size, 0);
});

test('first next-page command advances from the configured page like 0.0.9', t => {
    const f = fixture(t);
    const app = start(f, settingsFor(f));
    assert.equal(app.run('getNextPage'), 'efgh    2/3');
});

test('boss key replaces book text without reading a book or changing progress', t => {
    const f = fixture(t);
    const app = start(f, settingsFor(f));
    app.run('getNextPage');
    const before = fs.readFileSync(path.join(f.storagePath, 'progress.json'), 'utf8');
    const output = app.run('displayCode');
    assert.match(output, /^(Java|C\+\+|C|Python|PHP|Ruby|Perl|Lua|Scala|Golang) - /);
    assert.match(output, /Hello/);
    assert.equal(fs.readFileSync(path.join(f.storagePath, 'progress.json'), 'utf8'), before);
    assert.equal(app.run('getNextPage'), 'ijkl    3/3');
    const noBook = start(f);
    assert.match(noBook.run('displayCode'), /Hello/);
    assert.deepEqual(noBook.warnings, []);
});

test('restarting with unchanged settings resumes persisted progress without updating configuration', t => {
    const f = fixture(t);
    const settings = settingsFor(f, { 'thiefBook.currPageNumber': 1 });
    const first = start(f, settings);
    assert.equal(first.run('getNextPage'), 'efgh    2/3');
    assert.deepEqual(first.state(), {
        version: 1, filePath: f.bookPath, pageNumber: 2, configurationPageNumber: 1,
    });
    assert.equal(first.settings.get('thiefBook.currPageNumber'), 1);
    const restarted = start(f, settings);
    assert.equal(restarted.run('getJumpingPage'), 'efgh    2/3');
    assert.equal(restarted.run('getNextPage'), 'ijkl    3/3');
    assert.equal(restarted.state().pageNumber, 3);
    assert.equal(fs.statSync(path.join(f.storagePath, 'progress.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(f.storagePath), ['progress.json']);
});

test('initial host configuration delivered after activation still restores saved progress', t => {
    const f = fixture(t, 'abcdefghijklmnopqrst');
    const original = start(f, settingsFor(f, { 'thiefBook.currPageNumber': 2 }));
    assert.equal(original.run('getNextPage'), 'ijkl    3/5');
    const restarted = start(f, settingsFor(f));
    restarted.settings.set('thiefBook.currPageNumber', 2);
    assert.equal(restarted.run('getJumpingPage'), 'ijkl    3/5');
    restarted.settings.set('thiefBook.currPageNumber', 1);
    restarted.settings.set('thiefBook.currPageNumber', 2);
    assert.equal(restarted.run('getJumpingPage'), 'efgh    2/5');
});

test('explicit configuration reset before the first read overrides persisted progress', t => {
    const f = fixture(t);
    const original = start(f, settingsFor(f));
    assert.equal(original.run('getNextPage'), 'efgh    2/3');
    const restarted = start(f, settingsFor(f));
    restarted.settings.set('thiefBook.currPageNumber', 2);
    restarted.settings.set('thiefBook.currPageNumber', 1);
    assert.equal(restarted.run('getJumpingPage'), 'abcd    1/3');
    assert.equal(restarted.state().pageNumber, 1);
});

test('live reset after a delayed initial snapshot works before the first read', t => {
    const f = fixture(t, 'abcdefghijklmnopqrst');
    const original = start(f, settingsFor(f, { 'thiefBook.currPageNumber': 2 }));
    assert.equal(original.run('getNextPage'), 'ijkl    3/5');
    const restarted = start(f, settingsFor(f));
    restarted.settings.set('thiefBook.currPageNumber', 2);
    restarted.settings.set('thiefBook.currPageNumber', 1);
    restarted.settings.set('thiefBook.currPageNumber', 2);
    assert.equal(restarted.run('getJumpingPage'), 'efgh    2/5');
});

test('configuration changes take effect while an unchanged setting preserves reading progress', t => {
    const f = fixture(t, 'abcdefghijklmnopqrstuvwx');
    const app = start(f, settingsFor(f));
    app.run('getNextPage');
    app.settings.set('thiefBook.currPageNumber', 4);
    assert.equal(app.run('getJumpingPage'), 'mnop    4/6');
    app.settings.set('thiefBook.currPageNumber', 2);
    assert.equal(app.run('getNextPage'), 'ijkl    3/6');
    app.settings.set('thiefBook.currPageNumber', 1);
    assert.equal(app.run('getJumpingPage'), 'abcd    1/6');
    assert.equal(app.run('getNextPage'), 'efgh    2/6');
    assert.equal(app.run('getJumpingPage'), 'efgh    2/6');
    app.settings.set('thiefBook.currPageNumber', 2);
    app.settings.set('thiefBook.currPageNumber', 1);
    assert.equal(app.run('getJumpingPage'), 'abcd    1/6');
    app.settings.set('thiefBook.currPageNumber', 100);
    assert.equal(app.run('getJumpingPage'), 'uvwx    6/6');
    assert.deepEqual(app.warnings, []);
});

test('switching the configured book starts from its configured page', t => {
    const f = fixture(t);
    const app = start(f, settingsFor(f));
    app.run('getNextPage');
    const otherBook = path.join(f.directory, 'other-synthetic.txt');
    fs.writeFileSync(otherBook, '1234567890');
    app.settings.set('thiefBook.filePath', otherBook);
    assert.equal(app.run('getNextPage'), '5678    2/3');
    assert.equal(app.state().filePath, otherBook);
});

test('English doubles page size and original newline/indent normalization is retained', t => {
    const f = fixture(t, 'A\nB\r\nC　　D');
    const app = start(f, settingsFor(f, {
        'thiefBook.pageSize': 2, 'thiefBook.isEnglish': true, 'thiefBook.lineBreak': '|',
    }));
    assert.equal(app.run('getJumpingPage'), 'A|B     1/2');
    assert.equal(app.run('getNextPage'), '|C D    2/2');
});

test('runtime defaults work even if the host does not load contributed defaults', t => {
    const f = fixture(t, 'a'.repeat(50) + 'bc');
    const app = start(f, { 'thiefBook.filePath': f.bookPath });
    assert.equal(app.run('getJumpingPage'), 'a'.repeat(50) + '    1/2');
    assert.equal(app.run('getNextPage'), 'bc    2/2');
    const invalid = start({ ...f, storagePath: f.storagePath + '-invalid' }, {
        'thiefBook.filePath': f.bookPath, 'thiefBook.currPageNumber': NaN, 'thiefBook.pageSize': 0,
    });
    assert.equal(invalid.run('getJumpingPage'), 'a'.repeat(50) + '    1/2');
    assert.deepEqual(app.warnings, []);
});

test('missing and unreadable book paths warn without changing displayed text or persisting progress', t => {
    const f = fixture(t);
    const app = start(f);
    const cover = app.run('displayCode');
    assert.equal(app.run('getNextPage'), cover);
    assert.match(app.warnings[0], /绝对路径/);
    app.settings.set('thiefBook.filePath', path.join(f.directory, 'does-not-exist.txt'));
    assert.equal(app.run('getNextPage'), cover);
    assert.match(app.warnings[1], /无法读取/);
    assert.equal(fs.existsSync(f.storagePath), false);
});

test('corrupt progress falls back to configuration and an empty book has a stable first page', t => {
    const f = fixture(t, '');
    fs.mkdirSync(f.storagePath);
    fs.writeFileSync(path.join(f.storagePath, 'progress.json'), '{incomplete');
    const app = start(f, settingsFor(f));
    assert.equal(app.run('getJumpingPage'), '    1/1');
    assert.equal(app.run('getNextPage'), '    1/1');
    assert.equal(app.run('getPreviousPage'), '    1/1');
    assert.equal(app.state().pageNumber, 1);
});

test('invalid or unsupported saved progress is ignored instead of overriding configured pages', t => {
    const f = fixture(t);
    fs.mkdirSync(f.storagePath);
    for (const invalid of [
        { version: 1, pageNumber: 0, configurationPageNumber: 1 },
        { version: 1, pageNumber: 2.5, configurationPageNumber: 1 },
        { version: 2, pageNumber: 3, configurationPageNumber: 1 },
    ]) {
        fs.writeFileSync(path.join(f.storagePath, 'progress.json'), JSON.stringify({ filePath: f.bookPath, ...invalid }));
        const app = start(f, settingsFor(f));
        assert.equal(app.run('getNextPage'), 'efgh    2/3');
    }
});

test('progress write failure warns once while keeping readable pages and session progress', t => {
    const f = fixture(t);
    fs.writeFileSync(f.storagePath, 'not a directory');
    const app = start(f, settingsFor(f));
    assert.equal(app.run('getJumpingPage'), 'abcd    1/3');
    assert.equal(app.run('getNextPage'), 'efgh    2/3');
    assert.equal(app.run('getNextPage'), 'ijkl    3/3');
    assert.equal(app.warnings.length, 1);
    assert.match(app.warnings[0], /无法保存/);
});
