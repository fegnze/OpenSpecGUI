'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var registerIpc = require('../src/main/ipc').registerIpc;
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;
var WorkbenchService = require('../src/main/workbench-service').WorkbenchService;

test('IPC 只注册白名单操作并校验项目和文档输入', async function () {
    var fixture = await fixtures.createFixtureProject();
    var dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-ipc-'));
    var handlers = new Map();
    var clipboardValue = '';
    var service = new WorkbenchService(new ProjectRegistry(path.join(dataRoot, 'projects.json')), {
        statusProvider: fixtures.inferredStatusProvider
    });
    var ipcMain = { handle: function (name, handler) { handlers.set(name, handler); } };
    try {
        await service.initialize();
        registerIpc({
            ipcMain: ipcMain,
            dialog: { showOpenDialog: function () { return Promise.resolve({ canceled: true, filePaths: [] }); } },
            clipboard: { writeText: function (value) { clipboardValue = value; } },
            service: service,
            windowProvider: function () { return null; }
        });

        assert.deepEqual(Array.from(handlers.keys()).sort(), [
            'attachments:list', 'attachments:read', 'changes:commit-archive', 'changes:discard-archive', 'changes:prepare-archive',
            'clipboard:write', 'documents:read', 'initiatives:load', 'initiatives:read-artifact',
            'projects:add', 'projects:list', 'projects:relink',
            'projects:remove', 'projects:scan', 'projects:select', 'workspace:check-updates',
            'workspace:load', 'workspace:refresh'
        ]);

        var addResult = await handlers.get('projects:add')({}, { path: fixture.root });
        assert.equal(addResult.canceled, false);
        var workspace = await handlers.get('workspace:load')({});
        assert.equal(workspace.snapshot.stats.specs, 1);
        assert.throws(function () {
            handlers.get('documents:read')({}, {
                projectId: workspace.projectId,
                revision: workspace.revision,
                documentId: '../../outside-secret.md'
            });
        }, /文档 ID 格式无效/);

        assert.throws(function () {
            handlers.get('projects:select')({}, { projectId: 'x'.repeat(2 * 1024 * 1024) });
        }, /payload 限制/);
        assert.throws(function () {
            handlers.get('initiatives:load')({}, {
                projectId: workspace.projectId,
                revision: workspace.revision,
                providerId: 'Provider_With_Invalid_Format',
                initiativeId: 'release-readiness'
            });
        }, /Provider ID格式无效/);
        assert.throws(function () {
            handlers.get('clipboard:write')({}, { text: 'x'.repeat(8193) });
        }, /剪贴板文本超过限制/);

        await handlers.get('clipboard:write')({}, { text: 'openspec/specs/core/spec.md' });
        assert.equal(clipboardValue, 'openspec/specs/core/spec.md');
        assert.throws(function () { handlers.get('projects:select')({}, { projectId: '' }); }, /项目 ID无效/);
    } finally {
        await fixture.cleanup();
        await fsPromises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('归档 IPC 校验宿主主框架、计划身份和警告，拒绝任意路径及命令', async function () {
    var handlers = new Map();
    var sender = { mainFrame: {} };
    var event = { sender: sender, senderFrame: sender.mainFrame };
    var calls = [];
    var request = { projectId: '12345678-1234-4123-8123-123456789abc', revision: 3, changeId: 'add-example' };
    registerIpc({
        ipcMain: { handle: function (name, handler) { handlers.set(name, handler); } },
        dialog: {}, clipboard: {},
        windowProvider: function () { return { webContents: sender }; },
        service: {
            prepareArchive: function (value) { calls.push(value); return value; },
            commitArchive: function (value) { calls.push(value); return value; },
            discardArchive: function (value) { return value; }
        }
    });
    assert.throws(function () { handlers.get('changes:prepare-archive')({ sender: {} }, request); }, /来源无效/);
    assert.throws(function () { handlers.get('changes:prepare-archive')({ sender: sender, senderFrame: {} }, request); }, /来源无效/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { path: '/outside' })); }, /未支持字段/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { command: 'anything' })); }, /未支持字段/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { changeId: '../other' })); }, /格式无效/);
    assert.throws(function () { handlers.get('changes:prepare-archive')(event, Object.assign({}, request, { revision: -1 })); }, /revision/);
    handlers.get('changes:prepare-archive')(event, request);
    var commit = { projectId: request.projectId, revision: 3, planId: 'a'.repeat(48), acceptedWarnings: ['tasks:incomplete'] };
    assert.deepEqual(handlers.get('changes:commit-archive')(event, commit), commit);
    assert.throws(function () { handlers.get('changes:commit-archive')(event, Object.assign({}, commit, { content: 'injected' })); }, /未支持字段/);
    assert.throws(function () { handlers.get('changes:commit-archive')(event, Object.assign({}, commit, { acceptedWarnings: ['x'.repeat(70000)] })); }, /payload 限制/);
    assert.throws(function () { handlers.get('changes:commit-archive')(event, Object.assign({}, commit, { planId: '../../plan' })); }, /格式无效/);
    assert.equal(calls.length, 2);
});

