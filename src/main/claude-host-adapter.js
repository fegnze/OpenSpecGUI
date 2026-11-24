'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { resolveConfigDirectory } = require('./local-config');

const EVENT_NAMES = ['SessionStart', 'PreToolUse'];
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
// Claude Code 1.0.38 首次支持 hooks，1.0.62 加入 SessionStart。
function supportedEvents(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) { return null; }
    const [major, minor, patch] = match.slice(1).map(Number);
    const supports = minimum => major > 1 || (major === 1 && (minor > 0 || patch >= minimum));
    return [
        { name: 'SessionStart', supported: supports(62), detail: '读取会话开始或恢复时的工作目录。' },
        { name: 'PreToolUse', supported: supports(38), detail: '同步检查宿主触发的工具调用，可返回拒绝决定。' }
    ];
}

async function readUserSettings(file) {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') { return {}; } throw error; }
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) { throw new Error('settings'); }
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) { break; }
            length += bytesRead;
        }
        if (length !== info.size) { throw new Error('settings'); }
        return JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, ''));
    } finally { await handle.close(); }
}

function registration(groups = [], command, runnerPath) {
    if (!Array.isArray(groups)) { return 'conflict'; }
    let count = 0;
    for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) { return 'conflict'; }
        for (const handler of group.hooks) {
            if (!isObject(handler)) { return 'conflict'; }
            if (typeof handler.command !== 'string') { continue; }
            if (handler.command !== command) {
                if (handler.command.includes(runnerPath) || handler.command.includes(command)) { return 'conflict'; }
                continue;
            }
            if (handler.type !== 'command' || ![undefined, '', '*'].includes(group.matcher) ||
                Object.keys(handler).some(key => !['type', 'command'].includes(key))) { return 'conflict'; }
            count++;
        }
    }
    return count > 1 ? 'conflict' : count === 1 ? 'present' : 'missing';
}

/** 生成本机用户级钩子片段，仅读取注册相关字段，实际工作区信任由宿主决定。 */
async function inspectClaude({ version, home, env = {}, runnerPath }) {
    const events = supportedEvents(version);
    const result = { status: 'unknown', detail: '', events: events || [], targets: [], nextSteps: [] };
    if (!events) { return { ...result, detail: '无法确认该版本支持的钩子。' }; }
    if (events.some(event => !event.supported)) {
        return { ...result, status: 'incompatible', detail: '两项钩子需要 Claude Code 1.0.62 或更高版本。', nextSteps: ['更新 Claude Code 后重新检测。'] };
    }
    let directory = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    if (!path.isAbsolute(directory) || !path.isAbsolute(runnerPath) || /[\0\r\n]/.test(runnerPath)) {
        return { ...result, detail: '无法确定本机用户设置或钩子程序的绝对路径。' };
    }
    try { directory = await resolveConfigDirectory(directory); }
    catch { return { ...result, status: 'conflict', detail: '无法访问 Claude Code 用户配置目录。' }; }
    const settingsFile = path.join(directory, 'settings.json');
    const command = "'" + runnerPath.replace(/'/g, "'\\''") + "' --host claude";
    const hooks = Object.fromEntries(EVENT_NAMES.map(name => [name, [{ hooks: [{ type: 'command', command }] }]]));
    result.targets.push({ path: settingsFile, description: '用户级配置片段，按事件合并。钩子以当前操作系统用户身份运行。',
        preview: JSON.stringify({ hooks }, null, 2) });
    let settings;
    try { settings = await readUserSettings(settingsFile); }
    catch {
        return { ...result, status: 'conflict', detail: '无法检查用户设置，请核对读取权限、文件类型和 JSON 格式。',
            nextSteps: ['使用 claude doctor 查看宿主报告的配置问题。'] };
    }
    if (!isObject(settings) || (settings.hooks !== undefined && !isObject(settings.hooks)) ||
        (settings.disableAllHooks !== undefined && typeof settings.disableAllHooks !== 'boolean')) {
        return { ...result, status: 'conflict', detail: '用户设置中的钩子配置格式无效。' };
    }
    if (settings.disableAllHooks === true) {
        return { ...result, status: 'disabled', detail: '用户设置已启用 disableAllHooks。', nextSteps: ['在 Claude Code 中检查当前会话生效的设置来源。'] };
    }
    const entries = EVENT_NAMES.map(name => registration(settings.hooks?.[name], command, runnerPath));
    if (entries.includes('conflict')) {
        return { ...result, status: 'conflict', detail: '钩子结构异常，或工作台命令的注册方式与预览不同。',
            nextSteps: ['在 Claude Code 的 /hooks 中核对这两个事件的来源和命令。'] };
    }
    result.nextSteps = ['在目标工作树启动 Claude Code，在交互会话中确认工作区信任，通过 /hooks 查看已加载的钩子。'];
    const missing = EVENT_NAMES.filter((name, index) => entries[index] === 'missing');
    if (missing.length) {
        const needed = Object.fromEntries(missing.map(name => [name, hooks[name]]));
        result.targets[0].preview = JSON.stringify({ hooks: needed }, null, 2);
        return { ...result, status: 'available', missingEvents: missing, detail: '用户设置待添加 ' + missing.join('、') + '。' };
    }
    return { ...result, status: 'configured', detail: '用户设置已登记两项钩子，实际触发待宿主会话验证。' };
}

module.exports = { inspectClaude };
