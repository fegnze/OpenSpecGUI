'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { resolveConfigDirectory } = require('./local-config');
const { createHash } = require('node:crypto');
const { parse: parseToml } = require('smol-toml');

const events = ['SessionStart', 'PreToolUse'];
const stateNames = { SessionStart: 'session_start', PreToolUse: 'pre_tool_use' };
const maxConfigBytes = 4 * 1024 * 1024;
const isTable = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// 0.129.0 的正式版引入 /hooks、按定义信任和默认启用的稳定 hooks。
// https://github.com/openai/codex/releases/tag/rust-v0.129.0
function supportsHookTrust(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(version);
    if (!match) { return null; }
    const [, major, minor, patch, pre] = match;
    return Number(major) > 0 || Number(minor) > 129 || (Number(minor) === 129 && (Number(patch) > 0 || !pre));
}

async function readConfig(file, parse) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxConfigBytes) { throw new Error(); }
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== info.size) { throw new Error(); }
        const result = parse(buffer.toString('utf8', 0, bytesRead));
        if (!isTable(result)) { throw new Error(); }
        return result;
    } catch (error) {
        if (error.code === 'ENOENT') { return {}; }
        throw new Error('无法读取或解析 ' + path.basename(file) + '，请检查文件格式、大小与访问权限。');
    } finally { if (handle) { await handle.close(); } }
}

const legacyBrand = 'OpenSpec GUI';
const brand = require('../../package.json').productName;
function makeHandler(event, command, label = brand) {
    return { type: 'command', command, timeout: 5, statusMessage: label + ' · ' + event };
}

