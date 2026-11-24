'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CapabilityProjectServices } = require('../src/main/capability-project-services');
const { FeishuDefectBinding } = require('../src/main/feishu-defect-binding');

async function fixture(t, extra = {}) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-scopes-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const active = { project: { id: 'a', rootPath: path.join(dir, 'a') } };
    await fs.mkdir(active.project.rootPath);
    const a = { projectId: 'a', host: 'codex', root: active.project.rootPath };
    const b = { projectId: 'b', host: 'codex', root: path.join(dir, 'b') };
    await fs.mkdir(b.root);
    const options = { userDataPath: path.join(dir, 'data'), getActive: () => active.project,
        safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() },
        ...extra };
    return { a, b, options, scopes: new CapabilityProjectServices(options) };
}

test('当前工作树和宿主主动复用 CV 凭据，其余范围仍需各自选择', async t => {
    const { a, b, scopes } = await fixture(t);
    const call = (ctx, op, settings) => scopes.connection(ctx, 'cv-test1', op, settings);
    const dsh = { ...a, host: 'dsh' };
    await call(dsh, 'connect', { token: 'test1' });
    for (const ctx of [a, { ...a, host: 'claude' }, b]) {
        const status = await call(ctx, 'status');
        assert.equal(status.connected, false);
        assert.equal(status.canReuse, true);
    }
    await call(b, 'reuse', {});
    await call(b, 'disconnect');
    assert.equal((await call(dsh, 'status')).connected, true);
    assert.equal((await call(b, 'status')).canReuse, true);
});

test('同一 OAuth 授权只轮换一次，文档及验证状态按绑定隔离，断开最后一个引用才清除共享凭据', async t => {
    let rotations = 0;
    const docs = [];
    const { a, b, scopes } = await fixture(t, { now: () => 5_000_000, fetch: async (url, init) => {
        if (url.includes('/oauth/')) {
            const body = new URLSearchParams(init.body);
            assert.equal(body.get('scope'), 'docx:document:readonly');
            assert.equal(body.get('refresh_token'), 'refresh-' + rotations++);
            return Response.json({ access_token: 'fresh', refresh_token: 'refresh-' + rotations, expires_in:3600, token_type:'bearer' });
        }
        assert.equal(init.headers.Authorization, 'Bearer fresh');
        const doc = url.split('/').pop();
        docs.push(doc);
        return Response.json({ code:0, data:{document:{document_id:doc}} });
    } });
    const call = (ctx, op, settings) => scopes.connection(ctx, 'feishu', op, settings);
    const provider = 'feishu';
    const source = scopes.get(a).documentConnections;
    await source.write(provider, { version:1,provider,clientId:'fixture',clientSecret:'fixture',accessToken:'old',
        refreshToken:'refresh-0',expiresAt:0,grantedScopes:['docx:document:readonly', 'im:message'],documentId:'A'.repeat(16),verifiedAt:'saved' });
    await scopes.rememberAccount(provider,scopes.get(a).key,true);
    assert.equal((await call(b, 'status')).connected, false);
    await assert.rejects(call(b, 'reuse', {}), /文档 ID/);
    const reused = await call(b, 'reuse', {documentId:'B'.repeat(16)});
    assert.equal(reused.verifiedAt, null);
    assert.deepEqual(reused.scopes, ['docx:document:readonly', 'im:message']);
    assert.equal((await call(a, 'status')).verifiedAt,'saved');
    await Promise.all([call(a, 'verify'), call(b, 'verify')]);
    assert.equal(rotations,1);
    assert.deepEqual((await call(a, 'status')).scopes, ['docx:document:readonly']);
    assert.deepEqual((await call(b, 'status')).scopes, ['docx:document:readonly']);
    assert.deepEqual(docs.sort(),['A'.repeat(16),'B'.repeat(16)]);
    await call(a,'disconnect');
    assert.equal((await call(b,'verify')).state,'verified');
    assert.equal((await call(a,'status')).canReuse,true);
    await call(b,'disconnect');
    assert.equal((await call(a,'status')).canReuse,false);
    assert.deepEqual(await fs.readdir(scopes.options.accounts),[]);
});

test('明确迁移的两宿主各自拥有设置副本并保留相对路径语义', async t => {
    const { a, options, scopes } = await fixture(t);
    const old = new FeishuDefectBinding(options);
    const empty = await old.readSettings(a.projectId);
    const original = await old.saveSettings(a.projectId,empty.revision,{ ...empty.values,projectKey:'test-project',sources:[{kind:'view',id:'test-view'}] });
    const ctx = { ...a, migratedProject:true };
    const other = { ...a, host:'claude', migratedProject:true };
    const before = await (await scopes.defect({...other,migratedProject:false})).defectBinding.status(a.projectId);
    assert.equal(before.configured,false);
    const [codex,claude] = await Promise.all([scopes.defect(ctx),scopes.defect(other)]);
    const codexForm = await codex.defectBinding.readSettings(a.projectId);
    const claudeForm = await claude.defectBinding.readSettings(a.projectId);
    assert.equal(new Set([original.path,codexForm.path,claudeForm.path]).size,3);
    await codex.defectBinding.saveSettings(a.projectId,codexForm.revision,{...codexForm.values,projectKey:'codex-only'});
    assert.equal((await claude.defectBinding.readSettings(a.projectId)).values.projectKey,'test-project');
    assert.equal((await old.readSettings(a.projectId)).values.projectKey,'test-project');
});
