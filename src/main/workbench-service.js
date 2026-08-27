'use strict';

var crypto = require('node:crypto');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var createDefaultInitiativeRegistry = require('../core/initiative-providers').createDefaultInitiativeRegistry;
var workspaceModule = require('../core/workspace');

var DEFAULT_STAMP_LIMITS = {
    maxDepth: 32,
    maxEntries: 20000,
    maxBytes: 64 * 1024 * 1024
};
var WORKSPACE_DIRECTORIES = ['changes', 'specs'];
var WORKSPACE_ROOT_FILES = ['config.json', 'config.yaml', 'config.yml'];

function codedError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
}

async function assertPathSegmentsNoSymlink(rootPath, targetPath) {
    var relative = path.relative(rootPath, targetPath);
    var segments = relative ? relative.split(path.sep) : [];
    var current = rootPath;
    if (!workspaceModule.isWithin(rootPath, targetPath)) {
        throw codedError('CHANGE_PATH_FORBIDDEN', 'Change 目录超出 OpenSpec 根目录');
    }
    for (var index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index]);
        if ((await fsPromises.lstat(current)).isSymbolicLink()) {
            throw codedError('CHANGE_PATH_FORBIDDEN', 'Change 目录包含符号链接');
        }
    }
}

async function computeOpenSpecStamp(openspecPath, options) {
    var settings = Object.assign({}, DEFAULT_STAMP_LIMITS, options || {});
    var records = [];
    var entryCount = 0;
    var totalBytes = 0;

    function assertLimit(value, maximum, label) {
        if (!Number.isSafeInteger(maximum) || maximum < 1 || value > maximum) {
            throw codedError('WORKSPACE_STAMP_LIMIT', 'OpenSpec ' + label + '超过刷新扫描限制');
        }
    }

    async function recordFile(target, relativePath, stat) {
        totalBytes += Number(stat.size);
        assertLimit(totalBytes, settings.maxBytes, '文件总量');
        var content = await fsPromises.readFile(target);
        records.push(relativePath + '\0file\0' + stat.size + '\0' + crypto.createHash('sha256').update(content).digest('hex'));
    }

    async function visit(directory, relativeDirectory, depth) {
        assertLimit(depth, settings.maxDepth, '目录深度');
        var handle;
        var entries = [];
        try {
            handle = await fsPromises.opendir(directory);
        } catch (error) {
            if (error.code === 'ENOENT') {
                records.push(relativeDirectory + '\0missing');
                return;
            }
            throw error;
        }
        try {
            var nextEntry;
            while ((nextEntry = await handle.read()) !== null) {
                entryCount += 1;
                assertLimit(entryCount, settings.maxEntries, '目录项');
                entries.push(nextEntry);
            }
        } finally {
            await handle.close();
        }
        entries.sort(function (left, right) { return left.name.localeCompare(right.name); });
        for (var index = 0; index < entries.length; index += 1) {
            var entry = entries[index];
            var relativePath = path.posix.join(relativeDirectory, entry.name);
            var target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                records.push(relativePath + '\0symlink');
            } else if (entry.isDirectory()) {
                records.push(relativePath + '\0directory');
                await visit(target, relativePath, depth + 1);
            } else if (entry.isFile() && /\.(?:md|json|ya?ml)$/i.test(entry.name)) {
                await recordFile(target, relativePath, await fsPromises.stat(target, { bigint: true }));
            }
        }
    }

    for (var directoryIndex = 0; directoryIndex < WORKSPACE_DIRECTORIES.length; directoryIndex += 1) {
        var directoryName = WORKSPACE_DIRECTORIES[directoryIndex];
        await visit(path.join(openspecPath, directoryName), directoryName, 1);
    }
    for (var fileIndex = 0; fileIndex < WORKSPACE_ROOT_FILES.length; fileIndex += 1) {
        var fileName = WORKSPACE_ROOT_FILES[fileIndex];
        var filePath = path.join(openspecPath, fileName);
        try {
            var stat = await fsPromises.lstat(filePath, { bigint: true });
            entryCount += 1;
            assertLimit(entryCount, settings.maxEntries, '目录项');
            if (stat.isSymbolicLink()) {
                records.push(fileName + '\0symlink');
            } else if (stat.isFile()) {
                await recordFile(filePath, fileName, stat);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            records.push(fileName + '\0missing');
        }
    }
    return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

function WorkbenchService(registry, options) {
    this.registry = registry;
    this.options = options || {};
    this.initiativeRegistry = this.options.initiativeRegistry || createDefaultInitiativeRegistry();
    this.workspace = null;
    this.revision = 0;
    this.stamp = null;
    this.providerFingerprint = null;
    this.refreshPromise = null;
}

WorkbenchService.prototype.initialize = async function () {
    await this.registry.load();
    return this.registry.list();
};

WorkbenchService.prototype.invalidate = function () {
    this.revision += 1;
    this.workspace = null;
    this.stamp = null;
    this.providerFingerprint = null;
    if (typeof this.options.onInvalidate === 'function') {
        this.options.onInvalidate(this.revision);
    }
};

WorkbenchService.prototype.listProjects = function () {
    return this.registry.list();
};

WorkbenchService.prototype.addProjects = async function (paths) {
    var result = await this.registry.addPaths(paths);
    this.invalidate();
    return { added: result, registry: await this.registry.list() };
};

WorkbenchService.prototype.scanProjects = function (parentPath) {
    return this.registry.scan(parentPath);
};

WorkbenchService.prototype.selectProject = async function (projectId) {
    await this.registry.select(projectId);
    this.invalidate();
    return this.registry.list();
};

WorkbenchService.prototype.removeProject = async function (projectId) {
    await this.registry.remove(projectId);
    this.invalidate();
    return this.registry.list();
};

WorkbenchService.prototype.relinkProject = async function (projectId, rootPath) {
    await this.registry.relink(projectId, rootPath);
    this.invalidate();
    return this.registry.list();
};

WorkbenchService.prototype.loadWorkspace = async function (force) {
    var project = this.registry.getActive();
    if (!project) {
        return { projectId: null, revision: this.revision, snapshot: null };
    }
    if (force) {
        this.invalidate();
    }
    var expectedProjectId = project.id;
    var expectedRevision = this.revision;
    if (!this.workspace) {
        var nextWorkspace = await workspaceModule.buildWorkspace({
            id: project.id,
            name: project.name,
            rootPath: project.rootPath,
            openspecPath: project.openspecPath
        }, {
            cliOptions: this.options.cliOptions || {},
            statusProvider: this.options.statusProvider,
            initiativeRegistry: this.initiativeRegistry,
            now: this.options.now
        });
        var nextStamp = await computeOpenSpecStamp(project.openspecPath, this.options.workspaceStampOptions);
        var currentProject = this.registry.getActive();
        if (!currentProject || currentProject.id !== expectedProjectId || this.revision !== expectedRevision) {
            throw codedError('STALE_WORKSPACE', '工作区构建期间项目已切换或刷新');
        }
        this.workspace = nextWorkspace;
        this.stamp = nextStamp;
        this.providerFingerprint = nextWorkspace.providerFingerprint;
    }
    return {
        projectId: expectedProjectId,
        revision: this.revision,
        snapshot: this.workspace.snapshot
    };
};

WorkbenchService.prototype.readDocument = async function (request) {
    var active = this.registry.getActive();
    if (!active || !this.workspace) {
        throw codedError('NO_ACTIVE_PROJECT', '当前没有已载入项目');
    }
    if (!request || request.projectId !== active.id || request.revision !== this.revision) {
        throw codedError('STALE_WORKSPACE', '工作区已切换，请重新载入文档');
    }
    if (typeof request.documentId !== 'string' || !request.documentId) {
        throw codedError('INVALID_DOCUMENT', '文档标识无效');
    }
    return workspaceModule.readWorkspaceDocument(this.workspace, request.documentId);
};

WorkbenchService.prototype.assertCurrentRequest = function (request) {
    var active = this.registry.getActive();
    if (!active || !this.workspace) {
        throw codedError('NO_ACTIVE_PROJECT', '当前没有已载入项目');
    }
    if (!request || request.projectId !== active.id || request.revision !== this.revision) {
        throw codedError('STALE_WORKSPACE', '工作区已切换或刷新');
    }
    if (typeof request.providerId !== 'string' || typeof request.initiativeId !== 'string') {
        throw codedError('INVALID_INITIATIVE', 'Initiative 标识无效');
    }
    var descriptor = this.workspace.snapshot.initiatives.find(function (item) {
        return item.providerId === request.providerId && item.id === request.initiativeId;
    });
    if (!descriptor) {
        throw codedError('INITIATIVE_NOT_FOUND', 'Initiative 不存在或 Provider 不匹配');
    }
    return descriptor;
};

WorkbenchService.prototype.loadInitiative = async function (request) {
    var descriptor = this.assertCurrentRequest(request);
    return this.initiativeRegistry.load(this.workspace.roots, descriptor);
};

WorkbenchService.prototype.readInitiativeArtifact = async function (request) {
    var descriptor = this.assertCurrentRequest(request);
    if (typeof request.sourceHash !== 'string' || request.sourceHash !== descriptor.sourceHash) {
        throw codedError('STALE_INITIATIVE', 'Initiative 成果版本已变化');
    }
    if (typeof request.artifactId !== 'string' || !request.artifactId) {
        throw codedError('INVALID_ARTIFACT', '成果标识无效');
    }
    return this.initiativeRegistry.readArtifact(this.workspace.roots, descriptor, {
        sourceHash: request.sourceHash,
        artifactId: request.artifactId
    });
};

WorkbenchService.prototype.prepareEmbeddedInitiativeApp = async function (request) {
    var descriptor = this.assertCurrentRequest(request);
    if (!descriptor.presentation || descriptor.presentation.mode !== 'embedded-app') {
        throw codedError('EMBEDDED_APP_REQUIRED', '该 Initiative 不是独立应用');
    }
    return this.initiativeRegistry.prepareApp(this.workspace.roots, descriptor);
};

WorkbenchService.prototype.resolveChangeDirectory = async function (request) {
    var active = this.registry.getActive();
    var workspace = this.workspace;
    var revision = this.revision;
    var entity;
    var target;
    var realTarget;
    var stat;
    if (!active || !workspace) {
        throw codedError('NO_ACTIVE_PROJECT', '当前没有已载入项目');
    }
    if (!request || request.projectId !== active.id || request.revision !== revision) {
        throw codedError('STALE_WORKSPACE', '工作区已切换或刷新');
    }
    var activeMatches = workspace.snapshot.changes.filter(function (change) {
        return change.id === request.changeId;
    });
    var archiveMatches = workspace.snapshot.archives.filter(function (change) {
        return change.referenceId === request.changeId;
    });
    if (activeMatches.length > 1 || archiveMatches.length > 1 || (activeMatches.length && archiveMatches.length)) {
        throw codedError('CHANGE_INDEX_AMBIGUOUS', 'Change 索引存在歧义');
    }
    entity = activeMatches[0];
    if (entity) {
        target = path.join(workspace.roots.openspecRealRoot, 'changes', entity.id);
    } else {
        entity = archiveMatches[0];
        if (entity) {
            target = path.join(workspace.roots.openspecRealRoot, 'changes', 'archive', entity.id);
        }
    }
    if (!entity) {
        throw codedError('CHANGE_NOT_FOUND', 'Change 不存在或未登记');
    }
    await assertPathSegmentsNoSymlink(workspace.roots.openspecRealRoot, target);
    stat = await fsPromises.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw codedError('CHANGE_PATH_FORBIDDEN', 'Change 目录边界无效');
    }
    realTarget = await fsPromises.realpath(target);
    if (!workspaceModule.isWithin(workspace.roots.openspecRealRoot, realTarget)) {
        throw codedError('CHANGE_PATH_FORBIDDEN', 'Change 目录超出 OpenSpec 根目录');
    }
    var currentActive = this.registry.getActive();
    if (this.workspace !== workspace || this.revision !== revision || !currentActive || currentActive.id !== active.id) {
        throw codedError('STALE_WORKSPACE', '工作区已切换或刷新');
    }
    return realTarget;
};

