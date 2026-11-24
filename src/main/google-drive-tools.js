'use strict';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FIELDS = 'id,name,mimeType,modifiedTime,webViewLink';
const fileId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,256}$' };

const googleDriveTools = [
    {
        name: 'google_drive_list_files',
        description: '列出 Google Drive 文件元数据，可按名称前缀或父文件夹筛选，使用 nextPageToken 翻页。',
        inputSchema: {
            type: 'object', additionalProperties: false, properties: {
                name: { type: 'string', minLength: 1, maxLength: 256, description: '文件名称前缀' },
                folderId: { ...fileId, description: '要列出直接子项的文件夹 ID' },
                pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                pageToken: { type: 'string', minLength: 1, maxLength: 4096 }
            }
        }
    },
    {
        name: 'google_drive_get_file',
        description: '用文件 ID 获取 Google Drive 文件的名称、类型、修改时间和可用的浏览链接。',
        inputSchema: { type: 'object', additionalProperties: false, required: ['fileId'], properties: { fileId } }
    }
];

function validId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

function checkedText(value, limit, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error('Google Drive ' + label + '无效。');
    }
    return value;
}

function listUrl(args) {
    const url = new URL(DRIVE_FILES);
    const query = ['trashed = false'];
    if (args.folderId !== undefined) {
        if (!validId(args.folderId)) { throw new Error('Google Drive 文件夹 ID 无效。'); }
        query.push("'" + args.folderId + "' in parents");
    }
    if (args.name !== undefined) {
        const name = checkedText(args.name, 256, '名称');
        query.push("name contains '" + name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    }
    const size = args.pageSize === undefined ? 25 : args.pageSize;
    if (!Number.isInteger(size) || size < 1 || size > 100) { throw new Error('每页可读取 1 至 100 条元数据。'); }
    url.searchParams.set('q', query.join(' and '));
    url.searchParams.set('fields', 'nextPageToken,files(' + FIELDS + ')');
    url.searchParams.set('pageSize', String(size));
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (args.pageToken !== undefined) { url.searchParams.set('pageToken', checkedText(args.pageToken, 4096, '翻页标记')); }
    return url;
}

function metadata(data) {
    if (!data || !validId(data.id) || typeof data.name !== 'string' || typeof data.mimeType !== 'string') {
        throw new Error('Google Drive 没有返回有效的文件元数据。');
    }
    const result = { id: data.id, name: data.name, mimeType: data.mimeType };
    if (typeof data.modifiedTime === 'string') { result.modifiedTime = data.modifiedTime; }
    if (typeof data.webViewLink === 'string') { result.webViewLink = data.webViewLink; }
    return result;
}

/** 只允许访问 Drive v3 的两个固定元数据入口，令牌保留在工作台进程内。 */
async function callGoogleDriveTool(connections, name, args = {}, signal) {
    const tool = googleDriveTools.find(item => item.name === name);
    if (!tool) { throw new Error('未知的 Google Drive 工具。'); }
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) {
        throw new Error('Google Drive 工具参数无效。');
    }
    const listing = name === 'google_drive_list_files';
    let url;
    if (listing) { url = listUrl(args); }
    else {
        if (!validId(args.fileId)) { throw new Error('Google Drive 文件 ID 无效。'); }
        url = new URL(DRIVE_FILES + '/' + args.fileId);
        url.searchParams.set('fields', FIELDS);
        url.searchParams.set('supportsAllDrives', 'true');
    }
    return connections.withAccessToken('google-drive', async record => {
        signal?.throwIfAborted();
        const data = await connections.request(url.href, { signal, headers: { Authorization: 'Bearer ' + record.accessToken } });
        if (!listing) {
            const file = metadata(data);
            if (args.fileId !== 'root' && file.id !== args.fileId) { throw new Error('Google Drive 返回的文件与所选 ID 不一致。'); }
            return file;
        }
        if (!Array.isArray(data.files)) { throw new Error('Google Drive 没有返回文件列表。'); }
        const result = { files: data.files.map(metadata) };
        if (data.nextPageToken) { result.nextPageToken = checkedText(data.nextPageToken, 4096, '翻页标记'); }
        return result;
    });
}

module.exports = { googleDriveTools, callGoogleDriveTool };
