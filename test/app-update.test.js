'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { AppUpdates } = require('../src/main/app-update');
const { feedLocation, selectRelease, inspectBundle } = require('../src/main/app-update-feed');

const base = 'https://updates.example.test/team';
const arch = 'arm64';
const feed = feedLocation(base, arch);
const bytes = Buffer.from('isolated archive fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function manifest(version = '0.3.0', changes = {}) {
    const updateTo = {
        name: '工作台 ' + version, version, arch, sha256, notes: '更新了团队目录', pub_date: '2026-11-23T00:00:00Z',
        url: new URL('agent-workbench-' + version + '-darwin-arm64.zip', feed).href, ...changes
    };
    return { currentRelease: version, releases: [{ version, updateTo }] };
}

test('索引仅允许稳定发布目录中的匹配架构、版本和摘要', () => {
    assert.equal(feed.href, base + '/darwin/arm64/RELEASES.json');
    for (const url of ['http://updates.example.test', 'https://u:p@example.test/path', 'https://example.test/?token=x']) {
        assert.throws(() => feedLocation(url, arch));
    }
    assert.throws(() => feedLocation(base, 'ia32'));
    for (const changes of [{ url: 'https://other.example.test/z.zip' }, { arch: 'x64' }, { sha256: 'incomplete' }, { version: '0.5.0' }]) {
        assert.throws(() => selectRelease(manifest('0.3.0', changes), '0.2.0', arch, feed));
    }
    const duplicate = manifest();
    duplicate.releases.push(duplicate.releases[0]);
    assert.throws(() => selectRelease(duplicate, '0.2.0', arch, feed));
    assert.equal(selectRelease(manifest(), '0.3.0', arch, feed), null);
    assert.equal(selectRelease(manifest(), '0.10.0', arch, feed), null);
    assert.equal(selectRelease(manifest('0.10.0'), '0.3.0', arch, feed).version, '0.10.0');
    const legacy = manifest('0.7.0', { url: new URL('openspec-gui-0.7.0-darwin-arm64.zip', feed).href });
    assert.equal(selectRelease(legacy, '0.6.0', arch, feed).version, '0.7.0');
    assert.equal(selectRelease(legacy, '0.8.0', arch, feed), null);
});

async function fixture(t) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'app-update-test-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const state = { index: manifest(), bytes, dialogs: [], fetches: [], native: 0, installs: 0, busy: false };
    const updater = new EventEmitter();
    updater.setFeedURL = options => { assert.equal(options.serverType, 'default'); state.feed = fileURLToPath(options.url); };
    updater.checkForUpdates = () => {
        state.native++;
        fs.readFile(state.feed, 'utf8').then(async text => {
            const zip = fileURLToPath(JSON.parse(text).url);
            assert.deepEqual(await fs.readFile(zip), bytes);
            if (state.signatureError) { updater.emit('error', new Error('代码签名无效')); }
            else { updater.emit('update-downloaded'); }
        }).catch(error => updater.emit('error', error));
    };
    updater.quitAndInstall = () => { state.installs++; };
    const options = {
        base, arch, temp, updater, version: '0.2.0', packaged: true, archiveBusy: () => state.busy,
        async fetch(url, request) {
            state.fetches.push(url);
            assert.equal(request.redirect, 'error');
            if (state.offline) { throw new Error('网络已断开'); }
            return new Response(url === feed.href ? JSON.stringify(state.index) : state.bytes);
        },
        async inspect(file, release) { assert.deepEqual(await fs.readFile(file), bytes); assert.equal(release.arch, arch); },
        async show(options) {
            state.dialogs.push(options);
            return { response: state.choice?.(options) ?? 0 };
        }
    };
    return { options, state, temp, service: new AppUpdates(options) };
}

