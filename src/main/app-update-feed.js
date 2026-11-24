'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const command = promisify(execFile);
const metadata = require('../../package.json');
const releaseProducts = new Map([[metadata.name, metadata.productName], ['openspec-gui', 'OpenSpec GUI']]);

function releaseFilename(version, arch, slug = metadata.name) {
    return slug + '-' + version + '-darwin-' + arch + '.zip';
}

function feedLocation(base, arch) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('更新地址必须是 HTTPS 发布目录。');
    }
    if (!['arm64', 'x64'].includes(arch)) { throw new Error('没有适合此架构的更新包。'); }
    url.pathname = url.pathname.replace(/\/+$/, '') + '/darwin/' + arch + '/RELEASES.json';
    return url;
}

function versionParts(version) {
    if (typeof version !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
        throw new Error('更新索引中的版本号无效。');
    }
    return version.split('.').map(Number);
}

function selectRelease(index, current, arch, feed) {
    const target = versionParts(index?.currentRelease);
    const installed = versionParts(current);
    const position = target.findIndex((part, i) => part !== installed[i]);
    if (!Array.isArray(index.releases)) { throw new Error('版本索引缺少发布记录。'); }
    const entries = index.releases.filter(entry => entry?.version === index.currentRelease);
    if (entries.length !== 1) { throw new Error('版本索引没有唯一的当前发布记录。'); }
    const release = entries[0].updateTo;
    if (release?.version !== index.currentRelease || release.arch !== arch) {
        throw new Error('更新记录与所需版本或架构不匹配。');
    }
    const validUrl = Array.from(releaseProducts.keys()).some(slug =>
        release.url === new URL(releaseFilename(release.version, arch, slug), feed).href);
    if (!validUrl || typeof release.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(release.sha256)) {
        throw new Error('更新包的下载地址或 SHA-256 摘要无效。');
    }
    if (typeof release.notes !== 'string' || release.notes.length > 32000 ||
        typeof release.name !== 'string' || !release.name.trim() || release.name.length > 240 ||
        typeof release.pub_date !== 'string' || !Number.isFinite(Date.parse(release.pub_date))) {
        throw new Error('更新说明或发布日期无效。');
    }
    return position === -1 || target[position] < installed[position] ? null : release;
}

async function getResponse(fetch, url, milliseconds) {
    const response = await fetch(url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(milliseconds) });
    if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error('更新服务返回 HTTP ' + response.status + '。');
    }
    return response;
}

async function checkFeed({ fetch, base, arch, version }) {
    const url = feedLocation(base, arch);
    const response = await getResponse(fetch, url.href, 20000);
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
        size += part.length;
        if (size > 1024 * 1024) { throw new Error('更新索引超过大小限制。'); }
        parts.push(part);
    }
    let index;
    try { index = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new Error('无法读取更新索引。'); }
    return selectRelease(index, version, arch, url);
}

async function inspectBundle(zip, release) {
    const filename = path.posix.basename(new URL(release.url).pathname);
    const slug = Array.from(releaseProducts.keys()).find(key => filename === releaseFilename(release.version, release.arch, key));
    const product = releaseProducts.get(slug);
    if (!product) { throw new Error('更新包的名称与发布记录不匹配。'); }
    const app = product + '.app/Contents/';
    // 只检查固定包成员。签名验证与最终安装由系统更新组件接管。
    const { stdout: plist } = await command('/usr/bin/unzip', ['-p', zip, app + 'Info.plist'], { encoding: 'buffer', maxBuffer: 256 * 1024 });
    const file = path.join(path.dirname(zip), 'candidate.plist');
    await fsp.writeFile(file, plist, { mode: 0o600, flag: 'wx' });
    const { stdout: json } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { maxBuffer: 256 * 1024 });
    const info = JSON.parse(json);
    if (info.CFBundleIdentifier !== 'dev.openspec.gui' || info.CFBundleShortVersionString !== release.version || info.CFBundleExecutable !== product) {
        throw new Error('整包内的应用标识或版本与发布记录不匹配。');
    }
    const { stdout: binary } = await command('/usr/bin/unzip', ['-p', zip, app + 'MacOS/' + product], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const cpu = release.arch === 'arm64' ? 0x0100000c : 0x01000007;
    if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== cpu) {
        throw new Error('整包内的可执行文件与当前架构不匹配。');
    }
}

/** 下载到独占目录内的文件。仅将已经校验的本地副本交给 Squirrel。 */
async function stageRelease({ fetch, release, directory, inspect = inspectBundle }) {
    const response = await getResponse(fetch, release.url, 15 * 60 * 1000);
    const zip = path.join(directory, 'update.zip');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const measure = new Transform({
        transform(part, encoding, done) {
            size += part.length;
            if (size > 1024 * 1024 * 1024) { return done(new Error('更新包超过大小限制。')); }
            hash.update(part);
            done(null, part);
        }
    });
    await pipeline(response.body, measure, fs.createWriteStream(zip, { mode: 0o600, flags: 'wx' }));
    if (!size || hash.digest('hex') !== release.sha256) { throw new Error('更新包的 SHA-256 摘要与发布记录不匹配。'); }
    await inspect(zip, release);
    // Electron 43 内置 Squirrel 的文件 URL 读取单条更新对象。远端索引使用标准 RELEASES.json。
    const local = { version: release.version, name: release.name, notes: release.notes, pub_date: release.pub_date, url: pathToFileURL(zip).href };
    const manifest = path.join(directory, 'update.json');
    await fsp.writeFile(manifest, JSON.stringify(local), { flag: 'wx', mode: 0o600 });
    return pathToFileURL(manifest).href;
}

module.exports = { feedLocation, releaseFilename, selectRelease, checkFeed, stageRelease, inspectBundle };
