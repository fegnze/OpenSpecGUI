'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var createUiFixture = require('./ui-fixture').createUiFixture;
var ui = require('./ui-test-helpers');

test('能力绑定保留输入，独立于 OpenSpec 的延迟错误、刷新和冷启动', { timeout: 60000 }, async function () {
    var fixture = await createUiFixture();
    var launched;
    try {
        launched = await ui.launchWorkbench(fixture);
        var page = launched.page;
        var app = launched.electronApp;
        page.setDefaultTimeout(8000);
        await ui.addFixtureProjects(page, fixture);
        var snapshot = await page.evaluate(function () { return window.openSpecGUI.workspace.load(); });

        // 只替换临时 Electron 实例的两个工作区 IPC。页面、路由、项目登记及能力配置走产品入口。
        await app.evaluate(function (electron, initial) {
            var state = { loads: 0, refreshes: 0, mode: 'hold', failPending: null };
            state.started = new Promise(function (resolve) { state.notifyStart = resolve; });
            globalThis.isolationFixture = state;
            function respond() {
                if (state.mode === 'fail') { throw new Error('fixture-openspec-read-failed'); }
                if (state.mode === 'hold') {
                    return new Promise(function (_resolve, reject) {
                        state.failPending = function () { reject(new Error('fixture-stale-refresh')); };
                        state.notifyStart();
                    });
                }
                return initial;
            }
            electron.ipcMain.removeHandler('workspace:load');
            electron.ipcMain.removeHandler('workspace:refresh');
            electron.ipcMain.handle('workspace:load', function () { state.loads += 1; return respond(); });
            electron.ipcMain.handle('workspace:refresh', function () { state.refreshes += 1; return respond(); });
        }, snapshot);

        await page.locator('#refresh-button').click();
        await app.evaluate(function () { return globalThis.isolationFixture.started; });
        await page.locator('.sidebar [data-route="binding"]').click();
        var skill = page.locator('[data-capability-id="feishu-defect-agent"]');
        await skill.locator('.cap-item-link').click();
        await page.getByRole('button', { name: '项目绑定', exact: true }).click();
        await page.getByRole('button', { name: '预览绑定', exact: true }).click();
        await page.getByRole('button', { name: '确认应用', exact: true }).click();
        await page.locator('.cap-panel').waitFor({ state: 'hidden' });
        await skill.locator('.cap-item-link').click();
        await page.getByRole('button', { name: '项目设置', exact: true }).click();
        var projectKey = page.getByLabel('飞书项目键', { exact: true });
        await projectKey.fill('unsaved-project-key');
        await app.evaluate(function () {
            var state = globalThis.isolationFixture;
            state.mode = 'fail';
            state.failPending();
        });
        // 让前一条 IPC 回执及其渲染迭代结束后再检查同一输入框。
        await page.evaluate(function () {
            return window.openSpecGUI.projects.list().then(function () {
                return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
            });
        });
        assert.equal(await projectKey.inputValue(), 'unsaved-project-key');
        assert.equal(await page.locator('.error-state').count(), 0);

        await page.locator('#refresh-button').click();
        await skill.locator('.cap-item-link').waitFor();
        var refreshCount = await app.evaluate(function () { return globalThis.isolationFixture.refreshes; });
        assert.equal(refreshCount, 1, '能力页刷新不能触发第二次 OpenSpec 刷新');

        // 重新载入渲染器，恢复当前项目上次选择的能力绑定页。
        await page.evaluate(function () { history.replaceState(null, '', location.pathname); });
        await page.reload();
        await skill.locator('.cap-item-link').waitFor();
        assert.equal(await page.locator('.sidebar [data-route="binding"]').getAttribute('aria-current'), 'page');
        assert.equal(await app.evaluate(function () { return globalThis.isolationFixture.loads; }), 0);

        await page.locator('.sidebar [data-route="overview"]').click();
        var failure = page.locator('.error-state');
        await failure.getByText(/fixture-openspec-read-failed/).waitFor();
        await app.evaluate(function () { globalThis.isolationFixture.mode = 'ok'; });
        await failure.getByRole('button', { name: '重新读取' }).click();
        await page.locator('.control-header').waitFor();
        assert.equal(await page.locator('.error-state').count(), 0);
        assert.ok(await app.evaluate(function () {
            return globalThis.isolationFixture.loads + globalThis.isolationFixture.refreshes >= 3;
        }));
    } finally {
        if (launched) { await launched.electronApp.close(); }
        await fixture.cleanup();
    }
});
