'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var fs = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var files = require('../src/core/archive-files');
var planner = require('../src/core/archive-plan');
var cliModule = require('../src/core/archive-cli');
var transaction = require('../src/core/archive-transaction');
var fixtureModule = require('./archive-fixture');
var createFixture = fixtureModule.createArchiveFixture;
var WorkbenchService = require('../src/main/workbench-service').WorkbenchService;
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;

function options(fixture, extra) { return Object.assign({ cliOptions: { command: fixture.cli } }, extra || {}); }
async function planFor(fixture, extra) { return planner.prepare(fixture.root, fixture.changeId, options(fixture, extra)); }

test('归档预览不写原项目，提交逐字节匹配预览并保留全部 Change 内容', async function () {
    var fixture = await createFixture({ incomplete: true });
    try {
        await fixture.write('implementation.js', 'const keep = true;\n');
        var original = await files.capture(fixture.root, fixture.changeId);
        var plan = await planFor(fixture);
        assert.equal(plan.preview.syncState, 'needs-sync');
        assert.equal(plan.preview.changes.length, 1);
        assert.equal(plan.preview.warnings[0].id, 'tasks:incomplete');
        assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), files.digest(original));
        var result = await transaction.commit(plan, fixture.recoveryDirectory);
        assert.equal(result.state, 'completed');
        assert.equal(await fs.readFile(path.join(fixture.root, plan.changes[0].path), 'utf8'), plan.changes[0].after);
        var archived = await files.readTree(fixture.root, [plan.destination]);
        assert.equal(files.digest(original, plan.source), files.digest(archived, plan.destination));
        assert.equal(await fs.readFile(path.join(fixture.root, 'implementation.js'), 'utf8'), 'const keep = true;\n');
        await assert.rejects(fs.stat(path.join(fixture.root, plan.source)), { code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
});

test('无增量和已同步的归档不重写正式规范，日期前缀不叠加', async function () {
    for (var setting of [{ noDelta: true }, { changeId: '2026-01-02-add-example' }]) {
        var fixture = await createFixture(setting);
        try {
            if (!setting.noDelta) {
                var synced = await planFor(fixture);
                await fixture.write('openspec/specs/example/spec.md', synced.changes[0].after);
            }
            var specPath = path.join(fixture.root, 'openspec/specs/example/spec.md');
            var before = await fs.stat(specPath);
            var plan = await planFor(fixture);
            assert.equal(plan.preview.syncState, setting.noDelta ? 'no-delta' : 'already-synced');
            assert.equal(plan.changes.length, 0);
            if (!setting.noDelta) { assert.equal(plan.archivedAs, fixture.changeId); }
            assert.equal((await transaction.commit(plan, fixture.recoveryDirectory)).state, 'completed');
            assert.equal((await fs.stat(specPath)).mtimeMs, before.mtimeMs);
        } finally { await fixture.cleanup(); }
    }
});

test('真实 OpenSpec CLI 兼容性覆盖增删改重命名、退役、无增量及已同步', async function (context) {
    var fixture = await createFixture({ fake: false });
    try {
        try { await cliModule.resolve(fixture.root); } catch (error) { if (error.code === 'ARCHIVE_CLI_UNAVAILABLE') { context.skip('未安装外部 OpenSpec CLI；其余归档测试使用隔离契约夹具'); return; } throw error; }
    } finally { await fixture.cleanup(); }
    var requirement = fixtureModule.requirement;
    var cases = [
        { name: 'added', expected: 'New state' },
        { name: 'modified', delta: '## MODIFIED Requirements\n\n' + requirement('Existing state', 'Existing scenario', 'show the updated state.'), expected: 'updated state' },
        { name: 'renamed', delta: '## RENAMED Requirements\n- FROM: `### Requirement: Existing state`\n- TO: `### Requirement: Renamed state`\n', expected: 'Renamed state' },
        { name: 'retired', retire: true, delta: '## REMOVED Requirements\n\n### Requirement: Existing state\n**Reason**: Capability retired.\n**Migration**: Use the replacement capability.\n', removed: true },
        { name: 'no-delta', noDelta: true },
        { name: 'already-synced', synced: true }
    ];
    for (var item of cases) {
        await context.test(item.name, async function () {
            var current = await createFixture(Object.assign({ fake: false }, item));
            try {
                if (item.synced) { var first = await planFor(current); await current.write('openspec/specs/example/spec.md', first.changes[0].after); }
                var plan = await planFor(current);
                assert.equal((await transaction.commit(plan, current.recoveryDirectory)).state, 'completed');
                if (item.removed) { await assert.rejects(fs.stat(path.join(current.root, 'openspec/specs/example/spec.md')), { code: 'ENOENT' }); }
                else if (item.expected) { assert.match(await fs.readFile(path.join(current.root, 'openspec/specs/example/spec.md'), 'utf8'), new RegExp(item.expected)); }
                else { assert.equal(plan.changes.length, 0); }
            } finally { await current.cleanup(); }
        });
    }
});

test('真实 CLI 校验失败不修改原项目', async function (context) {
    var fixture = await createFixture({ fake: false, delta: '## MODIFIED Requirements\n### Requirement: Unknown requirement\nThe system SHALL fail.\n' });
    try {
        try { await cliModule.resolve(fixture.root); } catch (error) { if (error.code === 'ARCHIVE_CLI_UNAVAILABLE') { context.skip('需要外部 CLI'); return; } throw error; }
        var before = files.digest(await files.capture(fixture.root, fixture.changeId));
        await assert.rejects(planFor(fixture), { code: 'ARCHIVE_VALIDATION_FAILED' });
        assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
    } finally { await fixture.cleanup(); }
});

test('任务警告采用 CLI 的嵌套与示例复选框计数，不因 GUI 阅读解析而遗漏', async function () {
    var fixture = await createFixture();
    try {
        await fixture.write(fixture.source + '/tasks.md', '- [x] 1.1 Done\n  * [ ] Nested task\n```md\n- [ ] Example task\n```\n');
        var plan = await planFor(fixture);
        assert.deepEqual(plan.preview.tasks, { completed: 1, total: 3 });
        assert.match(plan.preview.warnings[0].message, /2 项任务/);
    } finally { await fixture.cleanup(); }
});

test('预览后文件增删、等长等时修改、CLI 变化、日期变化和目标占用均拒绝提交', async function (context) {
    var cases = {
        'same-time': async function (fixture) { var target = path.join(fixture.root, 'openspec/specs/example/spec.md'); var stat = await fs.stat(target); var content = await fs.readFile(target, 'utf8'); await fs.writeFile(target, content.replace('Existing state', 'Replaced state')); await fs.utimes(target, stat.atime, stat.mtime); },
        'binary-add': async function (fixture) { await fixture.write(fixture.source + '/another.dat', Buffer.from([9, 4])); },
        'binary-delete': async function (fixture) { await fs.unlink(path.join(fixture.root, fixture.source, 'evidence/blob.bin')); },
        'directory-replaced': async function (fixture) { var target = path.join(fixture.root, fixture.source); var replacement = path.join(fixture.root, 'replacement'); await fs.cp(target, replacement, { recursive: true }); await fs.rm(target, { recursive: true }); await fs.rename(replacement, target); },
        config: async function (fixture) { await fixture.write('openspec/config.yaml', 'schema: spec-driven\ncontext: changed\n'); },
        cli: async function (fixture) { await fs.appendFile(fixture.cli, '\n// upgraded\n'); },
        destination: async function (fixture, plan) { await fs.mkdir(path.join(fixture.root, plan.destination), { recursive: true }); }
    };
    for (var name of Object.keys(cases)) {
        await context.test(name, async function () {
            var fixture = await createFixture();
            try {
                var plan = await planFor(fixture);
                await cases[name](fixture, plan);
                var before = files.digest(await files.capture(fixture.root, fixture.changeId));
                await assert.rejects(transaction.commit(plan, fixture.recoveryDirectory), function (error) { return ['ARCHIVE_STALE', 'ARCHIVE_DESTINATION_EXISTS'].includes(error.code); });
                assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
            } finally { await fixture.cleanup(); }
        });
    }
    var fixture = await createFixture();
    try {
        var plan = await planFor(fixture);
        await assert.rejects(transaction.commit(plan, fixture.recoveryDirectory, { now: function () { return '2030-01-01T12:00:00'; } }), { code: 'ARCHIVE_STALE' });
    } finally { await fixture.cleanup(); }
});

test('取消、预检中刷新和切换项目均使归档计划失效，跨项目确认不能写入', async function () {
    var fixture = await createFixture();
    var other = await createFixture();
    var service = new WorkbenchService(new ProjectRegistry(path.join(fixture.base, 'user/projects.json')), { cliOptions: { command: fixture.cli }, statusProvider: async function () { return { source: 'inferred', items: new Map() }; } });
    try {
        await service.initialize();
        var one = (await service.addProjects([fixture.root])).added[0].id;
        var two = (await service.addProjects([other.root])).added[0].id;
        await service.selectProject(one);
        var workspace = await service.loadWorkspace(false);
        var request = { projectId: one, revision: workspace.revision, changeId: fixture.changeId };
        var before = files.digest(await files.capture(fixture.root, fixture.changeId));
        var first = await service.prepareArchive(request);
        service.discardArchive({ projectId: one, revision: request.revision, planId: first.planId });
        assert.throws(function () { service.commitArchive({ projectId: one, revision: request.revision, planId: first.planId, acceptedWarnings: [] }); }, { code: 'ARCHIVE_STALE' });
        var second = await service.prepareArchive(request);
        assert.throws(function () { service.commitArchive({ projectId: two, revision: request.revision, planId: second.planId, acceptedWarnings: [] }); }, { code: 'ARCHIVE_STALE' });
        await service.selectProject(two);
        assert.throws(function () { service.commitArchive({ projectId: one, revision: request.revision, planId: second.planId, acceptedWarnings: [] }); }, { code: 'ARCHIVE_STALE' });
        assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
        await service.selectProject(one);
        workspace = await service.loadWorkspace(false);
        request.revision = workspace.revision;
        // Make the actual preflight slow enough to exercise invalidation while it runs.
        var source = await fs.readFile(fixture.cli, 'utf8');
        await fs.writeFile(fixture.cli, source.replace("const args = process.argv.slice(2);", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80); const args = process.argv.slice(2);"));
        var preparing = service.prepareArchive(request);
        service.invalidate();
        await assert.rejects(preparing, function (error) { return ['ARCHIVE_STALE', 'STALE_WORKSPACE'].includes(error.code); });
        assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
    } finally { await fixture.cleanup(); await other.cleanup(); }
});

test('预演期间外部修改和提交中的目标碰撞均不被静默接受', async function () {
    var fixture = await createFixture();
    try {
        var originalCli = await fs.readFile(fixture.cli, 'utf8');
        var liveFile = path.join(fixture.root, fixture.source, 'during.dat');
        await fs.writeFile(fixture.cli, originalCli.replace("else if(cmd==='archive') {", "else if(cmd==='archive') { fs.writeFileSync(" + JSON.stringify(liveFile) + ",'outside change');"));
        await assert.rejects(planFor(fixture), { code: 'ARCHIVE_STALE' });
        assert.equal(await fs.readFile(liveFile, 'utf8'), 'outside change');
        await fs.writeFile(fixture.cli, originalCli);
        var before = files.digest(await files.capture(fixture.root, fixture.changeId));
        var plan = await planFor(fixture);
        var result = await transaction.commit(plan, fixture.recoveryDirectory, { onStep: async function (stage) { if (stage === 'before-move') { await fixture.write(plan.destination + '/external.txt', 'occupied'); } } });
        assert.equal(result.state, 'restored');
        assert.equal(await fs.readFile(path.join(fixture.root, plan.destination, 'external.txt'), 'utf8'), 'occupied');
        assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
    } finally { await fixture.cleanup(); }
});

test('符号链接、越界结果、非规范修改和文件遗漏不能生成可执行计划', async function (context) {
    var cases = {
        'change-symlink': async function (fixture) { await fs.symlink(path.join(fixture.base, 'fixture-cli.js'), path.join(fixture.root, fixture.source, 'link.js')); },
        'spec-directory-symlink': async function (fixture) { var target = path.join(fixture.root, 'openspec/specs'); await fs.rename(target, path.join(fixture.base, 'outside-specs')); await fs.symlink(path.join(fixture.base, 'outside-specs'), target); }
    };
    for (var name of Object.keys(cases)) {
        await context.test(name, async function () { var fixture = await createFixture(); try { await cases[name](fixture); await assert.rejects(planFor(fixture), { code: 'ARCHIVE_PATH_FORBIDDEN' }); } finally { await fixture.cleanup(); } });
    }
    for (var mutation of ["fs.writeFileSync(path.join(root,'implementation.js'),'bad');", "fs.writeFileSync(path.join(root,'openspec/config.yaml'),'bad');", "fs.unlinkSync(path.join(source,'evidence/blob.bin'));", "fs.writeFileSync(path.join(root,'openspec/specs/extra.txt'),'bad');"]) {
        var fixture = await createFixture({ fakeArchive: mutation });
        try {
            var before = files.digest(await files.capture(fixture.root, fixture.changeId));
            await assert.rejects(planFor(fixture), function (error) { return ['ARCHIVE_RESULT_INVALID', 'ARCHIVE_PATH_FORBIDDEN'].includes(error.code); });
            assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
        } finally { await fixture.cleanup(); }
    }
});

test('截断或不兼容的 CLI 输出、超时和预览体积限制不能继续归档', async function () {
    var fixture = await createFixture();
    try {
        await assert.rejects(planFor(fixture, { maxPreviewBytes: 10 }), { code: 'ARCHIVE_LIMIT' });
        await assert.rejects(planFor(fixture, { maxOutputBytes: 10 }), { code: 'ARCHIVE_LIMIT' });
        await fs.writeFile(fixture.cli, '#!/usr/bin/env node\nsetTimeout(()=>{},5000);\n');
        await assert.rejects(planFor(fixture, { timeoutMs: 30 }), { code: 'ARCHIVE_CLI_TIMEOUT' });
        await fs.writeFile(fixture.cli, '#!/usr/bin/env node\nconsole.log("unsupported");\n');
        await assert.rejects(planFor(fixture), { code: 'ARCHIVE_CLI_INCOMPATIBLE' });
    } finally { await fixture.cleanup(); }
});

test('规范新增、修改、删除及目录移动各阶段的故障安全恢复原项目', async function (context) {
    var mutations = {
        modified: undefined,
        added: "fs.mkdirSync(path.join(root,'openspec/specs/fresh'),{recursive:true}); fs.writeFileSync(path.join(root,'openspec/specs/fresh/spec.md'),'# New specification\\n');",
        removed: "fs.unlinkSync(path.join(root,'openspec/specs/example/spec.md'));"
    };
    for (var kind of Object.keys(mutations)) {
        for (var stage of ['reserved', 'backed-up', 'file-written', 'before-move', 'moved']) {
            await context.test(kind + ':' + stage, async function () {
                var fixture = await createFixture({ fakeArchive: mutations[kind] });
                try {
                    var before = files.digest(await files.capture(fixture.root, fixture.changeId));
                    var plan = await planFor(fixture);
                    var result = await transaction.commit(plan, fixture.recoveryDirectory, { onStep: function (current) { if (current === stage) { throw new Error('injected ' + stage); } } });
                    assert.equal(result.state, 'restored', JSON.stringify(result));
                    assert.equal(files.digest(await files.capture(fixture.root, fixture.changeId)), before);
                    assert.deepEqual(await transaction.recoveries(fixture.recoveryDirectory, fixture.root), []);
                } finally { await fixture.cleanup(); }
            });
        }
    }
});

test('恢复不会覆盖外部修改，未决恢复阻止新归档，手动修复后可重新核对', async function () {
    var fixture = await createFixture();
    try {
        var plan = await planFor(fixture);
        var result = await transaction.commit(plan, fixture.recoveryDirectory, { onStep: async function (stage, record, change) {
            if (stage === 'file-written') { await fixture.write(change.path, 'external writer\n'); throw new Error('write failed'); }
        } });
        assert.equal(result.state, 'needs-recovery');
        assert.equal(await fs.readFile(path.join(fixture.root, 'openspec/specs/example/spec.md'), 'utf8'), 'external writer\n');
        var records = await transaction.recoveries(fixture.recoveryDirectory, fixture.root);
        assert.equal(records.length, 1);
        var nextPlan = await planFor(fixture);
        await assert.rejects(transaction.commit(nextPlan, fixture.recoveryDirectory), { code: 'ARCHIVE_RECOVERY_REQUIRED' });
        await fixture.write('openspec/specs/example/spec.md', fixture.main);
        assert.deepEqual(await transaction.recoveries(fixture.recoveryDirectory, fixture.root), []);
    } finally { await fixture.cleanup(); }
});

test('外部编辑器持有原文件句柄时保留其写入，不把恢复误报为成功', async function () {
    var fixture = await createFixture();
    var handle;
    try {
        var plan = await planFor(fixture);
        handle = await fs.open(path.join(fixture.root, 'openspec/specs/example/spec.md'), 'r+');
        var result = await transaction.commit(plan, fixture.recoveryDirectory, { onStep: async function (stage) {
            if (stage === 'file-written') { await handle.truncate(0); await handle.write('external open descriptor\n', 0, 'utf8'); }
        } });
        assert.equal(result.state, 'needs-recovery');
        assert.equal(await fs.readFile(path.join(fixture.root, 'openspec/specs/example/spec.md'), 'utf8'), 'external open descriptor\n');
        await fs.stat(path.join(fixture.root, fixture.source));
    } finally { if (handle) { await handle.close(); } await fixture.cleanup(); }
});

test('进程中断后仅核对真实结果，部分提交需恢复、完整结果识别为成功', async function () {
    for (var stage of ['file-written', 'moved']) {
        var fixture = await createFixture();
        try {
            var script = "const p=require('./src/core/archive-plan');const t=require('./src/core/archive-transaction');(async()=>{const plan=await p.prepare(process.argv[1],'add-example',{cliOptions:{command:process.argv[2]}});await t.commit(plan,process.argv[3],{onStep:(stage)=>{if(stage===process.argv[4])process.exit(23);}});})().catch(e=>{console.error(e);process.exit(1);});";
            var code = await new Promise(function (resolve, reject) {
                var child = childProcess.spawn(process.execPath, ['-e', script, fixture.root, fixture.cli, fixture.recoveryDirectory, stage], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
                child.on('error', reject); child.on('exit', resolve);
            });
            assert.equal(code, 23);
            var records = await transaction.recoveries(fixture.recoveryDirectory, fixture.root);
            assert.equal(records.length, stage === 'moved' ? 0 : 1);
            var names = await fs.readdir(fixture.recoveryDirectory);
            var record = JSON.parse(await fs.readFile(path.join(fixture.recoveryDirectory, names.find(function (name) { return name.endsWith('.json'); })), 'utf8'));
            assert.equal(record.state, stage === 'moved' ? 'completed' : 'writing');
        } finally { await fixture.cleanup(); }
    }
});

test('服务绑定项目和 revision、要求接受警告、拒绝旧预览并去重提交', async function () {
    var fixture = await createFixture({ incomplete: true });
    var service = new WorkbenchService(new ProjectRegistry(path.join(fixture.base, 'userdata/projects.json')), { cliOptions: { command: fixture.cli }, statusProvider: async function () { return { source: 'inferred', items: new Map() }; } });
    try {
        await service.initialize(); await service.addProjects([fixture.root]);
        var workspace = await service.loadWorkspace(false);
        var request = { projectId: workspace.projectId, revision: workspace.revision, changeId: fixture.changeId };
        var preview = await service.prepareArchive(request);
        var commit = { projectId: request.projectId, revision: request.revision, planId: preview.planId, acceptedWarnings: [] };
        assert.throws(function () { service.commitArchive(commit); }, { code: 'ARCHIVE_WARNINGS_REQUIRED' });
        commit.acceptedWarnings = preview.warnings.map(function (warning) { return warning.id; });
        var first = service.commitArchive(commit);
        var second = service.commitArchive(commit);
        assert.equal(first, second);
        await assert.rejects(service.selectProject(request.projectId), { code: 'ARCHIVE_BUSY' });
        assert.equal((await first).state, 'completed');
        assert.equal((await service.commitArchive(commit)).state, 'completed');
        assert.equal((await service.loadWorkspace(false)).snapshot.archives.length, 1);
    } finally { await fixture.cleanup(); }
    var other = await createFixture();
    var another = new WorkbenchService(new ProjectRegistry(path.join(other.base, 'userdata/projects.json')), { cliOptions: { command: other.cli }, statusProvider: async function () { return { source: 'inferred', items: new Map() }; } });
    try {
        await another.initialize(); await another.addProjects([other.root]);
        var snapshot = await another.loadWorkspace(false);
        var preview = await another.prepareArchive({ projectId: snapshot.projectId, revision: snapshot.revision, changeId: other.changeId });
        await another.loadWorkspace(true);
        assert.throws(function () { another.commitArchive({ projectId: snapshot.projectId, revision: snapshot.revision, planId: preview.planId, acceptedWarnings: [] }); }, { code: 'ARCHIVE_STALE' });
    } finally { await other.cleanup(); }
});
