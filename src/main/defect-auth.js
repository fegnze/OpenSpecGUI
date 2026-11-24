'use strict';

const { findCli } = require('./local-cli');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectHosts = new Set(['project.feishu.cn', 'meegle.com']);
const accountHosts = new Set(['accounts.feishu.cn', 'open.feishu.cn', 'passport.feishu.cn', 'accounts.larksuite.com', 'open.larksuite.com']);
const install = { meegle: 'npm install -g @lark-project/meegle', feishu: 'npm install -g @larksuite/cli' };
const label = { meegle: 'Meegle CLI', feishu: '飞书 CLI' };
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const row = (state, message, fields = {}) => ({ state, message, ...fields });

function runCli(cli, args, { signal, timeout = 25_000, host, hostnameOnly = false } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('已取消')); return; }
        const env = { PATH: cli.dirs.join(path.delimiter), MEEGLE_NO_UPDATE_CHECK: '1', MEEGLE_TELEMETRY: 'disabled' };
        for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'LC_CTYPE', 'SYSTEMROOT']) {
            if (process.env[key]) { env[key] = process.env[key]; }
        }
        if (host) { env.MEEGLE_HOST = host; }
        const grouped = process.platform !== 'win32';
        const child = spawn(cli.file, args, { env, cwd: os.homedir(), shell: false, windowsHide: true,
            detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let size = 0;
        let stopped = false;
        const stop = () => {
            stopped = true;
            try { if (grouped && child.pid) { process.kill(-child.pid, 'SIGKILL'); } else { child.kill('SIGKILL'); } } catch { /* Already closed. */ }
        };
        const timer = setTimeout(stop, timeout);
        timer.unref();
        signal?.addEventListener('abort', stop, { once: true });
        const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
        const collect = (chunk, keep) => {
            size += chunk.length;
            if (size > 128 * 1024) { if (!stopped) { stop(); } return; }
            if (keep && !stopped) { chunks.push(chunk); }
        };
        child.stdout.on('data', chunk => collect(chunk, true));
        child.stderr.on('data', chunk => collect(chunk, false));
        child.once('error', () => { clean(); reject(new Error('官方 CLI 无法启动')); });
        child.once('close', code => {
            clean();
            if (stopped) { reject(new Error('官方 CLI 超时或输出超过上限')); return; }
            let data = null;
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (hostnameOnly) { data = text; }
            else { try { data = JSON.parse(text); } catch { /* Some login completions only print text. */ } }
            resolve({ code, data });
        });
    });
}

function payload(result) {
    let value = result.data;
    if (value && typeof value === 'object' && ('meta' in value || 'error' in value) && 'data' in value) {
        if (value.error || value.meta?.truncated || value.meta?.stopped_reason) { return null; }
        value = value.data;
    }
    if (value && typeof value === 'object' && 'code' in value) {
        if (![0, '0'].includes(value.code)) { return null; }
        return value.data;
    }
    return value;
}

function projectLogin(v) {
    return ['auth', 'login', '--host', v.host, ...(v.profile ? ['--profile', v.profile] : [])];
}

function safeVerification(value, target, host) {
    const url = new URL(value);
    const allowed = accountHosts.has(url.hostname) || (target === 'meegle' && url.hostname === host && projectHosts.has(host));
    if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port || url.hash || url.href.length > 4096 ||
        [...url.searchParams.keys()].some(key => /^(device_code|access_token|refresh_token|client_secret|redirect_uri|redirect_url|return_url|next)$/i.test(key))) {
        throw new Error('官方验证地址无法识别');
    }
    return url.href;
}

function visibleApp(v, env) {
    const app = v.appId || (envName.test(v.appIdEnv || '') && env[v.appIdEnv]);
    return typeof app === 'string' && /^cli_[a-zA-Z0-9]{1,64}$/.test(app) ? app : '';
}

function unavailable(target) {
    return row('missing', '未找到' + label[target] + '。请在终端安装，再点击检查。', { command: install[target] });
}

