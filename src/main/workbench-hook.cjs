'use strict';

// 稳定启动器指定实际工作台数据目录。本文件也可独立部署在该目录的 host-integration/bin。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const userData = fs.realpathSync(process.env.OPENSPEC_GUI_HOOK_USER_DATA || path.resolve(__dirname, '../..'));
const maxBytes = 8 * 1024 * 1024;
const readFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const receiptName = /^\d{13}-[a-f0-9-]{36}\.json$/;

function readBytes(file, limit, expectedMode) {
    const fd = fs.openSync(file, readFlags);
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > limit || (expectedMode !== undefined &&
            (info.nlink !== 1 || (info.mode & 0o7777) !== expectedMode))) { throw new Error(); }
        const data = Buffer.alloc(info.size + 1);
        if (fs.readSync(fd, data, 0, data.length, 0) !== info.size) { throw new Error(); }
        return data.subarray(0, info.size);
    } finally { fs.closeSync(fd); }
}

function readRegistry(file, empty, directory = userData) {
    try { return JSON.parse(readBytes(path.join(directory, file), maxBytes).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') { return empty; } throw error; }
}

function findProject(cwd, directory = userData) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) { return null; }
    let current;
    try {
        current = fs.realpathSync(cwd);
        if (!fs.statSync(current).isDirectory()) { return null; }
    } catch { return null; }
    const registry = readRegistry('projects.json', { version: 1, projects: [] }, directory);
    if (registry.version !== 1 || !Array.isArray(registry.projects)) { throw new Error(); }
    for (;;) {
        const matching = registry.projects.filter(p => p?.rootPath === current);
        // .git 也可能是 worktree 定位文件。未登记的子仓库不能继承父仓库绑定。
        const gitBoundary = !!fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false });
        if (matching.length) {
            const project = matching[0];
            if (matching.length !== 1 || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.id)) { return null; }
            return gitBoundary || fs.statSync(path.join(current, 'openspec'), { throwIfNoEntry: false })?.isDirectory()
                ? project : null;
        }
        const parent = path.dirname(current);
        if (gitBoundary || current === parent) { return null; }
        current = parent;
    }
}

function capabilities(project, host, directory = userData) {
    const registry = readRegistry('capabilities/registry.json', { schema: 2, bindings: [], records: [] }, directory);
    if (registry.schema !== 2 || !Array.isArray(registry.bindings) || !Array.isArray(registry.records)) { throw new Error(); }
    const bindings = [];
    for (const b of registry.bindings) {
        if (b.root !== project.rootPath || b.host !== host || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(b.id)) { continue; }
        const record = registry.records.find(r => r.id === b.id);
        const version = record?.versions?.find(v => v.builtin === true && v.version === b.version);
        if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version.version) || !/^[a-f0-9]{64}$/.test(version.digest)) { continue; }
        bindings.push({ id: b.id, kind: record.kind, version });
    }
    return bindings;
}

class SnapshotError extends Error {}
class GitCheckTimeout extends Error {}

/** 按绑定时 readSource 的排序、文件名、可执行位与字节重算 SHA-256。 */
function verifiedEntry({ id, kind, version }) {
    try {
        const base = path.join(userData, 'capabilities', 'versions', version.digest);
        const name = kind === 'skill' ? 'SKILL.md' : path.basename(version.source);
        const entry = path.join(base, name);
        if (!/^[^/\x00-\x1f]+\.md$/i.test(name) || (version.localEntry && version.localEntry !== entry)) { throw new Error(); }
        const files = [];
        let count = 0;
        let bytes = 0;
        let content;

        function visit(relative, depth) {
            if (depth > 10 || ++count > 512) { throw new Error(); }
            const file = path.join(base, relative);
            const info = fs.lstatSync(file);
            if (info.isDirectory()) {
                if ((info.mode & 0o022) || fs.realpathSync(file) !== file) { throw new Error(); }
                const children = fs.readdirSync(file).sort();
                // 物化过程只为文件创建父目录，空目录表示安装后有外部改动。
                if (!children.length || children.length > 512 - count) { throw new Error(); }
                for (const child of children) { visit(path.join(relative, child), depth + 1); }
                return;
            }
            const executable = Boolean(info.mode & 0o111);
            const data = readBytes(file, maxBytes - bytes, executable ? 0o700 : 0o600);
            bytes += data.length;
            files.push({ path: relative, executable, data: data.toString('base64') });
            if (relative === name) { content = data; }
        }

        visit('', 0);
        const actual = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
        if (actual !== version.digest || !content || (kind === 'rule' && files.length !== 1)) { throw new Error(); }
        // 规范直接从已参与摘要的字节注入，避免二次读取时内容发生变化。
        return { entry, content };
    } catch { throw new SnapshotError(id + '@' + version.version + ' 的本机快照未通过完整性校验'); }
}

