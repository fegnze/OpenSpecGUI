'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var createUiFixture = require('./ui-fixture').createUiFixture;
var ui = require('./ui-test-helpers');

test('Electron 按需列出活跃和归档提案的 JSON，分页只读并丢弃上个项目的回执', { timeout: 60000 }, async function () {
    var fixture = await createUiFixture();
    var launched;
    try {
        var archiveId = '2026-03-20-project-registry';
        var activeRoot = path.join(fixture.primaryProject, 'openspec/changes/modern-console/evidence');
        var archiveRoot = path.join(fixture.primaryProject, 'openspec/changes/archive', archiveId, 'evidence');
        await fs.mkdir(activeRoot, { recursive: true });
        await fs.mkdir(archiveRoot, { recursive: true });
        var record = JSON.stringify({ first: '<b>仅作为文本</b>', padding: 'a'.repeat(70000), final: '已达末段' });
        await fs.writeFile(path.join(activeRoot, 'long.json'), record);
        await fs.writeFile(path.join(archiveRoot, 'result.json'), '{"result":"归档完成"}');
        launched = await ui.launchWorkbench(fixture);
        var app = launched.electronApp;
        var page = launched.page;
        page.setDefaultTimeout(8000);
        await app.evaluate(function (electron) {
            var appRequire = process.getBuiltinModule('module').createRequire(electron.app.getAppPath() + '/package.json');
            var service = appRequire('./src/main/workbench-service').WorkbenchService.prototype;
            var trace = { list: [], read: [], holdNext: false };
            globalThis.attachmentTest = trace;
            ['listAttachments', 'readAttachment'].forEach(function (method) {
                var original = service[method];
                if (typeof original !== 'function') { throw new Error('附件接口尚未注册 ' + method); }
                service[method] = async function (request) {
                    trace[method === 'listAttachments' ? 'list' : 'read'].push(request);
                    var result = await original.call(this, request);
                    if (method === 'readAttachment' && trace.holdNext) {
                        trace.holdNext = false;
                        await new Promise(function (resolve) { trace.release = resolve; });
                    }
                    return result;
                };
            });
        });
        function counts() {
            return app.evaluate(function () { return [globalThis.attachmentTest.list.length, globalThis.attachmentTest.read.length]; });
        }

        await ui.addFixtureProjects(page, fixture);
        await page.locator('#refresh-button').click();
        await page.locator('#refresh-button:not(:disabled)').waitFor();
        await page.locator('button[data-entity-id="modern-console"]').click();
        var disclosure = page.locator('.change-attachments > summary');
        var output = page.getByLabel('验收记录原文');
        await disclosure.waitFor();
        assert.equal(await page.locator('.change-attachments').getAttribute('open'), null);
        assert.deepEqual(await counts(), [0, 0]);

        await disclosure.focus();
        await page.keyboard.press('Enter');
        var activeFile = page.getByRole('button', { name: /evidence\/long\.json/ });
        await activeFile.waitFor();
        assert.deepEqual(await counts(), [1, 0]);
        await activeFile.click();
        await page.getByRole('status').filter({ hasText: '第 1 段' }).waitFor();
        var first = await output.textContent();
        assert.ok(first.includes('<b>仅作为文本</b>') && !first.includes('已达末段'));
        assert.equal(await output.locator('b').count(), 0);
        assert.ok(Buffer.byteLength(first) <= 65536);
        await page.getByRole('button', { name: '下一段' }).click();
        await page.getByRole('status').filter({ hasText: '第 2 段' }).waitFor();
        assert.equal(first + await output.textContent(), record);
        assert.equal(await page.getByRole('button', { name: '下一段' }).isEnabled(), false);
        await page.getByRole('button', { name: '上一段' }).click();
        await page.getByRole('status').filter({ hasText: '第 1 段' }).waitFor();
        assert.equal(await output.textContent(), first);
        assert.deepEqual(await counts(), [1, 3]);

        await page.locator('.sidebar [data-route="archives"]').click();
        await page.locator('button[data-entity-id="' + archiveId + '"]').click();
        await disclosure.waitFor();
        assert.deepEqual(await counts(), [1, 3]);
        await disclosure.click();
        var archivedFile = page.getByRole('button', { name: /evidence\/result\.json/ });
        await archivedFile.waitFor();
        assert.deepEqual(await counts(), [2, 3]);
        await app.evaluate(function () { globalThis.attachmentTest.holdNext = true; });
        await archivedFile.click();
        // 等待读取服务已取得归档正文，先切项目，再释放旧回执。
        await app.evaluate(async function () {
            var trace = globalThis.attachmentTest;
            while (!trace.release) { await new Promise(function (resolve) { setTimeout(resolve, 5); }); }
        });
        var otherProject = await page.evaluate(async function () {
            var registry = await window.openSpecGUI.projects.list();
            return registry.projects.find(function (project) { return project.id !== registry.activeProjectId; }).id;
        });
        await page.locator('#project-picker-button').click();
        await page.locator('[data-project-option="' + otherProject + '"]').click();
        await page.locator('.control-header').waitFor();
        await app.evaluate(function () { globalThis.attachmentTest.release(); });
        await page.evaluate(async function () {
            await window.openSpecGUI.projects.list();
            await new Promise(function (resolve) { requestAnimationFrame(resolve); });
        });
        assert.equal(await page.locator('.change-attachments').count(), 0);
        assert.doesNotMatch(await page.locator('#page').innerText(), /归档完成/);
        var last = await app.evaluate(function () { return globalThis.attachmentTest.read.at(-1); });
        assert.equal(last.entityType, 'archive');
        assert.equal(last.changeId, archiveId);
    } finally {
        if (launched) { await launched.electronApp.close(); }
        await fixture.cleanup();
    }
});
