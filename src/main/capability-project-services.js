'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FeishuDefectBinding } = require('./feishu-defect-binding');
const { DefectAuth } = require('./defect-auth');
const { ScopedDocumentConnections } = require('./scoped-document-connections');
const { CvMcpConnection } = require('./cv-mcp-connection');
const { readJson, writeJson } = require('./local-config');

const hash = text => createHash('sha256').update(text).digest('hex');

function isReadOnlyFeishuGrant(record) {
    const scopes = record?.grantedScopes;
    return Array.isArray(scopes) && scopes.includes('docx:document:readonly') &&
        scopes.every(scope => ['docx:document:readonly', 'offline_access', 'user_profile'].includes(scope));
}

/** 为一个已启用能力的工作树和宿主打开独立服务。凭据和配置文件留在用户数据目录。 */
class CapabilityProjectServices {
    constructor(options) {
        this.options = { ...options, accountQueues: new Map(), accounts: path.join(options.userDataPath, 'capability-projects', 'personal', 'document-accounts') };
        this.scopes = new Map();
        this.referenceQueue = Promise.resolve();
        this.legacy = { cvConnection: new CvMcpConnection(options), documentConnections: new ScopedDocumentConnections(this.options) };
        this.references = path.join(options.userDataPath, 'capability-projects', 'personal');
    }

    get(ctx) {
        const key = hash(ctx.root) + '/' + ctx.host;
        if (!this.scopes.has(key)) {
            const local = { ...this.options, userDataPath: path.join(this.options.userDataPath, 'capability-projects', key) };
            const defectBinding = new FeishuDefectBinding(local);
            this.scopes.set(key, {
                key, defectBinding, defectAuth: new DefectAuth({ binding: defectBinding, openExternal: local.openExternal }),
                cvConnection: new CvMcpConnection(local), documentConnections: new ScopedDocumentConnections(local)
            });
        }
        return this.scopes.get(key);
    }

    async defect(ctx) {
        const scope = this.get(ctx);
        if (ctx.migratedProject) {
            const local = await scope.defectBinding.context(ctx.projectId);
            if (!await scope.defectBinding.selected(local)) {
                const old = new FeishuDefectBinding(this.options);
                const prior = await old.status(ctx.projectId);
                if (prior.configured) { await scope.defectBinding.importLegacy(ctx.projectId, prior.path); }
            }
        }
        return scope;
    }

    async reusable(provider, scope, acceptsGrant) {
        const recorded = await readJson(path.join(this.references, provider + '.json'), []);
        const keys = Array.isArray(recorded) ? recorded : [recorded];
        for (const key of [...keys, null]) {
            let source = this.legacy;
            if (key !== null) {
                if (typeof key !== 'string' || !/^[a-f0-9]{64}\/(codex|claude|dsh)$/.test(key) || key === scope.key) { continue; }
                const local = { ...this.options, userDataPath: path.join(this.options.userDataPath, 'capability-projects', key) };
                source = { cvConnection: new CvMcpConnection(local), documentConnections: new ScopedDocumentConnections(local) };
            }
            if (acceptsGrant) {
                if (acceptsGrant(await source.documentConnections.read(provider))) { return source; }
                continue;
            }
            const file = provider === 'cv-test1' ? source.cvConnection.file : path.join(source.documentConnections.directory, provider + '.enc');
            try { await fs.access(file); return source; }
            catch (error) { if (error.code !== 'ENOENT') { throw error; } }
        }
        return null;
    }

    rememberAccount(provider, key, active) {
        const file = path.join(this.references, provider + '.json');
        const run = this.referenceQueue.then(async () => {
            const old = await readJson(file, []);
            const previous = (Array.isArray(old) ? old : [old]).filter(value => value !== key);
            await writeJson(file, active ? [key, ...previous] : previous);
        });
        this.referenceQueue = run.catch(() => {});
        return run;
    }

    async connection(ctx, provider, operation, settings) {
        const scope = this.get(ctx);
        const cv = provider === 'cv-test1';
        const feishuReadOnly = provider === 'feishu' && ctx.bindingVersion === '1.0.0';
        const feishuDocumentTools = provider === 'feishu' && ctx.bindingVersion === '3.0.0';
        const binding = { feishuReadOnly, feishuDocumentTools };
        let acceptsGrant = feishuReadOnly ? isReadOnlyFeishuGrant : undefined;
        if (feishuDocumentTools) {
            acceptsGrant = record => ['docx:document', 'wiki:node:read', 'docs:document.comment:create'].every(scope => record?.grantedScopes?.includes(scope));
        }
        const documents = scope.documentConnections;
        if (operation === 'cancelAuthorization') {
            if (cv) { throw new Error('只有文档服务支持取消浏览器授权'); }
            return documents.cancelAuthorization(provider, binding);
        }
        if (operation === 'status') {
            const result = cv ? await scope.cvConnection.status() : await documents.status(provider, binding);
            return { ...result, canReuse: !result.connected && Boolean(await this.reusable(provider, scope, acceptsGrant)) };
        }
        if (operation === 'reuse') {
            const source = await this.reusable(provider, scope, acceptsGrant);
            if (!source) { throw new Error('没有可复用的个人授权'); }
            const selected = cv ? await scope.cvConnection.reuseFrom(source.cvConnection) :
                await documents.reuseFrom(provider, source.documentConnections, settings, acceptsGrant);
            await this.rememberAccount(provider, scope.key, true);
            return selected;
        }
        const result = cv ? await scope.cvConnection[operation](settings) :
            await documents[operation](provider, settings, binding);
        if (operation === 'connect') { await this.rememberAccount(provider, scope.key, true); }
        if (operation === 'disconnect') { await this.rememberAccount(provider, scope.key, false); }
        return result;
    }

    dispose() {
        for (const scope of this.scopes.values()) { scope.defectAuth.dispose(); }
    }
}

module.exports = { CapabilityProjectServices };
