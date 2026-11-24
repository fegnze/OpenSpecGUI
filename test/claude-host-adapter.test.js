'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspectClaude } = require('../src/main/claude-host-adapter');

async function fixture(t) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-host-')));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const options = { home, version: '2.1.327', runnerPath: path.join(home, "team 'one' $runner"), env: {} };
    return { home, options, inspect: () => inspectClaude(options) };
}

test('Claude Code 空用户配置可预览两项命令，命令安全处理路径，不会生成设置', async t => {
    const { home, options, inspect } = await fixture(t);
    const plan = await inspect();
    assert.equal(plan.status, 'available');
    assert.equal(plan.targets[0].path, path.join(home, '.claude', 'settings.json'));
    assert.deepEqual(await fs.readdir(home), []);
    const hooks = JSON.parse(plan.targets[0].preview).hooks;
    assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreToolUse']);
    assert.deepEqual(hooks.SessionStart, hooks.PreToolUse);
    const command = hooks.PreToolUse[0].hooks[0].command;
    await fs.writeFile(options.runnerPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    assert.equal(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }), '--host\nclaude\n');
});

test('Claude Code 核对自定义用户目录的完整或部分注册，保留私有配置，提示宿主工作区信任', async t => {
    const { home, options, inspect } = await fixture(t);
    options.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-personal');
    await fs.mkdir(options.env.CLAUDE_CONFIG_DIR);
    const blank = await inspect();
    const target = blank.targets[0].path;
    assert.equal(target, path.join(options.env.CLAUDE_CONFIG_DIR, 'settings.json'));
    const { hooks } = JSON.parse(blank.targets[0].preview);
    const settings = { env: { PRIVATE_KEY: 'test-private-value' }, hooks };
    settings.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'test-private-command' });
    const contents = JSON.stringify(settings);
    await fs.writeFile(target, contents);
    const checked = await inspect();
    assert.equal(checked.status, 'configured');
    assert.match(checked.nextSteps.join(' '), /工作区信任/);
    assert.doesNotMatch(JSON.stringify(checked), /test-private/);
    assert.equal(await fs.readFile(target, 'utf8'), contents);
    delete settings.hooks.PreToolUse;
    await fs.writeFile(target, JSON.stringify(settings));
    const partial = await inspect();
    assert.equal(partial.status, 'available');
    assert.match(partial.detail, /PreToolUse/);
    assert.deepEqual(Object.keys(JSON.parse(partial.targets[0].preview).hooks), ['PreToolUse']);
});

test('Claude Code 单独识别禁用、限定匹配、异步、重复和损坏的配置', async t => {
    const { home, inspect } = await fixture(t);
    const plan = await inspect();
    const target = plan.targets[0].path;
    await fs.mkdir(path.join(home, '.claude'));
    const { hooks } = JSON.parse(plan.targets[0].preview);
    const command = hooks.PreToolUse[0].hooks[0];
    for (const config of [
        { disableAllHooks: true },
        { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [command] }] } },
        { hooks: { PreToolUse: [{ hooks: [{ ...command, async: true }] }] } },
        { hooks: { PreToolUse: [{ hooks: [command, command] }] } },
        { hooks: { PreToolUse: 'invalid' } }
    ]) {
        await fs.writeFile(target, JSON.stringify(config));
        assert.equal((await inspect()).status, config.disableAllHooks ? 'disabled' : 'conflict');
    }
    await fs.writeFile(target, 'test-private-invalid');
    const invalid = await inspect();
    assert.equal(invalid.status, 'conflict');
    assert.doesNotMatch(JSON.stringify(invalid), /test-private-invalid/);
});

test('Claude Code 按版本分别报告原生事件支持情况', async t => {
    const { options, inspect } = await fixture(t);
    options.version = '1.0.61';
    const earlier = await inspect();
    assert.equal(earlier.status, 'incompatible');
    assert.deepEqual(earlier.events.map(event => event.supported), [false, true]);
    assert.deepEqual(earlier.targets, []);
    options.version = '1.0.62';
    assert.equal((await inspect()).status, 'available');
    options.version = 'unknown';
    assert.equal((await inspect()).status, 'unknown');
    options.version = '2.1.327';
    options.env.CLAUDE_CONFIG_DIR = 'relative/config';
    assert.equal((await inspect()).status, 'unknown');
});

test('Claude 的用户目录别名改指后，展示新目录的真实路径', async t => {
    const { options, home, inspect } = await fixture(t);
    const alias = path.join(home, 'current');
    options.env.CLAUDE_CONFIG_DIR = alias;
    for (const name of ['first', 'second']) {
        const directory = path.join(home, name);
        await fs.mkdir(directory);
        await fs.symlink(directory, alias);
        assert.equal((await inspect()).targets[0].path, path.join(directory, 'settings.json'));
        await fs.unlink(alias);
    }
    await fs.symlink(path.join(home, 'absent'), alias);
    const invalid = await inspect();
    assert.equal(invalid.status, 'conflict');
    assert.deepEqual(invalid.targets, []);
});
