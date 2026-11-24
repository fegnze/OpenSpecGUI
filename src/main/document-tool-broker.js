'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { readMessage } = require('./agent-document-tools');

async function socketPath(userData) {
    const key = createHash('sha256').update(await fs.realpath(userData)).digest('hex').slice(0, 28);
    const directory = path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'openspec-doc-' + key);
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid()) {
        throw new Error('工作台文档工具的本机通信目录权限异常。');
    }
    return path.join(directory, 'tools.sock');
}

/** 单实例桌面主进程与无窗口启动共用同一服务，确保授权刷新由同一个队列处理。 */
async function listen(userData, execute) {
    const socket = await socketPath(userData);
    try {
        const previous = await fs.lstat(socket);
        if (!previous.isSocket()) { throw new Error('文档工具的通信路径被其他文件占用。'); }
        await fs.unlink(socket);
    } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    const server = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableFinished) { controller.abort(); } });
        try {
            if (req.method === 'GET' && req.url === '/ready') { res.end('{"ready":true}'); return; }
            if (req.method !== 'POST' || req.url !== '/call') { res.writeHead(404); res.end('{}'); return; }
            const { host, input } = await readMessage(req, 64 * 1024);
            res.end(JSON.stringify(await execute(host, input, controller.signal)));
        } catch (error) { res.end(JSON.stringify({ error: error.message || '工作台文档工具执行失败。' })); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    return server;
}

function request(socket, message) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: socket, path: message ? '/call' : '/ready', method: message ? 'POST' : 'GET',
            agent: false, signal: AbortSignal.timeout(message ? 60000 : 1500) }, res => {
            readMessage(res, 1024 * 1024).then(resolve, reject);
        });
        req.on('error', reject);
        req.end(message && JSON.stringify(message));
    });
}

function startBackground(userData) {
    if (!process.versions.electron) { throw new Error('请打开工作台或通过已安装的工作台入口调用文档工具。'); }
    const env = { ...process.env, OPENSPEC_GUI_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = ['--workbench-document-tools'];
    if (!__dirname.includes('app.asar')) { args.unshift(path.resolve(__dirname, '../..')); }
    const child = spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' });
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}

async function invoke(userData, message) {
    const socket = await socketPath(userData);
    try { await request(socket); }
    catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) { throw error; }
        await startBackground(userData);
        const deadline = Date.now() + 12000;
        for (;;) {
            await delay(150);
            try { if ((await request(socket)).ready) { break; } }
            catch (problem) { if (!['ENOENT', 'ECONNREFUSED'].includes(problem.code)) { throw problem; } }
            if (Date.now() >= deadline) { throw new Error('工作台文档服务启动超时，请打开工作台后重试。'); }
        }
    }
    // 只重试服务发现。评论可能已经落地，断开后不可自动重发写请求。
    const result = await request(socket, message);
    if (result.error) { throw new Error(result.error); }
    return result;
}

module.exports = { listen, invoke };
