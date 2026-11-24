'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { digest, readSource } = require('../src/main/capability-source');
const { materialize, resolveMaterializedEntry } = require('../src/main/capability-materializer');

async function setup(t) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-version-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    return { base, root: path.join(base, 'user-data', 'capabilities') };
}

function snapshot(files, source = 'SKILL.md') {
    const rows = files.map(([name, content, executable = false]) => ({
        path: name, executable, data: Buffer.from(content).toString('base64')
    }));
    return { source, files: rows, digest: digest(JSON.stringify(rows)) };
}

test('完整 Skill 版本并发接入只发布一次，脚本和引用文档按原结构及权限提供', async t => {
    const { root, base } = await setup(t);
    const src = path.join(base, 'source');
    await fs.mkdir(path.join(src, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: fixture\ndescription: 测试\n---\n参阅 scripts/check。');
    await fs.writeFile(path.join(src, 'scripts', 'check'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const retained = await readSource('skill', path.join(src, 'SKILL.md'));
    await fs.rm(src, { recursive: true });
    const input = { root, snapshot: retained, kind: 'skill' };
    assert.equal(await resolveMaterializedEntry(input), null);
    await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
    const paths = await Promise.all(Array.from({ length: 12 }, () => materialize(input)));
    const [entry] = paths;
    assert.equal(new Set(paths).size, 1);
    const versionDir = path.dirname(entry);
    assert.equal(path.basename(versionDir), retained.digest);
    assert.deepEqual(await fs.readdir(path.dirname(versionDir)), [retained.digest]);
    assert.equal(path.basename(entry), 'SKILL.md');
    assert.equal((await fs.stat(entry)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(versionDir, 'scripts/check'))).mode & 0o777, 0o700);
    assert.equal(await fs.readFile(path.join(versionDir, 'scripts/check'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(await resolveMaterializedEntry(input), entry);
    const newer = { root, snapshot: snapshot([['SKILL.md', 'next']]), kind: 'skill' };
    assert.notEqual(await materialize(newer), entry);
    assert.equal(await resolveMaterializedEntry(input), entry);
});

test('单文件规则和工具返回对应本机入口，服务或宿主工具没有本机文件入口', async t => {
    const { root } = await setup(t);
    for (const [kind, filename, executable] of [['rule', '工程规则.md', false], ['tool', 'check.py', true]]) {
        const input = { root, kind, snapshot: snapshot([[filename, 'test', executable]], '/previous/' + filename) };
        const entry = await materialize(input);
        assert.equal(path.basename(entry), filename);
        assert.equal((await fs.stat(entry)).mode & 0o111, executable ? 0o100 : 0);
    }
    const remote = { source: 'https://example.invalid/mcp', files: [], digest: digest('https://example.invalid/mcp') };
    assert.equal(await materialize({ root, kind: 'mcp', snapshot: remote }), null);
    assert.equal(await resolveMaterializedEntry({ root, kind: 'tool', snapshot: remote }), null);
});

test('拒绝路径碰撞、逃逸、损坏快照、被改动的文件和目录，无条件读取不执行安装', async t => {
    const { root, base } = await setup(t);
    for (const extra of ['../outside', '/tmp/outside', 'a//b', '.git/config', 'dir/../evil', 'dir\\escape']) {
        await assert.rejects(materialize({ root, kind: 'skill', snapshot: snapshot([['SKILL.md', 'doc'], [extra, 'x']]) }));
    }
    for (const ambiguous of [['a', 'a/b'], ['a/b', 'a'], ['A/b', 'a/c'], ['a', 'a']]) {
        const input = { root, kind: 'skill', snapshot: snapshot([['SKILL.md', 'doc'], ...ambiguous.map(name => [name, 'x'])]) };
        await assert.rejects(materialize(input));
    }
    const input = { root, kind: 'skill', snapshot: snapshot([['SKILL.md', 'doc'], ['scripts/main', 'run', true]]) };
    await assert.rejects(materialize({ ...input, snapshot: { ...input.snapshot, digest: '0'.repeat(64) } }));
    const entry = await materialize(input);
    const dir = path.dirname(entry);
    const script = path.join(dir, 'scripts/main');
    await fs.writeFile(entry, 'bad');
    await assert.rejects(materialize(input), /不符合/);
    assert.equal(await fs.readFile(entry, 'utf8'), 'bad');
    await fs.writeFile(entry, 'doc');
    await fs.chmod(script, 0o600);
    await assert.rejects(resolveMaterializedEntry(input), /不符合/);
    await fs.chmod(script, 0o700);
    await fs.writeFile(path.join(dir, 'unexpected'), 'new');
    await assert.rejects(resolveMaterializedEntry(input), /不符合/);
    await fs.unlink(path.join(dir, 'unexpected'));
    await fs.unlink(script);
    await fs.symlink(entry, script);
    await assert.rejects(resolveMaterializedEntry(input));
    await fs.rm(path.join(dir, 'scripts'), { recursive: true });
    await fs.symlink(base, path.join(dir, 'scripts'));
    await assert.rejects(materialize(input));
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    const escape = path.join(base, 'linked-root');
    await fs.symlink(outside, escape);
    await assert.rejects(materialize({ ...input, root: escape }), /不符合/);
    await assert.rejects(materialize({ ...input, root: path.join(escape, 'capabilities') }), /不符合/);
    assert.deepEqual(await fs.readdir(outside), []);
});
