'use strict';

var assert = require('node:assert/strict');
var EventEmitter = require('node:events');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var fixtures = require('./fixtures');
var providerModule = require('../src/core/embedded-initiative-app-provider');
var protocolModule = require('../src/main/embedded-initiative-app-protocol');
var hostModule = require('../src/main/embedded-initiative-app-host');
var registerIpc = require('../src/main/ipc').registerIpc;
var workspaceModule = require('../src/core/workspace');
var discoverySchema = require('../docs/contracts/initiative-app-v1.schema.json');

var APP_SCHEMA = providerModule.MANIFEST_SCHEMA_URI;
var INSTANCE_ID = '0123456789abcdef0123456789abcdef';

test('发布的发现文件规范与运行时协议版本一致', function () {
    assert.equal(discoverySchema.$id, APP_SCHEMA);
    assert.equal(discoverySchema.properties.schemaVersion.const, 1);
    assert.equal(discoverySchema.properties.presentation.properties.type.const, 'embedded-app');
});

function nextTurn() {
    return new Promise(function (resolve) { setImmediate(resolve); });
}

function manifest(id, overrides) {
    var values = overrides || {};
    return {
        $schema: values.$schema === undefined ? APP_SCHEMA : values.$schema,
        schemaVersion: values.schemaVersion === undefined ? 1 : values.schemaVersion,
        id: values.id || id,
        kind: values.kind || 'program',
        title: values.title || id,
        summary: values.summary || '独立应用测试清单',
        presentation: {
            type: values.type || 'embedded-app',
            webRoot: values.webRoot || 'dashboard',
            entry: values.entry || 'index.html',
            actions: values.actions === undefined ? { '/_initiative/open-change': 'openspec.open-change' } : values.actions
        }
    };
}

async function writeManifest(fixture, collection, id, values) {
    await fixture.write('openspec/' + collection + '/' + id + '/initiative-app.json', JSON.stringify(manifest(id, values), null, 2) + '\n');
}

async function buildFixtureWorkspace(fixture) {
    return workspaceModule.buildWorkspace({ rootPath: fixture.root }, {
        statusProvider: fixtures.inferredStatusProvider
    });
}

test('embedded App 固定 manifest 发现并只暴露基础 descriptor，静态内容变化使旧快照失效', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixtures.addEmbeddedInitiativeApp(fixture, {
            collection: 'programs',
            id: 'delivery-program',
            html: '<!doctype html><html><body><h1>Original Dashboard</h1><script src="vendor/app.js"></script></body></html>\n'
        });
        var workspace = await buildFixtureWorkspace(fixture);
        var descriptor = workspace.snapshot.initiatives.find(function (item) { return item.id === 'delivery-program'; });
        assert.ok(descriptor);
        assert.equal(descriptor.providerId, providerModule.PROVIDER_ID);
        assert.equal(descriptor.collection, 'programs');
        assert.deepEqual(descriptor.presentation, { mode: 'embedded-app' });
        assert.doesNotMatch(JSON.stringify(descriptor), /webRoot|dashboard\/index|absolutePath|files/);
        assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

        var prepared = await workspace.initiativeRegistry.prepareApp(workspace.roots, descriptor);
        assert.equal(prepared.entry, 'index.html');
        assert.match(prepared.files.get('index.html').toString('utf8'), /Original Dashboard/);
        assert.equal(prepared.files.get('vendor/app.js').toString('utf8'), 'window.__embeddedInitiativeReady = true;\n');

        await fixture.write('openspec/programs/delivery-program/dashboard/vendor/app.js', 'window.__embeddedInitiativeReady = "updated";\n');
        await assert.rejects(function () {
            return workspace.initiativeRegistry.prepareApp(workspace.roots, descriptor);
        }, function (error) { return error.code === 'STALE_INITIATIVE'; });
        var refreshed = await buildFixtureWorkspace(fixture);
        assert.notEqual(refreshed.snapshot.initiatives[0].sourceHash, descriptor.sourceHash);
    } finally {
        await fixture.cleanup();
    }
});

