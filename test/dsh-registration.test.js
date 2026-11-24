'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DshRegistration, inspectDshPatch } = require('../src/main/dsh-registration');

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-dsh-patch-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const targetPath = path.join(root, '.dsh/profiles/desktop/cordis.patch.yml');
    const userDataPath = path.join(root, 'workbench');
    const runnerPath = path.join(userDataPath, "workbench's hook");
    const entry = { id: 'openspec-gui-workbench', name: path.join(userDataPath, 'plugin.cjs'), config: { runnerPath } };
    const options = { id: 'dsh', targetPath, runnerPath, fragment: JSON.stringify({ insert: [entry] }) };
    const registration = new DshRegistration({ userDataPath });
    const write = async text => {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, text, { mode: 0o640 });
    };
    return { root, entry, options, registration, write, read: () => fs.readFile(targetPath, 'utf8') };
}

test('首次接入和解除可重复，在没有用户设置的目录中只管理自己的 patch', async t => {
    const { entry, options, registration } = await fixture(t);
    assert.equal(await inspectDshPatch(options.targetPath, entry), 'missing');
    await assert.rejects(fs.stat(path.dirname(options.targetPath)), { code: 'ENOENT' });
    assert.equal((await registration.apply(options)).managed, true);
    assert.deepEqual((await registration.apply(options)).events, ['system-prompt/assemble', 'tools.guard']);
    assert.equal(await inspectDshPatch(options.targetPath, entry), 'present');
    assert.equal((await registration.remove(options)).managed, false);
    assert.equal((await registration.remove(options)).managed, false);
    await assert.rejects(fs.stat(options.targetPath), { code: 'ENOENT' });
});

test('保留块和行内 YAML、注释、DSH 标签、文件权限与原始字节', async t => {
    const { entry, options, registration, write, read } = await fixture(t);
    for (const original of [
        '', '# 用户配置', '# 注释\n', '[]', '[{ id: hand }]', '[{ id: hand }, # 注释\n]',
        '\uFEFF---\r\n- id: other # 注释\r\n  config: !env FOO\r\n# 末尾\r\n...\r\n',
        '---\n# 注释\n...\n', '- id: other\n  config: |\n    keep raw lines'
    ]) {
        await write(original);
        await registration.apply(options);
        assert.equal(await inspectDshPatch(options.targetPath, entry), 'present');
        await registration.remove(options);
        assert.equal(await read(), original);
        assert.equal((await fs.stat(options.targetPath)).mode & 0o777, 0o640);
    }
});

test('旧版 DSH 登记沿用台账时间，重接后从新登记开始验证', async t => {
    const { options, registration } = await fixture(t);
    await registration.apply(options);
    const ledger = JSON.parse(await fs.readFile(registration.file));
    delete ledger.verifiedSince;
    const legacy = JSON.stringify(ledger);
    await fs.writeFile(registration.file, legacy);
    const since = 1700000000000;
    await fs.utimes(registration.file, new Date(since), new Date(since));
    assert.equal((await registration.state('dsh')).verifiedSince, since);
    assert.equal((await registration.apply(options)).verifiedSince, since);
    assert.equal(await fs.readFile(registration.file, 'utf8'), legacy);
    assert.equal((await registration.remove(options)).verifiedSince, null);
    const renewed = await registration.apply(options);
    assert.ok(renewed.verifiedSince > since);
    assert.equal((await registration.apply(options)).verifiedSince, renewed.verifiedSince);
});

test('手工登记不接管，外部增加的插件、注释和同组成员保留', async t => {
    const { entry, options, registration, write, read } = await fixture(t);
    const manual = '- ' + options.fragment + '\n';
    await write(manual);
    assert.equal((await registration.apply(options)).managed, false);
    await registration.remove(options);
    assert.equal(await read(), manual);
    await write('# my profile\n');
    await registration.apply(options);
    const unrelated = '- id: hand # later\n  name: !expr env.NAME\n';
    await write((await read()) + unrelated);
    await registration.remove(options);
    assert.equal(await read(), '# my profile\n' + unrelated);
    await registration.apply(options);
    await write('- insert:\n    - ' + JSON.stringify(entry) + '\n    - {id: hand, name: hand} # 手工登记\n');
    await registration.remove(options);
    assert.equal(await read(), '- insert:\n    - {id: hand, name: hand} # 手工登记\n');
});

