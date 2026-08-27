'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var workspaceModule = require('../src/core/workspace');

test('扫描后的文档被替换为目录外符号链接时拒绝读取', async function () {
    var fixture = await fixtures.createFixtureProject();
    var specPath = path.join(fixture.root, 'openspec', 'specs', 'core', 'spec.md');
    try {
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        await fsPromises.unlink(specPath);
        await fsPromises.symlink(fixture.outsideFile, specPath);
        await assert.rejects(function () {
            return workspaceModule.readWorkspaceDocument(workspace, 'openspec/specs/core/spec.md');
        }, function (error) { return error.code === 'PATH_FORBIDDEN'; });
    } finally {
        await fixture.cleanup();
    }
});

test('renderer 不使用 HTTP transport 或直接 Node 能力', async function () {
    var renderer = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    var initiativeAppHost = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'initiative-app-host.js'), 'utf8');
    var preload = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');
    var main = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
    var html = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

    assert.doesNotMatch(renderer, /\bfetch\s*\(/);
    assert.doesNotMatch(renderer, /navigator\.clipboard|require\s*\(/);
    assert.doesNotMatch(initiativeAppHost, /\bfetch\s*\(|require\s*\(|iframe|webview/);
    assert.match(preload, /contextBridge\.exposeInMainWorld\('openSpecGUI'/);
    assert.doesNotMatch(preload, /provider\.call|readPath|exec|spawn|environment|network/);
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /sandbox:\s*true/);
    assert.match(main, /nodeIntegration:\s*false/);
    assert.doesNotMatch(main, /createServer|\.listen\s*\(/);
    assert.match(html, /connect-src 'none'/);
});

test('隐藏标题栏提供拖动区域且不吞掉控件交互', async function () {
    var main = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
    var styles = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

    assert.match(main, /titleBarStyle:.*hiddenInset/);
    assert.match(styles, /\.sidebar,\s*\.toolbar\s*\{\s*-webkit-app-region:\s*drag;/);
    assert.match(styles, /\.toolbar label\s*\{\s*-webkit-app-region:\s*no-drag;/);
});

test('Initiative 异步读取状态使用可访问 live status 语义', async function () {
    var renderer = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    ['正在读取成果索引', '正在读取成果', '正在载入独立 Initiative App'].forEach(function (label) {
        var marker = 'role="status" aria-live="polite" aria-label="' + label + '"';
        assert.match(renderer, new RegExp(marker));
    });
});

test('embedded App 仅由原生 View bridge 承载且不复制专项依赖', async function () {
    var html = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    var renderer = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    var preload = await fsPromises.readFile(path.resolve(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');
    assert.doesNotMatch(html, /mermaid|project-specific-app|trusted-initiative-apps/);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.match(renderer, /EmbeddedInitiativeAppHost/);
    assert.match(preload, /initiative-app:mount/);
    assert.match(preload, /initiative-app:focus/);
    assert.doesNotMatch(preload, /webRoot|absolutePath|command|provider\.call/);
});
