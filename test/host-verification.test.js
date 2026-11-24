'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { readHostVerification, readHookRecords } = require('../src/main/host-verification');

async function fixture(t) {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'host-verification-'));
    t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
    const project = { id: 'project-a', rootPath: path.join(userDataPath, 'project-a') };
    const dir = path.join(userDataPath, 'host-integration', 'receipts', project.id);
    const baseTime = Date.now() - 60_000;
    async function write(host, event, offset, data = {}) {
        const timestamp = baseTime + offset;
        const file = path.join(dir, host, timestamp + '-' + randomUUID() + '.json');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ schema: 1, checkVersion: '1.0.0',
            host, event, root: project.rootPath, projectId: project.id, timestamp: new Date(timestamp).toISOString(),
            decision: 'skipped', reason: '此工作树和宿主没有生效绑定', bindings: [], ...data }), { mode: 0o600 });
        return file;
    }
    return { write, userDataPath, project, baseTime, dir, read: sinceByHost => readHostVerification({ userDataPath, project, sinceByHost }) };
}

test('从既有回执分别取得三个宿主最新的原生事件，只向界面提供摘要，并按接入时间过滤', async t => {
    const f = await fixture(t);
    await f.write('dsh', 'tools.guard', 10);
    await f.write('dsh', 'system-prompt/assemble', 20);
    await f.write('dsh', 'system-prompt/assemble', 30, { decision: 'error', reason: '读取失败' });
    await f.write('codex', 'SessionStart', 40, { decision: 'context', bindings: [{ id: 'rule', version: '1.0.0' }] });
    await f.write('claude', 'PreToolUse', 50, { decision: 'deny' });
    const observed = await f.read();
    assert.deepEqual(observed.dsh['system-prompt/assemble'], {
        timestamp: new Date(f.baseTime + 30).toISOString(), decision: 'error', reason: '读取失败'
    });
    assert.equal(observed.dsh['tools.guard'].decision, 'skipped');
    assert.equal(observed.codex.SessionStart.decision, 'context');
    assert.equal(observed.claude.PreToolUse.decision, 'deny');
    const changed = await f.read({ dsh: new Date(f.baseTime + 21).toISOString(), claude: f.baseTime + 51, codex: 'unknown' });
    assert.deepEqual(changed, { codex: {}, claude: {}, dsh: { 'system-prompt/assemble': observed.dsh['system-prompt/assemble'] } });
    await f.write('dsh', 'tools.guard', 60, { decision: 'pass' });
    assert.equal((await f.read()).dsh['tools.guard'].decision, 'pass');
});

test('拒绝跨工作树、错宿主、非可用版本、事件结果不配对和错误时间的回执', async t => {
    const f = await fixture(t);
    const overrides = [
        { root: path.join(f.userDataPath, 'different') }, { projectId: 'different' }, { host: 'claude' },
        { schema: 2 }, { checkVersion: '2.0.0' }, { event: 'PreToolUse' }, { decision: 'context' }, { bindings: null },
        { timestamp: '2000-01-01T00:00:00.000Z' }
    ];
    for (const [index, data] of overrides.entries()) { await f.write('dsh', 'tools.guard', index + 1, data); }
    await f.write('dsh', 'tools.guard', 3_600_000);
    const broken = await f.write('dsh', 'tools.guard', 100);
    await fs.writeFile(broken, '{');
    assert.deepEqual(await f.read(), { codex: {}, claude: {}, dsh: {} });
});

test('宿主目录尚未生成时无证据，新文件无权读取时将该宿主标为待核对', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.read(), { codex: {}, claude: {}, dsh: {} });
    const older = await f.write('dsh', 'tools.guard', 10);
    await f.write('dsh', 'system-prompt/assemble', 20);
    assert.equal((await f.read()).dsh['tools.guard'].decision, 'skipped');
    const blocked = await f.write('dsh', 'tools.guard', 15);
    const canonicalBlocked = await fs.realpath(blocked);
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, ...options) => {
        if (file === canonicalBlocked) { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); }
        return open(file, ...options);
    });
    assert.deepEqual(await f.read(), { codex: {}, claude: {}, dsh: null });
    assert.equal(await fs.stat(older).then(info => info.isFile()), true);
});

test('目录或回执替换后丢弃旧缓存，忽略软链接指向的回执', async t => {
    const f = await fixture(t);
    const file = await f.write('dsh', 'tools.guard', 10);
    assert.equal((await f.read()).dsh['tools.guard'].decision, 'skipped');
    const saved = path.join(f.userDataPath, 'saved.json');
    await fs.rename(file, saved);
    await fs.symlink(saved, file);
    assert.deepEqual((await f.read()).dsh, {});
    await fs.unlink(file);
    await fs.rename(saved, file);
    const dir = path.join(f.dir, 'dsh');
    const moved = path.join(f.userDataPath, 'moved');
    await fs.rename(dir, moved);
    await fs.symlink(moved, dir);
    assert.deepEqual((await f.read()).dsh, {});
    assert.deepEqual(await readHostVerification({ userDataPath: f.userDataPath, project: { ...f.project, id: '../another' } }),
        { codex: {}, claude: {}, dsh: {} });
});

