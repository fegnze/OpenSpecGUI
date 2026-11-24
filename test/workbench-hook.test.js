'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { CapabilityRegistry } = require('../src/main/capability-registry');

const source = path.resolve(__dirname, '../src/main/workbench-hook.cjs');
const noUserGit = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(root, ...args) {
    return execFileSync('/usr/bin/git', args, { cwd: root, env: noUserGit, stdio: 'pipe' });
}

async function fixture(t) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-hook-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const userData = path.join(dir, 'user data');
    const runner = path.join(userData, 'host-integration', 'bin', 'workbench-hook.cjs');
    await fs.mkdir(path.dirname(runner), { recursive: true });
    await fs.copyFile(source, runner);
    const root = path.join(dir, 'repository');
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    git(root, 'init', '-q');
    await fs.writeFile(path.join(root, 'docs/guide.md'), 'original\n');
    git(root, 'add', 'docs/guide.md');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
    const other = path.join(dir, 'second checkout');
    git(root, 'worktree', 'add', '--detach', '-q', other);
    const projects = [{ id: 'main', rootPath: root }, { id: 'second', rootPath: other }];
    const saveProjects = entries => fs.writeFile(path.join(userData, 'projects.json'), JSON.stringify({ version: 1, projects: entries }));
    await saveProjects(projects);

    async function bind(projectId, host, id, version = '1.0.0') {
        const registry = new CapabilityRegistry({ userDataPath: userData, getActive: () => projects.find(p => p.id === projectId) });
        const { planId } = await registry.preview({ operation: 'bind', id, version, host, scope: 'project', projectId });
        await registry.apply({ planId, projectId });
    }

    function invoke(host, event, useAppSource = false) {
        const result = spawnSync(process.execPath, [useAppSource ? source : runner, '--host', host], { cwd: dir, encoding: 'utf8',
            env: useAppSource ? { OPENSPEC_GUI_HOOK_USER_DATA: userData } : {},
            input: JSON.stringify(event), timeout: 5000 });
        assert.equal(result.error, undefined);
        return { ...result, output: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null };
    }

    async function receipts(projectId, host) {
        const base = path.join(userData, 'host-integration', 'receipts', projectId, host);
        return Promise.all((await fs.readdir(base)).sort().map(async file => JSON.parse(await fs.readFile(path.join(base, file)))));
    }
    return { root, other, dir, userData, bind, invoke, receipts, projects, saveProjects };
}

