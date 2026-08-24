'use strict';

var crypto = require('node:crypto');
var fs = require('node:fs');
var fsPromises = require('node:fs/promises');
var path = require('node:path');

var REGISTRY_VERSION = 1;
var DEFAULT_MAX_DEPTH = 4;
var EXCLUDED_DIRECTORIES = new Set([
    '.git', '.hg', '.svn', '.cache', '.idea', '.vscode',
    'node_modules', 'dist', 'build', 'out', 'coverage', 'Library', 'Temp', 'Logs'
]);

function emptyRegistry() {
    return { version: REGISTRY_VERSION, activeProjectId: null, projects: [] };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRegistry(value) {
    if (!isPlainObject(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.projects)) {
        throw new Error('项目注册表格式无效');
    }

    var projects = value.projects.filter(function (project) {
        return isPlainObject(project) && typeof project.id === 'string' && typeof project.rootPath === 'string' && typeof project.openspecPath === 'string';
    }).map(function (project) {
        return {
            id: project.id,
            name: path.basename(project.rootPath),
            rootPath: project.rootPath,
            openspecPath: project.openspecPath,
            addedAt: project.addedAt || new Date(0).toISOString(),
            lastOpenedAt: project.lastOpenedAt || project.addedAt || new Date(0).toISOString()
        };
    });

    return {
        version: REGISTRY_VERSION,
        activeProjectId: projects.some(function (project) { return project.id === value.activeProjectId; }) ? value.activeProjectId : null,
        projects: projects
    };
}

async function pathIsReadableDirectory(targetPath) {
    try {
        var stat = await fsPromises.stat(targetPath);
        await fsPromises.access(targetPath, fs.constants.R_OK);
        return stat.isDirectory();
    } catch (error) {
        return false;
    }
}

async function resolveProject(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
        throw new Error('项目路径不能为空');
    }

    var requested = path.resolve(rootPath);
    if (!await pathIsReadableDirectory(requested)) {
        throw new Error('项目目录不存在或不可读取：' + requested);
    }

    var realRoot = await fsPromises.realpath(requested);
    var openspecPath = path.join(realRoot, 'openspec');
    if (!await pathIsReadableDirectory(openspecPath)) {
        throw new Error('所选目录中未发现可读取的 openspec/：' + realRoot);
    }

    return {
        name: path.basename(realRoot),
        rootPath: realRoot,
        openspecPath: await fsPromises.realpath(openspecPath)
    };
}

async function projectStatus(project) {
    try {
        var resolved = await resolveProject(project.rootPath);
        if (resolved.openspecPath !== project.openspecPath) {
            return { valid: false, error: 'OpenSpec 路径已变化，请重新关联' };
        }
        return { valid: true, error: null };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

function ProjectRegistry(registryPath, options) {
    var settings = options || {};
    this.registryPath = registryPath;
    this.backupPath = registryPath + '.bak';
    this.maxDepth = Number.isInteger(settings.maxDepth) ? settings.maxDepth : DEFAULT_MAX_DEPTH;
    this.data = emptyRegistry();
    this.diagnostic = null;
    this.recoveredFromBackup = false;
}

ProjectRegistry.prototype.load = async function () {
    await fsPromises.mkdir(path.dirname(this.registryPath), { recursive: true });

    try {
        this.data = normalizeRegistry(JSON.parse(await fsPromises.readFile(this.registryPath, 'utf8')));
        this.diagnostic = null;
        this.recoveredFromBackup = false;
        await this.ensureActiveSelection();
        return this.data;
    } catch (primaryError) {
        if (primaryError.code === 'ENOENT') {
            this.data = emptyRegistry();
            this.recoveredFromBackup = false;
            return this.data;
        }
        try {
            this.data = normalizeRegistry(JSON.parse(await fsPromises.readFile(this.backupPath, 'utf8')));
            this.diagnostic = '主注册表损坏，已恢复最近完整版本';
            this.recoveredFromBackup = true;
            await this.ensureActiveSelection();
            return this.data;
        } catch (backupError) {
            this.data = emptyRegistry();
            this.diagnostic = '项目注册表不可读，已使用空注册表：' + primaryError.message;
            this.recoveredFromBackup = false;
            return this.data;
        }
    }
};

ProjectRegistry.prototype.save = async function () {
    var temporaryPath = this.registryPath + '.tmp-' + process.pid + '-' + Date.now();
    var serialized = JSON.stringify(this.data, null, 2) + '\n';
    var handle;

    await fsPromises.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fsPromises.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 384 });
    handle = await fsPromises.open(temporaryPath, 'r');
    await handle.sync();
    await handle.close();

    if (!this.recoveredFromBackup) {
        try {
            await fsPromises.copyFile(this.registryPath, this.backupPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                await fsPromises.rm(temporaryPath, { force: true });
                throw error;
            }
        }
    }

    await fsPromises.rename(temporaryPath, this.registryPath);
    this.recoveredFromBackup = false;
};

ProjectRegistry.prototype.list = async function () {
    var projects = await Promise.all(this.data.projects.map(async function (project) {
        var status = await projectStatus(project);
        return Object.assign({}, project, {
            valid: status.valid,
            error: status.error
        });
    }));

    return {
        version: this.data.version,
        activeProjectId: this.data.activeProjectId,
        projects: projects,
        diagnostic: this.diagnostic
    };
};

ProjectRegistry.prototype.get = function (projectId) {
    return this.data.projects.find(function (project) { return project.id === projectId; }) || null;
};

ProjectRegistry.prototype.getActive = function () {
    return this.get(this.data.activeProjectId);
};

