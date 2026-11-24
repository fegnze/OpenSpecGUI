'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { listen } = require('../src/main/document-tool-broker');
const { callFeishuTool } = require('../src/main/feishu-document-tools');

test('宿主停止调用时，等待定位的文末批注不会继续提交', { timeout: 10000 }, async t => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'document-tool-cancel-'));
    t.after(() => fs.rm(data, { recursive: true, force: true }));
    const entered = Promise.withResolvers();
    const done = Promise.withResolvers();
    const closed = Promise.withResolvers();
    let writes = 0;
    const driver = {
        withAccessToken: (_provider, operation) => operation({ accessToken: 'fixture', grantedScopes: ['docs:document.comment:create'] }),
        async request(_url, options) {
            if (options.method === 'POST') { writes++; return { data: { comment_id: 'fixture' } }; }
            entered.resolve();
            await closed.promise;
            return { data: { block: { block_type: 1, block_id: 'ExampleDoc123', children: ['ExampleBlock123'] } } };
        }
    };
    const server = await listen(data, async (_host, input, signal) => {
        signal.addEventListener('abort', closed.resolve, { once: true });
        try { return await callFeishuTool(driver, 'workbench_feishu_add_comment', input.arguments, signal); }
        finally { done.resolve(); }
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const socket = server.address();
    assert.equal(typeof socket, 'string');
    assert.equal((await fs.stat(path.dirname(socket))).mode & 0o777, 0o700);
    const request = http.request({ socketPath: socket, method: 'POST', path: '/call' });
    request.on('error', () => {});
    request.end(JSON.stringify({ host: 'dsh', input: { arguments: { document: 'ExampleDoc123', placement: 'document_end', text: '测试' } } }));
    await entered.promise;
    request.destroy();
    await done.promise;
    assert.equal(writes, 0);
});
