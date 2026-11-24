'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { fileURLToPath } = require('node:url');
const { setTimeout: wait } = require('node:timers/promises');
const YAML = require('yaml');
const { readJson, writeJson, resolveConfigDirectory } = require('./local-config');

const events = ['system-prompt/assemble', 'tools.guard'];
const patchName = 'cordis.patch.yml';
const pluginId = 'openspec-gui-workbench';
const limit = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const error = message => Object.assign(new Error(message), { code: 'HOST_REGISTRATION_ERROR' });
const conflict = () => error('DeepSeek Harness 的工作台插件登记有冲突，请核对 desktop profile 后重试。');
const invalid = () => error('无法安全读取 DeepSeek Harness 的 cordis.patch.yml，请检查 YAML 格式、文件类型及权限。');

function parse(text) {
    // 保留具体语法树和偏移量，修改时只拼接目标段，不重新序列化包含凭据或自定义标签的其他插件。
    const options = { keepSourceTokens: true, logLevel: 'silent' };
    const documents = YAML.parseAllDocuments(text, options);
    if (documents.length > 1) { throw invalid(); }
    const document = documents[0] || YAML.parseDocument(text, options);
    const root = document.contents;
    if (document.errors.length || (root && !YAML.isSeq(root) && !(YAML.isScalar(root) && root.source === '' && root.value === null))) {
        throw invalid();
    }
    return document;
}

async function profileDirectory(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== patchName) { throw invalid(); }
    const directory = path.dirname(file);
    // adapter 已解析至真实目录；复检防止原目录在接入后被符号链接替换。
    try {
        if (await resolveConfigDirectory(directory) !== directory) { throw invalid(); }
    } catch { throw invalid(); }
    return directory;
}

async function snapshot(file) {
    await profileDirectory(file);
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) { throw invalid(); }
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) { break; }
            length += bytesRead;
        }
        if (length !== stat.size) { throw invalid(); }
        const content = bytes.subarray(0, length);
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
        return { text, document: parse(text), mode: stat.mode & 0o777, signature: [stat.dev, stat.ino, stat.mode, digest(content)].join('/') };
    } catch (reason) {
        if (reason.code === 'ENOENT') { return { text: '', document: parse(''), mode: 0o600, signature: null }; }
        throw invalid();
    } finally { if (handle) { await handle.close(); } }
}

function checkEntry(entry, runnerPath) {
    if (entry?.id !== pluginId || typeof entry.name !== 'string' || !path.isAbsolute(entry.name) ||
        typeof runnerPath !== 'string' || !path.isAbsolute(runnerPath) ||
        !isDeepStrictEqual(entry, { id: pluginId, name: entry.name, config: { runnerPath } })) { throw invalid(); }
}

function refersToModule(specifier, expected, directory) {
    if (typeof specifier !== 'string') { return false; }
    if (specifier.startsWith('file:')) {
        try { return path.normalize(fileURLToPath(specifier)) === expected; }
        catch { return false; }
    }
    if (path.isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
        return path.resolve(directory, specifier) === expected;
    }
    return false;
}

function lookup(document, entry, targetPath) {
    const root = document.contents;
    let match = null;
    if (!YAML.isSeq(root)) { return { status: 'missing' }; }
    const identity = (node, key) => {
        const value = node.get(key, true);
        return YAML.isAlias(value) ? value.resolve(document)?.value : value?.value;
    };
    const directory = path.dirname(targetPath);
    const refersToEntry = node => identity(node, 'id') === pluginId || refersToModule(identity(node, 'name'), entry.name, directory);
    function groupContainsEntry(node) {
        const children = node.get('config', true);
        if (!node.get('group') || !YAML.isSeq(children)) { return false; }
        return children.items.some(child => {
            if (!YAML.isMap(child)) { throw invalid(); }
            return refersToEntry(child) || groupContainsEntry(child);
        });
    }
    for (const [index, step] of root.items.entries()) {
        if (!YAML.isMap(step)) { throw invalid(); }
        if (refersToEntry(step) || groupContainsEntry(step)) { return { status: 'conflict' }; }
        const inserts = step.get('insert', true);
        if (!inserts) { continue; }
        if (!YAML.isSeq(inserts)) { throw invalid(); }
        for (const node of inserts.items) {
            if (!YAML.isMap(node)) { throw invalid(); }
            if (groupContainsEntry(node)) { return { status: 'conflict' }; }
            if (!refersToEntry(node)) { continue; }
            let tagged = false;
            YAML.visit(node, (_, value) => { if (value?.tag || value?.anchor || YAML.isAlias(value)) { tagged = true; } });
            if (tagged || step.tag || inserts.tag || step.items.length !== 1 || match ||
                !isDeepStrictEqual(node.toJS(document, { maxAliasCount: 0 }), entry)) { return { status: 'conflict' }; }
            match = { name: node.get('name', true), seq: inserts.items.length === 1 ? root : inserts,
                index: inserts.items.length === 1 ? index : inserts.items.indexOf(node) };
        }
    }
    return match ? { status: 'present', ...match } : { status: 'missing' };
}

