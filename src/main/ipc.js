'use strict';

var MAX_IPC_PAYLOAD_BYTES = 65536;
var MAX_PROJECT_PATHS = 128;
var PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
var ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
var SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/;
var INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;

function assertPayloadSize(request) {
    var serialized;
    try {
        serialized = JSON.stringify(request == null ? {} : request);
    } catch (error) {
        throw new Error('IPC 请求无法序列化');
    }
    if (Buffer.byteLength(serialized || '', 'utf8') > MAX_IPC_PAYLOAD_BYTES) {
        throw new Error('IPC 请求超过 payload 限制');
    }
}

function assertAllowedKeys(value, allowed, label) {
    Object.keys(value).forEach(function (key) {
        if (allowed.indexOf(key) === -1) {
            throw new Error(label + '包含未支持字段：' + key);
        }
    });
}

function requestObject(request, allowed, label) {
    assertPayloadSize(request);
    var value = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
    assertAllowedKeys(value, allowed, label);
    return value;
}

function requireString(value, label, maximum, pattern) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(label + '无效');
    }
    if (value.indexOf('\0') !== -1 || value.length > maximum) {
        throw new Error(label + '超过限制');
    }
    var normalized = value.trim();
    if (pattern && !pattern.test(normalized)) {
        throw new Error(label + '格式无效');
    }
    return normalized;
}

function normalizePaths(request) {
    var value = requestObject(request, ['path', 'paths'], '项目路径请求');
    if (Array.isArray(value.paths)) {
        if (value.paths.length > MAX_PROJECT_PATHS) {
            throw new Error('项目路径数量超过限制');
        }
        return value.paths.map(function (item) { return requireString(item, '项目路径', 4096); });
    }
    if (value.path) {
        return [requireString(value.path, '项目路径', 4096)];
    }
    return [];
}

function normalizeOptionalPath(request, label) {
    var value = requestObject(request, ['path'], label + '请求');
    return value.path ? requireString(value.path, label, 4096) : '';
}

function normalizeInitiativeRequest(request, includeArtifact) {
    var allowed = ['projectId', 'revision', 'providerId', 'initiativeId'];
    if (includeArtifact) { allowed = allowed.concat(['sourceHash', 'artifactId']); }
    var value = requestObject(request, allowed, 'Initiative 请求');
    var revision = value.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('工作区 revision 无效');
    }
    var normalized = {
        projectId: requireString(value.projectId, '项目 ID', 36, PROJECT_ID_PATTERN),
        revision: revision,
        providerId: requireString(value.providerId, 'Provider ID', 63, IDENTIFIER_PATTERN),
        initiativeId: requireString(value.initiativeId, 'Initiative ID', 63, IDENTIFIER_PATTERN)
    };
    if (includeArtifact) {
        normalized.sourceHash = requireString(value.sourceHash, 'source hash', 64, SOURCE_HASH_PATTERN);
        normalized.artifactId = requireString(value.artifactId, '成果 ID', 128, ARTIFACT_ID_PATTERN);
    }
    return normalized;
}

function normalizeEmbeddedAppRequest(request) {
    var allowed = ['projectId', 'revision', 'providerId', 'initiativeId', 'location'];
    var value = requestObject(request, allowed, '独立 Initiative App 请求');
    var normalized = normalizeInitiativeRequest({
        projectId: value.projectId,
        revision: value.revision,
        providerId: value.providerId,
        initiativeId: value.initiativeId
    }, false);
    normalized.location = value.location ? requireString(value.location, '应用内位置', 2048, /^[^\\\0]+$/) : '';
    return normalized;
}

function normalizeInstanceRequest(request, mode) {
    var allowed = mode === 'bounds' ? ['instanceId', 'bounds', 'visible'] : ['instanceId', 'visible'];
    var value = requestObject(request, allowed, '独立 Initiative App 实例请求');
    var normalized = {
        instanceId: requireString(value.instanceId, '应用实例 ID', 32, INSTANCE_ID_PATTERN)
    };
    if (mode === 'bounds') {
        var bounds = value.bounds && typeof value.bounds === 'object' && !Array.isArray(value.bounds) ? value.bounds : {};
        assertAllowedKeys(bounds, ['x', 'y', 'width', 'height'], '应用边界');
        ['x', 'y', 'width', 'height'].forEach(function (key) {
            if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]) || Math.abs(bounds[key]) > 100000) {
                throw new Error('应用边界无效');
            }
        });
        normalized.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    if (value.visible !== undefined && typeof value.visible !== 'boolean') {
        throw new Error('应用可见状态无效');
    }
    normalized.visible = value.visible !== false;
    return normalized;
}

function normalizeDisposeRequest(request) {
    var value = requestObject(request, ['instanceId'], '独立 Initiative App 销毁请求');
    return value.instanceId ? requireString(value.instanceId, '应用实例 ID', 32, INSTANCE_ID_PATTERN) : '';
}

function normalizeFocusRequest(request) {
    var value = requestObject(request, ['instanceId'], '独立 Initiative App 聚焦请求');
    return requireString(value.instanceId, '应用实例 ID', 32, INSTANCE_ID_PATTERN);
}