test('embedded App 发现覆盖零项、多 collection、冲突、版本、路径、首页、保留目录与符号链接边界', async function (context) {
    var emptyFixture = await fixtures.createFixtureProject();
    try {
        assert.equal((await buildFixtureWorkspace(emptyFixture)).snapshot.initiatives.length, 0);
    } finally {
        await emptyFixture.cleanup();
    }

    var fixture = await fixtures.createFixtureProject();
    try {
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'valid-program' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'duplicate-program' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'portfolios', id: 'duplicate-program' });

        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'unknown-version' });
        var futureVersion = manifest('unknown-version', { schemaVersion: 9 });
        futureVersion.futureCapability = { mode: 'read-only' };
        await fixture.write('openspec/programs/unknown-version/initiative-app.json', JSON.stringify(futureVersion, null, 2) + '\n');
        await fsPromises.rm(path.join(fixture.root, 'openspec', 'programs', 'unknown-version', 'dashboard'), { recursive: true, force: true });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'unknown-schema' });
        await writeManifest(fixture, 'programs', 'unknown-schema', { $schema: 'https://example.invalid/schema.json' });
        await fsPromises.rm(path.join(fixture.root, 'openspec', 'programs', 'unknown-schema', 'dashboard'), { recursive: true, force: true });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'unknown-presentation' });
        var futurePresentation = manifest('unknown-presentation', { type: 'future-app' });
        delete futurePresentation.presentation.webRoot;
        delete futurePresentation.presentation.entry;
        delete futurePresentation.presentation.actions;
        futurePresentation.presentation.futureOption = true;
        await fixture.write('openspec/programs/unknown-presentation/initiative-app.json', JSON.stringify(futurePresentation, null, 2) + '\n');
        await fsPromises.rm(path.join(fixture.root, 'openspec', 'programs', 'unknown-presentation', 'dashboard'), { recursive: true, force: true });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'missing-schema' });
        var missingSchema = manifest('missing-schema');
        delete missingSchema.$schema;
        await fixture.write('openspec/programs/missing-schema/initiative-app.json', JSON.stringify(missingSchema, null, 2) + '\n');
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'path-escape' });
        await writeManifest(fixture, 'programs', 'path-escape', { webRoot: '../dashboard' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'future-path-escape' });
        await writeManifest(fixture, 'programs', 'future-path-escape', { schemaVersion: 9, webRoot: '../dashboard' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'missing-identity' });
        var missingIdentity = manifest('missing-identity');
        delete missingIdentity.title;
        await fixture.write('openspec/programs/missing-identity/initiative-app.json', JSON.stringify(missingIdentity, null, 2) + '\n');
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'missing-entry' });
        await writeManifest(fixture, 'programs', 'missing-entry', { entry: 'missing.html' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'archive', id: 'reserved-program' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: '.hidden', id: 'hidden-program' });

        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'linked-root' });
        var linkedRoot = path.join(fixture.root, 'openspec', 'programs', 'linked-root', 'dashboard');
        var outsideRoot = path.join(fixture.root, 'outside-dashboard');
        await fsPromises.rm(linkedRoot, { recursive: true, force: true });
        await fsPromises.mkdir(outsideRoot, { recursive: true });
        await fsPromises.writeFile(path.join(outsideRoot, 'index.html'), '<h1>outside</h1>\n', 'utf8');
        try {
            await fsPromises.symlink(outsideRoot, linkedRoot, 'dir');
        } catch (error) {
            context.diagnostic('当前文件系统不允许创建目录符号链接：' + error.message);
        }

        var workspace = await buildFixtureWorkspace(fixture);
        assert.deepEqual(workspace.snapshot.initiatives.map(function (item) { return item.id; }), [
            'future-path-escape', 'unknown-presentation', 'unknown-schema', 'unknown-version', 'valid-program'
        ]);
        assert.ok(workspace.snapshot.initiativeDiagnostics.some(function (item) { return item.code === 'DUPLICATE_INITIATIVE_ID'; }));
        ['future-path-escape', 'unknown-version', 'unknown-schema', 'unknown-presentation'].forEach(function (id) {
            var descriptor = workspace.snapshot.initiatives.find(function (item) { return item.id === id; });
            assert.equal(descriptor.health, 'attention');
            assert.ok(descriptor.diagnostics.some(function (item) {
                return item.code === 'UNSUPPORTED_EMBEDDED_INITIATIVE_APP' && item.title === '不支持此应用';
            }));
            assert.ok(workspace.snapshot.initiativeDiagnostics.some(function (item) {
                return item.code === 'UNSUPPORTED_EMBEDDED_INITIATIVE_APP' && item.initiativeId === id;
            }));
        });
        ['missing-schema', 'path-escape', 'missing-identity', 'missing-entry'].forEach(function (id) {
            assert.ok(workspace.snapshot.initiativeDiagnostics.some(function (item) {
                return item.code === 'INVALID_EMBEDDED_INITIATIVE_APP' && item.initiativeId === id;
            }), id + ' 应产生受控诊断');
        });
        var unsupportedDescriptor = workspace.snapshot.initiatives.find(function (item) { return item.id === 'unknown-version'; });
        await assert.rejects(function () {
            return workspace.initiativeRegistry.prepareApp(workspace.roots, unsupportedDescriptor);
        }, function (error) { return error.code === 'UNSUPPORTED_INITIATIVE_APP'; });
        assert.equal(workspace.snapshot.initiatives.some(function (item) { return item.id === 'reserved-program' || item.id === 'hidden-program'; }), false);
        assert.doesNotMatch(JSON.stringify(workspace.snapshot.initiativeDiagnostics), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
        await fixture.cleanup();
    }
});

