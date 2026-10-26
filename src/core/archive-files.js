'use strict';

var crypto = require('node:crypto');
var fs = require('node:fs');
var fsp = require('node:fs/promises');
var path = require('node:path');

var LIMITS = { maxEntries: 20000, maxBytes: 64 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxDepth: 32 };

function fail(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function resolveInside(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.indexOf('\0') !== -1 || relative.indexOf('\\') !== -1 || relative.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
        throw fail('ARCHIVE_PATH_FORBIDDEN', '归档路径无效');
    }
    var target = path.resolve(root, relative);
    var suffix = path.relative(root, target);
    if (!suffix || suffix === '..' || suffix.startsWith('..' + path.sep) || path.isAbsolute(suffix)) {
        throw fail('ARCHIVE_PATH_FORBIDDEN', '归档路径超出项目范围');
    }
    return target;
}

async function assertSafe(root, relative, allowMissing) {
    var target = resolveInside(root, relative);
    var current = root;
    if (await fsp.realpath(root) !== root || !(await fsp.lstat(root)).isDirectory()) {
        throw fail('ARCHIVE_PATH_FORBIDDEN', '项目真实路径已变化，请重新关联项目');
    }
    var parts = relative.split('/');
    for (var index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        var stat;
        try { stat = await fsp.lstat(current); }
        catch (error) { if (allowMissing && error.code === 'ENOENT') { return target; } throw error; }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (index < parts.length - 1 && !stat.isDirectory())) {
            throw fail('ARCHIVE_PATH_FORBIDDEN', '归档路径含符号链接或特殊文件：' + relative);
        }
    }
    return target;
}

async function readRegular(target, maximum) {
    var handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        var before = await handle.stat();
        if (!before.isFile() || before.size > maximum) { throw fail('ARCHIVE_LIMIT', '归档文件类型或大小不受支持：' + path.basename(target)); }
        var content = await handle.readFile();
        var after = await handle.stat();
        var current = await fsp.lstat(target);
        if (content.length > maximum || current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw fail('ARCHIVE_STALE', '读取期间文件发生变化，请重新检查');
        }
        return { content: content, mode: after.mode & 511, inode: String(after.dev) + ':' + String(after.ino) };
    } finally { await handle.close(); }
}

async function readTree(root, relatives, options) {
    var limits = Object.assign({}, LIMITS, options || {});
    var tree = new Map();
    var bytes = 0;
    async function visit(relative, depth) {
        if (tree.has(relative)) { return; }
        if (tree.size >= limits.maxEntries || depth > limits.maxDepth) { throw fail('ARCHIVE_LIMIT', '归档文件数量或目录深度超过限制'); }
        var target = await assertSafe(root, relative, true);
        var stat;
        try { stat = await fsp.lstat(target); }
        catch (error) { if (error.code === 'ENOENT') { tree.set(relative, { type: 'missing' }); return; } throw error; }
        if (stat.isDirectory()) {
            tree.set(relative, { type: 'directory', mode: stat.mode & 511, inode: String(stat.dev) + ':' + String(stat.ino) });
            var entries = (await fsp.readdir(target)).sort();
            for (var index = 0; index < entries.length; index += 1) { await visit(relative + '/' + entries[index], depth + 1); }
        } else {
            var file = await readRegular(target, limits.maxFileBytes);
            bytes += file.content.length;
            if (bytes > limits.maxBytes) { throw fail('ARCHIVE_LIMIT', '归档文件总量超过限制'); }
            tree.set(relative, { type: 'file', mode: file.mode, inode: file.inode, content: file.content, hash: hash(file.content) });
        }
    }
    for (var index = 0; index < relatives.length; index += 1) { await visit(relatives[index], 0); }
    return tree;
}

function digest(tree, prefix) {
    var entries = Array.from(tree.entries()).filter(function (entry) { return !prefix || entry[0] === prefix || entry[0].startsWith(prefix + '/'); });
    return hash(entries.sort(function (a, b) { return a[0].localeCompare(b[0]); }).map(function (entry) {
        return JSON.stringify([prefix ? entry[0].slice(prefix.length) : entry[0], entry[1].type, entry[1].mode, entry[1].hash]);
    }).join('\n'));
}

function inputPaths(changeId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(changeId) || changeId === 'archive') { throw fail('ARCHIVE_CHANGE_INVALID', '变更名称无效'); }
    return ['openspec/changes/' + changeId, 'openspec/specs', 'openspec/schemas', 'openspec/config.yaml', 'openspec/config.yml', 'openspec/config.json'];
}

function identityDigest(tree) {
    return hash(Array.from(tree).map(function (entry) { return [entry[0], entry[1].inode || null]; }).sort().map(function (entry) { return JSON.stringify(entry); }).join('\n'));
}

async function capture(root, changeId, limits) {
    await assertSafe(root, 'openspec/changes', false);
    await assertSafe(root, 'openspec/changes/archive', true);
    var tree = await readTree(root, inputPaths(changeId), limits);
    if (tree.get('openspec/changes/' + changeId).type !== 'directory') { throw fail('ARCHIVE_CHANGE_MISSING', '活跃变更已不存在'); }
    return tree;
}

async function materialize(root, tree) {
    for (var entry of tree) {
        var relative = entry[0];
        var value = entry[1];
        if (value.type === 'missing') { continue; }
        var target = resolveInside(root, relative);
        if (value.type === 'directory') { await fsp.mkdir(target, { recursive: true }); }
        else {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, value.content, { flag: 'wx', mode: value.mode });
            await fsp.chmod(target, value.mode);
        }
    }
    // Set directory modes last so a read-only source does not weaken the copy.
    for (var item of Array.from(tree.entries()).reverse()) {
        if (item[1].type === 'directory') { await fsp.chmod(resolveInside(root, item[0]), item[1].mode); }
    }
}

async function ensureParent(root, relative, created) {
    var parts = relative.split('/').slice(0, -1);
    var current = '';
    for (var index = 0; index < parts.length; index += 1) {
        current += (current ? '/' : '') + parts[index];
        var target = await assertSafe(root, current, true);
        try { await fsp.mkdir(target); if (created) { created.push(current); } }
        catch (error) { if (error.code !== 'EEXIST') { throw error; } }
        if (!(await fsp.lstat(target)).isDirectory()) { throw fail('ARCHIVE_PATH_FORBIDDEN', '目标父目录无效'); }
        await assertSafe(root, current, false);
    }
}

async function fileHash(root, relative) {
    var target = await assertSafe(root, relative, true);
    try { return hash((await readRegular(target, LIMITS.maxFileBytes)).content); }
    catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
}

async function writeExclusive(target, content, mode) {
    var handle = await fsp.open(target, 'wx', mode || 384);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    if (mode !== undefined) { await fsp.chmod(target, mode); }
}

async function atomicJson(target, value) {
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 448 });
    var temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
        await writeExclusive(temporary, Buffer.from(JSON.stringify(value)), 384);
        await fsp.rename(temporary, target);
        if (process.platform !== 'win32') {
            var directory = await fsp.open(path.dirname(target), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    }
    finally { await fsp.rm(temporary, { force: true }); }
}

module.exports = { fail: fail, hash: hash, resolveInside: resolveInside, assertSafe: assertSafe, readRegular: readRegular, readTree: readTree, digest: digest, identityDigest: identityDigest, capture: capture, materialize: materialize, ensureParent: ensureParent, fileHash: fileHash, writeExclusive: writeExclusive, atomicJson: atomicJson, limits: LIMITS };