test('档案按名称时间、UUID 和宿主稳定排序；每页仅读入 20 份回执且锚点滚动后可继续', async t => {
    const f = await fixture(t);
    const sameTime = 10;
    const codex = await f.write('codex', 'SessionStart', sameTime);
    const claude = await f.write('claude', 'PreToolUse', sameTime);
    await fs.rename(claude, path.join(path.dirname(claude), path.basename(codex)));
    for (let i = 11; i < 43; i++) { await f.write('dsh', 'tools.guard', i); }
    const open = fs.open;
    let opened = 0;
    t.mock.method(fs, 'open', (...args) => { opened++; return open(...args); });
    const first = await readHookRecords(f);
    assert.equal(opened, 20);
    assert.equal(first.rows.length, 20);
    assert.equal(first.nextCursor, first.rows.at(-1).id);
    const last = first.rows.at(-1);
    await fs.unlink(path.join(f.dir, last.host, last.id.split('.')[0] + '.json'));
    await f.write('dsh', 'tools.guard', 101);
    const next = await readHookRecords({ ...f, cursor: first.nextCursor });
    assert.equal(next.rows.length, 14);
    assert.deepEqual(next.rows.slice(-2).map(row => row.host), ['codex', 'claude']);
    assert.equal(new Set([...first.rows, ...next.rows].map(row => row.id)).size, 34);
    assert.ok(next.rows.every(row => row.id < first.nextCursor));
    assert.equal(next.nextCursor, null);
});

test('历史保留原检查版本与绑定，裁剪额外字段，只显示匹配项目和指定宿主', async t => {
    const f = await fixture(t);
    await f.write('dsh', 'tools.guard', 10, {
        checkVersion: '0.9.0', bindings: [{ id: 'portable-paths', version: '1.0.0', privateValue: 'extra-binding' }],
        reason: '已执行检查', decision: 'pass', extra: 'extra-field'
    });
    await f.write('dsh', 'tools.guard', 11, { root: '/wrong-tree' });
    await f.write('dsh', 'tools.guard', 12, { projectId: 'other-checkout' });
    await f.write('dsh', 'tools.guard', 13, { bindings: [{ id: 'invalid/id', version: '1.0.0' }] });
    await f.write('claude', 'SessionStart', 14);
    const { rows, unavailableHosts } = await readHookRecords({ ...f, host: 'dsh' });
    assert.equal(rows.length, 1);
    assert.deepEqual(unavailableHosts, []);
    const { id, ...summary } = rows[0];
    assert.equal(id.endsWith('.dsh'), true);
    assert.deepEqual(summary, { host: 'dsh', event: 'tools.guard', timestamp: new Date(f.baseTime + 10).toISOString(),
        decision: 'pass', reason: '已执行检查', checkVersion: '0.9.0', bindings: [{ id: 'portable-paths', version: '1.0.0' }] });
    assert.deepEqual((await f.read()).dsh, {});
    await assert.rejects(readHookRecords({ ...f, host: '../claude' }), /参数无效/);
    await assert.rejects(readHookRecords({ ...f, host: 'claude', cursor: id }), /参数无效/);
    await assert.rejects(readHookRecords({ ...f, cursor: '../unsafe' }), /参数无效/);
    await assert.rejects(readHookRecords({ ...f, project: { ...f.project, id: '../wrong' } }), /参数无效/);
});

test('列表跳过损坏或链接回执，保留可读宿主记录并指出权限故障的宿主', async t => {
    const f = await fixture(t);
    const bad = await f.write('dsh', 'tools.guard', 11);
    await fs.writeFile(bad, '{');
    const link = await f.write('dsh', 'tools.guard', 12);
    await fs.unlink(link);
    await fs.symlink(bad, link);
    const blocked = await f.write('dsh', 'system-prompt/assemble', 13);
    await f.write('claude', 'PreToolUse', 14);
    const open = fs.open;
    const actual = await fs.realpath(blocked);
    t.mock.method(fs, 'open', (...args) => {
        if (args[0] === actual) { throw Object.assign(new Error('权限故障'), { code: 'EACCES' }); }
        return open(...args);
    });
    const result = await readHookRecords(f);
    assert.deepEqual(result.rows.map(row => row.host), ['claude']);
    assert.deepEqual(result.unavailableHosts, ['dsh']);
    assert.equal(result.nextCursor, null);
});

test('工具检查明确超时可见于项目历史及最近触发摘要', async t => {
    const f = await fixture(t);
    await f.write('claude', 'PreToolUse', 1, { decision: 'timeout', reason: '路径检查超时' });
    const history = await readHookRecords(f);
    assert.equal(history.rows[0].decision, 'timeout');
    assert.equal((await f.read()).claude.PreToolUse.decision, 'timeout');
});
