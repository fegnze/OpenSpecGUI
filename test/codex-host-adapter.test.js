'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stringify } = require('smol-toml');
const { inspectCodex } = require('../src/main/codex-host-adapter');

async function fixture(t) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hook-preview-')));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const directory = path.join(home, 'custom codex');
    const options = { version: '0.171.0-alpha.13', home, env: { CODEX_HOME: directory },
        runnerPath: path.join(home, "workbench's private bin", 'workbench-hook'), systemConfigDir: path.join(home, 'etc') };
    return { options, directory, inspect: () => inspectCodex(options) };
}

test('Codex 用户配置缺失时只生成原生预览，按提供的绝对路径引用程序', async t => {
    const { inspect, directory, options } = await fixture(t);
    const data = await inspect();
    assert.equal(data.status, 'available');
    assert.deepEqual(data.events.map(e => [e.name, e.supported]), [['SessionStart', true], ['PreToolUse', true]]);
    assert.equal(data.targets[0].path, path.join(directory, 'hooks.json'));
    const plan = JSON.parse(data.targets[0].preview);
    const handler = plan.hooks.PreToolUse[0].hooks[0];
    assert.equal(handler.command, "'" + options.runnerPath.replace(/'/g, "'\\''") + "' --host codex");
    assert.equal(handler.type, 'command');
    assert.equal(handler.statusMessage, require('../package.json').productName + ' · PreToolUse');
    assert.deepEqual(await fs.readdir(options.home), []);
    assert.equal((await inspectCodex({ ...options, version: '0.128.0' })).status, 'incompatible');
    assert.equal((await inspectCodex({ ...options, version: '0.129.0-alpha.1' })).status, 'incompatible');
    assert.equal((await inspectCodex({ ...options, version: '0.129.0' })).status, 'available');
    assert.equal((await inspectCodex({ ...options, version: 'unrecognized' })).status, 'unknown');
});

test('内联和 JSON 钩子共同作用，预览只补缺项，手工内容不回显', async t => {
    const { inspect, directory } = await fixture(t);
    const target = (await inspect()).targets[0];
    const expected = JSON.parse(target.preview).hooks;
    await fs.mkdir(directory);
    const file = path.join(directory, 'config.toml');
    const user = { hooks: { SessionStart: expected.SessionStart }, mcp_servers: { other: { env: { TOKEN: 'private-value' } } } };
    await fs.writeFile(file, stringify(user));
    await fs.writeFile(target.path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'private-command' }] }] } }));
    const partial = await inspect();
    assert.equal(partial.status, 'available');
    assert.deepEqual(Object.keys(JSON.parse(partial.targets[0].preview).hooks), ['PreToolUse']);
    assert.doesNotMatch(JSON.stringify(partial), /private-value|private-command/);

    await fs.writeFile(target.path, JSON.stringify({ hooks: { PreToolUse: expected.PreToolUse } }));
    const registered = await inspect();
    assert.equal(registered.status, 'needs-trust');
    assert.deepEqual(registered.targets, []);
    await fs.writeFile(target.path, JSON.stringify({ hooks: expected }));
    assert.equal((await inspect()).status, 'conflict');
    await fs.writeFile(target.path, '{ "private-parser-value"');
    const invalid = await inspect();
    assert.equal(invalid.status, 'conflict');
    assert.doesNotMatch(JSON.stringify(invalid), /private-parser-value/);
});

test('个人开关、系统策略及单个事件停用均可检测', async t => {
    const { inspect, options, directory } = await fixture(t);
    const target = (await inspect()).targets[0];
    await fs.mkdir(directory);
    await fs.mkdir(options.systemConfigDir);
    const file = path.join(directory, 'config.toml');
    await fs.writeFile(file, '[features]\ncodex_hooks = false\n');
    assert.equal((await inspect()).status, 'disabled');
    await fs.writeFile(file, '[features]\nhooks = true\n');
    const policy = path.join(options.systemConfigDir, 'requirements.toml');
    await fs.writeFile(policy, 'allow_managed_hooks_only = true\n');
    assert.equal((await inspect()).status, 'disabled');
    await fs.unlink(policy);
    await fs.writeFile(target.path, target.preview);
    const key = target.path + ':pre_tool_use:0:0';
    await fs.writeFile(file, stringify({ hooks: { state: { [key]: { enabled: false } } } }));
    assert.equal((await inspect()).status, 'disabled');
});

test('按 Codex 原生 hooks/list 的指纹区分信任和已变更的定义', async t => {
    const { options, directory, inspect } = await fixture(t);
    options.runnerPath = '/example/workbench-hook';
    await fs.mkdir(directory);
    const target = (await inspect()).targets[0];
    // 旧版应用生成的原生定义和信任指纹在改名后保持有效。
    await fs.writeFile(target.path, target.preview.replaceAll(require('../package.json').productName + ' · ', 'OpenSpec GUI · '));
    // 在独立用户目录中，由 Codex 0.171.0-alpha.13 的 hooks/list 返回。
    const state = {
        [target.path + ':session_start:0:0']: { trusted_hash: 'sha256:92a1e8fcc4a727a5311d1020dac3e630dd819fdd505e6f4cb52d0644b15062cb' },
        [target.path + ':pre_tool_use:0:0']: { trusted_hash: 'sha256:fe70cc405ec46f89d1b3e5b4f0f2c0845c2c9acc37100ba01c173c198b6da8f4' }
    };
    const file = path.join(directory, 'config.toml');
    await fs.writeFile(file, stringify({ hooks: { state } }));
    assert.equal((await inspect()).status, 'configured');
    state[target.path + ':pre_tool_use:0:0'].trusted_hash = 'stale';
    await fs.writeFile(file, stringify({ hooks: { state } }));
    assert.equal((await inspect()).status, 'needs-trust');
});

test('Codex 通过父目录别名预览新路径时，目录创建前后的接入位置一致', async t => {
    const { options, inspect } = await fixture(t);
    const directory = path.join(options.home, 'actual');
    const alias = path.join(options.home, 'alias');
    await fs.mkdir(directory);
    await fs.symlink(directory, alias);
    options.env.CODEX_HOME = path.join(alias, 'nested', 'user');
    const expected = path.join(directory, 'nested', 'user', 'hooks.json');
    assert.equal((await inspect()).configurationPath, expected);
    await fs.mkdir(options.env.CODEX_HOME, { recursive: true });
    assert.equal((await inspect()).configurationPath, expected);
    await fs.unlink(alias);
    await fs.symlink(path.join(options.home, 'absent'), alias);
    const invalid = await inspect();
    assert.equal(invalid.status, 'conflict');
    assert.deepEqual(invalid.targets, []);
});
