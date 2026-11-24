'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { inspectCodex } = require('../src/main/codex-host-adapter');
const { inspectClaude } = require('../src/main/claude-host-adapter');
const { HostRegistration } = require('../src/main/host-registration');

async function fixture(t, id = 'claude') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-registration-'));
    t.after(() => fs.rm(directory, { force: true, recursive: true }));
    const userDataPath = path.join(directory, 'workbench');
    const registration = new HostRegistration({ userDataPath });
    const runnerPath = path.join(userDataPath, 'bin', 'hook');
    const hostDir = path.join(directory, '.' + id);
    await fs.mkdir(hostDir, { mode: 0o700 });
    const inspect = id === 'codex' ? inspectCodex : inspectClaude;
    const preview = await inspect({ version: id === 'codex' ? '0.129.0' : '2.1.0', runnerPath,
        home: directory, env: {}, systemConfigDir: path.join(directory, 'system') });
    const targetPath = preview.targets[0].path;
    const fragment = JSON.parse(preview.targets[0].preview);
    const options = { id, targetPath, runnerPath, fragment };
    const read = async () => JSON.parse(await fs.readFile(targetPath, 'utf8'));
    const write = value => fs.writeFile(targetPath, JSON.stringify(value), { mode: 0o640 });
    return { options, registration, userDataPath, read, write, hostDir, directory };
}

for (const id of ['claude', 'codex']) {
    test(id + ' merges and removes only entries the workbench added, preserving manual hooks and permissions', async t => {
        const { options, registration, read, write } = await fixture(t, id);
        const manual = { type: 'command', command: 'my-private-command' };
        const existing = { description: 'my-private-account', hooks: {
            SessionStart: [{ matcher: '*', hooks: [manual, options.fragment.hooks.SessionStart[0].hooks[0]] }],
            PreToolUse: [{ hooks: [manual] }], Stop: [{ hooks: [manual] }]
        } };
        await write(existing);
        await fs.chmod(options.targetPath, 0o640);
        const first = await registration.apply(options);
        assert.deepEqual(first.events, ['PreToolUse']);
        assert.deepEqual(await registration.apply(options), first);
        const ledger = await fs.readFile(registration.ledgerPath(id), 'utf8');
        assert.doesNotMatch(ledger, /my-private-account|my-private-command/);
        assert.equal((await fs.stat(options.targetPath)).mode & 0o777, 0o640);
        const current = await read();
        assert.equal(current.hooks.PreToolUse.length, 2);
        current.hooks.PreToolUse[1].hooks.push({ type: 'command', command: 'added later' });
        current.description = 'edited while installed';
        await write(current);
        assert.equal((await registration.remove(options)).managed, false);
        assert.equal((await registration.remove(options)).managed, false);
        existing.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'added later' }] });
        existing.description = current.description;
        assert.deepEqual(await read(), existing);
    });
}

test('旧宿主台账兼容已有回执，实际恢复登记时才更新起点', async t => {
    const { options, registration, read, write } = await fixture(t, 'codex');
    await registration.apply(options);
    const file = registration.ledgerPath(options.id);
    const ledger = JSON.parse(await fs.readFile(file));
    delete ledger.current.verifiedSince;
    const legacy = JSON.stringify(ledger);
    await fs.writeFile(file, legacy);
    const since = 1700000000000;
    await fs.utimes(file, new Date(since), new Date(since));
    assert.equal((await registration.state(options.id)).verifiedSince, since);
    assert.equal((await registration.apply(options)).verifiedSince, since);
    assert.equal(await fs.readFile(file, 'utf8'), legacy);

    const config = await read();
    delete config.hooks.PreToolUse;
    await write(config);
    const repaired = await registration.apply(options);
    assert.ok(repaired.verifiedSince > since);
    assert.deepEqual(await registration.state(options.id), repaired);
    assert.equal((await registration.remove(options)).verifiedSince, null);
});

test('Codex registers only JSON events missing from the adapter preview and leaves inline TOML alone', async t => {
    const { options, registration, hostDir, directory, read } = await fixture(t, 'codex');
    const file = path.join(hostDir, 'config.toml');
    const command = options.fragment.hooks.SessionStart[0].hooks[0].command;
    const toml = '[hooks]\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ' +
        JSON.stringify(command) + '\ntimeout = 5\nstatusMessage = "OpenSpec GUI · SessionStart"\n';
    await fs.writeFile(file, toml);
    const preview = await inspectCodex({ version: '0.129.0', runnerPath: options.runnerPath,
        home: directory, env: {}, systemConfigDir: path.join(directory, 'system') });
    const state = await registration.apply({ ...options, fragment: preview.targets[0].preview });
    assert.deepEqual(state.events, ['PreToolUse']);
    assert.deepEqual(Object.keys((await read()).hooks), ['PreToolUse']);
    await registration.remove(options);
    assert.equal(await fs.readFile(file, 'utf8'), toml);
    await assert.rejects(fs.stat(options.targetPath), { code: 'ENOENT' });
});