async function inspectDshPatch(targetPath, entry) {
    checkEntry(entry, entry?.config?.runnerPath);
    const { document } = await snapshot(targetPath);
    return lookup(document, entry, targetPath).status;
}

function addition(file, entry) {
    const root = file.document.contents;
    const json = JSON.stringify({ insert: [entry] });
    if (root?.flow) {
        const at = root.srcToken.end.find(token => token.type === 'flow-seq-end').offset;
        const last = root.srcToken.items.at(-1);
        const trailingComma = last && !last.value && last.start.some(t => t.type === 'comma');
        return { at, insert: (root.items.length && !trailingComma ? ', ' : '') + json };
    }
    const at = YAML.isSeq(root) ? root.range[2] : file.document.range[1];
    const newline = file.text.includes('\r\n') ? '\r\n' : '\n';
    const prefix = at && !file.text.slice(0, at).endsWith('\n') ? newline : '';
    const line = ' '.repeat(root?.srcToken?.indent || 0) + '- ' + json + newline;
    if (prefix && YAML.isSeq(root)) {
        // 某些块标量保留末行。插入首行可保持原文件最后一个值的换行语义。
        return { at: root.range[0] - root.srcToken.indent, insert: line };
    }
    return { at, insert: prefix + line };
}

// 外部编辑了其他配置后仍只摘除当前序列项；用户写在项内的注释留待人工核对。
function omitItem(file, match) {
    const { seq, index } = match;
    const node = seq.items[index];
    const source = file.text;
    let start = node.range[0], end = node.range[1];
    if (seq.flow) {
        const startTokens = seq.srcToken.items[index].start;
        const comma = index ? startTokens.find(t => t.type === 'comma') : seq.srcToken.items[index + 1]?.start.find(t => t.type === 'comma');
        if (comma) {
            const commaEnd = comma.offset + 1;
            if (comma.offset < start) { return source.slice(0, comma.offset) + source.slice(commaEnd, start) + source.slice(end); }
            return source.slice(0, start) + source.slice(end, comma.offset) + source.slice(commaEnd);
        }
    } else {
        const dash = seq.srcToken.items[index].start.find(t => t.type === 'seq-item-ind');
        start = dash.offset - dash.indent;
        const tail = source.slice(end).match(/^[ \t]*(?:\r?\n|$)/);
        if (tail && !source.slice(start, end).endsWith('\n')) { end += tail[0].length; }
    }
    let commented = false;
    YAML.visit(node, (_, part) => { if (part?.comment) { commented = true; } });
    if (commented || source.slice(start, end).split('\n').some(line => /^\s*#/.test(line))) { throw conflict(); }
    return source.slice(0, start) + source.slice(end);
}

async function replace(file, original, text) {
    const temp = file + '.' + randomUUID() + '.tmp';
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
        if (text !== null) {
            await fs.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
            await fs.chmod(temp, original.mode);
        }
        if ((await snapshot(file)).signature !== original.signature) { throw error('DeepSeek Harness 配置在写入前已变化，请重新检测后重试。'); }
        if (text === null) { await fs.unlink(file); }
        else if (original.signature === null) { await fs.link(temp, file); }
        else { await fs.rename(temp, file); }
    } finally { await fs.rm(temp, { force: true }); }
}

// 与 @deepseek-ai/dsh-atomic-write 的 profile 写入协议一致。锁只有在记录完整且 PID 确已退出时可接管。
async function lockRecord(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16) { return null; }
        const data = Buffer.alloc(17);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        return data.toString('utf8', 0, bytesRead);
    } catch { return null; }
    finally { if (handle) { await handle.close(); } }
}

