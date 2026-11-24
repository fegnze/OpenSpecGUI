'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { digest } = require('./capability-source');

const maxBytes = 8 * 1024 * 1024;
const privateDirectoryMode = 0o700;

function invalid() {
    return new Error('能力来源快照不完整或包含不安全的路径。请重新登记来源。');
}

function changed() {
    return new Error('已落盘的能力内容、路径或权限不符合来源快照。');
}

function safeParts(relative) {
    if (typeof relative !== 'string' || !relative || relative.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(relative)) { throw invalid(); }
    const parts = relative.split('/');
    if (parts.length > 10 || parts.some(part => !part || part.startsWith('.') || part === '__pycache__' || part === 'node_modules')) { throw invalid(); }
    return parts;
}

function describe(snapshot, kind) {
    if (!['skill', 'rule', 'tool', 'mcp'].includes(kind) || !snapshot || typeof snapshot.source !== 'string' ||
        !Array.isArray(snapshot.files) || snapshot.files.length > 512 || typeof snapshot.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(snapshot.digest)) { throw invalid(); }
    if (kind === 'mcp' || snapshot.files.length === 0) { return null; }

    const files = new Map();
    const directories = new Set(['']);
    const names = new Map();
    let bytes = 0;
    for (const file of snapshot.files) {
        if (!file || typeof file.executable !== 'boolean' || typeof file.data !== 'string' || file.data.length > 4 * Math.ceil(maxBytes / 3)) { throw invalid(); }
        const parts = safeParts(file.path);
        const data = Buffer.from(file.data, 'base64');
        bytes += data.length;
        if (data.toString('base64') !== file.data || bytes > maxBytes) { throw invalid(); }
        let parent = '';
        for (const part of parts) {
            parent = parent ? parent + '/' + part : part;
            const folded = parent.normalize('NFC').toLowerCase();
            if (names.has(folded) && names.get(folded) !== parent) { throw invalid(); }
            names.set(folded, parent);
            if (files.has(parent)) { throw invalid(); }
            if (parent !== file.path) { directories.add(parent); }
        }
        if (directories.has(file.path)) { throw invalid(); }
        files.set(file.path, { data, mode: file.executable ? 0o700 : 0o600 });
    }
    if (names.size > 512 || digest(JSON.stringify(snapshot.files)) !== snapshot.digest) { throw invalid(); }
    const entry = kind === 'skill' ? 'SKILL.md' : path.basename(snapshot.source);
    if (!files.has(entry) || (kind !== 'skill' && files.size !== 1) || (kind === 'rule' && !/\.md$/i.test(entry))) { throw invalid(); }
    return { files, directories, entry };
}

async function directory(target, create) {
    if (create) {
        try { await fs.mkdir(target, { mode: privateDirectoryMode }); }
        catch (error) { if (error.code !== 'EEXIST') { throw error; } }
    }
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (!create && error.code === 'ENOENT') { return false; } throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) { throw changed(); }
    return true;
}

async function storeDirectory(root, create) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) { throw invalid(); }
    const userDataPath = path.dirname(root);
    if (create) { await fs.mkdir(userDataPath, { recursive: true, mode: privateDirectoryMode }); }
    if (!await directory(userDataPath, false)) { return null; }
    if (!await directory(root, create)) { return null; }
    const realRoot = await fs.realpath(root);
    const retained = path.join(realRoot, 'versions');
    if (!await directory(retained, create)) { return null; }
    return retained;
}

async function verifyFile(target, expected) {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.data.length || (stat.mode & 0o7777) !== expected.mode) { throw changed(); }
        const actual = await handle.readFile();
        if (!actual.equals(expected.data)) { throw changed(); }
    } finally { await handle.close(); }
}

async function verifyTree(target, snapshot) {
    if (!await directory(target, false)) { return false; }
    const found = new Set();
    async function visit(relative) {
        const dir = path.join(target, relative);
        const handle = await fs.opendir(dir);
        for await (const entry of handle) {
            const name = relative ? relative + '/' + entry.name : entry.name;
            const file = path.join(dir, entry.name);
            if (snapshot.directories.has(name) && entry.isDirectory()) {
                if (!await directory(file, false)) { throw changed(); }
                await visit(name);
            } else if (snapshot.files.has(name) && entry.isFile()) {
                await verifyFile(file, snapshot.files.get(name));
                found.add(name);
            } else { throw changed(); }
        }
    }
    await visit('');
    if (found.size !== snapshot.files.size) { throw changed(); }
    return true;
}

/** 返回已校验的本机能力入口。尚未落盘时返回 null。 */
async function resolveMaterializedEntry({ root, snapshot, kind }) {
    const expected = describe(snapshot, kind);
    if (!expected) { return null; }
    const store = await storeDirectory(root, false);
    if (!store) { return null; }
    const target = path.join(store, snapshot.digest);
    return await verifyTree(target, expected) ? path.join(target, expected.entry) : null;
}

/** 在同一文件系统暂存并原子发布快照，其他调用只会见到完整版本。 */
async function materialize({ root, snapshot, kind }) {
    const expected = describe(snapshot, kind);
    if (!expected) { return null; }
    const store = await storeDirectory(root, true);
    const target = path.join(store, snapshot.digest);
    const entry = path.join(target, expected.entry);
    if (await verifyTree(target, expected)) { return entry; }
    const stage = await fs.mkdtemp(path.join(store, '.incoming-'));
    try {
        for (const dir of expected.directories) {
            if (dir) { await fs.mkdir(path.join(stage, dir), { mode: privateDirectoryMode }); }
        }
        for (const [relative, file] of expected.files) {
            const handle = await fs.open(path.join(stage, relative), 'wx', file.mode);
            try { await handle.writeFile(file.data); await handle.chmod(file.mode); }
            finally { await handle.close(); }
        }
        if (!await verifyTree(stage, expected)) { throw changed(); }
        try { await fs.rename(stage, target); }
        catch (error) {
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !await verifyTree(target, expected)) { throw error; }
        }
        return entry;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

module.exports = { materialize, resolveMaterializedEntry };
