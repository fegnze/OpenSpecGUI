'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { CapabilityRegistry } = require('../src/main/capability-registry');

async function setup(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-capabilities-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const state = { project: null };
    const userDataPath = path.join(dir, 'user-data');
    const open = () => new CapabilityRegistry({ userDataPath, getActive: () => state.project });
    return { dir, state, registry: open(), open };
}

async function apply(registry, request) {
    const { planId } = await registry.preview(request);
    return registry.apply({ planId, projectId: request.projectId });
}

async function selectItem(registry, id, host, projectId) {
    const { items } = await registry.list({ host, projectId });
    return items.find(item => item.id === id);
}

test('归档前同步规范在所选工作树生效，解除最后一个宿主绑定后恢复项目默认', async t => {
    const { dir, state, registry } = await setup(t);
    const { readArchivePolicy } = require('../src/main/archive-binding-policy');
    const userData = path.join(dir, 'user-data');
    const root = path.join(dir, 'worktree');
    await fs.mkdir(root);
    state.project = { id: 'current', rootPath: root };
    const request = { projectId: 'current', scope: 'project', id: 'archive-synced-specs', version: '1.0.0' };
    assert.equal((await readArchivePolicy(userData, root)).requireSyncedSpecs, false);
    for (const host of ['codex', 'claude']) { await apply(registry, { ...request, host, operation: 'bind' }); }
    assert.equal((await readArchivePolicy(userData, root)).requireSyncedSpecs, true);
    assert.equal((await readArchivePolicy(userData, path.join(dir, 'other'))).requireSyncedSpecs, false);
    await apply(registry, { ...request, host: 'codex', operation: 'unbind' });
    assert.equal((await readArchivePolicy(userData, root)).requireSyncedSpecs, true);
    await apply(registry, { ...request, host: 'claude', operation: 'unbind' });
    assert.equal((await readArchivePolicy(userData, root)).requireSyncedSpecs, false);
});

test('内置能力均可读取，Skill 从同目录取得完整的实际脚本与说明', async t => {
    const { registry } = await setup(t);
    const { items } = await registry.list({ host: 'codex' });
    const byId = new Map(items.map(item => [item.id, item]));
    assert.equal(items.length, byId.size);
    for (const id of ['feishu-defect-agent', 'git-commit', 'cv-test1', 'feishu', 'google-drive']) {
        assert.ok(byId.has(id), id);
    }
    assert.ok(items.some(item => item.kind === 'rule'));
    for (const item of items) {
        assert.equal(item.effectiveVersion, null);
        const contents = await registry.snapshot(item, item.versions[0]);
        const files = contents.files.map(f => f.path);
        assert.ok(files.length > 0, item.id);
        assert.ok(!files.some(f => f.endsWith('.local.json') || path.basename(f) === '.env'), item.id);
        if (item.id === 'feishu-defect-agent') {
            for (const required of ['scripts/defects.mjs', 'scripts/lib/meegle.mjs', 'assets/binding.example.json', 'references/operations.md', 'LICENSE']) {
                assert.ok(files.includes(required), required);
            }
        } else if (item.id === 'git-commit') {
            for (const required of ['scripts/git_commit_helper.js', 'references/sync-recovery.md']) { assert.ok(files.includes(required), required); }
            await assert.rejects(registry.preview({ operation: 'bind', id: item.id, host: 'codex', scope: 'global', version: item.latest }), /项目|WorldTourCasino/);
        } else if (item.provider) {
            const descriptor = JSON.parse(Buffer.from(contents.files[0].data, 'base64').toString());
            assert.equal(descriptor.provider, item.id);
            if (item.kind === 'mcp') { assert.equal(item.endpoint, require('../src/main/cv-mcp-connection').ENDPOINT); }
            if (item.id === 'feishu') { assert.equal(descriptor.access, 'read-write'); }
            if (item.id === 'google-drive') { assert.equal(descriptor.access, 'read-only'); }
        }
    }
});

