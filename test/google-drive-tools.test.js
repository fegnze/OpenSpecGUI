'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { googleDriveTools, callGoogleDriveTool } = require('../src/main/google-drive-tools');

const file = { id: 'target_01', name: '文件 01', mimeType: 'application/vnd.google-apps.document' };

function connection(handler) {
    return {
        withAccessToken(provider, operation) {
            assert.equal(provider, 'google-drive');
            return operation({ accessToken: 'fixture-token' });
        },
        request(url, options) {
            assert.deepEqual(options, { signal: undefined, headers: { Authorization: 'Bearer fixture-token' } });
            const target = new URL(url);
            assert.equal(target.origin, 'https://www.googleapis.com');
            assert.equal(target.searchParams.has('alt'), false);
            return handler(target);
        }
    };
}

test('Drive 工具按名称和文件夹读取元数据并使用不透明翻页标记', async () => {
    let page = 0;
    const conn = connection(target => {
        assert.equal(target.pathname, '/drive/v3/files');
        assert.equal(target.searchParams.get('q'), "trashed = false and 'root' in parents and name contains 'L\\'été\\\\演示'");
        assert.equal(target.searchParams.get('fields'), 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)');
        assert.equal(target.searchParams.get('pageSize'), '2');
        assert.equal(target.searchParams.get('includeItemsFromAllDrives'), 'true');
        if (++page === 1) {
            assert.equal(target.searchParams.has('pageToken'), false);
            return { files: [{ ...file, owners: ['unexpected'], description: 'unexpected' }], nextPageToken: 'a/b+%=' };
        }
        assert.equal(target.searchParams.get('pageToken'), 'a/b+%=');
        return { files: [] };
    });
    const query = { name: "L'été\\演示", folderId: 'root', pageSize: 2 };
    const first = await callGoogleDriveTool(conn, 'google_drive_list_files', query);
    assert.deepEqual(first, { files: [file], nextPageToken: 'a/b+%=' });
    assert.deepEqual(await callGoogleDriveTool(conn, 'google_drive_list_files', { ...query, pageToken: first.nextPageToken }), { files: [] });
});

test('Drive 单文件保留所需元数据并支持 root 别名', async () => {
    for (const requested of [file.id, 'root']) {
        const conn = connection(target => {
            assert.equal(target.pathname, '/drive/v3/files/' + requested);
            assert.equal(target.searchParams.get('supportsAllDrives'), 'true');
            return { ...file, modifiedTime: '2026-01-01T00:00:00Z', webViewLink: 'https://drive.google.com/', owners: ['other'] };
        });
        const result = await callGoogleDriveTool(conn, 'google_drive_get_file', { fileId: requested });
        assert.deepEqual(result, { ...file, modifiedTime: '2026-01-01T00:00:00Z', webViewLink: 'https://drive.google.com/' });
    }
    await assert.rejects(callGoogleDriveTool(connection(() => file), 'google_drive_get_file', { fileId: 'another' }), /不一致/);
});

test('Drive 非法参数在获取令牌之前被拒绝，授权错误可供宿主展示', async () => {
    assert.deepEqual(googleDriveTools.map(tool => tool.name), ['google_drive_list_files', 'google_drive_get_file']);
    for (const args of [{ fileId: '../outside' }, { fileId: 'key', accessToken: 'user-supplied' }, {}]) {
        await assert.rejects(callGoogleDriveTool({}, 'google_drive_get_file', args), /Google Drive/);
    }
    for (const args of [{ folderId: "' or trashed=true" }, { pageSize: 1.5 }, { pageSize: 101 }, { pageToken: '' }, { name: '\n' }]) {
        await assert.rejects(callGoogleDriveTool({}, 'google_drive_list_files', args), /Google Drive|每页/);
    }
    const error = new Error('请先连接 Google Drive。');
    await assert.rejects(callGoogleDriveTool({ withAccessToken() { throw error; } }, 'google_drive_list_files', {}), error);
});
