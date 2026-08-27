'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var hostRouter = require('../src/renderer/host-router');
var initiativeApps = require('../src/renderer/initiative-app-host');

function createFakeDocument() {
    var document = {};
    document.createElement = function () {
        return {
            nodeType: 1,
            ownerDocument: document,
            className: '',
            attributes: {},
            children: [],
            isConnected: true,
            setAttribute: function (name, value) { this.attributes[name] = value; },
            replaceChildren: function () { this.children = Array.from(arguments); },
            remove: function () { this.isConnected = false; }
        };
    };
    return document;
}

test('Host Router 保留旧 Change 链接并序列化 Initiative 稳定路由', function () {
    var legacy = hostRouter.parse('#view=changes&status=attention');
    assert.equal(legacy.view, 'overview');
    assert.equal(legacy.legacyChanges, true);
    var encoded = hostRouter.serialize({
        view: 'initiative',
        detailPanel: 'tasks',
        documentMode: 'rendered',
        typeFilter: 'all',
        statusFilter: 'all',
        providerId: 'openspec-generic-initiative-v1',
        projectId: 'project-0123456789abcdef',
        initiativeId: 'release-readiness',
        appRoute: 'overview',
        artifactId: 'release-summary',
        changeScope: 'independent'
    });
    var restored = hostRouter.parse('#' + encoded);
    assert.equal(restored.view, 'initiative');
    assert.equal(restored.providerId, 'openspec-generic-initiative-v1');
    assert.equal(restored.routeProjectId, 'project-0123456789abcdef');
    assert.equal(restored.initiativeId, 'release-readiness');
    assert.equal(restored.artifactId, 'release-summary');
    assert.equal(hostRouter.parse('#view=not-a-route').view, 'overview');
});

test('Initiative App Host 按 mount/update/dispose 运行并恢复宿主焦点', async function () {
    var fakeDocument = createFakeDocument();
    var root = fakeDocument.createElement('div');
    var calls = [];
    var returnFocus = { isConnected: true, focus: function () { calls.push('focus'); } };
    var registry = new initiativeApps.InitiativeAppRegistry([{
        id: 'fixture-app',
        create: function (options) {
            assert.equal(options.root.attributes['data-initiative-app'], 'fixture-app');
            assert.equal(Object.isFrozen(options.api), true);
            return {
                mount: function (context) { calls.push('mount:' + context.route); },
                update: function (context) { calls.push('update:' + context.route); },
                dispose: function () { calls.push('dispose'); }
            };
        }
    }]);
    var host = new initiativeApps.InitiativeAppHost(root, registry, { load: function () {} });
    assert.equal(await host.mount('fixture-app', { route: 'overview' }, returnFocus), true);
    assert.equal(await host.update({ route: 'details' }), true);
    await host.dispose(true);
    assert.deepEqual(calls, ['mount:overview', 'update:details', 'dispose', 'focus']);
    assert.equal(root.children.length, 0);
});

test('Initiative App Host 丢弃 dispose 后的晚到挂载结果', async function () {
    var fakeDocument = createFakeDocument();
    var root = fakeDocument.createElement('div');
    var resolveCreate;
    var disposed = 0;
    var registry = new initiativeApps.InitiativeAppRegistry([{
        id: 'slow-app',
        create: function () {
            return new Promise(function (resolve) { resolveCreate = resolve; });
        }
    }]);
    var host = new initiativeApps.InitiativeAppHost(root, registry, {});
    var pending = host.mount('slow-app', {}, null);
    await Promise.resolve();
    await host.dispose(false);
    resolveCreate({
        update: function () {},
        dispose: function () { disposed += 1; }
    });
    assert.equal(await pending, false);
    assert.equal(disposed, 1);
    assert.equal(root.children.length, 0);
});

test('Initiative App Host 重复挂载时先清理旧实例并隔离 App 异常', async function () {
    var fakeDocument = createFakeDocument();
    var root = fakeDocument.createElement('div');
    var disposed = 0;
    var registry = new initiativeApps.InitiativeAppRegistry([{
        id: 'stable-app',
        create: function () {
            return {
                update: function () {},
                dispose: function () { disposed += 1; }
            };
        }
    }, {
        id: 'failing-app',
        create: function () { throw new Error('render failed'); }
    }]);
    var host = new initiativeApps.InitiativeAppHost(root, registry, {});
    await host.mount('stable-app', {}, null);
    await host.mount('stable-app', {}, null);
    assert.equal(disposed, 1);
    await assert.rejects(function () { return host.mount('failing-app', {}, null); }, /render failed/);
    assert.equal(disposed, 2);
    assert.equal(root.children.length, 0);
});

test('Initiative App Host 将同步 update 异常转为可捕获拒绝', async function () {
    var fakeDocument = createFakeDocument();
    var root = fakeDocument.createElement('div');
    var registry = new initiativeApps.InitiativeAppRegistry([{
        id: 'failing-update-app',
        create: function () {
            return {
                update: function () { throw new Error('update failed'); },
                dispose: function () {}
            };
        }
    }]);
    var host = new initiativeApps.InitiativeAppHost(root, registry, {});
    await host.mount('failing-update-app', {}, null);
    await assert.rejects(function () { return host.update({}); }, /update failed/);
    await host.dispose(false);
});
