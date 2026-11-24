'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findCli } = require('./local-cli');
const { readJson, writeJson } = require('./local-config');

const exec = promisify(execFile);
const hosts = [
    { id: 'codex', name: 'Codex', inspect: options => require('./codex-host-adapter').inspectCodex(options),
        version: /^codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/ },
    { id: 'claude', name: 'Claude Code', inspect: options => require('./claude-host-adapter').inspectClaude(options),
        version: /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?) \(Claude Code\)$/ },
    { id: 'dsh', name: 'DeepSeek Harness', inspect: options => require('./dsh-host-adapter').inspectDsh(options),
        version: /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/ }
];

/** 从工作台进程指定的用户安装位置检查宿主。探测与打开的项目无关。 */
class HostIntegration {
    constructor({ userDataPath, getActive = () => null, home = os.homedir(), env = process.env, baseDirs, maintainInstalledPaths = false,
        applicationDirs = ['/Applications', path.join(home, 'Applications')] }) {
        this.userDataPath = userDataPath;
        this.getActive = getActive;
        this.queue = Promise.resolve();
        this.completed = new Map();
        this.hostVersions = new Map();
        this.savedVersions = new Map();
        this.maintainInstalledPaths = maintainInstalledPaths;
        this.home = home;
        this.env = env;
        this.baseDirs = baseDirs;
        this.applicationDirs = applicationDirs;
        this.runnerPath = path.join(userDataPath, 'host-integration', 'bin', 'workbench-hook');
    }

    enqueue(task) {
        const result = this.queue.then(task);
        this.queue = result.catch(() => {});
        return result;
    }

    /** 安装包移动后修复本工作台登记的路径。只对已有入口操作，失败时宿主页面可再次检测。 */
    async refreshInstalledPaths() {
        if (!this.maintainInstalledPaths) { return; }
        try {
            if (await this.launcher.state() === 'update') { await this.launcher.install(); }
            const registration = this.registrationFor('dsh');
            const record = await registration.readLedger();
            if (!record) { return; }
            const { desktopPatchPath, pluginPath } = require('./dsh-host-adapter');
            if (record.entry.name === pluginPath || record.targetPath !== await desktopPatchPath(this.home, this.env)) { return; }
            await fs.access(pluginPath);
            await registration.relocate({ targetPath: record.targetPath, runnerPath: this.runnerPath, pluginPath });
        } catch (reason) { console.error('工作台宿主入口路径待恢复。', reason.message); }
    }

    inspect() {
        return this.enqueue(async () => {
            await this.refreshInstalledPaths();
            return this.snapshot();
        });
    }

    /** 只从主进程当前选中的项目读取历史回执，切换项目时丢弃旧请求。 */
    async records({ projectId, host, cursor }) {
        const project = this.getActive();
        if (!project || project.id !== projectId) { throw new Error('当前项目已切换，请刷新记录。'); }
        const { readHookRecords } = require('./host-verification');
        const result = await readHookRecords({ userDataPath: this.userDataPath, project, host, cursor });
        if (this.getActive()?.id !== projectId) { throw new Error('当前项目已切换，请刷新记录。'); }
        return result;
    }

    async snapshot() {
        const rows = await Promise.all(hosts.map(host => this.plan(host)));
        this.sinceByHost = Object.fromEntries(rows.map(row =>
            [row.id, row.verificationEligible ? (row.verifiedSince ?? 0) : Infinity]));
        return { hosts: rows };
    }

    /** 在当前项目读取触发摘要。轮询复用已检测的登记，不重复启动宿主 CLI。 */
    verification() {
        return this.enqueue(async () => {
            const project = this.getActive();
            if (!project || !this.sinceByHost) { return { projectId: project?.id ?? null, hosts: {} }; }
            const { readHostVerification } = require('./host-verification');
            const evidence = await readHostVerification({ userDataPath: this.userDataPath, project, sinceByHost: this.sinceByHost });
            for (const [id, since] of Object.entries(this.sinceByHost)) {
                const observed = this.hostVersions.get(id);
                if (!Number.isFinite(since) || observed === this.savedVersions.get(id)) { continue; }
                try {
                    await writeJson(this.versionFile(id), observed);
                    this.savedVersions.set(id, observed);
                } catch { evidence[id] = null; }
            }
            return { projectId: project.id, hosts: evidence };
        });
    }

