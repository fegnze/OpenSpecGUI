'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { feishuTools, callFeishuTool, WIKI_SCOPE, COMMENT_SCOPE } = require('../src/main/feishu-document-tools');
const { DocumentConnections, parseDocumentId } = require('../src/main/document-connections');

const [read, comment] = feishuTools.map(tool => tool.name);
const docId = 'doxcnExampleDocument1234567';
const wikiId = 'wikcnExampleDocument1234567';
const last = 'doxcnLastContentBlock123456';
const wiki = 'https://example.feishu.cn/wiki/' + wikiId + '?from=from_copylink';
const grantedScopes = ['docx:document', WIKI_SCOPE, COMMENT_SCOPE, 'offline_access'];
const api = 'https://open.feishu.cn/open-apis/';

function makeService(fetch, scopes = grantedScopes) {
    const service = new DocumentConnections({ userDataPath: '.', fetch });
    const record = { accessToken: 'fixture-token', expiresAt: Date.now() + 7200000, grantedScopes: scopes };
    service.read = async () => record;
    service.write = async () => {};
    return { service, record };
}

test('飞书会话解析知识库节点并分段读取 Unicode 文本，验证页也能验证同一链接', async () => {
    const calls = [];
    const { service, record } = makeService((url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        assert.equal(options.redirect, 'error');
        calls.push(url);
        if (url === api + 'wiki/v2/spaces/get_node?token=' + wikiId) { return Response.json({ code: 0, data: { node: { obj_type: 'docx', obj_token: docId } } }); }
        if (url === api + 'docx/v1/documents/' + docId + '/raw_content') { return Response.json({ code: 0, data: { content: '图💡文' } }); }
        assert.equal(url, api + 'docx/v1/documents/' + docId);
        return Response.json({ code: 0, data: { document: { document_id: docId, title: '验证文档' } } });
    });
    assert.equal(parseDocumentId(wiki), wiki.split('?')[0]);
    assert.equal(parseDocumentId('https://example.feishu.cn/docx/' + docId + '?share=1'), docId);
    const first = await callFeishuTool(service, read, { document: wiki, limit: 2 });
    assert.deepEqual(first, { documentId: docId, content: '图💡', offset: 0, nextOffset: 3, totalLength: 4 });
    const rest = await callFeishuTool(service, read, { document: docId, offset: first.nextOffset });
    assert.equal(rest.content, '文');
    assert.equal(rest.nextOffset, null);
    await assert.rejects(callFeishuTool(service, read, { document: 'https://example.feishu.cn.extranet/docx/' + docId }), /飞书域名/);
    assert.equal(calls.length, 3);
    assert.equal((await service.readMetadata('feishu', { ...record, documentId: wiki })).title, '验证文档');
});

test('末尾批注按需读到最后有内容的嵌套块，回执区分受理、块关联和客户端展示', async () => {
    const blank = 'doxcnBlankTrailingBlock';
    const container = 'doxcnQuoteContainer';
    const blocks = {
        [docId]: { block_type: 1, children: ['doxcnUnreadFirst', container, blank] },
        [blank]: { block_type: 2, text: { elements: [{ text_run: { content: ' \u200b\n' } }] } },
        [container]: { block_type: 34, quote_container: {}, children: [last] },
        [last]: { block_type: 2, text: { elements: [{ text_run: { content: '实际文末' } }] } }
    };
    const reads = [];
    const writes = [];
    const { service } = makeService((url, options) => {
        if (url.includes('get_node?')) { return Response.json({ code: 0, data: { node: { obj_type: 'docx', obj_token: docId } } }); }
        if (url.includes('/blocks/')) {
            const id = url.split('/').at(-1);
            reads.push(id);
            assert.ok(blocks[id]);
            return Response.json({ code: 0, data: { block: { block_id: id, ...blocks[id] } } });
        }
        assert.equal(url, api + 'drive/v1/files/' + docId + '/new_comments');
        assert.equal(options.method, 'POST');
        writes.push(JSON.parse(options.body));
        blocks[last].comment_ids = ['104567'];
        return Response.json({ code: 0, data: { comment_id: '104567' } });
    });
    const result = await callFeishuTool(service, comment, { document: wiki, text: '测试 <末尾>', placement: 'document_end' });
    assert.deepEqual(result, { documentId: docId, commentId: '104567', placement: 'document_end', blockId: last,
        blockUrl: wiki.split('?')[0] + '#' + last, blockType: 2, contentState: 'content', creation: 'accepted',
        commentIdOnBlock: 'listed', clientVisibility: 'unverified' });
    assert.deepEqual(reads, [docId, blank, container, last, last]);
    assert.deepEqual(writes[0], { file_type: 'docx', reply_elements: [{ type: 'text', text: '测试 &lt;末尾&gt;' }], anchor: { block_id: last } });
    const whole = await callFeishuTool(service, comment, { document: docId, text: '测试', placement: 'whole_document' });
    assert.deepEqual(whole, { documentId: docId, commentId: '104567', placement: 'whole_document', creation: 'accepted', clientVisibility: 'unverified' });
    assert.equal(writes[1].anchor, undefined);
    assert.equal(reads.length, 5);
});

