'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createUiFixture } = require('./ui-fixture');
const ui = require('./ui-test-helpers');

test('宿主检测在全局页面展示能力、按需展开配置，重检结果不会覆盖其他页面', { timeout: 30000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp, page } = await ui.launchWorkbench(fixture);
    t.after(() => electronApp.close());
    await electronApp.evaluate(({ ipcMain }) => {
        const example = {
            id: 'codex', name: 'Codex', version: '0.151.0', executable: '/fixture/codex',
            status: 'needs-trust', detail: '需在 Codex 确认钩子。',
            events: [{ name: 'SessionStart', supported: true, detail: '启动会话时' }, { name: 'PreToolUse', supported: true, detail: '工具运行前' }],
            targets: [{ path: '/fixture/hooks.json', description: '用户级钩子文件', preview: '{"path":"<fixture_hook>"}' }],
            nextSteps: ['在 Codex 中确认这些钩子。']
        };
        const missing = {
            id: 'claude', name: 'Claude Code', version: null, executable: null,
            status: 'missing', detail: '未发现可执行程序。', receiptsDirectory: '/fixture/receipts',
            events: [], targets: [], nextSteps: ['安装 Claude Code 后重新检测。']
        };
        const result = { hosts: [example, missing] };
        let calls = 0;
        ipcMain.removeHandler('hosts:inspect');
        ipcMain.handle('hosts:inspect', () => {
            calls += 1;
            if (calls === 2) { throw new Error('test-private-diagnostic'); }
            if (calls === 4) {
                return new Promise(resolve => { globalThis.returnHostInspection = () => resolve(result); });
            }
            return result;
        });
    });

    await page.getByRole('button', { name: '宿主接入', exact: true }).click();
    const area = page.locator('.host-setup');
    const codex = area.locator('[data-host="codex"]');
    const claude = area.locator('[data-host="claude"]');
    await codex.locator('h2').waitFor();
    assert.match(await codex.innerText(), /0\.151\.0/);
    assert.match(await codex.innerText(), /待信任/);
    assert.match(await codex.innerText(), /PreToolUse/);
    assert.match(await claude.innerText(), /未检测到/);
    assert.equal(await area.locator('pre').count(), 0);
    assert.equal(await claude.locator('.host-verification').count(), 0);
    await codex.locator('.host-configuration > summary').focus();
    await page.keyboard.press('Enter');
    await codex.locator('pre').waitFor();
    assert.equal(await codex.locator('pre code').innerText(), '{"path":"<fixture_hook>"}');
    assert.equal(await codex.locator('fixture_hook').count(), 0);
    await page.setViewportSize({ width: 820, height: 640 });
    await ui.assertNoPageOverflow(page, '最小窗口宿主接入预览');
    await ui.assertNoSeriousA11yViolations(page, '宿主接入预览');

    await page.getByRole('button', { name: '重新检测本机宿主' }).click();
    await area.getByText('宿主检测失败。请重新检测。').waitFor();
    assert.doesNotMatch(await area.innerText(), /test-private/);
    const recheck = area.getByRole('button', { name: '重新检测', exact: true });
    await recheck.click();
    await claude.locator('h2').waitFor();
    await recheck.click();
    await area.getByText('正在检测本机宿主…').waitFor();
    await page.evaluate(() => { window.location.hash = 'view=binding'; });
    await page.getByRole('heading', { name: '请先选择项目' }).waitFor();
    await electronApp.evaluate(() => globalThis.returnHostInspection());
    assert.equal(await area.count(), 0);
    await page.getByRole('button', { name: '宿主接入', exact: true }).click();
    await codex.locator('h2').waitFor();
});