test('MAX_APPS 只统计固定位置存在 manifest 的候选', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        var directories = [];
        for (var index = 0; index < providerModule.MAX_APPS + 1; index += 1) {
            directories.push(fsPromises.mkdir(path.join(fixture.root, 'openspec', 'programs', 'plain-' + String(index).padStart(3, '0')), { recursive: true }));
        }
        await Promise.all(directories);
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'valid-after-plain-directories' });
        var workspace = await buildFixtureWorkspace(fixture);
        assert.deepEqual(workspace.snapshot.initiatives.map(function (item) { return item.id; }), ['valid-after-plain-directories']);
        assert.equal(workspace.snapshot.initiativeDiagnostics.length, 0);
    } finally {
        await fixture.cleanup();
    }
});

test('readRegularFile 按实际读取字节限制 stat 后增长并返回实际大小', async function () {
    var fixture = await fixtures.createFixtureProject();
    var target = await fixture.write('bounded/file.bin', 'x');
    try {
        var fixtureRealRoot = await fsPromises.realpath(fixture.root);
        target = await fsPromises.realpath(target);
        var targetStat = await fsPromises.stat(target);
        var closed = false;
        var chunks = [Buffer.from('abcd'), Buffer.from('e')];
        var readIndex = 0;
        var growingHandle = {
            stat: function () { return Promise.resolve({ dev: targetStat.dev, ino: targetStat.ino, size: 1, isFile: function () { return true; } }); },
            read: function (buffer) {
                var chunk = chunks[readIndex] || Buffer.alloc(0);
                readIndex += 1;
                chunk.copy(buffer);
                return Promise.resolve({ bytesRead: chunk.byteLength });
            },
            close: function () { closed = true; return Promise.resolve(); }
        };
        await assert.rejects(function () {
            return providerModule.readRegularFile(fixtureRealRoot, target, 4, '测试文件', function () {
                return Promise.resolve(growingHandle);
            });
        }, /超过读取限制/);
        assert.equal(readIndex, 2);
        assert.equal(closed, true);

        var shrinkingRead = false;
        var shrinkingClosed = false;
        var shrinkingHandle = {
            stat: function () { return Promise.resolve({ dev: targetStat.dev, ino: targetStat.ino, size: 4, isFile: function () { return true; } }); },
            read: function (buffer) {
                if (shrinkingRead) { return Promise.resolve({ bytesRead: 0 }); }
                shrinkingRead = true;
                Buffer.from('xy').copy(buffer);
                return Promise.resolve({ bytesRead: 2 });
            },
            close: function () { shrinkingClosed = true; return Promise.resolve(); }
        };
        var opened = await providerModule.readRegularFile(fixtureRealRoot, target, 4, '测试文件', function () {
            return Promise.resolve(shrinkingHandle);
        });
        assert.equal(opened.size, 2);
        assert.equal(opened.content.toString('utf8'), 'xy');
        assert.equal(shrinkingClosed, true);
    } finally {
        await fixture.cleanup();
    }
});

test('readRegularFile 打开后校验 fd 身份并拒绝路径竞态指向根外对象', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        var allowedRoot = await fixture.write('allowed/nested/file.txt', 'allowed');
        var outsideTarget = await fixture.write('outside/file.txt', 'outside');
        allowedRoot = await fsPromises.realpath(path.join(path.dirname(allowedRoot), '..'));
        var allowedTarget = await fsPromises.realpath(path.join(allowedRoot, 'nested', 'file.txt'));
        outsideTarget = await fsPromises.realpath(outsideTarget);
        var closed = false;
        await assert.rejects(function () {
            return providerModule.readRegularFile(allowedRoot, allowedTarget, 64, '测试文件', async function () {
                var handle = await fsPromises.open(outsideTarget, 'r');
                var originalClose = handle.close.bind(handle);
                handle.close = function () {
                    closed = true;
                    return originalClose();
                };
                return handle;
            });
        }, /打开文件与已验证路径不一致/);
        assert.equal(closed, true);
    } finally {
        await fixture.cleanup();
    }
});

