'use strict';

const { findProject, capabilities } = require('./workbench-hook.cjs');
const { feishuTools, basicReadTool, callFeishuTool } = require('./feishu-document-tools');
const { googleDriveTools, callGoogleDriveTool } = require('./google-drive-tools');

const hosts = ['codex', 'claude', 'dsh'];
const drivers = [
    { provider: 'feishu', tools: feishuTools, call: callFeishuTool },
    { provider: 'google-drive', tools: googleDriveTools, call: callGoogleDriveTool }
];

async function readMessage(stream, maximum) {
    const parts = [];
    let size = 0;
    for await (const part of stream) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > maximum) { throw new Error('文档工具消息超过长度限制。'); }
        parts.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new Error('文档工具需要一个 JSON 对象。'); }
}

function checkRequest(host, input) {
    if (!hosts.includes(host) || !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('文档工具的宿主或请求格式无效。');
    }
}

function selection(userData, host, cwd) {
    const project = findProject(cwd, userData);
    if (!project) { return []; }
    const selected = capabilities(project, host, userData);
    const available = [];
    for (const driver of drivers) {
        const binding = selected.find(b => b.id === driver.provider && b.kind === 'tool');
        if (!binding) { continue; }
        const version = binding.version.version;
        const full = version === '3.0.0';
        if (!(driver.provider === 'google-drive' ? version === '1.0.0' : ['1.0.0','2.0.0','3.0.0'].includes(version))) { continue; }
        const ctx = { root: project.rootPath, projectId: project.id, host, bindingVersion: version };
        const definitions = driver.provider === 'feishu' && !full ? [basicReadTool] : driver.tools;
        for (const definition of definitions) {
            available.push({ definition, driver, ctx });
        }
    }
    return available;
}

function selectCall(userData, host, input) {
    checkRequest(host, input);
    if (input.action !== 'call' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
        throw new Error('请提供工具名与 arguments 对象。');
    }
    const selected = selection(userData, host, input.cwd).find(item => item.definition.name === input.name);
    if (!selected) { throw new Error('当前工作树和宿主没有启用此工具，请在工作台「能力绑定」选择对应宿主和版本。'); }
    if (Object.keys(input.arguments).some(key => !Object.hasOwn(selected.definition.inputSchema.properties, key))) {
        throw new Error('当前绑定版本不支持该工具参数。请根据此宿主的工具列表调用。');
    }
    if (selected.driver.provider === 'feishu' && selected.ctx.bindingVersion !== '3.0.0' &&
        typeof input.arguments.document === 'string' && /\/wiki\//.test(input.arguments.document)) {
        throw new Error('读取知识库链接需要在此宿主选用飞书 3.0 并授权知识库节点读取。');
    }
    return selected;
}

/** 只在工作台主进程内解密授权并调用厂商；每次调用都重新解析项目和绑定。 */
async function execute(userData, services, host, input, signal) {
    signal?.throwIfAborted();
    const { driver, ctx } = selectCall(userData, host, input);
    const connections = services.get(ctx).documentConnections;
    return { result: await driver.call(connections, input.name, input.arguments, signal) };
}

async function fromHost(userData, host, input) {
    checkRequest(host, input);
    if (input.action === 'catalog') { return { tools: drivers.flatMap(driver => driver.tools) }; }
    // DSH 原生插件也在宿主会话的本机工作目录内启动此命令。
    const cwd = process.cwd();
    if (input.action === 'list') {
        return { tools: selection(userData, host, cwd).map(entry => entry.definition) };
    }
    const request = { ...input, cwd };
    selectCall(userData, host, request);
    return require('./document-tool-broker').invoke(userData, { host, input: request });
}

module.exports = { readMessage, fromHost, execute };