test('未配置发行版和最新版本在后台保持安静，手动检查显示当前版本', async t => {
    const { service, options, state } = await fixture(t);
    options.base = '';
    await service.check(false);
    assert.equal(state.dialogs.length, 0);
    await service.check(true);
    assert.match(state.dialogs.at(-1).message, /未启用/);
    assert.deepEqual(state.fetches, []);
    options.base = base;
    state.index = manifest('0.2.0');
    await service.check(true);
    assert.match(state.dialogs.at(-1).message, /最新/);
    assert.deepEqual(state.fetches, [feed.href]);
});

test('后台与手动检查合并，失败保留当前版本，重试校验同一 ZIP 后按归档状态重启', async t => {
    const { service, state, temp } = await fixture(t);
    state.offline = true;
    await service.check(true);
    assert.match(state.dialogs.at(-1).detail, /网络/);
    state.offline = false;
    state.bytes = Buffer.from('damaged');
    const a = service.check(false);
    const b = service.check(true);
    assert.equal(a, b);
    await a;
    assert.match(state.dialogs.at(-1).detail, /SHA-256/);
    assert.equal(state.native, 0);
    assert.deepEqual(await fs.readdir(temp), []);
    state.bytes = bytes;
    state.signatureError = true;
    await service.check(true);
    assert.match(state.dialogs.at(-1).detail, /签名/);
    assert.equal(state.installs, 0);
    assert.deepEqual(await fs.readdir(temp), []);
    state.signatureError = false;
    state.busy = true;
    await service.check(true);
    assert.match(state.dialogs.at(-1).message, /归档/);
    assert.equal(state.installs, 0);
    assert.deepEqual(await fs.readdir(temp), []);
    const requests = state.fetches.length;
    state.busy = false;
    await service.check(true);
    assert.equal(state.fetches.length, requests);
    assert.equal(state.installs, 1);
});

test('推迟下载仅在手动重查或下一版本再显示，稍后重启不会主动退出', async t => {
    const { service, state } = await fixture(t);
    state.choice = () => 1;
    await service.check(false);
    await service.check(false);
    assert.equal(state.dialogs.length, 1);
    assert.equal(state.native, 0);
    state.choice = prompt => prompt.message.startsWith('可更新') ? 0 : 1;
    await service.check(true);
    assert.equal(state.native, 1);
    assert.equal(state.installs, 0);
    assert.ok(state.dialogs.at(-1).detail.includes('更新了团队目录'));
});

test('macOS 校验新旧品牌 ZIP 中的应用名称、版本和架构', { skip: process.platform !== 'darwin' }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-info-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const binary = Buffer.alloc(64);
    binary.writeUInt32LE(0xfeedfacf);
    binary.writeUInt32LE(0x0100000c, 4);
    for (const [slug, product] of [['agent-workbench', 'Agent Workbench'], ['openspec-gui', 'OpenSpec GUI']]) {
        const contents = path.join(dir, product + '.app', 'Contents');
        await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
        await fs.writeFile(path.join(contents, 'Info.plist'), JSON.stringify({
            CFBundleIdentifier: 'dev.openspec.gui', CFBundleShortVersionString: '0.8.0', CFBundleExecutable: product
        }));
        await fs.writeFile(path.join(contents, 'MacOS', product), binary);
        const zip = path.join(dir, slug + '.zip');
        execFileSync('/usr/bin/zip', ['-q', '-r', zip, product + '.app'], { cwd: dir });
        async function check(version, arch, name = slug) {
            const staged = await fs.mkdtemp(path.join(dir, 'stage-'));
            const file = path.join(staged, 'update.zip');
            await fs.copyFile(zip, file);
            const url = new URL(name + '-' + version + '-darwin-' + arch + '.zip', feed).href;
            await inspectBundle(file, { version, arch, url });
        }
        await check('0.8.0', 'arm64');
        await assert.rejects(check('0.8.0', 'x64'), /架构/);
        await assert.rejects(check('0.7.0', 'arm64'), /版本/);
        await assert.rejects(check('0.8.0', 'arm64', 'other-product'), /名称/);
        await assert.rejects(check('0.8.0', 'arm64', slug === 'openspec-gui' ? 'agent-workbench' : 'openspec-gui'), /Info.plist/);
    }
});
