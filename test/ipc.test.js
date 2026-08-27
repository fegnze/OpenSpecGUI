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