    registrationFor(id) {
        if (id === 'dsh') {
            return this._dshRegistration ||= new (require('./dsh-registration').DshRegistration)({ userDataPath: this.userDataPath });
        }
        return this._registration ||= new (require('./host-registration').HostRegistration)({ userDataPath: this.userDataPath });
    }

    get launcher() {
        return this._launcher ||= new (require('./host-launcher').HostLauncher)(this.userDataPath);
    }

    versionFile(id) { return path.join(this.userDataPath, 'host-integration', 'observed-versions', id + '.json'); }

    /** 旧回执未记录宿主版本，按程序安装时间及上次核对回执时观察到的版本限定归属。 */
    async versionSince(row) {
        if (!row.version || !row.executable) { return null; }
        let stat;
        try { stat = await fs.stat(row.executable); }
        catch { return null; }
        if (!stat.isFile()) { return null; }
        const fileTime = Math.floor(Math.max(stat.birthtimeMs, stat.mtimeMs));
        let previous = this.hostVersions.get(row.id);
        if (!previous) {
            try {
                const saved = await readJson(this.versionFile(row.id), null);
                if (saved) {
                    if (!Number.isSafeInteger(saved.since) || saved.since < 0 || typeof saved.version !== 'string' ||
                        typeof saved.executable !== 'string') { throw new SyntaxError(); }
                    previous = saved;
                    this.savedVersions.set(row.id, saved);
                }
            } catch (error) {
                if (!(error instanceof SyntaxError)) { return null; }
                previous = { since: Date.now() };
            }
        }
        let since = Math.max(fileTime, previous?.since ?? 0);
        if (previous && (previous.version !== row.version || previous.executable !== row.executable) && fileTime <= previous.since) {
            // 有些 CLI 包装脚本在底层宿主升级时保留原文件。
            since = Math.max(since, Date.now());
        }
        const current = previous?.version === row.version && previous.executable === row.executable && previous.since === since
            ? previous : { version: row.version, executable: row.executable, since };
        this.hostVersions.set(row.id, current);
        return since;
    }

    async plan(host) {
        const row = await this.inspectHost(host);
        try {
            const [state, launcher, versionSince] = await Promise.all([
                this.registrationFor(host.id).state(host.id), this.launcher.state(), this.versionSince(row)
            ]);
            const target = row.targets[0];
            const expectedPath = target?.path || row.configurationPath;
            const moved = state.targetPath && expectedPath && state.targetPath !== expectedPath;
            row.configurationPath = state.targetPath || expectedPath || null;
            row.runnerPath = this.runnerPath;
            row.receiptsDirectory = path.join(this.userDataPath, 'host-integration', 'receipts');
            row.installEvents = row.status === 'available'
                ? row.missingEvents || Object.keys(JSON.parse(target.preview).hooks) : [];
            row.removeEvents = state.events;
            const supported = ['available', 'needs-trust', 'configured'].includes(row.status);
            row.canRemove = Boolean(state.managed || state.pending);
            row.canInstall = Boolean(!moved && expectedPath && supported && state.pending !== 'remove' &&
                launcher !== 'conflict' && (row.status === 'available' || state.pending === 'apply' || launcher !== 'ready'));
            if (moved) {
                row.status = 'conflict';
                row.detail = '宿主用户目录已改变。解除旧位置的登记后，可接入当前位置。';
            } else if (launcher === 'conflict') {
                row.status = 'conflict';
                row.detail = '工作台的钩子程序已被外部修改，请核对程序路径后重新检测。';
            } else if (state.pending) {
                row.detail = state.pending === 'remove' ? '上次解除接入中断，可再次点击完成解除。' : '上次接入中断，可再次点击恢复。';
            } else if (row.canInstall && !row.installEvents.length) {
                row.detail = '宿主已有事件登记，点击接入可恢复本机钩子程序。';
            }
            row.verificationEligible = row.status === 'configured' && launcher === 'ready' && !state.pending && versionSince !== null;
            row.verifiedSince = versionSince === null ? null : Math.max(state.verifiedSince ?? 0, versionSince);
            row.planId = createHash('sha256').update(JSON.stringify([row, state, this.launcher.name])).digest('hex');
        } catch {
            row.canInstall = row.canRemove = false;
            row.status = 'unknown';
            row.detail = '无法读取本机接入组件或安装记录，请检查工作台安装和用户数据目录。';
        }
        return row;
    }

