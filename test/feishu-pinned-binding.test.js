'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CapabilityRegistry } = require('../src/main/capability-registry');
const { CapabilityProjectServices } = require('../src/main/capability-project-services');

test('旧版飞书绑定按登记版本申请权限，并只复用符合该版本的个人授权', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-pinned-binding-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { userDataPath: root, getActive: () => ({ id: 'target', rootPath: root }) };
    const registry = new CapabilityRegistry(options);
    await fs.mkdir(registry.root, { recursive: true });
    await fs.writeFile(registry.file, JSON.stringify({
        schema: 2, revision: 1,
        records: [{ id: 'feishu', versions: [{ builtin: true, version: '1.0.0' }] }],
        bindings: [{ root, host: 'codex', id: 'feishu', version: '1.0.0' }]
    }));
    const old = await registry.requireBinding({ projectId: 'target', host: 'codex', version: '2.0.0' }, 'feishu');
    assert.equal(old.bindingVersion, '1.0.0');
    let browserScope;
    const services = new CapabilityProjectServices({
        ...options, feishuPort: 0,
        safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() },
        openExternal: async input => {
            const auth = new URL(input);
            browserScope = auth.searchParams.get('scope');
            const callback = new URL(auth.searchParams.get('redirect_uri'));
            callback.searchParams.set('code', 'fixture');
            callback.searchParams.set('state', auth.searchParams.get('state'));
            await (await fetch(callback)).text();
        },
        fetch: async (_url, init) => {
            const { scope } = JSON.parse(init.body);
            assert.equal(scope, browserScope);
            return Response.json({ scope, access_token: 'fixture', token_type: 'bearer', expires_in: 3600 });
        }
    });
    const doc = { documentId: 'A'.repeat(16), clientId: 'fixture', clientSecret: 'fixture-secret' };
    const olderSource = { ...old, root: path.join(root, 'older-source') };
    const newerSource = { ...old, root: path.join(root, 'newer-source'), bindingVersion: '2.0.0' };
    const call = (ctx, operation, settings) => services.connection(ctx, 'feishu', operation, settings);
    const read = ['docx:document:readonly', 'offline_access'];
    const write = ['docx:document', 'offline_access'];
    assert.deepEqual((await call(old, 'status')).scopes, read);
    assert.deepEqual((await call(newerSource, 'status')).scopes, write);
    assert.deepEqual((await call(newerSource, 'connect', doc)).scopes, write);
    assert.equal((await call(old, 'status')).canReuse, false);
    await assert.rejects(call(old, 'reuse', doc), /没有可复用/);

    assert.deepEqual((await call(olderSource, 'connect', doc)).scopes, read);
    await call(newerSource, 'connect', doc); // 最近使用的是读写授权。
    assert.equal((await call(old, 'status')).canReuse, true);
    assert.deepEqual((await call(old, 'reuse', doc)).scopes, read);
});
