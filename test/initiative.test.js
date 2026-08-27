'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var contract = require('../src/core/initiative-contract');
var GenericInitiativeProvider = require('../src/core/generic-initiative-provider').GenericInitiativeProvider;
var InitiativeProviderRegistry = require('../src/core/initiative-provider-registry').InitiativeProviderRegistry;
var fixtures = require('./fixtures');
var workspaceModule = require('../src/core/workspace');

function fakeDescriptor(providerId, id, refs) {
    return {
        schemaVersion: 1,
        id: id,
        providerId: providerId,
        type: 'test-initiative',
        title: id,
        summary: '',
        goal: '',
        status: 'active',
        health: 'healthy',
        changeRefs: refs || [],
        presentation: { mode: 'generic', appId: '' },
        artifacts: [],
        sourceHash: 'fixture-hash',
        diagnostics: []
    };
}

function fakeProvider(id, discover, fingerprint) {
    return {
        id: id,
        schemaVersions: [1],
        discover: discover,
        fingerprint: fingerprint || function () { return Promise.resolve('fingerprint'); },
        load: function (context, descriptor) { return Promise.resolve({ descriptor: descriptor }); },
        readArtifact: function () { return Promise.reject(new Error('没有成果')); }
    };
}

function genericRegistry() {
    return new InitiativeProviderRegistry([new GenericInitiativeProvider()]);
}

async function invalidateGenericManifest(fixture, initiativeId) {
    var relativePath = 'openspec/initiatives/' + initiativeId + '/initiative.yaml';
    var content = await fsPromises.readFile(path.join(fixture.root, relativePath), 'utf8');
    await fixture.write(relativePath, content.replace('schemaVersion: 1', 'schemaVersion: 99'));
}

test('InitiativeDescriptor 拒绝未知字段、动态 app 路径和过大 payload', function () {
    var valid = fakeDescriptor('trusted-provider', 'safe-initiative');
    assert.equal(contract.normalizeDescriptor(valid, 'trusted-provider').id, 'safe-initiative');
    assert.throws(function () {
        contract.normalizeDescriptor(Object.assign({}, valid, { script: './provider.js' }), 'trusted-provider');
    }, /未支持字段/);
    assert.throws(function () {
        contract.normalizeDescriptor(Object.assign({}, valid, { summary: 'x'.repeat(300000) }), 'trusted-provider');
    }, /长度限制|payload/);
});

test('Provider registry 隔离崩溃、重复 ID 和未知版本', async function () {
    var registry = new InitiativeProviderRegistry([
        fakeProvider('a-good-provider', function () { return [fakeDescriptor('a-good-provider', 'shared-id')]; }),
        fakeProvider('b-failing-provider', function () { throw new Error('fixture failure'); }),
        fakeProvider('c-conflict-provider', function () { return [fakeDescriptor('c-conflict-provider', 'shared-id')]; }),
        fakeProvider('d-independent-provider', function () { return [fakeDescriptor('d-independent-provider', 'independent-id')]; })
    ]);
    var result = await registry.discover({ projectRoot: '/fixture' });
    assert.deepEqual(result.initiatives.map(function (item) { return item.providerId; }), ['d-independent-provider']);
    assert.ok(result.diagnostics.some(function (item) { return item.code === 'PROVIDER_DISCOVERY_FAILED'; }));
    assert.ok(result.diagnostics.some(function (item) { return item.code === 'DUPLICATE_INITIATIVE_ID'; }));
    assert.throws(function () {
        return new InitiativeProviderRegistry([Object.assign(fakeProvider('old-provider', function () { return []; }), { schemaVersions: [99] })]);
    }, /不支持/);
});

test('Provider registry 在相同 fingerprint 结果漂移时保留稳定快照', async function () {
    var call = 0;
    var registry = new InitiativeProviderRegistry([
        fakeProvider('unstable-provider', function () {
            call += 1;
            return [fakeDescriptor('unstable-provider', call === 1 ? 'first-result' : 'second-result')];
        })
    ]);
    var first = await registry.discover({ projectRoot: '/fixture' });
    var second = await registry.discover({ projectRoot: '/fixture' });
    assert.equal(first.initiatives[0].id, 'first-result');
    assert.equal(second.initiatives[0].id, 'first-result');
    assert.ok(second.diagnostics.some(function (item) { return item.code === 'UNSTABLE_PROVIDER_RESULT'; }));
});

