'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');

async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') { return fallback; } throw error; }
}

async function writeJson(file, value, beforeCommit) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        if (beforeCommit) { beforeCommit(); }
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

/** 用最近已存在的父目录解析新配置目录，保证创建前后的目标路径一致。 */
async function resolveConfigDirectory(directory) {
    let ancestor = directory;
    const missing = [];
    while (true) {
        try { await fs.lstat(ancestor); }
        catch (error) {
            const parent = path.dirname(ancestor);
            if (error.code !== 'ENOENT' || parent === ancestor) { throw error; }
            missing.push(path.basename(ancestor));
            ancestor = parent;
            continue;
        }
        // lstat 成功后再展开符号链接。悬空链接不能当成可新建的目录。
        const resolved = await fs.realpath(ancestor);
        if (!(await fs.stat(resolved)).isDirectory()) { throw new Error('宿主配置路径需要是目录。'); }
        await fs.access(resolved, constants.R_OK | constants.X_OK);
        return path.join(resolved, ...missing.reverse());
    }
}

module.exports = { readJson, writeJson, resolveConfigDirectory };
