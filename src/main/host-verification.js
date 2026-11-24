'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const serviceEvents = {
    codex: ['SessionStart', 'PreToolUse'],
    claude: ['SessionStart', 'PreToolUse'],
    dsh: ['system-prompt/assemble', 'tools.guard']
};
const receiptName = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
const summaries = new Map();

function validProject(project) {
    return project && typeof project.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(project.id) &&
        typeof project.rootPath === 'string' && path.isAbsolute(project.rootPath);
}

function validVersion(value) {
    return typeof value === 'string' && value.length <= 128 && versionPattern.test(value);
}

function parseReceipt(bytes, timestamp, project, host) {
    const data = JSON.parse(bytes);
    const events = serviceEvents[host];
    if (data?.schema !== 1 || !validVersion(data.checkVersion) ||
        data.host !== host || data.projectId !== project.id || data.root !== project.rootPath ||
        data.timestamp !== new Date(timestamp).toISOString() || !events.includes(data.event) ||
        typeof data.reason !== 'string' || data.reason.length > 512 || !Array.isArray(data.bindings)) { return; }
    const outcomes = data.event === events[0] ? ['context', 'error', 'skipped'] : ['pass', 'deny', 'error', 'timeout', 'skipped'];
    if (!outcomes.includes(data.decision) || !data.bindings.every(binding =>
        typeof binding?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.id) && validVersion(binding.version))) { return; }
    return {
        event: data.event, checkVersion: data.checkVersion,
        bindings: data.bindings.map(({ id, version }) => ({ id, version })),
        summary: { timestamp: data.timestamp, decision: data.decision, reason: data.reason }
    };
}

async function readSummary(file, timestamp, project, host) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o022) || info.size > 64 * 1024) { return; }
        const signature = [info.dev, info.ino, info.ctimeMs, info.size, project.rootPath].join('|');
        const cached = summaries.get(file);
        if (cached?.signature === signature) { return cached.value; }
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== info.size) { return; }
        const value = parseReceipt(buffer.toString('utf8', 0, bytesRead), timestamp, project, host);
        // 保存轻量摘要。下次同名文件被替换、编辑或项目根目录变化时重新核对。
        summaries.set(file, { signature, value });
        if (summaries.size > 768) { summaries.delete(summaries.keys().next().value); }
        return value;
    } catch (error) {
        // 滚动清理、外部链接及坏 JSON 可以跳过，读取权限或 I/O 错误需要界面提示。
        if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP'].includes(error.code)) { throw error; }
    } finally { if (handle) { await handle.close(); } }
}

async function receiptNames(dir) {
    if (await fs.realpath(dir) !== dir) { return []; }
    const now = Date.now();
    return (await fs.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && receiptName.test(entry.name) && Number(entry.name.slice(0, 13)) <= now)
        .map(entry => entry.name).sort().reverse().slice(0, 256);
}

async function hostEvents(projectDir, project, host, since) {
    const result = {};
    const earliest = typeof since === 'string' ? Date.parse(since) : since ?? 0;
    if (!Number.isFinite(earliest)) { return result; }
    const dir = path.join(projectDir, host);
    try {
        for (const name of await receiptNames(dir)) {
            const timestamp = Number(name.slice(0, 13));
            if (timestamp < earliest) { break; }
            const receipt = await readSummary(path.join(dir, name), timestamp, project, host);
            if (receipt?.checkVersion !== '1.0.0' || Object.hasOwn(result, receipt.event)) { continue; }
            result[receipt.event] = receipt.summary;
            if (Object.keys(result).length === serviceEvents[host].length) { break; }
        }
    } catch (error) {
        return ['ENOENT', 'ELOOP'].includes(error.code) ? {} : null;
    }
    return result;
}

/** 返回当前登记工作树中，各宿主两种原生事件最近一次可信回执的摘要。 */
async function readHostVerification({ userDataPath, project, sinceByHost = {} }) {
    const result = { codex: {}, claude: {}, dsh: {} };
    if (!validProject(project)) { return result; }
    let base;
    try { base = await fs.realpath(userDataPath); }
    catch (error) { return error.code === 'ENOENT' ? result : { codex: null, claude: null, dsh: null }; }
    const dir = path.join(base, 'host-integration', 'receipts', project.id);
    await Promise.all(Object.keys(result).map(async host => {
        result[host] = await hostEvents(dir, project, host, sinceByHost[host]);
    }));
    return result;
}

function validCursor(cursor, host) {
    if (typeof cursor !== 'string') { return false; }
    const [stem, scope, ...extra] = cursor.split('.');
    return !extra.length && receiptName.test(stem + '.json') && Object.hasOwn(serviceEvents, scope) &&
        (host === 'all' || host === scope);
}

/** 按项目合并各宿主保留的历史。分页游标仅参与排序，文件路径来自目录枚举。 */
async function readHookRecords({ userDataPath, project, host = 'all', cursor }) {
    if (!validProject(project) || typeof host !== 'string' || host !== 'all' && !Object.hasOwn(serviceEvents, host) ||
        cursor != null && !validCursor(cursor, host)) { throw new Error('项目回执查询参数无效。'); }
    const hosts = host === 'all' ? Object.keys(serviceEvents) : [host];
    const result = { projectId: project.id, rows: [], nextCursor: null, unavailableHosts: [] };
    let base;
    try { base = await fs.realpath(userDataPath); }
    catch (error) {
        if (error.code !== 'ENOENT') { result.unavailableHosts = hosts; }
        return result;
    }
    const unavailable = new Set();
    const groups = await Promise.all(hosts.map(async scope => {
        const dir = path.join(base, 'host-integration', 'receipts', project.id, scope);
        try {
            return (await receiptNames(dir)).map(name => ({
                id: name.slice(0, -5) + '.' + scope, host: scope, name, file: path.join(dir, name)
            }));
        } catch (error) {
            if (!['ENOENT', 'ELOOP'].includes(error.code)) { unavailable.add(scope); }
            return [];
        }
    }));
    // 毫秒 + UUID + 宿主构成稳定总序。翻页期间即使锚点被轮转，仍可从它原先的位置继续。
    const candidates = groups.flat().filter(item => !cursor || item.id < cursor)
        .sort((left, right) => left.id < right.id ? 1 : -1);
    for (const item of candidates) {
        if (result.rows.length === 20) {
            result.nextCursor = result.rows.at(-1).id;
            break;
        }
        let record;
        try { record = await readSummary(item.file, Number(item.name.slice(0, 13)), project, item.host); }
        catch { unavailable.add(item.host); continue; }
        if (record) {
            result.rows.push({ id: item.id, host: item.host, event: record.event, ...record.summary,
                checkVersion: record.checkVersion, bindings: record.bindings });
        }
    }
    result.unavailableHosts = hosts.filter(scope => unavailable.has(scope));
    return result;
}

module.exports = { readHostVerification, readHookRecords };