test('对已有回执只读核对原块，明确空段和当前文末，省略重复读取和文档正文', async () => {
    const blank = 'doxcnTrailingBlankBlock';
    const blocks = {
        [docId]: { block_type: 1, children: [last, blank] },
        [last]: { block_type: 27, image: { token: 'doxcnImageToken' } },
        [blank]: { block_type: 2, text: { elements: [] }, comment_ids: [] }
    };
    const reads = [];
    const { service } = makeService((url, options) => {
        assert.notEqual(options.method, 'POST');
        const id = url.split('/').at(-1);
        assert.ok(blocks[id]);
        reads.push(id);
        return Response.json({ code: 0, data: { block: { block_id: id, ...blocks[id] } } });
    }, ['docx:document']);
    const docUrl = 'https://example.feishu.cn/docx/' + docId;
    const args = { document: docUrl + '?tracking=1#old', inspectComment: { blockId: blank, commentId: '104567' } };
    const result = await callFeishuTool(service, read, args);
    assert.deepEqual(reads, [blank, docId, last]);
    assert.deepEqual(result, { documentId: docId, commentId: '104567', commentIdOnBlock: 'not_listed', clientVisibility: 'unverified',
        anchor: { blockId: blank, blockType: 2, contentState: 'empty_text', blockUrl: docUrl + '#' + blank },
        currentEnd: { blockId: last, blockType: 27, contentState: 'content', blockUrl: docUrl + '#' + last } });
    await assert.rejects(callFeishuTool(service, read, { ...args, offset: 0 }), /省略 offset 和 limit/);
    await assert.rejects(callFeishuTool(service, read, { ...args, inspectComment: { blockId: '../invalid', commentId: '104567' } }), /blockId/);
    assert.equal(reads.length, 3);
});

test('创建成功后读取块失败仍交付已受理回执，含提及的段落可锚定且只写入一次', async () => {
    let writes = 0;
    const { service } = makeService((url, options) => {
        if (options.method === 'POST') { writes++; return Response.json({ code: 0, data: { comment_id: '12345678' } }); }
        if (url.endsWith('/blocks/' + docId)) { return Response.json({ code: 0, data: { block: { block_id: docId, block_type: 1, children: [last] } } }); }
        if (writes) { return Response.json({ code: 99991677 }, { status: 401 }); }
        return Response.json({ code: 0, data: { block: { block_id: last, block_type: 12, bullet: { elements: [{ mention_user: { user_id: 'ou_123' } }] } } } });
    });
    const result = await callFeishuTool(service, comment, { document: docId, text: '测试', placement: 'document_end' });
    assert.equal(result.creation, 'accepted');
    assert.equal(result.commentIdOnBlock, 'unavailable');
    assert.equal(result.blockUrl, undefined);
    assert.equal(writes, 1);
});

test('旧文档授权可读 docx，缺少 scope、无锚点、不支持的知识库对象时给出可操作的失败结果', async () => {
    let writes = 0;
    const { service, record } = makeService((url, options) => {
        if (options.method === 'POST') { writes++; }
        if (url.endsWith('/raw_content')) { return Response.json({ code: 0, data: { content: '旧授权可读' } }); }
        if (url.includes('get_node?')) { return Response.json({ code: 0, data: { node: { obj_token: docId, obj_type: 'sheet' } } }); }
        return Response.json({ code: 0, data: { block: { block_id: docId, block_type: 1, children: [] } } });
    }, ['docx:document']);
    assert.equal((await callFeishuTool(service, read, { document: docId })).content, '旧授权可读');
    await assert.rejects(callFeishuTool(service, read, { document: wiki }), /wiki:node:read/);
    await assert.rejects(callFeishuTool(service, comment, { document: docId, text: '测试', placement: 'document_end' }), /docs:document.comment:create/);
    assert.match((await service.status('feishu', { feishuDocumentTools: true })).message, /重新授权/);
    record.grantedScopes = grantedScopes;
    await assert.rejects(callFeishuTool(service, comment, { document: docId, text: '测试', placement: 'document_end' }), /末尾内容块/);
    await assert.rejects(callFeishuTool(service, read, { document: wiki }), /其他类型/);
    assert.equal(writes, 0);
});

test('飞书 3.0 令牌兑换及刷新核对 wiki 和评论范围，业务响应不确定时不重放写入', async () => {
    let exchanges = 0;
    let writes = 0;
    let issuedScopes = grantedScopes;
    const { service, record } = makeService((url, options) => {
        if (url.endsWith('/token')) {
            exchanges++;
            const fields = options.headers['Content-Type'].startsWith('application/json') ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body));
            assert.equal(fields.scope, grantedScopes.join(' '));
            return Response.json({ access_token: 'new', refresh_token: 'refreshed', token_type: 'Bearer', expires_in: 7200, scope: issuedScopes.join(' ') });
        }
        writes++;
        if (writes === 1) { return Response.json({ code: 99991677 }, { status: 400 }); }
        return Response.json({ code: 1069302, msg: 'secret-token' }, { status: 400 });
    });
    await service.exchange('feishu', record, { grant_type: 'authorization_code', code: 'code' }, undefined, { feishuDocumentTools: true });
    await assert.rejects(callFeishuTool(service, comment, { document: docId, text: '测试', placement: 'whole_document' }),
        error => /HTTP 400/.test(error.message) && !error.message.includes('secret-token'));
    assert.equal(exchanges, 2);
    assert.equal(writes, 2);
    issuedScopes = ['docx:document'];
    await assert.rejects(service.exchange('feishu', record, { grant_type: 'authorization_code', code: 'code' }, undefined, { feishuDocumentTools: true }),
        /wiki:node:read.*docs:document.comment:create/);
});

test('评论响应在传输中丢失时仅提交一次，并提示核对远端结果', async () => {
    let writes = 0;
    const { service } = makeService(() => { writes++; throw new Error('socket closed'); });
    await assert.rejects(callFeishuTool(service, comment, { document: docId, text: '测试', placement: 'whole_document' }), /核对评论/);
    assert.equal(writes, 1);
});
