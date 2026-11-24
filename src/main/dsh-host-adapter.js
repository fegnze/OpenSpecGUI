'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveConfigDirectory } = require('./local-config');
const { inspectDshPatch } = require('./dsh-registration');

const hooks = [
    { name: 'system-prompt/assemble', detail: '为本机工作树提供已绑定的基础规范和 Skill 入口。' },
    { name: 'tools.guard', detail: '在工具执行前检查已覆盖的文件编辑，保留宿主权限判断。' }
];

// 该桌面版引入本适配器核对过的 Cordis 服务契约，0.x 跨次版本须重新验证。
function supportedVersion(version) {
    const match = /^0\.2\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(version);
    if (!match) { return false; }
    if (Number(match[1]) !== 2) { return Number(match[1]) > 2; }
    return !match[2] || /^rc\.\d+$/.test(match[2]) && Number(match[2].slice(3)) >= 5;
}

const pluginPath = path.join(__dirname, 'dsh-plugin', 'index.mjs').replace(/\/app\.asar\//, '/app.asar.unpacked/');

async function desktopPatchPath(home, env) {
    const dshHome = env.DSH_HOME?.trim() || path.join(home, '.dsh');
    if (!path.isAbsolute(dshHome)) { throw new Error('请为 DSH_HOME 设置绝对路径后重新检测。'); }
    const directory = await resolveConfigDirectory(path.join(dshHome, 'profiles', 'desktop'));
    return path.join(directory, 'cordis.patch.yml');
}

async function inspectDsh({ version, home, env = {}, runnerPath }) {
    const supported = supportedVersion(version);
    const result = { status: 'incompatible', detail: '此接入支持 DeepSeek Harness 桌面版 0.2.2-rc.5 起的 0.2.x 系列。',
        events: hooks.map(event => ({ ...event, supported })), targets: [], nextSteps: [] };
    if (!supported) { return result; }
    const dshHome = env.DSH_HOME?.trim() || path.join(home, '.dsh');
    if (!path.isAbsolute(dshHome)) { return { ...result, status: 'unknown', detail: '请为 DSH_HOME 设置绝对路径后重新检测。' }; }
    try { await fs.access(pluginPath); }
    catch { return { ...result, status: 'unknown', detail: '此工作台缺少供 DeepSeek Harness 加载的插件文件，请重新安装完整应用。' }; }
    try {
        result.configurationPath = await desktopPatchPath(home, env);
        const entry = { id: 'openspec-gui-workbench', name: pluginPath, config: { runnerPath } };
        const checked = await inspectDshPatch(result.configurationPath, entry);
        if (checked === 'conflict') {
            return { ...result, status: 'conflict', detail: '桌面 profile 中的工作台插件登记有冲突，请核对 cordis.patch.yml 中的 openspec-gui-workbench。' };
        }
        result.nextSteps = ['接入后在 DeepSeek Harness 打开本机项目的新会话；配置未重新载入时，可重启宿主。'];
        if (checked === 'present') { return { ...result, status: 'configured', detail: '桌面 profile 已登记工作台插件，实际触发待会话验证。' }; }
        result.targets = [{ path: result.configurationPath, description: '在桌面 profile 的用户补丁中追加本机插件。', preview: JSON.stringify({ insert: [entry] }, null, 2) }];
        return { ...result, status: 'available', detail: '可将项目上下文和工具检查接入本机桌面会话。', missingEvents: hooks.map(event => event.name) };
    } catch {
        return { ...result, status: 'conflict', detail: '无法安全读取桌面 profile，请核对 cordis.patch.yml 的格式、文件类型和访问权限。' };
    }
}

module.exports = { inspectDsh, desktopPatchPath, pluginPath };