function defectSetting(root) {
    const key = crypto.createHash('sha256').update(root).digest('hex');
    const reference = path.join('capability-projects', key, 'dsh', 'feishu-defect-bindings', key, 'reference.json');
    const file = readRegistry(reference, null)?.path;
    if (typeof file === 'string' && path.isAbsolute(file) && path.extname(file).toLowerCase() === '.json' &&
        !/[\x00-\x1f]/.test(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) { return file; }
    return null;
}

function sessionContext(bindings, host, root) {
    const sections = [];
    for (const binding of bindings) {
        if (!['rule', 'skill'].includes(binding.kind)) { continue; }
        const { entry, content } = verifiedEntry(binding);
        if (binding.kind === 'skill') {
            let setting = '';
            if (host === 'dsh' && binding.id === 'feishu-defect-agent') {
                const file = defectSetting(root);
                if (!file) {
                    sections.push('使用飞书缺陷前，请先在工作台配置当前项目的 DeepSeek Harness 飞书缺陷设置。');
                    continue;
                }
                const argument = "'" + file.replace(/'/g, "'\\''") + "'";
                setting = '\n在此工作树调用飞书缺陷命令时，显式传入 --binding ' + argument + '。';
            }
            sections.push('Skill ' + binding.id + '@' + binding.version.version + '（按需读取）：' + entry + setting);
        } else {
            sections.push(binding.id + '@' + binding.version.version + '\n' + content.toString('utf8').trim());
        }
    }
    const docs = bindings.filter(binding => binding.kind === 'tool' && ['feishu', 'google-drive'].includes(binding.id));
    if (docs.length) {
        const names = docs.map(binding => binding.id === 'feishu' ? '飞书文档' : 'Google Drive 文件元数据').join('、');
        if (host === 'dsh') {
            sections.push('已绑定的文档服务：' + names + '。用本会话注册的原生文档工具查询或操作。');
        } else {
            const runner = "'" + path.join(userData, 'host-integration', 'bin', 'workbench-hook').replace(/'/g, "'\\''") + "'";
            sections.push('已绑定的文档服务：' + names + '。在本工作树运行 ' + runner + ' --tools ' + host +
                '，标准输入发送 {"action":"list"} 查看可用工具及参数。调用时标准输入发送 {"action":"call","name":"工具名","arguments":{...}}。工作台使用此工作树已连接的账号。');
        }
    }
    if (bindings.some(binding => ['verify-changes', 'archive-synced-specs'].includes(binding.id)) &&
        fs.lstatSync(path.join(root, 'openspec'), { throwIfNoEntry: false })?.isDirectory()) {
        const runner = "'" + path.join(userData, 'host-integration', 'bin', 'workbench-hook').replace(/'/g, "'\\''") + "'";
        sections.push('归档前在此工作树运行 ' + runner + ' --archive preflight <change>。向用户展示预检结果、正式规范差异与目标，取得写入授权后按同一入口执行 --archive commit <change> --review <reviewFingerprint>，逐项传入已确认的 --accept-warning <id>。');
    }
    return sections.length ? '当前项目已启用的工作台规范与 Skill 入口\n\n' + sections.join('\n\n') : '';
}

// 仅检查原生编辑载荷中的新增文本。删除、上下文行和 shell 命令均不参与判断。
function edits(host, event) {
    const input = event.tool_input || {};
    if (host === 'claude' && ['Write', 'Edit'].includes(event.tool_name)) {
        const text = event.tool_name === 'Write' ? input.content : input.new_string;
        return typeof input.file_path === 'string' && typeof text === 'string' ? [{ file: input.file_path, text }] : null;
    }
    if (host === 'dsh' && ['write', 'edit'].includes(event.tool_name)) {
        const text = event.tool_name === 'write' ? input.content : input.new_string;
        return typeof input.file_path === 'string' && typeof text === 'string' ? [{ file: input.file_path, text }] : null;
    }
    const patch = host === 'dsh' ? input.input : input.command;
    if (!['codex', 'dsh'].includes(host) || event.tool_name !== 'apply_patch' || typeof patch !== 'string') { return null; }
    const lines = patch.trimEnd().split(/\r?\n/);
    if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') { return null; }
    const result = [];
    let file = null;
    let added = [];
    const flush = () => { if (file) { result.push({ file, text: added.join('\n') }); } added = []; };
    for (const line of lines) {
        const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
        if (header) { flush(); file = header[1] === 'Delete' ? null : header[2]; }
        else if (line.startsWith('*** Move to: ')) {
            flush(); file = line.slice('*** Move to: '.length);
        } else if (file && line.startsWith('+')) { added.push(line.slice(1)); }
    }
    flush();
    return result;
}

function checkPaths(root, event, changes) {
    const candidates = new Set();
    for (const change of changes) {
        if (!/\.(?:md|mdx|rst|txt)$/i.test(change.file) || !change.text.includes(root + path.sep)) { continue; }
        let target = path.resolve(fs.realpathSync(event.cwd), change.file);
        try {
            // Git 允许跟踪符号链接本身。编辑链接目标时，应按实际文件决定范围。
            target = fs.realpathSync(target);
        } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
        const relative = path.relative(root, target);
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
            candidates.add(relative);
        }
    }
    if (!candidates.size) { return false; }
    // 固定只读 Git 命令。忽略外部 Git 环境及仓库可配置的文件监视程序。
    const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
        'ls-files', '--cached', '-z', '--', ...candidates], { cwd: root, encoding: 'utf8', timeout: 1000, maxBuffer: maxBytes,
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (result.error?.code === 'ETIMEDOUT') { throw new GitCheckTimeout('Git 路径检查超过 1 秒，未取得检查结果'); }
    if (result.error || result.status !== 0) { throw new Error(); }
    return result.stdout.split('\0').some(file => candidates.has(file));
}

function decide(host, event, project, bindings) {
    if (!project) { return { decision: 'skipped', reason: '未匹配唯一的已登记工作树' }; }
    if (!bindings.length) { return { decision: 'skipped', reason: '此工作树和宿主没有生效绑定' }; }
    if (['SessionStart', 'system-prompt/assemble'].includes(event.hook_event_name)) {
        const context = sessionContext(bindings, host, project.rootPath);
        return context ? { decision: 'context', reason: '已提供当前绑定的工作台入口',
            output: { hookEventName: event.hook_event_name, additionalContext: context } } :
            { decision: 'skipped', reason: '没有可提供的规范或 Skill 入口' };
    }
    const rule = bindings.find(b => b.kind === 'rule' && b.id === 'portable-paths' && b.version.version === '1.0.0');
    if (!rule) { return { decision: 'skipped', reason: '此工作树与宿主未启用可执行的路径检查版本' }; }
    const changes = edits(host, event);
    if (!changes || !fs.lstatSync(path.join(project.rootPath, '.git'), { throwIfNoEntry: false })) {
        return { decision: 'skipped', reason: '调用不在已覆盖的 Git 文档编辑范围内' };
    }
    verifiedEntry(rule);
    if (!checkPaths(project.rootPath, event, changes)) {
        return { decision: 'pass', reason: '编辑未向已跟踪文档写入当前检出的绝对路径' };
    }
    const reason = '可移植路径规范要求在已跟踪的仓库文档中使用相对路径引用本工程文件。';
    return { decision: 'deny', reason, output: { hookEventName: event.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// 在 128 份回执的窗口中，给较低频的另一种原生事件保留最近的证据。
function pruneReceipts(dir, otherEvent) {
    const names = fs.readdirSync(dir).filter(name => receiptName.test(name)).sort();
    if (names.length <= 128) { return; }
    const older = names.slice(0, -127).reverse();
    let keep = older[0];
    for (const name of older) {
        try {
            const record = JSON.parse(readBytes(path.join(dir, name), maxBytes, 0o600));
            if (record.event === otherEvent && record.checkVersion === '1.0.0') { keep = name; break; }
        } catch { /* 其他进程也可能已清理此记录。 */ }
    }
    for (const name of older) {
        if (name === keep) { continue; }
        try { fs.unlinkSync(path.join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
}

function receipt(host, event, otherEvent, project, bindings, result) {
    let dir = path.join(userData, 'host-integration');
    for (const name of ['receipts', project?.id || '_unscoped', host]) {
        dir = path.join(dir, name);
        try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') { throw error; } }
        if (fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory()) { throw new Error(); }
    }
    const timestamp = new Date();
    const record = { schema: 1, timestamp: timestamp.toISOString(), projectId: project?.id || null,
        root: project?.rootPath || null, host, event: event.hook_event_name, checkVersion: '1.0.0',
        bindings: bindings.map(b => ({ id: b.id, version: b.version.version })), decision: result.decision, reason: result.reason };
    const name = timestamp.getTime() + '-' + crypto.randomUUID() + '.json';
    const temporary = path.join(dir, '.' + name);
    try {
        fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, path.join(dir, name));
    } finally { fs.rmSync(temporary, { force: true }); }
    pruneReceipts(dir, otherEvent);
}

async function main() {
    const [flag, host] = process.argv.slice(2);
    if (flag === '--tools') {
        try {
            const tools = require('./agent-document-tools');
            const input = await tools.readMessage(process.stdin, 64 * 1024);
            const response = await tools.fromHost(userData, host, input);
            process.stdout.write(JSON.stringify(response) + '\n');
        } catch (error) {
            process.stdout.write(JSON.stringify({ error: error.message || '文档工具调用失败。' }) + '\n');
            process.exitCode = 1;
        }
        return;
    }
    if (flag === '--archive') {
        let project = null;
        const args = process.argv.slice(3);
        try {
            const { archiveFromAgent } = require('./agent-archive');
            project = findProject(process.cwd());
            const result = await archiveFromAgent({ args, project, userDataPath: userData });
            process.stdout.write(JSON.stringify(result) + '\n');
            if (result.status === 'blocked') { process.exitCode = 1; }
        } catch (error) {
            process.stdout.write(JSON.stringify({ status: 'blocked', projectId: project?.id || null, root: project?.rootPath || null,
                changeId: args[1] || null, code: error.code || 'ARCHIVE_ERROR', message: error.message || '无法核对工作台的项目或归档配置。' }) + '\n');
            process.exitCode = 1;
        }
        return;
    }
    if (flag !== '--host' || !['codex', 'claude', 'dsh'].includes(host)) { throw new Error(); }
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > maxBytes) { throw new Error(); }
        chunks.push(chunk);
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const events = host === 'dsh' ? ['system-prompt/assemble', 'tools.guard'] : ['SessionStart', 'PreToolUse'];
    if (!events.includes(event.hook_event_name)) { return; }
    let project = null;
    let bindings = [];
    let result;
    try {
        project = findProject(event.cwd);
        if (project) { bindings = capabilities(project, host); }
        result = decide(host, event, project, bindings);
    } catch (error) {
        result = error instanceof GitCheckTimeout ? { decision: 'timeout', reason: error.message } :
            { decision: 'error', reason: error instanceof SnapshotError ? error.message : '无法读取本机配置或完成检查' };
        process.exitCode = 1;
    }
    if (result.output) { process.stdout.write(JSON.stringify({ hookSpecificOutput: result.output }) + '\n'); }
    try { receipt(host, event, events.find(name => name !== event.hook_event_name), project, bindings, result); }
    catch { process.stderr.write('工作台钩子无法保存本机回执。\n'); }
    if (process.exitCode === 1) { process.stderr.write(result.reason + '。\n'); }
}

module.exports = { findProject, capabilities };
if (require.main === module) {
    main().catch(() => { process.stderr.write('工作台钩子无法解析本次事件。\n'); process.exitCode = 1; });
}
