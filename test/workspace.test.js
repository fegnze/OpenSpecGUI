'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var markdown = require('../src/core/markdown');
var workspaceModule = require('../src/core/workspace');

test('Markdown 解析标题、Requirement、Scenario 和任务进度', function () {
    var parsed = markdown.parseMarkdown([
        '# Proposal: 测试提案',
        '',
        '### Requirement: 测试行为',
        '#### Scenario: 测试场景',
        '- [x] 已完成',
        '- [ ] 未完成'
    ].join('\n'));

    assert.equal(parsed.title, 'Proposal: 测试提案');
    assert.deepEqual(parsed.requirements, ['测试行为']);
    assert.deepEqual(parsed.scenarios, ['测试场景']);
    assert.equal(parsed.tasks.completed, 1);
    assert.equal(parsed.tasks.total, 2);
    assert.equal(parsed.tasks.percent, 50);
    assert.deepEqual(parsed.tasks.items.map(function (item) { return [item.id, item.text, item.completed, item.groupTitle]; }), [
        ['1', '已完成', true, '未分组'],
        ['2', '未完成', false, '未分组']
    ]);
    assert.equal(parsed.headings[1].anchor, 'requirement-测试行为');
});

test('缺少 openspec 目录时返回可操作错误', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-workbench-empty-'));
    try {
        await assert.rejects(function () {
            return workspaceModule.resolveProjectRoot(root);
        }, /缺少可读取的 openspec\/ 目录/);
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});

test('扫描正式规范、活跃提案、归档提案与不完整文档', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root, name: 'Injected Display Variant' }, {
            statusProvider: fixtures.officialStatusProvider
        });
        var feature = workspace.snapshot.changes.find(function (change) { return change.id === 'add-feature'; });
        var incomplete = workspace.snapshot.changes.find(function (change) { return change.id === 'incomplete-change'; });

        assert.equal(workspace.snapshot.project.name, path.basename(fixture.root));
        assert.equal(workspace.snapshot.stats.specs, 1);
        assert.equal(workspace.snapshot.stats.activeChanges, 2);
        assert.equal(workspace.snapshot.stats.archivedChanges, 1);
        assert.equal(workspace.snapshot.lifecycle.source, 'cli');
        assert.equal(feature.title, '新增测试能力');
        assert.equal(feature.tasks.completed, 2);
        assert.equal(feature.tasks.total, 3);
        assert.equal(feature.tasks.percent, 67);
        assert.equal(feature.tasks.items[1].id, '1.2');
        assert.equal(feature.tasks.items[1].groupTitle, '实施');
        assert.equal(feature.nextTask.text, '完成界面');
        assert.equal(feature.remainingTasks, 1);
        assert.equal(feature.controlState, 'in-progress');
        assert.equal(workspace.snapshot.stats.pendingTasks, 2);
        assert.ok(workspace.snapshot.taskQueue.some(function (task) { return task.changeId === 'add-feature' && task.id === '1.2'; }));
        assert.equal(feature.statusSource, 'cli');
        assert.equal(incomplete.statusSource, 'inferred');
        assert.ok(incomplete.warnings.some(function (warning) { return warning.indexOf('缺少 proposal.md') !== -1; }));
        assert.ok(incomplete.warnings.some(function (warning) { return warning.indexOf('未闭合的代码块') !== -1; }));
        assert.ok(workspace.documents.has('openspec/specs/core/spec.md'));
        assert.ok(workspace.snapshot.searchIndex.some(function (entry) { return entry.text.indexOf('用于验证搜索') !== -1; }));
    } finally {
        await fixture.cleanup();
    }
});

test('CLI 失败时使用任务文件推断并保留诊断', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        var feature = workspace.snapshot.changes.find(function (change) { return change.id === 'add-feature'; });

        assert.equal(workspace.snapshot.lifecycle.source, 'inferred');
        assert.match(workspace.snapshot.lifecycle.diagnostic, /CLI 不可用/);
        assert.equal(feature.tasks.completed, 1);
        assert.equal(feature.tasks.total, 2);
        assert.equal(feature.tasks.percent, 50);
        assert.equal(feature.statusSource, 'inferred');
    } finally {
        await fixture.cleanup();
    }
});

test('文档读取使用稳定 ID 并返回最新正文', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        await fixture.write('openspec/specs/core/spec.md', '# core Specification\n\n最新正文。\n');
        var document = await workspaceModule.readWorkspaceDocument(workspace, 'openspec/specs/core/spec.md');

        assert.match(document.markdown, /最新正文/);
        assert.equal(document.path, 'openspec/specs/core/spec.md');
    } finally {
        await fixture.cleanup();
    }
});
