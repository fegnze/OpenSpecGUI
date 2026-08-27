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

test('Finder Change 解析绑定当前索引、拒绝归档歧义与路径任意层符号链接', async function (context) {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-change-directory-'));
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider
    });
    try {
        await service.initialize();
        await service.addProjects([fixture.root]);
        var workspace = await service.loadWorkspace(false);
        var request = { projectId: workspace.projectId, revision: workspace.revision, changeId: 'add-feature' };
        assert.equal(await service.resolveChangeDirectory(request), await fsPromises.realpath(path.join(fixture.root, 'openspec', 'changes', 'add-feature')));
        assert.equal(await service.resolveChangeDirectory({
            projectId: workspace.projectId,
            revision: workspace.revision,
            changeId: 'old-change'
        }), await fsPromises.realpath(path.join(fixture.root, 'openspec', 'changes', 'archive', '2026-01-01-old-change')));
        await assert.rejects(function () {
            return service.resolveChangeDirectory({ projectId: workspace.projectId, revision: workspace.revision + 1, changeId: 'add-feature' });
        }, function (error) { return error.code === 'STALE_WORKSPACE'; });

        var changesPath = path.join(fixture.root, 'openspec', 'changes');
        var movedChangesPath = path.join(fixture.root, 'changes-moved-after-scan');
        await fsPromises.rename(changesPath, movedChangesPath);
        try {
            await fsPromises.symlink(movedChangesPath, changesPath, 'dir');
        } catch (error) {
            context.skip('当前文件系统不允许创建目录符号链接');
            return;
        }
        await assert.rejects(function () {
            return service.resolveChangeDirectory(request);
        }, function (error) { return error.code === 'CHANGE_PATH_FORBIDDEN'; });
    } finally {
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }

    var ambiguousFixture = await fixtures.createFixtureProject();
    var ambiguousDataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-change-ambiguity-'));
    var ambiguousService = new WorkbenchService(new ProjectRegistry(path.join(ambiguousDataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider
    });
    try {
        await ambiguousFixture.write('openspec/changes/old-change/proposal.md', '# Proposal: 活跃同名 Change\n');
        await ambiguousFixture.write('openspec/changes/old-change/tasks.md', '- [ ] 1.1 待处理\n');
        await ambiguousService.initialize();
        await ambiguousService.addProjects([ambiguousFixture.root]);
        var ambiguousWorkspace = await ambiguousService.loadWorkspace(false);
        await assert.rejects(function () {
            return ambiguousService.resolveChangeDirectory({
                projectId: ambiguousWorkspace.projectId,
                revision: ambiguousWorkspace.revision,
                changeId: 'old-change'
            });
        }, function (error) { return error.code === 'CHANGE_INDEX_AMBIGUOUS'; });
    } finally {
        await ambiguousFixture.cleanup();
        await fsPromises.rm(ambiguousDataRoot, { recursive: true, force: true });
    }
});

test('Finder Change 解析期间工作区刷新后拒绝返回旧项目路径', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-change-stale-'));
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider
    });
    var originalRealpath = fsPromises.realpath;
    var releaseRealpath;
    var realpathStartedResolve;
    var realpathStarted = new Promise(function (resolve) { realpathStartedResolve = resolve; });
    var delayed = false;
    try {
        await service.initialize();
        await service.addProjects([fixture.root]);
        var workspace = await service.loadWorkspace(false);
        fsPromises.realpath = async function (value) {
            if (!delayed) {
                delayed = true;
                realpathStartedResolve();
                await new Promise(function (resolve) { releaseRealpath = resolve; });
            }
            return originalRealpath(value);
        };
        var pending = service.resolveChangeDirectory({
            projectId: workspace.projectId,
            revision: workspace.revision,
            changeId: 'add-feature'
        });
        await realpathStarted;
        service.revision += 1;
        releaseRealpath();
        await assert.rejects(pending, function (error) { return error.code === 'STALE_WORKSPACE'; });
    } finally {
        fsPromises.realpath = originalRealpath;
        if (releaseRealpath) { releaseRealpath(); }
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('延迟工作区构建在项目切换后不得提交旧项目 roots 或覆盖新 revision', async function () {
    var fixtureOne = await fixtures.createFixtureProject();
    var fixtureTwo = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-delayed-workspace-'));
    var firstRoot = await fsPromises.realpath(fixtureOne.root);
    var releaseFirst;
    var firstStartedResolve;
    var firstStarted = new Promise(function (resolve) { firstStartedResolve = resolve; });
    var firstReleased = false;
    var delayedProvider = {
        id: 'delayed-test-provider',
        schemaVersions: [1],
        fingerprint: function (roots) { return Promise.resolve('fingerprint:' + roots.projectRoot); },
        discover: function (roots) {
            if (roots.projectRoot === firstRoot && !firstReleased) {
                firstStartedResolve();
                return new Promise(function (resolve) {
                    releaseFirst = function () {
                        firstReleased = true;
                        resolve({ initiatives: [], diagnostics: [], authoritative: true });
                    };
                });
            }
            return Promise.resolve({ initiatives: [], diagnostics: [], authoritative: true });
        },
        load: function () { return Promise.reject(new Error('not used')); },
        readArtifact: function () { return Promise.reject(new Error('not used')); }
    };
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        initiativeRegistry: new InitiativeProviderRegistry([delayedProvider]),
        statusProvider: fixtures.inferredStatusProvider
    });
    try {
        await service.initialize();
        var firstProjectId = (await service.addProjects([fixtureOne.root])).added[0].id;
        var secondProjectId = (await service.addProjects([fixtureTwo.root])).added[0].id;
        await service.selectProject(firstProjectId);
        var firstLoad = service.loadWorkspace(false);
        await firstStarted;

        await service.selectProject(secondProjectId);
        var secondLoad = await service.loadWorkspace(false);
        assert.equal(secondLoad.projectId, secondProjectId);
        assert.equal(secondLoad.snapshot.project.id, secondProjectId);
        releaseFirst();
        await assert.rejects(firstLoad, function (error) { return error.code === 'STALE_WORKSPACE'; });
        assert.equal(service.workspace.snapshot.project.id, secondProjectId);
        assert.equal(service.revision, secondLoad.revision);
    } finally {
        await fixtureOne.cleanup();
        await fixtureTwo.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('并发条件刷新共享单次扫描且只失效一个 workspace revision', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-shared-refresh-'));
    var invalidations = 0;
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider,
        onInvalidate: function () { invalidations += 1; }
    });
    try {
        await service.initialize();
        await service.addProjects([fixture.root]);
        await service.loadWorkspace(false);
        invalidations = 0;
        var previousRevision = service.revision;
        await fixture.write('openspec/changes/add-feature/tasks.md', '- [x] 1.1 完成\n- [x] 1.2 新增完成项\n');
        var results = await Promise.all([service.refreshIfChanged(), service.refreshIfChanged()]);
        assert.deepEqual(results, [true, true]);
        assert.equal(invalidations, 1);
        assert.equal(service.revision, previousRevision + 1);
        var reloaded = await service.loadWorkspace(false);
        assert.equal(reloaded.revision, service.revision);
        assert.equal(reloaded.snapshot.project.id, service.registry.getActive().id);
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
