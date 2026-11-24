'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostIntegration } = require('../src/main/host-integration');

test('单个宿主组件缺失时主进程服务能启动，另一个宿主仍可检测', async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-partial-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const main = path.resolve(__dirname, '../src/main');
    for (const file of ['host-integration.js', 'local-cli.js', 'claude-host-adapter.js', 'host-registration.js', 'host-launcher.js', 'local-config.js']) {
        await fs.copyFile(path.join(main, file), path.join(home, file));
    }
    const bin = path.join(home, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'codex'), "#!/bin/sh\necho 'codex-cli 0.171.0'\n", { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'claude'), "#!/bin/sh\necho '2.1.327 (Claude Code)'\n", { mode: 0o755 });
    const IsolatedService = require(path.join(home, 'host-integration')).HostIntegration;
    const result = await new IsolatedService({ userDataPath: home, home, env: {}, baseDirs: [bin], applicationDirs: [] }).inspect();
    assert.equal(result.hosts[0].status, 'unknown');
    assert.match(result.hosts[0].detail, /缺少 Codex 检测组件/);
    assert.equal(result.hosts[1].status, 'available');
});

test('宿主检测从用户安装位置读取版本，忽略工作目录和相对 PATH，识别损坏的安装', async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-hosts-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const apps = path.join(home, 'Applications');
    const service = new HostIntegration({ home, userDataPath: path.join(home, 'workbench'), env: { HOME: home, PATH: '.' },
        baseDirs: [], applicationDirs: [apps] });
    assert.deepEqual((await service.inspect()).hosts.map(h => h.status), ['missing', 'missing', 'missing']);

    const bin = path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin');
    const desktopBin = path.join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS');
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(desktopBin, { recursive: true });
    await fs.writeFile(path.join(bin, 'claude'), "#!/bin/sh\nprintf '2.1.327 (Claude Code)\\n'\n", { mode: 0o755 });
    await fs.writeFile(path.join(desktopBin, 'codex'), "#!/bin/sh\nprintf 'fixture-private-output\\n'\n", { mode: 0o755 });
    const [codex, claude] = (await service.inspect()).hosts;
    assert.equal(codex.status, 'unknown');
    assert.equal(codex.executable, path.join(desktopBin, 'codex'));
    assert.doesNotMatch(JSON.stringify(codex), /fixture-private-output/);
    assert.equal(claude.version, '2.1.327');
    assert.equal(claude.executable, path.join(bin, 'claude'));
    assert.equal(claude.status, 'available');
    assert.ok(claude.targets.length > 0);
    await assert.rejects(fs.stat(path.join(home, '.claude')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(home, 'workbench')), { code: 'ENOENT' });
});

async function isolatedSetup(t) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-install-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const bin = path.join(home, 'bin');
    await fs.mkdir(bin);
    for (const [name, version] of [['codex', 'codex-cli 0.171.0'], ['claude', '2.1.327 (Claude Code)']]) {
        await fs.writeFile(path.join(bin, name), "#!/bin/sh\necho '" + version + "'\n", { mode: 0o755 });
    }
    const userDataPath = path.join(home, "workbench's local data");
    return { home, bin, userDataPath, service: new HostIntegration({ home, userDataPath, env: {}, baseDirs: [bin], applicationDirs: [] }) };
}

const forHost = (snapshot, id) => snapshot.hosts.find(row => row.id === id);
const request = row => ({ host: row.id, planId: row.planId });

test('进行中的宿主检测先完成，再应用接入并保留最新回执起点', async t => {
    const { service } = await isolatedSetup(t);
    const row = forHost(await service.inspect(), 'claude');
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const plan = service.plan.bind(service);
    let calls = 0;
    t.mock.method(service, 'plan', async host => {
        const first = host.id === 'claude' && ++calls === 1;
        const result = await plan(host);
        if (first) { entered.resolve(); await release.promise; }
        return result;
    });
    const inspection = service.inspect();
    await entered.promise;
    const install = service.install(request(row));
    await new Promise(resolve => setImmediate(resolve));
    const beforeRelease = calls;
    release.resolve();
    const [before, after] = await Promise.all([inspection, install]);
    assert.equal(beforeRelease, 1);
    assert.equal(forHost(before, 'claude').status, 'available');
    const configured = forHost(after, 'claude');
    assert.equal(configured.verificationEligible, true);
    assert.equal(service.sinceByHost.claude, configured.verifiedSince);
});

