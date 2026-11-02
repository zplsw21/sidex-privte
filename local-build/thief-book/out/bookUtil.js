'use strict';

// Paging and text normalization follow C-TEAM.thief-book 0.0.9.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function positiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
        ? Math.floor(value)
        : fallback;
}

class Book {
    constructor(extensionContext) {
        const storagePath = extensionContext.globalStorageUri
            ? extensionContext.globalStorageUri.fsPath
            : extensionContext.globalStoragePath || path.join(extensionContext.extensionPath, '.global-storage');
        this.statePath = path.join(storagePath, 'progress.json');
        this.savedProgress = this.readProgress();
        this.warnedSaveError = false;
        this.observedConfigurationPageNumber = positiveInteger(
            vscode.workspace.getConfiguration().get('thiefBook.currPageNumber', 1), 1,
        );
        this.configurationPageChanged = false;
        this.configurationReady = false;
        if (vscode.workspace.onDidChangeConfiguration) {
            extensionContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('thiefBook.currPageNumber')) {
                    this.observeConfigurationPage(vscode.workspace.getConfiguration());
                    this.configurationReady = true;
                }
            }));
        }
    }

    observeConfigurationPage(config) {
        const pageNumber = positiveInteger(config.get('thiefBook.currPageNumber', 1), 1);
        if (pageNumber !== this.observedConfigurationPageNumber) {
            // The first notification can be SideX's delayed initial snapshot.
            // Subsequent changes are explicit jumps, even before the first read.
            if (this.configurationReady) this.configurationPageChanged = true;
            this.observedConfigurationPageNumber = pageNumber;
        }
        return pageNumber;
    }

    readProgress() {
        try {
            const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            if (state.version === 1 && typeof state.filePath === 'string'
                && Number.isInteger(state.pageNumber) && state.pageNumber >= 1
                && Number.isInteger(state.configurationPageNumber) && state.configurationPageNumber >= 1) {
                return state;
            }
        } catch (_) {
            // A missing or incomplete progress file falls back to the configured page.
        }
        return undefined;
    }

    init() {
        const config = vscode.workspace.getConfiguration();
        this.filePath = config.get('thiefBook.filePath', '');
        if (typeof this.filePath !== 'string' || this.filePath.trim() === '') {
            throw new Error('请填写 TXT 格式的小说文件绝对路径。');
        }
        this.configurationPageNumber = this.observeConfigurationPage(config);
        this.pageSize = positiveInteger(config.get('thiefBook.pageSize', 50), 50);
        if (config.get('thiefBook.isEnglish', false) === true) {
            this.pageSize *= 2;
        }
        const lineBreak = config.get('thiefBook.lineBreak', ' ');
        this.lineBreak = typeof lineBreak === 'string' ? lineBreak : ' ';
        this.currPageNumber = this.configurationPageNumber;
        const saved = this.savedProgress;
        if (saved && saved.filePath === path.resolve(this.filePath)
            && !this.configurationPageChanged
            && saved.configurationPageNumber === this.configurationPageNumber) {
            this.currPageNumber = saved.pageNumber;
        }
    }

    readFile() {
        let text;
        try {
            text = fs.readFileSync(this.filePath, 'utf8');
        } catch (_) {
            throw new Error('无法读取 TXT 文件，请检查文件路径和访问权限。');
        }
        return text.replace(/\n/g, this.lineBreak).replace(/\r/g, ' ').replace(/　　/g, ' ').replace(/ /g, ' ');
    }

    updatePage() {
        const state = {
            version: 1,
            filePath: path.resolve(this.filePath),
            pageNumber: this.currPageNumber,
            configurationPageNumber: this.configurationPageNumber,
        };
        this.savedProgress = state;
        this.configurationPageChanged = false;
        this.configurationReady = true;
        const temporaryPath = this.statePath + '.' + process.pid + '.tmp';
        try {
            fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
            fs.writeFileSync(temporaryPath, JSON.stringify(state) + '\n', { mode: 0o600 });
            fs.renameSync(temporaryPath, this.statePath);
        } catch (_) {
            if (!this.warnedSaveError) {
                vscode.window.showWarningMessage('无法保存 Thief-Book 阅读进度；本次会话仍可继续阅读。');
                this.warnedSaveError = true;
            }
        }
    }

    getPage(type) {
        this.init();
        const text = this.readFile();
        const totalPages = Math.max(1, Math.ceil(text.length / this.pageSize));
        let current = this.currPageNumber;
        current = Math.min(totalPages, Math.max(1, current));
        if (type === 'previous') {
            current = Math.max(1, current - 1);
        } else if (type === 'next') {
            current = Math.min(totalPages, current + 1);
        }
        this.currPageNumber = current;
        this.updatePage();
        const start = (current - 1) * this.pageSize;
        return text.substring(start, start + this.pageSize) + '    ' + current + '/' + totalPages;
    }

    getPreviousPage() {
        return this.getPage('previous');
    }

    getNextPage() {
        return this.getPage('next');
    }

    getJumpingPage() {
        return this.getPage('curr');
    }
}

exports.Book = Book;