test('新版飞书目录保留旧只读绑定与快照，成员可确认升级读写版本', async t => {
    const { registry, dir, state } = await setup(t);
    state.project = { id: 'project', rootPath: dir };
    const context = { projectId: 'project', host: 'codex', scope: 'project', operation: 'bind', id: 'feishu' };
    const oldCatalog = path.join(dir, 'old-release');
    const entry = (await registry.entries()).find(item => item.id === 'feishu');
    const oldVersion = '1.0.0';
    await fs.mkdir(path.join(oldCatalog, 'tools'), { recursive: true });
    await fs.writeFile(path.join(oldCatalog, 'catalog.json'), JSON.stringify([{ ...entry, version: oldVersion, versions: [{ version: oldVersion, source: entry.source }] }]));
    await fs.writeFile(path.join(oldCatalog, entry.source), JSON.stringify({ provider: 'feishu', access: 'read-only' }));
    const oldRegistry = new CapabilityRegistry({ userDataPath: path.join(dir, 'user-data'), getActive: () => state.project, catalogRoot: oldCatalog });
    await apply(oldRegistry, { ...context, version: oldVersion });

    const upgraded = await selectItem(registry, 'feishu', context.host, context.projectId);
    assert.equal(upgraded.effectiveVersion, oldVersion);
    assert.notEqual(upgraded.latest, oldVersion);
    const snapshot = await registry.snapshot(upgraded, upgraded.pinnedVersion);
    assert.equal(JSON.parse(Buffer.from(snapshot.files[0].data, 'base64').toString()).access, 'read-only');
    await apply(registry, { ...context, version: upgraded.latest });
    assert.equal((await selectItem(registry, 'feishu', context.host, context.projectId)).effectiveVersion, upgraded.latest);
});

test('WTC 提交 Skill 按工程标识和检查命令限制范围，允许目录名不同的工作树', async t => {
    const { registry, state, dir } = await setup(t);
    const root = path.join(dir, 'WorldTourCasino');
    await fs.mkdir(root);
    state.project = { id: 'current', rootPath: root };
    const { latest } = await selectItem(registry, 'git-commit', 'claude', state.project.id);
    const binding = { host: 'claude', operation: 'bind', id: 'git-commit', scope: 'project', projectId: 'current', version: latest };
    await assert.rejects(registry.preview(binding), /项目标识|WorldTourCasino/);
    const manifest = { name: 'world-tour-casino', scripts: { 'list:openspec': 'fixture' } };
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(registry.preview(binding), /检查脚本|WorldTourCasino/);
    const worktree = path.join(dir, 'nightly-fix');
    await fs.mkdir(worktree);
    state.project = { id: 'current', rootPath: worktree };
    manifest.scripts['check:openspec'] = 'fixture';
    await fs.writeFile(path.join(worktree, 'package.json'), JSON.stringify(manifest));
    await apply(registry, binding);
    assert.equal((await selectItem(registry, 'git-commit', 'claude', state.project.id)).effectiveVersion, latest);
});

