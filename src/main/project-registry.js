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
        return isPlainObject(project) && typeof project.id === 'string' && typeof project.rootPath === 'string' &&
            (project.openspecPath === null || typeof project.openspecPath === 'string');
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

/**
 * 只读取 Git 工作树定位文件的短文本，不加载仓库配置或运行命令。
 * @param {string} targetPath 定位文件路径
 * @returns {Promise<string>} 有效文本或空字符串
 */
async function readGitLocation(targetPath) {
    var limit = 4096;
    var handle;
    try {
        handle = await fsPromises.open(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        var stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) { return ''; }
        var buffer = Buffer.alloc(limit + 1);
        var result = await handle.read(buffer, 0, buffer.length, 0);
        if (result.bytesRead > limit) { return ''; }
        return buffer.toString('utf8', 0, result.bytesRead).trimEnd();
    } catch (error) {
        return '';
    } finally {
        if (handle) { await handle.close(); }
    }
}

/**
 * 检查目录自身的 Git 元数据，支持常规仓库和带定位文件的工作树。
 * @param {string} rootPath 已规范化项目根目录
 * @returns {Promise<boolean>} 是否具有有效的工作树元数据
 */
async function hasGitWorkingTree(rootPath) {
    var gitPath = path.join(rootPath, '.git');
    try {
        var marker = await fsPromises.lstat(gitPath);
        if (marker.isFile()) {
            var pointer = /^gitdir: ([^\r\n\0]+)$/.exec(await readGitLocation(gitPath));
            if (!pointer) { return false; }
            gitPath = path.resolve(rootPath, pointer[1]);
        } else if (!marker.isDirectory()) {
            return false;
        }

        var head = await readGitLocation(path.join(gitPath, 'HEAD'));
        if (!/^ref: refs\/[^\r\n\0]+$|^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) { return false; }
        var common = await readGitLocation(path.join(gitPath, 'commondir'));
        if (common && /[\r\n\0]/.test(common)) { return false; }
        return pathIsReadableDirectory(path.resolve(gitPath, common, 'objects'));
    } catch (error) {
        return false;
    }
}

/**
 * 解析当前检出中可读且位于项目内的 OpenSpec 目录。
 * @param {string} rootPath 已规范化项目根目录
 * @returns {Promise<string|null>} OpenSpec 的真实路径
 */
async function findOpenSpecPath(rootPath) {
    var openspecPath = path.join(rootPath, 'openspec');
    try {
        if (!await pathIsReadableDirectory(openspecPath)) { return null; }
        var realPath = await fsPromises.realpath(openspecPath);
        var relative = path.relative(rootPath, realPath);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? realPath : null;
    } catch (error) {
        return null;
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
    var openspecPath = await findOpenSpecPath(realRoot);
    if (!openspecPath && !await hasGitWorkingTree(realRoot)) {
        throw new Error('所选目录不是 Git 工作树根目录，也没有可读取的 openspec/：' + realRoot);
    }

    return {
        name: path.basename(realRoot),
        rootPath: realRoot,
        openspecPath: openspecPath
    };
}

async function projectStatus(project) {
    try {
        var resolved = await resolveProject(project.rootPath);
        if (resolved.rootPath !== project.rootPath) {
            return { valid: false, openspecPath: null, error: '项目根目录已变化，请重新关联' };
        }
        return { valid: true, openspecPath: resolved.openspecPath, error: null };
    } catch (error) {
        return { valid: false, openspecPath: null, error: error.message };
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
        return Object.assign({}, project, status);
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

ProjectRegistry.prototype.inspect = function (project) {
    return projectStatus(project);
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
    if (!project) {
        throw new Error('项目不存在');
    }
    var status = await projectStatus(project);
    if (!status.valid) {
        throw new Error(status.error);
    }
    project.openspecPath = status.openspecPath;
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

        var hasProjectMarker = entries.some(function (entry) {
            return (entry.name === 'openspec' && entry.isDirectory()) ||
                (entry.name === '.git' && (entry.isDirectory() || entry.isFile()));
        });
        if (hasProjectMarker) {
            try {
                var resolved = await resolveProject(item.directory);
                if (!seen.has(resolved.rootPath)) {
                    seen.add(resolved.rootPath);
                    candidates.push(Object.assign({}, resolved, {
                        registered: this.data.projects.some(function (project) { return project.rootPath === resolved.rootPath; })
                    }));
                }
            } catch (error) {
                // 扫描结果允许跳过无效或已消失的候选项。
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
