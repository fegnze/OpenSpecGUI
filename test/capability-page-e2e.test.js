'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var ui = require('./ui-test-helpers');
var createUiFixture = require('./ui-fixture').createUiFixture;

test('Electron 在项目目录选择能力，按工作树与宿主隔离绑定、配置和只读入口', { timeout: 60000 }, async function () {
    var fixture = await createUiFixture();
    var launched;
    try {
        var oldRoot = path.join(fixture.root, 'user-data/capabilities');
        var legacy = { schema: 1, revision: 7, items: [{ id: 'personal-rule', kind: 'rule', versions: [] }],
            bindings: [{ root: null, host: 'codex', id: 'cv-test1', version: '1.0.0' }] };
        await fs.mkdir(oldRoot, { recursive: true });
        await fs.writeFile(path.join(oldRoot, 'registry.json'), JSON.stringify(legacy));
        launched = await ui.launchWorkbench(fixture, {});
        var page = launched.page;
        await ui.addFixtureProjects(page, fixture);
        await page.locator('.sidebar [data-route="binding"]').click();
        var area = page.locator('.cap-page');
        var panel = area.locator('.cap-panel');
        var entry = area.locator('[data-capability-id="cv-test1"]');
        var byLabel = function (label) { return panel.getByLabel(label, { exact: true }); };
        var apply = async function () { await panel.getByRole('button', { name: '确认应用', exact: true }).click(); await panel.waitFor({ state: 'hidden' }); };
        async function configure(row, action) {
            await row.locator('.cap-item-link').click();
            await panel.getByRole('button', { name: action, exact: true }).click();
        }
        async function enable(row) {
            await configure(row, '项目绑定');
            await panel.getByRole('button', { name: '预览绑定', exact: true }).click();
            await apply();
            await row.getByText('已绑定', { exact: true }).waitFor();
        }

        assert.deepEqual(await area.getByRole('group', { name: '能力类别' }).getByRole('button').allTextContents(), ['全部', 'Skills', 'MCP', 'Tools', '基础规范']);
        var defaultTable = area.getByRole('table', { name: '项目能力清单' });
        await defaultTable.locator('[data-capability-id="verify-changes"]').waitFor();
        assert.equal(await area.locator('[data-capability-id="personal-rule"]').count(), 0);
        assert.equal(await area.locator('.cap-recovery').getAttribute('open'), null);
        await area.getByText('旧版记录', { exact: true }).click();
        var backup = await area.getByLabel('原始备份路径').inputValue();
        assert.deepEqual(JSON.parse(await fs.readFile(backup, 'utf8')), legacy);
        await area.getByText('旧版记录', { exact: true }).click();
        assert.ok(await defaultTable.locator('tbody tr').count() >= 8);
        await defaultTable.locator('.cap-item-link').first().focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await panel.getByRole('button', { name: '关闭检查器' }).waitFor();
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await defaultTable.locator('.cap-item-link').nth(1).evaluate(function (node) { return node === document.activeElement; }), true);
        await area.getByLabel('筛选能力', { exact: true }).fill('cv-test1');
        assert.equal(await defaultTable.locator('tbody tr').count(), 1);
        await area.getByLabel('筛选能力', { exact: true }).fill('');
        await area.getByRole('button', { name: 'MCP', exact: true }).click();
        await entry.locator('.cap-item-link').click();
        assert.equal(await panel.getByRole('button', { name: '连接设置' }).count(), 0);
        await enable(entry);
        await configure(entry, '连接设置');
        await byLabel('访问令牌').waitFor();
        assert.equal(await byLabel('访问令牌').getAttribute('type'), 'password');
        await byLabel('访问令牌').fill('example-input-only');
        await panel.getByText('接入 Claude Code', { exact: true }).click();
        await panel.getByRole('button', { name: '复制命令模板' }).click();
        assert.match(await launched.electronApp.evaluate(function (electron) { return electron.clipboard.readText(); }), /Authorization: Bearer atk_你的token"$/);
        await area.getByRole('button', { name: 'Tools', exact: true }).click();
        await enable(area.locator('[data-capability-id="feishu"]'));
        await configure(area.locator('[data-capability-id="feishu"]'), '连接设置');
        await byLabel('验证用飞书文档').waitFor();
        assert.match(await panel.textContent(), /127\.0\.0\.1:47921\/oauth\/callback/);
        await enable(area.locator('[data-capability-id="google-drive"]'));
        await configure(area.locator('[data-capability-id="google-drive"]'), '连接设置');
        await byLabel('OAuth Client Secret').waitFor();
        assert.equal(await byLabel('验证用飞书文档').count(), 0);
        await area.getByRole('button', { name: 'MCP', exact: true }).click();
        await area.getByRole('button', { name: '全部', exact: true }).click();
        var skill = area.locator('[data-capability-id="feishu-defect-agent"]');
        await configure(skill, '项目绑定');
        await panel.getByRole('button', { name: '预览绑定' }).click();
        var confirm = panel.getByRole('button', { name: '确认应用' });
        await confirm.waitFor();
        var skillPreview = await panel.textContent();
        assert.match(skillPreview, /SHA-256[：:]\s*[a-f0-9]{64}/);
        assert.match(skillPreview, /scripts\/lib\/runtime\.mjs/);
        assert.match(skillPreview, /references\/operations\.md/);
        await apply();
        var snapshotId = skillPreview.match(/SHA-256[：:]\s*([a-f0-9]{64})/)[1];
        var local = JSON.parse(await fs.readFile(path.join(fixture.root, 'user-data/capabilities/objects', snapshotId + '.json'), 'utf8'));
        var expectedRoot = path.join(ui.repositoryRoot, 'src/capabilities/skills/feishu-defect-agent');
        var expectedNames = [];
        for (var name of await fs.readdir(expectedRoot, { recursive: true })) {
            if ((await fs.stat(path.join(expectedRoot, name))).isFile()) { expectedNames.push(name); }
        }
        assert.deepEqual(local.files.map(function (file) { return file.path; }).sort(), expectedNames.sort());
        for (var file of local.files) {
            assert.deepEqual(Buffer.from(file.data, 'base64'), await fs.readFile(path.join(expectedRoot, file.path)), file.path);
        }
        await skill.locator('.cap-item-link').click();
        await panel.getByText('版本详情', { exact: true }).click();
        var localEntry = await panel.getByLabel('本机入口路径', { exact: true }).inputValue();
        assert.equal(path.isAbsolute(localEntry), true);
        assert.deepEqual(await fs.readFile(localEntry), await fs.readFile(path.join(expectedRoot, 'SKILL.md')));
        await configure(skill, '项目设置');
        await panel.getByRole('button', { name: '项目配置', exact: true, pressed: true }).waitFor();
        await panel.getByRole('button', { name: '配置文件', exact: true }).click();
        await panel.getByRole('button', { name: '生成示例配置' }).click();
        await panel.getByRole('button', { name: '在 Finder 中显示' }).waitFor();
        var settingsPath = await byLabel('本机配置路径').inputValue();
        assert.ok(settingsPath.startsWith(path.join(fixture.root, 'user-data') + path.sep) || (await fs.realpath(settingsPath)).startsWith((await fs.realpath(path.join(fixture.root, 'user-data'))) + path.sep));
        assert.ok(JSON.parse(await fs.readFile(settingsPath, 'utf8')));
        await panel.getByRole('button', { name: '项目配置', exact: true }).click();
        await byLabel('飞书项目键').fill('fixture-project');
        await byLabel('来源 ID').fill('fixture-view');
        await panel.getByRole('button', { name: '保存项目配置' }).click();
        await panel.getByText('项目配置已保存到本机').waitFor();
        await configure(skill, '项目设置');
        await panel.getByRole('button', { name: '项目配置', exact: true, pressed: true }).waitFor();
        assert.equal(await byLabel('飞书项目键').inputValue(), 'fixture-project');
        assert.equal(await byLabel('来源 ID').inputValue(), 'fixture-view');
        await panel.getByRole('button', { name: '账号与授权', exact: true }).click();
        await panel.getByText(/Meegle/).first().waitFor();
        await area.getByLabel('宿主', { exact: true }).selectOption({ label: 'DeepSeek Harness' });
        await entry.getByText('未绑定', { exact: true }).waitFor();
        await enable(entry);
        await configure(entry, '连接设置');
        await byLabel('访问令牌').waitFor();
        assert.match(await panel.textContent(), /DeepSeek Harness/);
        assert.equal(await panel.getByText('接入 Claude Code', { exact: true }).count(), 0);
        await enable(skill);
        await configure(skill, '项目设置');
        await byLabel('飞书项目键').waitFor();
        assert.match(await panel.textContent(), /--binding/);
        assert.equal(await byLabel('飞书项目键').inputValue(), '');
        await area.getByLabel('宿主', { exact: true }).selectOption('claude');
        await entry.getByText('未绑定', { exact: true }).waitFor();
        await entry.locator('.cap-item-link').click();
        assert.equal(await panel.getByRole('button', { name: '连接设置', exact: true }).count(), 0);
        await area.getByLabel('宿主', { exact: true }).selectOption('codex');
        await entry.getByText('已绑定', { exact: true }).waitFor();
        await configure(entry, '项目绑定');
        await panel.getByRole('button', { name: '预览解除绑定' }).click();
        await page.locator('#project-picker-button').click();
        await page.getByRole('option', { name: /empty-specs/ }).click();
        await page.locator('#openspec-nav [data-route="overview"][aria-current="page"]').waitFor();
        assert.equal(await page.getByRole('button', { name: '确认应用', exact: true }).count(), 0);
        await page.locator('.sidebar [data-route="binding"]').click();
        await entry.getByText('未绑定', { exact: true }).waitFor();
    } finally {
        if (launched) { await launched.electronApp.close(); }
        await fixture.cleanup();
    }
});

