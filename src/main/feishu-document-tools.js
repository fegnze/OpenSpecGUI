'use strict';

const API = 'https://open.feishu.cn/open-apis/';
const WIKI_SCOPE = 'wiki:node:read';
const COMMENT_SCOPE = 'docs:document.comment:create';
const READ = 'workbench_feishu_read_document';
const COMMENT = 'workbench_feishu_add_comment';
const documentArgument = { type: 'string', description: '飞书 /docx/ 或 /wiki/ 链接，或新版文档 ID。', maxLength: 4096 };
const validToken = value => typeof value === 'string' && /^[a-zA-Z0-9]{10,80}$/.test(value);
const basicReadTool = { name: READ, description: '读取飞书新版文档纯文本，长文按 nextOffset 接着读取。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['document'], properties: {
        document: { ...documentArgument, description: '飞书 /docx/ 链接或新版文档 ID。' },
        offset: { type: 'integer', minimum: 0, description: '上一段返回的 nextOffset，首段可省略。' },
        limit: { type: 'integer', minimum: 1, maximum: 16000 } } } };
const feishuTools = [
    { name: READ, description: '读取飞书文档纯文本，长文按 nextOffset 接着读取。传 inspectComment 可只读核对已有文末批注的块、评论 ID 和当前文末位置。',
        inputSchema: { ...basicReadTool.inputSchema, properties: { ...basicReadTool.inputSchema.properties, document: documentArgument,
            inspectComment: { type: 'object', additionalProperties: false, required: ['blockId', 'commentId'],
                description: '按已有回执核对锚点，与 offset、limit 互斥。', properties: {
                    blockId: { type: 'string', pattern: '^[a-zA-Z0-9]{10,80}$' }, commentId: { type: 'string', minLength: 1, maxLength: 256 }
                } } } } },
    { name: COMMENT, description: '在飞书新版文档写入评论。document_end 从尾部寻找有内容的段落或媒体块，whole_document 创建全文评论。回执分别报告飞书 API 受理、块上评论 ID 核对和客户端展示状态。',
        inputSchema: { type: 'object', additionalProperties: false, required: ['document', 'text', 'placement'],
            properties: { document: documentArgument, text: { type: 'string', minLength: 1, maxLength: 10000 },
                placement: { type: 'string', enum: ['document_end', 'whole_document'] } } } }
];

/** 将链接规范化。保留 wiki 类型，分享链接的跟踪参数不参与请求或存储。 */
function parseDocumentId(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    if (validToken(input)) { return input; }
    if (input.length <= 4096 && input.startsWith('https://')) {
        let url;
        try { url = new URL(input); } catch { throw new Error('飞书文档链接无效。'); }
        if (url.username || url.password || url.port || !/(^|\.)feishu\.cn$/.test(url.hostname)) {
            throw new Error('请输入飞书域名下的 docx 或 wiki 文档链接。');
        }
        const match = /^\/(docx|wiki)\/([a-zA-Z0-9]{10,80})\/?$/.exec(url.pathname);
        if (match) { return match[1] === 'docx' ? match[2] : url.origin + '/wiki/' + match[2]; }
    }
    throw new Error('请输入飞书新版文档 ID、/docx/ 链接或 /wiki/ 链接。');
}

function requireScope(record, scope) {
    if (record.grantedScopes?.includes(scope)) { return; }
    const message = scope === WIKI_SCOPE ? '当前授权缺少知识库节点读取权限。可改用 /docx/ 链接，或在飞书应用开通 ' + scope + ' 后，在工作台重新授权。' :
        '当前授权缺少创建评论权限。请在飞书应用开通 ' + scope + ' 并发布，然后在工作台重新授权。';
    throw new Error(message);
}

async function resolveDocument(connections, record, reference, signal) {
    signal?.throwIfAborted();
    if (validToken(reference)) { return reference; }
    requireScope(record, WIKI_SCOPE);
    const nodeToken = new URL(reference).pathname.slice('/wiki/'.length);
    const response = await connections.request(API + 'wiki/v2/spaces/get_node?token=' + nodeToken, {
        headers: { Authorization: 'Bearer ' + record.accessToken }, signal
    });
    const node = response.data?.node;
    if (!node || !validToken(node.obj_token)) { throw new Error('飞书未返回知识库节点关联的文档。'); }
    if (node.obj_type !== 'docx') { throw new Error('该知识库节点指向其他类型的文件，目前工具支持新版文档（docx）。'); }
    return node.obj_token;
}

