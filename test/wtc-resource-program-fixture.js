'use strict';

var fsPromises = require('node:fs/promises');
var path = require('node:path');

var CONTRACT_ROOT = path.join(__dirname, '..', 'src', 'core', 'contracts', 'wtc-resource-program-v1');

async function readJson(filePath) {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
}

async function copyProgramSchemas(fixture, programId) {
    var names = (await fsPromises.readdir(CONTRACT_ROOT)).sort();
    for (var index = 0; index < names.length; index += 1) {
        var name = names[index];
        var schema = await readJson(path.join(CONTRACT_ROOT, name));
        if (schema.properties && schema.properties.programId && schema.properties.programId.const) {
            schema.properties.programId.const = programId;
        }
        await fixture.write('openspec/programs/' + programId + '/contracts/' + name,
            JSON.stringify(schema, null, 2) + '\n');
    }
}

/**
 * 在 OpenSpec 测试项目中安装一个最小但完整的 Resource Program v1。
 * @param {Object} fixture createFixtureProject 返回的测试项目
 * @param {string} programId Program/Initiative ID
 * @param {Object} [settings] 可覆盖 Change 与权威状态
 * @returns {Promise<string>} Program 仓库相对目录
 */
async function installProgram(fixture, programId, settings) {
    var options = settings || {};
    var base = 'openspec/programs/' + programId + '/';
    var changeId = options.changeId || 'add-feature';
    var deliveryStatus = options.deliveryStatus || 'pending';
    await copyProgramSchemas(fixture, programId);
    await fixture.write(base + 'initiative-provider.json', JSON.stringify({
        $schema: 'contracts/initiative-provider.schema.json',
        schemaVersion: 1,
        providerId: 'wtc-resource-program-v1',
        initiativeId: programId,
        summary: '验证 ' + programId + ' 的声明式 Provider'
    }, null, 2) + '\n');
    await fixture.write(base + 'program.json', JSON.stringify({
        $schema: 'contracts/program.schema.json',
        schemaVersion: 1,
        programId: programId,
        title: programId + ' Program',
        changeLifecycleSource: 'openspec',
        workstreams: [{
            workstreamId: 'ws-01-foundation',
            name: '基础',
            objective: '冻结契约',
            document: 'workstreams/ws-01-foundation.md'
        }],
        changes: [{
            changeId: changeId,
            workstreamId: 'ws-01-foundation',
            kind: 'quality',
            risk: 'high',
            resourceSourceAccess: 'none',
            startRequires: ['gate-contract'],
            acceptRequires: ['gate-delivery']
        }],
        gates: [
            { gateId: 'gate-contract', type: 'contract', title: '契约', requiredChanges: [], requiredEvidence: [] },
            { gateId: 'gate-delivery', type: 'delivery', title: '交付', requiredChanges: [], requiredEvidence: [base + 'evidence/verification.md'] },
            { gateId: 'gate-milestone', type: 'milestone', title: '里程碑', requiredChanges: [], requiredEvidence: [] }
        ],
        milestones: [{ milestoneId: 'provider-ready', title: 'Provider Ready', gateId: 'gate-delivery' }]
    }, null, 2) + '\n');
    await fixture.write(base + 'program-state.json', JSON.stringify({
        $schema: 'contracts/program-state.schema.json',
        schemaVersion: 1,
        programId: programId,
        changes: [{ changeId: changeId, status: options.changeStatus || 'active', blockerIds: [] }],
        gates: [
            { gateId: 'gate-contract', status: 'passed', evidence: [] },
            { gateId: 'gate-delivery', status: deliveryStatus, evidence: [] },
            { gateId: 'gate-milestone', status: 'pending', evidence: [] }
        ],
        contractLocks: [],
        contractConsumptions: [],
        impactReviews: [],
        blockers: options.blockers || [],
        legacyMigration: {
            status: 'cleanup-complete',
            disposition: 'migration/disposition.json',
            referencePolicy: 'migration/reference-policy.json',
            verificationEvidence: []
        }
    }, null, 2) + '\n');
    await fixture.write(base + 'assignments.json', JSON.stringify({
        $schema: 'contracts/assignments.schema.json',
        schemaVersion: 1,
        programId: programId,
        assignments: []
    }, null, 2) + '\n');
    await fixture.write(base + 'artifact-taxonomy.json', JSON.stringify({
        $schema: 'contracts/artifact-taxonomy.schema.json',
        schemaVersion: 1,
        programId: programId,
        topics: [{ topicId: 'program-governance', name: 'Program 治理', description: 'Program 契约与门禁' }],
        annotations: [{
            path: base + 'program-orchestration-design.md',
            topics: ['program-governance'],
            featured: true,
            readingSections: [{ heading: '结论', role: 'conclusion', priority: 'primary' }]
        }]
    }, null, 2) + '\n');
    await fixture.write(base + 'requirements.md', '# Requirements\n\nProgram requirements.\n');
    await fixture.write(base + 'program.md', '# Program\n\nProgram summary.\n');
    await fixture.write(base + 'program-orchestration-design.md', [
        '# Program Design', '', '## 结论', '', '当前契约可以安全加载。', '',
        '## SAMPLE-FLOW-01 流程', '', '```mermaid', 'flowchart LR', '  A --> B', '```', ''
    ].join('\n'));
    await fixture.write(base + 'workstreams/ws-01-foundation.md', '# Foundation\n\nWorkstream summary.\n');
    await fixture.write(base + 'decisions/readme.md', '# Decision\n\nDecision summary.\n');
    await fixture.write(base + 'evidence/verification.md', '# Verification\n\nVerification summary.\n');
    return base;
}

module.exports = {
    CONTRACT_ROOT: CONTRACT_ROOT,
    copyProgramSchemas: copyProgramSchemas,
    installProgram: installProgram
};
