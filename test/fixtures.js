'use strict';

var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');

async function writeFile(root, relativePath, content) {
    var target = path.join(root, relativePath);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, content, 'utf8');
    return target;
}

/**
 * 创建包含完整、不完整和归档内容的独立 OpenSpec 测试项目。
 * @returns {Promise<object>} 测试项目句柄
 */
async function createFixtureProject() {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-workbench-'));
    var outsideFile = await writeFile(root, 'outside-secret.md', '# 不应读取\n\nsecret');

    await writeFile(root, 'package.json', '{"name":"fixture-project","productName":"Fixture Product","displayName":"Fixture Display"}\n');
    await writeFile(root, 'openspec/config.yaml', 'schema: spec-driven\n');
    await writeFile(root, 'openspec/specs/core/spec.md', [
        '# core Specification',
        '',
        '## Purpose',
        '',
        '核心能力说明。',
        '',
        '## Requirements',
        '',
        '### Requirement: 用户可以查看状态',
        '',
        '系统 MUST 展示状态。',
        '',
        '#### Scenario: 状态存在',
        '',
        '- **WHEN** 用户打开页面',
        '- **THEN** 页面展示状态',
        ''
    ].join('\n'));
    await writeFile(root, 'openspec/changes/add-feature/proposal.md', '# Proposal: 新增测试能力\n\n## Why\n\n用于验证搜索与提案解析。\n');
    await writeFile(root, 'openspec/changes/add-feature/design.md', '## Context\n\n使用独立夹具。\n');
    await writeFile(root, 'openspec/changes/add-feature/tasks.md', '## 1. 实施\n\n- [x] 1.1 完成解析\n- [ ] 1.2 完成界面\n');
    await writeFile(root, 'openspec/changes/add-feature/specs/core/spec.md', '## ADDED Requirements\n\n### Requirement: 新状态\n\n系统 MUST 展示新状态。\n\n#### Scenario: 展示新状态\n- **WHEN** 数据存在\n- **THEN** 展示数据\n');
    await writeFile(root, 'openspec/changes/incomplete-change/design.md', '## Context\n\n```js\nvar open = true;\n');
    await writeFile(root, 'openspec/changes/incomplete-change/tasks.md', '## 1. 待办\n\n- [ ] 1.1 补充提案\n');
    await writeFile(root, 'openspec/changes/archive/2026-01-01-old-change/proposal.md', '# Proposal: 历史提案\n\n## Why\n\n验证归档扫描。\n');
    await writeFile(root, 'openspec/changes/archive/2026-01-01-old-change/tasks.md', '## 1. 完成\n\n- [x] 1.1 已完成\n');

    return {
        root: root,
        outsideFile: outsideFile,
        write: function (relativePath, content) { return writeFile(root, relativePath, content); },
        cleanup: function () { return fsPromises.rm(root, { recursive: true, force: true }); }
    };
}

async function addGenericInitiative(fixture, settings) {
    var initiativeId = settings && settings.id ? settings.id : 'launch-readiness';
    var artifactPath = 'initiatives/' + initiativeId + '/outcomes.md';
    await fixture.write('openspec/' + artifactPath, '# 交付结论\n\n已完成核心准备。\n');
    await fixture.write('openspec/initiatives/' + initiativeId + '/initiative.yaml', [
        'schemaVersion: 1',
        'id: ' + initiativeId,
        'title: 发布准备专项',
        'summary: 统一追踪发布前工作。',
        'goal: 让所有发布前结论和证据保持可追溯。',
        'status: active',
        'health: healthy',
        'changes:',
        '  - id: add-feature',
        '    relationship: owned',
        '  - id: incomplete-change',
        '    relationship: related',
        '  - id: old-change',
        '    relationship: related',
        'artifacts:',
        '  - id: delivery-outcomes',
        '    title: 交付结论',
        '    path: ' + artifactPath,
        ''
    ].join('\n'));
    return initiativeId;
}

async function addEmbeddedInitiativeApp(fixture, settings) {
    var config = settings || {};
    var collection = config.collection || 'programs';
    var initiativeId = config.id || 'delivery-program';
    var title = config.title || '交付 Program';
    var manifest = {
        $schema: 'https://openspec.dev/schemas/initiative-app-v1.json',
        schemaVersion: 1,
        id: initiativeId,
        kind: config.kind || 'program',
        title: title,
        summary: config.summary || '由独立静态应用提供完整专项界面。',
        presentation: {
            type: 'embedded-app',
            webRoot: 'dashboard',
            entry: 'index.html',
            actions: config.actions || { '/_initiative/open-change': 'openspec.open-change' }
        }
    };
    await fixture.write('openspec/' + collection + '/' + initiativeId + '/initiative-app.json', JSON.stringify(manifest, null, 2) + '\n');
    await fixture.write('openspec/' + collection + '/' + initiativeId + '/dashboard/index.html', config.html || '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body><h1>' + title + '</h1><script src="vendor/app.js"></script></body></html>\n');
    await fixture.write('openspec/' + collection + '/' + initiativeId + '/dashboard/vendor/app.js', 'window.__embeddedInitiativeReady = true;\n');
    return initiativeId;
}

function officialStatusProvider() {
    return Promise.resolve({
        source: 'cli',
        diagnostic: null,
        items: new Map([['add-feature', {
            name: 'add-feature',
            completedTasks: 2,
            totalTasks: 3,
            status: 'in-progress',
            lastModified: '2026-08-21T03:00:00.000Z'
        }]])
    });
}

function inferredStatusProvider() {
    return Promise.resolve({
        source: 'inferred',
        diagnostic: '测试：CLI 不可用',
        items: new Map()
    });
}

module.exports = {
    addEmbeddedInitiativeApp: addEmbeddedInitiativeApp,
    addGenericInitiative: addGenericInitiative,
    createFixtureProject: createFixtureProject,
    inferredStatusProvider: inferredStatusProvider,
    officialStatusProvider: officialStatusProvider
};