test('发布目录在工作树及宿主之间相同，先显式绑定才能使用，成员端拒绝增改来源', async t => {
    const { dir, state, registry, open } = await setup(t);
    state.project = { id: 'a', rootPath: path.join(dir, 'a') };
    const request = { operation: 'bind', scope: 'project', host: 'codex', projectId: 'a', id: 'cv-test1', version: '1.0.0' };
    await assert.rejects(registry.requireBinding(request, request.id), /先在当前项目/);
    await assert.rejects(registry.preview({ ...request, operation: 'update' }), /操作无效/);
    await assert.rejects(registry.preview({ ...request, operation: 'register' }), /操作无效/);
    await assert.rejects(registry.preview({ ...request, scope: 'global' }), /只可按项目/);
    await assert.rejects(registry.preview({ ...request, projectId:null }), /只可按项目/);
    await apply(registry, request);
    const a = await registry.list(request);
    const mcp = a.items.find(i => i.id === request.id);
    assert.equal(mcp.effectiveVersion, request.version);
    assert.equal((await registry.requireBinding(request, request.id)).root, state.project.rootPath);
    await assert.rejects(registry.requireBinding({...request,host:'claude'}, request.id), /先在当前项目/);
    const dsh = { ...request, host: 'dsh' };
    await assert.rejects(registry.requireBinding(dsh, request.id), /先在当前项目/);
    assert.ok((await registry.preview(dsh)).details.includes(state.project.rootPath + ' · DeepSeek Harness'));
    await apply(registry, dsh);
    assert.equal((await open().requireBinding(dsh, request.id)).host, 'dsh');
    await apply(registry, { ...dsh, operation: 'unbind' });
    assert.equal((await open().requireBinding(request, request.id)).host, 'codex');
    for (const { id, name } of a.items.filter((item, i, items) => items.findIndex(it => it.kind === item.kind) === i)) {
        await registry.rename({ ...request, id, expectedName: name, name: '自定义 ' + id });
    }
    const keys = list => list.items.map(i => [i.id,i.versions.map(v => v.version)]);
    state.project = { id: 'b', rootPath: path.join(dir, 'worktree-b') };
    const b = await open().list({projectId:'b',host:'codex'});
    assert.deepEqual(keys(b), keys(a));
    assert.ok(b.items.every(i => i.effectiveVersion === null));
    assert.ok(b.items.find(i => i.id === request.id).name.startsWith('自定义'));
    assert.equal((await open().list({projectId:null,host:'claude'})).items.length, b.items.length);
});

test('schema 1 保留原始备份、别名、固定旧版及快照，旧全局与外部来源不会生效', async t => {
    const { dir, state, registry, open } = await setup(t);
    state.project = { id:'a', rootPath: dir };
    const patch = { version: '0.9', builtin: true, localEntry: path.join(dir,'saved-entry'), digest: 'a'.repeat(64), source: 'skills/feishu-defect-agent/SKILL.md' };
    const old = { schema:1, revision:3, items:[
        { id:'feishu-defect-agent',kind:'skill',name:'项目助手',versions:[patch] },
        { id:'cv-test1',kind:'mcp',name:'测试连接',versions:[{version:'1.0.0',builtin:true}] },
        { id:'private-mcp',kind:'mcp',name:'自定义',versions:[{version:'1', source:'https://example.test'}] }
    ],bindings:[
        { id:'feishu-defect-agent',root:dir, host:'codex',version:'0.9' },
        { id:'cv-test1',root:null,host:'codex',version:'1.0.0' },
        { id:'private-mcp',root:dir,host:'codex',version:'1' }
    ] };
    await fs.mkdir(registry.root,{recursive:true});
    const bytes = JSON.stringify(old,null,2);
    await fs.writeFile(registry.file,bytes);
    const [first, second] = await Promise.all([registry.list({host:'codex',projectId:'a'}), registry.list({host:'claude',projectId:'a'})]);
    assert.equal(first.items.find(i => i.id === 'feishu-defect-agent').pinnedVersion.localEntry, patch.localEntry);
    assert.equal(first.items.find(i => i.id === 'feishu-defect-agent').name, '项目助手');
    assert.equal(first.recovery.globalBindings, 1);
    assert.equal(first.recovery.customItems, 1);
    assert.deepEqual(await fs.readFile(first.recovery.backupPath),Buffer.from(bytes));
    const upgraded = JSON.parse(await fs.readFile(registry.file));
    assert.equal(upgraded.items, undefined, '旧版 Skill 只读取 items，升级后不能发现任何授权');
    assert.ok(upgraded.records.some(record => record.id === 'feishu-defect-agent'));
    assert.ok(first.items.every(i => i.id !== 'private-mcp'));
    assert.ok(first.items.find(i => i.id === 'cv-test1').effectiveVersion === null);
    assert.ok(second.items.every(i => i.effectiveVersion === null));
    const backups = (await fs.readdir(registry.root)).filter(f => f.startsWith('registry-v1-'));
    assert.equal(backups.length,1);
    assert.equal(await fs.readFile(path.join(registry.root,backups[0]),'utf8'),bytes);
    assert.deepEqual((await open().list({host:'codex',projectId:'a'})).recovery,first.recovery);
});

