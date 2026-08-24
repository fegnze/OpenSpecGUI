'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;
var WorkbenchService = require('../src/main/workbench-service').WorkbenchService;

test('工作区快照绑定项目与 revision，切换后拒绝旧文档请求', async function () {
    var fixtureOne = await fixtures.createFixtureProject();
    var fixtureTwo = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-service-'));
    var registry = new ProjectRegistry(path.join(dataRoot, 'projects.json'));
    var service = new WorkbenchService(registry, { statusProvider: fixtures.inferredStatusProvider });
    try {
        await service.initialize();
        var addedOne = await service.addProjects([fixtureOne.root]);
        var firstProjectId = addedOne.added[0].id;
        var first = await service.loadWorkspace(false);
        assert.equal(first.projectId, firstProjectId);
        assert.equal(first.snapshot.project.id, firstProjectId);
        assert.equal(first.snapshot.project.path, undefined);

        var document = await service.readDocument({
            projectId: first.projectId,
            revision: first.revision,
            documentId: 'openspec/specs/core/spec.md'
        });
        assert.match(document.markdown, /用户可以查看状态/);

        await service.addProjects([fixtureTwo.root]);
        await assert.rejects(function () {
            return service.readDocument({
                projectId: first.projectId,
                revision: first.revision,
                documentId: 'openspec/specs/core/spec.md'
            });
        }, function (error) { return error.code === 'NO_ACTIVE_PROJECT' || error.code === 'STALE_WORKSPACE'; });

        var second = await service.loadWorkspace(false);
        assert.notEqual(second.projectId, first.projectId);
        assert.ok(second.revision > first.revision);

        await service.selectProject(firstProjectId);
        var selectedAgain = await service.loadWorkspace(false);
        await fixtureOne.write('openspec/specs/new/spec.md', '# new Specification\n\n新内容。\n');
        assert.equal(await service.refreshIfChanged(), true);
        var refreshed = await service.loadWorkspace(false);
        assert.ok(refreshed.revision > selectedAgain.revision);
        assert.equal(refreshed.snapshot.stats.specs, 2);
    } finally {
        await fixtureOne.cleanup();
        await fixtureTwo.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('没有项目时返回稳定空工作区', async function () {
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-empty-'));
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')));
    try {
        await service.initialize();
        assert.deepEqual(await service.loadWorkspace(false), { projectId: null, revision: 0, snapshot: null });
    } finally {
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});