function ownerExited(record) {
    if (!/^\d+\n$/.test(record)) { return false; }
    const pid = Number(record.trim());
    if (pid < 1 || pid > 0x7fffffff || pid === process.pid) { return false; }
    try { process.kill(pid, 0); return false; }
    catch (reason) { return reason.code === 'ESRCH'; }
}

async function clearExitedLock(lock) {
    const record = await lockRecord(lock);
    if (!ownerExited(record)) { return false; }
    const claim = lock + '.takeover-' + digest(record).slice(0, 16);
    try { await fs.writeFile(claim, process.pid + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (reason) { if (reason.code === 'EEXIST') { return false; } throw reason; }
    try {
        if (await lockRecord(lock) !== record || !ownerExited(record)) { return false; }
        await fs.rm(lock, { force: true });
        return true;
    } finally { await fs.rm(claim, { force: true }); }
}

async function withProfileLock(file, operation) {
    const directory = await profileDirectory(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, 'package.json.lock');
    const owner = process.pid + '\n';
    const deadline = Date.now() + 2000;
    let delay = 20;
    for (;;) {
        try { await fs.writeFile(lock, owner, { flag: 'wx', mode: 0o600 }); break; }
        catch (reason) {
            if (reason.code !== 'EEXIST') { throw reason; }
            if (await clearExitedLock(lock)) { continue; }
        }
        if (Date.now() >= deadline) { throw error('DeepSeek Harness 正在修改 desktop profile，请稍后重试。'); }
        await wait(delay);
        delay = Math.min(delay * 2, 200);
    }
    try { return await operation(); }
    finally {
        if (await lockRecord(lock) === owner) { await fs.rm(lock, { force: true }); }
    }
}

class DshRegistration {
    constructor({ userDataPath }) {
        this.file = path.join(userDataPath, 'host-integration', 'registrations', 'dsh.json');
    }

    async readLedger() {
        const record = await readJson(this.file, null);
        if (record && record.verifiedSince == null) {
            record.verifiedSince = Math.floor((await fs.stat(this.file)).mtimeMs);
        }
        return record;
    }

    async state(id) {
        if (id !== 'dsh') { throw invalid(); }
        const record = await this.readLedger();
        return { managed: Boolean(record), pending: record?.pending || null,
            targetPath: record?.targetPath || null, events: record ? [...events] : [], verifiedSince: record?.verifiedSince ?? null };
    }

    async save(record) {
        if (record) { await writeJson(this.file, record); }
        else { await fs.rm(this.file, { force: true }); }
    }

    async change({ id, targetPath, runnerPath, fragment }, action) {
        if (id !== 'dsh' || !path.isAbsolute(runnerPath)) { throw invalid(); }
        const record = await this.readLedger();
        if (record && (record.targetPath !== targetPath || record.entry.config.runnerPath !== runnerPath)) { throw conflict(); }
        const original = await snapshot(targetPath);
        let entry = record?.entry;
        if (fragment) {
            let patch;
            try { patch = typeof fragment === 'string' ? JSON.parse(fragment) : fragment; }
            catch { throw invalid(); }
            entry = patch?.insert?.[0];
            checkEntry(entry, runnerPath);
            if (!isDeepStrictEqual(patch, { insert: [entry] }) || (record && !isDeepStrictEqual(record.entry, entry))) { throw invalid(); }
        }
        if (!entry) { return this.state(id); }
        const found = lookup(original.document, entry, targetPath);
        if (found.status === 'conflict') { throw conflict(); }
        if (action === 'apply') {
            if (found.status === 'present') {
                if (record?.pending) { await this.save({ ...record, pending: null }); }
                return this.state(id);
            }
            if (!fragment && !record?.pending) { return this.state(id); }
            const { at, insert } = addition(original, entry);
            const next = original.text.slice(0, at) + insert + original.text.slice(at);
            if (lookup(parse(next), entry, targetPath).status !== 'present') { throw invalid(); }
            const pending = { entry, targetPath, pending: 'apply', verifiedSince: Date.now(),
                createdFile: original.signature === null, after: digest(next), at, length: insert.length };
            await this.save(pending);
            try { await replace(targetPath, original, next); }
            catch (cause) { await this.save(record); throw cause; }
            await this.save({ ...pending, pending: null });
        } else if (record) {
            if (found.status === 'present') {
                const unchanged = digest(original.text) === record.after;
                let next = unchanged
                    ? original.text.slice(0, record.at) + original.text.slice(record.at + record.length)
                    : omitItem(original, found);
                const remaining = parse(next);
                if (lookup(remaining, entry, targetPath).status !== 'missing') { throw conflict(); }
                if (record.createdFile && !next.length) { next = null; }
                else if (!unchanged && !YAML.isSeq(remaining.contents)) {
                    // Cordis 的补丁加载器要求数组。保留安装后用户留下的注释和文档结束符。
                    const at = remaining.range[1];
                    const newline = next.includes('\r\n') ? '\r\n' : '\n';
                    const prefix = at && !next.slice(0, at).endsWith('\n') ? newline : '';
                    next = next.slice(0, at) + prefix + '[]' + newline + next.slice(at);
                    if (!YAML.isSeq(parse(next).contents)) { throw conflict(); }
                }
                await this.save({ ...record, pending: 'remove' });
                await replace(targetPath, original, next);
            }
            await this.save(null);
        }
        return this.state(id);
    }

    /** 在 Cordis 的写锁下仅替换已管理模块的 name 标量，保留其他文本及原解除信息。 */
    relocate({ targetPath, runnerPath, pluginPath }) {
        return withProfileLock(targetPath, async () => {
            let record = await this.readLedger();
            if (!record || record.targetPath !== targetPath || record.pending === 'remove') { return; }
            if (![null, undefined, 'apply', 'relocate'].includes(record.pending)) { throw invalid(); }
            checkEntry(record.entry, runnerPath);
            const original = await snapshot(targetPath);
            if (record.pending === 'relocate') {
                const previous = record;
                const { relocation, ...rest } = previous;
                const moved = { ...rest, ...relocation, pending: null };
                checkEntry(moved.entry, runnerPath);
                if (lookup(original.document, moved.entry, targetPath).status === 'present') {
                    await this.save(moved);
                    record = moved;
                } else {
                    if (lookup(original.document, rest.entry, targetPath).status !== 'present') { throw conflict(); }
                    record = { ...rest, pending: null };
                    await this.save(record);
                }
            }
            if (record.entry.name === pluginPath) { return; }
            const found = lookup(original.document, record.entry, targetPath);
            const entry = { ...record.entry, name: pluginPath };
            checkEntry(entry, runnerPath);
            if (found.status === 'missing' && lookup(original.document, entry, targetPath).status === 'missing') {
                // 旧版尚未写入，或原登记已被移除。保留可重试的接入意图，用户点击恢复时再写 profile。
                await this.save({ ...record, entry, pending: 'apply' });
                return;
            }
            if (found.status !== 'present') { throw conflict(); }
            const [start, end] = found.name.range;
            const next = original.text.slice(0, start) + JSON.stringify(pluginPath) + original.text.slice(end);
            if (lookup(parse(next), entry, targetPath).status !== 'present') { throw conflict(); }
            const unchanged = digest(original.text) === record.after;
            const relocation = { entry, after: unchanged ? digest(next) : null,
                length: record.length + next.length - original.text.length };
            await this.save({ ...record, pending: 'relocate', relocation });
            await replace(targetPath, original, next);
            await this.save({ ...record, ...relocation, pending: null });
        });
    }

    apply(options) { return withProfileLock(options.targetPath, () => this.change(options, 'apply')); }
    remove(options) { return withProfileLock(options.targetPath, () => this.change(options, 'remove')); }
}

module.exports = { DshRegistration, inspectDshPatch };