/** 文本需有可显示的文字或内联对象。布局块由其子块提供正文。 */
function contentState(block) {
    const textKey = Object.keys(block).find(key => /^(text|heading[1-9]|bullet|ordered|code|quote|equation|todo|agenda_item_title)$/.test(key));
    if (textKey) {
        const elements = block[textKey]?.elements ?? [];
        if (!Array.isArray(elements)) { throw new Error('飞书返回的文档块文本结构异常。'); }
        const nonempty = elements.some(item => /[^\s\u200b\ufeff]/u.test(item?.text_run?.content || '') ||
            item?.mention_user?.user_id || item?.mention_doc?.token || item?.reminder?.expire_time || item?.equation?.content?.trim() ||
            item?.inline_block?.block_id || item?.file?.file_token || item?.link_preview?.url);
        return nonempty ? 'content' : 'empty_text';
    }
    const media = block.image?.token || block.file?.token || block.board?.token || block.sheet?.token ||
        block.bitable?.token || block.mindnote?.token || block.iframe?.component?.url || block.link_preview?.url || block.chat_card?.chat_id;
    return media ? 'content' : 'container_or_unsupported';
}

async function getBlock(connections, documentId, blockId, headers, signal) {
    signal?.throwIfAborted();
    if (!validToken(blockId)) { throw new Error('飞书返回了无效的文档块标识。'); }
    const response = await connections.request(API + 'docx/v1/documents/' + documentId + '/blocks/' + blockId, { headers, signal });
    const block = response.data?.block;
    if (block?.block_id !== blockId || !Number.isInteger(block.block_type) ||
        (block.children !== undefined && !Array.isArray(block.children))) { throw new Error('飞书返回的文档块结构异常。'); }
    return block;
}

/** 逆序按需遍历，找到最后一个有内容的子块后即停止。 */
async function lastContentBlock(documentId, readBlock) {
    const seen = new Set();
    async function visit(id) {
        if (seen.has(id)) { throw new Error('飞书返回了重复的文档块标识。'); }
        seen.add(id);
        const block = await readBlock(id);
        if (id === documentId && block.block_type !== 1) { throw new Error('飞书返回的文档根块类型异常。'); }
        const children = block.children || [];
        for (let i = children.length - 1; i >= 0; i--) {
            const found = await visit(children[i]);
            if (found) { return found; }
        }
        return id !== documentId && contentState(block) === 'content' ? block : null;
    }
    return visit(documentId);
}

function blockLocation(document, block) {
    if (!block) { return null; }
    const location = { blockId: block.block_id, blockType: block.block_type, contentState: contentState(block) };
    if (!validToken(document.trim())) {
        const url = new URL(document.trim());
        location.blockUrl = url.origin + url.pathname.replace(/\/$/, '') + '#' + block.block_id;
    }
    return location;
}

function commentOnBlock(block, commentId) {
    if (!Array.isArray(block.comment_ids)) { return 'unavailable'; }
    return block.comment_ids.includes(commentId) ? 'listed' : 'not_listed';
}