test('全局宿主检测只允许主窗口调用，无命令或路径参数', async () => {
    const handlers = new Map();
    const sender = { mainFrame: {} };
    const event = { sender, senderFrame: sender.mainFrame };
    registerIpc({
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        windowProvider: () => ({ webContents: sender }),
        hostIntegration: { inspect: async () => ({ hosts: [] }), verification: async () => ({ projectId: null, hosts: {} }) }
    });
    const inspect = handlers.get('hosts:inspect');
    assert.deepEqual(await inspect(event), { hosts: [] });
    assert.throws(() => inspect(event, { executable: 'fixture' }), /不接受参数/);
    assert.throws(() => inspect({ sender, senderFrame: {} }), /来源无效/);
    const verification = handlers.get('hosts:verification');
    assert.deepEqual(await verification(event), { projectId: null, hosts: {} });
    assert.throws(() => verification(event, { rootPath: '/fixture' }), /不接受参数/);
    assert.throws(() => verification({ sender, senderFrame: {} }), /来源无效/);
});

test('宿主接入和解除只接受主窗口已预览的宿主和计划', async () => {
    const handlers = new Map();
    const sender = { mainFrame: {} };
    const event = { sender, senderFrame: sender.mainFrame };
    registerIpc({
        ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
        windowProvider: () => ({ webContents: sender }),
        hostIntegration: { install: request => request, remove: request => request }
    });
    const request = { host: 'codex', planId: 'b'.repeat(64) };
    for (const action of ['install', 'remove']) {
        const invoke = handlers.get('hosts:' + action);
        assert.deepEqual(invoke(event, request), request);
        assert.throws(() => invoke({ sender, senderFrame: {} }, request), /来源无效/);
        assert.throws(() => invoke(event, { ...request, path: 'somewhere' }), /未支持字段/);
        assert.throws(() => invoke(event, { ...request, host: 'unknown' }), /宿主无效/);
        assert.throws(() => invoke(event, { ...request, planId: null }), /接入计划/);
        assert.throws(() => invoke(event, request, {}), /参数无效/);
    }
});

test('能力和凭据 IPC 只允许工作台主框架执行显式操作', async function () {
    var handlers = new Map();
    var sender = { mainFrame: {} };
    var event = { sender: sender, senderFrame: sender.mainFrame };
    var calls = [];
    registerIpc({
        ipcMain: { handle: function (name, handler) { handlers.set(name, handler); } },
        windowProvider: function () { return { webContents: sender }; },
        capabilities: { requireBinding: async (r,id) => { calls.push([r.projectId,r.host,id]); return r; } },
        projectServices: { connection: async () => 'disconnected' }
    });
    const ctx = { projectId:'12345678-1234-4123-8123-123456789abc',host:'codex' };
    await assert.rejects(handlers.get('connections:connect')({ sender: sender, senderFrame: {} }, { ...ctx,provider:'cv-test1', settings:{ token:'test' } }), /来源无效/);
    await assert.rejects(handlers.get('connections:connect')(event, { ...ctx,provider:'cv-test1', settings:{ token:'test', url:'https:\/\/example.test' } }), /未支持字段/);
    assert.ok(!handlers.has('capabilities:choose-source'));
    assert.throws(function () { handlers.get('capabilities:apply')(event, { projectId:null, planId:'0123', path:'/tmp' }); }, /未支持字段/);
    assert.throws(function () { handlers.get('capabilities:rename')({ sender: sender, senderFrame: {} }, {}); }, /来源无效/);
    assert.throws(function () { handlers.get('capabilities:rename')(event, { id: 'cv-test1', name: '新名称', source: '/tmp' }); }, /未支持字段/);
    await assert.rejects(handlers.get('capabilities:defect-config')(event, { projectId:'12345678-1234-4123-8123-123456789abc', action:'reveal', path:'/tmp' }), /未支持字段/);
    await assert.rejects(handlers.get('connections:status')(event, { provider:'cv-test1' }), /项目 ID无效/);
    assert.equal(await handlers.get('connections:status')(event, { ...ctx,provider:'cv-test1' }), 'disconnected');
    assert.deepEqual(calls, [[ctx.projectId, ctx.host, 'cv-test1'], [ctx.projectId, ctx.host, 'cv-test1']]);
});

