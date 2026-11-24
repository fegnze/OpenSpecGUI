'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CvMcpConnection, ENDPOINT } = require('../src/main/cv-mcp-connection');

const fixtureToken = 'test-mcp-bearer';
const protocol = '2025-06-18';
const session = 'fixture-session';
const initialize = { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '4.0' } };

function fakeStorage() {
    const records = new Map();
    return {
        isEncryptionAvailable: () => true,
        encryptString(value) {
            const handle = Buffer.from('fixture-keychain-' + records.size);
            records.set(handle.toString(), value);
            return handle;
        },
        decryptString(handle) {
            if (!records.has(handle.toString())) { throw new Error('unknown fixture key'); }
            return records.get(handle.toString());
        }
    };
}

function rpc(id, result, type, headers = {}) {
    const envelope = JSON.stringify({ jsonrpc: '2.0', id, result });
    if (type === 'application/json') { return new Response(envelope, { headers: { 'Content-Type': type, ...headers } }); }
    const data = [': keepalive\r\n\r\n', 'data: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n',
        'event: message\r\ndata: ' + envelope, '\r\n', '\r\n'];
    const stream = new ReadableStream({
        start(controller) {
            for (const fragment of data) { controller.enqueue(new TextEncoder().encode(fragment)); }
            controller.close();
        }
    });
    return new Response(stream, { headers: { 'Content-Type': type, ...headers } });
}

async function setup(t, request, storage = fakeStorage()) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-cv-connection-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const open = () => new CvMcpConnection({ userDataPath: dir, safeStorage: storage, fetch: request });
    return { open, connection: open() };
}

for (const format of ['application/json', 'text/event-stream']) {
    test(format + ' 握手传递协商版本和会话，凭据保存在系统存储，失败后清除验证结果', async t => {
        const calls = [];
        let denied = false;
        const request = async (url, init) => {
            assert.equal(url, ENDPOINT);
            assert.equal(init.redirect, 'error');
            const headers = new Headers(init.headers);
            assert.equal(headers.get('authorization'), 'Bearer ' + fixtureToken);
            const body = init.body ? JSON.parse(init.body) : {};
            calls.push(body.method || init.method);
            if (denied) { return new Response('Unauthorized ' + fixtureToken, { status: 401 }); }
            if (body.method === 'initialize') {
                assert.equal(headers.get('mcp-session-id'), null);
                return rpc(body.id, initialize, format, { 'Mcp-Session-Id': session });
            }
            assert.equal(headers.get('mcp-session-id'), session);
            assert.equal(headers.get('mcp-protocol-version'), protocol);
            if (body.method === 'notifications/initialized') { return new Response(null, { status: 202 }); }
            if (body.method === 'tools/list') { return rpc(body.id, { tools: [{ name: 'fixture_read' }] }, format); }
            assert.equal(init.method, 'DELETE');
            return new Response(null, { status: 204 });
        };
        const { connection, open } = await setup(t, request);
        assert.equal((await connection.status()).state, 'disconnected');
        const connected = await connection.connect({ token: fixtureToken });
        assert.equal(connected.state, 'connected');
        assert.ok(!JSON.stringify(connected).includes(fixtureToken));
        const record = await fs.readFile(connection.file, 'utf8');
        assert.ok(!record.includes(fixtureToken));
        assert.notEqual(Buffer.from(JSON.parse(record).secret, 'base64').toString(), fixtureToken);
        const verified = await open().verify();
        assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
        assert.equal(verified.state, 'verified');
        assert.equal(verified.serverVersion, '4.0');
        assert.deepEqual(verified.toolNames, ['fixture_read']);
        assert.ok(!JSON.stringify(verified).includes(fixtureToken));
        assert.ok(!JSON.stringify(verified).includes(session));
        denied = true;
        await assert.rejects(connection.verify(), error => error.message.includes('401') && !error.message.includes(fixtureToken));
        const later = await open().status();
        assert.equal(later.state, 'connected');
        assert.deepEqual(later.toolNames, []);
        assert.equal((await connection.disconnect()).state, 'disconnected');
        await assert.rejects(fs.stat(connection.file), { code: 'ENOENT' });
    });
}

test('系统无法保护凭据时拒绝保存，服务端协议不兼容时不报告已验证', async t => {
    let requests = 0;
    const deniedStorage = { ...fakeStorage(), getSelectedStorageBackend: () => 'basic_text' };
    const insecure = await setup(t, () => { requests++; }, deniedStorage);
    await assert.rejects(insecure.connection.connect({ token: fixtureToken }), /加密存储/);
    assert.equal((await insecure.connection.status()).state, 'disconnected');
    assert.equal(requests, 0);
    const incompatible = await setup(t, async () => {
        requests++;
        return rpc(1, { ...initialize, protocolVersion: 'unsupported' }, 'application/json');
    });
    await incompatible.connection.connect({ token: fixtureToken });
    await assert.rejects(incompatible.connection.verify(), /MCP/);
    assert.equal(requests, 1);
    assert.equal((await incompatible.connection.status()).state, 'connected');
});

test('无工具能力的无状态服务无需建会话或调用 tools/list', async t => {
    const methods = [];
    const { connection } = await setup(t, async (_, init) => {
        const body = JSON.parse(init.body);
        methods.push(body.method);
        if (body.method === 'initialize') { return rpc(1, { ...initialize, capabilities: {} }, 'application/json'); }
        if (body.method === 'notifications/initialized') { return new Response(null, { status: 202 }); }
        throw new Error('unexpected ' + body.method);
    });
    await connection.connect({ token: fixtureToken });
    assert.deepEqual((await connection.verify()).toolNames, []);
    assert.deepEqual(methods, ['initialize', 'notifications/initialized']);
});

test('服务元数据误带当前凭据时，仅保留能安全展示的工具信息', async t => {
    const { connection } = await setup(t, async (_, init) => {
        const body = JSON.parse(init.body);
        if (body.method === 'initialize') {
            return rpc(body.id, { ...initialize, serverInfo: { name: 'fixture', version: 'v1 ' + fixtureToken } }, 'application/json');
        }
        if (body.method === 'notifications/initialized') { return new Response(null, { status: 202 }); }
        return rpc(body.id, { tools: [{ name: fixtureToken }, { name: 'reader' }] }, 'application/json');
    });
    await connection.connect({ token: fixtureToken });
    const status = await connection.verify();
    assert.equal(status.state, 'verified');
    assert.equal(status.serverVersion, '');
    assert.deepEqual(status.toolNames, ['reader']);
    assert.ok(!JSON.stringify(status).includes(fixtureToken));
    assert.ok(!(await fs.readFile(connection.file, 'utf8')).includes(fixtureToken));
});