// Codex 对单个规范化处理项的有序 JSON 求 SHA-256。此处只核对我们生成的固定处理项。
// https://github.com/openai/codex/blob/rust-v0.129.0/codex-rs/hooks/src/engine/discovery.rs
function trustedHash(event, handler, matcher) {
    const identity = {
        event_name: stateNames[event],
        hooks: [{ async: false, command: handler.command, statusMessage: handler.statusMessage, timeout: handler.timeout, type: 'command' }]
    };
    if (matcher !== undefined) { identity.matcher = matcher; }
    return 'sha256:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

// 仅返回本工作台的匹配项，其他命令及其参数不进入 IPC 响应。
function findEntries(hooks, file, runnerPath, command, found) {
    if (!isTable(hooks)) { throw new Error('Codex 的 hooks 配置格式无效。'); }
    for (const [event, groups] of Object.entries(hooks)) {
        if (event === 'state') { continue; }
        if (!Array.isArray(groups)) { throw new Error('Codex 的钩子事件应包含匹配组列表。'); }
        groups.forEach((group, groupIndex) => {
            if (!Array.isArray(group?.hooks)) { throw new Error('Codex 的钩子匹配组缺少 hooks 列表。'); }
            group.hooks.forEach((handler, index) => {
                if (!isTable(handler)) { throw new Error('Codex 钩子处理项格式无效。'); }
                // 已被宿主信任的定义沿用原文及哈希，新安装显示当前产品名。
                const label = [brand, legacyBrand].find(value => events.some(name => handler.statusMessage === value + ' · ' + name));
                const invokesRunner = typeof handler.command === 'string' &&
                    (handler.command.includes(runnerPath) || handler.command.includes(command));
                if (!label && !invokesRunner) { return; }
                const expected = makeHandler(event, command, label);
                if (!events.includes(event) || ![undefined, '', '*'].includes(group.matcher) ||
                    !Object.keys(group).every(k => ['matcher', 'hooks'].includes(k)) ||
                    !Object.entries(expected).every(([k, v]) => handler[k] === v) ||
                    !Object.keys(handler).every(k => Object.hasOwn(expected, k)) || found.has(event)) {
                    throw new Error('工作台钩子的命令、匹配条件或登记数量有冲突。请在 Codex /hooks 核对现有条目。');
                }
                found.set(event, { key: file + ':' + stateNames[event] + ':' + groupIndex + ':' + index,
                    hash: trustedHash(event, expected, group.matcher) });
            });
        });
    }
}

/** 检查 Codex 的用户层配置，输出待合并的两类原生事件。宿主负责实际信任和运行验证。 */
async function inspectCodex({ version, home, env = {}, runnerPath, systemConfigDir = '/etc/codex' }) {
    const supported = supportsHookTrust(version);
    const result = {
        status: 'available', detail: '', targets: [], nextSteps: [],
        events: events.map(name => ({ name, supported: supported === true, detail: name === 'SessionStart'
            ? '会话启动与恢复时提供项目规则入口。' : '工具调用前同步检查，覆盖范围由 Codex 决定。' }))
    };
    if (!supported) {
        result.status = supported === null ? 'unknown' : 'incompatible';
        result.detail = '此接入需要带有原生钩子信任审阅的 Codex CLI 0.129.0 或更高版本。';
        return result;
    }
    let codexHome = env.CODEX_HOME || path.join(home, '.codex');
    if (!path.isAbsolute(codexHome) || !path.isAbsolute(runnerPath)) {
        return { ...result, status: 'unknown', detail: 'Codex 用户配置目录和工作台入口均需使用绝对路径。' };
    }
    try { codexHome = await resolveConfigDirectory(codexHome); }
    catch { return { ...result, status: 'conflict', detail: '无法访问 Codex 用户配置目录。' }; }
    result.configurationPath = path.join(codexHome, 'hooks.json');
    const configFile = path.join(codexHome, 'config.toml');
    const hooksFile = path.join(codexHome, 'hooks.json');
    const command = "'" + runnerPath.replace(/'/g, "'\\''") + "' --host codex";
    const found = new Map();
    let config;
    try {
        const [user, document, requirements] = await Promise.all([
            readConfig(configFile, parseToml), readConfig(hooksFile, JSON.parse),
            readConfig(path.join(systemConfigDir, 'requirements.toml'), parseToml)
        ]);
        config = user;
        if (requirements.allow_managed_hooks_only === true || requirements.features?.hooks === false ||
            requirements.features?.codex_hooks === false) {
            return { ...result, status: 'disabled', detail: '本机 Codex 管理策略限制了用户钩子。', nextSteps: ['请向宿主管理员核对 requirements.toml。'] };
        }
        const features = config.features || {};
        const profileFlags = config.profiles?.[config.profile]?.features || {};
        const enabled = profileFlags.hooks ?? profileFlags.codex_hooks ?? features.hooks ?? features.codex_hooks;
        if (enabled === false) {
            return { ...result, status: 'disabled', detail: 'Codex 用户配置已关闭 hooks。', nextSteps: ['检查当前配置的 features.hooks，再重新检测。'] };
        }
        if (enabled !== undefined && typeof enabled !== 'boolean') { throw new Error('Codex 的 hooks 功能开关格式无效。'); }
        if (Object.keys(document).some(key => !['description', 'hooks'].includes(key))) {
            throw new Error('hooks.json 含有不受支持的顶层字段，请在 Codex 中检查该文件。');
        }
        findEntries(document.hooks === undefined ? {} : document.hooks, hooksFile, runnerPath, command, found);
        findEntries(config.hooks === undefined ? {} : config.hooks, configFile, runnerPath, command, found);
    } catch (error) {
        return { ...result, status: 'conflict', detail: error.message };
    }
    const required = events.filter(name => !found.has(name));
    if (required.length) {
        const fragment = { hooks: Object.fromEntries(required.map(name => [name, [{ hooks: [makeHandler(name, command)] }]])) };
        result.targets.push({ path: hooksFile, description: '追加当前用户缺少的工作台事件。', preview: JSON.stringify(fragment, null, 2) });
        result.detail = found.size ? '部分入口已登记，可预览待补充的事件。' : '当前用户可接入工作台钩子。';
        result.nextSteps.push('安装后在 Codex 中打开 /hooks，审阅并信任两个入口。');
        return result;
    }
    const entries = [...found.values()];
    const states = config.hooks?.state || {};
    if (entries.some(entry => states[entry.key]?.enabled === false)) {
        return { ...result, status: 'disabled', detail: 'Codex 已停用工作台的钩子。', nextSteps: ['在 Codex /hooks 中核对入口的启用状态。'] };
    }
    if (entries.some(entry => states[entry.key]?.trusted_hash !== entry.hash)) {
        return { ...result, status: 'needs-trust', detail: '已登记工作台入口，部分钩子的当前定义待信任。', nextSteps: ['在 Codex 中打开 /hooks，审阅并信任对应入口。'] };
    }
    return { ...result, status: 'configured', detail: '两项原生入口均已登记，已有本地信任记录。',
        nextSteps: ['在 Codex /hooks 中确认当前定义的信任状态，在新会话中验证触发。'] };
}

module.exports = { inspectCodex };
