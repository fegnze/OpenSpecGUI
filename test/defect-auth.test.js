'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DefectAuth, findCli } = require('../src/main/defect-auth');

const values = { host: 'project.feishu.cn', profile: 'team-a', notificationProvider: 'feishu-app',
    appId: 'cli_fixture', appSecretEnv: 'TEST_FIXTURE_SECRET' };
const personal = { appId: values.appId, identities: { user: { available: false, status: 'missing' }, bot: { available: true, verified: true } } };
const reply = data => ({ code: 0, data });
const projectDevice = { device_code: 'private-fixture-device', client_id: 'client-fixture', user_code: 'ABCD-EFGH',
    verification_uri_complete: 'https://project.feishu.cn/oauth/verify?usercode=ABCD-EFGH', interval: 5, expires_in: 300 };

function setup(extra = {}) {
    const view = { projectId: 'p', configured: true, revision: 'one', values: { ...values, ...extra.values } };
    const calls = [];
    const opened = [];
    const service = new DefectAuth({
        binding: { readSettings: async id => { assert.equal(id, 'p'); return structuredClone(view); } },
        find: extra.find || (async name => ({ file: name, dirs: [] })),
        env: { TEST_FIXTURE_SECRET: 'fake-secret-never-return' },
        openExternal: async url => { opened.push(url); },
        run: async (cli, args, options) => {
            calls.push({ cli: cli.file, args, options });
            const result = extra.respond?.(cli.file, args, options, view);
            if (result !== undefined) { return result; }
            if (cli.file === 'meegle' && args.includes('config')) { return reply(values.host); }
            if (cli.file === 'lark-cli' && args.includes('status')) { return reply(personal); }
            if (cli.file === 'meegle' && args.includes('status')) { return { code: 1, data: { host: values.host, authenticated: false, reason: 'no local token' } }; }
            throw new Error('Unexpected fixture operation');
        }
    });
    return { service, view, calls, opened };
}

test('Finder locates an executable nvm installation without shell initialization', async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'defect-discovery-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    for (const version of ['v9.0.0', 'v22.1.0', 'project-local']) {
        const dir = path.join(home, '.nvm', 'versions', 'node', version, 'bin');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'meegle'), '#!/usr/bin/env node\n', { mode: 0o700 });
    }
    const result = await findCli('meegle', { home, baseDirs: [] });
    assert.ok(result.file.endsWith('/v22.1.0/bin/meegle'));
    assert.equal(result.dirs[0], path.dirname(result.file));
    assert.equal(await findCli('lark-cli', { home, baseDirs: [] }), null);
    await assert.rejects(findCli('untrusted'));
});

test('unsaved settings show local CLI detection, no processes or authorization', async () => {
    const f = setup({ find: async name => name === 'meegle' ? { file: name } : null });
    f.view.configured = false;
    const result = await f.service.authorize('p', 'meegle');
    assert.match(result.meegle.message, /已找到.*先保存/);
    assert.match(result.feishu.message, /未找到/);
    assert.match(result.feishu.command, /larksuite/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.opened, []);
});

test('Meegle device login opens once, keeps private codes internal and verifies user me after completion', async () => {
    let complete;
    let logged = false;
    const f = setup({ respond: (cli, args) => {
        if (cli !== 'meegle') { return; }
        if (args.includes('init')) { return reply(projectDevice); }
        if (args.includes('poll')) {
            return new Promise(resolve => { complete = () => { logged = true; resolve(reply({})); }; });
        }
        if (args.includes('status') && logged) { return reply({ authenticated: true, host: values.host }); }
        if (args.includes('me')) { return reply({ data: { code: 0, data: { user_key: 'project-actor', name: 'private fixture' } }, meta: {}, error: null }); }
    } });
    const [one, two] = await Promise.all([f.service.authorize('p', 'meegle'), f.service.authorize('p', 'meegle')]);
    assert.equal(one.meegle.state, 'pending');
    assert.equal(two.meegle.state, 'pending');
    assert.equal(f.opened.length, 1);
    const waiting = await f.service.check('p');
    assert.equal(waiting.meegle.userCode, projectDevice.user_code);
    assert.equal(JSON.stringify(waiting).includes(projectDevice.device_code), false);
    assert.equal(f.calls.filter(x => x.args.includes('poll')).length, 1);
    assert.ok(f.calls.filter(x => x.cli === 'meegle').every(x => x.args.includes(values.profile) && (x.args.includes('config') ? !x.options.host : x.options.host === values.host)));
    complete();
    await new Promise(resolve => setImmediate(resolve));
    const done = await f.service.check('p');
    assert.equal(done.meegle.state, 'verified');
    assert.equal(done.feishu.state, 'login');
    assert.equal(done.notifications.state, 'unverified');
    assert.equal(done.identityMapping.state, 'unverified');
    assert.doesNotMatch(JSON.stringify(done), /private fixture|project-actor|fake-secret-never-return|ABCD-EFGH/);
});

