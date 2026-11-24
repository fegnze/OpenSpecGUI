'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HostLauncher } = require('../src/main/host-launcher');
const { CapabilityRegistry } = require('../src/main/capability-registry');
const { ChangeArchiveService } = require('../src/main/change-archive-service');
const { readArchivePolicy } = require('../src/main/archive-binding-policy');
const { createArchiveFixture } = require('./archive-fixture');

async function setup(t, options) {
    const f = await createArchiveFixture(options);
    t.after(f.cleanup);
    const userDataPath = path.join(f.base, "member's workbench");
    const launcher = new HostLauncher(userDataPath);
    await launcher.install();
    const project = { id: 'fixture', rootPath: f.root };
    await fs.writeFile(path.join(userDataPath, 'projects.json'), JSON.stringify({ version: 1, projects: [project] }));
    function invoke(args, cwd = f.root, input) {
        const run = spawnSync(launcher.file, args, {
            cwd, env: { ...process.env, OPENSPEC_GUI_CLI: f.cli }, encoding: 'utf8', input, timeout: 20000
        });
        assert.ifError(run.error);
        return { status: run.status, result: run.stdout ? JSON.parse(run.stdout) : null };
    }
    return { ...f, userDataPath, project, invoke };
}

test('同一工作树的桌面和稳定 Agent 入口给出相同预检，写入前重验已审阅内容', async t => {
    const f = await setup(t, { incomplete: true });
    const service = new ChangeArchiveService({ cliOptions: { command: f.cli }, recoveryDirectory: f.recoveryDirectory });
    const request = { projectId: f.project.id, revision: 1, root: f.root, changeId: f.changeId };
    const desktop = await service.prepare(request);
    const preview = f.invoke(['--archive', 'preflight', f.changeId], path.join(f.root, 'openspec'));
    assert.equal(preview.status, 0);
    assert.equal(preview.result.reviewFingerprint, desktop.reviewFingerprint);
    assert.deepEqual(preview.result.changes, desktop.changes);
    assert.deepEqual(preview.result.warnings, desktop.warnings);
    assert.equal(await fs.readFile(path.join(f.root, 'openspec/specs/example/spec.md'), 'utf8'), f.main);
    const args = ['--archive', 'commit', f.changeId, '--review', desktop.reviewFingerprint];
    const warning = f.invoke(args).result;
    assert.equal(warning.code, 'ARCHIVE_WARNINGS_REQUIRED');
    assert.equal(warning.projectId, f.project.id);
    assert.equal(warning.changeId, f.changeId);
    assert.equal(f.invoke(['--archive', 'commit', f.changeId]).result.code, 'ARCHIVE_ARGUMENTS_INVALID');
    const proposal = path.join(f.root, f.source, 'proposal.md');
    await fs.appendFile(proposal, '\n本次审阅后更新。\n');
    args.push('--accept-warning', 'tasks:incomplete');
    assert.equal(f.invoke(args).result.code, 'ARCHIVE_STALE');
    assert.equal(await fs.readFile(path.join(f.root, 'openspec/specs/example/spec.md'), 'utf8'), f.main);
    args[4] = f.invoke(['--archive', 'preflight', f.changeId]).result.reviewFingerprint;
    const archived = f.invoke(args);
    assert.equal(archived.status, 0);
    assert.equal(archived.result.status, 'archived');
    await fs.stat(path.join(f.root, archived.result.destination, 'proposal.md'));
    await assert.rejects(fs.stat(proposal), { code: 'ENOENT' });
    assert.match(await fs.readFile(path.join(f.root, 'openspec/specs/example/spec.md'), 'utf8'), /New scenario/);
    assert.equal(f.invoke(['--archive', 'preflight', f.changeId], f.base).result.code, 'ARCHIVE_PROJECT_MISSING');
});

test('工作树启用同步规则后，桌面及 Agent 预检均阻止尚未同步的规范', async t => {
    const f = await setup(t);
    const service = new ChangeArchiveService({ cliOptions: { command: f.cli }, recoveryDirectory: f.recoveryDirectory,
        getArchivePolicy: root => readArchivePolicy(f.userDataPath, root) });
    const request = { projectId: f.project.id, revision: 1, root: f.root, changeId: f.changeId };
    const registry = new CapabilityRegistry({ userDataPath: f.userDataPath, getActive: () => f.project });
    const { planId } = await registry.preview({ operation: 'bind', id: 'archive-synced-specs', version: '1.0.0',
        host: 'dsh', scope: 'project', projectId: f.project.id });
    await registry.apply({ planId, projectId: f.project.id });
    const agent = f.invoke(['--archive', 'preflight', f.changeId]);
    assert.equal(agent.status, 1);
    await assert.rejects(service.prepare(request), { code: agent.result.code, message: agent.result.message });
    assert.equal(await fs.readFile(path.join(f.root, 'openspec/specs/example/spec.md'), 'utf8'), f.main);
});