test('DSH 原生文档工具按模型步骤选择，并在调用时重查会话工作树', async t => {
    const f = await fixture(t);
    const { HostLauncher } = require('../src/main/host-launcher');
    const { listen } = require('../src/main/document-tool-broker');
    const { execute } = require('../src/main/agent-document-tools');
    const { CapabilityProjectServices } = require('../src/main/capability-project-services');
    const services = new CapabilityProjectServices({ userDataPath: f.userData });
    const server = await listen(f.userData, (host, input) => execute(f.userData, services, host, input));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const launcher = new HostLauncher(f.userData);
    await launcher.install();
    await f.bind('main', 'dsh', 'feishu', '3.0.0');
    await f.bind('second', 'claude', 'feishu', '3.0.0');
    const { apply } = await import('../src/main/dsh-plugin/index.mjs');
    const tools = new Map();
    apply({
        on() {}, logger: { warn: assert.fail },
        tools: { guard() {}, register: (definition, { when }) => tools.set(definition.name, { definition, when }) }
    }, { runnerPath: launcher.file });
    let cwd = f.root;
    let local = true;
    const providers = {
        workingDirectory: { get: () => cwd },
        fs: { processPathFromHostPath: hostPath => local ? hostPath : undefined }
    };
    const agent = { session: {}, ctx: { get: key => providers[key] } };
    const signal = new AbortController().signal;
    function step() { return { agent, signal }; }
    const read = tools.get('workbench_feishu_read_document');
    const inspect = tools.get('workbench_feishu_inspect_comment');
    const comment = tools.get('workbench_feishu_add_comment');
    const input = { document: 'https://example.feishu.cn/wiki/FixtureNode0001' };
    const context = step();
    assert.equal(await read.when(context), true);
    assert.equal(await comment.when(context), true);
    assert.equal(await inspect.when(context), true);
    assert.deepEqual(read.definition.parameters.required, ['document']);
    assert.equal(read.definition.parameters.properties.inspectComment, undefined);
    const inspection = { document: 'FixtureDoc0001', inspectComment: { blockId: 'FixtureBlock0001', commentId: '123' } };
    await assert.rejects(inspect.definition.execute(inspection, context), /能力绑定页面连接文档服务/);
    await assert.rejects(read.definition.execute(input, context), /能力绑定页面连接文档服务/);
    cwd = f.other;
    assert.equal(await read.when(step()), false);
    await assert.rejects(read.definition.execute(input, context), /没有启用此工具/);
    cwd = f.root;
    local = false;
    assert.equal(await read.when(step()), false);
    await assert.rejects(read.definition.execute(input, context), /映射到本机/);
    assert.equal(await read.when({ agent, signal: AbortSignal.abort() }), false);
    local = true;
    const file = path.join(f.userData, 'capabilities', 'registry.json');
    const registry = JSON.parse(await fs.readFile(file));
    const record = registry.records.find(r => r.id === 'feishu');
    const binding = registry.bindings.find(b => b.host === 'dsh');
    for (const version of ['1.0.0', '2.0.0']) {
        record.versions.push({ ...record.versions[0], version });
        binding.version = version;
        await fs.writeFile(file, JSON.stringify(registry));
        const { tools: listed } = JSON.parse(execFileSync(launcher.file, ['--tools', 'dsh'], {
            cwd, input: JSON.stringify({ action: 'list' }), encoding: 'utf8' }));
        assert.deepEqual(listed.map(tool => tool.name), ['workbench_feishu_read_document']);
        assert.doesNotMatch(JSON.stringify(listed), /inspectComment|\/wiki\//);
        assert.equal(await read.when(step()), true);
        assert.equal(await inspect.when(step()), false);
        assert.equal(await comment.when(step()), false);
        await assert.rejects(inspect.definition.execute(inspection, context), /当前绑定版本不支持/);
        await assert.rejects(read.definition.execute(inspection, context), /当前绑定版本不支持/);
        await assert.rejects(read.definition.execute(input, context), /需要在此宿主选用飞书 3.0/);
        await assert.rejects(read.definition.execute({ document: inspection.document }, context), /能力绑定页面连接文档服务/);
        await assert.rejects(execute(f.userData, services, 'dsh', { action: 'call', cwd, name: read.definition.name, arguments: inspection }), /当前绑定版本不支持/);
    }
});

test('工作台关闭后，两种原生启动事件只收到当前工作树和宿主的绑定', async t => {
    const f = await fixture(t);
    await f.bind('main', 'codex', 'portable-paths');
    await f.bind('main', 'codex', 'feishu-defect-agent', '1.2.0');
    await f.bind('main', 'claude', 'verify-changes');
    await f.bind('second', 'claude', 'task-scope');
    const start = cwd => ({ hook_event_name: 'SessionStart', cwd });
    const run = f.invoke('codex', start(path.join(f.root, 'docs')), true);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.output.additionalContext, /portable-paths@1.0.0/);
    assert.match(run.output.additionalContext, /SKILL\.md/);
    assert.doesNotMatch(run.output.additionalContext, /verify-changes|task-scope|prepare --input/);
    assert.equal(run.output.hookEventName, 'SessionStart');
    const claude = f.invoke('claude', start(f.root)).output.additionalContext;
    assert.match(claude, /verify-changes@1.0.0/);
    assert.doesNotMatch(claude, /portable-paths|feishu-defect-agent/);
    assert.equal(f.invoke('codex', start(f.other)).output, null);
    assert.match(f.invoke('claude', start(f.other)).output.additionalContext, /task-scope/);
    const nested = path.join(f.root, 'docs', 'nested repo');
    await fs.mkdir(nested);
    git(nested, 'init', '-q');
    assert.equal(f.invoke('codex', start(nested)).output, null);
    assert.equal(f.invoke('codex', start(undefined)).output, null);
    await f.saveProjects([f.projects[1]]);
    assert.equal(f.invoke('codex', start(f.root)).output, null);
    const logs = await f.receipts('main', 'codex');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].decision, 'context');
    assert.equal(logs[0].root, f.root);
    assert.deepEqual(logs[0].bindings, [{ id: 'portable-paths', version: '1.0.0' }, { id: 'feishu-defect-agent', version: '1.2.0' }]);
    assert.equal((await f.receipts('_unscoped', 'codex')).length, 3);
});

