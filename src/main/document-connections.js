'use strict';

var crypto = require('node:crypto');
var fs = require('node:fs/promises');
var path = require('node:path');
var loopback = require('./document-oauth-loopback');
var { parseDocumentId, resolveDocument, WIKI_SCOPE, COMMENT_SCOPE } = require('./feishu-document-tools');

var FEISHU_DOCUMENT = 'docx:document';
var FEISHU_DOCUMENT_READONLY = 'docx:document:readonly';
var PROVIDERS = {
    feishu: {
        name: '飞书', authorize: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
        // 飞书「获取授权码」文档指定该授权页的 PKCE 流程搭配 v2 JSON 兑换。
        pkceToken: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        token: 'https://accounts.feishu.cn/oauth/v3/token', scopes: [FEISHU_DOCUMENT, 'offline_access'],
        port: 47921
    },
    'google-drive': {
        name: 'Google Drive', authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'], port: 0
    }
};

function providerFor(provider) {
    if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) { throw new Error('未知的文档连接服务。'); }
    return PROVIDERS[provider];
}

function authorizationScopes(provider, binding) {
    if (provider === 'feishu' && binding?.feishuReadOnly) { return [FEISHU_DOCUMENT_READONLY, 'offline_access']; }
    if (provider === 'feishu' && binding?.feishuDocumentTools) { return [FEISHU_DOCUMENT, WIKI_SCOPE, COMMENT_SCOPE, 'offline_access']; }
    return providerFor(provider).scopes;
}

function validateSettings(provider, settings) {
    var id = settings && settings.clientId;
    var secret = settings && settings.clientSecret;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{3,512}$/.test(id.trim()) ||
        typeof secret !== 'string' || !secret.trim() || secret.length > 2048) { throw new Error('请填写 OAuth 客户端 ID 和密钥。'); }
    return { clientId: id.trim(), clientSecret: secret.trim(), documentId: provider === 'feishu' ? parseDocumentId(settings.documentId) : null };
}

/** 通过系统浏览器接入文档服务，仅在主进程解密本应用保存的连接。 */
function DocumentConnections(options) {
    this.directory = path.join(options.userDataPath, 'document-connections');
    this.storage = options.safeStorage;
    this.openExternal = options.openExternal;
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    this.timeoutMs = options.timeoutMs || 5 * 60 * 1000;
    this.feishuPort = options.feishuPort === undefined ? PROVIDERS.feishu.port : options.feishuPort;
    this.pending = new Map();
    this.messages = new Map();
}

DocumentConnections.prototype.checkStorage = function () {
    if (!this.storage || !this.storage.isEncryptionAvailable() ||
        (process.platform === 'linux' && this.storage.getSelectedStorageBackend && this.storage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error('系统凭据存储不可用，请解锁系统钥匙串后重试。');
    }
};

DocumentConnections.prototype.readEncrypted = async function (file) {
    var encrypted;
    try { encrypted = await fs.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') { return null; } throw new Error('无法读取本机文档连接。'); }
    this.checkStorage();
    try {
        return JSON.parse(this.storage.decryptString(encrypted));
    } catch (error) { throw new Error('无法解锁本机文档连接，请检查系统钥匙串或断开后重新授权。'); }
};

DocumentConnections.prototype.read = async function (provider) {
    const record = await this.readEncrypted(path.join(this.directory, provider + '.enc'));
    if (record && (record.provider !== provider || record.version !== 1 || !record.accessToken)) { throw new Error('本机文档授权格式无效。'); }
    return record;
};

DocumentConnections.prototype.write = function (provider, record) {
    return this.writeEncrypted(path.join(this.directory, provider + '.enc'), record);
};

DocumentConnections.prototype.writeEncrypted = async function (target, record) {
    this.checkStorage();
    var encrypted;
    try { encrypted = this.storage.encryptString(JSON.stringify(record)); }
    catch (error) { throw new Error('系统凭据存储写入失败，请检查系统钥匙串。'); }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 448 });
    var temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, encrypted, { mode: 384, flag: 'wx' });
        await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
};

