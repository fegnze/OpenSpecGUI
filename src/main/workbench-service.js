'use strict';

var crypto = require('node:crypto');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var createDefaultInitiativeRegistry = require('../core/initiative-providers').createDefaultInitiativeRegistry;
var workspaceModule = require('../core/workspace');
var changeAttachments = require('../core/change-attachments');
var ChangeArchiveService = require('./change-archive-service').ChangeArchiveService;

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
        // 工作台索引 Markdown 和 OpenSpec 配置正文。其他结构化附件只需要
        // 识别变化，完整归档预检由归档服务独立读取和校验。
        var indexesContent = /\.md$/i.test(relativePath) ||
            WORKSPACE_ROOT_FILES.includes(relativePath) || /^\.openspec\.(?:json|ya?ml)$/i.test(path.basename(relativePath));
        if (!indexesContent) {
            records.push([relativePath, 'attachment', stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0'));
            return;
        }
        totalBytes += Number(stat.size);
        assertLimit(totalBytes, settings.maxBytes, '文档与配置总量');
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
                // 目录枚举用于发现 Markdown 和受控配置。JSON 附件仅在展开提案时登记。
                if (!nextEntry.isDirectory() && changeAttachments.isAttachment(nextEntry.name)) { continue; }
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
                // 活跃/归档提案目录本身是实体。深层目录只通过其中的索引输入影响快照。
                if (relativeDirectory === 'changes' || relativeDirectory === 'changes/archive') {
                    records.push(relativePath + '\0directory');
                }
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
    this.loadedProject = null;
    this.workspace = null;
    this.revision = 0;
    this.stamp = null;
    this.providerFingerprint = null;
    this.refreshPromise = null;
    this.registryMutations = 0;
    this.archiveService = new ChangeArchiveService(Object.assign({
        recoveryDirectory: path.join(path.dirname(registry.registryPath), 'archive-operations'),
        cliOptions: this.options.cliOptions || {}
    }, this.options.archiveOptions || {}));
}

WorkbenchService.prototype.initialize = async function () {
    await this.registry.load();
    return this.registry.list();
};

WorkbenchService.prototype.invalidate = function () {
    this.archiveService.invalidate();
    this.revision += 1;
    this.loadedProject = null;
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
    this.assertArchiveIdle();
    this.registryMutations += 1;
    try {
        var result = await this.registry.addPaths(paths);
        this.invalidate();
        return { added: result, registry: await this.registry.list() };
    } finally { this.registryMutations -= 1; }
};

WorkbenchService.prototype.scanProjects = function (parentPath) {
    return this.registry.scan(parentPath);
};

WorkbenchService.prototype.selectProject = async function (projectId) {
    this.assertArchiveIdle();
    this.registryMutations += 1;
    try { await this.registry.select(projectId); this.invalidate(); return await this.registry.list(); }
    finally { this.registryMutations -= 1; }
};

WorkbenchService.prototype.removeProject = async function (projectId) {
    this.assertArchiveIdle();
    this.registryMutations += 1;
    try { await this.registry.remove(projectId); this.invalidate(); return await this.registry.list(); }
    finally { this.registryMutations -= 1; }
};

WorkbenchService.prototype.relinkProject = async function (projectId, rootPath) {
    this.assertArchiveIdle();
    this.registryMutations += 1;
    try { await this.registry.relink(projectId, rootPath); this.invalidate(); return await this.registry.list(); }
    finally { this.registryMutations -= 1; }
};

/**
 * 确认异步请求仍指向原项目根和工作区版本。
 * @param {object} project 请求开始时的项目身份
 * @param {number} revision 请求开始时的版本
 * @returns {boolean} 是否仍属于当前项目
 */
WorkbenchService.prototype.isCurrentProject = function (project, revision) {
    var current = this.registry.getActive();
    return Boolean(current && current.id === project.id && current.rootPath === project.rootPath && this.revision === revision);
};

WorkbenchService.prototype.loadWorkspace = async function (force) {
    var registered = this.registry.getActive();
    if (!registered) {
        return { projectId: null, revision: this.revision, snapshot: null };
    }
    var project = { id: registered.id, rootPath: registered.rootPath };
    if (force && !this.archiveService.busy) {
        this.invalidate();
    }
    var expectedRevision = this.revision;
    var status = await this.registry.inspect(project);
    if (!this.isCurrentProject(project, expectedRevision)) {
        throw codedError('STALE_WORKSPACE', '检查工作区期间项目已切换或刷新');
    }
    if (!status.valid) {
        this.invalidate();
        throw codedError('PROJECT_UNAVAILABLE', status.error);
    }
    project.openspecPath = status.openspecPath;
    if (this.loadedProject && (this.loadedProject.id !== project.id || this.loadedProject.rootPath !== project.rootPath ||
        this.loadedProject.openspecPath !== project.openspecPath)) {
        this.invalidate();
        expectedRevision = this.revision;
    }
    this.loadedProject = project;
    if (!project.openspecPath) {
        return { projectId: project.id, snapshot: null };
    }
    if (!this.workspace) {
        var nextWorkspace = await workspaceModule.buildWorkspace({
            id: project.id,
            rootPath: project.rootPath,
            openspecPath: project.openspecPath
        }, {
            cliOptions: this.options.cliOptions || {},
            statusProvider: this.options.statusProvider,
            initiativeRegistry: this.initiativeRegistry,
            now: this.options.now
        });
        var nextStamp = await computeOpenSpecStamp(project.openspecPath, this.options.workspaceStampOptions);
        if (!this.isCurrentProject(project, expectedRevision)) {
            throw codedError('STALE_WORKSPACE', '工作区构建期间项目已切换或刷新');
        }
        this.workspace = nextWorkspace;
        this.stamp = nextStamp;
        this.providerFingerprint = nextWorkspace.providerFingerprint;
    }
    var expectedSnapshot = this.workspace.snapshot;
    var recovery = this.archiveService.busy ? [] : await this.archiveService.recoveries(this.workspace.roots.projectRoot);
    if (!this.isCurrentProject(project, expectedRevision)) { throw codedError('STALE_WORKSPACE', '恢复状态检查期间项目已切换或刷新'); }
    return {
        projectId: project.id,
        revision: this.revision,
        snapshot: expectedSnapshot,
        archiveRecovery: recovery
    };
};

WorkbenchService.prototype.assertArchiveIdle = function () {
    if (this.archiveService.busy) { throw codedError('ARCHIVE_BUSY', '归档正在执行，请完成后再切换或修改项目'); }
};

WorkbenchService.prototype.assertArchiveRequest = function (request) {
    if (this.registryMutations) { throw codedError('ARCHIVE_BUSY', '项目正在切换或更新，请稍后重新检查'); }
    var active = this.registry.getActive();
    if (!this.isOpenSpecWorkspace(active)) {
        throw codedError('STALE_WORKSPACE', '当前项目没有可用于此操作的 OpenSpec 工作区');
    }
    if (request.projectId !== active.id || request.revision !== this.revision) { throw codedError('STALE_WORKSPACE', '工作区已切换或刷新，请重新检查归档'); }
    return active;
};

WorkbenchService.prototype.prepareArchive = async function (request) {
    this.assertArchiveRequest(request);
    if (!this.workspace.snapshot.changes.some(function (change) { return change.id === request.changeId; })) { throw codedError('ARCHIVE_CHANGE_MISSING', '只能归档当前项目中的活跃变更'); }
    var root = this.workspace.roots.projectRoot;
    var result = await this.archiveService.prepare(Object.assign({ root: root }, request));
    try { this.assertArchiveRequest(request); }
    catch (error) { this.archiveService.discard({ projectId: request.projectId, revision: request.revision, planId: result.planId }); throw error; }
    return result;
};

WorkbenchService.prototype.discardArchive = function (request) { return this.archiveService.discard(request); };

WorkbenchService.prototype.commitArchive = function (request) {
    var entry = this.archiveService.entry(request);
    var active = this.registry.getActive();
    if (!active || active.id !== request.projectId) { throw codedError('STALE_WORKSPACE', '项目已切换，请重新检查归档'); }
    if (entry.promise) { return entry.promise; }
    this.assertArchiveRequest(request);
    var self = this;
    var result = this.archiveService.commit(request);
    // Keep the same promise for duplicate IPC submissions, including after refresh.
    entry.promise = result.finally(function () { self.invalidate(); });
    return entry.promise;
};

/**
 * 确认 OpenSpec 快照属于当前登记的实际项目根目录。
 * @param {object|null} project 当前注册项目
 * @returns {boolean} 是否允许按该快照处理 OpenSpec 操作
 */
WorkbenchService.prototype.isOpenSpecWorkspace = function (project) {
    var roots = this.workspace && this.workspace.roots;
    return Boolean(project && roots && roots.projectId === project.id && roots.projectRoot === project.rootPath);
};

/**
 * 只向发起请求时的工作区交付异步读取结果。
 * @param {Promise<object>} pending 当前正在处理的读取操作
 * @param {object} request 绑定了项目和版本的请求
 * @returns {Promise<object>} 仍适用于当前工作区的结果
 */
WorkbenchService.prototype.finishOpenSpecRead = async function (pending, request) {
    var workspace = this.workspace;
    var value = await pending;
    var active = this.registry.getActive();
    if (this.workspace !== workspace || !this.isOpenSpecWorkspace(active) ||
        active.id !== request.projectId || this.revision !== request.revision) {
        throw codedError('STALE_WORKSPACE', '读取期间工作区已切换或刷新');
    }
    return value;
};

WorkbenchService.prototype.readDocument = async function (request) {
    var active = this.registry.getActive();
    if (!this.isOpenSpecWorkspace(active)) {
        throw codedError('NO_ACTIVE_PROJECT', '当前没有已载入的 OpenSpec 工作区');
    }
    if (!request || request.projectId !== active.id || request.revision !== this.revision) {
        throw codedError('STALE_WORKSPACE', '工作区已切换，请重新载入文档');
    }
    if (typeof request.documentId !== 'string' || !request.documentId) {
        throw codedError('INVALID_DOCUMENT', '文档标识无效');
    }
    return this.finishOpenSpecRead(workspaceModule.readWorkspaceDocument(this.workspace, request.documentId), request);
};

WorkbenchService.prototype.assertCurrentRequest = function (request) {
    var active = this.registry.getActive();
    if (!this.isOpenSpecWorkspace(active)) {
        throw codedError('NO_ACTIVE_PROJECT', '当前没有已载入的 OpenSpec 工作区');
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
    return this.finishOpenSpecRead(this.initiativeRegistry.load(this.workspace.roots, descriptor), request);
};

WorkbenchService.prototype.readInitiativeArtifact = async function (request) {
    var descriptor = this.assertCurrentRequest(request);
    if (typeof request.sourceHash !== 'string' || request.sourceHash !== descriptor.sourceHash) {
        throw codedError('STALE_INITIATIVE', 'Initiative 成果版本已变化');
    }
    if (typeof request.artifactId !== 'string' || !request.artifactId) {
        throw codedError('INVALID_ARTIFACT', '成果标识无效');
    }
    return this.finishOpenSpecRead(this.initiativeRegistry.readArtifact(this.workspace.roots, descriptor, {
        sourceHash: request.sourceHash,
        artifactId: request.artifactId
    }), request);
};

WorkbenchService.prototype.prepareEmbeddedInitiativeApp = async function (request) {
    var descriptor = this.assertCurrentRequest(request);
    if (!descriptor.presentation || descriptor.presentation.mode !== 'embedded-app') {
        throw codedError('EMBEDDED_APP_REQUIRED', '该 Initiative 不是独立应用');
    }
    return this.finishOpenSpecRead(this.initiativeRegistry.prepareApp(this.workspace.roots, descriptor), request);
};

function attachmentContext(service, request) {
    var active = service.registry.getActive();
    if (!request || !service.isOpenSpecWorkspace(active) || active.id !== request.projectId || service.revision !== request.revision) {
        throw codedError('STALE_WORKSPACE', '工作区已切换或刷新，请重新展开附件列表。');
    }
    var workspace = service.workspace;
    var collection = request.entityType === 'active' ? workspace.snapshot.changes :
        request.entityType === 'archive' ? workspace.snapshot.archives : [];
    var entity = collection.find(function (item) { return item.id === request.changeId; });
    if (!entity || entity.id !== path.basename(entity.id) || entity.id === '.' || entity.id === '..') {
        throw codedError('CHANGE_NOT_FOUND', '当前提案不存在或未登记。');
    }
    var key = JSON.stringify([request.entityType, entity.id]);
    var segments = request.entityType === 'archive' ? ['changes', 'archive', entity.id] : ['changes', entity.id];
    return { workspace: workspace, key: key, root: workspace.roots.projectRoot,
        directory: path.join(workspace.roots.openspecRoot, ...segments) };
}

/** 仅在详情明确要求时扫描该提案，并将票据绑定到当前快照及提案类型。 */
WorkbenchService.prototype.listAttachments = async function (request) {
    var ctx = attachmentContext(this, request);
    var lists = ctx.workspace.attachmentLists || (ctx.workspace.attachmentLists = new Map());
    var existing = lists.get(ctx.key);
    if (existing && existing.pending) { return existing.pending; }
    lists.delete(ctx.key);
    if (lists.size >= 4) { lists.delete(lists.keys().next().value); }
    var slot = { pending: null, records: null };
    lists.set(ctx.key, slot);
    var service = this;
    slot.pending = (async function () {
        try {
            var index = await changeAttachments.listFiles(ctx.root, ctx.directory);
            if (attachmentContext(service, request).workspace !== ctx.workspace || lists.get(ctx.key) !== slot) {
                throw codedError('STALE_WORKSPACE', '工作区或附件列表已刷新。');
            }
            slot.records = index.records;
            return { files: index.files };
        } catch (error) {
            if (lists.get(ctx.key) === slot) { lists.delete(ctx.key); }
            throw error.code === 'STALE_WORKSPACE' ? error : changeAttachments.publicError(error);
        } finally { slot.pending = null; }
    }());
    return slot.pending;
};

/** 只接受本次清单中的随机票据与字节位置，读完后再次核对当前项目。 */
WorkbenchService.prototype.readAttachment = async function (request) {
    var ctx = attachmentContext(this, request);
    var list = ctx.workspace.attachmentLists && ctx.workspace.attachmentLists.get(ctx.key);
    var record = list && list.records && list.records.get(request.id);
    var value;
    try { value = await changeAttachments.readChunk(ctx.root, record, request.offset); }
    catch (error) { throw changeAttachments.publicError(error); }
    if (attachmentContext(this, request).workspace !== ctx.workspace || ctx.workspace.attachmentLists.get(ctx.key) !== list) {
        throw codedError('STALE_WORKSPACE', '附件列表已刷新，请重新选择。');
    }
    return value;
};

WorkbenchService.prototype.resolveChangeDirectory = async function (request) {
    var active = this.registry.getActive();
    var workspace = this.workspace;
    var revision = this.revision;
    var entity;
    var target;
    var realTarget;
    var stat;
    if (!this.isOpenSpecWorkspace(active)) {
        throw codedError('NO_ACTIVE_PROJECT', '当前没有已载入的 OpenSpec 工作区');
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
    if (this.archiveService.busy) { return Promise.resolve(false); }
    var self = this;
    var project = this.loadedProject;
    var workspace = this.workspace;
    var revision = this.revision;
    var stamp = this.stamp;
    var providerFingerprint = this.providerFingerprint;
    var pending;
    var shared;
    if (this.refreshPromise) {
        return this.refreshPromise;
    }
    if (!project || !this.isCurrentProject(project, revision)) {
        return Promise.resolve(false);
    }
    pending = (async function () {
        try {
            var status = await self.registry.inspect(project);
            if (self.archiveService.busy || !self.isCurrentProject(project, revision)) { return false; }
            if (!status.valid || status.openspecPath !== project.openspecPath) {
                self.invalidate();
                return true;
            }
            if (!workspace || stamp === null) { return false; }
            var nextStamp = await computeOpenSpecStamp(project.openspecPath, self.options.workspaceStampOptions);
            var nextProviderFingerprint = await self.initiativeRegistry.fingerprint(workspace.roots);
            if (self.archiveService.busy || self.workspace !== workspace || !self.isCurrentProject(project, revision)) {
                return false;
            }
            if (nextStamp !== stamp || nextProviderFingerprint !== providerFingerprint) {
                self.invalidate();
                return true;
            }
        } catch (error) {
            if (!self.archiveService.busy && self.workspace === workspace && self.isCurrentProject(project, revision)) {
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
