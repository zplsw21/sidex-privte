'use strict';

// Adapted from C-TEAM.thief-book 0.0.9 for SideX's extension host.
const vscode = require('vscode');
const { Book } = require('./bookUtil');

const codeExamples = [
    'Java - System.out.println("Hello World");',
    'C++ - cout << "Hello, world!" << endl;',
    'C - printf("Hello, World!");',
    'Python - print("Hello, World!")',
    'PHP - echo "Hello World!";',
    'Ruby - puts "Hello World!";',
    'Perl - print "Hello, World!";',
    'Lua - print("Hello World!")',
    'Scala - println("Hello, world!")',
    'Golang - fmt.Println("Hello, World!")',
];

function activate(context) {
    const books = new Book(context);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1000);
    status.name = 'Thief-Book';
    status.tooltip = 'Thief-Book';
    context.subscriptions.push(status);

    const display = text => {
        status.text = text;
        status.show();
    };
    const readPage = method => {
        try {
            display(books[method]());
        } catch (error) {
            vscode.window.showWarningMessage(error.message);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.displayCode', () => {
            display(codeExamples[Math.floor(Math.random() * codeExamples.length)]);
        }),
        vscode.commands.registerCommand('extension.getPreviousPage', () => readPage('getPreviousPage')),
        vscode.commands.registerCommand('extension.getNextPage', () => readPage('getNextPage')),
        vscode.commands.registerCommand('extension.getJumpingPage', () => readPage('getJumpingPage')),
    );
}

exports.activate = activate;