/** 仅将参数转为固定的飞书 OpenAPI 路径，返回内容与位置来自厂商结果。 */
async function callFeishuTool(connections, name, args, signal) {
    const tool = feishuTools.find(item => item.name === name);
    if (!tool || !args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) { throw new Error('无效的飞书工具或参数。'); }
    const reference = parseDocumentId(args.document);
    const offset = args.offset === undefined ? 0 : args.offset;
    const limit = args.limit === undefined ? 6000 : args.limit;
    const inspection = args.inspectComment;
    if (name === COMMENT) {
        if (!['document_end', 'whole_document'].includes(args.placement)) { throw new Error('请指定 document_end（文档末尾）或 whole_document（全文评论）。'); }
        if (typeof args.text !== 'string' || !args.text.trim() || Array.from(args.text).length > 10000) { throw new Error('请输入 1 至 10000 字符的评论。'); }
    } else if (Object.hasOwn(args, 'inspectComment')) {
        if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection) ||
            Object.keys(inspection).some(key => !['blockId', 'commentId'].includes(key)) || !validToken(inspection.blockId) ||
            typeof inspection.commentId !== 'string' || !inspection.commentId.trim() || inspection.commentId.length > 256 ||
            Object.hasOwn(args, 'offset') || Object.hasOwn(args, 'limit')) { throw new Error('核对已有批注需要回执中的 blockId、commentId，请省略 offset 和 limit。'); }
    } else if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000) {
        throw new Error('读取范围无效，请使用上一段返回的 nextOffset 以及 1 至 16000 的 limit。');
    }
    return connections.withAccessToken('feishu', async record => {
        if (name === COMMENT) { requireScope(record, COMMENT_SCOPE); }
        const documentId = await resolveDocument(connections, record, reference, signal);
        signal?.throwIfAborted();
        const headers = { Authorization: 'Bearer ' + record.accessToken };
        const readBlock = id => getBlock(connections, documentId, id, headers, signal);
        if (inspection) {
            const original = await readBlock(inspection.blockId);
            const current = await lastContentBlock(documentId, id => id === original.block_id ? original : readBlock(id));
            return { documentId, commentId: inspection.commentId, anchor: blockLocation(args.document, original),
                commentIdOnBlock: commentOnBlock(original, inspection.commentId), currentEnd: blockLocation(args.document, current),
                clientVisibility: 'unverified' };
        }
        if (name === READ) {
            const response = await connections.request(API + 'docx/v1/documents/' + documentId + '/raw_content', { headers, signal });
            const content = response.data?.content;
            if (typeof content !== 'string') { throw new Error('飞书未返回文档纯文本。'); }
            if (offset > content.length || /[\uDC00-\uDFFF]/.test(content.charAt(offset))) { throw new Error('当前文档的读取起点无效，请从首段重新读取。'); }
            let end = Math.min(offset + limit, content.length);
            if (/[\uDC00-\uDFFF]/.test(content.charAt(end))) { end++; }
            return { documentId, content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalLength: content.length };
        }
        const plainText = args.text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const body = { file_type: 'docx', reply_elements: [{ type: 'text', text: plainText }] };
        let anchor;
        if (args.placement === 'document_end') {
            anchor = await lastContentBlock(documentId, readBlock);
            if (!anchor) { throw new Error('文档没有可定位的末尾内容块，未写入批注。'); }
            body.anchor = { block_id: anchor.block_id };
        }
        // 飞书官方 lark-cli drive +add-comment 采用此接口。anchor 指向内容块。
        signal?.throwIfAborted();
        let response;
        try {
            response = await connections.request(API + 'drive/v1/files/' + documentId + '/new_comments', {
                method: 'POST', signal, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body)
            });
        } catch (error) {
            if (signal?.aborted || ['PROVIDER_NETWORK_ERROR', 'PROVIDER_RESPONSE_INVALID', 'PROVIDER_SERVER_ERROR'].includes(error.code)) {
                throw new Error('未收到可确认的评论写入结果，请先在文档中核对评论再决定是否重试。');
            }
            throw error;
        }
        const commentId = response.data?.comment_id;
        if (typeof commentId !== 'string' || !commentId) { throw new Error('飞书未返回评论 ID，请先在文档中核对写入结果。'); }
        const receipt = { documentId, commentId, placement: args.placement, creation: 'accepted', clientVisibility: 'unverified' };
        if (anchor) {
            Object.assign(receipt, blockLocation(args.document, anchor));
            // 已取得创建回执。只读回一次；核对失败仍返回已受理的回执，避免重放 POST。
            try { receipt.commentIdOnBlock = commentOnBlock(await readBlock(anchor.block_id), commentId); }
            catch { receipt.commentIdOnBlock = 'unavailable'; }
        }
        return receipt;
    });
}

module.exports = { feishuTools, basicReadTool, callFeishuTool, parseDocumentId, resolveDocument, WIKI_SCOPE, COMMENT_SCOPE };