WorkbenchService.prototype.checkForUpdates = async function () {
    var changed = await this.refreshIfChanged();
    return { changed: changed, revision: this.revision };
};

WorkbenchService.prototype.refreshIfChanged = function () {
    var self = this;
    var project = this.registry.getActive();
    var workspace = this.workspace;
    var revision = this.revision;
    var stamp = this.stamp;
    var providerFingerprint = this.providerFingerprint;
    var pending;
    var shared;
    if (this.refreshPromise) {
        return this.refreshPromise;
    }
    if (!project || !workspace || stamp === null) {
        return Promise.resolve(false);
    }
    pending = (async function () {
        try {
            var nextStamp = await computeOpenSpecStamp(project.openspecPath, self.options.workspaceStampOptions);
            var nextProviderFingerprint = await self.initiativeRegistry.fingerprint(workspace.roots);
            var currentProject = self.registry.getActive();
            if (self.workspace !== workspace || self.revision !== revision || !currentProject || currentProject.id !== project.id) {
                return false;
            }
            if (nextStamp !== stamp || nextProviderFingerprint !== providerFingerprint) {
                self.invalidate();
                return true;
            }
        } catch (error) {
            if (self.workspace === workspace && self.revision === revision) {
                self.invalidate();
                return true;
            }
        }
        return false;
    }());
    shared = pending.finally(function () {
        if (self.refreshPromise === shared) {
            self.refreshPromise = null;
        }
    });
    this.refreshPromise = shared;
    return shared;
};

module.exports = {
    WorkbenchService: WorkbenchService,
    computeOpenSpecStamp: computeOpenSpecStamp
};