test('Provider 持续发现失败时 discover 与 check 使用同一 fingerprint 基线', async function () {
    var registry = new InitiativeProviderRegistry([
        fakeProvider('failing-provider', function () { throw new Error('stable discovery failure'); }, function () {
            return Promise.resolve('stable-input');
        })
    ]);
    var result = await registry.discover({ projectRoot: '/fixture' });
    assert.equal(result.initiatives.length, 0);
    assert.equal(result.diagnostics[0].code, 'PROVIDER_DISCOVERY_FAILED');
    assert.equal(contract.sha256(contract.stableJson(result.fingerprints)), await registry.fingerprint({ projectRoot: '/fixture' }));
});

test('Provider 失败时保留明确标记的历史快照', async function () {
    var shouldFail = false;
    var registry = new InitiativeProviderRegistry([
        fakeProvider('recoverable-provider', function () {
            if (shouldFail) { throw new Error('current input invalid'); }
            return [fakeDescriptor('recoverable-provider', 'historical-initiative')];
        }, function () { return Promise.resolve(shouldFail ? 'changed-input' : 'valid-input'); })
    ]);
    var current = await registry.discover({ projectRoot: '/fixture' });
    assert.equal(current.initiatives[0].health, 'healthy');
    shouldFail = true;
    var stale = await registry.discover({ projectRoot: '/fixture' });
    assert.equal(stale.initiatives[0].health, 'attention');
    assert.ok(stale.initiatives[0].diagnostics.some(function (item) { return item.code === 'STALE_PROVIDER_SNAPSHOT'; }));
    assert.equal(contract.sha256(contract.stableJson(stale.fingerprints)), await registry.fingerprint({ projectRoot: '/fixture' }));
});

test('Provider registry 拒绝超过数量上限的 descriptor 集合', async function () {
    var registry = new InitiativeProviderRegistry([
        fakeProvider('oversized-provider', function () {
            return Array.from({ length: contract.MAX_DESCRIPTORS_PER_PROVIDER + 1 }, function (unused, index) {
                return fakeDescriptor('oversized-provider', 'initiative-' + String(index).padStart(3, '0'));
            });
        })
    ]);
    var result = await registry.discover({ projectRoot: '/fixture' });
    assert.equal(result.initiatives.length, 0);
    assert.equal(result.diagnostics[0].code, 'PROVIDER_DISCOVERY_FAILED');
    assert.match(result.diagnostics[0].message, /数量超过限制/);
});

test('普通 Initiative 从固定 YAML 清单发现并保留完整 Change 索引', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixtures.addGenericInitiative(fixture, {});
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        assert.equal(workspace.snapshot.initiatives.length, 1);
        assert.equal(workspace.snapshot.initiatives[0].title, '发布准备专项');
        assert.deepEqual(workspace.snapshot.changes.map(function (change) { return change.id; }).sort(), ['add-feature', 'incomplete-change']);
        assert.deepEqual(workspace.snapshot.changeRelations.independentChangeIds, ['incomplete-change']);
        assert.equal(workspace.snapshot.archives[0].referenceId, 'old-change');
        assert.equal(workspace.snapshot.changeRelations.diagnostics.some(function (item) {
            return item.code === 'DANGLING_CHANGE_REFERENCE' && item.resourceId === 'old-change';
        }), false);
        assert.equal(workspace.snapshot.initiatives[0].artifacts[0].id, 'delivery-outcomes');
        assert.equal(workspace.snapshot.initiatives[0].artifacts[0].path, undefined);
    } finally {
        await fixture.cleanup();
    }
});