    install(request) { return this.change('install', request); }
    remove(request) { return this.change('remove', request); }

    change(operation, { host: id, planId }) {
        const host = hosts.find(item => item.id === id);
        const run = async () => {
            if (!host) { throw new Error('宿主无效'); }
            const row = await this.plan(host);
            const last = this.completed.get(id);
            if (last?.operation === operation && last.before === planId && last.after === row.planId) {
                return this.snapshot();
            }
            if (planId !== row.planId || !(operation === 'install' ? row.canInstall : row.canRemove)) {
                throw new Error('宿主状态已变化，请核对最新配置后重试。');
            }
            const options = { id, targetPath: row.configurationPath, runnerPath: this.runnerPath };
            try {
                if (operation === 'install') {
                    await this.launcher.install();
                    await this.registrationFor(id).apply({ ...options, fragment: row.installEvents.length ? row.targets[0].preview : undefined });
                } else {
                    await this.registrationFor(id).remove(options);
                }
            } catch (error) {
                if (error.code === 'HOST_REGISTRATION_ERROR') { throw error; }
                throw new Error('无法更新宿主接入，请检查程序路径及本机文件权限后重试。');
            }
            const result = await this.snapshot();
            this.completed.set(id, { operation, before: planId, after: result.hosts.find(item => item.id === id).planId });
            return result;
        };
        return this.enqueue(run);
    }

    async inspectHost(host) {
        const fallbackDirs = host.id === 'codex' ? this.applicationDirs.flatMap(dir => [
            path.join(dir, 'Codex.app', 'Contents', 'Resources'),
            path.join(dir, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS')
        ]) : host.id === 'dsh' ? this.applicationDirs.map(dir =>
            path.join(dir, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin')) : [];
        const cli = await findCli(host.id, { home: this.home, baseDirs: this.baseDirs, fallbackDirs });
        const row = { id: host.id, name: host.name, executable: cli?.file || null, version: null, events: [], targets: [], nextSteps: [] };
        if (!cli) {
            return { ...row, status: 'missing', detail: '在本机常用安装位置未找到 ' + host.name + '。', nextSteps: ['安装宿主后重新检测。'] };
        }
        try {
            const { stdout } = await exec(cli.file, ['--version'], {
                cwd: this.home, env: { HOME: this.home, PATH: cli.dirs.join(path.delimiter), LANG: 'C', DISABLE_AUTOUPDATER: '1' },
                timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024
            });
            row.version = host.version.exec(stdout.trim())?.[1] || null;
        } catch { /* 失败输出可能含本机信息，仅展示固定诊断。 */ }
        if (!row.version) {
            return { ...row, status: 'unknown', detail: '已找到可执行文件，但未取得可识别的宿主版本。',
                nextSteps: ['在终端检查该程序的 --version 输出，然后重新检测。'] };
        }
        try {
            const result = await host.inspect({ version: row.version, executable: cli.file, home: this.home,
                env: this.env, runnerPath: this.runnerPath, cliDirs: cli.dirs });
            return { ...row, ...result };
        } catch (error) {
            if (error.code === 'MODULE_NOT_FOUND') {
                return { ...row, status: 'unknown', detail: '此工作台缺少 ' + host.name + ' 检测组件。', nextSteps: ['更新或重新安装完整的工作台应用。'] };
            }
            return { ...row, status: 'unknown', detail: '无法完成对宿主配置的检查。', nextSteps: ['检查宿主用户配置的读取权限后重新检测。'] };
        }
    }
}

module.exports = { HostIntegration };