test('浏览器授权、立即重试与取消按发送顺序交给同一文档连接', async function () {
    const handlers = new Map();
    const sender = { mainFrame: {} };
    const event = { sender, senderFrame: sender.mainFrame };
    const ctx = { projectId: '12345678-1234-4123-8123-123456789abc', host: 'codex', provider: 'google-drive' };
    const binding = Promise.withResolvers();
    const finished = Promise.withResolvers();
    let checks = 0;
    const operations = [];
    registerIpc({
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        windowProvider: () => ({ webContents: sender }),
        capabilities: { requireBinding: async () => { checks++; return binding.promise; } },
        projectServices: { connection: async (context, provider, operation, settings) => {
            operations.push([operation, settings && Object.keys(settings)]);
            if (operation === 'cancelAuthorization') { finished.resolve(); }
            await finished.promise;
        } }
    });
    const connect = handlers.get('connections:connect');
    const cancel = handlers.get('connections:cancelAuthorization');
    await assert.rejects(cancel(event, { ...ctx, provider: 'cv-test1' }), /文档服务/);
    await assert.rejects(cancel(event, { ...ctx, settings: {} }), /未支持字段/);
    await assert.rejects(connect(event, ctx), /认证参数/);
    await assert.rejects(connect(event, { ...ctx, settings: { clientId: 'fixture' } }), /认证参数/);
    const first = connect(event, { ...ctx, settings: { clientId: 'fixture', clientSecret: 'fixture' } });
    const restart = connect(event, { ...ctx, settings: {} });
    const stop = cancel(event, ctx);
    assert.equal(checks, 1);
    binding.resolve(ctx);
    await Promise.all([first, restart, stop]);
    assert.deepEqual(operations, [
        ['connect', ['clientId', 'clientSecret']], ['connect', []], ['cancelAuthorization', undefined]
    ]);
    assert.equal(checks, 4);
});

test('附件 IPC 仅向宿主主框架开放，拒绝路径、提案类型与越界的分页参数', function () {
    var handlers = new Map();
    var sender = { mainFrame: {} };
    var event = { sender: sender, senderFrame: sender.mainFrame };
    var req = { projectId: '12345678-1234-4123-8123-123456789abc', revision: 2, entityType: 'active', changeId: 'example' };
    var read = { ...req, id: '12345678-1234-4123-8123-123456789abd', offset: 0 };
    registerIpc({ ipcMain: { handle: function (name, handler) { handlers.set(name, handler); } },
        dialog: {}, clipboard: {}, windowProvider: function () { return { webContents: sender }; },
        service: { listAttachments: function (r) { return r; }, readAttachment: function (r) { return r; } } });
    var list = handlers.get('attachments:list');
    var open = handlers.get('attachments:read');
    assert.throws(function () { list({ sender: sender, senderFrame: {} }, req); }, /来源无效/);
    assert.throws(function () { open({ sender: {} }, read); }, /来源无效/);
    assert.throws(function () { list(event, { ...req, changeId: '../other' }); }, /格式无效/);
    assert.throws(function () { list(event, { ...req, entityType: 'spec' }); }, /类型无效/);
    assert.throws(function () { open(event, { ...read, id: '/tmp/report.json' }); }, /格式无效/);
    assert.throws(function () { open(event, { ...read, path: '../report.json' }); }, /未支持字段/);
    assert.throws(function () { open(event, { ...read, offset: -1 }); }, /位置无效/);
    assert.deepEqual(list(event, req), req);
    assert.deepEqual(open(event, read), read);
});
