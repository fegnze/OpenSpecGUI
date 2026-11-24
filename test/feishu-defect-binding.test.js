'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FeishuDefectBinding } = require('../src/main/feishu-defect-binding');
const { validateBinding } = require('../src/capabilities/skills/feishu-defect-agent/scripts/lib/io.mjs');

async function setup(t) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'defect-workbench-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    for (const sub of ['tree-a', 'tree-b', 'outside']) { await fs.mkdir(path.join(dir, sub)); }
    const first = { id: 'a', rootPath: path.join(dir, 'tree-a') };
    const second = { id: 'b', rootPath: path.join(dir, 'tree-b') };
    const active = { current: first };
    const data = path.join(dir, 'settings');
    const open = () => new FeishuDefectBinding({ userDataPath: data, getActive: () => active.current });
    return { dir, data, first, second, active, open, service: open() };
}

function validBinding() {
    return { version: 1, host: 'project.feishu.cn', project_key: 'fixture', work_item_type: 'issue',
        fields: { title: 'title', state: 'state', priority: 'priority', owners: 'owners', description: 'description' },
        sources: [{ kind: 'view', id: 'fixture-view' }], owners_semantics: 'current_state_operator',
        notifications: { provider: 'feishu-app', app_id: 'fixture-app', app_secret_env: 'FIXTURE_APP_SECRET' },
        repositories: [{ id: 'current', path: '../tree-a' }]
    };
}

test('保留外部单项目 JSON 的位置并在重启、切换和外部修改后重新检查', async t => {
    const { dir, data, first, second, active, open, service } = await setup(t);
    const file = path.join(dir, 'outside', 'binding.json');
    await fs.writeFile(file, JSON.stringify(validBinding()));
    const linked = await service.link(first.id, file);
    assert.equal(linked.configured, true);
    assert.equal(linked.path, file);
    assert.equal(path.resolve(path.dirname(linked.path), JSON.parse(await fs.readFile(file)).repositories[0].path), first.rootPath);
    const savedFiles = await fs.readdir(data, { recursive: true });
    assert.deepEqual(savedFiles.filter(f => f.endsWith('.json')).map(f => path.basename(f)), ['reference.json']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, savedFiles.find(f => f.endsWith('.json'))))), { path: file });
    assert.deepEqual(await fs.readdir(first.rootPath), []);
    assert.equal((await open().status(first.id)).configured, true);
    active.current = second;
    assert.equal((await service.status(second.id)).path, null);
    await assert.rejects(service.link(first.id, file), /工作树/);
    active.current = first;
    await fs.writeFile(file, '{}');
    assert.equal((await service.status(first.id)).configured, false);
    await fs.rm(file);
    assert.match((await service.status(first.id)).message, /无法读取/);
});

test('模板只在用户目录创建，重复创建保留已填内容；多个工作树互相隔离', async t => {
    const { data, first, second, active, service } = await setup(t);
    const sample = await service.template(first.id);
    assert.equal(sample.configured, false);
    assert.ok(sample.path.startsWith(data + path.sep));
    assert.match(sample.message, /EXAMPLE/);
    const template = JSON.parse(await fs.readFile(sample.path));
    assert.equal(template.repositories[0].path, first.rootPath);
    assert.doesNotThrow(() => validateBinding(template));
    const content = JSON.stringify(validBinding(), null, 3);
    await fs.writeFile(sample.path, content);
    assert.equal((await service.status(first.id)).configured, true);
    assert.equal((await service.template(first.id)).path, sample.path);
    assert.equal(await fs.readFile(sample.path, 'utf8'), content);
    active.current = second;
    const other = await service.template(second.id);
    assert.notEqual(other.path, sample.path);
    assert.equal(other.configured, false);
    assert.deepEqual(await fs.readdir(first.rootPath), []);
    assert.deepEqual(await fs.readdir(second.rootPath), []);
});

test('嵌套凭据、错误类型或示例配置不能替换原绑定，不将输入内容回显给调用方', async t => {
    const { dir, first, service } = await setup(t);
    const file = path.join(dir, 'valid.json'), invalid = path.join(dir, 'invalid.json');
    await fs.writeFile(file, JSON.stringify(validBinding()));
    await service.link(first.id, file);
    const secret = 'fixture-private-literal';
    for (const change of [
        b => { b.notifications.app_secret = secret; },
        b => { b.client = { refreshToken: secret }; },
        b => { b.repositories[0].remote = 'https://' + secret + '@example.invalid/repo'; },
        b => { b.issue_url_template = 'https://example.invalid/item?access_token=' + secret; },
        b => { b.headers = { authorization: 'Bearer ' + secret }; },
        b => { b.project_key = 'EXAMPLE_PROJECT_KEY'; },
        b => { b.sources = []; },
        b => { b.fields.owners = null; },
        b => { b.fields.owners = ' '; }
    ]) {
        const input = validBinding();
        change(input);
        await fs.writeFile(invalid, JSON.stringify(input));
        await assert.rejects(service.link(first.id, invalid), error => !error.message.includes(secret));
        const current = await service.status(first.id);
        assert.equal(current.path, file);
        assert.equal(current.configured, true);
    }
});

test('用户数据位置落在工作树内时不创建本机配置', async t => {
    const { first } = await setup(t);
    const service = new FeishuDefectBinding({ userDataPath: path.join(first.rootPath, '.personal'), getActive: () => first });
    await assert.rejects(service.template(first.id), /业务工程之外/);
    assert.deepEqual(await fs.readdir(first.rootPath), []);
});

