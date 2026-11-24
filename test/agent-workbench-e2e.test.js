'use strict';

var assert = require('node:assert/strict');
var execFile = require('node:util').promisify(require('node:child_process').execFile);
var fs = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var createArchiveFixture = require('./archive-fixture').createArchiveFixture;
var ui = require('./ui-test-helpers');

async function switchProject(page, project) {
    await page.locator('#project-picker-button').click();
    await page.locator('[data-project-option="' + project.id + '"]').click();
    await page.locator('[data-project-option="' + project.id + '"][aria-selected="true"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#project-picker-name').textContent(), project.name);
}

function navigation(page, route) {
    return page.locator('.sidebar [data-route="' + route + '"]');
}

async function showPage(page, route, title) {
    var entry = navigation(page, route);
    assert.equal(await entry.getAttribute('aria-label'), title);
    await entry.click();
    await page.locator('.sidebar [data-route="' + route + '"][aria-current="page"]').waitFor();
}

async function waitForView(page, expectedView) {
    await page.waitForFunction(function (view) {
        return new URLSearchParams(window.location.hash.slice(1)).get('view') === view;
    }, expectedView);
}

test('Electron 按项目恢复页面，限制 OpenSpec 深链接和归档，并保留全局页面', { timeout: 90000 }, async function () {
    var fixture = await createArchiveFixture();
    var launched;
    try {
        var gitRoot = path.join(fixture.base, 'plain-git');
        await execFile('git', ['init', '--quiet', gitRoot]);
        launched = await ui.launchWorkbench({ root: fixture.base, fixedNow: '' }, { cli: fixture.cli });
        var page = launched.page;
        await page.evaluate(function () { window.location.hash = 'view=capabilities'; });
        await waitForView(page, 'binding');
        await page.getByRole('heading', { name: '请先选择项目', exact: true }).waitFor();
        await page.evaluate(function () { history.replaceState(null, '', location.pathname); });
        var projects = await page.evaluate(async function (paths) {
            var result = await window.openSpecGUI.projects.add({ paths: paths });
            return result.added;
        }, [gitRoot, fixture.root]);
        assert.equal(projects.length, 2);
        var gitProject = projects.find(function (project) { return project.name === 'plain-git'; });
        var specProject = projects.find(function (project) { return project.id !== gitProject.id; });

        await page.reload();
        await page.locator('.control-header').waitFor();
        assert.equal(await page.locator('#project-picker-name').textContent(), specProject.name);
        assert.equal(await navigation(page, 'overview').getAttribute('aria-current'), 'page');
        var activeChange = page.locator('button[data-entity-type="active"][data-entity-id="' + fixture.changeId + '"]');
        await activeChange.click();
        await page.locator('[data-panel="documents"]').click();
        await page.locator('.markdown-body').waitFor();
        var legacyHash = await page.evaluate(function () { return window.location.hash; });
        assert.match(legacyHash, /view=detail/);

        // 已移除工作树的链接可能引用当前工作树也存在的提案 ID。
        await page.evaluate(function (hash) {
            var params = new URLSearchParams(hash.slice(1));
            params.set('project', 'removed-worktree');
            params.set('task', '1.1');
            window.location.hash = params.toString();
        }, legacyHash);
        await waitForView(page, 'overview');
        await page.locator('.control-header').waitFor();
        var safeHash = new URLSearchParams(new URL(page.url()).hash.slice(1));
        assert.equal(safeHash.get('project'), specProject.id);
        for (var field of ['id', 'doc', 'panel', 'task', 'q']) { assert.equal(safeHash.has(field), false, field); }
        assert.equal(await page.locator('.markdown-body').count(), 0);

        // 通过同一渲染进程的 IPC 保留未提交计划，项目选择器仍可切换。
        var plan = await page.evaluate(async function (changeId) {
            var bridge = window.openSpecGUI;
            var workspace = await bridge.workspace.load();
            return bridge.changes.prepareArchive({ projectId: workspace.projectId, revision: workspace.revision, changeId: changeId });
        }, fixture.changeId);
        assert.match(plan.planId, /^[a-f0-9]{48}$/);
        await showPage(page, 'specs', '规范');

        await switchProject(page, gitProject);
        await waitForView(page, 'binding');
        await page.getByRole('heading', { name: '能力绑定', exact: true }).waitFor();
        for (var route of ['overview', 'initiatives', 'specs', 'archives']) {
            assert.equal(await navigation(page, route).isVisible(), false, route + ' 在普通项目中仍然可见');
        }
        await assert.rejects(page.evaluate(function (preview) {
            return window.openSpecGUI.changes.commitArchive({
                projectId: preview.projectId,
                revision: preview.revision,
                planId: preview.planId,
                acceptedWarnings: preview.warnings.map(function (warning) { return warning.id; })
            });
        }, plan), /项目已切换|工作区已切换|预览已失效/);
        assert.equal(await fs.readFile(path.join(fixture.root, 'openspec/specs/example/spec.md'), 'utf8'), fixture.main);
        await fs.stat(path.join(fixture.root, fixture.source, 'proposal.md'));

        await page.evaluate(function (link) {
            var params = new URLSearchParams(link.hash.slice(1));
            params.set('project', link.projectId);
            window.location.hash = params.toString();
        }, { hash: legacyHash, projectId: gitProject.id });
        await waitForView(page, 'binding');
        await page.getByRole('heading', { name: '能力绑定', exact: true }).waitFor();
        assert.equal(await page.locator('#project-picker-name').textContent(), gitProject.name);
        assert.equal(await page.locator('.markdown-body').count(), 0);
        assert.equal(await page.locator('[data-action="archive-change"]').count(), 0);

        await showPage(page, 'hook-records', '钩子记录');
        await switchProject(page, specProject);
        await waitForView(page, 'specs');
        await navigation(page, 'specs').waitFor();
        await switchProject(page, gitProject);
        await waitForView(page, 'hook-records');
        await page.getByRole('heading', { name: '钩子记录', exact: true }).waitFor();

        assert.equal(await navigation(page, 'capabilities').count(), 0);
        await page.evaluate(function (id) { window.location.hash = 'view=capabilities&project=' + id + '&q=old'; }, specProject.id);
        await waitForView(page, 'binding');
        await page.getByRole('heading', { name: '能力绑定', exact: true }).waitFor();
        assert.equal(await page.locator('#project-picker-name').textContent(), gitProject.name);
        await switchProject(page, specProject);
        await waitForView(page, 'specs');
        await navigation(page, 'specs').waitFor();

        await showPage(page, 'host-setup', '宿主接入');
        await switchProject(page, gitProject);
        await waitForView(page, 'host-setup');
        await page.getByRole('heading', { name: '宿主接入', exact: true }).waitFor();
        assert.equal(await navigation(page, 'specs').isVisible(), false);
    } finally {
        if (launched) { await launched.electronApp.close(); }
        await fixture.cleanup();
    }
});
