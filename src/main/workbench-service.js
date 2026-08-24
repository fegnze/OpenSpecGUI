'use strict';

var fsPromises = require('node:fs/promises');
var path = require('node:path');
var workspaceModule = require('../core/workspace');

function codedError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
}

async function computeOpenSpecStamp(openspecPath) {
    var newest = 0;

    async function visit(directory) {
        var entries = await fsPromises.readdir(directory, { withFileTypes: true });
        for (var index = 0; index < entries.length; index += 1) {
            var entry = entries[index];
            var target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                await visit(target);
            } else if (entry.isFile() && /\.(md|ya?ml|json)$/i.test(entry.name)) {
                var stat = await fsPromises.stat(target);
                newest = Math.max(newest, stat.mtimeMs, stat.size);
            }
        }
    }

    await visit(openspecPath);
    return newest;
}

function WorkbenchService(registry, options) {
    this.registry = registry;
    this.options = options || {};
    this.workspace = null;
    this.revision = 0;
    this.stamp = null;
}

WorkbenchService.prototype.initialize = async function () {
    await this.registry.load();
    return this.registry.list();
};

WorkbenchService.prototype.invalidate = function () {
    this.revision += 1;
    this.workspace = null;
    this.stamp = null;
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
    if (!this.workspace) {
        this.workspace = await workspaceModule.buildWorkspace({
            id: project.id,
            name: project.name,
            rootPath: project.rootPath,
            openspecPath: project.openspecPath
        }, {
            cliOptions: this.options.cliOptions || {},
            statusProvider: this.options.statusProvider,
            now: this.options.now
        });
        this.stamp = await computeOpenSpecStamp(project.openspecPath);
    }
    return {
        projectId: project.id,
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

WorkbenchService.prototype.refreshIfChanged = async function () {
    var project = this.registry.getActive();
    if (!project || this.stamp === null) {
        return false;
    }
    try {
        var nextStamp = await computeOpenSpecStamp(project.openspecPath);
        if (nextStamp !== this.stamp) {
            this.invalidate();
            return true;
        }
    } catch (error) {
        this.invalidate();
        return true;
    }
    return false;
};

module.exports = {
    WorkbenchService: WorkbenchService,
    computeOpenSpecStamp: computeOpenSpecStamp
};
