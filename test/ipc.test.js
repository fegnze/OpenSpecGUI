'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var registerIpc = require('../src/main/ipc').registerIpc;
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;
var WorkbenchService = require('../src/main/workbench-service').WorkbenchService;

test('IPC 只注册白名单操作并校验项目和文档输入', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-ipc-'));
    var handlers = new Map();
    var clipboardValue = '';
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider
    });
    var ipcMain = { handle: function (name, handler) { handlers.set(name, handler); } };
    try {
        await service.initialize();
        registerIpc({
            ipcMain: ipcMain,
            dialog: { showOpenDialog: function () { return Promise.resolve({ canceled: true, filePaths: [] }); } },
            clipboard: { writeText: function (value) { clipboardValue = value; } },
            service: service,
            windowProvider: function () { return null; }
        });

        assert.deepEqual(Array.from(handlers.keys()).sort(), [
            'changes:commit-archive', 'changes:discard-archive', 'changes:prepare-archive',
            'clipboard:write', 'documents:read', 'initiatives:load', 'initiatives:read-artifact',
            'projects:add', 'projects:list', 'projects:relink',
            'projects:remove', 'projects:scan', 'projects:select', 'workspace:check-updates',
            'workspace:load', 'workspace:refresh'
        ]);

        var addResult = await handlers.get('projects:add')({}, { path: fixture.root });
        assert.equal(addResult.canceled, false);
        var workspace = await handlers.get('workspace:load')({});
        assert.equal(workspace.snapshot.stats.specs, 1);
        assert.throws(function () {
            handlers.get('documents:read')({}, {
                projectId: workspace.projectId,
                revision: workspace.revision,
                documentId: '../../outside-secret.md'
            });
        }, /文档 ID 格式无效/);

        assert.throws(function () {
            handlers.get('projects:select')({}, { projectId: 'x'.repeat(2 * 1024 * 1024) });
        }, /payload 限制/);
        assert.throws(function () {
            handlers.get('initiatives:load')({}, {
                projectId: workspace.projectId,
                revision: workspace.revision,
                providerId: 'Provider_With_Invalid_Format',
                initiativeId: 'release-readiness'
            });
        }, /Provider ID格式无效/);
        assert.throws(function () {
            handlers.get('clipboard:write')({}, { text: 'x'.repeat(8193) });
        }, /剪贴板文本超过限制/);

        await handlers.get('clipboard:write')({}, { text: 'openspec/specs/core/spec.md' });
        assert.equal(clipboardValue, 'openspec/specs/core/spec.md');
        assert.throws(function () { handlers.get('projects:select')({}, { projectId: '' }); }, /项目 ID无效/);
    } finally {
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('归档 IPC 校验宿主主框架、计划身份和警告，拒绝任意路径及命令', async function () {
    var handlers = new Map();
    var sender = { mainFrame: {} };
    var event = { sender: sender, senderFrame: sender.mainFrame };
    var calls = [];
    var request = { projectId: '12345678-1234-4123-8123-123456789abc', revision: 3, changeId: 'add-example' };
    registerIpc({
        ipcMain: { handle: function (name, handler) { handlers.set(name, handler); } },
        dialog: {}, clipboard: {},
        windowProvider: function () { return { webContents: sender }; },
        service: {
            prepareArchive: function (value) { calls.push(value); return value; },
            commitArchive: function (value) { calls.push(value); return value; },
            discardArchive: function (value) { return value; }
        }
    });
    assert.throws(function () { handlers.get('changes:prepare-archive')({ sender: {} }, request); }, /来源无效/);
    assert.throws(function () { handlers.get('changes:prepare-archive')({ sender: sender, senderFrame: {} }, request); }, /来源无效/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { path: '/outside' })); }, /未支持字段/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { command: 'anything' })); }, /未支持字段/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { changeId: '../other' })); }, /格式无效/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { revision: -1 })); }, /revision/);
    handlers.get('changes:prepare-archive')(event, request);
    var commit = { projectId: request.projectId, revision: 3, planId: 'a'.repeat(48), acceptedWarnings: ['tasks:incomplete'] };
    assert.deepEqual(handlers.get('changes:commit-archive')(event, commit), commit);
    assert.throws(function () { handlers.get('changes:commit-archive')(event, Object.assign({}, commit, { content: 'injected' })); }, /未支持字段/);
    assert.throws(function () { handlers.get('changes:commit-archive')(event, Object.assign({}, commit, { acceptedWarnings: ['x'.repeat(70000)] })); }, /payload 限制/);
    assert.throws(function () { handlers.get('changes:commit-archive')(event, Object.assign({}, commit, { planId: '../../plan' })); }, /格式无效/);
    assert.equal(calls.length, 2);
});