test('明确拒绝两种宿主原生编辑中向已跟踪文档写入本机检出引用，保留宿主权限判断', async t => {
    const f = await fixture(t);
    await f.bind('main', 'codex', 'portable-paths');
    await f.bind('main', 'claude', 'portable-paths');
    const docs = path.join(f.root, 'docs');
    const privateText = 'private-fixture-string';
    const text = privateText + ' ' + f.root + '/package.json';
    const call = (host, tool_name, tool_input) => f.invoke(host, { cwd: docs, hook_event_name: 'PreToolUse', tool_name, tool_input });
    const patch = lines => '*** Begin Patch\n*** Update File: guide.md\n@@\n' + lines + '\n*** End Patch';
    const deny = call('codex', 'apply_patch', { command: patch('-original\n+' + text) });
    assert.equal(deny.status, 0, deny.stderr);
    assert.equal(deny.output.hookEventName, 'PreToolUse');
    assert.equal(deny.output.permissionDecision, 'deny');
    assert.equal(call('claude', 'Edit', { file_path: 'guide.md', old_string: 'original', new_string: text }).output.permissionDecision, 'deny');
    assert.equal(call('claude', 'Write', { file_path: path.join(docs, 'guide.md'), content: text }).output.permissionDecision, 'deny');
    assert.equal(call('codex', 'apply_patch', { command: patch('-' + text + '\n+../package.json') }).output, null);
    assert.equal(call('claude', 'Write', { file_path: 'untracked.local.md', content: text }).output, null);
    assert.equal(call('claude', 'Edit', { file_path: path.join(f.other, 'docs/guide.md'), new_string: text }).output, null);
    assert.equal(call('codex', 'Bash', { command: privateText }).output, null);
    const codexLogs = await f.receipts('main', 'codex');
    assert.deepEqual(codexLogs.map(r => r.decision), ['deny', 'pass', 'skipped']);
    const logs = codexLogs.concat(await f.receipts('main', 'claude'));
    assert.ok(logs.every(log => log.checkVersion === '1.0.0'));
    assert.doesNotMatch(JSON.stringify(logs), /private-fixture-string|guide\.md|package\.json/);
});

