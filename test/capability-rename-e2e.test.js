'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var electron = require('playwright-core')._electron;
var ui = require('./ui-test-helpers');
var createUiFixture = require('./ui-fixture').createUiFixture;

test('项目连接面板与项目详情重命名，保留表单、机器 ID 和跨重启的本机名称', { timeout: 60000 }, async function () {
    var fixture = await createUiFixture();
    var launched;
    var app;
    try {
        launched = await ui.launchWorkbench(fixture);
        app = launched.electronApp;
        var page = launched.page;
        page.setDefaultTimeout(8000);
        await ui.addFixtureProjects(page, fixture);
        function nav(view) { return page.locator('.sidebar [data-route="' + view + '"]').click(); }
        function row(id) { return page.locator('[data-capability-id="' + id + '"] .cap-item-link'); }
        function panel() { return page.locator('.cap-panel'); }
        function rename() { return panel().getByRole('button', { name: '重命名', exact: true }).click(); }
        function nameField() { return panel().getByLabel('显示名称', { exact: true }); }
        await nav('binding');
        await row('cv-test1').click();
        await panel().getByRole('button', { name: '项目绑定' }).click();
        await panel().getByRole('button', { name: '预览绑定' }).click();
        await panel().getByRole('button', { name: '确认应用' }).click();
        await panel().waitFor({ state: 'hidden' });
        await row('cv-test1').click();
        await panel().getByRole('button', { name: '连接设置' }).click();
        var token = panel().getByLabel('访问令牌');
        await token.fill('unsaved-fixture-value');
        await panel().getByText('接入 Claude Code', { exact: true }).click();
        var template = panel().getByLabel('Claude Code 命令模板');
        var command = await template.inputValue();
        await rename();
        await panel().getByText('本机所有项目共用此名称。').waitFor();
        await nameField().fill('不要保存');
        await nameField().press('Escape');
        await panel().getByRole('heading', { name: 'cv-test1', exact: true }).waitFor();
        assert.equal(await token.inputValue(), 'unsaved-fixture-value');
        await rename();
        await nameField().fill('CV 测试环境');
        var previousName = 'cv-test1';
        for (var actualName of ['CV 第一处改名', 'CV 第二处改名']) {
            await page.evaluate(async function (names) {
                var registry = await window.openSpecGUI.projects.list();
                return window.openSpecGUI.capabilities.rename({
                    id: 'cv-test1', expectedName: names.previous, name: names.next, projectId: registry.activeProjectId, host: 'codex'
                });
            }, { previous: previousName, next: actualName });
            await nameField().press('Enter');
            await panel().getByRole('alert').filter({ hasText: actualName }).waitFor();
            await panel().getByRole('heading', { name: actualName, exact: true }).waitFor();
            assert.equal(await nameField().inputValue(), 'CV 测试环境');
            assert.equal(await token.inputValue(), 'unsaved-fixture-value');
            var stored = await page.evaluate(async function () {
                var registry = await window.openSpecGUI.projects.list();
                var result = await window.openSpecGUI.capabilities.list({ projectId: registry.activeProjectId, host: 'codex' });
                return result.items.find(function (item) { return item.id === 'cv-test1'; }).name;
            });
            assert.equal(stored, actualName);
            previousName = actualName;
        }
        await panel().getByRole('button', { name: '覆盖保存' }).click();
        await panel().getByRole('heading', { name: 'CV 测试环境', exact: true }).waitFor();
        await page.getByRole('button', { name: 'CV 测试环境', exact: true }).waitFor();
        assert.equal(await token.inputValue(), 'unsaved-fixture-value');
        assert.equal(await template.inputValue(), command);
        await panel().getByRole('button', { name: '复制命令模板' }).click();
        assert.match(await app.evaluate(function (api) { return api.clipboard.readText(); }), /^claude mcp add --transport http cv-test1 /);

        await nav('binding');
        var filter = page.getByLabel('筛选能力');
        for (var query of ['CV 测试环境', 'cv-test1']) {
            await filter.fill(query);
            await row('cv-test1').waitFor();
            assert.equal(await page.locator('.cap-table tbody tr').count(), 1);
        }
        await filter.fill('');
        for (var id of ['feishu-defect-agent', 'feishu', 'portable-paths']) {
            await row(id).click();
            await rename();
            await nameField().press('Escape');
        }
        // 在真实注册表保存后暂缓回执，再打开另一个项目页面的条目。
        await app.evaluate(function (api) {
            var appRequire = process.getBuiltinModule('module').createRequire(api.app.getAppPath() + '/package.json');
            var prototype = appRequire('./src/main/capability-registry').CapabilityRegistry.prototype;
            var original = prototype.rename;
            globalThis.renameStarted = new Promise(function (resolve) {
                prototype.rename = async function (request) {
                    var result = await original.call(this, request);
                    await new Promise(function (release) { globalThis.releaseRename = release; resolve(); });
                    return result;
                };
            });
        });
        await row('cv-test1').click();
        await rename();
        await nameField().fill('CV 联调环境');
        await nameField().press('Enter');
        await app.evaluate(function () { return globalThis.renameStarted; });
        await page.locator('#project-picker-button').click();
        await page.getByRole('option', { name: /empty-specs/ }).click();
        await nav('binding');
        await row('portable-paths').click();
        await app.evaluate(function () { globalThis.releaseRename(); });
        await page.getByRole('button', { name: 'CV 联调环境', exact: true }).waitFor();
        await panel().getByRole('heading', { name: '可移植的路径', exact: true }).waitFor();

        await app.close();
        app = await electron.launch({ executablePath: launched.electronExecutable, args: launched.applicationArguments, env: launched.environment });
        page = await app.firstWindow();
        page.setDefaultTimeout(8000);
        await nav('binding');
        await row('cv-test1').click();
        await panel().getByRole('heading', { name: 'CV 联调环境', exact: true }).waitFor();
        assert.match(await panel().locator('.cap-identity').textContent(), /cv-test1$/);
    } finally {
        if (app) { await app.close(); }
        await fixture.cleanup();
    }
});
