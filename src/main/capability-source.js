'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('yaml');

const limit = 8 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function remoteSource(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('请填写有效的 HTTPS 服务地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
        throw new Error('MCP 地址必须使用 HTTPS；请在独立凭据入口配置认证');
    }
    return url.href;
}

function toolRef(source) {
    if (/^host:[a-zA-Z0-9_.-]{1,100}$/.test(source)) { return 'host'; }
    if (/^mcp:[a-z0-9][a-z0-9-]{0,62}\/[a-zA-Z0-9_.-]{1,100}$/.test(source)) { return 'mcp'; }
    return null;
}

async function readSource(kind, source, descriptor) {
    if (!descriptor && (kind === 'mcp' || (kind === 'tool' && toolRef(source)))) {
        const normalized = kind === 'mcp' ? remoteSource(source) : source;
        return { digest: digest(normalized), source: normalized, files: [], requirements: {} };
    }
    const isSkill = kind === 'skill';
    if (isSkill && path.basename(source) !== 'SKILL.md') { throw new Error('请选择 Skill 目录内的 SKILL.md'); }
    if (kind === 'rule' && !/\.md$/i.test(source)) { throw new Error('请选择 Markdown 规范文件'); }
    const root = await fs.realpath(path.dirname(source));
    const entry = path.join(root, path.basename(source));
    const files = [];
    let bytes = 0;
    let entries = 0;
    async function visit(file, depth) {
        if (depth > 10 || ++entries > 512) { throw new Error('来源目录过大，请选择独立的 Skill 目录'); }
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) { throw new Error('来源中包含符号链接，请选择独立的来源目录'); }
        if (stat.isDirectory()) {
            const names = (await fs.readdir(file)).sort();
            for (const name of names) {
                if (name.startsWith('.') || ['__pycache__','node_modules','projects.local.json'].includes(name)) { continue; }
                await visit(path.join(file, name), depth + 1);
            }
            return;
        }
        if (!stat.isFile() || (bytes += stat.size) > limit) { throw new Error('来源不是普通文件或超出 8 MiB 上限'); }
        // 打包内置文件由 Electron 的只读 ASAR 提供，其虚拟 inode 不可与打开后的临时文件比较。
        if (descriptor && process.versions.electron && file.includes('.asar' + path.sep)) {
            const data = await fs.readFile(file);
            if (data.length !== stat.size) { throw new Error('应用内置来源不完整'); }
            files.push({ path: path.relative(root, file), executable: Boolean(stat.mode & 0o111), data: data.toString('base64') });
            return;
        }
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino) { throw new Error('来源已变化，请重新预览'); }
            const data = await handle.readFile();
            if (data.length !== stat.size) { throw new Error('来源已变化，请重新预览'); }
            files.push({ path: path.relative(root, file), executable: Boolean(opened.mode & 0o111), data: data.toString('base64') });
        } finally { await handle.close(); }
    }
    await visit(isSkill ? root : entry, 0);
    const main = files.find(f => f.path === path.basename(source));
    if (!main) { throw new Error('未找到入口文件'); }
    const text = Buffer.from(main.data, 'base64').toString('utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    let requirements = {};
    if (isSkill || (kind === 'rule' && header)) {
        const meta = header && yaml.parse(header[1]);
        if (isSkill && (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string')) {
            throw new Error('SKILL.md 需要 name 和 description 元数据');
        }
        if (kind === 'rule' && meta?.workbench?.requires) {
            requirements = meta.workbench.requires;
            if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements) ||
                Object.entries(requirements).some(([key, value]) => !/^[a-z][a-z0-9.-]{0,63}$/i.test(key) || typeof value !== 'string' || value.length > 200)) {
                throw new Error('规范 workbench.requires 必须是键值均为文本的约束声明');
            }
        }
    }
    return { source, digest: digest(JSON.stringify(files)), files, requirements, content: ['rule','skill'].includes(kind) ? text.slice(0, 16000) : undefined };
}

module.exports = { readSource, remoteSource, toolRef, digest };