function manual(v, target, app) {
    const command = target === 'meegle' ? ['meegle', ...projectLogin(v), '--device-code'].join(' ')
        : 'lark-cli --profile ' + app + ' auth login --scope offline_access';
    return { action: 'authorize', command };
}

class DefectAuth {
    constructor({ binding, openExternal, find = findCli, run = runCli, env = process.env }) {
        this.binding = binding;
        this.openExternal = openExternal;
        this.find = find;
        this.run = run;
        this.env = env;
        this.sessions = new Map();
        this.failures = new Map();
        this.shutdown = new AbortController();
    }

    dispose() {
        this.shutdown.abort();
        this.sessions.clear();
        this.failures.clear();
    }

    async context(projectId) {
        const [view, meegle, feishu] = await Promise.all([
            this.binding.readSettings(projectId), this.find('meegle'), this.find('lark-cli')
        ]);
        const values = view.values;
        return { projectId, view, values, app: visibleApp(values, this.env), cli: { meegle, feishu } };
    }

    async current(ctx) {
        const next = await this.binding.readSettings(ctx.projectId);
        if (next.revision !== ctx.view.revision || this.shutdown.signal.aborted) {
            throw new Error('项目配置已变化，请重新检查');
        }
    }

    key(ctx, target) {
        return JSON.stringify(target === 'meegle' ? [target, ctx.values.profile || ''] : [target, ctx.app]);
    }

    stamp(ctx, target) {
        return JSON.stringify([ctx.projectId, ctx.view.revision, target]);
    }

