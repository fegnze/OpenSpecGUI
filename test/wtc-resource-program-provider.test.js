'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');

var createDefaultInitiativeRegistry = require('../src/core/initiative-providers').createDefaultInitiativeRegistry;
var fixtures = require('./fixtures');
var providerModule = require('../src/core/wtc-resource-program-provider');
var schemaValidator = require('../src/core/wtc-resource-program/schema-validator');
var resourceProgramFixture = require('./wtc-resource-program-fixture');

var CONTRACT_ROOT = resourceProgramFixture.CONTRACT_ROOT;
var FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'wtc-resource-program-v1');
var installProgram = resourceProgramFixture.installProgram;

async function readJson(filePath) {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
}

function contextFor(fixture) {
    return {
        projectRoot: fixture.root,
        openspecRoot: path.join(fixture.root, 'openspec'),
        openspecRealRoot: path.join(fixture.root, 'openspec')
    };
}

test('canonical fixture 由 GUI 独立解析并逐对象匹配 WTC expected outputs', async function () {
    var input = await readJson(path.join(FIXTURE_ROOT, 'canonical-input.json'));
    var outputs = providerModule.buildContractFixture(input);
    assert.deepEqual(outputs.descriptor, await readJson(path.join(FIXTURE_ROOT, 'expected-descriptor.json')));
    assert.deepEqual(outputs.overviewSnapshot, await readJson(path.join(FIXTURE_ROOT, 'expected-overview.json')));
    assert.deepEqual(outputs.artifactIndex, await readJson(path.join(FIXTURE_ROOT, 'expected-artifact-index.json')));

    input.artifacts[0].summary = '';
    input.catalog.readingSections[0].summary = '';
    var fallbackOutputs = providerModule.buildContractFixture(input);
    assert.equal(fallbackOutputs.artifactIndex.artifacts[0].summary, input.artifacts[0].title);
    assert.equal(fallbackOutputs.artifactIndex.readingSections[0].summary,
        input.catalog.readingSections[0].heading);
});

test('固定 sidecar 反例拒绝未知 Provider、版本、ID 和执行字段', async function () {
    var negativeCases = await readJson(path.join(FIXTURE_ROOT, 'negative-cases.json'));
    negativeCases.sidecars.forEach(function (entry) {
        assert.notEqual(providerModule.validateSidecar(entry.value, entry.directoryName).length, 0, entry.name);
    });
});

test('canonical output 反例被递归 schema 拒绝', async function () {
    var negativeCases = await readJson(path.join(FIXTURE_ROOT, 'negative-cases.json'));
    var descriptorSchema = await readJson(path.join(CONTRACT_ROOT, 'initiative-descriptor.schema.json'));
    var diagnosticSchema = await readJson(path.join(CONTRACT_ROOT, 'initiative-diagnostic.schema.json'));
    var overviewSchema = await readJson(path.join(CONTRACT_ROOT, 'initiative-overview.schema.json'));
    var indexSchema = await readJson(path.join(CONTRACT_ROOT, 'initiative-artifact-index.schema.json'));
    var responseSchema = await readJson(path.join(CONTRACT_ROOT, 'initiative-artifact-response.schema.json'));
    var expectedDescriptor = await readJson(path.join(FIXTURE_ROOT, 'expected-descriptor.json'));
    var expectedOverview = await readJson(path.join(FIXTURE_ROOT, 'expected-overview.json'));
    var expectedIndex = await readJson(path.join(FIXTURE_ROOT, 'expected-artifact-index.json'));
    var referenced = {};
    referenced[diagnosticSchema.$id] = diagnosticSchema;
    assert.deepEqual(schemaValidator.validate(descriptorSchema, expectedDescriptor, referenced), []);
    assert.deepEqual(schemaValidator.validate(overviewSchema, expectedOverview), []);
    assert.deepEqual(schemaValidator.validate(indexSchema, expectedIndex), []);

    negativeCases.outputFragments.forEach(function (entry) {
        var errors;
        if (entry.target === 'artifact') {
            var index = JSON.parse(JSON.stringify(expectedIndex));
            index.artifacts[0] = entry.name === 'empty-artifact' ? entry.value :
                Object.assign({}, index.artifacts[0], entry.value);
            errors = schemaValidator.validate(indexSchema, index);
        } else if (entry.target === 'program') {
            var overview = JSON.parse(JSON.stringify(expectedOverview));
            overview.program = entry.value;
            errors = schemaValidator.validate(overviewSchema, overview);
        } else if (entry.target === 'responseMetadata') {
            var response = {
                schemaVersion: 1,
                providerId: 'wtc-resource-program-v1',
                initiativeId: expectedIndex.initiativeId,
                sourceHash: expectedIndex.sourceHash,
                artifactId: expectedIndex.artifacts[0].artifactId,
                mediaType: expectedIndex.artifacts[0].mediaType,
                content: 'fixture',
                metadata: entry.value
            };
            var indexReference = {};
            indexReference[indexSchema.$id] = indexSchema;
            errors = schemaValidator.validate(responseSchema, response, indexReference);
        } else {
            errors = schemaValidator.validate(diagnosticSchema, entry.value);
        }
        assert.notEqual(errors.length, 0, entry.name);
    });
});

