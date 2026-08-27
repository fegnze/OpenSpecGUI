'use strict';

var path = require('node:path');

var SCHEME = 'openspec-initiative-app';
var MAX_ACTION_BODY_BYTES = 16 * 1024;
var CHANGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
var INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
var CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'"
].join('; ');
var MIME_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
});

function responseHeaders(contentType) {
    return {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Content-Type': contentType || 'text/plain; charset=utf-8',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
    };
}

function textResponse(status, message) {
    return new Response(message, { status: status, headers: responseHeaders('text/plain; charset=utf-8') });
}

function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), { status: status, headers: responseHeaders('application/json; charset=utf-8') });
}

function rawPathname(requestUrl) {
    var match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(requestUrl);
    return match ? (match[1] || '/') : '';
}

function rawAuthority(requestUrl) {
    var match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(requestUrl);
    return match ? match[1] : '';
}

function decodeStaticPath(requestUrl) {
    var rawPath = rawPathname(requestUrl);
    var decoded;
    var segments;
    if (!rawPath || rawPath.indexOf('\\') !== -1 || /%(?:2f|5c)/i.test(rawPath)) {
        throw new Error('静态路径格式无效');
    }
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (error) {
        throw new Error('静态路径编码无效');
    }
    if (decoded.indexOf('\0') !== -1 || decoded.indexOf('\\') !== -1 || decoded.charAt(0) !== '/') {
        throw new Error('静态路径格式无效');
    }
    segments = decoded.slice(1).split('/');
    if (segments.some(function (segment) { return !segment || segment === '.' || segment === '..'; })) {
        throw new Error('静态路径格式无效');
    }
    return segments.join('/');
}

function contentTypeFor(relativePath) {
    return MIME_TYPES[path.extname(relativePath).toLowerCase()] || '';
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(label + '必须是普通对象');
    }
    return value;
}

async function readActionPayload(request) {
    var contentType = request.headers.get('content-type') || '';
    var lengthHeader = request.headers.get('content-length');
    var declaredLength = lengthHeader ? Number(lengthHeader) : 0;
    var chunks = [];
    var total = 0;
    var reader;
    var result;
    var buffer;
    var value;
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new Error('动作 Content-Type 无效');
    }
    if (lengthHeader && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_ACTION_BODY_BYTES)) {
        throw new Error('动作 payload 超过限制');
    }
    if (request.body) {
        reader = request.body.getReader();
        while (true) {
            result = await reader.read();
            if (result.done) {
                break;
            }
            total += result.value.byteLength;
            if (total > MAX_ACTION_BODY_BYTES) {
                try { await reader.cancel(); } catch (error) { /* Request is already rejected. */ }
                throw new Error('动作 payload 超过限制');
            }
            chunks.push(Buffer.from(result.value));
        }
    }
    buffer = Buffer.concat(chunks, total);
    try {
        value = JSON.parse(buffer.toString('utf8'));
    } catch (error) {
        throw new Error('动作 payload 不是有效 JSON');
    }
    return assertPlainObject(value, '动作 payload');
}

function EmbeddedInitiativeAppProtocol(options) {
    this.service = options.service;
    this.shell = options.shell;
    this.instances = new Map();
}

EmbeddedInitiativeAppProtocol.prototype.register = function (instance) {
    if (!instance || !INSTANCE_ID_PATTERN.test(instance.id) || !(instance.files instanceof Map)) {
        throw new Error('独立应用协议实例无效');
    }
    if (this.instances.has(instance.id)) {
        throw new Error('独立应用协议实例重复');
    }
    this.instances.set(instance.id, instance);
};

EmbeddedInitiativeAppProtocol.prototype.unregister = function (instanceId) {
    this.instances.delete(instanceId);
};

EmbeddedInitiativeAppProtocol.prototype.assertCurrentInstance = function (instance) {
    if (!instance || this.instances.get(instance.id) !== instance) {
        var error = new Error('独立应用实例已失效');
        error.code = 'STALE_APP_INSTANCE';
        throw error;
    }
};

EmbeddedInitiativeAppProtocol.prototype.dispatchAction = async function (instance, actionId, request) {
    this.assertCurrentInstance(instance);
    var payload = await readActionPayload(request);
    var keys = Object.keys(payload);
    if (actionId !== 'openspec.open-change' || keys.length !== 1 || keys[0] !== 'changeId' || typeof payload.changeId !== 'string' || !CHANGE_ID_PATTERN.test(payload.changeId)) {
        return jsonResponse(400, { ok: false, error: 'INVALID_ACTION_PAYLOAD' });
    }
    this.assertCurrentInstance(instance);
    var target = await this.service.resolveChangeDirectory({
        projectId: instance.projectId,
        revision: instance.revision,
        changeId: payload.changeId
    });
    this.assertCurrentInstance(instance);
    this.shell.showItemInFolder(target);
    return jsonResponse(200, { ok: true });
};

EmbeddedInitiativeAppProtocol.prototype.handle = async function (request) {
    var requestUrl;
    var instance;
    var relativePath;
    var actionId;
    try {
        requestUrl = new URL(request.url);
    } catch (error) {
        return textResponse(400, 'Bad request');
    }
    if (requestUrl.protocol !== SCHEME + ':' || !INSTANCE_ID_PATTERN.test(requestUrl.hostname) || requestUrl.username || requestUrl.password || requestUrl.port || rawAuthority(request.url) !== requestUrl.hostname) {
        return textResponse(404, 'Not found');
    }
    instance = this.instances.get(requestUrl.hostname);
    if (!instance) {
        return textResponse(404, 'Not found');
    }
    try {
        relativePath = decodeStaticPath(request.url);
    } catch (error) {
        return textResponse(404, 'Not found');
    }
    actionId = instance.actions['/' + relativePath];
    if (actionId) {
        if (request.method !== 'POST') {
            return textResponse(405, 'Method not allowed');
        }
        try {
            return await this.dispatchAction(instance, actionId, request);
        } catch (error) {
            return jsonResponse(error.code === 'STALE_WORKSPACE' || error.code === 'STALE_APP_INSTANCE' ? 409 : (error.code === 'CHANGE_NOT_FOUND' ? 404 : 400), {
                ok: false,
                error: error.code || 'INVALID_ACTION_REQUEST'
            });
        }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse(405, 'Method not allowed');
    }
    if (!instance.files.has(relativePath)) {
        return textResponse(404, 'Not found');
    }
    var contentType = contentTypeFor(relativePath);
    if (!contentType) {
        return textResponse(415, 'Unsupported media type');
    }
    return new Response(request.method === 'HEAD' ? null : instance.files.get(relativePath), {
        status: 200,
        headers: responseHeaders(contentType)
    });
};

module.exports = {
    CONTENT_SECURITY_POLICY: CONTENT_SECURITY_POLICY,
    EmbeddedInitiativeAppProtocol: EmbeddedInitiativeAppProtocol,
    INSTANCE_ID_PATTERN: INSTANCE_ID_PATTERN,
    MAX_ACTION_BODY_BYTES: MAX_ACTION_BODY_BYTES,
    MIME_TYPES: MIME_TYPES,
    SCHEME: SCHEME,
    contentTypeFor: contentTypeFor,
    decodeStaticPath: decodeStaticPath,
    readActionPayload: readActionPayload,
    rawAuthority: rawAuthority,
    responseHeaders: responseHeaders
};
