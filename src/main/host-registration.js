'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const { readJson, writeJson } = require('./local-config');

const eventNames = ['SessionStart', 'PreToolUse'];
const filenames = new Map([['claude', 'settings.json'], ['codex', 'hooks.json']]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = data => createHash('sha256').update(data).digest('hex');

function registrationError(message) {
    return Object.assign(new Error(message), { code: 'HOST_REGISTRATION_ERROR' });
}

function conflict(file, events) {
    return registrationError(path.basename(file) + ' 中 ' + events.join('、') + ' 的工作台条目有外部修改。请核对并恢复或移除这些条目后重试。');
}

async function snapshot(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4 * 1024 * 1024) { throw new Error(); }
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const result = await handle.read(buffer, length, buffer.length - length, length);
            if (!result.bytesRead) { break; }
            length += result.bytesRead;
        }
        if (length !== info.size) { throw new Error(); }
        const bytes = buffer.subarray(0, length);
        const text = bytes.toString('utf8');
        const config = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) { throw new Error(); }
        return { config, signature: [info.dev, info.ino, info.mode, hash(bytes)].join('/'), mode: info.mode & 0o777,
            indent: text.match(/\n([ \t]+)"/)?.[1] || 2, bom: text.startsWith('\uFEFF') ? '\uFEFF' : '',
            newline: text.includes('\r\n') ? '\r\n' : '\n' };
    } catch (error) {
        if (error.code === 'ENOENT') { return { config: {}, signature: null, mode: 0o600, indent: 2, bom: '', newline: '\n' }; }
        throw registrationError('无法安全修改 ' + path.basename(file) + '。请检查文件类型、权限和 JSON 格式。');
    } finally { if (handle) { await handle.close(); } }
}

// 只有宿主配置使用快照校验。工作台自己的台账由主进程串行维护。
async function replaceConfig(file, original, config) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
        if (config !== null) {
            const text = original.bom + JSON.stringify(config, null, original.indent).replace(/\n/g, original.newline) + original.newline;
            await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
            await fs.chmod(temporary, original.mode);
        }
        if ((await snapshot(file)).signature !== original.signature) {
            throw registrationError(path.basename(file) + ' 在写入前已变化，请重新检测后重试。');
        }
        if (config === null) { await fs.unlink(file); }
        else if (original.signature === null) { await fs.link(temporary, file); }
        else { await fs.rename(temporary, file); }
    } catch (error) {
        error.configUntouched = true;
        throw error;
    } finally { await fs.rm(temporary, { force: true }); }
}

// 用户配置只以相关事件的摘要进入预写记录；令牌、命令和其他设置不会被复制。
function eventDigest(config, events) {
    return hash(JSON.stringify(events.map(name => config?.hooks && Object.hasOwn(config.hooks, name) ? [config.hooks[name]] : [])));
}

function desiredEntries(fragment) {
    if (fragment == null) { return []; }
    const hooks = (typeof fragment === 'string' ? JSON.parse(fragment) : fragment)?.hooks;
    if (!object(hooks)) { throw registrationError('工作台的钩子配置片段格式无效。'); }
    return Object.entries(hooks).map(([event, groups]) => {
        const item = groups?.[0]?.hooks?.[0];
        if (!eventNames.includes(event) || !Array.isArray(groups) || groups.length !== 1 ||
            !isDeepStrictEqual(groups, [{ hooks: [item] }]) || item?.type !== 'command' || typeof item.command !== 'string') {
            throw registrationError('工作台的钩子配置片段格式无效。');
        }
        return [event, item];
    });
}

// 工作台每次追加一个无 matcher 的组。其他处理项可以随后加入该组。
function locate(groups, handler, runnerPath, owned) {
    if (!Array.isArray(groups)) { return { conflict: true }; }
    let found = null;
    for (const [index, group] of groups.entries()) {
        if (!object(group) || !Array.isArray(group.hooks)) { return { conflict: true }; }
        for (const [itemIndex, item] of group.hooks.entries()) {
            if (!object(item)) { return { conflict: true }; }
            if (!isDeepStrictEqual(item, handler)) {
                if (typeof item.command === 'string' && (item.command.includes(runnerPath) || item.command.includes(handler.command)) ||
                    (handler.statusMessage && item.statusMessage === handler.statusMessage)) { return { conflict: true }; }
                continue;
            }
            if (found || (owned ? Object.keys(group).length !== 1 : ![undefined, '', '*'].includes(group.matcher))) {
                return { conflict: true };
            }
            found = { index, itemIndex };
        }
    }
    // 原位置出现无法识别的命令时可能是用户替换了整个处理项，不能把它当成未安装。
    if (!found && owned && groups[owned.index] && !owned.previous.includes(hash(JSON.stringify(groups[owned.index])))) {
        return { conflict: true };
    }
    return found || {};
}

function summarize(current, operation) {
    const sources = [current, operation?.next].filter(Boolean);
    return { managed: sources.length > 0, pending: operation?.action || null, targetPath: sources[0]?.targetPath || null,
        events: [...new Set(sources.flatMap(record => Object.keys(record.entries)))], verifiedSince: sources[0]?.verifiedSince ?? null };
}

class HostRegistration {
    constructor({ userDataPath }) {
        this.directory = path.join(userDataPath, 'host-integration', 'registrations');
    }

    ledgerPath(id) {
        if (!filenames.has(id)) { throw registrationError('未知的宿主。'); }
        return path.join(this.directory, id + '.json');
    }

