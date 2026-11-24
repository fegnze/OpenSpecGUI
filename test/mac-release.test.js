'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseSettings, distribute } = require('../scripts/mac-release');

test('正式发行构建要求凭据、说明和固定 HTTPS 地址', () => {
    const env = { OPENSPEC_GUI_SIGN_IDENTITY: 'Developer ID Application: Example (12345ABCDE)',
        OPENSPEC_GUI_NOTARY_PROFILE: 'release', OPENSPEC_GUI_RELEASE_NOTES: '目录更新',
        OPENSPEC_GUI_UPDATE_URL: 'https://example.test/updates/' };
    assert.equal(releaseSettings(env).base, 'https://example.test/updates');
    for (const key of Object.keys(env)) assert.throws(() => releaseSettings({ ...env, [key]: '' }));
    assert.throws(() => releaseSettings({ ...env, OPENSPEC_GUI_UPDATE_URL: 'http://example.test' }));
});

test('实际分发目录先放齐可验证的版本包，失败保留旧索引并支持重试', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-distribute-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = path.join(temp, 'web');
    const archs = ['arm64', 'x64'];
    const getIndex = arch => fs.readFile(path.join(root, 'darwin', arch, 'RELEASES.json'), 'utf8');
    const pkg = arch => path.join(temp, arch + '.zip');
    const config = { base: 'https://example.test/team', notes: '能力目录更新' };
    async function verify(file, arch) {
        assert.equal(await fs.readFile(file, 'utf8'), arch);
    }
    const version1 = { root, sourceZip: pkg, config, verify, version: '0.1.0' };
    const version2 = { ...version1, version: '0.2.0' };
    for (const arch of archs) await fs.writeFile(pkg(arch), arch);
    await distribute(version1);
    const previous = await Promise.all(archs.map(getIndex));

    await fs.unlink(pkg('x64'));
    await assert.rejects(distribute(version2), { code: 'ENOENT' });
    await fs.writeFile(pkg('x64'), 'wrong-arch');
    await assert.rejects(distribute(version2));
    assert.deepEqual(await Promise.all(archs.map(getIndex)), previous);
    await fs.writeFile(pkg('x64'), 'x64');
    await assert.rejects(distribute({ ...version2, checkDownload: async () => 'bad' }), /SHA-256/);
    assert.deepEqual(await Promise.all(archs.map(getIndex)), previous);
    let checked = [];
    async function readOnline(url) {
        assert.deepEqual(await Promise.all(archs.map(getIndex)), previous);
        const relative = new URL(url).pathname.slice('/team/'.length);
        checked.push(relative);
        return crypto.createHash('sha256').update(await fs.readFile(path.join(root, relative))).digest('hex');
    }
    // 两架构之间中断时，已切换的一侧仍指向有效 ZIP，下一次重试可补齐另一侧。
    const originalRename = fs.rename.bind(fs);
    const interrupted = t.mock.method(fs, 'rename', async (from, to) => {
        if (to.endsWith('/x64/RELEASES.json')) throw new Error('模拟站点卷写入中断');
        return originalRename(from, to);
    });
    await assert.rejects(distribute({ ...version2, checkDownload: readOnline }), /写入中断/);
    interrupted.mock.restore();
    assert.equal(JSON.parse(await getIndex('arm64')).currentRelease, version2.version);
    assert.equal(await getIndex('x64'), previous[1]);
    await distribute(version2);
    assert.deepEqual(checked, archs.map(a => 'darwin/' + a + '/agent-workbench-0.2.0-darwin-' + a + '.zip'));
    const published = await Promise.all(archs.map(getIndex));
    for (const [i, json] of published.entries()) {
        const index = JSON.parse(json);
        assert.equal(index.currentRelease, version2.version);
        assert.equal(index.releases[0].updateTo.arch, archs[i]);
        assert.equal(index.releases[0].updateTo.notes, config.notes);
    }
    await distribute(version2);
    await assert.rejects(distribute(version1), /更高版本/);
    assert.deepEqual(await Promise.all(archs.map(getIndex)), published);
});