test('fingerprint 与紧随其后的 discover 复用扫描且多个 App 共享项目级预算', async function () {
    var fixture = await fixtures.createFixtureProject();
    try {
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'alpha-program' });
        await fixtures.addEmbeddedInitiativeApp(fixture, { collection: 'programs', id: 'beta-program' });
        var roots = await workspaceModule.resolveProjectContext({ rootPath: fixture.root });
        var provider = new providerModule.EmbeddedInitiativeAppProvider();
        var originalScan = provider.scanProject;
        var scanCount = 0;
        provider.scanProject = function (context, budget) {
            scanCount += 1;
            return originalScan(context, budget);
        };
        await provider.fingerprint(roots);
        var discovery = await provider.discover(roots);
        assert.equal(scanCount, 1);
        assert.deepEqual(discovery.initiatives.map(function (item) { return item.id; }), ['alpha-program', 'beta-program']);
        await nextTurn();
        await provider.fingerprint(roots);
        assert.equal(scanCount, 2, '独立的下一轮 fingerprint 必须重新扫描');

        var alphaRoot = path.join(fixture.root, 'openspec', 'programs', 'alpha-program', 'dashboard');
        var alphaBytes = (await fsPromises.stat(path.join(alphaRoot, 'index.html'))).size +
            (await fsPromises.stat(path.join(alphaRoot, 'vendor', 'app.js'))).size;
        var limits = [
            { maxFiles: 3 },
            { maxScanEntries: 4 },
            { maxTotalBytes: alphaBytes }
        ];
        for (var limitIndex = 0; limitIndex < limits.length; limitIndex += 1) {
            var values = limits[limitIndex];
            var limitedProvider = new providerModule.EmbeddedInitiativeAppProvider({
                createScanBudget: function () { return providerModule.createScanBudget(values); }
            });
            var limited = await limitedProvider.discover(roots);
            assert.deepEqual(limited.initiatives.map(function (item) { return item.id; }), ['alpha-program']);
            assert.ok(limited.diagnostics.some(function (item) {
                return item.code === 'INVALID_EMBEDDED_INITIATIVE_APP' && item.initiativeId === 'beta-program';
            }));
            assert.equal(limited.authoritative, false);
        }
    } finally {
        await fixture.cleanup();
    }
});

