'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var hostRouter = require('../src/renderer/host-router');

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
        appRoute: '/artifacts.html?lens=design#diagram-01',
        artifactId: 'release-summary',
        changeScope: 'independent'
    });
    var restored = hostRouter.parse('#' + encoded);
    assert.equal(restored.view, 'initiative');
    assert.equal(restored.providerId, 'openspec-generic-initiative-v1');
    assert.equal(restored.routeProjectId, 'project-0123456789abcdef');
    assert.equal(restored.initiativeId, 'release-readiness');
    assert.equal(restored.artifactId, 'release-summary');
    assert.equal(restored.appRoute, '/artifacts.html?lens=design#diagram-01');
    assert.equal(hostRouter.parse('#view=not-a-route').view, 'overview');
    assert.equal(hostRouter.parse('#view=initiative&route=' + 'x'.repeat(2049)).appRoute, '');
});