    async probe(ctx, target) {
        const { cli, view, values: v, app } = ctx;
        if (!view.configured) {
            const msg = cli[target] ? '已找到' + label[target] + '。' : '未找到' + label[target] + '。';
            return row('configure', msg + '请先保存项目域名、项目键和缺陷来源，再检查身份。', cli[target] ? {} : { command: install[target] });
        }
        if (!cli[target]) { return unavailable(target); }
        if (target === 'meegle') {
            if (!projectHosts.has(v.host) || (v.profile && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v.profile))) {
                return row('configure', '请核对项目域名和 CLI profile。桌面授权支持 project.feishu.cn 和 meegle.com。自建站点请由管理员核对后在官方 CLI 中登录。');
            }
        } else if (v.notificationProvider !== 'feishu-app' || !app) {
            return row('configure', '请先选择飞书消息应用并配置它的 App ID，使用环境变量时请确认工作台能读取该变量。');
        }
        const pending = this.sessions.get(this.key(ctx, target));
        if (pending) {
            if (pending.stamp !== this.stamp(ctx, target)) {
                return row('pending', '另一个项目正在为此账号配置授权，请等待授权结束后重新检查。');
            }
            return pending.row;
        }
        try {
            return target === 'meegle' ? await this.meegle(ctx) : await this.feishu(ctx);
        } catch {
            return row('error', '未能检查' + label[target] + '。请确认网络与 CLI 版本，再点击检查。');
        }
    }

    async meegle({ values: v, cli }) {
        const profile = v.profile ? ['--profile', v.profile] : [];
        // MEEGLE_HOST overrides the profile's configured host. Check the public host field
        // before allowing that override on any authenticated operation.
        const configured = await this.run(cli.meegle, ['config', 'get', 'host', ...profile], { signal: this.shutdown.signal, hostnameOnly: true });
        if (configured.code !== 0) { return row('error', '无法读取 Meegle profile 的站点配置。请核对 CLI 和 profile 后重试。'); }
        if (configured.data === '(not set)') { return row('login', '此 Meegle profile 尚未设置站点，请为当前项目登录。', manual(v, 'meegle')); }
        if (![v.host, 'https://' + v.host, 'https://' + v.host + '/'].includes(configured.data)) {
            return row('configure', '此 Meegle profile 属于其他站点，请在项目设置中选择对应的 profile。');
        }
        const flags = [...profile, '--format', 'json', '--envelope'];
        const opt = { host: v.host, signal: this.shutdown.signal };
        const status = await this.run(cli.meegle, ['auth', 'status', ...flags], opt);
        const data = payload(status);
        if (data?.host && data.host !== v.host) { return row('configure', '此 Meegle profile 属于其他站点，请在项目设置中选择对应的 profile。'); }
        if (data?.authenticated === false && [0, 1].includes(status.code) &&
            (!data.reason || ['no local token', 'token rejected by server'].includes(data.reason))) {
            return row('login', '此 Meegle profile 需要本人登录。', manual(v, 'meegle'));
        }
        if (status.code !== 0 || data?.authenticated !== true || data.host !== v.host) {
            return row('error', '无法核实此站点的项目登录，请检查网络、站点和 CLI 版本后重试。');
        }
        const user = await this.run(cli.meegle, ['user', 'me', ...flags], opt);
        const id = payload(user)?.user_key;
        if (user.code || !(typeof id === 'string' && id.trim() || Number.isSafeInteger(id) && id >= 0)) { return row('error', '已检测到登录，但读取当前项目用户失败。请核对个人访问权限后重试。'); }
        return row('verified', '已通过 user me 核验此站点的项目账号。缺陷空间权限在运行 doctor 时核对。');
    }

    async feishu({ cli, values: v, app }) {
        const result = await this.run(cli.feishu, ['--profile', app, 'auth', 'status', '--verify', '--json'], { signal: this.shutdown.signal });
        const data = result.data;
        if (result.code || data?.appId !== app) {
            return row('configure', '请在终端选择「已有应用」，配置当前消息 App ID 后再次检查。命名配置可保留已有应用。', { command: 'lark-cli config init --name defect-' + app.slice(4, 28) });
        }
        const user = data.identities?.user;
        if (user?.available && user.verified === true) {
            return row('verified', '已核验当前消息应用的飞书个人身份。');
        }
        if (['missing', 'not_configured'].includes(user?.status)) {
            return row('login', '消息应用已识别，请用本人飞书账号登录。', manual(v, 'feishu', app));
        }
        return row('error', '个人身份尚未通过官方校验，请在终端核对授权状态、网络和当前应用。', { command: 'lark-cli --profile ' + app + ' auth status --verify --json' });
    }

    async snapshot(ctx) {
        const [meegle, feishu] = await Promise.all([this.probe(ctx, 'meegle'), this.probe(ctx, 'feishu')]);
        const v = ctx.values;
        let notifications = row('configure', '请在项目设置中选择消息应用，并填写 App ID 和应用密钥环境变量名。');
        if (ctx.view.configured && v.notificationProvider === 'command') {
            notifications = row('unverified', '此项目使用自定义通知适配器。请在随包 Skill 的 prepare 中检查机器人和本轮 QA 群。');
        } else if (ctx.view.configured && v.notificationProvider === 'feishu-app' && ctx.app && envName.test(v.appSecretEnv || '')) {
            notifications = this.env[v.appSecretEnv] ? row('unverified', '工作台已找到消息应用的凭据引用。选择本轮 QA 群后用 prepare 检查应用和机器人在群状态。')
                : row('configure', '本机未向工作台提供消息应用密钥。请由维护者配置该环境变量并重启工作台。');
        }
        const identityMapping = !ctx.view.configured ? row('configure', '请先保存项目设置，再核对本人通知身份。') :
            row('unverified', v.identityHost ? '已配置共享身份映射。在 Skill 中运行 prepare，按项目用户键和当前应用核对本人收件人。' :
                '在 Skill 中运行 prepare，按项目用户键和当前消息应用核对本人收件人。若提示 ACTOR_NOTIFICATION_REQUIRED，请按引导确认同一人。');
        await this.current(ctx);
        const result = { projectId: ctx.projectId, meegle, feishu, notifications, identityMapping };
        for (const target of ['meegle', 'feishu']) {
            const failure = this.failures.get(this.stamp(ctx, target));
            if (failure && result[target].state === 'login') { result[target] = failure; }
        }
        return result;
    }

    async check(projectId) {
        return this.snapshot(await this.context(projectId));
    }

    async authorize(projectId, target) {
        if (!['meegle', 'feishu'].includes(target)) { throw new Error('不支持的授权目标'); }
        const ctx = await this.context(projectId);
        const status = await this.snapshot(ctx);
        if (status[target].action !== 'authorize') { return status; }
        const key = this.key(ctx, target);
        if (this.sessions.has(key)) { return this.snapshot(ctx); }
        const stamp = this.stamp(ctx, target);
        this.failures.delete(stamp);
        const session = { stamp, row: row('pending', '正在向官方服务申请授权页面。') };
        this.sessions.set(key, session);
        const failed = () => {
            if (this.shutdown.signal.aborted) { return; }
            if (this.failures.size >= 32) { this.failures.delete(this.failures.keys().next().value); }
            this.failures.set(stamp, row('error', '授权未完成或已过期。可重试，或在终端执行官方登录命令。', manual(ctx.values, target, ctx.app)));
        };
        try {
            const poll = await this.startDevice(ctx, target, session);
            this.run(ctx.cli[target], poll.args, { host: target === 'meegle' ? ctx.values.host : undefined,
                timeout: poll.timeout, signal: this.shutdown.signal }).then(r => { if (r.code !== 0) { failed(); } }, failed)
                .finally(() => this.sessions.delete(key));
            return { ...status, [target]: session.row };
        } catch {
            failed();
            this.sessions.delete(key);
            return { ...status, [target]: this.failures.get(stamp) || row('error', '授权已取消。') };
        }
    }

    async startDevice(ctx, target, session) {
        const isProject = target === 'meegle';
        const base = isProject ? [...projectLogin(ctx.values), '--device-code'] : ['--profile', ctx.app, 'auth', 'login'];
        const init = isProject ? ['--phase', 'init', '--format', 'json'] : ['--scope', 'offline_access', '--no-wait', '--json'];
        const result = await this.run(ctx.cli[target], [...base, ...init], { host: isProject ? ctx.values.host : undefined, signal: this.shutdown.signal });
        const data = payload(result);
        const opaque = x => typeof x === 'string' && /^[a-zA-Z0-9_.~+/=-]{1,4096}$/.test(x);
        if (result.code || !opaque(data?.device_code) || (isProject && !opaque(data.client_id))) { throw new Error('官方 CLI 未返回授权码'); }
        const expiry = Number(data.expires_in);
        if (!Number.isSafeInteger(expiry) || expiry <= 0) { throw new Error('官方 CLI 未返回有效期限'); }
        const seconds = Math.min(expiry, 900);
        const url = safeVerification(isProject ? data.verification_uri_complete || data.verification_uri : data.verification_url, target, ctx.values.host);
        if (url.includes(data.device_code)) { throw new Error('授权地址携带私有凭据'); }
        const userCode = isProject && typeof data.user_code === 'string' && /^[A-Za-z0-9 -]{3,24}$/.test(data.user_code) ? data.user_code : '';
        if (isProject && !userCode && !data.verification_uri_complete) { throw new Error('缺少用户确认码'); }
        await this.current(ctx);
        await this.openExternal(url);
        await this.current(ctx);
        session.row = row('pending', '已打开官方页面，请以本人账号确认。完成后点击检查。', userCode ? { userCode } : {});
        const args = isProject ? [...base, '--phase', 'poll', '--device-code-value', data.device_code, '--client-id', data.client_id,
            '--interval', String(Math.max(1, Math.min(30, Number(data.interval) || 5))), '--expires-in', String(seconds), '--format', 'json']
            : [...base, '--device-code', data.device_code, '--json'];
        return { args, timeout: seconds * 1000 + 5000 };
    }
}

module.exports = { DefectAuth, findCli };