test('custom protocol 严格解码静态路径并返回固定安全 header 与 MIME', async function () {
    assert.equal(protocolModule.decodeStaticPath('openspec-initiative-app://' + INSTANCE_ID + '/assets/app.js?x=1'), 'assets/app.js');
    ['/../secret.txt', '/%2e%2e/secret.txt', '/%2Fetc/passwd', '/bad%zz', '/a%5cb', '/a//b'].forEach(function (suffix) {
        assert.throws(function () {
            protocolModule.decodeStaticPath('openspec-initiative-app://' + INSTANCE_ID + suffix);
        });
    });

    var protocol = new protocolModule.EmbeddedInitiativeAppProtocol({
        service: { resolveChangeDirectory: function () { throw new Error('unexpected action'); } },
        shell: { showItemInFolder: function () { throw new Error('unexpected action'); } }
    });
    protocol.register({
        id: INSTANCE_ID,
        projectId: 'project',
        revision: 3,
        files: new Map([
            ['index.html', Buffer.from('<h1>dashboard</h1>')],
            ['vendor/app.js', Buffer.from('window.ready=true;')],
            ['payload.bin', Buffer.from('secret')]
        ]),
        actions: {}
    });
    var response = await protocol.handle(new Request('openspec-initiative-app://' + INSTANCE_ID + '/index.html'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /dashboard/);

    response = await protocol.handle(new Request('openspec-initiative-app://' + INSTANCE_ID + '/vendor/app.js', { method: 'HEAD' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await response.text(), '');
    assert.equal((await protocol.handle({ url: 'openspec-initiative-app://' + INSTANCE_ID + '/%2e%2e/secret.txt', method: 'GET' })).status, 404);
    assert.equal((await protocol.handle(new Request('openspec-initiative-app://' + INSTANCE_ID + '/payload.bin'))).status, 415);
    assert.equal((await protocol.handle(new Request('file:///etc/passwd'))).status, 404);
    var invalidAuthorities = [
        'openspec-initiative-app://' + INSTANCE_ID + ':8443/index.html',
        'openspec-initiative-app://user@' + INSTANCE_ID + '/index.html',
        'openspec-initiative-app://' + INSTANCE_ID.toUpperCase() + '/index.html',
        'openspec-initiative-app://' + INSTANCE_ID + './index.html'
    ];
    for (var authorityIndex = 0; authorityIndex < invalidAuthorities.length; authorityIndex += 1) {
        assert.equal((await protocol.handle({ url: invalidAuthorities[authorityIndex], method: 'GET' })).status, 404);
    }
});

test('custom protocol 动作只接受声明路径、有界 JSON 与当前 Change', async function () {
    var resolved = [];
    var shown = [];
    var service = {
        resolveChangeDirectory: function (request) {
            resolved.push(request);
            if (request.changeId === 'stale-change') {
                var error = new Error('stale');
                error.code = 'STALE_WORKSPACE';
                return Promise.reject(error);
            }
            return Promise.resolve('/safe/change/' + request.changeId);
        }
    };
    var protocol = new protocolModule.EmbeddedInitiativeAppProtocol({
        service: service,
        shell: { showItemInFolder: function (target) { shown.push(target); } }
    });
    var actionPath = '/_initiative/open-change';
    var actionUrl = 'openspec-initiative-app://' + INSTANCE_ID + actionPath;
    protocol.register({
        id: INSTANCE_ID,
        projectId: 'current-project',
        revision: 17,
        files: new Map(),
        actions: { '/_initiative/open-change': 'openspec.open-change' }
    });

    function actionRequest(payload, headers) {
        return new Request(actionUrl, {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
            body: typeof payload === 'string' ? payload : JSON.stringify(payload)
        });
    }

    var response = await protocol.handle(actionRequest({ changeId: 'add-feature' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(resolved[0], { projectId: 'current-project', revision: 17, changeId: 'add-feature' });
    assert.deepEqual(shown, ['/safe/change/add-feature']);

    response = await protocol.handle(actionRequest('{bad json'));
    assert.equal(response.status, 400);
    response = await protocol.handle(actionRequest({ changeId: '../outside' }));
    assert.equal(response.status, 400);
    response = await protocol.handle(actionRequest('x'.repeat(protocolModule.MAX_ACTION_BODY_BYTES + 1)));
    assert.equal(response.status, 400);
    assert.equal((await protocol.handle(new Request(actionUrl))).status, 405);
    response = await protocol.handle(actionRequest({ changeId: 'stale-change' }));
    assert.equal(response.status, 409);
    assert.equal(resolved.length, 2);
    assert.equal(shown.length, 1);

    var releaseResolution;
    var resolutionStarted = new Promise(function (resolve) {
        service.resolveChangeDirectory = function () {
            resolve();
            return new Promise(function (finish) { releaseResolution = finish; });
        };
    });
    var pendingResponse = protocol.handle(actionRequest({ changeId: 'add-feature' }));
    await resolutionStarted;
    protocol.unregister(INSTANCE_ID);
    releaseResolution('/safe/change/add-feature');
    response = await pendingResponse;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'STALE_APP_INSTANCE' });
    assert.equal(shown.length, 1);
});

function FakeWebContents() {
    EventEmitter.call(this);
    this.closed = false;
    this.focused = false;
    this.windowOpenHandler = null;
}
FakeWebContents.prototype = Object.create(EventEmitter.prototype);
FakeWebContents.prototype.constructor = FakeWebContents;
FakeWebContents.prototype.setWindowOpenHandler = function (handler) { this.windowOpenHandler = handler; };
FakeWebContents.prototype.loadURL = function (target) {
    this.url = FakeWebContents.locationTransform ? FakeWebContents.locationTransform(target) : target;
    this.emit('did-navigate', {}, this.url);
    return Promise.resolve();
};
FakeWebContents.prototype.close = function () { this.closed = true; };
FakeWebContents.prototype.focus = function () { this.focused = true; this.emit('focus'); };
FakeWebContents.prototype.getURL = function () { return this.url || ''; };
FakeWebContents.prototype.isFocused = function () { return this.focused; };
FakeWebContents.prototype.isDestroyed = function () { return this.closed; };
FakeWebContents.locationTransform = null;

function FakeWebContentsView(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.bounds = null;
    FakeWebContentsView.instances.push(this);
}
FakeWebContentsView.instances = [];
FakeWebContentsView.prototype.setVisible = function (visible) { this.visible = visible; };
FakeWebContentsView.prototype.setBounds = function (bounds) { this.bounds = bounds; };

function FakeSession() {
    EventEmitter.call(this);
    var self = this;
    this.protocol = {
        handled: null,
        unhandled: null,
        handle: function (scheme, handler) { self.protocol.handled = { scheme: scheme, handler: handler }; return Promise.resolve(); },
        unhandle: function (scheme) { self.protocol.unhandled = scheme; return Promise.resolve(); }
    };
    this.webRequest = {
        onBeforeRequest: function (filter, callback) {
            if (filter === null) {
                self.requestFilter = null;
                self.beforeRequest = null;
                return;
            }
            self.requestFilter = filter;
            self.beforeRequest = callback;
        }
    };
}
FakeSession.prototype = Object.create(EventEmitter.prototype);
FakeSession.prototype.constructor = FakeSession;
FakeSession.prototype.setPermissionCheckHandler = function (handler) { this.permissionCheck = handler; };
FakeSession.prototype.setPermissionRequestHandler = function (handler) { this.permissionRequest = handler; };

function createHostHarness(serviceOverrides) {
    var appSessions = [];
    var sent = [];
    var attached = [];
    var detached = [];
    var window = {
        focused: false,
        isDestroyed: function () { return false; },
        focus: function () { this.focused = true; },
        getContentSize: function () { return [800, 600]; },
        webContents: {
            focused: false,
            focus: function () { this.focused = true; },
            send: function (channel, payload) { sent.push({ channel: channel, payload: payload }); }
        },
        contentView: {
            addChildView: function (view) { attached.push(view); },
            removeChildView: function (view) { detached.push(view); }
        }
    };
    var service = Object.assign({
        prepareEmbeddedInitiativeApp: function () {
            return Promise.resolve({
                entry: 'index.html',
                manifestHash: 'manifest-hash',
                sourceHash: 'source-hash',
                files: new Map([['index.html', Buffer.from('<h1>app</h1>')]]),
                actions: {}
            });
        },
        resolveChangeDirectory: function () { return Promise.resolve('/safe/change'); }
    }, serviceOverrides || {});
    var appProtocol = new protocolModule.EmbeddedInitiativeAppProtocol({ service: service, shell: { showItemInFolder: function () {} } });
    var host = new hostModule.EmbeddedInitiativeAppHost({
        WebContentsView: FakeWebContentsView,
        session: {
            fromPartition: function (partition, options) {
                var appSession = new FakeSession();
                appSession.partition = partition;
                appSession.options = options;
                appSessions.push(appSession);
                return appSession;
            }
        },
        service: service,
        protocol: appProtocol,
        windowProvider: function () { return window; }
    });
    return { appProtocol: appProtocol, appSessions: appSessions, attached: attached, detached: detached, host: host, sent: sent, window: window };
}

function mountRequest(location) {
    return {
        projectId: '11111111-1111-4111-8111-111111111111',
        revision: 4,
        providerId: providerModule.PROVIDER_ID,
        initiativeId: 'delivery-program',
        location: location || ''
    };
}

test('WebContentsView 宿主使用隔离 session、固定安全配置、精确边界并完整释放资源', async function () {
    FakeWebContentsView.instances.length = 0;
    var harness = createHostHarness();
    FakeWebContents.locationTransform = function (target) {
        return target.replace('/index.html?lens=design#current', '/details.html?lens=evidence#actual');
    };
    var mounted = await harness.host.mount(mountRequest('/index.html?lens=design#current'));
    FakeWebContents.locationTransform = null;
    var instance = harness.host.current;
    var view = instance.view;
    var appSession = harness.appSessions[0];
    assert.match(mounted.instanceId, protocolModule.INSTANCE_ID_PATTERN);
    assert.equal(mounted.location, '/details.html?lens=evidence#actual');
    assert.match(appSession.partition, /^openspec-initiative-app:[a-f0-9]{32}$/);
    assert.deepEqual(appSession.options, { cache: false });
    assert.equal(view.options.webPreferences.session, appSession);
    assert.equal(view.options.webPreferences.contextIsolation, true);
    assert.equal(view.options.webPreferences.sandbox, true);
    assert.equal(view.options.webPreferences.nodeIntegration, false);
    assert.equal(view.options.webPreferences.nodeIntegrationInWorker, false);
    assert.equal(view.options.webPreferences.webviewTag, false);
    assert.equal(view.options.webPreferences.webSecurity, true);
    assert.equal(view.options.webPreferences.preload, undefined);
    assert.equal(appSession.permissionCheck(), false);
    assert.deepEqual(view.webContents.windowOpenHandler({ url: 'https://example.com' }), { action: 'deny' });

    var externalCanceled;
    appSession.beforeRequest({ url: 'https://example.com/tracker.js' }, function (result) { externalCanceled = result.cancel; });
    assert.equal(externalCanceled, true);
    var internalCanceled;
    appSession.beforeRequest({ url: 'openspec-initiative-app://' + mounted.instanceId + '/index.html' }, function (result) { internalCanceled = result.cancel; });
    assert.equal(internalCanceled, false);
    var prevented = false;
    view.webContents.emit('will-navigate', { preventDefault: function () { prevented = true; } }, 'file:///etc/passwd');
    assert.equal(prevented, true);
    assert.equal(hostModule.sameInstanceOrigin(instance, 'openspec-initiative-app://' + mounted.instanceId + ':8443/index.html'), false);
    assert.equal(hostModule.sameInstanceOrigin(instance, 'openspec-initiative-app://user@' + mounted.instanceId + '/index.html'), false);
    assert.equal(hostModule.sameInstanceOrigin(instance, 'openspec-initiative-app://' + mounted.instanceId.toUpperCase() + '/index.html'), false);

    var applied = harness.host.updateBounds({
        instanceId: mounted.instanceId,
        bounds: { x: -40, y: 10, width: 900, height: 900 },
        visible: true
    });
    assert.deepEqual(applied, { applied: true, bounds: { x: 0, y: 10, width: 800, height: 590 } });
    assert.equal(view.visible, true);
    assert.deepEqual(hostModule.clampBounds({ x: 790, y: 590, width: 100, height: 100 }, [800, 600]), { x: 790, y: 590, width: 10, height: 10 });
    assert.equal(hostModule.safeRelativeLocation('/details.html?lens=design#current'), '/details.html?lens=design#current');
    ['/../secret', '/%2e%2e/secret', '/bad%zz', '/a%2fb', '/a\\b', 'https://example.com/'].forEach(function (route) {
        assert.equal(hostModule.safeRelativeLocation(route), '');
    });
    assert.equal(hostModule.safeRelativeLocation('/#' + 'x'.repeat(2046)).length, 2048);
    assert.equal(hostModule.safeRelativeLocation('/#' + 'x'.repeat(2047)), '');

    var locationEventCount = harness.sent.filter(function (event) { return event.payload.type === 'location'; }).length;
    view.webContents.emit('did-navigate-in-page', {}, 'openspec-initiative-app://' + mounted.instanceId + '/details.html#saved');
    assert.equal(harness.sent.filter(function (event) { return event.payload.type === 'location'; }).length, locationEventCount + 1);
    assert.equal(harness.sent[harness.sent.length - 1].payload.location, '/details.html#saved');
    view.webContents.emit('did-navigate-in-page', {}, 'openspec-initiative-app://' + mounted.instanceId + '/#' + 'x'.repeat(100000));
    assert.equal(harness.sent.filter(function (event) { return event.payload.type === 'location'; }).length, locationEventCount + 1);

    assert.deepEqual(harness.host.setVisible({ instanceId: mounted.instanceId, visible: false }), { applied: true });
    assert.equal(view.visible, false);
    assert.deepEqual(harness.host.focus(mounted.instanceId), { applied: false });
    harness.host.setVisible({ instanceId: mounted.instanceId, visible: true });
    assert.deepEqual(harness.host.focus(mounted.instanceId), { applied: true });
    assert.equal(harness.window.focused, true);
    assert.equal(view.webContents.focused, true);
    view.webContents.focused = false;
    view.webContents.emit('blur');
    var keyPrevented = false;
    view.webContents.emit('before-input-event', { preventDefault: function () { keyPrevented = true; } }, {
        type: 'keyDown', key: 'F6', alt: false, control: false, meta: false, shift: false
    });
    assert.equal(keyPrevented, true);
    assert.equal(harness.window.webContents.focused, true);
    assert.ok(harness.sent.some(function (event) { return event.payload.type === 'return-focus'; }));
    var files = instance.files;
    assert.deepEqual(await harness.host.dispose(mounted.instanceId), { disposed: true });
    assert.equal(harness.host.current, null);
    assert.equal(view.webContents.closed, true);
    assert.equal(appSession.protocol.unhandled, protocolModule.SCHEME);
    assert.equal(appSession.permissionCheck, null);
    assert.equal(appSession.permissionRequest, null);
    assert.equal(appSession.listenerCount('will-download'), 0);
    assert.equal(appSession.beforeRequest, null);
    assert.equal(harness.appProtocol.instances.size, 0);
    assert.equal(files.size, 0);
    assert.deepEqual(harness.attached, [view]);
    assert.deepEqual(harness.detached, [view]);
});

test('WebContentsView 宿主拒绝旧 mount 结果并在 crash 后收敛到单一错误边界', async function () {
    var resolveFirst;
    var startedFirst;
    var firstStarted = new Promise(function (resolve) { startedFirst = resolve; });
    var calls = 0;
    var harness = createHostHarness({
        prepareEmbeddedInitiativeApp: function () {
            calls += 1;
            if (calls === 1) {
                startedFirst();
                return new Promise(function (resolve) { resolveFirst = resolve; });
            }
            return Promise.resolve({
                entry: 'index.html', manifestHash: 'second', sourceHash: 'second',
                files: new Map([['index.html', Buffer.from('second')]]), actions: {}
            });
        }
    });
    var firstMount = harness.host.mount(mountRequest('/first.html'));
    await firstStarted;
    var secondMount = await harness.host.mount(mountRequest('/index.html'));
    resolveFirst({
        entry: 'index.html', manifestHash: 'first', sourceHash: 'first',
        files: new Map([['index.html', Buffer.from('first')]]), actions: {}
    });
    await assert.rejects(firstMount, function (error) { return error.code === 'STALE_APP_MOUNT'; });
    assert.equal(harness.host.current.id, secondMount.instanceId);

    var currentView = harness.host.current.view;
    currentView.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await nextTurn();
    assert.equal(harness.host.current, null);
    assert.equal(currentView.webContents.closed, true);
    assert.ok(harness.sent.some(function (event) {
        return event.payload.type === 'error' && event.payload.code === 'RENDER_PROCESS_GONE';
    }));
});

test('embedded App IPC 只接受主 BrowserWindow sender 并继续校验 instance 与 bounds', async function () {
    var handlers = new Map();
    var mainSender = {};
    var calls = [];
    var service = {
        listProjects: function () {}, addProjects: function () {}, scanProjects: function () {}, relinkProject: function () {},
        removeProject: function () {}, selectProject: function () {}, loadWorkspace: function () {}, checkForUpdates: function () {},
        readDocument: function () {}, loadInitiative: function () {}, readInitiativeArtifact: function () {}
    };
    registerIpc({
        ipcMain: { handle: function (name, handler) { handlers.set(name, handler); } },
        dialog: { showOpenDialog: function () { return Promise.resolve({ canceled: true, filePaths: [] }); } },
        clipboard: { writeText: function () {} },
        service: service,
        embeddedAppHost: {
            mount: function (request) { calls.push({ method: 'mount', request: request }); return { instanceId: INSTANCE_ID }; },
            updateBounds: function (request) { calls.push({ method: 'bounds', request: request }); return { applied: true }; },
            setVisible: function (request) { calls.push({ method: 'visible', request: request }); return { applied: true }; },
            focus: function (instanceId) { calls.push({ method: 'focus', instanceId: instanceId }); return { applied: true }; },
            dispose: function (instanceId) { calls.push({ method: 'dispose', instanceId: instanceId }); return { disposed: true }; }
        },
        windowProvider: function () { return { isDestroyed: function () { return false; }, webContents: mainSender }; }
    });
    assert.throws(function () {
        handlers.get('initiative-app:mount')({ sender: {} }, mountRequest());
    }, /IPC 调用来源无效/);
    handlers.get('initiative-app:mount')({ sender: mainSender }, mountRequest('/index.html'));
    handlers.get('initiative-app:focus')({ sender: mainSender }, { instanceId: INSTANCE_ID });
    assert.throws(function () {
        handlers.get('initiative-app:update-bounds')({ sender: mainSender }, {
            instanceId: INSTANCE_ID,
            bounds: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 },
            visible: true
        });
    }, /应用边界无效/);
    handlers.get('initiative-app:dispose')({ sender: mainSender }, { instanceId: INSTANCE_ID });
    assert.deepEqual(calls.map(function (entry) { return entry.method; }), ['mount', 'focus', 'dispose']);
});