test('包装脚本报告新版本后旧回执失效，工作台重启仍沿用此次版本的起点', async t => {
    const { home, bin, userDataPath, service } = await isolatedSetup(t);
    const project = { id: 'fixture', rootPath: await fs.realpath(home) };
    service.getActive = () => project;
    const versionFile = path.join(home, 'claude-version');
    const cli = path.join(bin, 'claude');
    await fs.writeFile(cli, '#!/bin/sh\n/bin/cat "$HOME/claude-version"\n');
    await fs.writeFile(versionFile, '2.1.327 (Claude Code)\n');
    const row = forHost(await service.inspect(), 'claude');
    await service.install(request(row));

    const file = service.registrationFor('claude').ledgerPath('claude');
    const ledger = JSON.parse(await fs.readFile(file));
    delete ledger.current.verifiedSince;
    await fs.writeFile(file, JSON.stringify(ledger));
    const older = new Date(1700000000000);
    await fs.utimes(file, older, older);
    const stat = await fs.stat(cli);
    assert.equal(forHost(await service.inspect(), 'claude').verifiedSince, Math.floor(Math.max(stat.mtimeMs, stat.birthtimeMs)));

    const receiptDir = path.join(userDataPath, 'host-integration', 'receipts', project.id, 'claude');
    await fs.mkdir(receiptDir, { recursive: true });
    const timestamp = new Date();
    const name = timestamp.getTime() + '-' + require('node:crypto').randomUUID() + '.json';
    const record = { schema: 1, timestamp: timestamp.toISOString(), projectId: project.id, root: project.rootPath,
        host: 'claude', event: 'SessionStart', checkVersion: '1.0.0', bindings: [], decision: 'skipped', reason: '当前没有绑定' };
    await fs.writeFile(path.join(receiptDir, name), JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(fs.stat(service.versionFile('claude')), { code: 'ENOENT' });
    assert.equal((await service.verification()).hosts.claude.SessionStart.timestamp, record.timestamp);

    const reopen = () => new HostIntegration({ home, userDataPath, env: {}, baseDirs: [bin], applicationDirs: [], getActive: () => project });
    await fs.writeFile(versionFile, '2.1.328 (Claude Code)\n');
    const start = Date.now();
    const reopened = reopen();
    const updated = forHost(await reopened.inspect(), 'claude');
    assert.ok(updated.verifiedSince >= start);
    assert.equal(updated.version, '2.1.328');
    assert.deepEqual((await reopened.verification()).hosts.claude, {});
    const again = reopen();
    assert.equal(forHost(await again.inspect(), 'claude').verifiedSince, updated.verifiedSince);
    assert.deepEqual((await again.verification()).hosts.claude, {});
});

test('一键登记防止重复提交，移除一方后另一宿主可独立运行入口', async t => {
    const { home, userDataPath, service } = await isolatedSetup(t);
    const initial = await service.inspect();
    const codex = forHost(initial, 'codex');
    const [first, second] = await Promise.all([service.install(request(codex)), service.install(request(codex))]);
    assert.equal(forHost(first, 'codex').status, 'needs-trust');
    assert.deepEqual(first, second);
    const claude = forHost(await service.install(request(forHost(initial, 'claude'))), 'claude');
    assert.equal(claude.status, 'configured');
    await service.remove(request(forHost(await service.inspect(), 'codex')));
    await assert.rejects(fs.stat(codex.configurationPath), { code: 'ENOENT' });
    const settings = JSON.parse(await fs.readFile(claude.configurationPath));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: home, env: { PATH: '/usr/bin:/bin' },
        input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: home }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const receipts = path.join(userDataPath, 'host-integration/receipts/_unscoped/claude');
    const [entry] = await fs.readdir(receipts);
    assert.equal(JSON.parse(await fs.readFile(path.join(receipts, entry))).decision, 'skipped');
    await fs.rm(claude.runnerPath);
    const repair = forHost(await service.inspect(), 'claude');
    assert.equal(repair.canInstall, true);
    assert.deepEqual(repair.installEvents, []);
    const restored = forHost(await service.install(request(repair)), 'claude');
    assert.equal(restored.canInstall, false);
    const final = await service.remove(request(restored));
    assert.deepEqual(await service.remove(request(restored)), final);
    assert.equal(forHost(final, 'claude').canRemove, false);
});