test('Feishu uses the notification app, asks for no business scopes, and verifies the personal identity separately', async () => {
    let finish;
    let ready = false;
    const url = 'https://accounts.feishu.cn/oauth/device?user_code=ABC';
    const f = setup({ respond: (cli, args) => {
        if (cli !== 'lark-cli') { return; }
        assert.deepEqual(args.slice(0, 2), ['--profile', values.appId]);
        if (args.includes('--no-wait')) {
            assert.ok(args.includes('offline_access'));
            assert.ok(!args.includes('--recommend'));
            return reply({ device_code: 'sensitive-fixture', expires_in: 360, verification_url: url });
        }
        if (args.includes('--device-code')) { return new Promise(resolve => { finish = () => { ready = true; resolve(reply({})); }; }); }
        if (ready) { return reply({ appId: values.appId, identities: { user: { verified: true, available: true } } }); }
    } });
    const waiting = await f.service.authorize('p', 'feishu');
    assert.equal(waiting.feishu.state, 'pending');
    assert.deepEqual(f.opened, [url]);
    assert.doesNotMatch(JSON.stringify(waiting), /sensitive-fixture|user_code/);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    const done = await f.service.check('p');
    assert.equal(done.feishu.state, 'verified');
    assert.equal(done.identityMapping.state, 'unverified');
});

test('rejects unexpected hosts, mismatched applications, raw errors and unsafe verification URLs', async () => {
    const invalid = setup({ values: { host: 'example.invalid', notificationProvider: 'command' } });
    assert.equal((await invalid.service.authorize('p', 'meegle')).meegle.state, 'configure');
    assert.deepEqual(invalid.calls, []);
    for (const url of ['http://project.feishu.cn/x', 'https://project.feishu.cn.untrusted.invalid/x', 'https://project.feishu.cn:4200/x',
        'https://who@project.feishu.cn/x', 'https://project.feishu.cn/x?device_code=secret']) {
        const bad = setup({ respond: (cli, args) => {
            if (args.includes('init')) { return reply({ ...projectDevice, verification_uri_complete: url }); }
            if (cli === 'lark-cli') { return reply({ appId: 'cli_another', identities: { user: { verified: true } } }); }
        } });
        const response = await bad.service.authorize('p', 'meegle');
        assert.equal(response.meegle.state, 'error');
        assert.equal(response.feishu.state, 'configure');
        assert.deepEqual(bad.opened, []);
        assert.ok(!bad.calls.some(c => c.args.includes('poll')));
        assert.doesNotMatch(JSON.stringify(response), /another|untrusted|device_code/);
    }
    const network = setup({ respond: (cli, args) => cli === 'meegle' && args.includes('status') ?
        { code: 2, data: { host: values.host, authenticated: false, reason: 'server unreachable: fixture-diagnostic' } } : undefined });
    const status = await network.service.authorize('p', 'meegle');
    assert.equal(status.meegle.state, 'error');
    assert.equal(status.meegle.action, undefined);
    assert.doesNotMatch(JSON.stringify(status), /fixture-diagnostic/);
    assert.deepEqual(network.opened, []);
});

test('a changed project cannot open an authorization page after device initiation', async () => {
    const f = setup({ respond: (_cli, args, _options, view) => {
        if (args.includes('init')) { view.revision = 'replaced'; return reply(projectDevice); }
    } });
    assert.equal((await f.service.authorize('p', 'meegle')).meegle.state, 'error');
    assert.deepEqual(f.opened, []);
    assert.ok(!f.calls.some(call => call.args.includes('poll')));
    f.service.dispose();
});

test('a profile belonging to another host is diagnosed before contacting any project server', async () => {
    const f = setup({ respond: (cli, args) => cli === 'meegle' && args.includes('config') ? reply('meegle.com') : undefined });
    const result = await f.service.authorize('p', 'meegle');
    assert.equal(result.meegle.state, 'configure');
    assert.ok(f.calls.filter(c => c.cli === 'meegle').every(c => c.args.includes('config') && !c.options.host));
    assert.deepEqual(f.opened, []);
});

test('a Finder-style process runs the fixed CLI in a temporary fixture and returns only sanitized state', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'defect-cli-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'meegle');
    const stub = [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('config')) process.stdout.write('project.feishu.cn\\n');",
        "else if (args.includes('status')) process.stdout.write(JSON.stringify({ authenticated: true, host: process.env.MEEGLE_HOST }));",
        "else if (args.includes('me')) process.stdout.write(JSON.stringify({data: {user_key: 'actor', marker: 'private example'}, meta: {}}));",
        "else process.exitCode = 2;"
    ].join('\n');
    await fs.writeFile(file, stub, { mode: 0o700 });
    const service = new DefectAuth({
        binding: { readSettings: async () => ({ configured: true, projectId: 'p', revision: 'one', values }) },
        find: async name => name === 'meegle' ? { file, dirs: [path.dirname(process.execPath), '/usr/bin'] } : null,
        env: {}
    });
    t.after(() => service.dispose());
    const result = await service.check('p');
    assert.equal(result.meegle.state, 'verified');
    assert.equal(result.feishu.state, 'missing');
    assert.doesNotMatch(JSON.stringify(result), /private example/);
});