DocumentConnections.prototype.summary = function (provider, record, authorizing, binding) {
    var verified = record && record.verifiedAt;
    var state = authorizing ? 'authorizing' : (record ? (verified ? 'verified' : 'connected') : 'disconnected');
    var messages = { authorizing: '请在系统浏览器完成授权。', disconnected: '尚未连接。', connected: '授权已保存，可验证只读访问。', verified: '最近一次只读访问验证成功。' };
    if (provider === 'feishu') {
        messages.connected = '授权已保存，可验证指定文档的访问。';
        messages.verified = '已成功读取指定飞书文档的基本信息。';
    }
    var missing = provider === 'feishu' && binding?.feishuDocumentTools && record ?
        [FEISHU_DOCUMENT, WIKI_SCOPE, COMMENT_SCOPE].filter(scope => !record.grantedScopes?.includes(scope)) : [];
    var message = this.messages.get(provider) || messages[state];
    if (missing.length) { message += ' 当前授权缺少 ' + missing.join('、') + '，请在飞书应用开通并发布后，在工作台重新授权。'; }
    return { provider: provider, state: state, connected: Boolean(record), verifiedAt: verified || null,
        scopes: record ? (record.grantedScopes || []).slice() : authorizationScopes(provider, binding).slice(),
        redirectUri: provider === 'feishu' ? 'http://127.0.0.1:' + this.feishuPort + loopback.callbackPath : null,
        message: authorizing ? messages.authorizing : message };
};

DocumentConnections.prototype.status = async function (provider, binding) {
    providerFor(provider);
    var atStart = this.pending.get(provider);
    var record = await this.read(provider);
    var pending = this.pending.get(provider);
    if (atStart?.kind === 'connect' && !pending) { record = await this.read(provider); }
    return this.summary(provider, record, pending?.kind === 'connect', binding);
};

DocumentConnections.prototype.exclusive = function (provider, kind, action, settings) {
    providerFor(provider);
    var previous = this.pending.get(provider);
    if (previous && (kind !== 'connect' || previous.kind !== 'connect')) {
        return Promise.reject(new Error('该文档服务的连接操作正在进行。'));
    }
    if (previous) { previous.controller.abort(new Error('已重新发起授权。')); }
    var entry = { kind: kind, controller: new AbortController(), settings: settings };
    var self = this;
    this.pending.set(provider, entry);
    var ready = previous ? previous.promise.catch(function () {}) : Promise.resolve();
    entry.promise = ready.then(function () {
        entry.controller.signal.throwIfAborted();
        return action(entry.controller.signal);
    }).catch(function (error) {
        if (kind === 'connect') {
            if (error.name === 'AbortError') { error = Object.assign(new Error('本次文档授权已取消，可重新授权。'), { code: 'AUTHORIZATION_CANCELED' }); }
            if (error.name === 'TimeoutError') { error = new Error('浏览器授权超时，请重试。'); }
            if (error.syscall) { error = new Error('本机授权记录写入失败，请检查系统凭据存储和磁盘后重试。'); }
            if (self.pending.get(provider) === entry) { self.messages.set(provider, error.message); }
        }
        throw error;
    })
        .finally(function () { if (self.pending.get(provider) === entry) { self.pending.delete(provider); } });
    return entry.promise;
};

// 只展示协议中的错误编号及已知原因。厂商原始描述可能包含用户提交的值。
var FEISHU_TOKEN_ERRORS = {
    20002: '请从同一个飞书应用的「凭证与基础信息」重新复制 App ID 和 App Secret。',
    20003: '飞书未找到该授权码，请从工作台重新发起授权。',
    20004: '授权码已过期，请从工作台重新发起授权。',
    20009: '当前租户尚未安装此应用，请联系应用管理员。',
    20010: '当前账号没有此应用的使用权限，请管理员核对应用的可用范围。',
    20024: '授权凭据与 App ID 不匹配，请核对飞书应用后重新授权。',
    20026: '刷新凭据无效，请重新授权。',
    20037: '刷新凭据已过期，请重新授权。',
    20048: '飞书找不到该应用，请核对 App ID。',
    20049: '飞书未通过本次 PKCE 校验，请从工作台重新发起授权。',
    20065: '授权码已使用，请从工作台重新发起授权。',
    20068: '本次请求中有权限尚未获用户授权。请在飞书应用后台核对工作台列出的文档权限和 offline_access，发布生效后重新授权。',
    20069: '飞书应用尚未启用，请管理员检查应用状态。',
    20071: '兑换令牌时的回调地址与授权时不同，请从工作台重新发起授权。'
};

function feishuTokenFailure(stage, status, body) {
    var code = body && Number.isSafeInteger(body.code) && body.code > 0 ? body.code : null;
    var hint = FEISHU_TOKEN_ERRORS[code];
    if (!hint && body && body.error === 'invalid_client') {
        hint = FEISHU_TOKEN_ERRORS[20002];
    }
    var failure = new Error(stage + '失败（HTTP ' + status + (code ? '，飞书错误码 ' + code : '') + '）。' +
        (hint || '请从工作台重新授权，若仍失败请将此错误信息提供给维护者。'));
    failure.feishuErrorCode = code;
    return failure;
}