test('改名与绑定预览共用串行写队列，已更改的显示名不被陈旧输入覆盖', async t => {
    const { dir, state, registry } = await setup(t);
    state.project = { id:'project', rootPath:dir };
    const item = await selectItem(registry, 'cv-test1', 'codex');
    const req = { id:item.id,expectedName:item.name,host:'codex',projectId:'project' };
    const plan = await registry.preview({ ...req, operation:'bind',scope:'project',version:item.latest });
    const [first, second] = await Promise.allSettled([registry.rename({...req,name:'A'}),registry.rename({...req,name:'B'})]);
    assert.equal(first.status,'fulfilled'); assert.equal(second.status,'rejected');
    await assert.rejects(registry.apply({planId:plan.planId,projectId:'project'}), /失效/);
    await assert.rejects(registry.rename({...req,name:' '}),/显示名称无效/);
});

test('独立工具、宿主工具、MCP 工具与依赖使用发布清单，预览后内容变化或依赖冲突均拒绝写入', async t => {
    const { dir } = await setup(t);
    const catalog = path.join(dir, 'release');
    await fs.mkdir(catalog);
    const entries = [
        { id:'sample',kind:'mcp',source:'mcp.json' },
        { id:'script',kind:'tool',source:'command.js' },
        { id:'host',kind:'tool',source:'host.json',reference:'host:read' },
        { id:'mtool',kind:'tool',source:'mtool.json',reference:'mcp:sample/read' },
        { id:'rule-a',kind:'rule',source:'a.md' }, { id:'rule-b',kind:'rule',source:'b.md' }
    ].map(e => ({ name:e.id,version:'1', ...e }));
    const manifest = path.join(catalog,'catalog.json');
    await fs.writeFile(manifest, JSON.stringify(entries));
    for (const row of entries) {
        const text = row.kind === 'rule' ? '---\nworkbench:\n  requires:\n    style: ' + row.id + '\n---\n' :
            row.source.endsWith('json') ? '{}' : 'console.log("test")';
        await fs.writeFile(path.join(catalog,row.source),text);
    }
    const options = { userDataPath:path.join(dir,'ud'),getActive:() => ({id:'aa',rootPath:dir}),catalogRoot:catalog };
    const registry = new CapabilityRegistry(options);
    const request = (id,operation = 'bind') => ({id,operation,projectId:'aa',host:'codex',scope:'project',version:'1'});
    const items = (await registry.list(request('host'))).items;
    assert.deepEqual(items.filter(item => item.kind === 'tool').map(item => item.toolType),['command','host','mcp']);
    await assert.rejects(registry.preview(request('host')), /宿主自带/);
    await assert.rejects(registry.preview(request('mtool')), /绑定.*MCP/);
    await apply(registry,request('sample'));
    await apply(registry,request('mtool'));
    await assert.rejects(registry.preview(request('sample','unbind')), /绑定.*MCP/);
    await apply(registry,request('rule-a'));
    await assert.rejects(registry.preview(request('rule-b')), /规范冲突/);
    const plan = await registry.preview(request('script'));
    await fs.writeFile(path.join(catalog, 'command.js'), 'console.log("new")');
    await assert.rejects(registry.apply({planId:plan.planId,projectId:'aa'}), /重新预览/);
    await fs.writeFile(manifest,JSON.stringify(entries.filter(row => row.id !== 'mtool')));
    const reopened = new CapabilityRegistry(options);
    assert.ok(!(await reopened.list(request('sample'))).items.some(row => row.id === 'mtool'));
    assert.ok(!(await reopened.load()).bindings.some(row => row.id === 'mtool'));
});