test('默认静态 registry 支持零、一和多个 Resource Program 且不写死 Initiative ID', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        assert.ok(createDefaultInitiativeRegistry().list().includes('wtc-resource-program-v1'));
        assert.deepEqual((await provider.discover(contextFor(fixture))).initiatives, []);
        await installProgram(fixture, 'alpha-resource-program');
        var one = await provider.discover(contextFor(fixture));
        assert.deepEqual(one.initiatives.map(function (item) { return item.id; }), ['alpha-resource-program']);
        assert.equal(one.initiatives[0].presentation.appId, 'resource-program-v1');
        assert.equal(one.initiatives[0].changeRefs[0].relationship, 'owned');
        await installProgram(fixture, 'beta-resource-program');
        var multiple = await provider.discover(contextFor(fixture));
        assert.deepEqual(multiple.initiatives.map(function (item) { return item.id; }), [
            'alpha-resource-program', 'beta-resource-program'
        ]);
        var betaSidecarPath = 'openspec/programs/beta-resource-program/initiative-provider.json';
        var duplicateSidecar = JSON.parse(await fsPromises.readFile(
            path.join(fixture.root, betaSidecarPath), 'utf8'
        ));
        duplicateSidecar.initiativeId = 'alpha-resource-program';
        await fixture.write(betaSidecarPath, JSON.stringify(duplicateSidecar, null, 2) + '\n');
        var duplicateAttempt = await provider.discover(contextFor(fixture));
        assert.deepEqual(duplicateAttempt.initiatives.map(function (item) { return item.id; }), [
            'alpha-resource-program'
        ]);
        assert.ok(duplicateAttempt.diagnostics.some(function (item) {
            return item.code === 'SIDECAR_INVALID' && item.initiativeId === 'beta-resource-program';
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('坏 Program 被隔离且不会隐藏同仓库其他有效 Program', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        await installProgram(fixture, 'alpha-resource-program');
        await installProgram(fixture, 'broken-resource-program');
        var statePath = 'openspec/programs/broken-resource-program/program-state.json';
        var state = JSON.parse(await fsPromises.readFile(path.join(fixture.root, statePath), 'utf8'));
        state.executable = 'node provider.js';
        await fixture.write(statePath, JSON.stringify(state, null, 2) + '\n');
        var discovery = await provider.discover(contextFor(fixture));
        assert.deepEqual(discovery.initiatives.map(function (item) { return item.id; }), ['alpha-resource-program']);
        assert.ok(discovery.invalidInitiativeIds.includes('broken-resource-program'));
        assert.ok(discovery.diagnostics.some(function (item) {
            return item.initiativeId === 'broken-resource-program' && item.code === 'AUTHORITY_SCHEMA_INVALID';
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('schema 与 Program 引用递归校验并拒绝未知关键字、悬空 gate 和 contract Change', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'unsafe-schema-program');
        var schemaPath = base + 'contracts/program.schema.json';
        var schema = JSON.parse(await fsPromises.readFile(path.join(fixture.root, schemaPath), 'utf8'));
        schema.allOf = [];
        await fixture.write(schemaPath, JSON.stringify(schema, null, 2) + '\n');
        var unsafeSchema = await provider.discover(contextFor(fixture));
        assert.equal(unsafeSchema.initiatives.length, 0);
        assert.ok(unsafeSchema.diagnostics.some(function (item) { return item.code === 'AUTHORITY_SCHEMA_INVALID'; }));

        await fixture.cleanup();
        fixture = await fixtures.createFixtureProject();
        base = await installProgram(fixture, 'dangling-reference-program');
        var programPath = base + 'program.json';
        var program = JSON.parse(await fsPromises.readFile(path.join(fixture.root, programPath), 'utf8'));
        program.gates[0].requiredChanges = ['missing-change'];
        await fixture.write(programPath, JSON.stringify(program, null, 2) + '\n');
        var danglingGate = await provider.discover(contextFor(fixture));
        assert.equal(danglingGate.initiatives.length, 0);
        assert.match(danglingGate.diagnostics[0].message, /GATE_CHANGE_UNREGISTERED/);

        program.gates[0].requiredChanges = [];
        await fixture.write(programPath, JSON.stringify(program, null, 2) + '\n');
        var statePath = base + 'program-state.json';
        var state = JSON.parse(await fsPromises.readFile(path.join(fixture.root, statePath), 'utf8'));
        state.contractLocks = [{
            lockId: 'sample-lock', producerChangeId: 'missing-change', revision: 1,
            paths: [base + 'program-orchestration-design.md'], sha256: '0'.repeat(64), consumerChangeIds: []
        }];
        await fixture.write(statePath, JSON.stringify(state, null, 2) + '\n');
        var danglingContract = await provider.discover(contextFor(fixture));
        assert.equal(danglingContract.initiatives.length, 0);
        assert.match(danglingContract.diagnostics[0].message, /CONTRACT_PRODUCER_UNREGISTERED/);
    } finally {
        await fixture.cleanup();
    }
});

test('contract lock 使用逐段安全读取重算 hash 并在锁定文件篡改后拒绝 Program', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'contract-hash-program');
        var lockedPath = base + 'program-orchestration-design.md';
        var lockedContent = await fsPromises.readFile(path.join(fixture.root, lockedPath));
        var fileHash = crypto.createHash('sha256').update(lockedContent).digest('hex');
        var lockHash = crypto.createHash('sha256').update(lockedPath + '\0' + fileHash).digest('hex');
        var statePath = base + 'program-state.json';
        var state = JSON.parse(await fsPromises.readFile(path.join(fixture.root, statePath), 'utf8'));
        state.contractLocks = [{
            lockId: 'sample-lock',
            producerChangeId: 'add-feature',
            revision: 1,
            paths: [lockedPath],
            sha256: lockHash,
            consumerChangeIds: []
        }];
        await fixture.write(statePath, JSON.stringify(state, null, 2) + '\n');
        var valid = await provider.discover(contextFor(fixture));
        assert.equal(valid.initiatives.length, 1);
        assert.equal(valid.diagnostics.length, 0);

        await fixture.write(lockedPath, lockedContent.toString('utf8') + '\n篡改内容。\n');
        var tampered = await provider.discover(contextFor(fixture));
        assert.equal(tampered.initiatives.length, 0);
        assert.ok(tampered.diagnostics.some(function (item) {
            return item.code === 'CONTRACT_HASH_MISMATCH' && /sample-lock/.test(item.message);
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('summaryStatus 仅由权威状态派生并按固定优先级降级', function () {
    function documents(changeStatus, gateStatus, blockers) {
        return { state: { changes: [{ status: changeStatus }], gates: [{ status: gateStatus }], blockers: blockers || [] } };
    }
    assert.equal(providerModule.deriveSummaryStatus(documents('accepted', 'passed'), [{ severity: 'error' }], [{ archived: true }]).value, 'invalid');
    assert.equal(providerModule.deriveSummaryStatus(documents('accepted', 'passed', [{ status: 'open' }]), [], [{ archived: true }]).value, 'blocked');
    assert.equal(providerModule.deriveSummaryStatus(documents('needs-review', 'passed'), [], [{ archived: true }]).value, 'needs-review');
    assert.equal(providerModule.deriveSummaryStatus(documents('active', 'passed'), [], [{ archived: false }]).value, 'in-progress');
    assert.deepEqual(providerModule.deriveSummaryStatus(documents('accepted', 'passed'), [], [{ archived: true }]), {
        authority: 'derived', value: 'complete'
    });
});

test('分层 load 稳定、sourceHash 只受权威输入影响且过期读取被拒绝', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'layered-resource-program');
        await fixture.write(base + 'requirements.md', '# Empty Requirements\n');
        var discovery = await provider.discover(contextFor(fixture));
        var descriptor = discovery.initiatives[0];
        var first = await provider.load(contextFor(fixture), descriptor);
        var repeated = await provider.load(contextFor(fixture), descriptor);
        assert.deepEqual(repeated, first);
        assert.equal(first.overviewSnapshot.sourceHash, descriptor.sourceHash);
        assert.equal(first.artifactIndex.sourceHash, descriptor.sourceHash);
        assert.ok(first.artifactIndex.artifacts.length > 0);
        assert.ok(first.artifactIndex.artifacts.every(function (artifact) { return !artifact.content; }));
        assert.equal(first.artifactIndex.artifacts.find(function (artifact) {
            return artifact.path === base + 'requirements.md';
        }).summary, 'Empty Requirements');

        await fixture.write('package.json', '{"name":"unrelated-derived-change"}\n');
        var unaffected = await provider.discover(contextFor(fixture));
        assert.equal(unaffected.initiatives[0].sourceHash, descriptor.sourceHash);

        await fixture.write(base + 'program-orchestration-design.md', '# Program Design\n\n## 结论\n\n权威结论已经变化。\n');
        var changed = await provider.discover(contextFor(fixture));
        assert.notEqual(changed.initiatives[0].sourceHash, descriptor.sourceHash);
        var artifactId = first.artifactIndex.artifacts[0].artifactId;
        await assert.rejects(function () {
            return provider.readArtifact(contextFor(fixture), descriptor, {
                sourceHash: descriptor.sourceHash,
                artifactId: artifactId
            });
        }, /stale/i);
    } finally {
        await fixture.cleanup();
    }
});

test('Resource Program fingerprint 检测保留 mtime 的等长权威修改', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'fingerprint-resource-program');
        var target = path.join(fixture.root, base, 'requirements.md');
        await fixture.write(base + 'requirements.md', '# Requirement\n\nAAAA\n');
        var fixedTime = new Date('2024-01-01T00:00:00.000Z');
        await fsPromises.utimes(target, fixedTime, fixedTime);
        var initial = await provider.fingerprint(contextFor(fixture));

        await fsPromises.writeFile(target, '# Requirement\n\nBBBB\n', 'utf8');
        await fsPromises.utimes(target, fixedTime, fixedTime);
        assert.notEqual(await provider.fingerprint(contextFor(fixture)), initial);
    } finally {
        await fixture.cleanup();
    }
});

test('无签名深目录不会让坏 Program 隐藏同仓库有效 Program', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await installProgram(fixture, 'alpha-resource-program');
        var segments = ['openspec', 'programs', 'broken-resource-program'];
        for (var index = 0; index < 34; index += 1) {
            segments.push('level-' + index);
        }
        await fsPromises.mkdir(path.join.apply(path, [fixture.root].concat(segments)), { recursive: true });

        var result = await createDefaultInitiativeRegistry().discover(contextFor(fixture));
        assert.ok(result.initiatives.some(function (item) {
            return item.providerId === providerModule.PROVIDER_ID && item.id === 'alpha-resource-program';
        }));
        assert.ok(!result.diagnostics.some(function (item) {
            return item.providerId === providerModule.PROVIDER_ID && item.code === 'PROVIDER_DISCOVERY_FAILED';
        }));
    } finally {
        await fixture.cleanup();
    }
});