test('普通 Initiative 从有效变为无效时保留上版快照并暴露当前诊断', async function () {
    var fixture = await fixtures.createFixtureProject();
    var registry = genericRegistry();
    try {
        var initiativeId = await fixtures.addGenericInitiative(fixture, {});
        var current = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        assert.equal(current.snapshot.initiatives[0].health, 'healthy');

        await invalidateGenericManifest(fixture, initiativeId);
        var stale = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        assert.equal(stale.snapshot.initiatives.length, 1);
        assert.equal(stale.snapshot.initiatives[0].id, initiativeId);
        assert.equal(stale.snapshot.initiatives[0].health, 'attention');
        assert.ok(stale.snapshot.initiatives[0].diagnostics.some(function (item) {
            return item.code === 'STALE_PROVIDER_SNAPSHOT';
        }));
        assert.ok(stale.snapshot.initiativeDiagnostics.some(function (item) {
            return item.code === 'INVALID_GENERIC_INITIATIVE' && item.initiativeId === initiativeId;
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('普通 Initiative 部分无效时只降级失败条目并保留有效条目', async function () {
    var fixture = await fixtures.createFixtureProject();
    var registry = genericRegistry();
    try {
        await fixtures.addGenericInitiative(fixture, { id: 'first-initiative' });
        await fixtures.addGenericInitiative(fixture, { id: 'second-initiative' });
        var initial = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        var initialSecondHash = initial.snapshot.initiatives.find(function (item) {
            return item.id === 'second-initiative';
        }).sourceHash;

        await invalidateGenericManifest(fixture, 'first-initiative');
        var secondManifestPath = path.join(fixture.root, 'openspec', 'initiatives', 'second-initiative', 'initiative.yaml');
        var secondManifest = await fsPromises.readFile(secondManifestPath, 'utf8');
        await fixture.write(
            'openspec/initiatives/second-initiative/initiative.yaml',
            secondManifest.replace('title: 发布准备专项', 'title: 第二版发布准备专项')
        );
        var partial = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        assert.deepEqual(partial.snapshot.initiatives.map(function (item) {
            return { id: item.id, health: item.health };
        }), [
            { id: 'first-initiative', health: 'attention' },
            { id: 'second-initiative', health: 'healthy' }
        ]);
        assert.equal(partial.snapshot.initiativeDiagnostics.filter(function (item) {
            return item.code === 'INVALID_GENERIC_INITIATIVE';
        }).length, 1);
        var secondVersion = partial.snapshot.initiatives.find(function (item) {
            return item.id === 'second-initiative';
        });
        assert.equal(secondVersion.title, '第二版发布准备专项');
        assert.notEqual(secondVersion.sourceHash, initialSecondHash);

        await invalidateGenericManifest(fixture, 'second-initiative');
        var allInvalid = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        assert.deepEqual(allInvalid.snapshot.initiatives.map(function (item) {
            return { id: item.id, health: item.health };
        }), [
            { id: 'first-initiative', health: 'attention' },
            { id: 'second-initiative', health: 'attention' }
        ]);
        var staleSecondVersion = allInvalid.snapshot.initiatives.find(function (item) {
            return item.id === 'second-initiative';
        });
        assert.equal(staleSecondVersion.title, '第二版发布准备专项');
        assert.equal(staleSecondVersion.sourceHash, secondVersion.sourceHash);
    } finally {
        await fixture.cleanup();
    }
});

test('普通 Initiative 合法删除为空会更新缓存而不是保留 stale 快照', async function () {
    var fixture = await fixtures.createFixtureProject();
    var registry = genericRegistry();
    try {
        var initiativeId = await fixtures.addGenericInitiative(fixture, {});
        await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        await fsPromises.rm(path.join(fixture.root, 'openspec', 'initiatives', initiativeId), { recursive: true });
        var empty = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        assert.equal(empty.snapshot.initiatives.length, 0);

        await fixture.write('openspec/initiatives/' + initiativeId + '/initiative.yaml', [
            'schemaVersion: 99',
            'id: ' + initiativeId,
            'title: Invalid recreated initiative',
            'status: active',
            'health: healthy',
            ''
        ].join('\n'));
        var invalidAfterDelete = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider,
            initiativeRegistry: registry
        });
        assert.equal(invalidAfterDelete.snapshot.initiatives.length, 0);
        assert.ok(invalidAfterDelete.snapshot.initiativeDiagnostics.some(function (item) {
            return item.code === 'INVALID_GENERIC_INITIATIVE';
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('普通 Initiative 成果每次读取都重新校验 source hash 与真实路径', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixtures.addGenericInitiative(fixture, {});
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        var descriptor = workspace.snapshot.initiatives[0];
        var provider = new GenericInitiativeProvider();
        var loaded = await provider.load(workspace.roots, descriptor);
        var artifact = await provider.readArtifact(workspace.roots, descriptor, {
            sourceHash: loaded.sourceHash,
            artifactId: 'delivery-outcomes'
        });
        assert.match(artifact.content, /已完成核心准备/);

        await fixture.write('openspec/initiatives/launch-readiness/outcomes.md', '# 已替换\n');
        await assert.rejects(function () {
            return provider.readArtifact(workspace.roots, descriptor, {
                sourceHash: loaded.sourceHash,
                artifactId: 'delivery-outcomes'
            });
        }, function (error) { return error.code === 'STALE_INITIATIVE'; });

        await assert.rejects(function () {
            return provider.readArtifact(workspace.roots, descriptor, {
                sourceHash: loaded.sourceHash,
                artifactId: '../../outside-secret.md'
            });
        }, /ID 格式无效|版本已变化/);
    } finally {
        await fixture.cleanup();
    }
});

test('普通 Initiative 拒绝未知 schema、越界路径和符号链接', async function (context) {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixture.write('openspec/initiatives/unknown-version/initiative.yaml', 'schemaVersion: 9\nid: unknown-version\ntitle: Unknown\nstatus: active\nhealth: healthy\n');
        await fixture.write('openspec/initiatives/path-escape/initiative.yaml', [
            'schemaVersion: 1', 'id: path-escape', 'title: Escape', 'status: active', 'health: healthy',
            'artifacts:', '  - id: secret', '    title: Secret', '    path: ../outside-secret.md', ''
        ].join('\n'));
        var symlinkPath = path.join(fixture.root, 'openspec', 'initiatives', 'linked-manifest');
        await fsPromises.mkdir(symlinkPath, { recursive: true });
        try {
            await fsPromises.symlink(fixture.outsideFile, path.join(symlinkPath, 'initiative.yaml'));
        } catch (error) {
            context.skip('Current filesystem does not permit symbolic links');
            return;
        }
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        assert.equal(workspace.snapshot.initiatives.length, 0);
        assert.equal(workspace.snapshot.initiativeDiagnostics.filter(function (item) {
            return item.code === 'INVALID_GENERIC_INITIATIVE';
        }).length, 3);
    } finally {
        await fixture.cleanup();
    }
});

test('Change 多重 owned 产生诊断并仍留在独立范围', function () {
    var relation = contract.createRelationshipIndex([{ id: 'shared-change' }], [
        fakeDescriptor('provider-one', 'initiative-one', [{ id: 'shared-change', relationship: 'owned' }]),
        fakeDescriptor('provider-two', 'initiative-two', [{ id: 'shared-change', relationship: 'owned' }])
    ]);
    assert.deepEqual(relation.independentChangeIds, ['shared-change']);
    assert.equal(relation.diagnostics[0].code, 'MULTIPLE_CHANGE_OWNERS');
    var dangling = contract.createRelationshipIndex([{ id: 'known-change' }], [
        fakeDescriptor('provider-one', 'initiative-one', [{ id: 'missing-change', relationship: 'related' }])
    ]);
    assert.equal(dangling.diagnostics[0].code, 'DANGLING_CHANGE_REFERENCE');
    assert.deepEqual(dangling.independentChangeIds, ['known-change']);
});

test('普通 Initiative 拒绝项目声明的 Provider 代码、CLI、HTML 和外部 URL', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixture.write('openspec/initiatives/executable-provider/initiative.yaml', [
            'schemaVersion: 1',
            'id: executable-provider',
            'title: Executable',
            'status: active',
            'health: unknown',
            'provider: ./provider.js',
            'command: node provider.js',
            'html: dashboard.html',
            ''
        ].join('\n'));
        await fixture.write('openspec/initiatives/external-artifact/initiative.yaml', [
            'schemaVersion: 1',
            'id: external-artifact',
            'title: External',
            'status: active',
            'health: unknown',
            'artifacts:',
            '  - id: remote',
            '    title: Remote',
            '    path: https://example.com/payload.md',
            ''
        ].join('\n'));
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        assert.equal(workspace.snapshot.initiatives.length, 0);
        assert.equal(workspace.snapshot.initiativeDiagnostics.length, 2);
        assert.ok(workspace.snapshot.initiativeDiagnostics.every(function (item) {
            return item.code === 'INVALID_GENERIC_INITIATIVE';
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('成果在发现后被替换为符号链接时拒绝读取', async function (context) {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixtures.addGenericInitiative(fixture, {});
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        var descriptor = workspace.snapshot.initiatives[0];
        var artifactPath = path.join(fixture.root, 'openspec', 'initiatives', 'launch-readiness', 'outcomes.md');
        await fsPromises.unlink(artifactPath);
        try {
            await fsPromises.symlink(fixture.outsideFile, artifactPath);
        } catch (error) {
            context.skip('Current filesystem does not permit symbolic links');
            return;
        }
        await assert.rejects(function () {
            return workspace.initiativeRegistry.readArtifact(workspace.roots, descriptor, {
                sourceHash: descriptor.sourceHash,
                artifactId: 'delivery-outcomes'
            });
        }, /符号链接/);
    } finally {
        await fixture.cleanup();
    }
});

test('普通 Initiative 拒绝超过 payload 限制的成果', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixture.write('openspec/initiatives/oversized/payload.md', 'x'.repeat(1048577));
        await fixture.write('openspec/initiatives/oversized/initiative.yaml', [
            'schemaVersion: 1', 'id: oversized', 'title: Oversized', 'status: active', 'health: unknown',
            'artifacts:', '  - id: oversized-payload', '    title: Oversized payload',
            '    path: initiatives/oversized/payload.md', ''
        ].join('\n'));
        var workspace = await workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
            statusProvider: fixtures.inferredStatusProvider
        });
        assert.equal(workspace.snapshot.initiatives.length, 0);
        assert.match(workspace.snapshot.initiativeDiagnostics[0].message, /超过读取限制/);
    } finally {
        await fixture.cleanup();
    }
});
