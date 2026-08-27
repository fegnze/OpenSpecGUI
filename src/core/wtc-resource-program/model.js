'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var CHANGE_STATUSES = [
    'planned', 'ready', 'active', 'verification', 'accepted', 'rework', 'blocked', 'needs-review'
];
var GATE_STATUSES = ['pending', 'reviewing', 'passed', 'failed'];
var GATE_TYPES = ['contract', 'delivery', 'milestone'];
var IMPACT_CONCLUSIONS = ['unaffected', 'update_required', 'reverify_required', 'invalidated'];
var ASSIGNMENT_STATUSES = ['planned', 'active', 'awaiting-verification', 'accepted', 'rework', 'blocked'];
var CHANGE_KINDS = ['contract', 'foundation', 'vertical-slice', 'migration-batch', 'quality', 'cutover'];
var RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
var RESOURCE_SOURCE_ACCESS = ['none', 'read', 'modify'];

/**
 * 读取 JSON 文件。
 * @param {string} filePath - JSON 文件路径。
 * @returns {Object} 解析结果。
 */
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 生成稳定排序的 JSON 文本。
 * @param {*} value - 待序列化值。
 * @returns {string} 稳定 JSON。
 */
function stableJson(value) {
    function normalize(input) {
        var result;
        if (Array.isArray(input)) {
            return input.map(normalize);
        }
        if (input && typeof input === 'object') {
            result = {};
            Object.keys(input).sort().forEach(function (key) {
                result[key] = normalize(input[key]);
            });
            return result;
        }
        return input;
    }
    return JSON.stringify(normalize(value), null, 2) + '\n';
}

/**
 * 计算文本 SHA-256。
 * @param {string|Buffer} value - 输入内容。
 * @returns {string} 十六进制摘要。
 */
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 计算文件 SHA-256。
 * @param {string} filePath - 文件路径。
 * @returns {string} 十六进制摘要。
 */
function sha256File(filePath) {
    return sha256(fs.readFileSync(filePath));
}

/**
 * 安全解析仓库相对路径。
 * @param {string} root - 仓库根目录。
 * @param {string} relativePath - 仓库相对路径。
 * @returns {string} 绝对路径。
 */
function resolveRepositoryPath(root, relativePath) {
    var normalizedRoot = path.resolve(root);
    var absolutePath;
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
        throw new Error('path must be repository-relative: ' + relativePath);
    }
    absolutePath = path.resolve(normalizedRoot, relativePath);
    if (absolutePath !== normalizedRoot && absolutePath.indexOf(normalizedRoot + path.sep) !== 0) {
        throw new Error('path escapes repository root: ' + relativePath);
    }
    return absolutePath;
}