test('成果按稳定 ID 惰性读取并拒绝未登记 ID、超限正文和符号链接替换', async function (context) {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'artifact-security-program');
        var discovery = await provider.discover(contextFor(fixture));
        var descriptor = discovery.initiatives[0];
        var loaded = await provider.load(contextFor(fixture), descriptor);
        var design = loaded.artifactIndex.artifacts.find(function (artifact) {
            return artifact.path === base + 'program-orchestration-design.md';
        });
        var response = await provider.readArtifact(contextFor(fixture), descriptor, {
            sourceHash: descriptor.sourceHash,
            artifactId: design.artifactId
        });
        assert.equal(response.mediaType, 'text/markdown');
        assert.match(response.content, /SAMPLE-FLOW-01/);
        assert.ok(loaded.artifactIndex.artifacts.every(function (artifact) {
            return ['text/markdown', 'application/json', 'text/plain'].includes(artifact.mediaType);
        }));
        assert.throws(function () {
            providerModule.validateArtifactFile(fixture.root, '../../outside-secret.md', [
                path.join(fixture.root, base)
            ]);
        }, /escapes repository root|outside/);
        await assert.rejects(function () {
            return provider.readArtifact(contextFor(fixture), descriptor, {
                sourceHash: descriptor.sourceHash,
                artifactId: 'artifact-0000000000000000'
            });
        }, /whitelist/);

        await fixture.write(base + 'program-orchestration-design.md',
            '# Oversized\n\n## 结论\n\n' + 'x'.repeat(providerModule.MAX_ARTIFACT_BYTES + 1));
        var oversizedDiscovery = await provider.discover(contextFor(fixture));
        var oversizedDescriptor = oversizedDiscovery.initiatives[0];
        var oversizedLoad = await provider.load(contextFor(fixture), oversizedDescriptor);
        var oversized = oversizedLoad.artifactIndex.artifacts.find(function (artifact) {
            return artifact.path === base + 'program-orchestration-design.md';
        });
        await assert.rejects(function () {
            return provider.readArtifact(contextFor(fixture), oversizedDescriptor, {
                sourceHash: oversizedDescriptor.sourceHash,
                artifactId: oversized.artifactId
            });
        }, /size limit/);

        await fixture.write(base + 'program-orchestration-design.md',
            '# Restored\n\n## 结论\n\nSafe content.\n');
        var beforeSwap = await provider.discover(contextFor(fixture));
        var beforeSwapLoad = await provider.load(contextFor(fixture), beforeSwap.initiatives[0]);
        var beforeSwapArtifact = beforeSwapLoad.artifactIndex.artifacts.find(function (artifact) {
            return artifact.path === base + 'program-orchestration-design.md';
        });
        var artifactPath = path.join(fixture.root, base, 'program-orchestration-design.md');
        await fsPromises.unlink(artifactPath);
        try {
            await fsPromises.symlink(fixture.outsideFile, artifactPath);
        } catch (error) {
            context.skip('Current filesystem does not permit symbolic links');
            return;
        }
        await assert.rejects(function () {
            return provider.readArtifact(contextFor(fixture), beforeSwap.initiatives[0], {
                sourceHash: beforeSwap.initiatives[0].sourceHash,
                artifactId: beforeSwapArtifact.artifactId
            });
        }, /symbolic link|regular file/);
    } finally {
        await fixture.cleanup();
    }
});