DocumentConnections.prototype.request = async function (url, options, feishuTokenStage) {
    var response;
    try {
        var deadline = AbortSignal.timeout(15000);
        var signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        response = await this.fetch(url, Object.assign({ redirect: 'error' }, options, { signal: signal }));
    } catch (error) {
        if (options.signal && options.signal.aborted && options.signal.reason?.name === 'AbortError') {
            throw new Error('本次文档授权已取消。');
        }
        throw Object.assign(new Error((feishuTokenStage || '连接文档服务') + '失败，请检查网络后重试。'), { code: 'PROVIDER_NETWORK_ERROR' });
    }
    var body;
    try { body = await response.json(); } catch (error) {
        if (feishuTokenStage) { throw feishuTokenFailure(feishuTokenStage, response.status, null); }
        throw Object.assign(new Error('文档服务没有返回有效响应。'), { code: 'PROVIDER_RESPONSE_INVALID' });
    }
    if (!response.ok || !body || typeof body !== 'object' || body.error || (body.code !== undefined && body.code !== 0)) {
        if (feishuTokenStage) { throw feishuTokenFailure(feishuTokenStage, response.status, body); }
        var expiredFeishuToken = url.startsWith('https://open.feishu.cn/open-apis/') && [99991677, 99991668].includes(body?.code);
        var code = response.status === 401 || expiredFeishuToken ? 'AUTH_EXPIRED' : (response.status >= 500 ? 'PROVIDER_SERVER_ERROR' : 'PROVIDER_ERROR');
        var providerCode = url.startsWith('https://open.feishu.cn/open-apis/') && Number.isSafeInteger(body?.code) && body.code > 0 ?
            '，飞书错误码 ' + body.code : '';
        var failure = new Error(response.status === 403 ? '文档服务拒绝访问，请检查应用权限和文档共享设置。' :
            '文档服务请求失败（HTTP ' + response.status + providerCode + '），请检查授权、应用配置和文档访问权限。');
        failure.code = code;
        throw failure;
    }
    return body;
};

function feishuScopeError(issue, message) {
    var error = new Error(message);
    error.feishuScopeIssue = issue;
    return error;
}

/** 刷新只申请此前已授予的文档权限；旧的只读连接需经用户重新授权才能升级。 */
function feishuRefreshScopes(granted) {
    var scopes = Array.isArray(granted) ? granted : [];
    var documentScope = [FEISHU_DOCUMENT, FEISHU_DOCUMENT_READONLY].find(function (scope) { return scopes.includes(scope); });
    if (!documentScope) { throw feishuScopeError('missing_required', '本机保存的飞书授权缺少文档权限，请重新连接。'); }
    return [documentScope, WIKI_SCOPE, COMMENT_SCOPE, 'offline_access'].filter(scope => scopes.includes(scope));
}

/** 核对飞书返回的实际权限。诊断只展示权限标识，不回显厂商响应。 */
function validateFeishuScopes(scopes, requested) {
    var documentScope = requested[0];
    if (!scopes.length) {
        throw feishuScopeError('missing_scope', '飞书令牌响应中缺少可核对的授权范围。请重新授权。');
    }
    if (!scopes.includes(documentScope)) {
        var name = documentScope === FEISHU_DOCUMENT ? '创建及编辑新版文档' : '查看新版文档';
        var issue = documentScope === FEISHU_DOCUMENT ? 'missing_required' : 'missing_readonly';
        throw feishuScopeError(issue, '飞书未授予「' + name + '」(' + documentScope + ')。请在飞书应用后台开通该用户身份权限，发布生效后重新授权。');
    }
    var missing = [WIKI_SCOPE, COMMENT_SCOPE].filter(scope => requested.includes(scope) && !scopes.includes(scope));
    if (missing.length) {
        throw feishuScopeError('missing_required', '飞书未授予 ' + missing.join('、') + '，请在飞书应用开通对应用户身份权限，发布生效后重新授权。');
    }
    // 飞书令牌示例包含 user_profile；用户信息接口可凭用户令牌读取本人的基础资料。
    // 只接受这个已知身份范围。它不参与文档请求或下一次令牌的 scope 参数。
    var extra = scopes.filter(function (scope) {
        return scope !== 'user_profile' && scope !== FEISHU_DOCUMENT_READONLY && !requested.includes(scope);
    });
    if (extra.length) {
        var names = extra.filter(function (scope) {
            return scope === 'offline_access' || (scope.length <= 64 && /^[a-z][a-z0-9_]*(:[a-z][a-z0-9._]*){1,3}$/.test(scope));
        }).slice(0, 5);
        var detail = names.length ? '（' + names.join('、') + '）' : '';
        throw feishuScopeError('unexpected_scope', '飞书令牌包含本次请求范围之外的权限' + detail + '。工作台已拒绝该令牌，请核对应用授权范围。');
    }
}