test('Agent 确认时只在快照中调用 CLI archive，并通过工作台事务提交', async t => {
    const f = await setup(t, { noDelta: true, fakeArchive: "if(fs.existsSync(path.join(root, 'live-worktree'))) throw Error('原工作树不得执行 CLI archive');" });
    await f.write('live-worktree', 'fixture');
    const preview = f.invoke(['--archive', 'preflight', f.changeId]);
    assert.equal(preview.status, 0);
    const result = f.invoke(['--archive', 'commit', f.changeId, '--review', preview.result.reviewFingerprint]);
    assert.equal(result.status, 0);
    assert.equal(result.result.status, 'archived');
    await fs.stat(path.join(f.root, result.result.destination, 'proposal.md'));
    const journal = path.join(f.userDataPath, 'archive-operations');
    const names = (await fs.readdir(journal)).filter(name => name.endsWith('.json'));
    assert.equal(names.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(journal, names[0]), 'utf8')).state, 'completed');
});

// 用事务已有的阶段回调确定并发写入时机，经过实际 CLI 入口的退出码处理。
async function commitWithConcurrentEdit(f, preview, file, extra) {
    const preload = path.join(f.base, 'concurrent-writer.cjs');
    await fs.writeFile(preload, [
        'const fs = require("node:fs/promises");',
        'const transaction = require(' + JSON.stringify(require.resolve('../src/core/archive-transaction')) + ');',
        'const commit = transaction.commit;',
        'transaction.commit = (plan, directory, options) => commit(plan, directory, { ...options, onStep: async stage => {',
        '  if (stage === "before-move") await fs.appendFile(' + JSON.stringify(file) + ', ' + JSON.stringify(extra) + ');',
        '} });'
    ].join('\n'));
    const run = spawnSync(process.execPath, ['--require', preload, require.resolve('../src/main/workbench-hook.cjs'),
        '--archive', 'commit', f.changeId, '--review', preview.reviewFingerprint], {
        cwd: f.root, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, OPENSPEC_GUI_HOOK_USER_DATA: f.userDataPath, OPENSPEC_GUI_CLI: f.cli }
    });
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    return JSON.parse(run.stdout);
}

test('执行期间新增的任务保留在活跃 Change，Agent 返回非零退出码并允许重新预检', async t => {
    const f = await setup(t);
    const tasks = path.join(f.root, f.source, 'tasks.md');
    const originalTasks = await fs.readFile(tasks, 'utf8');
    const extraTask = '\n- [ ] 2.1 等待另一位成员确认\n';
    const preview = f.invoke(['--archive', 'preflight', f.changeId]).result;
    const blocked = await commitWithConcurrentEdit(f, preview, tasks, extraTask);
    assert.equal(blocked.code, 'ARCHIVE_WRITE_RESTORED');
    assert.equal(blocked.state, 'restored');
    assert.equal(JSON.parse(await fs.readFile(blocked.recordPath, 'utf8')).state, blocked.state);
    assert.equal(await fs.readFile(tasks, 'utf8'), originalTasks + extraTask);
    assert.equal(await fs.readFile(path.join(f.root, 'openspec/specs/example/spec.md'), 'utf8'), f.main);
    await assert.rejects(fs.stat(path.join(f.root, preview.destination)), { code: 'ENOENT' });
    const retry = f.invoke(['--archive', 'preflight', f.changeId]);
    assert.equal(retry.status, 0);
    assert.notEqual(retry.result.reviewFingerprint, preview.reviewFingerprint);
    assert.ok(retry.result.warnings.some(warning => warning.id === 'tasks:incomplete'));
});

test('Agent 保留与已写入规范冲突的外部内容并返回恢复记录', async t => {
    const f = await setup(t);
    const preview = f.invoke(['--archive', 'preflight', f.changeId]).result;
    const spec = path.join(f.root, 'openspec/specs/example/spec.md');
    const extra = '\n成员在此处追加了规则。\n';
    const blocked = await commitWithConcurrentEdit(f, preview, spec, extra);
    assert.equal(blocked.code, 'ARCHIVE_RECOVERY_REQUIRED');
    assert.equal(blocked.state, 'needs-recovery');
    assert.equal(JSON.parse(await fs.readFile(blocked.recordPath, 'utf8')).state, blocked.state);
    assert.ok((await fs.readFile(spec, 'utf8')).endsWith(extra));
    const retry = f.invoke(['--archive', 'preflight', f.changeId]);
    assert.equal(retry.status, 1);
    assert.equal(retry.result.recoveries[0].recordPath, blocked.recordPath);
});

test('绑定变更验证的 OpenSpec 工作树收到受控归档命令，同机其他宿主独立', async t => {
    const f = await setup(t);
    const registry = new CapabilityRegistry({ userDataPath: f.userDataPath, getActive: () => f.project });
    const { planId } = await registry.preview({ operation: 'bind', id: 'verify-changes', version: '1.0.0',
        host: 'codex', scope: 'project', projectId: f.project.id });
    await registry.apply({ planId, projectId: f.project.id });
    const start = JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.root });
    const ctx = f.invoke(['--host', 'codex'], f.root, start).result.hookSpecificOutput.additionalContext;
    assert.match(ctx, /workbench-hook' --archive preflight/);
    assert.equal(f.invoke(['--host', 'claude'], f.root, start).result, null);
});
