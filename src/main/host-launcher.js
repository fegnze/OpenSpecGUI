'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const conflict = () => new Error('钩子入口已被外部修改，请核对页面上的程序路径后重新检测。');

/** 宿主调用固定入口，运行环境和检查代码来自用户安装的同一份工作台。 */
class HostLauncher {
    constructor(userDataPath) {
        this.directory = path.join(userDataPath, 'host-integration', 'bin');
        this.file = path.join(this.directory, 'workbench-hook');
        this.source = path.join(__dirname, 'workbench-hook.cjs');
        this.script = [
            '#!/bin/sh',
            'unset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR',
            'export ELECTRON_RUN_AS_NODE=1',
            'export OPENSPEC_GUI_HOOK_USER_DATA=' + quote(userDataPath),
            'exec ' + quote(process.execPath) + ' ' + quote(this.source) + ' "$@"',
            ''
        ].join('\n');
        this.name = 'launch-' + hash(this.script) + '.sh';
    }

    async state() {
        let current;
        try { current = await fs.readlink(this.file); }
        catch (error) { return error.code === 'ENOENT' ? 'missing' : 'conflict'; }
        if (!/^launch-[a-f0-9]{64}\.sh$/.test(current)) { return 'conflict'; }
        const file = path.join(this.directory, current);
        try {
            const info = await fs.lstat(file);
            if (!info.isFile() || info.size > 32 * 1024 || !(info.mode & 0o100) ||
                current !== 'launch-' + hash(await fs.readFile(file)) + '.sh') { return 'conflict'; }
        } catch (error) { return error.code === 'ENOENT' && current === this.name ? 'repair' : 'conflict'; }
        return current === this.name ? 'ready' : 'update';
    }

    async install() {
        await fs.access(this.source);
        const state = await this.state();
        if (state === 'conflict') { throw conflict(); }
        if (state === 'ready') { return; }
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = path.join(this.directory, this.name);
        const temporary = path.join(this.directory, '.install-' + randomUUID());
        try {
            // 在临时文件上完成写入，再以独占硬链接发布。中断后重试可复用已发布的内容。
            await fs.writeFile(temporary, this.script, { flag: 'wx', mode: 0o700 });
            try { await fs.link(temporary, target); }
            catch (error) {
                if (error.code !== 'EEXIST') { throw error; }
                const info = await fs.lstat(target);
                if (!info.isFile() || !(info.mode & 0o100) || info.size !== Buffer.byteLength(this.script) ||
                    await fs.readFile(target, 'utf8') !== this.script) { throw conflict(); }
            }
            if (state === 'missing') { await fs.symlink(this.name, this.file); }
            if (state === 'update') {
                await fs.unlink(temporary);
                await fs.symlink(this.name, temporary);
                if (await this.state() !== 'update') { throw conflict(); }
                await fs.rename(temporary, this.file);
            }
        } finally { await fs.rm(temporary, { force: true }); }
        if (await this.state() !== 'ready') { throw conflict(); }
    }
}

module.exports = { HostLauncher };