DocumentConnections.prototype.exchange = async function (provider, record, params, signal, binding) {
    var config = providerFor(provider);
    var refreshing = params.grant_type === 'refresh_token';
    var stage = refreshing ? '刷新飞书访问令牌' : '用授权码换取飞书访问令牌';
    var usePkceEndpoint = Boolean(config.pkceToken && params.grant_type === 'authorization_code');
    var fields = Object.assign({ client_id: record.clientId, client_secret: record.clientSecret }, params);
    var requested = authorizationScopes(provider, binding);
    if (provider === 'feishu') {
        if (refreshing) { requested = feishuRefreshScopes(record.grantedScopes); }
        fields.scope = requested.join(' ');
    }
    var request = {
        method: 'POST',
        headers: { 'Content-Type': usePkceEndpoint ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
        body: usePkceEndpoint ? JSON.stringify(fields) : new URLSearchParams(fields).toString()
    };
    if (signal) { request.signal = AbortSignal.any([signal, AbortSignal.timeout(15000)]); }
    var data = await this.request(usePkceEndpoint ? config.pkceToken : config.token, request, provider === 'feishu' ? stage : null);
    var scopeText = data.scope;
    if (scopeText === undefined && refreshing) {
        scopeText = (provider === 'feishu' ? requested : record.grantedScopes).join(' ');
    }
    var scopes = typeof scopeText === 'string' ? scopeText.split(/\s+/).filter(Boolean) : [];
    if (provider === 'feishu') {
        validateFeishuScopes(scopes, requested);
    } else if (!scopes.includes(config.scopes[0]) || scopes.some(function (scope) { return !config.scopes.includes(scope); })) {
        throw new Error('厂商返回的授权范围与所需只读权限不符，请使用专用 OAuth 客户端重新授权。');
    }
    if (typeof data.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0) ||
        (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) {
        throw new Error('厂商返回的授权信息不完整。');
    }
    record.accessToken = data.access_token;
    record.expiresAt = this.now() + Number(data.expires_in) * 1000;
    record.refreshToken = data.refresh_token || (provider === 'google-drive' && record.refreshToken) || null;
    record.grantedScopes = scopes;
};

DocumentConnections.prototype.connect = async function (provider, settings, binding) {
    var config = providerFor(provider);
    this.checkStorage();
    var previous = this.pending.get(provider);
    var retry = settings && Object.keys(settings).length === 0 && previous?.kind === 'connect';
    var inputs = validateSettings(provider, retry ? previous.settings : settings);
    var self = this;
    return this.exclusive(provider, 'connect', async function (signal) {
        self.messages.delete(provider);
        var record = Object.assign({ version: 1, provider: provider, verifiedAt: null }, inputs);
        var params = { client_id: record.clientId, scope: authorizationScopes(provider, binding).join(' '), prompt: 'consent' };
        if (provider === 'google-drive') { params.access_type = 'offline'; }
        return loopback.authorize({ port: provider === 'feishu' ? self.feishuPort : 0,
            callbackPath: provider === 'feishu' ? loopback.callbackPath : '/', authorizeUrl: config.authorize,
            params: params, openExternal: self.openExternal, timeoutMs: self.timeoutMs, signal: signal,
            complete: async function (result, attemptSignal) {
                var fields = { grant_type: 'authorization_code', code: result.code, code_verifier: result.verifier, redirect_uri: result.redirectUri };
                var interrupted = Promise.withResolvers();
                var stopExchange = function () { interrupted.reject(attemptSignal.reason); };
                attemptSignal.addEventListener('abort', stopExchange, { once: true });
                try {
                    await Promise.race([self.exchange(provider, record, fields, attemptSignal, binding), interrupted.promise]);
                } catch (error) {
                    attemptSignal.throwIfAborted();
                    throw error;
                } finally { attemptSignal.removeEventListener('abort', stopExchange); }
                attemptSignal.throwIfAborted();
                await self.write(provider, record, attemptSignal);
                return self.summary(provider, record, false);
            }
        });
    }, inputs);
};

/** 停止本次浏览器授权，保留之前的凭据；已经开始提交的记录以保存结果为准。 */
DocumentConnections.prototype.cancelAuthorization = async function (provider, binding) {
    providerFor(provider);
    var entry = this.pending.get(provider);
    var canceled = false;
    if (entry?.kind === 'connect') {
        entry.controller.abort();
        try { await entry.promise; }
        catch (error) { canceled = error.code === 'AUTHORIZATION_CANCELED'; }
    }
    return Object.assign(await this.status(provider, binding), { canceled: canceled });
};

/** 固定厂商和只读资源路径，取飞书文档元信息或 Google Drive 文件元数据。 */
DocumentConnections.prototype.readMetadata = async function (provider, record) {
    if (provider === 'feishu') {
        var documentId = await resolveDocument(this, record, parseDocumentId(record.documentId));
        var result = await this.request('https://open.feishu.cn/open-apis/docx/v1/documents/' + documentId, {
            headers: { Authorization: 'Bearer ' + record.accessToken }
        });
        var document = result.data && result.data.document;
        if (!document || document.document_id !== documentId) { throw new Error('没有取得指定飞书文档的基本信息。'); }
        return { documentId: document.document_id, title: document.title, revision: document.revision_id };
    }
    var files = await this.request('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id%2Cname%2CmimeType)&q=trashed%3Dfalse', {
        headers: { Authorization: 'Bearer ' + record.accessToken }
    });
    if (!Array.isArray(files.files)) { throw new Error('没有取得 Google Drive 文件元数据。'); }
    return files.files.map(function (file) { return { id: file.id, name: file.name, mimeType: file.mimeType }; });
};

DocumentConnections.prototype.refresh = async function (provider, record) {
    if (!record.refreshToken) { throw new Error('授权已过期，请重新连接。'); }
    await this.exchange(provider, record, { grant_type: 'refresh_token', refresh_token: record.refreshToken });
    await this.write(provider, record);
};

// 每个已选账户串行刷新。厂商明确拒绝访问令牌时才重新发送操作。
DocumentConnections.prototype.authorizedRequest = async function (provider, record, operation) {
    var refreshed = record.expiresAt <= this.now() + 60000;
    if (refreshed) { await this.refresh(provider, record); }
    try { return await operation(record); }
    catch (error) {
        if (error.code !== 'AUTH_EXPIRED' || refreshed || !record.refreshToken) { throw error; }
        await this.refresh(provider, record);
        return operation(record);
    }
};

DocumentConnections.prototype.withAccessToken = function (provider, operation) {
    return this.exclusive(provider, 'agent-tool', async () => {
        var record = await this.read(provider);
        if (!record) { throw new Error('请在工作台当前项目和宿主的能力绑定页面连接文档服务。'); }
        return this.authorizedRequest(provider, record, operation);
    });
};

DocumentConnections.prototype.withMetadata = function (provider, reveal) {
    var self = this;
    return this.exclusive(provider, 'verify', async function () {
        var record = await self.read(provider);
        if (!record) { throw new Error('请先连接文档服务。'); }
        try {
            var metadata = await self.authorizedRequest(provider, record, value => self.readMetadata(provider, value));
            record.verifiedAt = new Date(self.now()).toISOString();
            await self.write(provider, record);
            self.messages.delete(provider);
            return reveal ? metadata : self.summary(provider, record, false);
        } catch (error) {
            record.verifiedAt = null;
            self.messages.set(provider, error.message);
            await self.write(provider, record);
            throw error;
        }
    });
};

DocumentConnections.prototype.verify = function (provider) { return this.withMetadata(provider, false); };

/** 供可信主进程调用，返回已配置飞书文档的标题与版本。 */
DocumentConnections.prototype.feishuDocumentMetadata = function () { return this.withMetadata('feishu', true); };

/** 供可信主进程调用，返回最多一个可见 Drive 文件的 ID、名称与 MIME 类型。 */
DocumentConnections.prototype.googleDriveFileMetadata = function () { return this.withMetadata('google-drive', true); };

DocumentConnections.prototype.disconnect = async function (provider) {
    providerFor(provider);
    var pending = this.pending.get(provider);
    if (pending && pending.kind === 'connect') {
        pending.controller.abort();
        await pending.promise.catch(function () {});
    }
    var self = this;
    return this.exclusive(provider, 'disconnect', async function () {
        await fs.rm(path.join(self.directory, provider + '.enc'), { force: true });
        self.messages.set(provider, '已清除本机连接。可在厂商账户中撤销应用授权。');
        return self.summary(provider, null, false);
    });
};

module.exports = { DocumentConnections, parseDocumentId };
