'use strict';

var fs = require('node:fs/promises');
var flags = require('node:fs').constants;
var path = require('node:path');
var randomUUID = require('node:crypto').randomUUID;

var CHUNK_BYTES = 64 * 1024;
var MAX_ENTRIES = 20000;
var MAX_FILES = 4096;
var MAX_PATH_BYTES = 2 * 1024 * 1024;

function rejectAttachment(message) {
    var error = new Error(message);
    error.code = 'ATTACHMENT_UNAVAILABLE';
    return error;
}

function stale() {
    return rejectAttachment('附件或所在目录已变化，请重新展开附件列表。');
}

function directoryIdentity(stat) { return stat.dev + ':' + stat.ino; }

function fileIdentity(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}

/** 验证从实际仓库到目标目录的每一段，目录替换或引入链接后旧清单立即失效。 */
async function directoryChain(root, directory, expected) {
    var relative = path.relative(root, directory);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { throw stale(); }
    var parts = relative ? relative.split(path.sep) : [];
    var chain = [];
    var current = root;
    for (var i = 0; i <= parts.length; i += 1) {
        if (i) { current = path.join(current, parts[i - 1]); }
        var stat = await fs.lstat(current, { bigint: true });
        if (!stat.isDirectory() || (expected && expected[i] !== directoryIdentity(stat))) { throw stale(); }
        chain.push(directoryIdentity(stat));
    }
    if (await fs.realpath(directory) !== directory) { throw stale(); }
    return chain;
}

function isAttachment(name) { return /\.json$/i.test(name) && name.toLowerCase() !== '.openspec.json'; }

/** 此扫描只从已经匹配当前快照的一条提案开始，只返回元信息。 */
async function listFiles(projectRoot, directory) {
    var records = new Map();
    var files = [];
    var count = 0;
    var pathBytes = 0;
    async function visit(folder, parents, depth) {
        if (depth > 32) { throw rejectAttachment('附件目录深度超过限制。'); }
        var chain = await directoryChain(projectRoot, folder);
        if (parents && parents.some(function (value, index) { return value !== chain[index]; })) { throw stale(); }
        var handle = await fs.opendir(folder);
        for await (var entry of handle) {
            count += 1;
            if (count > MAX_ENTRIES) { throw rejectAttachment('此提案的目录项超过附件列表上限。'); }
            var target = path.join(folder, entry.name);
            if (entry.isDirectory()) { await visit(target, chain, depth + 1); continue; }
            if (!entry.isFile() || !isAttachment(entry.name)) { continue; }
            var stat = await fs.lstat(target, { bigint: true });
            if (!stat.isFile() || stat.nlink !== 1n) { continue; }
            var relative = path.relative(directory, target).split(path.sep).join('/');
            pathBytes += Buffer.byteLength(relative);
            if (files.length >= MAX_FILES || pathBytes > MAX_PATH_BYTES) { throw rejectAttachment('此提案的附件清单超过显示上限。'); }
            var size = Number(stat.size);
            if (!Number.isSafeInteger(size)) { throw rejectAttachment('附件大小超过可读取范围。'); }
            var id = randomUUID();
            records.set(id, { target: target, chain: chain, stamp: fileIdentity(stat), size: size });
            files.push({ id: id, path: relative, size: size, modifiedAt: stat.mtime.toISOString() });
        }
        await directoryChain(projectRoot, folder, chain);
    }
    await visit(directory, null, 0);
    files.sort(function (left, right) { return left.path.localeCompare(right.path); });
    return { files: files, records: records };
}

/** 片尾的不完整 UTF-8 字符留给下一次读取，下一段仍从完整字符开始。 */
function completePrefix(buffer, eof) {
    if (eof) { return buffer.length; }
    var start = buffer.length - 1;
    while (start > 0 && buffer.length - start <= 3 && (buffer[start] & 0xc0) === 0x80) { start -= 1; }
    var lead = buffer[start];
    var width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
    return start + width > buffer.length ? start : buffer.length;
}

async function readChunk(root, record, offset) {
    if (!record) { throw rejectAttachment('请先展开当前提案并选择已列出的附件。'); }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.size) { throw rejectAttachment('附件读取位置无效。'); }
    var directory = path.dirname(record.target);
    await directoryChain(root, directory, record.chain);
    var handle = await fs.open(record.target, flags.O_RDONLY | flags.O_NONBLOCK | (flags.O_NOFOLLOW || 0));
    try {
        var before = await handle.stat({ bigint: true });
        if (!before.isFile() || fileIdentity(before) !== record.stamp) { throw stale(); }
        var bytes = Buffer.alloc(Math.min(CHUNK_BYTES, record.size - offset));
        var length = 0;
        while (length < bytes.length) {
            var part = await handle.read(bytes, length, bytes.length - length, offset + length);
            if (!part.bytesRead) { throw stale(); }
            length += part.bytesRead;
        }
        var after = await handle.stat({ bigint: true });
        var named = await fs.lstat(record.target, { bigint: true });
        if (fileIdentity(after) !== record.stamp || !named.isFile() || fileIdentity(named) !== record.stamp) { throw stale(); }
        await directoryChain(root, directory, record.chain);
        var end = completePrefix(bytes, offset + length === record.size);
        var text;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)); }
        catch { throw rejectAttachment('附件包含无效的 UTF-8 文本或读取位置不在字符边界。'); }
        var next = offset + end;
        return { text: text, offset: offset, nextOffset: next, totalBytes: record.size, done: next === record.size };
    } finally { await handle.close(); }
}

/** 将底层文件错误归并为不含本机绝对路径的用户提示。 */
function publicError(error) { return error.code === 'ATTACHMENT_UNAVAILABLE' ? error : stale(); }

module.exports = { isAttachment: isAttachment, listFiles: listFiles, readChunk: readChunk, publicError: publicError };
