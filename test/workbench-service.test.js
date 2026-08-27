'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var InitiativeProviderRegistry = require('../src/core/initiative-provider-registry').InitiativeProviderRegistry;
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;
var workbenchServiceModule = require('../src/main/workbench-service');
var computeOpenSpecStamp = workbenchServiceModule.computeOpenSpecStamp;
var WorkbenchService = workbenchServiceModule.WorkbenchService;

test('工作区刷新指纹检测删除、重命名和保留 mtime 的等长修改', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        var oldPath = path.join(fixture.root, 'openspec', 'specs', 'old', 'spec.md');
        var renamedPath = path.join(fixture.root, 'openspec', 'specs', 'renamed', 'spec.md');
        await fixture.write('openspec/specs/old/spec.md', '# old\n\nAAAA\n');
        var fixedTime = new Date('2024-01-01T00:00:00.000Z');
        await fsPromises.utimes(oldPath, fixedTime, fixedTime);
        var initial = await computeOpenSpecStamp(path.join(fixture.root, 'openspec'));

        await fsPromises.writeFile(oldPath, '# old\n\nBBBB\n', 'utf8');
        await fsPromises.utimes(oldPath, fixedTime, fixedTime);
        var modified = await computeOpenSpecStamp(path.join(fixture.root, 'openspec'));
        assert.notEqual(modified, initial);

        await fsPromises.mkdir(path.dirname(renamedPath), { recursive: true });
        await fsPromises.rename(oldPath, renamedPath);
        var renamed = await computeOpenSpecStamp(path.join(fixture.root, 'openspec'));
        assert.notEqual(renamed, modified);

        await fsPromises.rm(renamedPath);
        var deleted = await computeOpenSpecStamp(path.join(fixture.root, 'openspec'));
        assert.notEqual(deleted, renamed);

        var changeConfigPath = path.join(fixture.root, 'openspec', 'changes', 'configured', '.openspec.yaml');
        await fixture.write('openspec/changes/configured/.openspec.yaml', 'schema: specs\n');
        await fsPromises.utimes(changeConfigPath, fixedTime, fixedTime);
        var configured = await computeOpenSpecStamp(path.join(fixture.root, 'openspec'));
        await fsPromises.writeFile(changeConfigPath, 'schema: delta\n', 'utf8');
        await fsPromises.utimes(changeConfigPath, fixedTime, fixedTime);
        assert.notEqual(await computeOpenSpecStamp(path.join(fixture.root, 'openspec')), configured);
    } finally {
        await fixture.cleanup();
    }
});

test('工作区刷新指纹有界且不扫描 Provider 专属 programs 树', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-stamp-'));
    var openspecRoot = path.join(root, 'openspec');
    try {
        await fsPromises.mkdir(path.join(openspecRoot, 'changes'), { recursive: true });
        await fsPromises.mkdir(path.join(openspecRoot, 'specs'), { recursive: true });
        await fsPromises.mkdir(path.join(openspecRoot, 'programs', 'invalid', 'deep'), { recursive: true });
        await fsPromises.writeFile(path.join(openspecRoot, 'programs', 'invalid', 'deep', 'ignored.md'), '# ignored\n');
        await computeOpenSpecStamp(openspecRoot, { maxEntries: 3 });

        await fsPromises.mkdir(path.join(openspecRoot, 'changes', 'one'), { recursive: true });
        await fsPromises.writeFile(path.join(openspecRoot, 'changes', 'one', 'proposal.md'), '# one\n');
        await assert.rejects(function () {
            return computeOpenSpecStamp(openspecRoot, { maxEntries: 1 });
        }, function (error) { return error.code === 'WORKSPACE_STAMP_LIMIT'; });
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});

test('初始指纹失败不保留半初始化工作区且可在限制恢复后重试', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-stamp-retry-'));
    var stampOptions = { maxEntries: 1 };
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider,
        workspaceStampOptions: stampOptions
    });
    try {
        await service.initialize();
        await service.addProjects([fixture.root]);
        await assert.rejects(function () {
            return service.loadWorkspace(false);
        }, function (error) { return error.code === 'WORKSPACE_STAMP_LIMIT'; });
        assert.equal(service.workspace, null);
        assert.equal(service.stamp, null);

        stampOptions.maxEntries = 20000;
        var recovered = await service.loadWorkspace(false);
        assert.ok(recovered.snapshot);
        assert.equal(await service.refreshIfChanged(), false);
    } finally {
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

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

test('Initiative 服务绑定项目 revision、Provider、source hash 和成果 ID', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-initiative-service-'));
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider
    });
    try {
        await fixtures.addGenericInitiative(fixture, {});
        await service.initialize();
        await service.addProjects([fixture.root]);
        var workspace = await service.loadWorkspace(false);
        var descriptor = workspace.snapshot.initiatives[0];
        var loaded = await service.loadInitiative({
            projectId: workspace.projectId,
            revision: workspace.revision,
            providerId: descriptor.providerId,
            initiativeId: descriptor.id
        });
        assert.equal(loaded.artifactIndex[0].id, 'delivery-outcomes');
        var artifact = await service.readInitiativeArtifact({
            projectId: workspace.projectId,
            revision: workspace.revision,
            providerId: descriptor.providerId,
            initiativeId: descriptor.id,
            sourceHash: descriptor.sourceHash,
            artifactId: 'delivery-outcomes'
        });
        assert.match(artifact.content, /核心准备/);
        await assert.rejects(function () {
            return service.loadInitiative({
                projectId: workspace.projectId,
                revision: workspace.revision,
                providerId: 'unknown-provider',
                initiativeId: descriptor.id
            });
        }, function (error) { return error.code === 'INITIATIVE_NOT_FOUND'; });
        await service.loadWorkspace(true);
        await assert.rejects(function () {
            return service.readInitiativeArtifact({
                projectId: workspace.projectId,
                revision: workspace.revision,
                providerId: descriptor.providerId,
                initiativeId: descriptor.id,
                sourceHash: descriptor.sourceHash,
                artifactId: 'delivery-outcomes'
            });
        }, function (error) { return error.code === 'STALE_WORKSPACE'; });
    } finally {
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('Provider 持续发现失败不会触发条件刷新风暴', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-provider-failure-'));
    var initiativeRegistry = new InitiativeProviderRegistry([{
        id: 'stable-failing-provider',
        schemaVersions: [1],
        fingerprint: function () { return Promise.resolve('stable-authority-input'); },
        discover: function () { return Promise.reject(new Error('fixture discovery failure')); },
        load: function () { return Promise.reject(new Error('unavailable')); },
        readArtifact: function () { return Promise.reject(new Error('unavailable')); }
    }]);
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        initiativeRegistry: initiativeRegistry,
        statusProvider: fixtures.inferredStatusProvider
    });
    try {
        await service.initialize();
        await service.addProjects([fixture.root]);
        var workspace = await service.loadWorkspace(false);
        assert.ok(workspace.snapshot.initiativeDiagnostics.some(function (item) {
            return item.code === 'PROVIDER_DISCOVERY_FAILED';
        }));
        assert.equal(await service.refreshIfChanged(), false);
        assert.equal(await service.refreshIfChanged(), false);
    } finally {
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});
