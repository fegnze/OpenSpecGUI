'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DocumentConnections, parseDocumentId } = require('./document-connections');

/** 未共享时保持独立存储。显式复用后，共用一个加密的 OAuth 记录以支持厂商轮换刷新令牌。 */
class ScopedDocumentConnections extends DocumentConnections {
    constructor(options) {
        super(options);
        this.accounts = options.accounts;
        this.accountQueues = options.accountQueues;
        this.owner = 'owner-' + crypto.createHash('sha256').update(this.directory).digest('hex');
    }

    accountDirectory(account) {
        if (!/^[a-f0-9-]{36}$/.test(account)) { throw new Error('本机授权引用无效'); }
        return path.join(this.accounts, account);
    }

    localFile(provider) { return path.join(this.directory, provider + '.enc'); }

    async read(provider) {
        const local = await this.readEncrypted(this.localFile(provider));
        if (!local) { return null; }
        if (local.provider !== provider) { throw new Error('本机文档授权格式无效'); }
        if (local.version === 1 && local.accessToken) { return local; }
        if (local.version !== 2) { throw new Error('本机文档授权版本无效'); }
        const shared = await this.readEncrypted(path.join(this.accountDirectory(local.account), 'authorization.enc'));
        if (!shared?.accessToken || shared.provider !== provider) { throw new Error('个人授权引用已失效，请重新连接'); }
        return { ...shared, account: local.account, documentId: local.documentId, verifiedAt: local.verifiedAt };
    }

    async reference(provider, { account, documentId, verifiedAt }) {
        const dir = this.accountDirectory(account);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(dir, this.owner), '', { mode: 0o600 });
        await this.writeEncrypted(this.localFile(provider), { version: 2, provider, account, documentId, verifiedAt });
    }

    async release(account) {
        if (!account) { return; }
        const dir = this.accountDirectory(account);
        await fs.rm(path.join(dir, this.owner), { force: true });
        if (!(await fs.readdir(dir)).some(name => name.startsWith('owner-'))) {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }

    write(provider, record, signal) {
        if (!signal) { return this.writeAccount(provider, record); }
        signal.throwIfAborted();
        // 等待共享账户时可结束本轮授权，新授权无需等待旧队列项。开始保存后让事务完成。
        return new Promise((resolve, reject) => {
            const cancel = () => reject(signal.reason);
            signal.addEventListener('abort', cancel, { once: true });
            this.accountLock(provider, () => {
                signal.removeEventListener('abort', cancel);
                signal.throwIfAborted();
                return this.writeAccount(provider, record);
            }).then(resolve, reject);
        });
    }

    async writeAccount(provider, record) {
        const prior = await this.readEncrypted(this.localFile(provider));
        if (record.account) {
            const { account, documentId, verifiedAt, ...authorization } = record;
            await this.writeEncrypted(path.join(this.accountDirectory(account), 'authorization.enc'), authorization);
            await this.reference(provider, { account, documentId, verifiedAt });
        } else {
            await super.write(provider, record);
        }
        if (prior?.account && prior.account !== record.account) { await this.release(prior.account); }
    }

    reuseFrom(provider, prior, settings, acceptsGrant) {
        return this.exclusive(provider, 'reuse', async () => {
            const documentId = provider === 'feishu' ? parseDocumentId(settings?.documentId) : null;
            const record = await prior.read(provider);
            if (!record || (acceptsGrant && !acceptsGrant(record))) { throw new Error('没有可复用的个人授权'); }
            if (!record.account) {
                record.account = crypto.randomUUID();
                await prior.write(provider, record);
            }
            const local = await this.readEncrypted(this.localFile(provider));
            const selected = { ...record, documentId, verifiedAt: null };
            await this.reference(provider, selected);
            if (local?.account && local.account !== record.account) { await this.release(local.account); }
            return this.summary(provider, selected, false);
        });
    }

    exclusive(provider, kind, action, settings) {
        return super.exclusive(provider, kind, signal => {
            if (kind === 'connect') { return action(signal); }
            return this.accountLock(provider, () => action(signal));
        }, settings);
    }

    accountLock(provider, action) {
        const previous = this.accountQueues.get(provider) || Promise.resolve();
        const run = previous.catch(() => {}).then(action);
        this.accountQueues.set(provider, run);
        return run.finally(() => { if (this.accountQueues.get(provider) === run) { this.accountQueues.delete(provider); } });
    }

    async disconnect(provider) {
        const pending = this.pending.get(provider);
        if (pending?.kind === 'connect') { pending.controller.abort(); await pending.promise.catch(() => {}); }
        return this.exclusive(provider, 'disconnect', async () => {
            const local = await this.readEncrypted(this.localFile(provider));
            await fs.rm(this.localFile(provider), { force: true });
            await this.release(local?.account);
            this.messages.delete(provider);
            return this.summary(provider, null, false);
        });
    }
}

module.exports = { ScopedDocumentConnections };
