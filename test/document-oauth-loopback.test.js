'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authorize } = require('../src/main/document-oauth-loopback');

async function begin(complete) {
    const opened = Promise.withResolvers();
    const controller = new AbortController();
    const result = authorize({
        port: 0, authorizeUrl: 'https://example.invalid/authorize',
        timeoutMs: 5000, signal: controller.signal, complete,
        openExternal: url => opened.resolve(new URL(url))
    });
    const authorization = await opened.promise;
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code');
    return { callback, result, controller };
}

test('回调等待连接保存，重复回调无法重用授权码', async () => {
    const received = Promise.withResolvers();
    const saved = Promise.withResolvers();
    const { callback, result } = await begin(function (grant) {
        received.resolve(grant);
        return saved.promise;
    });
    let responseArrived = false;
    const pending = fetch(callback).then(response => { responseArrived = true; return response; });
    const grant = await received.promise;
    assert.equal(grant.redirectUri, callback.origin + callback.pathname);
    assert.equal(grant.code, 'fixture-code');
    assert.ok(grant.verifier);
    const duplicate = await fetch(callback);
    assert.equal(duplicate.status, 400);
    await duplicate.text();
    assert.equal(responseArrived, false);
    saved.resolve({ state: 'connected' });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '工作台已保存授权。请返回工作台验证连接。');
    assert.deepEqual(await result, { state: 'connected' });
});

test('换令牌或保存失败时浏览器显示失败，详细原因交给工作台', async () => {
    const cause = Object.assign(new Error('fixture-secret'), { feishuErrorCode: 20049 });
    const { callback, result } = await begin(async () => { throw cause; });
    const rejection = assert.rejects(result, error => error === cause);
    const response = await fetch(callback);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '工作台未能保存本次授权。飞书错误码 20049。请返回工作台查看原因。');
    await rejection;
});

test('浏览器拒绝授权时结束回调，不发起令牌兑换', async () => {
    const { callback, result } = await begin(() => assert.fail('不应提交授权'));
    const rejection = assert.rejects(result, /浏览器授权未完成/);
    callback.searchParams.delete('code');
    callback.searchParams.set('error', 'access_denied');
    const response = await fetch(callback);
    assert.equal(await response.text(), '授权未完成。请回到工作台。');
    await rejection;
});

test('浏览器仅显示已知飞书权限问题的静态提示', async () => {
    const examples = [
        ['missing_required', '本次授权缺少飞书文档读写权限（docx:document）。'],
        ['missing_scope', '飞书令牌响应中缺少可核对的授权范围。'],
        ['unexpected_scope', '本次授权包含工作台申请范围之外的权限。'],
        ['fixture-sensitive-value', '']
    ];
    for (const [issue, expected] of examples) {
        const cause = Object.assign(new Error('fixture-secret'), { feishuScopeIssue: issue });
        const { callback, result } = await begin(async () => { throw cause; });
        const rejection = assert.rejects(result, error => error === cause);
        const response = await fetch(callback);
        assert.equal(response.status, 500);
        assert.equal(await response.text(), '工作台未能保存本次授权。' + expected + '请返回工作台查看原因。');
        await rejection;
    }
});