test('恶意 Markdown 只作为文本返回且 sidecar 不能声明脚本、HTML、URL 或命令', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'malicious-content-program');
        var marker = 'RESOURCE_PROGRAM_SHOULD_NOT_EXECUTE';
        await fixture.write(base + 'program-orchestration-design.md', [
            '# Malicious', '', '## 结论', '',
            '<script>globalThis.' + marker + ' = true</script>',
            '<img src=x onerror="globalThis.' + marker + '=true">',
            '[remote](https://example.com/payload)', ''
        ].join('\n'));
        var discovery = await provider.discover(contextFor(fixture));
        var loaded = await provider.load(contextFor(fixture), discovery.initiatives[0]);
        var artifact = loaded.artifactIndex.artifacts.find(function (item) {
            return item.path === base + 'program-orchestration-design.md';
        });
        var response = await provider.readArtifact(contextFor(fixture), discovery.initiatives[0], {
            sourceHash: discovery.initiatives[0].sourceHash,
            artifactId: artifact.artifactId
        });
        assert.match(response.content, /<script>/);
        assert.equal(globalThis[marker], undefined);

        var sidecarPath = base + 'initiative-provider.json';
        var sidecar = JSON.parse(await fsPromises.readFile(path.join(fixture.root, sidecarPath), 'utf8'));
        sidecar.command = 'node provider.js';
        sidecar.module = './provider.js';
        sidecar.html = 'dashboard.html';
        sidecar.url = 'https://example.com';
        await fixture.write(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
        var rejected = await provider.discover(contextFor(fixture));
        assert.equal(rejected.initiatives.length, 0);
        assert.ok(rejected.diagnostics.every(function (item) { return item.code === 'SIDECAR_INVALID'; }));
    } finally {
        await fixture.cleanup();
    }
});