test('飞书旧授权可升级为读写，访问验证与 Google Drive 只读授权分别展示', { timeout: 30000 }, async function (t) {
    var fixture = await createUiFixture();
    t.after(fixture.cleanup);
    var legacyCatalog = path.join(fixture.root, 'legacy-catalog');
    var legacySource = 'tools/feishu.json';
    await fs.mkdir(path.join(legacyCatalog, 'tools'), { recursive: true });
    await fs.writeFile(path.join(legacyCatalog, legacySource), JSON.stringify({ provider: 'feishu', access: 'read-only' }));
    await fs.writeFile(path.join(legacyCatalog, 'catalog.json'), JSON.stringify([{
        id: 'feishu', provider: 'feishu', name: '飞书文档连接认证', kind: 'tool', version: '1.0.0', source: legacySource
    }]));
    var legacyProject = { id: 'old-project', rootPath: await fs.realpath(fixture.primaryProject) };
    var CapabilityRegistry = require('../src/main/capability-registry').CapabilityRegistry;
    var legacy = new CapabilityRegistry({ userDataPath: path.join(fixture.root, 'user-data'), catalogRoot: legacyCatalog,
        getActive: function () { return legacyProject; } });
    var oldPlan = await legacy.preview({ projectId: legacyProject.id, host: 'codex', scope: 'project',
        operation: 'bind', id: 'feishu', version: '1.0.0' });
    await legacy.apply({ projectId: legacyProject.id, planId: oldPlan.planId });
    var launched = await ui.launchWorkbench(fixture);
    t.after(function () { return launched.electronApp.close(); });
    var page = launched.page;
    await ui.addFixtureProjects(page, fixture);
    await page.evaluate(async function () {
        var api = window.openSpecGUI.capabilities;
        var projectId = (await window.openSpecGUI.projects.list()).activeProjectId;
        var context = { projectId: projectId, host: 'codex' };
        var catalog = await api.list(context);
        var drive = catalog.items.find(function (entry) { return entry.id === 'google-drive'; });
        var plan = await api.preview(Object.assign({}, context, { scope: 'project', operation: 'bind', id: drive.id, version: drive.latest }));
        await api.apply({ projectId: projectId, planId: plan.planId });
    });
    // 在临时实例模拟厂商授权范围，经过真实的项目面板展示旧凭据及重新授权结果。
    async function scopes(...feishuScopes) {
        await launched.electronApp.evaluate(function (electron, scope) {
            electron.ipcMain.removeHandler('connections:status');
            electron.ipcMain.handle('connections:status', function (_event, request) {
                return { connected: true, state: 'verified', scopes: request.provider === 'feishu' ?
                    scope.concat('offline_access') : ['https://www.googleapis.com/auth/drive.metadata.readonly'] };
            });
        }, feishuScopes);
    }
    var panel = page.locator('.cap-panel');
    async function showConnection(provider) {
        await page.locator('[data-capability-id="' + provider + '"] .cap-item-link').click();
        await panel.getByRole('button', { name: '连接设置', exact: true }).click();
    }
    await scopes('docx:document:readonly');
    await page.locator('.sidebar [data-route="binding"]').click();
    await showConnection('feishu');
    var upgrade = panel.getByRole('button', { name: '升级为读写版本', exact: true });
    await upgrade.waitFor();
    assert.equal(await panel.getByRole('button', { name: '重新授权以启用读写' }).count(), 0);
    var feishu = page.locator('[data-capability-id="feishu"] .cap-item-link');
    await feishu.click();
    await panel.getByText('在 Agent 中验证', { exact: true }).click();
    await panel.getByRole('button', { name: '复制读取提示词', exact: true }).click();
    assert.match(await launched.electronApp.evaluate(electron => electron.clipboard.readText()), /正文开头/);
    assert.equal(await panel.getByRole('button', { name: '复制批注提示词' }).count(), 0);
    await panel.getByRole('button', { name: '项目绑定', exact: true }).click();
    await panel.getByLabel('采用版本', { exact: true }).selectOption('2.0.0');
    await panel.getByRole('button', { name: '预览绑定', exact: true }).click();
    await panel.getByText('1.0.0 → 2.0.0', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '确认应用', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await page.locator('[data-capability-id="feishu"]').getByText('2.0.0', { exact: true }).waitFor();
    await showConnection('feishu');
    await panel.getByRole('button', { name: '重新授权以启用读写', exact: true }).waitFor();
    await panel.getByRole('button', { name: '验证文档访问', exact: true }).waitFor();
    await page.locator('[data-capability-id="feishu"]').getByText('待授权读写', { exact: true }).waitFor();
    await scopes('docx:document');
    await showConnection('feishu');
    await panel.getByText('已授权范围 docx:document · offline_access', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: '重新授权以启用读写' }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '补充知识库和评论授权' }).count(), 0);
    await panel.getByRole('button', { name: '升级文档工具', exact: true }).click();
    await panel.getByText('2.0.0 → 3.0.0', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '确认应用', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await showConnection('feishu');
    await panel.getByRole('button', { name: '补充知识库和评论授权', exact: true }).waitFor();
    await page.locator('[data-capability-id="feishu"]').getByText('待补充授权', { exact: true }).waitFor();
    await scopes('docx:document', 'wiki:node:read', 'docs:document.comment:create');
    await showConnection('feishu');
    await panel.getByText(/已授权范围.*docs:document.comment:create/).waitFor();
    assert.equal(await panel.getByRole('button', { name: '补充知识库和评论授权' }).count(), 0);
    await feishu.click();
    await panel.getByText('在 Agent 中验证', { exact: true }).click();
    await panel.getByRole('button', { name: '复制批注提示词', exact: true }).click();
    assert.match(await launched.electronApp.evaluate(electron => electron.clipboard.readText()), /文末.*测试.*评论 ID/);
    await showConnection('google-drive');
    await panel.getByRole('button', { name: '验证只读访问', exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: '验证文档访问' }).count(), 0);
    await page.locator('[data-capability-id="google-drive"] .cap-item-link').click();
    await panel.getByText('在 Agent 中验证', { exact: true }).click();
    await panel.getByRole('button', { name: '复制读取提示词', exact: true }).click();
    assert.match(await launched.electronApp.evaluate(electron => electron.clipboard.readText()), /Google Drive.*名称、ID 和类型/);
});

