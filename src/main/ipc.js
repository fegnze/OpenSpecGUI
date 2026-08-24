'use strict';

function requireString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(label + '无效');
    }
    return value;
}

function normalizePaths(request) {
    if (request && Array.isArray(request.paths)) {
        return request.paths.map(function (item) { return requireString(item, '项目路径'); });
    }
    if (request && request.path) {
        return [requireString(request.path, '项目路径')];
    }
    return [];
}

function registerIpc(options) {
    var ipcMain = options.ipcMain;
    var dialog = options.dialog;
    var clipboard = options.clipboard;
    var service = options.service;
    var windowProvider = options.windowProvider;

    ipcMain.handle('projects:list', function () {
        return service.listProjects();
    });

    ipcMain.handle('projects:add', async function (event, request) {
        var paths = normalizePaths(request);
        if (!paths.length) {
            var selected = await dialog.showOpenDialog(windowProvider(), {
                title: '添加 OpenSpec 项目',
                buttonLabel: '添加项目',
                properties: ['openDirectory', 'createDirectory']
            });
            if (selected.canceled || !selected.filePaths.length) {
                return { canceled: true };
            }
            paths = selected.filePaths;
        }
        return Object.assign({ canceled: false }, await service.addProjects(paths));
    });

    ipcMain.handle('projects:scan', async function (event, request) {
        var parentPath = request && request.path;
        if (!parentPath) {
            var selected = await dialog.showOpenDialog(windowProvider(), {
                title: '扫描 OpenSpec 项目',
                buttonLabel: '扫描此目录',
                properties: ['openDirectory']
            });
            if (selected.canceled || !selected.filePaths.length) {
                return { canceled: true, candidates: [] };
            }
            parentPath = selected.filePaths[0];
        }
        return { canceled: false, parentPath: parentPath, candidates: await service.scanProjects(requireString(parentPath, '扫描路径')) };
    });

    ipcMain.handle('projects:select', function (event, request) {
        return service.selectProject(requireString(request && request.projectId, '项目 ID'));
    });

    ipcMain.handle('projects:remove', function (event, request) {
        return service.removeProject(requireString(request && request.projectId, '项目 ID'));
    });

    ipcMain.handle('projects:relink', async function (event, request) {
        var projectId = requireString(request && request.projectId, '项目 ID');
        var rootPath = request && request.path;
        if (!rootPath) {
            var selected = await dialog.showOpenDialog(windowProvider(), {
                title: '重新关联 OpenSpec 项目',
                buttonLabel: '关联此目录',
                properties: ['openDirectory']
            });
            if (selected.canceled || !selected.filePaths.length) {
                return { canceled: true };
            }
            rootPath = selected.filePaths[0];
        }
        return { canceled: false, registry: await service.relinkProject(projectId, requireString(rootPath, '项目路径')) };
    });

    ipcMain.handle('workspace:load', function () {
        return service.loadWorkspace(false);
    });

    ipcMain.handle('workspace:refresh', function () {
        return service.loadWorkspace(true);
    });

    ipcMain.handle('documents:read', function (event, request) {
        return service.readDocument(request);
    });

    ipcMain.handle('clipboard:write', function (event, request) {
        var text = requireString(request && request.text, '剪贴板文本');
        if (text.length > 8192) {
            throw new Error('剪贴板文本超过限制');
        }
        clipboard.writeText(text);
        return { ok: true };
    });
}

module.exports = {
    normalizePaths: normalizePaths,
    registerIpc: registerIpc,
    requireString: requireString
};
