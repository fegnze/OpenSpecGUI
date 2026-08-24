'use strict';

var childProcess = require('node:child_process');
var fs = require('node:fs');
var path = require('node:path');

var roots = ['src', 'test', 'scripts'];
var files = [];

function collect(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
        var target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect(target);
        } else if (entry.isFile() && /\.js$/i.test(entry.name)) {
            files.push(target);
        }
    });
}

roots.forEach(function (root) {
    if (fs.existsSync(root)) {
        collect(root);
    }
});

files.forEach(function (file) {
    childProcess.execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
});

console.log('Syntax check passed for ' + files.length + ' files.');