test('文档授权失败、取消、切页及刷新后均可在当前窗口重试', { timeout: 45000 }, async function (t) {
    var fixture = await createUiFixture();
    t.after(fixture.cleanup);
    var launched = await ui.launchWorkbench(fixture);
    t.after(function () { return launched.electronApp.close(); });
    var page = launched.page;
    await ui.addFixtureProjects(page, fixture);
    await page.evaluate(async function () {
        var gui = window.openSpecGUI;
        var projectId = (await gui.projects.list()).activeProjectId;
        var plan = await gui.capabilities.preview({ projectId, host: 'codex', id: 'google-drive',
            scope: 'project', operation: 'bind', version: '1.0.0' });
        await gui.capabilities.apply({ projectId, planId: plan.planId });
    });
    await launched.electronApp.evaluate(function (electron) {
        var attempt = null;
        var state = 'disconnected';
        var message = '尚未连接。';
        var requests = [];
        var current = function () { return { state, message, connected: state === 'connected' }; };
        var complete = function (succeed, reason) {
            state = succeed ? 'connected' : 'disconnected';
            message = reason;
            var previous = attempt;
            attempt = null;
            if (succeed) { previous.resolve(current()); }
            else { previous.reject(new Error(reason)); }
        };
        globalThis.fixtureOAuth = { requests, complete };
        for (var key of ['status', 'cancelAuthorization', 'connect']) { electron.ipcMain.removeHandler('connections:' + key); }
        electron.ipcMain.handle('connections:status', current);
        electron.ipcMain.handle('connections:cancelAuthorization', function () {
            complete(false, '本次授权已取消。');
            return Object.assign({ canceled: true }, current());
        });
        electron.ipcMain.handle('connections:connect', function (_event, request) {
            var keys = Object.keys(request.settings);
            if (attempt) { complete(false, '旧的授权已结束。'); }
            else if (!keys.length) { throw new Error('未找到进行中的授权'); }
            requests.push(keys.sort());
            state = 'authorizing';
            message = '请在系统浏览器完成授权。';
            attempt = Promise.withResolvers();
            return attempt.promise;
        });
    });
    var area = page.locator('.cap-page');
    var panel = area.locator('.cap-panel');
    var showDrive = async function () {
        await area.locator('[data-capability-id="google-drive"] .cap-item-link').click();
        await panel.getByRole('button', {name:'连接设置', exact:true}).click();
    };
    var client = panel.getByLabel('OAuth Client ID', {exact:true});
    var secret = panel.getByLabel('OAuth Client Secret', {exact:true});
    var auth = panel.getByRole('button', {name:'在浏览器中授权', exact:true});
    var restart = panel.getByRole('button', {name:'重新授权', exact:true});
    var cancel = panel.getByRole('button', {name:'取消本次授权', exact:true});
    async function finish(ok, message) {
        await launched.electronApp.evaluate(function (_electron, args) { globalThis.fixtureOAuth.complete(...args); }, [ok, message]);
    }
    await page.locator('.sidebar [data-route="binding"]').click();
    await showDrive();
    await client.fill('fixture-client');
    await secret.fill('fixture-secret');
    await auth.click();
    await cancel.waitFor();
    await finish(false, '浏览器授权失败。');
    await auth.waitFor();
    assert.equal(await secret.inputValue(), 'fixture-secret');
    await auth.click();
    await cancel.click();
    await auth.waitFor();
    assert.equal(await client.inputValue(), 'fixture-client');
    assert.equal(await secret.inputValue(), 'fixture-secret');
    await auth.click();
    await restart.click();

    await area.getByRole('button', {name:'MCP', exact:true}).click();
    await area.getByRole('button', {name:'Tools', exact:true}).click();
    await showDrive();
    await restart.waitFor();
    assert.equal(await secret.inputValue(), '');
    await restart.click();
    await page.reload();
    await page.locator('.sidebar [data-route="binding"]').click();
    await showDrive();
    await restart.waitFor();
    assert.equal(await secret.inputValue(), '');
    await restart.click();
    await area.getByRole('button', {name:'MCP', exact:true}).click();
    await area.getByRole('button', {name:'Tools', exact:true}).click();
    await showDrive();
    await restart.waitFor();
    await client.fill('edited-client');
    await restart.click();
    assert.equal(await secret.evaluate(function (node) { return node.validity.valueMissing; }), true);
    await finish(true, '授权已保存。');
    await panel.getByRole('button', {name:'验证只读访问',exact:true}).waitFor();
    assert.equal(await client.inputValue(), 'edited-client');
    assert.equal(await area.locator('.cap-message.is-error').count(), 0);
    var requests = await launched.electronApp.evaluate(function () { return globalThis.fixtureOAuth.requests; });
    assert.deepEqual(requests, Array.from({length:4}, function () { return ['clientId','clientSecret']; }).concat([[],[]]));
});