function normalizeProjectIdRequest(request) {
    var value = requestObject(request, ['projectId'], '项目请求');
    return requireString(value.projectId, '项目 ID', 36, PROJECT_ID_PATTERN);
}

function normalizeRelinkRequest(request) {
    var value = requestObject(request, ['projectId', 'path'], '重新关联请求');
    return {
        projectId: requireString(value.projectId, '项目 ID', 36, PROJECT_ID_PATTERN),
        path: value.path ? requireString(value.path, '项目路径', 4096) : ''
    };
}

function normalizeDocumentRequest(request) {
    var value = requestObject(request, ['projectId', 'revision', 'documentId'], '文档请求');
    var revision = value.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('工作区 revision 无效');
    }
    var documentId = requireString(value.documentId, '文档 ID', 1024, /^[^\\\0]+$/);
    if (documentId.charAt(0) === '/' || documentId.split('/').some(function (segment) {
        return !segment || segment === '.' || segment === '..';
    })) {
        throw new Error('文档 ID 格式无效');
    }
    return {
        projectId: requireString(value.projectId, '项目 ID', 36, PROJECT_ID_PATTERN),
        revision: revision,
        documentId: documentId
    };
}

function registerIpc(options) {
    var ipcMain = options.ipcMain;
    var dialog = options.dialog;
    var clipboard = options.clipboard;
    var service = options.service;
    var windowProvider = options.windowProvider;
    var embeddedAppHost = options.embeddedAppHost;

    function assertTrustedRenderer(event) {
        var window = windowProvider();
        if (!window || window.isDestroyed && window.isDestroyed() || !event || event.sender !== window.webContents) {
            throw new Error('IPC 调用来源无效');
        }
    }

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
        var parentPath = normalizeOptionalPath(request, '扫描路径');
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
        return { canceled: false, parentPath: parentPath, candidates: await service.scanProjects(requireString(parentPath, '扫描路径', 4096)) };
    });

    ipcMain.handle('projects:select', function (event, request) {
        return service.selectProject(normalizeProjectIdRequest(request));
    });

    ipcMain.handle('projects:remove', function (event, request) {
        return service.removeProject(normalizeProjectIdRequest(request));
    });

    ipcMain.handle('projects:relink', async function (event, request) {
        var normalized = normalizeRelinkRequest(request);
        var projectId = normalized.projectId;
        var rootPath = normalized.path;
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
        return { canceled: false, registry: await service.relinkProject(projectId, requireString(rootPath, '项目路径', 4096)) };
    });

    ipcMain.handle('workspace:load', function () {
        return service.loadWorkspace(false);
    });

    ipcMain.handle('workspace:refresh', function () {
        return service.loadWorkspace(true);
    });

    ipcMain.handle('workspace:check-updates', function () {
        return service.checkForUpdates();
    });

    ipcMain.handle('documents:read', function (event, request) {
        return service.readDocument(normalizeDocumentRequest(request));
    });

    ipcMain.handle('initiatives:load', function (event, request) {
        return service.loadInitiative(normalizeInitiativeRequest(request, false));
    });

    ipcMain.handle('initiatives:read-artifact', function (event, request) {
        return service.readInitiativeArtifact(normalizeInitiativeRequest(request, true));
    });

    if (embeddedAppHost) {
        ipcMain.handle('initiative-app:mount', function (event, request) {
            assertTrustedRenderer(event);
            return embeddedAppHost.mount(normalizeEmbeddedAppRequest(request));
        });

        ipcMain.handle('initiative-app:update-bounds', function (event, request) {
            assertTrustedRenderer(event);
            return embeddedAppHost.updateBounds(normalizeInstanceRequest(request, 'bounds'));
        });

        ipcMain.handle('initiative-app:set-visible', function (event, request) {
            assertTrustedRenderer(event);
            return embeddedAppHost.setVisible(normalizeInstanceRequest(request, 'visible'));
        });

        ipcMain.handle('initiative-app:focus', function (event, request) {
            assertTrustedRenderer(event);
            return embeddedAppHost.focus(normalizeFocusRequest(request));
        });

        ipcMain.handle('initiative-app:dispose', function (event, request) {
            assertTrustedRenderer(event);
            return embeddedAppHost.dispose(normalizeDisposeRequest(request));
        });
    }

    ipcMain.handle('clipboard:write', function (event, request) {
        var value = requestObject(request, ['text'], '剪贴板请求');
        var text = requireString(value.text, '剪贴板文本', 8192);
        clipboard.writeText(text);
        return { ok: true };
    });
}

module.exports = {
    MAX_IPC_PAYLOAD_BYTES: MAX_IPC_PAYLOAD_BYTES,
    assertPayloadSize: assertPayloadSize,
    normalizeDocumentRequest: normalizeDocumentRequest,
    normalizeEmbeddedAppRequest: normalizeEmbeddedAppRequest,
    normalizeFocusRequest: normalizeFocusRequest,
    normalizeInstanceRequest: normalizeInstanceRequest,
    normalizePaths: normalizePaths,
    normalizeInitiativeRequest: normalizeInitiativeRequest,
    registerIpc: registerIpc,
    requireString: requireString
};