function readPathStat(filePath) {
    try {
        return fs.lstatSync(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function isArchiveNameForChange(name, changeId) {
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(changeId)) {
        return name === changeId;
    }
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name) && name.slice(11) === changeId;
}

/**
 * 解析已登记 Change 的 active 或唯一归档目录。
 * @param {string} root - 仓库根目录。
 * @param {string} changeId - Change ID。
 * @returns {Object} Change 目录解析结果。
 */
function resolveChangeDirectory(root, changeId) {
    var changesRelative = 'openspec/changes';
    var changesRoot = resolveRepositoryPath(root, changesRelative);
    var changesRootStat = readPathStat(changesRoot);
    var activeRelative = path.posix.join(changesRelative, changeId);
    var activePath = resolveRepositoryPath(root, activeRelative);
    var activeStat = readPathStat(activePath);
    var archiveRelative = path.posix.join(changesRelative, 'archive');
    var archivePath = resolveRepositoryPath(root, archiveRelative);
    var archiveStat;
    var archiveNames = [];
    var candidates;
    var invalidBareArchive;
    var candidateRelative;
    var candidatePath;
    var candidateStat;
    var realChangesRoot;
    var realCandidate;
    var realRoot;

    function result(relativePath, absolutePath, archived, directoryExists, unsafe) {
        return {
            absolutePath: absolutePath,
            archived: archived,
            directoryExists: directoryExists,
            relativePath: relativePath,
            unsafe: unsafe
        };
    }

    if (typeof changeId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) {
        return result(activeRelative, activePath, false, false, true);
    }
    if (!changesRootStat || changesRootStat.isSymbolicLink() || !changesRootStat.isDirectory()) {
        return result(activeRelative, activePath, false, false, true);
    }
    realRoot = fs.realpathSync(root);
    realChangesRoot = fs.realpathSync(changesRoot);
    if (realChangesRoot.indexOf(realRoot + path.sep) !== 0) {
        return result(activeRelative, activePath, false, false, true);
    }
    archiveStat = readPathStat(archivePath);
    if (archiveStat && (archiveStat.isSymbolicLink() || !archiveStat.isDirectory())) {
        return result(activeRelative, activePath, false, false, true);
    }
    if (archiveStat) {
        archiveNames = fs.readdirSync(archivePath);
    }
    invalidBareArchive = !/^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(changeId) &&
        archiveNames.indexOf(changeId) !== -1;
    candidates = archiveNames.filter(function (name) {
        return isArchiveNameForChange(name, changeId);
    }).sort();
    if (invalidBareArchive || candidates.length > 1 || (activeStat && candidates.length > 0)) {
        return result(activeRelative, activePath, false, false, true);
    }
    if (activeStat) {
        if (activeStat.isSymbolicLink() || !activeStat.isDirectory()) {
            return result(activeRelative, activePath, false, false, true);
        }
        realCandidate = fs.realpathSync(activePath);
        return result(activeRelative, activePath, false, true,
            realCandidate.indexOf(realChangesRoot + path.sep) !== 0);
    }
    if (candidates.length === 0) {
        return result(activeRelative, activePath, false, false, false);
    }
    candidateRelative = path.posix.join(archiveRelative, candidates[0]);
    candidatePath = resolveRepositoryPath(root, candidateRelative);
    candidateStat = readPathStat(candidatePath);
    if (!candidateStat || candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
        return result(candidateRelative, candidatePath, true, false, true);
    }
    realChangesRoot = fs.realpathSync(changesRoot);
    realCandidate = fs.realpathSync(candidatePath);
    return result(candidateRelative, candidatePath, true, true,
        realCandidate.indexOf(realChangesRoot + path.sep) !== 0);
}

/**
 * 递归列出文本文件。
 * @param {string} root - 仓库根目录。
 * @param {string} relativePath - 起始相对路径。
 * @returns {string[]} 排序后的仓库相对路径。
 */
function listTextFiles(root, relativePath, traversal) {
    var absolutePath = resolveRepositoryPath(root, relativePath);
    var result = [];
    var rootStat;
    var state = traversal || { entries: 0 };
    var allowedExtensions = {
        '': true,
        '.html': true,
        '.js': true,
        '.json': true,
        '.md': true,
        '.yaml': true,
        '.yml': true
    };
    state.entries += 1;
    if (state.entries > 10000) {
        throw new Error('governed text tree exceeds its entry limit');
    }
    try {
        rootStat = fs.lstatSync(absolutePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return result;
        }
        throw error;
    }
    if (rootStat.isSymbolicLink()) {
        throw new Error('symbolic links are not allowed in governed text trees: ' + relativePath);
    }
    if (!rootStat.isDirectory()) {
        return allowedExtensions[path.extname(absolutePath).toLowerCase()] ? [relativePath] : [];
    }
    fs.readdirSync(absolutePath).sort().forEach(function (name) {
        var child = path.posix.join(relativePath, name);
        var childPath = resolveRepositoryPath(root, child);
        var childStat = fs.lstatSync(childPath);
        if (childStat.isSymbolicLink()) {
            throw new Error('symbolic links are not allowed in governed text trees: ' + child);
        }
        if (childStat.isDirectory()) {
            result = result.concat(listTextFiles(root, child, state));
        } else if (allowedExtensions[path.extname(name).toLowerCase()]) {
            result.push(child);
        }
    });
    return result;
}

function stripInlineMarkdown(value) {
    return value
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .trim();
}

/**
 * 解析 OpenSpec tasks.md。
 * @param {string} markdown - Markdown 内容。
 * @returns {Object} 任务统计和任务列表。
 */
function parseTasks(markdown) {
    var groups = [];
    var currentGroup = null;
    var tasks = [];
    markdown.split(/\r?\n/).forEach(function (line) {
        var heading = line.match(/^##\s+(.+)$/);
        var task = line.match(/^- \[([ xX])\]\s+([0-9]+(?:\.[0-9]+)*)\s+(.+)$/);
        var parsed;
        if (heading) {
            currentGroup = { name: stripInlineMarkdown(heading[1]), tasks: [] };
            groups.push(currentGroup);
        } else if (task) {
            if (!currentGroup) {
                currentGroup = { name: 'Tasks', tasks: [] };
                groups.push(currentGroup);
            }
            parsed = {
                taskId: task[2],
                text: stripInlineMarkdown(task[3]),
                done: task[1].toLowerCase() === 'x'
            };
            currentGroup.tasks.push(parsed);
            tasks.push(parsed);
        }
    });
    return {
        completed: tasks.filter(function (task) { return task.done; }).length,
        total: tasks.length,
        groups: groups.filter(function (group) { return group.tasks.length > 0; }),
        tasks: tasks
    };
}

/**
 * 读取一个已登记 Change 的官方 OpenSpec 工件摘要。
 * @param {string} root - 仓库根目录。
 * @param {string} changeId - Change ID。
 * @returns {Object} Change 工件摘要。
 */
function readChangeArtifacts(root, changeId) {
    var resolved = resolveChangeDirectory(root, changeId);
    var base = resolved.relativePath;
    var basePath = resolved.absolutePath;
    var directoryExists = resolved.directoryExists;
    var unsafe = resolved.unsafe;
    var proposalPath = resolveRepositoryPath(root, path.posix.join(base, 'proposal.md'));
    var designPath = resolveRepositoryPath(root, path.posix.join(base, 'design.md'));
    var tasksPath = resolveRepositoryPath(root, path.posix.join(base, 'tasks.md'));
    var proposal;
    var title;
    var changeFiles;
    var specFiles;
    var proposalExists;
    var designExists;
    var tasksExists;

    function safeFile(filePath) {
        return fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink() &&
            fs.statSync(filePath).isFile() &&
            fs.realpathSync(filePath).indexOf(fs.realpathSync(basePath) + path.sep) === 0;
    }

    if (!directoryExists || unsafe) {
        return {
            absolutePath: basePath,
            archived: resolved.archived,
            changeId: changeId,
            directoryExists: false,
            relativePath: base,
            unsafe: unsafe,
            proposalExists: false,
            designExists: false,
            tasksExists: false,
            specFiles: [],
            title: changeId,
            tasks: { completed: 0, total: 0, groups: [], tasks: [] }
        };
    }
    proposalExists = safeFile(proposalPath);
    designExists = safeFile(designPath);
    tasksExists = safeFile(tasksPath);
    unsafe = (!proposalExists && fs.existsSync(proposalPath)) ||
        (!designExists && fs.existsSync(designPath)) || (!tasksExists && fs.existsSync(tasksPath));
    proposal = proposalExists ? fs.readFileSync(proposalPath, 'utf8') : '';
    title = proposal.match(/^#\s+Proposal:\s*(.+)$/m);
    try {
        changeFiles = listTextFiles(root, base);
        specFiles = changeFiles.filter(function (filePath) {
            return /\/spec\.md$/.test(filePath);
        });
    } catch (error) {
        unsafe = true;
        specFiles = [];
    }
    return {
        absolutePath: basePath,
        archived: resolved.archived,
        changeId: changeId,
        directoryExists: true,
        relativePath: base,
        unsafe: unsafe,
        proposalExists: proposalExists,
        designExists: designExists,
        tasksExists: tasksExists,
        specFiles: specFiles,
        title: title ? stripInlineMarkdown(title[1]) : changeId,
        tasks: tasksExists ? parseTasks(fs.readFileSync(tasksPath, 'utf8')) : {
            completed: 0,
            total: 0,
            groups: [],
            tasks: []
        }
    };
}

/**
 * 计算 contract lock 的确定性摘要。
 * @param {string} root - 仓库根目录。
 * @param {string[]} paths - 被锁定的仓库相对路径。
 * @returns {string} SHA-256。
 */
function computeContractHash(root, paths) {
    var records = paths.slice().sort().map(function (relativePath) {
        var absolutePath = resolveRepositoryPath(root, relativePath);
        if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
            throw new Error('contract path does not exist: ' + relativePath);
        }
        return relativePath + '\0' + sha256File(absolutePath);
    });
    return sha256(records.join('\n'));
}

/**
 * 生成 contract consumer 的稳定复合键。
 * @param {string} lockId - Contract lock ID。
 * @param {string} changeId - 消费者 Change ID。
 * @returns {string} 复合键。
 */
function contractConsumptionKey(lockId, changeId) {
    return lockId + '\0' + changeId;
}

/**
 * 生成绑定 revision 的 impact review 复合键。
 * @param {string} lockId - Contract lock ID。
 * @param {string} changeId - 消费者 Change ID。
 * @param {number} revision - Contract lock revision。
 * @returns {string} 复合键。
 */
function impactReviewKey(lockId, changeId, revision) {
    return contractConsumptionKey(lockId, changeId) + '\0' + revision;
}

module.exports = {
    ASSIGNMENT_STATUSES: ASSIGNMENT_STATUSES,
    CHANGE_KINDS: CHANGE_KINDS,
    CHANGE_STATUSES: CHANGE_STATUSES,
    GATE_STATUSES: GATE_STATUSES,
    GATE_TYPES: GATE_TYPES,
    IMPACT_CONCLUSIONS: IMPACT_CONCLUSIONS,
    RISK_LEVELS: RISK_LEVELS,
    RESOURCE_SOURCE_ACCESS: RESOURCE_SOURCE_ACCESS,
    computeContractHash: computeContractHash,
    contractConsumptionKey: contractConsumptionKey,
    impactReviewKey: impactReviewKey,
    listTextFiles: listTextFiles,
    parseTasks: parseTasks,
    readChangeArtifacts: readChangeArtifacts,
    readJson: readJson,
    resolveChangeDirectory: resolveChangeDirectory,
    resolveRepositoryPath: resolveRepositoryPath,
    sha256: sha256,
    sha256File: sha256File,
    stableJson: stableJson
};