test('接入创建的文件仅剩用户注释时，解除后保留注释和 Cordis 可加载的空数组', async t => {
    const { entry, options, registration, read, write } = await fixture(t);
    await registration.apply(options);
    await write((await read()) + '# my profile note');
    await registration.remove(options);
    assert.equal(await read(), '# my profile note\n[]\n');
    assert.deepEqual(require('yaml').parse(await read()), []);
    assert.equal(await inspectDshPatch(options.targetPath, entry), 'missing');
});

test('外部修改、重复或禁用的工作台登记保留并报告冲突', async t => {
    const { entry, options, registration, write, read } = await fixture(t);
    await registration.apply(options);
    const installed = await read();
    for (const modified of [
        installed.replace('plugin.cjs', 'changed.cjs'), installed + installed,
        installed + '- id: openspec-gui-workbench\n  disabled: true\n',
        '- insert: [' + JSON.stringify({ id: 'manual', group: true, config: [entry] }) + ']\n'
    ]) {
        await write(modified);
        assert.equal(await inspectDshPatch(options.targetPath, entry), 'conflict');
        await assert.rejects(registration.remove(options), /冲突/);
        assert.equal(await read(), modified);
    }
    await write('');
    assert.equal((await registration.remove(options)).managed, false);
});

test('以其他 ID 使用等价 file URL 或相对路径时阻止重复接入', async t => {
    const { entry, options, registration, write, read } = await fixture(t);
    const relative = path.relative(path.dirname(options.targetPath), entry.name);
    for (const name of [require('node:url').pathToFileURL(entry.name).href, relative, './' + relative]) {
        const text = '- ' + JSON.stringify({ insert: [{ ...entry, id: 'my-manual-alias', name }] }) + '\n';
        await write(text);
        assert.equal(await inspectDshPatch(options.targetPath, entry), 'conflict');
        await assert.rejects(registration.apply(options), /冲突/);
        assert.equal(await read(), text);
    }
});

test('拒绝损坏的 YAML、多文档、链接和非常规目标，诊断不含配置内容', async t => {
    const { entry, root, options, write, read } = await fixture(t);
    for (const invalid of ['{foo: private-value}', '---\n[]\n---\n[]\n', '- id: a\n  id: b', 'not-a-list private-value']) {
        await write(invalid);
        await assert.rejects(inspectDshPatch(options.targetPath, entry), { code: 'HOST_REGISTRATION_ERROR', message: /YAML/ });
        assert.equal(await read(), invalid);
    }
    const link = path.join(root, 'other');
    await fs.writeFile(link, '[]');
    for (const make of [fs.symlink, fs.link]) {
        await fs.unlink(options.targetPath);
        await make(link, options.targetPath);
        await assert.rejects(inspectDshPatch(options.targetPath, entry), /YAML/);
        assert.equal(await fs.readFile(link, 'utf8'), '[]');
    }
});

test('与原生 profile 编辑器竞争同一把锁，释放后读取最新补丁', async t => {
    const { options, registration, write, read } = await fixture(t);
    const lock = path.join(path.dirname(options.targetPath), 'package.json.lock');
    const owner = process.pid + '\n';
    await write('[]');
    await fs.writeFile(lock, owner);
    await assert.rejects(registration.apply(options), /正在修改/);
    assert.equal(await fs.readFile(lock, 'utf8'), owner);
    assert.equal(await read(), '[]');
    const pending = registration.apply(options);
    const updated = '- id: updated-in-dsh\n';
    await write(updated);
    await fs.unlink(lock);
    await pending;
    await registration.remove(options);
    assert.equal(await read(), updated);
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
});