ProjectRegistry.prototype.findValidFallback = async function () {
    var candidates = this.data.projects.slice().sort(function (left, right) {
        return String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt));
    });
    for (var index = 0; index < candidates.length; index += 1) {
        if ((await projectStatus(candidates[index])).valid) {
            return candidates[index];
        }
    }
    return null;
};

ProjectRegistry.prototype.ensureActiveSelection = async function () {
    var active = this.getActive();
    if (!active || (await projectStatus(active)).valid) {
        return;
    }
    var fallback = await this.findValidFallback();
    this.data.activeProjectId = fallback ? fallback.id : null;
    await this.save();
};

ProjectRegistry.prototype.addPath = async function (rootPath, selectProject) {
    var resolved = await resolveProject(rootPath);
    var existing = this.data.projects.find(function (project) { return project.rootPath === resolved.rootPath; });
    var now = new Date().toISOString();

    if (existing) {
        existing.name = resolved.name;
        existing.openspecPath = resolved.openspecPath;
        if (selectProject !== false) {
            existing.lastOpenedAt = now;
            this.data.activeProjectId = existing.id;
        }
        await this.save();
        return existing;
    }

    var project = {
        id: crypto.randomUUID(),
        name: resolved.name,
        rootPath: resolved.rootPath,
        openspecPath: resolved.openspecPath,
        addedAt: now,
        lastOpenedAt: now
    };
    this.data.projects.push(project);
    if (selectProject !== false || !this.data.activeProjectId) {
        this.data.activeProjectId = project.id;
    }
    await this.save();
    return project;
};

ProjectRegistry.prototype.addPaths = async function (rootPaths) {
    var added = [];
    for (var index = 0; index < rootPaths.length; index += 1) {
        added.push(await this.addPath(rootPaths[index], index === rootPaths.length - 1));
    }
    return added;
};

ProjectRegistry.prototype.select = async function (projectId) {
    var project = this.get(projectId);
    var resolved;
    if (!project) {
        throw new Error('项目不存在');
    }
    resolved = await resolveProject(project.rootPath);
    if (resolved.openspecPath !== project.openspecPath) {
        throw new Error('OpenSpec 路径已变化，请重新关联项目');
    }
    project.lastOpenedAt = new Date().toISOString();
    this.data.activeProjectId = project.id;
    await this.save();
    return project;
};

ProjectRegistry.prototype.remove = async function (projectId) {
    var before = this.data.projects.length;
    this.data.projects = this.data.projects.filter(function (project) { return project.id !== projectId; });
    if (this.data.projects.length === before) {
        throw new Error('项目不存在');
    }
    if (this.data.activeProjectId === projectId) {
        var fallback = await this.findValidFallback();
        this.data.activeProjectId = fallback ? fallback.id : null;
    }
    await this.save();
    return this.data.activeProjectId;
};

ProjectRegistry.prototype.relink = async function (projectId, rootPath) {
    var project = this.get(projectId);
    var resolved;
    var duplicate;
    if (!project) {
        throw new Error('项目不存在');
    }
    resolved = await resolveProject(rootPath);
    duplicate = this.data.projects.find(function (item) { return item.id !== projectId && item.rootPath === resolved.rootPath; });
    if (duplicate) {
        throw new Error('该路径已关联到项目：' + duplicate.name);
    }
    project.name = resolved.name;
    project.rootPath = resolved.rootPath;
    project.openspecPath = resolved.openspecPath;
    project.lastOpenedAt = new Date().toISOString();
    await this.save();
    return project;
};

ProjectRegistry.prototype.scan = async function (parentPath) {
    var parent = path.resolve(parentPath);
    var candidates = [];
    var seen = new Set();
    var queue = [{ directory: parent, depth: 0 }];

    if (!await pathIsReadableDirectory(parent)) {
        throw new Error('扫描目录不存在或不可读取：' + parent);
    }

    while (queue.length) {
        var item = queue.shift();
        var entries;
        var rootStat;
        try {
            rootStat = await fsPromises.lstat(item.directory);
            if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
                continue;
            }
            entries = await fsPromises.readdir(item.directory, { withFileTypes: true });
        } catch (error) {
            continue;
        }

        var hasOpenSpec = entries.some(function (entry) {
            return entry.name === 'openspec' && entry.isDirectory() && !entry.isSymbolicLink();
        });
        if (hasOpenSpec) {
            try {
                var resolved = await resolveProject(item.directory);
                if (!seen.has(resolved.rootPath)) {
                    seen.add(resolved.rootPath);
                    candidates.push(Object.assign({}, resolved, {
                        registered: this.data.projects.some(function (project) { return project.rootPath === resolved.rootPath; })
                    }));
                }
            } catch (error) {
                // A candidate can disappear during a scan; skip it and continue.
            }
        }

        if (item.depth >= this.maxDepth) {
            continue;
        }
        entries.forEach(function (entry) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'openspec' || EXCLUDED_DIRECTORIES.has(entry.name)) {
                return;
            }
            queue.push({ directory: path.join(item.directory, entry.name), depth: item.depth + 1 });
        });
    }

    candidates.sort(function (left, right) { return left.name.localeCompare(right.name) || left.rootPath.localeCompare(right.rootPath); });
    return candidates;
};

module.exports = {
    DEFAULT_MAX_DEPTH: DEFAULT_MAX_DEPTH,
    EXCLUDED_DIRECTORIES: EXCLUDED_DIRECTORIES,
    ProjectRegistry: ProjectRegistry,
    resolveProject: resolveProject
};
