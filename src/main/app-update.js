'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const releaseFeed = require('./app-update-feed');

/** Squirrel 在发出 update-downloaded 之前验证安装包的代码签名。 */
function verifyNative(updater, fileUrl) {
    return new Promise((resolve, reject) => {
        function cleanup() {
            updater.off('update-downloaded', downloaded);
            updater.off('update-not-available', unavailable);
            updater.off('error', failed);
        }
        function downloaded() { cleanup(); resolve(true); }
        function unavailable() { cleanup(); resolve(false); }
        function failed(error) { cleanup(); reject(new Error('系统未接受更新包。' + error.message)); }
        updater.once('update-downloaded', downloaded);
        updater.once('update-not-available', unavailable);
        updater.once('error', failed);
        try {
            updater.setFeedURL({ url: fileUrl, serverType: 'default' });
            updater.checkForUpdates();
        } catch (error) { failed(error); }
    });
}

class AppUpdates {
    constructor(options) {
        this.o = options;
        this.pending = null;
        this.ready = null;
        this.deferred = null;
        this.interactive = false;
        this.installing = false;
        this.installError = error => {
            if (this.installing) {
                this.installing = false;
                this.ready = null;
                this.notify('安装未完成', '请重新检查更新。' + error.message).catch(() => {});
            }
        };
        options.updater.on('error', this.installError);
    }

    notify(message, detail, buttons = ['好']) {
        return this.o.show({ type: 'info', title: '工作台更新', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
    }

    async confirmRestart() {
        const value = this.ready;
        const answer = await this.notify('版本 ' + value.version + ' 已就绪', (value.notes || '此版本没有附加说明。') +
            '\n\n立即重新启动，或在下次退出应用时安装。', ['重新启动并安装', '稍后']);
        if (answer.response !== 0) { return; }
        if (this.o.archiveBusy()) {
            await this.notify('正在归档，暂时无法重启', '归档完成后，选择「检查更新…」即可安装已就绪的版本。');
            return;
        }
        this.installing = true;
        try { this.o.updater.quitAndInstall(); }
        catch (error) { this.installing = false; this.ready = null; throw error; }
    }

    async run() {
        const o = this.o;
        if (!o.base || !o.packaged) {
            if (this.interactive) {
                await this.notify('此版本未启用在线更新', '当前版本 ' + o.version + '。请使用团队提供的安装包。');
            }
            return;
        }
        if (this.ready) {
            if (this.interactive) { await this.confirmRestart(); }
            return;
        }
        const release = await releaseFeed.checkFeed(o);
        if (!release) {
            if (this.interactive) { await this.notify('当前已是最新版本', '已安装 ' + o.version + '。'); }
            return;
        }
        if (!this.interactive && this.deferred === release.version) { return; }
        const answer = await this.notify('可更新到 ' + release.version, release.notes || '此版本没有附加说明。', ['下载并验证', '稍后']);
        if (answer.response !== 0) { this.deferred = release.version; return; }
        this.interactive = true;
        const dir = await fs.mkdtemp(path.join(o.temp, 'openspec-gui-update-'));
        try {
            const localFeed = await releaseFeed.stageRelease({ fetch: o.fetch, release, directory: dir, inspect: o.inspect });
            if (await verifyNative(o.updater, localFeed)) { this.ready = release; }
        } finally { await fs.rm(dir, { recursive: true, force: true }); }
        if (this.ready) { await this.confirmRestart(); }
        else { await this.notify('当前没有可安装的更新', '已安装 ' + o.version + '。'); }
    }

    check(manual) {
        if (this.installing) { return Promise.resolve(); }
        if (manual) { this.interactive = true; }
        if (!this.pending) {
            this.pending = this.run().catch(async error => {
                if (this.interactive) {
                    await this.notify('未能完成更新', (error.message || '无法取得更新。') + '\n\n可从应用菜单重新检查更新。');
                }
            }).finally(() => { this.pending = null; this.interactive = false; });
        }
        return this.pending;
    }
}

function setupAppUpdates({ electron, archiveBusy, base }) {
    if (process.platform !== 'darwin') { return; }
    const { app, autoUpdater, Menu, MenuItem, dialog, net } = electron;
    const updates = new AppUpdates({
        packaged: app.isPackaged, base, version: app.getVersion(), arch: process.arch,
        updater: autoUpdater, temp: app.getPath('temp'), archiveBusy,
        fetch: (url, options) => net.fetch(url, options), show: options => dialog.showMessageBox(options)
    });
    const menu = Menu.getApplicationMenu() || Menu.buildFromTemplate([
        { role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }, { role: 'help' }
    ]);
    menu.items[0].submenu.insert(1, new MenuItem({ id: 'check-app-updates', label: '检查更新…', click: () => { updates.check(true); } }));
    Menu.setApplicationMenu(menu);
    if (app.isPackaged && base) {
        const check = () => { updates.check(false); };
        const first = setTimeout(check, 30000);
        const interval = setInterval(check, 6 * 60 * 60 * 1000);
        first.unref();
        interval.unref();
        app.once('will-quit', () => { clearTimeout(first); clearInterval(interval); });
    }
    return updates;
}

module.exports = { setupAppUpdates, AppUpdates };
