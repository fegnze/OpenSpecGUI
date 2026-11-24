'use strict';

var crypto = require('node:crypto');
var http = require('node:http');

var CALLBACK_PATH = '/oauth/callback';
var scopeIssues = new Map([
    ['missing_required', '本次授权缺少飞书文档读写权限（docx:document）。'],
    ['missing_readonly', '本次授权缺少旧版本所需的飞书文档只读权限。'],
    ['missing_scope', '飞书令牌响应中缺少可核对的授权范围。'],
    ['unexpected_scope', '本次授权包含工作台申请范围之外的权限。']
]);

/** 为浏览器保留接收最终结果的机会，同时限制异常客户端占用回调端口的时间。 */
async function finishResponse(res, status, message) {
    var socket = res.socket;
    if (!socket || socket.destroyed) { return; }
    var closed = new Promise(function (resolve) { socket.once('close', resolve); });
    var deadline = setTimeout(function () { socket.destroy(); }, 1000);
    try {
        res.setHeader('Connection', 'close');
        res.writeHead(status).end(message);
        await closed;
    } finally { clearTimeout(deadline); }
}

/** 接收一次带 state 的回调，调用 complete 兑换并保存授权，再向浏览器反馈结果。 */
async function authorize(options) {
    var state = crypto.randomBytes(32).toString('base64url');
    var verifier = crypto.randomBytes(48).toString('base64url');
    var challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    var acceptCallback;
    var rejectCallback;
    var callback = new Promise(function (resolve, reject) { acceptCallback = resolve; rejectCallback = reject; });
    var consumed = false;
    var host;
    var callbackPath = options.callbackPath || CALLBACK_PATH;
    var server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, function (req, res) {
        var url;
        try { url = new URL(req.url, 'http://' + host); } catch (error) { res.writeHead(400).end(); return; }
        var valid = req.method === 'GET' && req.headers.host === host && url.origin === 'http://' + host && url.pathname === callbackPath &&
            url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        if (!valid || consumed) { res.writeHead(400).end('无效的授权回调。'); return; }
        consumed = true;
        var code = url.searchParams.get('code');
        if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096) {
            code = null;
        }
        acceptCallback({ code: code, response: res });
    });
    var signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    var cancel = function () { rejectCallback(signal.reason); };
    try {
        await new Promise(function (resolve, reject) {
            server.once('error', function () { reject(new Error('无法打开本机回调端口，请关闭占用此端口的程序后重试。')); });
            server.listen(options.port, '127.0.0.1', resolve);
        });
        host = '127.0.0.1:' + server.address().port;
        var redirectUri = 'http://' + host + callbackPath;
        var url = new URL(options.authorizeUrl);
        Object.entries(Object.assign({}, options.params, {
            response_type: 'code', state: state, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirectUri
        })).forEach(function (pair) { url.searchParams.set(pair[0], pair[1]); });
        signal.throwIfAborted();
        signal.addEventListener('abort', cancel, { once: true });
        var reply;
        try {
            Promise.resolve().then(function () { return options.openExternal(url.href); }).catch(function () {
                rejectCallback(new Error('无法打开系统浏览器，请检查默认浏览器后重试。'));
            });
            reply = await callback;
        } finally {
            signal.removeEventListener('abort', cancel);
        }
        if (!reply.code) {
            await finishResponse(reply.response, 200, '授权未完成。请回到工作台。');
            throw new Error('浏览器授权未完成，请重试。');
        }
        var result;
        try {
            signal.throwIfAborted();
            result = await options.complete({ code: reply.code, verifier: verifier, redirectUri: redirectUri }, signal);
        } catch (error) {
            var detail = Number.isSafeInteger(error?.feishuErrorCode) && error.feishuErrorCode > 0
                ? '飞书错误码 ' + error.feishuErrorCode + '。' : '';
            var scopeDetail = scopeIssues.get(error?.feishuScopeIssue) || '';
            await finishResponse(reply.response, 500, '工作台未能保存本次授权。' + detail + scopeDetail + '请返回工作台查看原因。');
            throw error;
        }
        await finishResponse(reply.response, 200, '工作台已保存授权。请返回工作台验证连接。');
        return result;
    } finally {
        server.close();
        server.closeAllConnections();
    }
}

module.exports = { authorize: authorize, callbackPath: CALLBACK_PATH };