test('过期计划可重新检测，移动宿主目录时按原路径解除，外部程序不会被覆盖', async t => {
    const { home, service } = await isolatedSetup(t);
    const old = forHost(await service.inspect(), 'claude');
    service.env.CLAUDE_CONFIG_DIR = path.join(home, 'changed');
    await assert.rejects(service.install(request(old)), /状态已变化/);
    const fresh = forHost(await service.inspect(), 'claude');
    const installed = forHost(await service.install(request(fresh)), 'claude');
    service.env.CLAUDE_CONFIG_DIR = path.join(home, 'new-profile');
    const moved = forHost(await service.inspect(), 'claude');
    assert.equal(moved.status, 'conflict');
    assert.equal(moved.configurationPath, installed.configurationPath);
    assert.equal(moved.canRemove, true);
    await service.remove(request(moved));
    await assert.rejects(fs.stat(installed.configurationPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(service.env.CLAUDE_CONFIG_DIR), { code: 'ENOENT' });
    await fs.unlink(installed.runnerPath);
    await fs.writeFile(installed.runnerPath, 'manually replaced');
    const blocked = forHost(await service.inspect(), 'claude');
    assert.equal(blocked.canInstall, false);
    assert.equal(blocked.status, 'conflict');
    assert.equal(await fs.readFile(installed.runnerPath, 'utf8'), 'manually replaced');
});

test('DeepSeek Harness 使用桌面自带 CLI，预览、重复接入及解除均指向 desktop profile', async t => {
    const { home, service } = await isolatedSetup(t);
    const appRoot = path.join(home, 'Applications');
    service.applicationDirs = [appRoot];
    service.env.DSH_HOME = path.join(home, 'custom-dsh');
    const bin = path.join(appRoot, 'DeepSeek Harness.app/Contents/Resources/runtime/cli/bin');
    await fs.mkdir(bin, { recursive: true });
    const executable = path.join(bin, 'dsh');
    const version = v => fs.writeFile(executable, "#!/bin/sh\necho '" + v + "'\n", { mode: 0o755 });
    await version('0.2.2-rc.4');
    const earlier = forHost(await service.inspect(), 'dsh');
    assert.equal(earlier.status, 'incompatible');
    assert.equal(earlier.canInstall, false);
    await version('0.2.2-rc.5');
    const row = forHost(await service.inspect(), 'dsh');
    assert.equal(row.status, 'available');
    assert.equal(row.executable, executable);
    assert.deepEqual(row.installEvents, ['system-prompt/assemble', 'tools.guard']);
    await assert.rejects(fs.stat(service.env.DSH_HOME), { code: 'ENOENT' });
    const [a, b] = await Promise.all([service.install(request(row)), service.install(request(row))]);
    assert.deepEqual(a, b);
    const installed = forHost(a, 'dsh');
    assert.equal(installed.status, 'configured');
    assert.equal(installed.canRemove, true);
    const yaml = require('yaml');
    const patch = yaml.parse(await fs.readFile(installed.configurationPath, 'utf8'));
    assert.equal(patch.length, 1);
    assert.equal(patch[0].insert[0].config.runnerPath, installed.runnerPath);
    assert.ok(patch[0].insert[0].name.endsWith('/dsh-plugin/index.mjs'));
    service.env.DSH_HOME = path.join(home, 'other-profile');
    const moved = forHost(await service.inspect(), 'dsh');
    assert.equal(moved.status, 'conflict');
    assert.equal(moved.configurationPath, installed.configurationPath);
    assert.equal(forHost(await service.remove(request(moved)), 'dsh').status, 'available');
    await assert.rejects(fs.stat(installed.configurationPath), { code: 'ENOENT' });
});

for (const action of ['apply', 'remove']) {
    for (const timing of ['before', 'after']) {
        test('升级后从宿主接入页恢复旧版 DSH 的 ' + action + '，中断点 ' + timing, async t => {
            const { home, service } = await isolatedSetup(t);
            service.applicationDirs = [path.join(home, 'Applications')];
            const bin = path.join(service.applicationDirs[0], 'DeepSeek Harness.app/Contents/Resources/runtime/cli/bin');
            await fs.mkdir(bin, { recursive: true });
            service.maintainInstalledPaths = true;
            await fs.writeFile(path.join(bin, 'dsh'), '#!/bin/sh\necho 0.2.2-rc.5\n', { mode: 0o755 });
            const initial = forHost(await service.inspect(), 'dsh');
            assert.equal(initial.status, 'available', initial.detail);
            const current = JSON.parse(initial.targets[0].preview).insert[0];
            const targetPath = initial.configurationPath;
            const original = '# 自定义配置\n[]\n';
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, original);
            const entry = { ...current, name: path.join(home, 'OpenSpec GUI.app/plugin.mjs') };
            const oldOptions = { id: 'dsh', targetPath, runnerPath: service.runnerPath, fragment: { insert: [entry] } };
            const registration = service.registrationFor('dsh');
            await service.launcher.install();
            if (action === 'remove') { await registration.apply(oldOptions); }
            const save = registration.save.bind(registration);
            registration.save = async record => {
                if (timing === 'after' && !record?.pending) { throw new Error('interrupted'); }
                await save(record);
                if (timing === 'before' && record?.pending) { throw new Error('interrupted'); }
            };
            await assert.rejects(registration[action](oldOptions), /interrupted/);
            registration.save = save;
            const row = forHost(await service.inspect(), 'dsh');
            const profile = await fs.readFile(targetPath, 'utf8');
            if (action === 'apply') {
                if (timing === 'before') {
                    assert.equal(row.canInstall, true);
                    assert.equal(profile, original);
                    assert.equal(forHost(await service.install(request(row)), 'dsh').status, 'configured');
                } else {
                    assert.equal(row.status, 'configured');
                    assert.equal(row.canInstall, false);
                    assert.ok(profile.includes(current.name));
                }
                assert.equal((await registration.state('dsh')).pending, null);
            } else {
                assert.equal(row.canInstall, false);
                assert.equal(row.canRemove, true);
                assert.equal((await registration.state('dsh')).pending, 'remove');
                assert.equal(profile.includes(entry.name), timing === 'before');
            }
            await service.remove(request(forHost(await service.inspect(), 'dsh')));
            assert.equal(await fs.readFile(targetPath, 'utf8'), original);
            assert.equal((await registration.state('dsh')).managed, false);
        });
    }
}
