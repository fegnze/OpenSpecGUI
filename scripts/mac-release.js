'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { verifyPackage } = require('./verify-package');
const { feedLocation, releaseFilename, selectRelease } = require('../src/main/app-update-feed');
const pkg = require('../package.json');

const architectures = ['arm64', 'x64'];
const project = path.join(__dirname, '..');
const out = path.join(project, 'out');

function releaseSettings(env) {
    const base = new URL(env.OPENSPEC_GUI_UPDATE_URL || 'about:blank');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
        throw new Error('OPENSPEC_GUI_UPDATE_URL 须为固定 HTTPS 基址。');
    }
    const identity = (env.OPENSPEC_GUI_SIGN_IDENTITY || '').trim();
    const profile = (env.OPENSPEC_GUI_NOTARY_PROFILE || '').trim();
    const notes = (env.OPENSPEC_GUI_RELEASE_NOTES || '').trim();
    if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity) || !profile || !notes) {
        throw new Error('正式发行需要完整的 Developer ID Application 身份、notarytool 钥匙串配置名和更新说明。');
    }
    return { base: base.href.replace(/\/+$/, ''), identity, profile, notes };
}

async function digest(stream) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

function systemTool(command, args) {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 300000 }).trim();
}

// 验证最终 ZIP 中实际会安装的内容。源 ZIP 只来自本机 Forge 构建。
async function verifyZip(zip, arch, config) {
    const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-release-'));
    try {
        const bundleDir = path.join(temporary, pkg.productName + '-darwin-' + arch);
        await fsp.mkdir(bundleDir);
        systemTool('/usr/bin/ditto', ['-x', '-k', zip, bundleDir]);
        const { appPath, asarPath } = verifyPackage({ projectRoot: project, outputRoot: temporary, arch });
        const plist = path.join(appPath, 'Contents/Info.plist');
        const plistValue = key => systemTool('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
        const metadata = JSON.parse(asar.extractFile(asarPath, 'package.json'));
        if (plistValue('CFBundleIdentifier') !== 'dev.openspec.gui' ||
            plistValue('CFBundleShortVersionString') !== pkg.version ||
            metadata.version !== pkg.version || metadata.openspecGUIUpdateBaseURL !== config.base) {
            throw new Error('ZIP 内的应用标识、版本或更新地址不匹配。');
        }
        const binary = path.join(appPath, 'Contents/MacOS', pkg.productName);
        if (systemTool('/usr/bin/lipo', ['-archs', binary]) !== (arch === 'x64' ? 'x86_64' : 'arm64')) {
            throw new Error('ZIP 的 CPU 架构与目标目录不匹配。');
        }
        // 通过 Apple 的信任锚、Developer ID Application 证书扩展与团队 ID 验证签发者。
        const team = config.identity.match(/\(([A-Z0-9]{10})\)$/)[1];
        const requirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "' + team + '"';
        systemTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R=' + requirement, appPath]);
        systemTool('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    } finally {
        await fsp.rm(temporary, { recursive: true, force: true });
    }
}

async function remoteDigest(url) {
    const res = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(300000) });
    if (res.status !== 200 || !res.body) throw new Error('发行包下载检查失败，HTTP ' + res.status);
    return digest(res.body);
}

async function readIndex(file) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

// 同一路径仅发布一次内容。断线后的重试可复用上一轮已经就绪的 ZIP。
async function exposeZip(source, destination, expected) {
    try {
        await fsp.link(source, destination);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await digest(fs.createReadStream(destination)) !== expected) {
            throw new Error('同版本的发行包已存在且内容不同，请递增版本号。');
        }
    }
}

async function distribute({ root, sourceZip, version, config, verify = verifyZip, checkDownload }) {
    await fsp.mkdir(root, { recursive: true });
    const lock = path.join(root, '.openspec-gui-release-lock');
    await fsp.mkdir(lock, { mode: 0o700 });
    try {
        const pending = [];
        for (const arch of architectures) {
            const dir = path.join(root, 'darwin', arch);
            const index = path.join(dir, 'RELEASES.json');
            const previous = await readIndex(index);
            const feed = feedLocation(config.base, arch);
            if (previous && selectRelease(previous, version, arch, feed)) {
                throw new Error('更新索引已有更高版本。');
            }
            const filename = releaseFilename(version, arch);
            const copy = path.join(lock, filename);
            await fsp.copyFile(sourceZip(arch), copy);
            await verify(copy, arch, config);
            const sha256 = await digest(fs.createReadStream(copy));
            const url = config.base + '/darwin/' + arch + '/' + filename;
            const updateTo = { name: pkg.productName + ' ' + version, version, arch, sha256, url,
                notes: config.notes, pub_date: new Date().toISOString() };
            const existing = previous && previous.currentRelease === version;
            if (existing && !previous.releases.some(r => r.version === version &&
                r.updateTo.sha256 === sha256 && r.updateTo.url === url && r.updateTo.notes === config.notes)) {
                throw new Error('索引中已有该版本的其他发行内容。');
            }
            const next = { currentRelease: version, releases: [{ version, updateTo }] };
            selectRelease(next, version, arch, feed);
            const stagedIndex = path.join(lock, arch + '.json');
            await fsp.writeFile(stagedIndex, JSON.stringify(next, null, 2) + '\n');
            await fsp.mkdir(dir, { recursive: true });
            pending.push({ copy, file: path.join(dir, filename), index, stagedIndex, sha256, url, existing });
        }
        for (const item of pending) {
            await exposeZip(item.copy, item.file, item.sha256);
            if (checkDownload && await checkDownload(item.url) !== item.sha256) {
                throw new Error('线上 ZIP 的 SHA-256 与发行包不匹配。');
            }
        }
        for (const item of pending) {
            if (!item.existing) await fsp.rename(item.stagedIndex, item.index);
        }
    } finally {
        await fsp.rm(lock, { recursive: true, force: true });
    }
}

async function run(mode) {
    if (!['build', 'publish'].includes(mode)) throw new Error('使用 build 或 publish。');
    const config = releaseSettings(process.env);
    const version = pkg.version;
    const stage = path.join(out, 'release', version);
    if (mode === 'build') {
        for (const arch of architectures) {
            const result = spawnSync('npm', ['run', 'make:mac:' + arch], {
                cwd: project, stdio: 'inherit', env: { ...process.env, OPENSPEC_GUI_RELEASE_BUILD: '1' }
            });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error('构建失败 ' + arch);
        }
        await distribute({ root: stage, version, config, sourceZip: arch => path.join(out, 'make/zip/darwin', arch,
            pkg.productName + '-darwin-' + arch + '-' + version + '.zip') });
        console.log('发行候选已验证 ' + stage);
    } else {
        const webroot = process.env.OPENSPEC_GUI_RELEASE_WEBROOT;
        if (!webroot || !path.isAbsolute(webroot) || !(await fsp.stat(webroot)).isDirectory()) {
            throw new Error('OPENSPEC_GUI_RELEASE_WEBROOT 须指向已挂载的静态站点目录。');
        }
        await distribute({ root: webroot, version, config, checkDownload: remoteDigest,
            sourceZip: arch => path.join(stage, 'darwin', arch, releaseFilename(version, arch)) });
        console.log('两个架构均已发布 ' + version);
    }
}

if (require.main === module) run(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = { releaseSettings, distribute, digest };
