'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var createFixture = require('./archive-fixture').createArchiveFixture;
var ui = require('./ui-test-helpers');

async function openFixture(fixture, settings) {
    var launched = await ui.launchWorkbench({ root: fixture.base, fixedNow: '' }, settings);
    await launched.page.evaluate(function (root) { return window.openSpecGUI.projects.add({ path: root }); }, fixture.root);
    await launched.page.reload();
    await launched.page.waitForSelector('.control-header');
    await launched.page.locator('button[data-entity-type="active"][data-entity-id="' + fixture.changeId + '"]').click();
    await launched.page.waitForSelector('.change-detail-header');
    return launched;
}

test('Electron 归档覆盖详情双入口、完整预览、警告、取消、失效和成功定位', { timeout: 90000 }, async function () {
    var fixture = await createFixture({ incomplete: true });
    var launched;
    try {
        launched = await openFixture(fixture, { cli: fixture.cli, path: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin' });
        var page = launched.page;
        var errors = [];
        page.on('pageerror', function (error) { errors.push(error.message); });
        await page.locator('[data-panel="documents"]').click();
        await page.locator('[data-action="archive-change"]').click();
        await page.waitForSelector('#archive-confirm:not([hidden])');
        assert.equal(await page.locator('#archive-confirm').isDisabled(), true);
        assert.match(await page.locator('#archive-dialog-body').textContent(), /New state/);
        assert.match(await page.locator('#archive-dialog-body').textContent(), /任务 1 \/ 2/);
        await ui.assertNoSeriousA11yViolations(page, '归档预览浅色');
        await ui.assertNoPageOverflow(page, '归档预览宽窗口');
        await fs.mkdir(path.join(ui.repositoryRoot, 'artifacts'), { recursive: true });
        await page.screenshot({ path: path.join(ui.repositoryRoot, 'artifacts/archive-preview-wide-light.png') });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#archive-dialog').getAttribute('open'), null);
        assert.equal(await page.locator('[data-action="archive-change"]').evaluate(function (element) { return element === document.activeElement; }), true);
        await fs.stat(path.join(fixture.root, fixture.source));
        await page.locator('[data-panel="tasks"]').click();
        await ui.setTheme(page, 'dark');
        await page.setViewportSize({ width: 820, height: 640 });
        await page.locator('[data-action="archive-change"]').click();
        await page.waitForSelector('#archive-confirm:not([hidden])');
        await ui.assertNoSeriousA11yViolations(page, '归档预览深色');
        await ui.assertNoPageOverflow(page, '归档预览最小窗口');
        var geometry = await page.locator('#archive-dialog').boundingBox();
        assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.y + geometry.height <= 640);
        await page.screenshot({ path: path.join(ui.repositoryRoot, 'artifacts/archive-preview-minimum-dark.png') });
        await page.locator('[data-archive-warning]').check();
        assert.equal(await page.locator('#archive-confirm').isEnabled(), true);
        await fixture.write(fixture.source + '/evidence/new.dat', 'external update\n');
        await page.locator('#archive-confirm').click();
        await page.waitForFunction(function () { return document.querySelector('#archive-dialog-status').getAttribute('data-state') === 'error'; });
        assert.match(await page.locator('#archive-dialog-status').textContent(), /预览已失效/);
        await fs.stat(path.join(fixture.root, fixture.source));
        await page.locator('#archive-retry').click();
        await page.waitForSelector('#archive-confirm:not([hidden])');
        await page.locator('[data-archive-warning]').check();
        await page.locator('#archive-confirm').click();
        await page.waitForFunction(function () { return !document.querySelector('#archive-dialog').open && document.querySelector('.document-detail-header'); });
        assert.equal(await page.locator('[data-action="archive-change"]').count(), 0);
        assert.match(await page.locator('#toast').textContent(), /归档完成/);
        var archives = await fs.readdir(path.join(fixture.root, 'openspec/changes/archive'));
        assert.equal(archives.length, 1);
        var archived = path.join(fixture.root, 'openspec/changes/archive', archives[0]);
        assert.equal(await fs.readFile(path.join(archived, 'evidence/new.dat'), 'utf8'), 'external update\n');
        assert.deepEqual(await fs.readFile(path.join(archived, 'evidence/blob.bin')), Buffer.from([0, 255, 3, 12, 42]));
        await assert.rejects(fs.stat(path.join(fixture.root, fixture.source)), { code: 'ENOENT' });
        assert.deepEqual(errors, []);
    } finally { if (launched) { await launched.electronApp.close(); } await fixture.cleanup(); }
});

test('Electron 无兼容 CLI 时解释限制并保持文档浏览', { timeout: 45000 }, async function () {
    var fixture = await createFixture();
    var launched;
    try {
        launched = await openFixture(fixture, {});
        var page = launched.page;
        await page.locator('[data-action="archive-change"]').click();
        await page.waitForSelector('.archive-error');
        assert.match(await page.locator('.archive-error').textContent(), /CLI/);
        assert.equal(await page.locator('#archive-confirm').isVisible(), false);
        await page.locator('#archive-cancel').click();
        await page.locator('[data-panel="documents"]').click();
        await page.waitForSelector('.markdown-body');
        await fs.stat(path.join(fixture.root, fixture.source));
    } finally { if (launched) { await launched.electronApp.close(); } await fixture.cleanup(); }
});

test('Electron 使用自身 Node 运行时支持 Finder 环境中的项目本地 CLI', { timeout: 45000 }, async function () {
    var fixture = await createFixture({ noDelta: true });
    var launched;
    try {
        await fs.mkdir(path.join(fixture.root, 'node_modules/.bin'), { recursive: true });
        await fs.symlink(fixture.cli, path.join(fixture.root, 'node_modules/.bin/openspec'));
        launched = await openFixture(fixture, {});
        var page = launched.page;
        await page.locator('[data-action="archive-change"]').click();
        await page.waitForSelector('#archive-confirm:not([hidden])');
        assert.match(await page.locator('#archive-dialog-body').textContent(), /没有增量规范/);
        assert.equal(await page.locator('#archive-confirm').textContent(), '归档');
        await page.locator('#archive-confirm').click();
        await page.waitForFunction(function () { return !document.querySelector('#archive-dialog').open && document.querySelector('.document-detail-header'); });
        await assert.rejects(fs.stat(path.join(fixture.root, fixture.source)), { code: 'ENOENT' });
    } finally { if (launched) { await launched.electronApp.close(); } await fixture.cleanup(); }
});
