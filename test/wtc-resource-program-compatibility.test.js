'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var uiFixture = require('./ui-fixture');
var uiHelpers = require('./ui-test-helpers');

var wtcProject = process.env.OPENSPEC_GUI_WTC_PROJECT;

function routeHash(projectId, route) {
    var params = new URLSearchParams();
    params.set('view', 'initiative');
    params.set('provider', 'wtc-resource-program-v1');
    params.set('project', projectId);
    params.set('initiative', 'dh-browser-progressive-resource-reorganization');
    params.set('route', route);
    return '#' + params.toString();
}

test('真实 WTC Resource Program 与专用 App 保持功能等价', {
    timeout: 240000,
    skip: !wtcProject
}, async function () {
    var fixture = await uiFixture.createUiFixture();
    var electronApp;
    try {
        var launched = await uiHelpers.launchWorkbench(fixture, {
            theme: 'dark',
            userDataName: 'wtc-compatibility-user-data'
        });
        electronApp = launched.electronApp;
        var page = launched.page;
        await page.evaluate(function (projectPath) {
            return window.openSpecGUI.projects.add({ paths: [projectPath] });
        }, wtcProject);
        await page.reload();
        await page.waitForSelector('.control-header');
        await page.locator('.primary-nav [data-route="initiatives"]').click();
        await page.waitForSelector('.initiative-row[data-provider-id="wtc-resource-program-v1"]');

        var authority = await page.evaluate(async function () {
            var workspace = await window.openSpecGUI.workspace.load();
            var descriptor = workspace.snapshot.initiatives.find(function (item) {
                return item.providerId === 'wtc-resource-program-v1';
            });
            var details = await window.openSpecGUI.initiatives.load({
                initiativeId: descriptor.id,
                projectId: workspace.projectId,
                providerId: descriptor.providerId,
                revision: workspace.revision
            });
            return {
                details: details,
                projectId: workspace.projectId
            };
        });
        var overview = authority.details.overviewSnapshot;
        var index = authority.details.artifactIndex;
        assert.equal(overview.workstreams.length, 9);
        assert.equal(overview.changes.length, 5);
        assert.equal(overview.gates.length, 10);
        assert.equal(index.diagrams.length, 41);

        await page.locator('.initiative-row[data-provider-id="wtc-resource-program-v1"]').click();
        await page.waitForSelector('[data-initiative-app="resource-program-v1"] .rp-header');
        var archivedChanges = overview.changes.filter(function (change) { return change.archived; });
        assert.ok(archivedChanges.length > 0);
        for (var changeIndex = 0; changeIndex < archivedChanges.length; changeIndex += 1) {
            var change = archivedChanges[changeIndex];
            await page.evaluate(function (hash) { window.location.hash = hash; },
                routeHash(authority.projectId, 'tasks/' + change.changeId + '/all'));
            await page.waitForFunction(function (expected) {
                return document.querySelectorAll('.rp-task-row').length === expected;
            }, change.tasks.total);
            assert.equal(await page.locator('.rp-task-row').count(), change.tasks.total);
            await page.locator('[data-rp-tasks="open"]').click();
            await page.waitForSelector('.rp-empty');
            assert.match(await page.locator('[data-rp-task-results]').textContent(), /所有任务均已完成/);
        }

        await page.evaluate(function (hash) { window.location.hash = hash; },
            routeHash(authority.projectId, 'artifacts/conclusions'));
        await page.waitForSelector('.rp-artifact-browser');
        assert.deepEqual(await page.locator('[data-rp-lens]').evaluateAll(function (items) {
            return items.map(function (item) { return item.getAttribute('data-rp-lens'); });
        }), ['conclusions', 'design', 'evidence', 'all']);

        var failures = [];
        for (var diagramIndex = 0; diagramIndex < index.diagrams.length; diagramIndex += 1) {
            var diagram = index.diagrams[diagramIndex];
            var diagramRoute = 'artifact/all/' + diagram.artifactId + '/diagram/' + diagram.diagramId;
            await page.evaluate(function (hash) { window.location.hash = hash; },
                routeHash(authority.projectId, diagramRoute));
            try {
                await page.waitForFunction(function (diagramId) {
                    var blocks = Array.from(document.querySelectorAll('.rp-diagram'));
                    var block = blocks.find(function (item) {
                        return item.getAttribute('data-rp-diagram-id').toLowerCase() === diagramId.toLowerCase();
                    });
                    return block && block.getAttribute('data-rp-render-state') !== 'rendering' &&
                        block.getAttribute('data-rp-render-state') !== 'idle';
                }, diagram.diagramId, { timeout: 10000 });
                var result = await page.evaluate(function (diagramId) {
                    var blocks = Array.from(document.querySelectorAll('.rp-diagram'));
                    var block = blocks.find(function (item) {
                        return item.getAttribute('data-rp-diagram-id').toLowerCase() === diagramId.toLowerCase();
                    });
                    var svg = block && block.querySelector('svg');
                    var rect = svg && svg.getBoundingClientRect();
                    return {
                        elements: svg ? svg.querySelectorAll('path,rect,line,polygon,circle,ellipse,text').length : 0,
                        height: rect ? rect.height : 0,
                        state: block ? block.getAttribute('data-rp-render-state') : 'missing',
                        width: rect ? rect.width : 0
                    };
                }, diagram.diagramId);
                if (result.state !== 'rendered' || result.width <= 20 || result.height <= 20 || result.elements === 0) {
                    failures.push(diagram.diagramId + ': ' + JSON.stringify(result));
                }
            } catch (error) {
                failures.push(diagram.diagramId + ': ' + error.message);
            }
        }
        assert.deepEqual(failures, []);
        await uiHelpers.assertNoSeriousA11yViolations(page, '真实 WTC Resource Program 图形阅读');
        await uiHelpers.assertNoPageOverflow(page, '真实 WTC Resource Program 图形阅读');
    } finally {
        if (electronApp) { await electronApp.close(); }
        await fixture.cleanup();
    }
});