test('authority 中间目录符号链接与路径逃逸被发现阶段拒绝', async function (context) {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'linked-authority-program');
        var contractsPath = path.join(fixture.root, base, 'contracts');
        var movedPath = path.join(fixture.root, base, 'contracts-real');
        await fsPromises.rename(contractsPath, movedPath);
        try {
            await fsPromises.symlink(movedPath, contractsPath);
        } catch (error) {
            context.skip('Current filesystem does not permit symbolic links');
            return;
        }
        var linked = await provider.discover(contextFor(fixture));
        assert.equal(linked.initiatives.length, 0);
        assert.ok(linked.diagnostics.some(function (item) { return item.code === 'AUTHORITY_PATH_SYMLINK'; }));
    } finally {
        await fixture.cleanup();
    }
});

test('authority、候选数量与 schema 复杂度都受固定上限约束', async function () {
    var fixture = await fixtures.createFixtureProject();
    var provider = new providerModule.WtcResourceProgramProvider();
    try {
        var base = await installProgram(fixture, 'bounded-resource-program');
        await fixture.write(base + 'program-state.json', ' '.repeat(providerModule.MAX_AUTHORITY_BYTES + 1));
        var oversized = await provider.discover(contextFor(fixture));
        assert.equal(oversized.initiatives.length, 0);
        assert.ok(oversized.diagnostics.some(function (item) {
            return item.code === 'AUTHORITY_FILE_TOO_LARGE';
        }));

        var nested = { type: 'object', additionalProperties: false, properties: {} };
        var cursor = nested;
        for (var depth = 0; depth < 70; depth += 1) {
            cursor.properties.child = { type: 'object', additionalProperties: false, properties: {} };
            cursor = cursor.properties.child;
        }
        assert.ok(providerModule.validateSchemaDefinition(nested, 'deep-schema').some(function (message) {
            return /complexity limits/.test(message);
        }));
    } finally {
        await fixture.cleanup();
    }
});
