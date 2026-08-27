'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');
var resourceProgram = require('../src/renderer/resource-program-app');

var fixtureRoot = path.join(__dirname, 'fixtures', 'wtc-resource-program-v1');
var artifactIndex = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'expected-artifact-index.json'), 'utf8'));

test('Resource Program App 使用固定静态身份并拒绝不完整宿主 API', function () {
    assert.equal(resourceProgram.APP_ID, 'resource-program-v1');
    assert.equal(resourceProgram.app.id, 'resource-program-v1');
    assert.throws(function () { resourceProgram.app.create({ root: {} }); }, /宿主 API 不完整/);
});

test('Resource Program 子路由恢复 Change、tasks、lens、section 与 Diagram', function () {
    assert.deepEqual(resourceProgram.parseRoute('tasks/sample-change/all'), {
        view: 'change', changeId: 'sample-change', taskFilter: 'all', lens: 'conclusions', artifactId: '', sectionId: '', diagramId: ''
    });
    var artifactRoute = resourceProgram.buildRoute({
        view: 'artifact',
        lens: 'design',
        artifactId: 'artifact-0123456789abcdef',
        sectionId: 'section-0123456789abcdef',
        diagramId: 'SAMPLE-FLOW-01'
    });
    assert.equal(artifactRoute, 'artifact/design/artifact-0123456789abcdef/section/section-0123456789abcdef/diagram/sample-flow-01');
    assert.deepEqual(resourceProgram.parseRoute(artifactRoute), {
        view: 'artifact',
        changeId: '',
        taskFilter: 'open',
        lens: 'design',
        artifactId: 'artifact-0123456789abcdef',
        sectionId: 'section-0123456789abcdef',
        diagramId: 'sample-flow-01'
    });
    assert.equal(resourceProgram.parseRoute('unknown/unsafe').view, 'not-found');
    assert.equal(resourceProgram.parseRoute('artifact/all/../../outside').artifactId, '');
});

test('Resource Program 合法组合深链接可使用 Host Router 的 320 字符预算', function () {
    var route = resourceProgram.buildRoute({
        view: 'artifact',
        lens: 'design',
        artifactId: 'artifact-0123456789abcdef',
        sectionId: 'section-0123456789abcdef',
        diagramId: 'diagram-' + 'a'.repeat(112)
    });
    assert.ok(route.length > 120);
    assert.ok(route.length <= 320);
    assert.equal(resourceProgram.parseRoute(route).diagramId, 'diagram-' + 'a'.repeat(112));
});

test('官方 tasks.md 可完整解析并保持阶段、顺序与完成状态', function () {
    var groups = resourceProgram.parseTasksMarkdown([
        '# Tasks',
        '## 1. 契约',
        '- [x] 1.1 冻结 schema',
        '- [ ] 1.2 固定 fixture',
        '## 2. 交付',
        '- [X] 2.1 完成实现'
    ].join('\n'));
    assert.deepEqual(groups, [{
        title: '1. 契约',
        items: [
            { id: '1.1', title: '冻结 schema', completed: true },
            { id: '1.2', title: '固定 fixture', completed: false }
        ]
    }, {
        title: '2. 交付',
        items: [{ id: '2.1', title: '完成实现', completed: true }]
    }]);
});

test('任务成果只能从当前 Change 已登记的稳定 artifactId 选择', function () {
    var index = { artifacts: [{
        artifactId: 'artifact-aabbccddeeff0011',
        changeIds: ['sample-change'],
        kind: 'change-tasks',
        path: 'openspec/changes/sample-change/tasks.md'
    }, {
        artifactId: 'artifact-aabbccddeeff0022',
        changeIds: ['other-change'],
        kind: 'change-tasks',
        path: 'openspec/changes/other-change/tasks.md'
    }] };
    assert.equal(resourceProgram.artifactForTasks(index, 'sample-change').artifactId, 'artifact-aabbccddeeff0011');
    assert.equal(resourceProgram.artifactForTasks(index, 'missing-change'), null);
});

test('四种阅读视角按 taxonomy 选择且全部档案不与精选章节混排', function () {
    assert.equal(resourceProgram.selectArtifactEntries(artifactIndex, 'conclusions', '', 'all').length, 1);
    assert.equal(resourceProgram.selectArtifactEntries(artifactIndex, 'design', '', 'all').length, 1);
    assert.equal(resourceProgram.selectArtifactEntries(artifactIndex, 'evidence', '', 'all').length, 0);
    assert.equal(resourceProgram.selectArtifactEntries(artifactIndex, 'all', '', 'all').length, 1);
    assert.equal(resourceProgram.selectArtifactEntries(artifactIndex, 'all', 'program-design', 'all')[0].entryType, 'artifact');
    assert.equal(resourceProgram.selectArtifactEntries(artifactIndex, 'conclusions', '不存在', 'all').length, 0);
});

test('Resource Program renderer 不引入项目执行、网络、嵌入页面或全局样式入口', function () {
    var source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'resource-program-app.js'), 'utf8');
    var css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'resource-program-app.css'), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|child_process|\.execFile\s*\(|<iframe|<webview|nodeIntegration/);
    assert.doesNotMatch(source, /require\s*\(/);
    assert.doesNotMatch(css, /(^|\n)\s*:root\b|(^|\n)\s*(html|body|\.app-shell|\.sidebar|\.toolbar)\b/);
    assert.match(css, /\.resource-program-app \.rp-diagram/);
    assert.match(css, /\.rp-diagram-graphic svg \.node rect/);
    assert.match(source, /securityLevel:\s*'strict'/);
    assert.match(source, /htmlLabels:\s*false/);
    assert.match(source, /querySelectorAll\('style'\)/);
    assert.match(source, /IntersectionObserver/);
});