test('无需 JSON 即可从表单建立本机配置，保存后按真实 Skill 契约回读', async t => {
    const { first, data, open, service } = await setup(t);
    const fresh = await service.readSettings(first.id);
    assert.equal(fresh.configured, false);
    assert.equal(fresh.values.ownerSemantics, '');
    assert.equal(fresh.values.fields.owners, 'current_status_operator');
    assert.equal(fresh.values.repositories[0].path, first.rootPath);
    assert.deepEqual(fresh.values.sources, [{ kind: 'view', id: '' }]);
    const values = { ...fresh.values, projectKey: 'work-items', sources: [{ kind: 'view', id: 'bugs' }, { kind: 'issue', id: '7' }],
        ownerSemantics: 'current_state_operator', profile: 'defects-team', releaseProvider: 'Jenkins',
        notificationProvider: 'feishu-app', appId: 'fixture-app', appSecretEnv: 'FEISHU_APP_SECRET',
        identityHost: 'identity-service', identityFile: '/identities/project.json' };
    const saved = await service.saveSettings(first.id, fresh.revision, values);
    assert.ok(saved.configured);
    assert.ok(saved.path.startsWith(data + path.sep));
    assert.notEqual(saved.revision, fresh.revision);
    assert.deepEqual(saved.values, values);
    const json = JSON.parse(await fs.readFile(saved.path));
    assert.doesNotThrow(() => validateBinding(json));
    assert.deepEqual(json.identity_source, { host: values.identityHost, file: values.identityFile });
    assert.equal(json.notifications.app_secret_env, 'FEISHU_APP_SECRET');
    assert.equal(json.cli.profile, 'defects-team');
    assert.deepEqual(await open().readSettings(first.id), saved);
    const again = await service.saveSettings(first.id, saved.revision, { ...saved.values, releaseProvider: 'TeamRelease' });
    assert.equal(again.path, saved.path, '保持 CLI 按绑定路径定位的运行历史');
    assert.deepEqual(await fs.readdir(first.rootPath), []);
});

test('编辑外部绑定生成可用本机副本，保留相对仓库、路由、字段和高级适配器', async t => {
    const { first, dir, service } = await setup(t);
    const file = path.join(dir, 'outside', 'external.json');
    const original = validBinding();
    original.repositories[0].match = { field: 'module', equals: 'client' };
    original.repositories[0].delivery = { publish: { argv: ['fixture-release', 'deploy'] } };
    original.fields.product = 'flavour';
    original.cli = { profile: 'old', executable: 'private-adapter' };
    original.notifications = { provider: 'command', argv: ['private-adapter'], qa: { receive_id_type: 'chat_id', receive_id: 'qa' } };
    original.budgets = { candidate_limit: 6 };
    original.handoff = { directory: 'docs/handoff' };
    const contents = JSON.stringify(original, null, 4);
    await fs.writeFile(file, contents);
    await service.link(first.id, file);
    const view = await service.readSettings(first.id);
    assert.equal(view.values.repositories[0].path, first.rootPath);
    assert.equal(view.values.notificationProvider, 'command');
    assert.ok(!JSON.stringify(view).includes('private-adapter'));
    assert.ok(!JSON.stringify(view).includes('fixture-release'));
    await assert.rejects(service.saveSettings(first.id, view.revision, { ...view.values, repositories: [{ ...view.values.repositories[0], id: 'new' }] }), /高级配置/);
    await assert.rejects(service.saveSettings(first.id, view.revision, { ...view.values, cli: { executable: 'unlisted' } }), /不支持的字段/);
    await assert.rejects(service.saveSettings(first.id, view.revision, { ...view.values, repositories: [{ ...view.values.repositories[0], delivery: {} }] }), /不支持的字段/);
    const changed = await service.saveSettings(first.id, view.revision, { ...view.values, profile: 'new-person', projectKey: 'new-space' });
    assert.notEqual(changed.path, file);
    const copy = JSON.parse(await fs.readFile(changed.path));
    assert.equal(copy.repositories[0].path, first.rootPath);
    assert.deepEqual(copy.repositories[0].delivery, original.repositories[0].delivery);
    assert.deepEqual(copy.repositories[0].match, original.repositories[0].match);
    assert.deepEqual(copy.notifications, original.notifications);
    assert.deepEqual(copy.budgets, original.budgets);
    assert.equal(copy.fields.product, original.fields.product);
    assert.deepEqual(copy.cli, { ...original.cli, profile: 'new-person' });
    assert.equal(await fs.readFile(file, 'utf8'), contents);
    assert.deepEqual(await fs.readdir(first.rootPath), []);
});

test('并发编辑、外部修改及项目切换后拒绝旧表单，保留最后一次有效配置', async t => {
    const { first, second, active, dir, service } = await setup(t);
    const file = path.join(dir, 'outside', 'bound.json');
    await fs.writeFile(file, JSON.stringify(validBinding()));
    await service.link(first.id, file);
    const initial = await service.readSettings(first.id);
    active.current = second;
    await assert.rejects(service.saveSettings(first.id, initial.revision, initial.values), /工作树/);
    await assert.rejects(service.saveSettings(second.id, initial.revision, initial.values), /重新打开/);
    active.current = first;
    await fs.writeFile(file, JSON.stringify({ ...validBinding(), release_provider: 'External' }));
    await assert.rejects(service.saveSettings(first.id, initial.revision, initial.values), /重新打开/);
    const fresh = await service.readSettings(first.id);
    const replies = await Promise.allSettled(['First', 'Second'].map(releaseProvider =>
        service.saveSettings(first.id, fresh.revision, { ...fresh.values, releaseProvider })));
    assert.equal(replies.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(replies.find(result => result.status === 'rejected').reason.message, /重新打开/);
    const saved = replies.find(result => result.status === 'fulfilled').value;
    assert.deepEqual((await service.readSettings(first.id)).values, saved.values);
    assert.equal(JSON.parse(await fs.readFile(file)).release_provider, 'External');
});
