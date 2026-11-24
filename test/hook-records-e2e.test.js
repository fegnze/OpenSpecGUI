'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createUiFixture } = require('./ui-fixture');
const ui = require('./ui-test-helpers');

test('项目钩子记录通过真实 IPC 分页、筛选和展开，并拒绝另一个项目的请求', { timeout: 45000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp, page } = await ui.launchWorkbench(fixture);
    t.after(() => electronApp.close());
    await ui.addFixtureProjects(page, fixture);
    const registry = await page.evaluate(() => window.openSpecGUI.projects.list());
    const active = registry.projects.find(item => item.id === registry.activeProjectId);
    const other = registry.projects.find(item => item.id !== registry.activeProjectId);
    const base = Date.now() - 120000;
    async function write(project, host, offset, reason) {
        const time = base + offset;
        const dir = path.join(fixture.root, 'user-data', 'host-integration', 'receipts', project.id, host);
        await fs.mkdir(dir, { recursive: true });
        const data = { schema: 1, timestamp: new Date(time).toISOString(), projectId: project.id, root: project.rootPath,
            host, event: host === 'dsh' ? 'tools.guard' : 'PreToolUse', checkVersion: '1.0.0',
            bindings: [{ id: 'portable-paths', version: '1.0.0' }], decision: 'pass', reason };
        await fs.writeFile(path.join(dir, time + '-' + randomUUID() + '.json'), JSON.stringify(data), { mode: 0o600 });
    }
    for (let i = 0; i < 23; i++) { await write(active, i === 0 ? 'dsh' : 'codex', i, '记录-' + i); }
    await write(other, 'dsh', 40, '另一工作树的记录');
    await page.getByRole('button', { name: '钩子记录', exact: true }).click();
    const area = page.locator('.hook-records-page');
    await area.getByText('记录-22', { exact: true }).waitFor();
    assert.equal(await area.getByText('记录-0', { exact: true }).count(), 0);
    await area.getByRole('button', { name: '查看更多' }).click();
    await area.getByText('记录-0', { exact: true }).waitFor();
    await area.getByRole('combobox', { name: '宿主' }).selectOption('dsh');
    await area.getByRole('button', { name: 'tools.guard' }).click();
    await area.getByText('检查版本', { exact: true }).waitFor();
    assert.match(await area.innerText(), /portable-paths/);
    assert.doesNotMatch(await area.innerText(), /记录-22|另一工作树的记录/);
    await page.setViewportSize({ width: 820, height: 640 });
    await ui.assertNoPageOverflow(page, '项目钩子记录最小窗口');
    await ui.assertNoSeriousA11yViolations(page, '项目钩子记录');
    await assert.rejects(page.evaluate(id => window.openSpecGUI.hosts.records({ projectId: id, host: 'all' }), other.id), /当前项目已切换/);
    await assert.rejects(page.evaluate(id => window.openSpecGUI.hosts.records({ projectId: id, host: 'dsh', cursor: '../../private' }), active.id), /游标/);
    await write(active, 'dsh', 60, '最新记录');
    await area.getByRole('button', { name: '刷新记录', exact: true }).click();
    await area.getByText('最新记录', { exact: true }).waitFor();
});
