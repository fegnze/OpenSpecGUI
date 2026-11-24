'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./local-config');
const { materialize } = require('./capability-materializer');
const { readSource, toolRef, digest } = require('./capability-source');

const { version: appVersion } = require('../../package.json');
const actions = { bind: '绑定版本', unbind: '解除绑定' };
const hostNames = { codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness' };
const MAX_PLANS = 48;
const ttl = 10 * 60 * 1000;

function value(input, label, max, pattern) {
    if (typeof input !== 'string' || !input.trim() || input.length > max || /[\0\r\n]/.test(input) ||
        (pattern && !pattern.test(input))) { throw new Error(label + '无效'); }
    return input.trim();
}
function sameBinding(b, host, root, id) { return b.host === host && b.root === root && b.id === id; }

class CapabilityRegistry {
    constructor({ userDataPath, getActive, catalogRoot = path.resolve(__dirname, '../capabilities') }) {
        this.root = path.join(userDataPath, 'capabilities');
        this.file = path.join(this.root, 'registry.json');
        this.catalogRoot = catalogRoot;
        this.getActive = getActive;
        this.plans = new Map();
        this.migration = null;
        this.writes = Promise.resolve();
    }

    invalidate() { this.plans.clear(); }

    context(projectId, host) {
        if (typeof host !== 'string' || !Object.hasOwn(hostNames, host)) { throw new Error('请选择有效宿主'); }
        if (projectId == null) { return { host, root: null, projectId: null }; }
        const project = this.getActive();
        if (!project || project.id !== projectId) { throw new Error('当前项目已变化，请重新预览'); }
        return { host, root: project.rootPath, projectId };
    }

    async load() {
        if (!this.migration) {
            this.migration = this.migrate().catch(error => { this.migration = null; throw error; });
        }
        await this.migration;
        const store = await readJson(this.file, { schema: 2, revision: 0, records: [], bindings: [], recovery: { globalBindings: 0, customItems: 0 } });
        if (store.schema !== 2 || !Number.isSafeInteger(store.revision) || !Array.isArray(store.records) || !Array.isArray(store.bindings)) {
            throw new Error('本机能力登记文件格式无效');
        }
        return store;
    }

    async migrate() {
        const old = await readJson(this.file, null);
        if (!old) { return; }
        if (old.schema === 2) {
            // 早期试用版使用 items，旧宿主脚本也认识该键。迁出后旧入口便无法自动发现。
            const records = old.records || old.items;
            if (!Array.isArray(records) || !Array.isArray(old.bindings)) { throw new Error('本机能力登记文件格式无效'); }
            const ids = new Set((await this.entries()).map(entry => entry.id));
            const bindings = old.bindings.filter(binding => ids.has(binding.id));
            if (Array.isArray(old.items) || bindings.length !== old.bindings.length) {
                // 取消移出本版目录的绑定，已安装的旧 Skill 也会看到同一结果；保留快照供恢复。
                const { items, ...rest } = old;
                await writeJson(this.file, { ...rest, revision: old.revision + 1, records, bindings });
            }
            return;
        }
        if (old.schema !== 1 || !Number.isSafeInteger(old.revision) || !Array.isArray(old.items) || !Array.isArray(old.bindings)) {
            throw new Error('本机能力登记文件格式无效');
        }
        const current = await this.entries();
        const items = old.items.filter(item => current.some(entry => entry.id === item.id) && Array.isArray(item.versions) &&
            (!item.versions.length || item.versions.some(v => v.builtin === true)))
            .map(item => ({ ...item, versions: item.versions.filter(v => v.builtin === true) }));
        const bindings = old.bindings.filter(binding => typeof binding.root === 'string' && path.isAbsolute(binding.root) &&
            ['codex','claude'].includes(binding.host) && items.some(item => item.id === binding.id &&
                item.versions.some(version => version.version === binding.version)))
            .map(binding => ({ ...binding, migratedProject: true }));
        const recovery = { globalBindings: old.bindings.filter(b => b.root === null).length, customItems: old.items.length - items.length };
        // 旧记录按原字节保留，迁移重试不覆盖备份。对象快照仍留在原处。
        const backup = await fs.readFile(this.file);
        const backupFile = path.join(this.root, 'registry-v1-' + digest(backup) + '.json');
        try { await fs.writeFile(backupFile, backup, { mode: 0o600, flag: 'wx' }); }
        catch (error) {
            if (error.code !== 'EEXIST' || !(await fs.readFile(backupFile)).equals(backup)) { throw error; }
        }
        await writeJson(this.file, { schema: 2, revision: old.revision + 1, records: items, bindings, recovery: { ...recovery, backupName: path.basename(backupFile) } });
    }

    async entries() {
        const entries = await readJson(path.join(this.catalogRoot, 'catalog.json'));
        if (!Array.isArray(entries)) { throw new Error('应用缺少内置能力目录'); }
        return entries;
    }

    async catalog(store) {
        const items = [];
        for (const entry of await this.entries()) {
            const file = path.resolve(this.catalogRoot, entry.source);
            if (!file.startsWith(this.catalogRoot + path.sep)) { throw new Error('内置能力位置无效'); }
            const descriptor = (entry.kind === 'mcp' || (entry.kind === 'tool' && path.extname(file) === '.json')) ? await readJson(file) : {};
            const saved = store.records.find(item => item.id === entry.id);
            const versions = (entry.versions || [{ version: entry.version, source: entry.source, origin: entry.origin }])
                .map(version => ({ ...version, builtin: true, reference: version.reference || entry.reference,
                    dependencies: version.dependencies || entry.dependencies || [] }));
            const currentVersion = versions.find(version => version.version === entry.version);
            if (!currentVersion || new Set(versions.map(version => version.version)).size !== versions.length) {
                throw new Error('目录中的版本声明无效：' + entry.id);
            }
            for (const version of versions) {
                if (!Array.isArray(version.dependencies) || version.dependencies.some(id => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))) {
                    throw new Error('目录中的依赖声明无效：' + entry.id);
                }
                if (version.reference && (entry.kind !== 'tool' || !toolRef(version.reference))) {
                    throw new Error('目录中的工具引用无效：' + entry.id);
                }
            }
            if (entry.kind === 'rule' || entry.kind === 'skill') {
                const latest = versions.find(v => v.version === entry.version);
                if (latest) { latest.content = (await fs.readFile(file, 'utf8')).slice(0,16000); }
            }
            items.push({ ...entry, name: saved?.name || entry.name, builtin: true, toolType: entry.kind === 'tool' ? toolRef(currentVersion.reference) || (entry.provider ? 'builtin' : 'command') : undefined,
                endpoint: descriptor?.url || descriptor?.endpoint, versions, latest: entry.version });
        }
        return items;
    }

    async list({ projectId, host }) {
        const ctx = this.context(projectId, host);
        const store = await this.load();
        const items = await this.catalog(store);
        for (const item of items) {
            const binding = ctx.root && store.bindings.find(b => sameBinding(b, host, ctx.root, item.id));
            const stored = store.records.find(i => i.id === item.id)?.versions.find(v => v.version === binding?.version && v.builtin);
            item.pinnedVersion = stored || null;
            item.bindings = { project: stored ? binding.version : null };
            item.effectiveVersion = item.bindings.project;
            if (stored) {
                const matching = item.versions.find(v => v.version === stored.version);
                if (matching) { Object.assign(matching, { digest: stored.digest, localEntry: stored.localEntry }); }
            }
        }
        const recovery = await this.recoveryStatus(store.recovery);
        this.context(projectId, host);
        return { projectId: ctx.projectId, host, appVersion, items, recovery };
    }

    async recoveryStatus(recovery = {}) {
        const result = { globalBindings: recovery.globalBindings || 0, customItems: recovery.customItems || 0, backupPath: null };
        if (!recovery.backupName && !result.globalBindings && !result.customItems) { return result; }
        const namePattern = /^registry-v1-[a-f0-9]{64}\.json$/;
        const candidates = recovery.backupName ? [recovery.backupName] : await fs.readdir(this.root);
        for (const name of candidates) {
            if (!namePattern.test(name)) { continue; }
            const file = path.join(this.root, name);
            const info = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') { throw error; } });
            if (info?.isFile()) { result.backupPath = file; break; }
        }
        return result;
    }

    async requireBinding({projectId, host}, id) {
        const ctx = this.context(projectId, host);
        if (!ctx.root) { throw new Error('请选择项目并启用此能力'); }
        const store = await this.load();
        const entry = (await this.entries()).find(e => e.id === id);
        const binding = store.bindings.find(b => sameBinding(b, host, ctx.root, id));
        if (!entry || !binding || !store.records.some(i => i.id === id && i.versions.some(v => v.version === binding.version && v.builtin))) {
            throw new Error('请先在当前项目和宿主中启用此能力');
        }
        if (this.context(projectId, host).root !== ctx.root) { throw new Error('当前项目已变化'); }
        return { ...ctx, bindingVersion: binding.version, migratedProject: binding.migratedProject === true };
    }

    async snapshot(item, version) {
        if (version.digest) {
            if (!/^[a-f0-9]{64}$/.test(version.digest)) { throw new Error('保留的来源版本无效'); }
            const cached = await readJson(path.join(this.root, 'objects', version.digest + '.json'));
            if (!cached || cached.digest !== version.digest || (cached.files.length ? digest(JSON.stringify(cached.files)) : digest(cached.source)) !== version.digest) {
                throw new Error('保留的来源版本无法校验，请重新登记');
            }
            return cached;
        }
        const source = version.builtin ? path.join(this.catalogRoot, version.source) : version.source;
        return readSource(item.kind, source, version.builtin);
    }

    validateBindings(store, items, host, roots) {
        for (const root of roots) {
            const rules = new Map();
            const effective = id => store.bindings.find(b => sameBinding(b, host, root, id));
            for (const item of items) {
                const binding = effective(item.id);
                if (!binding) { continue; }
                const v = store.records.find(i => i.id === item.id)?.versions.find(v => v.builtin && v.version === binding.version);
                if (!v) { throw new Error('绑定引用了不存在的版本：' + item.name); }
                for (const id of v.dependencies || []) {
                    if (!items.some(entry => entry.id === id) || !effective(id)) { throw new Error('请先启用依赖：' + id); }
                }
                const reference = v.reference || v.source;
                if (item.kind === 'tool' && toolRef(reference) === 'mcp') {
                    const connection = reference.slice(4).split('/')[0];
                    if (!items.some(i => i.id === connection && i.kind === 'mcp') || !effective(connection)) {
                        throw new Error('请先绑定此工具所属的 MCP 连接：' + connection);
                    }
                }
                for (const [key, required] of Object.entries(v.requirements || {})) {
                    const previous = rules.get(key);
                    if (previous && previous.required !== required) {
                        throw new Error('规范冲突：' + key + '；' + previous.source + ' 与 ' + v.source);
                    }
                    rules.set(key, { required, source: v.source });
                }
            }
        }
    }

    async preview(request) {
        const plan = await this.prepare(request);
        const planId = crypto.randomBytes(24).toString('hex');
        for (const [id, old] of this.plans) { if (old.expires <= Date.now()) { this.plans.delete(id); } }
        if (this.plans.size >= MAX_PLANS) { this.plans.delete(this.plans.keys().next().value); }
        this.plans.set(planId, { request: { ...request }, expires: Date.now() + ttl, fingerprint: plan.fingerprint });
        return { planId, summary: plan.summary, details: plan.details };
    }

    async prepare(r) {
        const ctx = this.context(r.projectId, r.host);
        if (!Object.hasOwn(actions, r.operation)) { throw new Error('能力操作无效'); }
        const id = value(r.id, '能力 ID', 63, /^[a-z0-9][a-z0-9-]{0,62}$/);
        const store = await this.load();
        const items = await this.catalog(store);
        let item = items.find(i => i.id === id);
        let snapshot;
        let revision;
        let location;
        let difference;
        let previousVersion;
        {
            if (!item) { throw new Error('能力未收录在当前工作台目录'); }
            if (r.scope !== 'project' || !ctx.root) { throw new Error('请选择已登记的项目，能力只可按项目绑定'); }
            const root = ctx.root;
            if (r.operation === 'bind' && id === 'git-commit') {
                const manifest = await readJson(path.join(root, 'package.json'), {});
                if (manifest.name !== 'world-tour-casino' || !manifest.scripts?.['check:openspec'] || !manifest.scripts?.['list:openspec']) {
                    throw new Error('该检出缺少 WorldTourCasino 的项目标识或提交检查脚本');
                }
            }
            const match = b => sameBinding(b, ctx.host, root, id);
            const previous = store.bindings.find(match);
            previousVersion = store.records.find(record => record.id === id)?.versions.find(v => v.version === previous?.version && v.builtin);
            store.bindings = store.bindings.filter(b => !match(b));
            location = root + ' · ' + hostNames[ctx.host];
            if (r.operation === 'bind') {
                const v = item.versions.find(v => v.version === r.version);
                if (!v) { throw new Error('请选择可用版本'); }
                if (root && item.kind === 'tool' && toolRef(v.reference) === 'host') {
                    throw new Error('宿主自带工具由宿主管理，工作台不支持按项目隔离该工具');
                }
                const absolute = path.resolve(this.catalogRoot, v.source);
                if (!absolute.startsWith(this.catalogRoot + path.sep)) { throw new Error('内置能力位置无效'); }
                snapshot = await readSource(item.kind, absolute, true);
                const known = store.records.find(i => i.id === id)?.versions.find(s => s.version === v.version && s.builtin);
                if ((v.digest && snapshot.digest !== v.digest) || (known?.digest && known.digest !== snapshot.digest)) {
                    throw new Error('当前发布包的能力版本与已知摘要不符，请检查发布版本');
                }
                revision = { ...v, digest: snapshot.digest, requirements: snapshot.requirements };
                this.remember(store, item, revision);
                Object.assign(v, revision);
                store.bindings.push({ ...previous, id, host: ctx.host, root, version: v.version });
            } else if (!previous) { throw new Error('该范围没有直接绑定'); }
            difference = (previous?.version || '未绑定') + ' → ' + (revision?.version || '解除绑定');
            this.validateBindings(store, items, ctx.host, [root]);
        }
        const details = [location, difference];
        if (previousVersion) { details.push('此前来源：' + previousVersion.source); }
        if (revision) {
            details.push('采用来源：' + revision.source, 'SHA-256：' + revision.digest);
            if (revision.reference) { details.push('工具来自：' + revision.reference); }
            if (revision.dependencies.length) { details.push('依赖：' + revision.dependencies.join('、')); }
        }
        if (revision && previousVersion && previousVersion.version !== revision.version && snapshot?.files.length) {
            const old = await this.snapshot(item, previousVersion);
            const byPath = new Map(old.files.map(file => [file.path, file]));
            for (const file of snapshot.files) {
                const before = byPath.get(file.path);
                if (!before || before.data !== file.data || before.executable !== file.executable) {
                    details.push((before ? '修改文件：' : '新增文件：') + file.path);
                }
                byPath.delete(file.path);
            }
            for (const removed of byPath.keys()) { details.push('移除文件：' + removed); }
        }
        if (item.endpoint) { details.push('服务地址：' + item.endpoint + '（使用成员个人 Bearer Token）'); }
        if (snapshot?.files.length) { details.push('本机保留 ' + snapshot.files.length + ' 个来源文件：' + snapshot.files.map(f => f.path).join('、')); }
        if (item.scopeHint) { details.push(item.scopeHint); }
        if (r.operation === 'bind') { details.push('本次保存工作台配置；宿主加载及权限由宿主接入验证。'); }
        const fingerprint = digest(JSON.stringify([store.revision, ctx.root, r, revision?.source, revision?.digest,
            revision?.reference, revision?.dependencies, difference]));
        this.context(r.projectId, r.host);
        return { store, item, revision, snapshot, fingerprint, details, summary: actions[r.operation] + ' · ' + item.name };
    }

    remember(store, item, revision) {
        let saved = store.records.find(i => i.id === item.id);
        if (!saved) {
            saved = { id: item.id, kind: item.kind, name: item.name, description: item.description, versions: [] };
            store.records.push(saved);
        }
        saved.kind = item.kind;
        if (!saved.versions.some(v => v.version === revision.version)) { saved.versions.push(revision); }
    }

    enqueue(task) {
        const job = this.writes.then(task);
        this.writes = job.catch(() => {});
        return job;
    }

    /** 两个界面编辑同一项本机登记名称，使用原名防止覆盖另一个界面已保存的修改。 */
    rename({ id, name, expectedName, host, projectId }) {
        return this.enqueue(async () => {
            const ctx = this.context(projectId, host);
            const key = value(id, '能力 ID', 63, /^[a-z0-9][a-z0-9-]{0,62}$/);
            const next = value(name, '显示名称', 120);
            const expected = value(expectedName, '原显示名称', 120);
            const store = await this.load();
            const item = (await this.catalog(store)).find(entry => entry.id === key);
            if (!item) { throw new Error('能力不存在'); }
            const checkProject = () => {
                if (this.context(projectId, host).root !== ctx.root) { throw new Error('当前项目已变化，请重新打开详情'); }
            };
            checkProject();
            if (item.name === next) { return { ok: true, name: next }; }
            if (item.name !== expected) { throw new Error('显示名称已变化，请重新打开详情再编辑'); }
            const saved = store.records.find(entry => entry.id === key);
            if (saved) { saved.name = next; }
            else { store.records.push({ id: key, name: next, versions: [] }); }
            store.revision++;
            await writeJson(this.file, store, checkProject);
            this.plans.clear();
            return { ok: true, name: next };
        });
    }

    apply({ planId, projectId }) {
        return this.enqueue(async () => {
            const original = this.plans.get(planId);
            if (!original || original.expires < Date.now() || (original.request.projectId ?? null) !== (projectId ?? null)) {
                throw new Error('接入预览已失效，请重新预览');
            }
            const next = await this.prepare(original.request);
            if (next.fingerprint !== original.fingerprint) { throw new Error('来源或绑定已变化，请重新预览'); }
            if (next.snapshot) {
                if (next.item.kind !== 'mcp' && !next.item.provider && !next.revision.reference) {
                    const entry = await materialize({ root: this.root, snapshot: next.snapshot, kind: next.item.kind });
                    const savedVersion = next.store.records.find(i => i.id === next.item.id).versions.find(v => v.version === next.revision.version);
                    if (entry) { savedVersion.localEntry = entry; }
                }
                await writeJson(path.join(this.root, 'objects', next.snapshot.digest + '.json'), next.snapshot);
            }
            next.store.revision++;
            await writeJson(this.file, next.store, () => {
                if (!this.plans.has(planId)) { throw new Error('工作区已变化，请重新预览'); }
                this.context(projectId, original.request.host);
            });
            this.plans.clear();
            return { ok: true };
        });
    }
}

module.exports = { CapabilityRegistry };