test('一键接入显示用户级变更、自动更新失败的计划，切页后可解除接入', { timeout: 30000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp, page } = await ui.launchWorkbench(fixture);
    t.after(() => electronApp.close());
    await electronApp.evaluate(({ ipcMain }) => {
        const names = ['SessionStart', 'PreToolUse'];
        let configured = false;
        let generation = 0;
        const requests = [];
        globalThis.hostActionRequests = requests;
        function snapshot() {
            generation++;
            return { hosts: [{
                id: 'codex', name: 'Codex', version: '0.151.0', executable: '/fixture/codex',
                status: configured ? 'needs-trust' : 'available', detail: configured ? '本机入口已登记。' : '本机可接入。',
                nextSteps: ['打开 Codex /hooks 审阅并信任两个入口。'],
                events: names.map(name => ({ name, supported: true, detail: '' })),
                targets: [], canInstall: !configured, canRemove: configured,
                installEvents: configured ? [] : names, removeEvents: configured ? names : [],
                configurationPath: '/fixture/.codex/hooks.json', runnerPath: '/fixture/app support/bin/workbench-hook',
                planId: 'plan-' + generation
            }] };
        }
        for (const method of ['inspect', 'install', 'remove']) { ipcMain.removeHandler('hosts:' + method); }
        ipcMain.handle('hosts:inspect', snapshot);
        ipcMain.handle('hosts:install', (event, payload) => {
            requests.push(payload);
            if (requests.length === 1) { throw new Error('配置已变化。'); }
            return new Promise(resolve => {
                globalThis.finishHostInstall = () => {
                    configured = true;
                    resolve(snapshot());
                };
            });
        });
        ipcMain.handle('hosts:remove', (event, payload) => {
            requests.push(payload);
            configured = false;
            return snapshot();
        });
    });
    const entry = page.getByRole('button', { name: '宿主接入', exact: true });
    await entry.click();
    const area = page.locator('.host-setup');
    const row = area.locator('[data-host="codex"]');
    const install = row.getByRole('button', { name: '一键接入' });
    await install.waitFor();
    for (const text of ['/fixture/.codex/hooks.json', 'workbench-hook', 'SessionStart、PreToolUse', '当前用户身份']) {
        assert.ok((await row.innerText()).includes(text));
    }
    assert.equal(await row.locator('details[open]').count(), 0);
    await page.setViewportSize({ width: 820, height: 640 });
    await ui.assertNoPageOverflow(page, '最小窗口宿主一键接入');
    await ui.assertNoSeriousA11yViolations(page, '宿主接入操作');
    await install.click();
    await area.getByText(/接入失败。配置已变化。 已重新检测/).waitFor();
    await install.evaluate(button => { button.click(); button.click(); });
    await area.getByText('正在接入 Codex…').waitFor();
    assert.equal(await install.isDisabled(), true);
    await page.evaluate(() => { window.location.hash = 'view=binding'; });
    await page.getByRole('heading', { name: '请先选择项目' }).waitFor();
    await entry.click();
    await area.getByText('正在检测本机宿主…').waitFor();
    assert.equal(await install.count(), 0);
    await electronApp.evaluate(() => globalThis.finishHostInstall());
    const remove = row.getByRole('button', { name: '解除接入' });
    await remove.waitFor();
    assert.match(await row.innerText(), /待信任/);
    assert.match(await row.innerText(), /打开 Codex \/hooks/);
    assert.match(await row.innerText(), /解除事件/);
    assert.equal(await install.count(), 0);
    await remove.click();
    await install.waitFor();
    assert.match(await area.innerText(), /已移除工作台登记的配置/);
    assert.deepEqual(await electronApp.evaluate(() => globalThis.hostActionRequests), [
        { host: 'codex', planId: 'plan-1' }, { host: 'codex', planId: 'plan-2' }, { host: 'codex', planId: 'plan-4' }
    ]);
});

test('已接入宿主可分别预览和复制当前项目的验证提示词，复制失败后可重试', { timeout: 30000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp, page } = await ui.launchWorkbench(fixture);
    t.after(() => electronApp.close());
    await ui.addFixtureProjects(page, fixture);
    const project = await page.evaluate(async () => {
        const registry = await window.openSpecGUI.projects.list();
        return registry.projects.find(item => item.id === registry.activeProjectId);
    });
    const hosts = [
        { id: 'codex', name: 'Codex', status: 'needs-trust', event: 'SessionStart' },
        { id: 'claude', name: 'Claude Code', status: 'configured', event: 'SessionStart' },
        { id: 'dsh', name: 'DeepSeek Harness', status: 'configured', event: 'system-prompt/assemble' }
    ];
    await electronApp.evaluate(({ ipcMain }, rows) => {
        ipcMain.removeHandler('hosts:inspect');
        ipcMain.handle('hosts:inspect', () => ({ hosts: rows.map(host => ({
            ...host, events: [], targets: [], nextSteps: [],
            receiptsDirectory: '/fixture/receipts', runnerPath: '/fixture/bin/workbench-hook'
        })) }));
        ipcMain.removeHandler('clipboard:write');
        globalThis.verificationWrites = [];
        ipcMain.handle('clipboard:write', (event, { text }) => {
            if (globalThis.rejectVerificationCopy) {
                globalThis.rejectVerificationCopy = false;
                throw new Error('clipboard unavailable');
            }
            globalThis.verificationWrites.push(text);
            return { ok: true };
        });
    }, hosts);
    await page.getByRole('button', { name: '宿主接入', exact: true }).click();
    for (const host of hosts) {
        const verification = page.locator('[data-host="' + host.id + '"] .host-verification');
        const details = verification.locator('details');
        const summary = verification.getByText('查看验证提示词', { exact: true });
        await summary.waitFor();
        assert.equal(await details.getAttribute('open'), null);
        await summary.click();
        const preview = await details.locator('pre').innerText();
        for (const expected of [host.name, host.event, project.rootPath]) {
            assert.ok(preview.includes(expected), '预览缺少 ' + expected);
        }
        await summary.click();
        assert.equal(await details.getAttribute('open'), null);
        const copy = verification.getByRole('button', { name: '复制验证提示词', exact: true });
        if (host.id === 'dsh') {
            await electronApp.evaluate(() => { globalThis.rejectVerificationCopy = true; });
            await copy.click();
            await verification.locator('details[open]').waitFor();
            assert.equal(await electronApp.evaluate(() => globalThis.verificationWrites.length), 2);
        }
        const started = Date.now();
        await copy.click();
        await verification.getByText(/已复制/).first().waitFor();
        const copied = await electronApp.evaluate(() => globalThis.verificationWrites.at(-1));
        const toolCheck = host.id === 'dsh' ? ['tools.guard', 'write'] : ['PreToolUse', 'pwd -P'];
        for (const expected of [host.name, host.event, ...toolCheck, project.rootPath, '/fixture/receipts/' + project.id + '/' + host.id]) {
            assert.ok(copied.includes(expected), '复制文本缺少 ' + expected);
        }
        const copiedTime = copied.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
        assert.ok(copiedTime && Date.parse(copiedTime[0]) >= started && Date.parse(copiedTime[0]) <= Date.now());
    }
    assert.equal(await electronApp.evaluate(() => globalThis.verificationWrites.length), 3);
});