    async readLedger(id) {
        const file = this.ledgerPath(id);
        const ledger = await readJson(file, {});
        const legacy = [ledger.current, ledger.operation?.next].filter(record => record && record.verifiedSince == null);
        if (legacy.length) {
            // 旧台账按宿主独立保存。用上次登记写入的时间划定范围，只读检测不会改写台账。
            const since = Math.floor((await fs.stat(file)).mtimeMs);
            for (const record of legacy) { record.verifiedSince = since; }
        }
        return ledger;
    }

    async state(id) {
        const { current, operation } = await this.readLedger(id);
        return summarize(current, operation);
    }

    async save(id, current, operation = null) {
        if (current || operation) { await writeJson(this.ledgerPath(id), { current, operation }); }
        else { await fs.rm(this.ledgerPath(id), { force: true }); }
    }

    async load(id, targetPath, runnerPath, action) {
        const { current, operation } = await this.readLedger(id);
        if (!path.isAbsolute(targetPath) || !path.isAbsolute(runnerPath) || path.basename(targetPath) !== filenames.get(id)) {
            throw registrationError('无法确认宿主接入的本机目标路径。');
        }
        const record = current || operation?.next;
        if (record && (record.targetPath !== targetPath || record.runnerPath !== runnerPath)) {
            throw registrationError('宿主配置位置已变化，请先核对原有的接入记录。');
        }
        const original = await snapshot(targetPath);
        if (!operation) { return { original, current }; }
        const observed = eventDigest(original.config, operation.events);
        let recovered;
        if (observed === operation.after) { recovered = operation.next; }
        else if (observed === operation.before) { recovered = current; }
        else if (action === 'remove') {
            // 中断后又有人编辑事件时，按条目比较，只解除仍精确匹配的项。
            recovered = operation.action === 'apply' ? operation.next : current;
        } else { throw conflict(targetPath, operation.events); }
        await this.save(id, recovered);
        return { original, current: recovered };
    }

    async commit(id, targetPath, action, original, config, current, next) {
        const events = eventNames.filter(event => !isDeepStrictEqual(original.config.hooks?.[event], config?.hooks?.[event]));
        if (events.length) {
            if (action === 'apply') { next.verifiedSince = Date.now(); }
            await this.save(id, current, { action, events, before: eventDigest(original.config, events),
                after: eventDigest(config, events), next });
            try { await replaceConfig(targetPath, original, config); }
            catch (error) {
                if (error.configUntouched) { await this.save(id, current); }
                throw error;
            }
        }
        if (events.length || !isDeepStrictEqual(current || null, next)) { await this.save(id, next); }
        return summarize(next);
    }

    async apply({ id, targetPath, fragment, runnerPath }) {
        const { original, current } = await this.load(id, targetPath, runnerPath, 'apply');
        const config = structuredClone(original.config);
        const next = current ? structuredClone(current) : { targetPath, runnerPath, createdFile: original.signature === null,
            createdHooks: config.hooks === undefined, entries: {} };
        const desired = new Map(desiredEntries(fragment));
        for (const event of new Set([...Object.keys(next.entries), ...desired.keys()])) {
            const owned = next.entries[event];
            const handler = desired.get(event) || owned.handler;
            const groups = config.hooks?.[event] === undefined ? [] : config.hooks[event];
            const match = locate(groups, handler, runnerPath, owned);
            if (match.conflict) { throw conflict(targetPath, [event]); }
            if (match.index !== undefined) { continue; }
            if (!desired.has(event)) {
                // 适配器已在另一配置来源找到同一入口，原 JSON 登记不再归工作台管理。
                delete next.entries[event];
                continue;
            }
            next.entries[event] = { handler, index: groups.length, previous: groups.map(group => hash(JSON.stringify(group))),
                createdEvent: owned?.createdEvent ?? (config.hooks?.[event] === undefined) };
            config.hooks ??= {};
            config.hooks[event] = [...groups, { hooks: [handler] }];
        }
        return this.commit(id, targetPath, 'apply', original, config, current, Object.keys(next.entries).length ? next : null);
    }

    async remove({ id, targetPath, runnerPath }) {
        const { original, current } = await this.load(id, targetPath, runnerPath, 'remove');
        if (!current) { return summarize(null); }
        const config = structuredClone(original.config);
        const next = structuredClone(current);
        const conflicts = [];
        for (const [event, owned] of Object.entries(current.entries)) {
            const groups = config.hooks?.[event] === undefined ? [] : config.hooks[event];
            const match = locate(groups, owned.handler, runnerPath, owned);
            if (match.conflict) { conflicts.push(event); continue; }
            if (match.index !== undefined) {
                const group = groups[match.index];
                group.hooks.splice(match.itemIndex, 1);
                if (!group.hooks.length) { groups.splice(match.index, 1); }
                if (owned.createdEvent && !groups.length) { delete config.hooks[event]; }
            }
            delete next.entries[event];
        }
        if (current.createdHooks && config.hooks && !Object.keys(config.hooks).length) { delete config.hooks; }
        const removeFile = current.createdFile && !Object.keys(config).length;
        const state = await this.commit(id, targetPath, 'remove', original, removeFile ? null : config, current,
            Object.keys(next.entries).length ? next : null);
        if (conflicts.length) { throw conflict(targetPath, conflicts); }
        return state;
    }
}

module.exports = { HostRegistration };