test('绑定版本和本机快照异常不被记成已校验，未知事件安静退出', async t => {
    const f = await fixture(t);
    await f.bind('main', 'codex', 'portable-paths');
    const file = path.join(f.userData, 'capabilities', 'registry.json');
    const registry = JSON.parse(await fs.readFile(file));
    const event = { cwd: f.root, hook_event_name: 'SessionStart' };
    registry.bindings[0].version = '9.0.0';
    await fs.writeFile(file, JSON.stringify(registry));
    assert.equal(f.invoke('codex', event).output, null);
    registry.bindings[0].version = '1.0.0';
    const version = registry.records[0].versions[0];
    await fs.unlink(version.localEntry);
    await fs.symlink(path.join(f.root, 'docs/guide.md'), version.localEntry);
    await fs.writeFile(file, JSON.stringify(registry));
    const writeEvent = { ...event, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: docs/guide.md\n@@\n+relative\n*** End Patch' } };
    const failed = f.invoke('codex', writeEvent);
    assert.equal(failed.status, 1);
    assert.equal(failed.output, null);
    const ignored = f.invoke('codex', { ...event, hook_event_name: 'PostToolUse' });
    assert.equal(ignored.status, 0);
    const logs = await f.receipts('main', 'codex');
    assert.deepEqual(logs.map(r => r.decision), ['skipped', 'error']);
});

test('会话按实际物化内容核验规范与完整 Skill，路径检查只核验绑定的规范', async t => {
    const f = await fixture(t);
    await f.bind('main', 'codex', 'portable-paths');
    await f.bind('main', 'codex', 'feishu-defect-agent', '1.2.0');
    const data = JSON.parse(await fs.readFile(path.join(f.userData, 'capabilities', 'registry.json')));
    const rule = data.records.find(r => r.id === 'portable-paths').versions[0].localEntry;
    const skill = data.records.find(r => r.id === 'feishu-defect-agent').versions[0].localEntry;
    const start = () => f.invoke('codex', { cwd: f.root, hook_event_name: 'SessionStart' });
    const verifyIssue = async id => {
        const run = start();
        assert.equal(run.status, 1, run.stderr);
        assert.equal(run.output, null);
        const last = (await f.receipts('main', 'codex')).at(-1);
        assert.equal(last.decision, 'error');
        assert.ok(last.reason.includes(id));
        assert.match(last.reason, /完整性校验/);
    };
    const original = await fs.readFile(rule);
    await fs.writeFile(rule, Buffer.alloc(original.length, 65));
    await verifyIssue('portable-paths@1.0.0');
    await fs.writeFile(rule, original);
    assert.ok(start().output.additionalContext.includes(original.toString().trim()));

    const script = path.join(path.dirname(skill), 'scripts/defects.mjs');
    const scriptBytes = await fs.readFile(script);
    const scriptMode = (await fs.stat(script)).mode & 0o777;
    await fs.writeFile(script, Buffer.alloc(scriptBytes.length, 66));
    await verifyIssue('feishu-defect-agent@1.2.0');
    const check = f.invoke('codex', { cwd: f.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: docs/guide.md\n@@\n+' + f.root + '/file.md\n*** End Patch' } });
    assert.equal(check.output.permissionDecision, 'deny');

    await fs.unlink(script);
    await verifyIssue('feishu-defect-agent@1.2.0');
    await fs.writeFile(script, scriptBytes, { mode: scriptMode });
    const extra = path.join(path.dirname(skill), 'extra.mjs');
    await fs.writeFile(extra, 'unexpected\n', { mode: 0o600 });
    await verifyIssue('feishu-defect-agent@1.2.0');
    await fs.unlink(extra);
    assert.equal(start().status, 0);
});

test('高频提示组装回执轮转时保留最近一次工具守卫的回执', async t => {
    const f = await fixture(t);
    const dir = path.join(f.userData, 'host-integration/receipts/main/dsh');
    const guard = { cwd: f.root, hook_event_name: 'tools.guard', tool_name: 'write' };
    assert.equal(f.invoke('dsh', guard).status, 0);
    const [guardFile] = await fs.readdir(dir);
    const sample = JSON.parse(await fs.readFile(path.join(dir, guardFile)));
    // 用早于本次运行的一组时间模拟已有回执，再通过真实入口触发轮转。
    const base = Date.now() - 10_000;
    await fs.unlink(path.join(dir, guardFile));
    for (let i = 0; i <= 130; i++) {
        const time = base + i;
        const entry = { ...sample, event: i < 2 ? 'tools.guard' : 'system-prompt/assemble', timestamp: new Date(time).toISOString() };
        await fs.writeFile(path.join(dir, time + '-' + require('node:crypto').randomUUID() + '.json'), JSON.stringify(entry), { mode: 0o600 });
    }
    for (let i = 0; i < 2; i++) {
        assert.equal(f.invoke('dsh', { cwd: f.root, hook_event_name: 'system-prompt/assemble' }).status, 0);
        const records = await f.receipts('main', 'dsh');
        assert.equal(records.length, 128);
        assert.deepEqual(records.filter(item => item.event === 'tools.guard').map(item => item.timestamp), [new Date(base + 1).toISOString()]);
    }
});

test('Git 路径检查明确超时时，钩子写入超时回执并向宿主报告执行失败', async t => {
    const f = await fixture(t);
    await f.bind('main', 'claude', 'portable-paths');
    // 阻塞隔离仓库的 Git 索引读取，实际经过钩子的一秒超时。
    const index = path.join(f.root, '.git', 'index');
    await fs.unlink(index);
    execFileSync('mkfifo', [index]);
    const result = f.invoke('claude', { cwd: f.root, hook_event_name: 'PreToolUse', tool_name: 'Write',
        tool_input: { file_path: 'docs/guide.md', content: f.root + '/docs/guide.md' } });
    assert.equal(result.status, 1);
    assert.equal(result.output, null);
    const [entry] = await f.receipts('main', 'claude');
    assert.equal(entry.decision, 'timeout');
    assert.match(entry.reason, /Git 路径检查超过 1 秒/);
});

test('DSH 原生插件按当前工作树提供上下文，工具守卫按 DSH 实参作出独立决定', async t => {
    const f = await fixture(t);
    const { apply } = await import('../src/main/dsh-plugin/index.mjs');
    const { HostLauncher } = require('../src/main/host-launcher');
    const launcher = new HostLauncher(f.userData);
    await launcher.install();
    await f.bind('main', 'dsh', 'portable-paths');
    await f.bind('main', 'dsh', 'feishu-defect-agent', '1.2.0');
    await f.bind('second', 'codex', 'task-scope');

    const listeners = new Map();
    let guard;
    let current = f.root;
    let local = true;
    const warnings = [];
    const session = {};
    const providers = {
        workingDirectory: { get: requested => {
            assert.equal(requested, session);
            return current;
        } },
        fs: { processPathFromHostPath: cwd => local ? cwd : undefined }
    };
    // DSH 通过 Agent 所在的执行作用域选择 provider。直接读取未注入的服务会抛错。
    const agent = { session, ctx: {
        get: name => providers[name],
        get workingDirectory() { throw new Error('DSH agent core 未注入 workingDirectory'); },
        get fs() { throw new Error('DSH agent core 未注入 fs'); }
    } };
    const ctx = {
        on: (event, fn) => listeners.set(event, fn),
        tools: { guard: fn => { guard = fn; }, register: () => {} },
        workingDirectory: { get: () => f.root }, fs: { processPathFromHostPath: cwd => cwd },
        logger: { warn: reason => warnings.push(reason) }
    };
    apply(ctx, { runnerPath: launcher.file });
    const existing = { contexts: [{ name: 'existing', text: 'keep' }] };
    const assemble = signal => listeners.get('system-prompt/assemble')({}, { agent, signal }, async () => existing);
    let view = await assemble();
    assert.equal(view.contexts[0].text, 'keep');
    assert.match(view.contexts[1].text, /portable-paths@1.0.0/);
    assert.match(view.contexts[1].text, /请先在工作台配置/);
    assert.doesNotMatch(view.contexts[1].text, /SKILL\.md/);
    assert.equal(view.contexts[1].interpolate, false);
    const key = require('node:crypto').createHash('sha256').update(f.root).digest('hex');
    const bindingDir = path.join(f.userData, 'capability-projects', key, 'dsh', 'feishu-defect-bindings', key);
    const file = path.join(f.dir, "binding's file.json");
    await fs.mkdir(bindingDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ privateFixture: 'must-stay-local' }));
    await fs.writeFile(path.join(bindingDir, 'reference.json'), JSON.stringify({ path: file }));
    view = await assemble();
    assert.match(view.contexts[1].text, /SKILL\.md/);
    assert.match(view.contexts[1].text, /--binding '/);
    assert.doesNotMatch(view.contexts[1].text, /must-stay-local/);
    const argumentsFor = { file_path: 'docs/guide.md', content: f.root + '/package.json' };
    assert.match(guard({ agent, name: 'write', arguments: argumentsFor }), /相对路径/);
    assert.match(guard({ agent, name: 'edit', arguments: { file_path: 'docs/guide.md', new_string: argumentsFor.content } }), /相对路径/);
    assert.match(guard({ agent, name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** Update File: docs/guide.md\n@@\n+' + argumentsFor.content + '\n*** End Patch' } }), /相对路径/);
    assert.equal(guard({ agent, name: 'write', arguments: { ...argumentsFor, content: './package.json' } }), undefined);
    assert.equal(guard({ agent, name: 'shell', arguments: {} }), undefined);
    const receipts = await f.receipts('main', 'dsh');
    assert.deepEqual(receipts.map(entry => entry.event), ['system-prompt/assemble', 'system-prompt/assemble', ...Array(4).fill('tools.guard')]);
    assert.doesNotMatch(JSON.stringify(receipts), /--binding|package\.json|must-stay-local/);

    current = f.other;
    assert.equal((await assemble()).contexts.length, 1);
    assert.equal(guard({ agent, name: 'write', arguments: argumentsFor }), undefined);
    local = false;
    current = f.root;
    assert.equal((await assemble()).contexts.length, 1);
    assert.equal(guard({ agent, name: 'write', arguments: argumentsFor }), undefined);
    assert.equal((await f.receipts('main', 'dsh')).length, receipts.length);
    assert.deepEqual(warnings, []);

    local = true;
    const write = signal => guard({ agent, name: 'write', arguments: argumentsFor, signal });
    for (const [name, method] of [['workingDirectory', 'get'], ['fs', 'processPathFromHostPath']]) {
        const provider = providers[name];
        delete providers[name];
        assert.deepEqual(await assemble(), existing);
        assert.equal(write(), undefined);
        providers[name] = { [method]() { throw new Error('private-directory-diagnostic'); } };
        assert.deepEqual(await assemble(), existing);
        assert.equal(write(), undefined);
        providers[name] = provider;
    }
    assert.doesNotMatch(JSON.stringify(warnings), /private-directory-diagnostic/);
    const warningCount = warnings.length;
    const cancelled = AbortSignal.abort();
    assert.deepEqual(await assemble(cancelled), existing);
    assert.equal(write(cancelled), undefined);
    assert.equal((await f.receipts('main', 'dsh')).length, receipts.length);

    const controller = new AbortController();
    providers.workingDirectory.get = () => {
        queueMicrotask(() => controller.abort());
        return current;
    };
    assert.deepEqual(await assemble(controller.signal), existing);
    providers.workingDirectory.get = () => {
        queueMicrotask(() => { current = f.other; });
        return current;
    };
    assert.deepEqual(await assemble(), existing);
    assert.equal(warnings.length, warningCount);
});