test('manual modification with a different command survives partial removal, then can be resolved', async t => {
    const { options, registration, read, write } = await fixture(t);
    await registration.apply(options);
    const config = await read();
    config.hooks.SessionStart[0].hooks[0].command = 'my-edit';
    await write(config);
    await assert.rejects(registration.remove(options), { code: 'HOST_REGISTRATION_ERROR', message: /SessionStart/ });
    assert.deepEqual(await read(), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-edit' }] }] } });
    assert.deepEqual((await registration.state('claude')).events, ['SessionStart']);
    await write({ theme: 'dark' });
    assert.equal((await registration.remove(options)).managed, false);
    assert.deepEqual(await read(), { theme: 'dark' });
});

test('a symbolic link in the target slot is left intact', async t => {
    const { options, registration, hostDir } = await fixture(t);
    const other = path.join(hostDir, 'other.json');
    await fs.writeFile(other, '{}');
    await fs.symlink(other, options.targetPath);
    await assert.rejects(registration.apply(options), { code: 'HOST_REGISTRATION_ERROR' });
    assert.equal(await fs.readFile(other, 'utf8'), '{}');
    assert.equal((await fs.lstat(options.targetPath)).isSymbolicLink(), true);
});

for (const action of ['apply', 'remove']) {
    for (const stage of ['before', 'after']) {
        test('reopening recovers interrupted ' + action + ' ' + stage + ' the host file change', async t => {
            const { options, registration, userDataPath, read } = await fixture(t);
            if (action === 'remove') { await registration.apply(options); }
            const save = registration.save.bind(registration);
            registration.save = async (id, current, operation) => {
                if (stage === 'before' && operation) {
                    await save(id, current, operation);
                    throw new Error('simulated interruption');
                }
                if (stage === 'after' && !operation) { throw new Error('simulated interruption'); }
                await save(id, current, operation);
            };
            await assert.rejects(registration[action](options), /simulated interruption/);
            const reopened = new HostRegistration({ userDataPath });
            assert.equal((await reopened.state(options.id)).pending, action);
            const state = await reopened[action](options);
            assert.equal(state.pending, null);
            assert.equal(state.managed, action === 'apply');
            if (action === 'apply') {
                assert.deepEqual((await read()).hooks, options.fragment.hooks);
                await reopened.remove(options);
            }
            await assert.rejects(fs.stat(options.targetPath), { code: 'ENOENT' });
        });
    }
}

test('an external edit between planning and writing is preserved, and the next attempt can replan', async t => {
    const { options, registration, read, write } = await fixture(t);
    const initial = { hooks: { PreToolUse: [] } };
    const latest = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'keep-my-edit' }] }] } };
    await write(initial);
    const save = registration.save.bind(registration);
    registration.save = async (id, current, operation) => {
        await save(id, current, operation);
        if (operation) { await write(latest); }
    };
    await assert.rejects(registration.apply(options), { code: 'HOST_REGISTRATION_ERROR' });
    assert.deepEqual(await read(), latest);
    assert.equal((await registration.state('claude')).pending, null);
    registration.save = save;
    await registration.apply(options);
    await registration.remove(options);
    assert.deepEqual(await read(), latest);
});

test('fully manual registrations never acquire workbench ownership', async t => {
    const { options, registration, write, read } = await fixture(t);
    await write(options.fragment);
    const state = await registration.apply(options);
    assert.equal(state.managed, false);
    assert.deepEqual(state.events, []);
    assert.equal((await registration.remove(options)).managed, false);
    assert.deepEqual(await read(), options.fragment);
});

test('a damaged event in the current config is preserved during a retry', async t => {
    const { options, registration, write, read } = await fixture(t);
    await write({ hooks: { PreToolUse: null } });
    await assert.rejects(registration.apply(options), { code: 'HOST_REGISTRATION_ERROR' });
    assert.deepEqual(await read(), { hooks: { PreToolUse: null } });
});

test('cancelling an interrupted application preserves a changed event and removes the matching one', async t => {
    const { options, registration, userDataPath, write, read } = await fixture(t);
    const save = registration.save.bind(registration);
    registration.save = async (id, current, operation) => {
        if (!operation) { throw new Error('simulated interruption'); }
        await save(id, current, operation);
    };
    await assert.rejects(registration.apply(options), /simulated interruption/);
    const config = await read();
    config.hooks.PreToolUse[0].matcher = 'Bash';
    await write(config);
    const reopened = new HostRegistration({ userDataPath });
    await assert.rejects(reopened.remove(options), { code: 'HOST_REGISTRATION_ERROR', message: /PreToolUse/ });
    assert.deepEqual((await read()).hooks, { PreToolUse: config.hooks.PreToolUse });
    assert.deepEqual((await reopened.state(options.id)).events, ['PreToolUse']);
});