test('宿主锁记录的 PID 确已退出才接管，其他进程的 takeover 声明保留', async t => {
    const { options, registration, write } = await fixture(t);
    await write('[]');
    const record = require('node:child_process').execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const lock = path.join(path.dirname(options.targetPath), 'package.json.lock');
    await fs.writeFile(lock, record);
    const claim = lock + '.takeover-' + require('node:crypto').createHash('sha256').update(record).digest('hex').slice(0, 16);
    await fs.writeFile(claim, 'other claimant');
    await assert.rejects(registration.apply(options), /正在修改/);
    assert.equal(await fs.readFile(claim, 'utf8'), 'other claimant');
    await fs.unlink(claim);
    assert.equal((await registration.apply(options)).managed, true);
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(claim), { code: 'ENOENT' });
});

for (const action of ['apply', 'remove']) {
    for (const timing of ['before', 'after']) {
        test(action + ' 在写入' + timing + '中断后可恢复', async t => {
            const { entry, options, registration } = await fixture(t);
            if (action === 'remove') { await registration.apply(options); }
            const save = registration.save.bind(registration);
            registration.save = async next => {
                if (timing === 'after' && !next?.pending) { throw new Error('simulate interruption'); }
                await save(next);
                if (timing === 'before' && next?.pending) { throw new Error('simulate interruption'); }
            };
            await assert.rejects(registration[action](options), /simulate/);
            registration.save = save;
            const prior = await registration.state('dsh');
            assert.equal(prior.pending, action);
            const result = await registration[action](options);
            assert.equal(result.pending, null);
            assert.equal(await inspectDshPatch(options.targetPath, entry), action === 'apply' ? 'present' : 'missing');
        });
    }
}


test('安装包移动时只更新已管理的 DSH 模块地址，解除仍还原用户文件', async t => {
    const { root, entry, options, registration, write, read } = await fixture(t);
    const pluginPath = path.join(root, "Agent Workbench's.app", 'plugin.mjs');
    const original = '# 我的 profile\n[]';
    await write(original);
    await registration.apply(options);
    const installed = await read();
    const since = (await registration.state('dsh')).verifiedSince;
    await write(installed.replace(entry.name, 'my-plugin'));
    await assert.rejects(registration.relocate({ ...options, pluginPath }), /冲突/);
    assert.equal(await read(), installed.replace(entry.name, 'my-plugin'));
    await write(installed);
    await registration.relocate({ ...options, pluginPath });
    assert.equal(await read(), installed.replace(entry.name, pluginPath));
    assert.equal((await registration.state('dsh')).verifiedSince, since);
    await registration.relocate({ ...options, pluginPath });
    await registration.remove({ ...options, fragment: undefined });
    assert.equal(await read(), original);
});

for (const timing of ['before', 'after']) {
    test('插件路径迁移 ' + timing + ' 中断后恢复，并保留其他插件的后续修改', async t => {
        const { root, entry, options, registration, write, read } = await fixture(t);
        const pluginPath = path.join(root, 'Agent Workbench.app/plugin.mjs');
        await registration.apply(options);
        const unrelated = '- id: manually-added\n';
        await write(await read() + unrelated);
        const save = registration.save.bind(registration);
        registration.save = async record => {
            if (timing === 'after' && !record.pending) { throw new Error('interrupted'); }
            await save(record);
            if (timing === 'before' && record.pending) { throw new Error('interrupted'); }
        };
        await assert.rejects(registration.relocate({ ...options, pluginPath }), /interrupted/);
        registration.save = save;
        await registration.relocate({ ...options, pluginPath });
        assert.equal(await inspectDshPatch(options.targetPath, { ...entry, name: pluginPath }), 'present');
        await registration.remove({ ...options, fragment: undefined });
        assert.equal(await read(), unrelated);
    });
}
