'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ui = require('./ui-test-helpers');
const { createUiFixture } = require('./ui-fixture');

test('macOS 原生应用菜单可检查更新，并保留系统编辑与退出入口', { skip: process.platform !== 'darwin', timeout: 25000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp: app } = await ui.launchWorkbench(fixture);
    t.after(() => app.close());
    const result = await app.evaluate(async electron => {
        const menu = electron.Menu.getApplicationMenu();
        const item = menu.getMenuItemById('check-app-updates');
        const names = menu.items.flatMap(group => group.submenu?.items.map(child => child.role) || []);
        const original = electron.dialog.showMessageBox;
        try {
            const dialog = new Promise(resolve => { electron.dialog.showMessageBox = async options => { resolve(options); return { response: 0 }; }; });
            item.click();
            return { label: item.label, options: await dialog, roles: names, version: electron.app.getVersion() };
        } finally { electron.dialog.showMessageBox = original; }
    });
    assert.equal(result.label, '检查更新…');
    assert.ok(result.roles.includes('copy') && result.roles.includes('quit'));
    assert.match(result.options.message, /未启用在线更新/);
    assert.ok(result.options.detail.includes(result.version));
});

test('真实 Squirrel 在本机接收已下载文件并拒绝损坏 ZIP', { skip: process.platform !== 'darwin', timeout: 25000 }, async t => {
    const fixture = await createUiFixture();
    t.after(fixture.cleanup);
    const { electronApp: app } = await ui.launchWorkbench(fixture);
    t.after(() => app.close());
    const result = await app.evaluate(async (electron, temp) => {
        const localRequire = process.getBuiltinModule('node:module').createRequire(electron.app.getAppPath() + '/package.json');
        const { AppUpdates } = localRequire('./src/main/app-update');
        const { createHash } = process.getBuiltinModule('node:crypto');
        const version = '99.0.0';
        const arch = process.arch;
        const base = 'https://release.example.test';
        const bytes = Buffer.from('deliberately invalid ZIP for native handoff verification');
        const release = { name: '临时测试', version, notes: '临时测试', pub_date: '2026-11-23T00:00:00Z', arch,
            url: base + '/darwin/' + arch + '/openspec-gui-' + version + '-darwin-' + arch + '.zip',
            sha256: createHash('sha256').update(bytes).digest('hex') };
        const dialogs = [];
        let observed = false;
        electron.autoUpdater.once('update-available', () => { observed = true; });
        const updates = new AppUpdates({
            packaged: true, version: '0.1.0', base, arch, temp, updater: electron.autoUpdater,
            inspect: async () => {}, archiveBusy: () => true,
            fetch: async url => new Response(url === release.url ? bytes : JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: release }] })),
            show: async info => { dialogs.push(info); return { response: 0 }; }
        });
        await updates.check(true);
        return { observed, ready: updates.ready, last: dialogs.at(-1) };
    }, fixture.root);
    assert.equal(result.observed, true);
    assert.equal(result.ready, null);
    assert.match(result.last.detail, /系统未接受更新包/);
});