test('宿主接入按当前项目的原生回执自动更新，保留配置状态与已展开的面板', { timeout: 30000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp, page } = await ui.launchWorkbench(fixture);
    t.after(() => electronApp.close());
    await ui.addFixtureProjects(page, fixture);
    const projectId = await page.evaluate(async () => (await window.openSpecGUI.projects.list()).activeProjectId);
    await electronApp.evaluate(({ ipcMain }, projectId) => {
        ipcMain.removeHandler('hosts:inspect');
        ipcMain.removeHandler('hosts:verification');
        const makeRow = (id, status) => ({
            id, name: id, status, verificationEligible: status === 'configured', detail: '原有配置状态',
            events: [], targets: [], nextSteps: [], receiptsDirectory: '/fixture/receipts'
        });
        globalThis.hostInspections = 0;
        ipcMain.handle('hosts:inspect', () => {
            globalThis.hostInspections++;
            return { hosts: [makeRow('dsh', 'configured'), makeRow('codex', 'needs-trust'), makeRow('claude', 'conflict')] };
        });
        const skipped = { timestamp: new Date().toISOString(), decision: 'skipped', reason: '此工作树和宿主没有生效绑定' };
        globalThis.receiptResults = { projectId, hosts: {
            dsh: { 'system-prompt/assemble': skipped }, codex: { SessionStart: skipped, PreToolUse: skipped },
            claude: { SessionStart: skipped, PreToolUse: skipped }
        } };
        ipcMain.handle('hosts:verification', () => globalThis.receiptResults);
    }, projectId);
    await page.getByRole('button', { name: '宿主接入', exact: true }).click();
    const area = page.locator('.host-setup');
    const row = area.locator('[data-host="dsh"]');
    await row.getByText('已配置 · 部分钩子已触发', { exact: true }).waitFor();
    assert.match(await row.innerText(), /tools.guard 待触发/);
    await row.getByText('查看验证提示词', { exact: true }).click();
    await row.locator('details[open] pre').waitFor();

    // 不操作工作台，宿主在项目另一端产生回执后，该页面应自行更新。
    await electronApp.evaluate(() => {
        const events = globalThis.receiptResults.hosts.dsh;
        events['tools.guard'] = events['system-prompt/assemble'];
    });
    await row.getByText('已配置 · 钩子已触发', { exact: true }).waitFor({ timeout: 9000 });
    assert.match(await row.innerText(), /没有生效绑定而跳过检查/);
    assert.match(await row.innerText(), /最近触发于 .*\d{2}:\d{2}:\d{2}/);
    assert.equal(await row.locator('details[open] pre').count(), 1);
    assert.equal(await area.locator('[data-host="codex"] .host-status').innerText(), '待信任');
    assert.equal(await area.locator('[data-host="claude"] .host-status').innerText(), '配置冲突');
    assert.equal(await electronApp.evaluate(() => globalThis.hostInspections), 1);

    await electronApp.evaluate(() => {
        globalThis.receiptResults.hosts.dsh['tools.guard'] = { timestamp: new Date().toISOString(), decision: 'error', reason: '无法完成检查' };
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await row.getByText('已配置 · 钩子执行出错', { exact: true }).waitFor();
    await electronApp.evaluate(() => { globalThis.receiptResults.projectId = 'different-project'; });
    await area.getByRole('button', { name: '重新检测', exact: true }).click();
    await row.getByText('已配置 · 待验证', { exact: true }).waitFor();
    assert.equal(await row.getByText('已配置 · 钩子执行出错').count(), 0);
});
