'use strict';

var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');

var FIXED_NOW = '2026-04-18T09:30:00.000Z';
var FIXED_MTIME = new Date('2026-04-18T08:15:00.000Z');

async function write(root, relativePath, content, writtenFiles) {
    var target = path.join(root, relativePath);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, content, 'utf8');
    writtenFiles.push(target);
}

async function createProject(parent, settings) {
    var root = path.join(parent, settings.directoryName);
    var writtenFiles = [];
    await write(root, 'package.json', JSON.stringify({
        name: settings.directoryName,
        productName: settings.productName
    }, null, 2) + '\n', writtenFiles);
    await write(root, 'openspec/config.yaml', 'schema: spec-driven\n', writtenFiles);
    await write(root, 'openspec/specs/workbench/spec.md', [
        '# workbench Specification',
        '',
        '## Purpose',
        '',
        '为端到端验证提供稳定的工作台内容。',
        '',
        '### Requirement: 展示执行状态',
        '系统 MUST 展示当前提案状态与任务进度。',
        '',
        '#### Scenario: 正常读取',
        '- **WHEN** 用户打开工作台',
        '- **THEN** 系统展示规范、提案与任务'
    ].join('\n') + '\n', writtenFiles);

    if (settings.rich) {
        await write(root, 'openspec/changes/modern-console/proposal.md', [
            '# Proposal: 现代任务控制台',
            '',
            '## Why',
            '',
            '团队需要在一个安静、紧凑的界面中理解当前工作并继续执行。',
            '',
            '## What Changes',
            '',
            '- 建立清晰的执行状态层级。',
            '- 保留精确的机器 ID、任务编号与完成比例。',
            '- 支持中英文长文、表格和代码片段。',
            '',
            '## Security fixture',
            '',
            '<script>window.__openspecPwned = true</script>',
            '<img src="javascript:alert(1)" onerror="window.__openspecPwned = true">',
            '',
            '## Comparison',
            '',
            '| Surface | Current behavior | Expected behavior |',
            '| --- | --- | --- |',
            '| Overview | Proposal status overview | Status lanes with focused proposal flow |',
            '| Detail | Competing context panels | Current task and exact progress first |',
            '',
            '## Long content',
            '',
            'https://example.com/openspec/workbench/this-is-a-deliberately-long-link-that-must-wrap-inside-the-document-column-without-expanding-the-page',
            '',
            '`workbench-visual-system-machine-id-with-a-deliberately-long-unbroken-suffix-0123456789abcdef`',
            '',
            '```text',
            'openspec/changes/modern-console/specs/workbench-visual-system/spec.md',
            '```'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/changes/modern-console/design.md', [
            '# Design: 现代任务控制台',
            '',
            '## Context',
            '',
            '这是一个稳定、真实结构的视觉回归夹具。',
            '',
            '## Decisions',
            '',
            '### Quiet workbench',
            '',
            '使用克制表面、明确语义状态与稳定控件尺寸。',
            '',
            '### Responsive hierarchy',
            '',
            '宽桌面并列上下文，最小窗口优先当前任务。'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/changes/modern-console/tasks.md', [
            '## 1. 视觉基础',
            '',
            '- [x] 1.1 固定界面颜色与排版 token',
            '- [x] 1.2 建立稳定的导航和项目上下文',
            '',
            '## 2. 核心工作流',
            '',
            '- [x] 2.1 重构首页提案流',
            '- [x] 2.2 突出提案详情的当前任务',
            '- [x] 2.3 改进长文档阅读层级',
            '- [ ] 2.4 完成最小窗口与键盘验收'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/changes/modern-console/specs/workbench/spec.md', [
            '## ADDED Requirements',
            '',
            '### Requirement: 清晰呈现当前工作',
            '系统 SHALL 将下一项任务置于主要阅读路径。',
            '',
            '#### Scenario: 打开提案详情',
            '- **WHEN** 提案包含未完成任务',
            '- **THEN** 用户先看到当前任务和精确进度'
        ].join('\n') + '\n', writtenFiles);

        await write(root, 'openspec/changes/resolve-import-diagnostics/proposal.md', [
            '# Proposal: 修复导入诊断',
            '',
            '## Why',
            '',
            '项目路径失效时需要更直接的恢复提示。'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/changes/resolve-import-diagnostics/design.md', '# Design\n\n等待补充任务清单。\n', writtenFiles);

        await write(root, 'openspec/changes/archive-ready-theme/proposal.md', [
            '# Proposal: 统一明暗主题',
            '',
            '## Why',
            '',
            '明暗主题需要保持等价的信息层级。'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/changes/archive-ready-theme/tasks.md', [
            '## 1. 交付',
            '',
            '- [x] 1.1 校准浅色主题',
            '- [x] 1.2 校准深色主题',
            '- [x] 1.3 检查状态对比度',
            '- [x] 1.4 完成主题验收'
        ].join('\n') + '\n', writtenFiles);

        await write(root, 'openspec/changes/archive/2026-03-20-project-registry/proposal.md', '# Proposal: 项目注册表\n\n已完成的多项目管理能力。\n', writtenFiles);
        await write(root, 'openspec/changes/archive/2026-03-20-project-registry/tasks.md', '## 1. 交付\n\n- [x] 1.1 完成项目注册表\n', writtenFiles);

        await write(root, 'openspec/initiatives/release-readiness/summary.md', '# 发布结论\n\n核心交付链路已就绪，进入最后验收。\n', writtenFiles);
        await write(root, 'openspec/initiatives/release-readiness/initiative.yaml', [
            'schemaVersion: 1',
            'id: release-readiness',
            'title: 发布准备专项',
            'summary: 聚合当前交付、归档和诊断工作。',
            'goal: 在不改变 OpenSpec Change 生命周期的前提下，建立可追溯的发布准备视图。',
            'status: active',
            'health: healthy',
            'changes:',
            '  - id: modern-console',
            '    relationship: owned',
            '  - id: archive-ready-theme',
            '    relationship: related',
            'artifacts:',
            '  - id: release-summary',
            '    title: 发布结论',
            '    path: initiatives/release-readiness/summary.md'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/initiatives/invalid-contract/initiative.yaml', [
            'schemaVersion: 99',
            'id: invalid-contract',
            'title: 不受支持的专项',
            'status: active',
            'health: unknown'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/initiative-host-fixture.json', '{"enabled":true}\n', writtenFiles);

        await write(root, 'openspec/programs/delivery-suite/initiative-app.json', JSON.stringify({
            $schema: 'https://openspec.dev/schemas/initiative-app-v1.json',
            schemaVersion: 1,
            id: 'delivery-suite',
            kind: 'program',
            title: '交付专项',
            summary: '使用独立静态应用提供项目自有界面。',
            presentation: {
                type: 'embedded-app',
                webRoot: 'dashboard',
                entry: 'index.html',
                actions: { '/_initiative/open-change': 'openspec.open-change' }
            }
        }, null, 2) + '\n', writtenFiles);
        await write(root, 'openspec/programs/delivery-suite/dashboard/index.html', [
            '<!doctype html>',
            '<html><head><meta charset="utf-8"><title>交付专项</title>',
            '<style>html,body{height:100%;margin:0}body{background:#101719;color:#eef5f2;font:16px sans-serif;display:grid;place-items:center}main{border-left:3px solid #18a889;padding:24px}a{color:#8eb7ff}</style></head>',
            '<body><main><h1>交付专项</h1><p>项目自有应用独立运行</p><a href="details.html?view=design#current">查看设计</a></main><script src="vendor/app.js"></script></body></html>'
        ].join('\n') + '\n', writtenFiles);
        await write(root, 'openspec/programs/delivery-suite/dashboard/details.html', '<!doctype html><html><body><h1>专项设计详情</h1><a href="index.html">返回</a></body></html>\n', writtenFiles);
        await write(root, 'openspec/programs/delivery-suite/dashboard/vendor/app.js', 'window.__embeddedInitiativeReady = true;\n', writtenFiles);
    }

    await Promise.all(writtenFiles.map(function (filePath) {
        return fsPromises.utimes(filePath, FIXED_MTIME, FIXED_MTIME);
    }));
    return root;
}

async function createUiFixture() {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-ui-'));
    var primaryProject = await createProject(root, {
        directoryName: 'atlas-workbench',
        productName: 'Atlas Workbench',
        rich: true
    });
    var secondaryProject = await createProject(root, {
        directoryName: 'empty-specs',
        productName: 'Empty Specs',
        rich: false
    });
    return {
        root: root,
        primaryProject: primaryProject,
        secondaryProject: secondaryProject,
        fixedNow: FIXED_NOW,
        cleanup: function () {
            return fsPromises.rm(root, { recursive: true, force: true });
        }
    };
}

module.exports = {
    FIXED_MTIME: FIXED_MTIME,
    FIXED_NOW: FIXED_NOW,
    createUiFixture: createUiFixture
};
