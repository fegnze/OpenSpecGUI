'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { CapabilityProjectServices } = require('../src/main/capability-project-services');
const { CapabilityRegistry } = require('../src/main/capability-registry');
const skill = path.resolve(__dirname, '../src/capabilities/skills/feishu-defect-agent');

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-defect-discovery-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const userDataPath = path.join(root, 'installed');
    const a = { id: 'first', rootPath: path.join(root, 'a/project') };
    const b = { id: 'second', rootPath: path.join(root, 'b/project') };
    await fs.mkdir(path.dirname(b.rootPath), { recursive: true });
    await execFile('git', ['init', '--quiet', a.rootPath]);
    await execFile('git', ['-C', a.rootPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    await execFile('git', ['-C', a.rootPath, 'worktree', 'add', '--quiet', '--detach', b.rootPath]);
    const active = { current: a };
    const options = { userDataPath, getActive: () => active.current };
    const scopes = new CapabilityProjectServices(options);
    const settings = new Proxy({}, { get: (_obj, method) => (...args) => {
        const ctx = { root: active.current.rootPath, host: 'codex' };
        return scopes.get(ctx).defectBinding[method](...args);
    } });
    const registry = new CapabilityRegistry(options);
    for (const project of [b, a]) {
        active.current = project;
        const { planId } = await registry.preview({ operation: 'bind', id: 'feishu-defect-agent', projectId: project.id, host: 'codex', scope: 'project', version: '1.2.0' });
        await registry.apply({ planId, projectId: project.id });
    }
    const entry = (await registry.list({ host: 'codex', projectId: a.id })).items.find(item => item.id === 'feishu-defect-agent').pinnedVersion.localEntry;
    const cli = path.join(path.dirname(entry), 'scripts/defects.mjs');
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'meegle'), "#!/usr/bin/env node\nif (process.argv[2] !== 'user' || process.argv[3] !== 'me') process.exit(2);console.log(JSON.stringify({user_key:'fixture'}))\n", {mode: 0o700});
    async function run(file, checkout, extra = []) {
        const cwd = path.join(checkout.rootPath, 'src/nested');
        await fs.mkdir(cwd, { recursive: true });
        const args = [file, 'choices', '--state-dir', path.join(root, 'state', checkout.id), ...extra];
        const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
        const result = await execFile(process.execPath, args, { cwd, env }).catch(error => {
            if (error.stdout) return error;
            throw error;
        });
        return JSON.parse(result.stdout);
    }
    async function configure(project, releaseProvider) {
        active.current = project;
        const form = await settings.readSettings(project.id);
        return settings.saveSettings(project.id, form.revision, { ...form.values, projectKey: 'team-' + project.id, sources: [{ kind: 'view', id: 'bugs' }], releaseProvider });
    }
    return { root, a, b, active, settings, configure, run, cli };
}

test('实际 CLI 从同名 worktree 的子目录选择当前项目，显式 --binding 优先', async t => {
    const f = await fixture(t);
    const first = await f.configure(f.a, 'Alpha');
    assert.equal((await f.run(f.cli, f.a)).project_defaults.release_provider, 'Alpha');
    assert.equal((await f.run(f.cli, f.b)).error.code, 'BINDING_REQUIRED');
    await f.configure(f.b, 'Beta');
    assert.equal((await f.run(f.cli, f.b)).project_defaults.release_provider, 'Beta');
    assert.equal((await f.run(f.cli, f.a)).project_defaults.release_provider, 'Alpha');
    assert.equal((await f.run(f.cli, f.b, ['--binding', first.path])).project_defaults.release_provider, 'Alpha');
    f.active.current = f.b;
    await f.settings.template(f.b.id);
    assert.equal((await f.run(f.cli, f.b)).error.code, 'BINDING_REQUIRED');
    for (const project of [f.a, f.b]) {
        assert.equal((await execFile('git', ['-C', project.rootPath, 'status', '--porcelain'])).stdout, '');
    }
});

test('独立安装沿用原项目映射，工作台只从真实登记的安装位置读取项目绑定', async t => {
    const f = await fixture(t);
    const configured = await f.configure(f.a, 'Workbench');
    const standalone = path.join(f.root, 'standalone');
    await fs.cp(skill, standalone, { recursive: true });
    const data = JSON.parse(await fs.readFile(configured.path));
    data.release_provider = 'Standalone';
    await fs.writeFile(path.join(standalone, 'projects.local.json'), JSON.stringify({ project: data }));
    assert.equal((await f.run(path.join(standalone, 'scripts/defects.mjs'), f.a)).project_defaults.release_provider, 'Standalone');
    const falseInstall = path.join(f.a.rootPath, 'capabilities', 'versions', 'a'.repeat(64));
    await fs.cp(standalone, falseInstall, { recursive: true });
    assert.equal((await f.run(path.join(falseInstall, 'scripts/defects.mjs'), f.a)).error.code, 'WORKBENCH_INSTALL_INVALID');
});

test('升级内置目录后，原先固定的 1.0.0 保留已安装的内容和入口', async t => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-defect-upgrade-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const legacy = path.join(dir, 'old-catalog');
    await fs.mkdir(path.join(legacy, 'skill'), { recursive: true });
    const oldSkill = '---\nname: feishu-defect-agent\ndescription: 旧版夹具\n---\n调用时指定 --binding。\n';
    await fs.writeFile(path.join(legacy, 'skill/SKILL.md'), oldSkill);
    await fs.writeFile(path.join(legacy, 'catalog.json'), JSON.stringify([{ id: 'feishu-defect-agent', kind: 'skill',
        name: '飞书缺陷', version: '1.0.0', source: 'skill/SKILL.md', origin: 'fixture' }]));
    const options = { userDataPath: path.join(dir, 'data'), getActive: () => ({id: 'fixture', rootPath: dir}) };
    const old = new CapabilityRegistry({ ...options, catalogRoot: legacy });
    const request = { operation: 'bind', id: 'feishu-defect-agent', host: 'codex', projectId: 'fixture', scope: 'project', version: '1.0.0' };
    await old.apply({ ...await old.preview(request), projectId: 'fixture' });
    const upgraded = new CapabilityRegistry(options);
    const load = async () => (await upgraded.list({ host: 'codex', projectId:'fixture' })).items.find(i => i.id === request.id);
    const item = await load();
    assert.equal(item.latest, '1.2.0');
    assert.equal(item.effectiveVersion, request.version);
    const entry = item.pinnedVersion.localEntry;
    assert.equal(await fs.readFile(entry, 'utf8'), oldSkill);
    await upgraded.apply({ ...await upgraded.preview({ ...request, version: '1.2.0' }), projectId:'fixture' });
    assert.equal((await load()).effectiveVersion, '1.2.0');
    await assert.rejects(upgraded.preview(request), /选择可用版本/);
    assert.equal(await fs.readFile(entry, 'utf8'), oldSkill);
});
