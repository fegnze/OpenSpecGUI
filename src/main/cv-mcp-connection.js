'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJson } = require('./local-config');

const { name, version } = require('../../package.json');
const ENDPOINT = require('../capabilities/mcp/cv-test1.json').url;
const PROTOCOLS = ['2025-11-25','2025-06-18','2025-03-26'];
const MAX_RESPONSE = 2 * 1024 * 1024;

function responseValue(message, id) {
    if (!message || message.jsonrpc !== '2.0' || message.id !== id || message.error || !message.result || typeof message.result !== 'object') {
        throw new Error('服务未返回有效的 MCP 响应');
    }
    return message.result;
}

async function rpcResult(response, id) {
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['application/json','text/event-stream'].includes(type) || !response.body) { throw new Error('服务响应格式不兼容'); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', bytes = 0;
    function eventResult(event) {
        const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) { return; }
        const message = JSON.parse(payload);
        if (message.id === id) { return responseValue(message, id); }
    }
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) { break; }
            bytes += chunk.value.length;
            if (bytes > MAX_RESPONSE) { throw new Error('MCP 响应超出大小限制'); }
            buffer += decoder.decode(chunk.value, { stream: true });
            if (type === 'text/event-stream') {
                const events = buffer.split(/\r?\n\r?\n/);
                buffer = events.pop();
                for (const event of events) { const result = eventResult(event); if (result) { return result; } }
            }
        }
        buffer += decoder.decode();
        if (type === 'application/json') { return responseValue(JSON.parse(buffer), id); }
        const result = eventResult(buffer);
        if (result) { return result; }
        throw new Error('MCP 未返回匹配请求的结果');
    } finally { await reader.cancel().catch(() => {}); }
}

async function probe(token, request) {
    const safeMetadata = (value, maximum) => typeof value === 'string' && !value.includes(token) && !/[\x00-\x1f]/.test(value) ? value.slice(0, maximum) : '';
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const signal = AbortSignal.timeout(15000);
    async function post(body) {
        const response = await request(ENDPOINT, { method:'POST', headers: { ...headers }, redirect:'error', signal, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error('MCP 连接失败（HTTP ' + response.status + '）');
        }
        return response;
    }
    const response = await post({ id: 1, method:'initialize', params: { protocolVersion:PROTOCOLS[0], capabilities:{}, clientInfo: { name, version } } });
    const result = await rpcResult(response, 1);
    if (!PROTOCOLS.includes(result.protocolVersion) || !result.serverInfo || typeof result.serverInfo.name !== 'string' || !result.capabilities) {
        throw new Error('MCP 服务初始化信息不兼容');
    }
    const session = response.headers.get('mcp-session-id');
    if (session) { headers['Mcp-Session-Id'] = session; }
    headers['MCP-Protocol-Version'] = result.protocolVersion;
    try {
        const initialized = await post({method:'notifications/initialized'});
        await initialized.body?.cancel();
        let toolNames = [];
        if (result.capabilities.tools) {
            const listing = await rpcResult(await post({ id:2, method:'tools/list', params:{} }), 2);
            if (!Array.isArray(listing.tools)) { throw new Error('MCP 工具列表无效'); }
            toolNames = listing.tools.slice(0,128).map(tool => safeMetadata(tool.name, 128)).filter(Boolean);
        }
        return { serverVersion: safeMetadata(result.serverInfo.version, 100), toolNames };
    } finally {
        if (session) {
            try {
                const closed = await request(ENDPOINT, { method:'DELETE', headers, redirect:'error', signal:AbortSignal.timeout(2000) });
                await closed.body?.cancel();
            } catch { /* 服务可以自行释放会话。 */ }
        }
    }
}

class CvMcpConnection {
    constructor({ userDataPath, safeStorage, fetch: request = fetch }) {
        this.file = path.join(userDataPath, 'connections', 'cv-test1.json');
        this.storage = safeStorage;
        this.request = request;
        this.pending = Promise.resolve();
    }
    run(task) {
        const job = this.pending.then(task);
        this.pending = job.catch(() => {});
        return job;
    }
    async status() {
        const record = await readJson(this.file, null);
        let state = 'disconnected';
        if (record?.secret) { state = record.verifiedAt ? 'verified' : 'connected'; }
        return { provider:'cv-test1', endpoint:ENDPOINT, state, connected:state !== 'disconnected',
            verifiedAt:record?.verifiedAt || null, serverVersion:record?.serverVersion || '', toolNames:record?.toolNames || [],
            message: ({ disconnected:'待填写个人 Bearer Token', connected:'凭据已保存，待验证连接', verified:'已完成 MCP 握手' })[state] };
    }
    connect(settings) {
        return this.run(async () => {
            const token = settings?.token?.trim();
            if (!token || !/^[A-Za-z0-9._~+\/=-]{1,8192}$/.test(token)) { throw new Error('请填写有效的个人 Bearer Token'); }
            if (!this.storage.isEncryptionAvailable() || this.storage.getSelectedStorageBackend?.() === 'basic_text') { throw new Error('系统凭据加密存储不可用'); }
            const secret = this.storage.encryptString(token).toString('base64');
            await writeJson(this.file, { secret });
            return this.status();
        });
    }
    reuseFrom(other) {
        return this.run(async () => {
            const prior = await readJson(other.file, null);
            if (!prior?.secret) { throw new Error('没有可复用的个人凭据'); }
            await writeJson(this.file, { secret: prior.secret });
            return this.status();
        });
    }
    verify() {
        return this.run(async () => {
            const record = await readJson(this.file, null);
            if (!record?.secret) { throw new Error('请先填写个人 Bearer Token'); }
            await writeJson(this.file, { secret:record.secret });
            let token;
            try { token = this.storage.decryptString(Buffer.from(record.secret, 'base64')); }
            catch { throw new Error('系统无法解密此凭据，请重新设置'); }
            let observed;
            try { observed = await probe(token, this.request); }
            catch (error) {
                const status = /HTTP (\d{3})/.exec(error.message);
                throw new Error(status ? 'MCP 连接验证失败（HTTP ' + status[1] + '）' : 'MCP 验证未完成，请检查网络、凭据和服务的协议支持');
            }
            await writeJson(this.file, { secret:record.secret, ...observed, verifiedAt:new Date().toISOString() });
            return this.status();
        });
    }
    disconnect() {
        return this.run(async () => { await fs.rm(this.file, { force:true }); return this.status(); });
    }
}

module.exports = { CvMcpConnection, probe, ENDPOINT };
