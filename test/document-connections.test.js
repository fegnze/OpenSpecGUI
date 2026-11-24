'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var fs = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var DocumentConnections = require('../src/main/document-connections').DocumentConnections;

var DOC_ID = 'A'.repeat(27);
var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
var ScopedDocumentConnections = require('../src/main/scoped-document-connections').ScopedDocumentConnections;

function fakeSecureStorage() {
    var key = crypto.randomBytes(32);
    return {
        isEncryptionAvailable: function () { return true; },
        encryptString: function (text) {
            var iv = crypto.randomBytes(12);
            var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            var data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), data]);
        },
        decryptString: function (value) {
            var cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
            cipher.setAuthTag(value.subarray(12, 28));
            return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
        }
    };
}

async function callback(authorization, valid) {
    var url = new URL(authorization.searchParams.get('redirect_uri'));
    assert.equal(url.hostname, '127.0.0.1');
    url.searchParams.set('state', valid ? authorization.searchParams.get('state') : 'unrelated');
    url.searchParams.set('code', 'fixture-code');
    var reply = await fetch(url);
    await reply.text();
    return reply.status;
}

for (var provider of ['feishu', 'google-drive']) {
    (function (id) {
        test(id + ' 通过系统浏览器回调授权、持久化、轮换并验证只读元数据', async function () {
            var directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-auth-'));
            var storage = fakeSecureStorage();
            var consent;
            var tokenCalls = 0;
            var failed = false;
            var time = Date.now();
            var calls = [];
            var requestedScope = id === 'feishu' ? 'docx:document offline_access' : DRIVE_SCOPE;
            var options = {
                userDataPath: directory, safeStorage: storage, feishuPort: 0, now: function () { return time; },
                openExternal: async function (input) {
                    consent = new URL(input);
                    assert.equal(consent.origin + consent.pathname, id === 'feishu' ?
                        'https://accounts.feishu.cn/open-apis/authen/v1/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
                    assert.equal(new URL(consent.searchParams.get('redirect_uri')).pathname, id === 'feishu' ? '/oauth/callback' : '/');
                    assert.equal(consent.searchParams.get('scope'), requestedScope);
                    assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
                    assert.equal(consent.searchParams.get('client_secret'), null);
                    assert.equal(await callback(consent, false), 400);
                    assert.equal(await callback(consent, true), 200);
                },
                fetch: async function (url, init) {
                    calls.push(url);
                    if (url.endsWith('/token')) {
                        var feishuCodeExchange = id === 'feishu' && tokenCalls === 0;
                        var expectedUrl = id === 'feishu' ? 'https://accounts.feishu.cn/oauth/v3/token' : 'https://oauth2.googleapis.com/token';
                        if (feishuCodeExchange) { expectedUrl = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'; }
                        assert.equal(url, expectedUrl);
                        assert.equal(init.headers['Content-Type'], feishuCodeExchange ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded');
                        var body = new URLSearchParams(feishuCodeExchange ? JSON.parse(init.body) : init.body);
                        assert.equal(init.method, 'POST');
                        assert.equal(init.redirect, 'error');
                        assert.equal(body.get('client_secret'), 'fixture-secret');
                        assert.equal(body.get('scope'), id === 'feishu' ? requestedScope : null);
                        tokenCalls += 1;
                        if (tokenCalls === 1) {
                            assert.equal(body.get('redirect_uri'), consent.searchParams.get('redirect_uri'));
                            assert.equal(body.get('code'), 'fixture-code');
                            var hash = crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url');
                            assert.equal(hash, consent.searchParams.get('code_challenge'));
                        } else {
                            assert.equal(body.get('grant_type'), 'refresh_token');
                            assert.equal(body.get('refresh_token'), 'fixture-refresh-' + (tokenCalls - 1));
                        }
                        return Response.json({ access_token: 'fixture-access-' + tokenCalls, refresh_token: 'fixture-refresh-' + tokenCalls,
                            token_type: 'Bearer', scope: requestedScope, expires_in: 3600 });
                    }
                    assert.equal(init.headers.Authorization, 'Bearer fixture-access-' + tokenCalls);
                    if (failed) { return Response.json({ error: 'do-not-surface-this-value' }, { status: 403 }); }
                    if (id === 'feishu') {
                        assert.equal(url, 'https://open.feishu.cn/open-apis/docx/v1/documents/' + DOC_ID);
                        return Response.json({ code: 0, data: { document: { document_id: DOC_ID, title: 'PRIVATE DOCUMENT', revision_id: 1 } } });
                    }
                    assert.equal(new URL(url).searchParams.get('fields'), 'files(id,name,mimeType)');
                    return Response.json({ files: [{ id: '1', name: 'PRIVATE DOCUMENT', mimeType: 'text/plain' }] });
                }
            };
            try {
                var service = new DocumentConnections(options);
                assert.equal((await service.status(id)).state, 'disconnected');
                assert.equal((await service.connect(id, { clientId: 'test-client', clientSecret: 'fixture-secret',
                    documentId: 'https://example.feishu.cn/docx/' + DOC_ID })).state, 'connected');
                var encrypted = await fs.readFile(path.join(directory, 'document-connections', id + '.enc'));
                assert.equal(encrypted.includes('fixture-'), false);
                assert.equal((await fs.stat(path.join(directory, 'document-connections', id + '.enc'))).mode & 511, 384);
                service = new DocumentConnections(options);
                var summary = await service.verify(id);
                assert.equal(summary.state, 'verified');
                assert.doesNotMatch(JSON.stringify(summary), /fixture-|PRIVATE DOCUMENT/);
                time += 3600 * 1000;
                if (id === 'feishu') { assert.equal((await service.feishuDocumentMetadata()).title, 'PRIVATE DOCUMENT'); }
                else { assert.equal((await service.googleDriveFileMetadata())[0].name, 'PRIVATE DOCUMENT'); }
                assert.equal(tokenCalls, 2);
                failed = true;
                await assert.rejects(service.verify(id), /拒绝访问/);
                assert.equal((await service.status(id)).verifiedAt, null);
                assert.doesNotMatch((await service.status(id)).message, /do-not-surface/);
                var count = calls.length;
                assert.equal((await service.disconnect(id)).state, 'disconnected');
                assert.equal(calls.length, count);
                assert.equal((await fs.readdir(path.join(directory, 'document-connections'))).length, 0);
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        });
    }(provider));
}

test('授权取消、超时、不可用的钥匙串和授权范围扩大时均不保存凭据', async function () {
    var root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-auth-errors-'));
    var settings = { clientId: 'test-client', clientSecret: 'fixture-secret' };
    var released;
    var opened = new Promise(function (resolve) { released = resolve; });
    var options = { userDataPath: root, safeStorage: fakeSecureStorage(), openExternal: function () { released(); }, timeoutMs: 1000 };
    try {
        var service = new DocumentConnections(options);
        var connecting = service.connect('google-drive', settings);
        await opened;
        assert.equal((await service.status('google-drive')).state, 'authorizing');
        var rejection = assert.rejects(connecting, /已取消/);
        await service.disconnect('google-drive');
        await rejection;
        service = new DocumentConnections(Object.assign({}, options, { timeoutMs: 25 }));
        await assert.rejects(service.connect('google-drive', settings), /超时/);
        service = new DocumentConnections(Object.assign({}, options, {
            openExternal: function (url) { return callback(new URL(url), true); },
            fetch: function () { return Response.json({ scope: DRIVE_SCOPE + ' https://www.googleapis.com/auth/drive', access_token: 'broad', expires_in: 3600, token_type: 'Bearer' }); }
        }));
        await assert.rejects(service.connect('google-drive', settings), /授权范围/);
        await assert.rejects(service.connect('feishu', Object.assign({ documentId: 'https://example.com/docx/' + DOC_ID }, settings)), /飞书域名/);
        service = new DocumentConnections(Object.assign({}, options, { safeStorage: { isEncryptionAvailable: function () { return false; } } }));
        await assert.rejects(service.connect('google-drive', settings), /钥匙串/);
        assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('回调后飞书拒绝兑换时保留安全的厂商错误码，未保存的连接可重新授权', async function (t) {
    var root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-feishu-exchange-'));
    t.after(function () { return fs.rm(root, { recursive: true, force: true }); });
    var reply = { code: 20002, error: 'invalid_client', error_description: 'fixture-secret fixture-code' };
    var status = 400;
    var service = new DocumentConnections({
        userDataPath: root, safeStorage: fakeSecureStorage(), feishuPort: 0,
        openExternal: function (url) { return callback(new URL(url), true); },
        fetch: function (url) {
            assert.equal(url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
            return Response.json(reply, { status: status });
        }
    });
    var settings = { clientId: 'test-client', clientSecret: 'fixture-secret', documentId: DOC_ID };
    await assert.rejects(service.connect('feishu', settings), function (error) {
        assert.match(error.message, /换取飞书访问令牌.*HTTP 400.*飞书错误码 20002.*App Secret/);
        assert.doesNotMatch(error.message, /fixture-|文档访问权限/);
        return true;
    });
    assert.equal((await service.status('feishu')).connected, false);
    reply = { code: 20068, error: 'invalid_scope', error_description: 'fixture-secret fixture-code' };
    await assert.rejects(service.connect('feishu', settings), function (error) {
        assert.match(error.message, /20068.*(权限|授权范围)/);
        assert.doesNotMatch(error.message, /fixture-/);
        return true;
    });
    assert.deepEqual(await fs.readdir(root), []);
    status = 200;
    reply = { code: 0, access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, scope: 'docx:document' };
    assert.equal((await service.connect('feishu', settings)).state, 'connected');
});

test('飞书新授权要求文档读写权限，接受附带的只读和身份范围', async function (t) {
    var root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-feishu-scopes-'));
    t.after(function () { return fs.rm(root, { recursive: true, force: true }); });
    var tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer' };
    var scope;
    var service = new DocumentConnections({
        userDataPath: root, safeStorage: fakeSecureStorage(), feishuPort: 0,
        openExternal: function (input) { return callback(new URL(input), true); },
        fetch: function () { return Response.json(Object.assign({}, tokens, { scope: scope })); }
    });
    var settings = { clientId: 'fixture-client', clientSecret: 'fixture-secret', documentId: DOC_ID };
    for (var sample of [
        { scope: undefined, issue: 'missing_scope' },
        { scope: 'user_profile offline_access', issue: 'missing_required' },
        { scope: 'docx:document:readonly offline_access', issue: 'missing_required' },
        { scope: 'docx:document user_profile im:message', issue: 'unexpected_scope' }
    ]) {
        scope = sample.scope;
        await assert.rejects(service.connect('feishu', settings), { feishuScopeIssue: sample.issue });
        assert.equal((await service.status('feishu')).connected, false);
        assert.deepEqual(await fs.readdir(root), []);
    }
    for (scope of ['docx:document user_profile', 'docx:document:readonly docx:document']) {
        var connected = await service.connect('feishu', settings);
        assert.equal(connected.state, 'connected');
        assert.deepEqual(connected.scopes, scope.split(' '));
    }
    var saved = await service.read('feishu');
    scope = 'docx:document:readonly';
    await assert.rejects(service.connect('feishu', settings), { feishuScopeIssue: 'missing_required' });
    assert.deepEqual(await service.read('feishu'), saved);
});

test('飞书刷新明确返回空范围时保留此前令牌', async function (t) {
    var root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-feishu-refresh-scopes-'));
    t.after(function () { return fs.rm(root, { recursive: true, force: true }); });
    var service = new DocumentConnections({
        userDataPath: root, safeStorage: fakeSecureStorage(),
        fetch: function (url, init) {
            assert.equal(url, 'https://accounts.feishu.cn/oauth/v3/token');
            assert.equal(new URLSearchParams(init.body).get('scope'), 'docx:document:readonly');
            return Response.json({ scope: '', access_token: 'replacement', refresh_token: 'replacement-refresh',
                token_type: 'Bearer', expires_in: 3600 });
        }
    });
    var record = { provider: 'feishu', version: 1, clientId: 'fixture-client', clientSecret: 'fixture-secret',
        grantedScopes: ['docx:document:readonly'], accessToken: 'previous', refreshToken: 'previous-refresh',
        documentId: DOC_ID, verifiedAt: null, expiresAt: 0 };
    await service.write('feishu', record);
    await assert.rejects(service.verify('feishu'), { feishuScopeIssue: 'missing_scope' });
    assert.deepEqual(await service.read('feishu'), record);
});

test('旧只读连接刷新时沿用原权限，按厂商规则处理未返回的新刷新令牌', async function (t) {
    var root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-refresh-rotation-'));
    t.after(function () { return fs.rm(root, { recursive: true, force: true }); });
    for (const id of ['feishu', 'google-drive']) {
        await t.test(id, async function () {
            var scope = id === 'feishu' ? 'docx:document:readonly' : DRIVE_SCOPE;
            var now = Date.now();
            var exchanges = 0;
            var service = new DocumentConnections({
                userDataPath: root, safeStorage: fakeSecureStorage(), now: function () { return now; },
                fetch: function (url, init) {
                    if (url.endsWith('/token')) {
                        var request = new URLSearchParams(init.body);
                        assert.equal(request.get('scope'), id === 'feishu' ? scope : null);
                        assert.equal(request.get('refresh_token'), 'previous-refresh');
                        exchanges++;
                        return Response.json({ access_token: 'fresh-' + exchanges, token_type: 'Bearer', expires_in: 3600 });
                    }
                    assert.equal(init.headers.Authorization, 'Bearer fresh-' + exchanges);
                    return Response.json(id === 'feishu' ? { data: { document: { document_id: DOC_ID } } } : { files: [] });
                }
            });
            await service.write(id, { provider: id, version: 1, clientId: 'fixture-client', clientSecret: 'fixture-secret',
                documentId: DOC_ID, grantedScopes: [scope], accessToken: 'previous', refreshToken: 'previous-refresh', expiresAt: 0 });
            var verified = await service.verify(id);
            assert.deepEqual(verified.scopes, [scope]);
            var saved = await service.read(id);
            assert.equal(saved.accessToken, 'fresh-1');
            assert.equal(saved.refreshToken, id === 'feishu' ? null : 'previous-refresh');
            now += 3600 * 1000;
            if (id === 'feishu') {
                await assert.rejects(service.verify(id), /重新连接/);
                assert.equal(exchanges, 1);
            } else {
                assert.equal((await service.verify(id)).state, 'verified');
                assert.equal(exchanges, 2);
            }
        });
    }
});

test('同一项目连续重试只启动最新授权，重新使用回调端口，拒绝旧浏览器页', async function (t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-authorize-retry-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const firstBrowser = Promise.withResolvers();
    const nextBrowser = Promise.withResolvers();
    let opens = 0;
    const service = new DocumentConnections({
        userDataPath: root, safeStorage: fakeSecureStorage(), feishuPort: 0,
        openExternal(url) { (++opens === 1 ? firstBrowser : nextBrowser).resolve(new URL(url)); },
        fetch(url, options) {
            assert.equal(JSON.parse(options.body).client_secret, 'fixture-secret');
            return Response.json({ access_token: 'successful', expires_in: 3600, token_type: 'Bearer', scope: 'docx:document' });
        }
    });
    const settings = { clientId: 'first-client', clientSecret: 'fixture-secret', documentId: DOC_ID };
    const first = service.connect('feishu', settings);
    const original = await firstBrowser.promise;
    service.feishuPort = Number(new URL(original.searchParams.get('redirect_uri')).port);
    await assert.rejects(service.connect('feishu', { ...settings, clientSecret: '' }), /密钥/);
    assert.equal((await service.status('feishu')).state, 'authorizing');
    const replaced = assert.rejects(first, /已重新发起/);
    const intermediate = assert.rejects(service.connect('feishu', { ...settings, clientId: 'next-client' }), /已重新发起/);
    const final = service.connect('feishu', {});
    const latest = await nextBrowser.promise;
    assert.equal(latest.searchParams.get('client_id'), 'next-client');
    assert.equal(latest.searchParams.get('redirect_uri'), original.searchParams.get('redirect_uri'));
    assert.notEqual(latest.searchParams.get('state'), original.searchParams.get('state'));
    assert.notEqual(latest.searchParams.get('code_challenge'), original.searchParams.get('code_challenge'));
    assert.equal(await callback(original, true), 400);
    assert.equal(await callback(latest, true), 200);
    assert.equal((await final).state, 'connected');
    await Promise.all([replaced, intermediate]);
    assert.equal(opens, 2);
    await assert.rejects(service.connect('feishu', {}), /密钥/);
    assert.equal((await service.read('feishu')).accessToken, 'successful');
});

test('授权排队保存时可取消，既有凭据保留，已经开始的保存可正常完成', { timeout: 3000 }, async function (t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-authorize-save-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const queues = new Map();
    const service = new ScopedDocumentConnections({
        userDataPath: root, safeStorage: fakeSecureStorage(), accountQueues: queues, accounts: path.join(root, 'accounts'),
        openExternal: url => callback(new URL(url), true),
        fetch: () => Response.json({ access_token: 'new', expires_in: 3600, token_type: 'Bearer', scope: DRIVE_SCOPE })
    });
    const provider = 'google-drive';
    const settings = { clientId: 'client', clientSecret: 'secret' };
    await service.write(provider, { version: 1, provider, accessToken: 'original', grantedScopes: [DRIVE_SCOPE], verifiedAt: 'earlier' });
    const otherWork = Promise.withResolvers();
    queues.set(provider, otherWork.promise);
    const queued = Promise.withResolvers();
    const originalLock = service.accountLock.bind(service);
    service.accountLock = (id, action) => { const result = originalLock(id, action); queued.resolve(); return result; };
    const canceled = assert.rejects(service.connect(provider, settings), /取消/);
    await queued.promise;
    const stopped = await service.cancelAuthorization(provider);
    assert.equal(stopped.canceled, true);
    assert.equal(stopped.state, 'verified');
    assert.match(stopped.message, /取消/);
    await canceled;
    otherWork.resolve();
    await assert.rejects(queues.get(provider), { name: 'AbortError' });
    assert.equal((await service.read(provider)).accessToken, 'original');

    const committing = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const save = service.writeAccount.bind(service);
    service.writeAccount = async (id, record) => { committing.resolve(); await finish.promise; return save(id, record); };
    const success = service.connect(provider, settings);
    await committing.promise;
    const lateCancel = service.cancelAuthorization(provider);
    finish.resolve();
    assert.equal((await success).state, 'connected');
    assert.equal((await lateCancel).canceled, false);
    assert.equal((await service.read(provider)).accessToken, 'new');
});

test('旧回调的令牌响应迟到时，新授权已可完成，且旧响应不能覆盖新凭据', { timeout: 3000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-authorize-stale-token-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const exchangeStarted = Promise.withResolvers();
    const delayedExchange = Promise.withResolvers();
    const access = token => Response.json({ access_token: token, expires_in: 3600, token_type: 'Bearer', scope: DRIVE_SCOPE });
    let exchanges = 0;
    const service = new DocumentConnections({
        userDataPath: root, safeStorage: fakeSecureStorage(),
        openExternal: url => callback(new URL(url), true),
        fetch() {
            if (++exchanges === 1) { exchangeStarted.resolve(); return delayedExchange.promise; }
            return access('newest');
        }
    });
    const first = assert.rejects(service.connect('google-drive', { clientId: 'client', clientSecret: 'secret' }), /已重新发起/);
    await exchangeStarted.promise;
    assert.equal((await service.connect('google-drive', {})).state, 'connected');
    await first;
    delayedExchange.resolve(access('stale'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await service.read('google-drive')).accessToken, 'newest');
});
