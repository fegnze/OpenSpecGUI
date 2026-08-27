'use strict';

var crypto = require('node:crypto');
var fs = require('node:fs');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var contract = require('./initiative-contract');

var PROVIDER_ID = 'openspec-embedded-app-v1';
var MANIFEST_NAME = 'initiative-app.json';
var MANIFEST_SCHEMA_VERSION = 1;
var MANIFEST_SCHEMA_URI = 'https://openspec.dev/schemas/initiative-app-v1.json';
var MAX_MANIFEST_BYTES = 128 * 1024;
var MAX_APPS = 128;
var MAX_ROOT_ENTRIES = 512;
var MAX_COLLECTION_ENTRIES = 1024;
var MAX_SCAN_ENTRIES = 8192;
var MAX_TREE_DEPTH = 32;
var MAX_FILES = 4096;
var MAX_FILE_BYTES = 16 * 1024 * 1024;
var MAX_TOTAL_BYTES = 96 * 1024 * 1024;
var READ_CHUNK_BYTES = 64 * 1024;
var RESERVED_COLLECTIONS = Object.freeze(['archive', 'archives', 'changes', 'specs']);
var ALLOWED_ACTIONS = Object.freeze(['openspec.open-change']);

function toPosix(value) {
    return value.split(path.sep).join('/');
}

function isWithin(rootPath, targetPath) {
    var relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(label + '必须是普通对象');
    }
    return value;
}

function assertAllowedKeys(value, allowed, label) {
    Object.keys(value).forEach(function (key) {
        if (allowed.indexOf(key) === -1) {
            throw new Error(label + '包含未支持字段：' + key);
        }
    });
}

function requireText(value, label, maximum) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
        throw new Error(label + '不能为空');
    }
    if (text.length > maximum || text.indexOf('\0') !== -1) {
        throw new Error(label + '超过限制');
    }
    return text;
}

function optionalText(value, label, maximum) {
    if (value === undefined || value === null || value === '') {
        return '';
    }
    return requireText(value, label, maximum);
}

function validateRelativePath(value, label) {
    var relativePath = requireText(value, label, 512);
    var segments;
    if (path.isAbsolute(relativePath) || relativePath.charAt(0) === '/' || relativePath.indexOf('\\') !== -1 || relativePath.indexOf('%') !== -1 || relativePath.indexOf('?') !== -1 || relativePath.indexOf('#') !== -1 || /[\x00-\x1f\x7f]/.test(relativePath) || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) {
        throw new Error(label + '必须是安全相对路径');
    }
    segments = relativePath.split('/');
    if (segments.some(function (segment) { return !segment || segment === '.' || segment === '..'; })) {
        throw new Error(label + '必须是安全相对路径');
    }
    return segments.join('/');
}

function validateActionPath(value) {
    var actionPath = requireText(value, '宿主动作路径', 256);
    var decoded;
    if (actionPath.charAt(0) !== '/' || actionPath.indexOf('\\') !== -1 || actionPath.indexOf('%') !== -1 || actionPath.indexOf('?') !== -1 || actionPath.indexOf('#') !== -1 || /[\x00-\x1f\x7f]/.test(actionPath)) {
        throw new Error('宿主动作路径格式无效');
    }
    try {
        decoded = decodeURIComponent(actionPath);
    } catch (error) {
        throw new Error('宿主动作路径编码无效');
    }
    if (decoded.indexOf('\0') !== -1 || decoded.split('/').some(function (segment, index) {
        return index > 0 && (!segment || segment === '.' || segment === '..');
    })) {
        throw new Error('宿主动作路径格式无效');
    }
    return actionPath;
}

function normalizeActions(value) {
    var actions = value === undefined ? {} : assertPlainObject(value, '宿主动作');
    var normalized = {};
    if (Object.keys(actions).length > 16) {
        throw new Error('宿主动作数量超过限制');
    }
    Object.keys(actions).sort().forEach(function (requestPath) {
        var actionId = requireText(actions[requestPath], '宿主动作 ID', 80);
        if (ALLOWED_ACTIONS.indexOf(actionId) === -1) {
            throw new Error('宿主动作不受支持：' + actionId);
        }
        normalized[validateActionPath(requestPath)] = actionId;
    });
    return normalized;
}

async function readPathChain(rootPath, targetPath) {
    var relative = path.relative(rootPath, targetPath);
    var segments;
    var current = rootPath;
    var chain = [];
    if (!isWithin(rootPath, targetPath)) {
        throw new Error('路径超出 Initiative 目录');
    }
    segments = relative ? relative.split(path.sep) : [];
    for (var index = -1; index < segments.length; index += 1) {
        if (index >= 0) {
            current = path.join(current, segments[index]);
        }
        var stat = await fsPromises.lstat(current, { bigint: true });
        if (stat.isSymbolicLink()) {
            throw new Error('拒绝符号链接路径：' + toPosix(relative));
        }
        chain.push(stat);
    }
    return chain;
}

async function assertNoSymlink(rootPath, targetPath) {
    await readPathChain(rootPath, targetPath);
}

function sameFileIdentity(left, right) {
    return left && right && left.dev !== undefined && left.ino !== undefined &&
        right.dev !== undefined && right.ino !== undefined &&
        String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function samePathChain(left, right) {
    return left.length === right.length && left.every(function (stat, index) {
        return sameFileIdentity(stat, right[index]);
    });
}

async function assertOpenedFileWithin(rootPath, targetPath, openedStat) {
    var firstChain = await readPathChain(rootPath, targetPath);
    var firstResolved = await fsPromises.realpath(targetPath);
    var firstTargetStat = firstChain[firstChain.length - 1];
    if (path.normalize(firstResolved) !== path.normalize(targetPath) || !isWithin(rootPath, firstResolved) ||
        !firstTargetStat.isFile() || !sameFileIdentity(openedStat, firstTargetStat)) {
        throw new Error('打开文件与已验证路径不一致');
    }
    var secondChain = await readPathChain(rootPath, targetPath);
    var secondResolved = await fsPromises.realpath(targetPath);
    var secondTargetStat = secondChain[secondChain.length - 1];
    if (path.normalize(secondResolved) !== path.normalize(firstResolved) ||
        !samePathChain(firstChain, secondChain) || !sameFileIdentity(openedStat, secondTargetStat)) {
        throw new Error('文件路径在验证期间发生变化');
    }
}

async function readDirectoryEntries(directory, maximumEntries, label) {
    var handle = await fsPromises.opendir(directory);
    var entries = [];
    try {
        var entry;
        while ((entry = await handle.read()) !== null) {
            if (entries.length >= maximumEntries) {
                throw new Error(label + '超过限制');
            }
            entries.push(entry);
        }
    } finally {
        await handle.close();
    }
    return entries;
}

async function readHandleContent(handle, maximumBytes, label) {
    var chunks = [];
    var totalBytes = 0;
    while (totalBytes <= maximumBytes) {
        var remaining = maximumBytes + 1 - totalBytes;
        var buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
        var result = await handle.read(buffer, 0, buffer.length, null);
        var bytesRead = Number(result && result.bytesRead);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) {
            throw new Error(label + '读取结果无效');
        }
        if (bytesRead === 0) {
            break;
        }
        totalBytes += bytesRead;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        if (totalBytes > maximumBytes) {
            throw new Error(label + '超过读取限制');
        }
    }
    return Buffer.concat(chunks, totalBytes);
}

async function readRegularFile(rootPath, targetPath, maximumBytes, label, openFile) {
    var realPath;
    var handle;
    var stat;
    var content;
    await assertNoSymlink(rootPath, targetPath);
    realPath = await fsPromises.realpath(targetPath);
    if (!isWithin(rootPath, realPath)) {
        throw new Error(label + '超出允许目录');
    }
    handle = await (openFile || fsPromises.open)(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        stat = await handle.stat({ bigint: true });
        if (!stat.isFile()) {
            throw new Error(label + '不是普通文件');
        }
        if (BigInt(stat.size) > BigInt(maximumBytes)) {
            throw new Error(label + '超过读取限制');
        }
        await assertOpenedFileWithin(rootPath, realPath, stat);
        content = await readHandleContent(handle, maximumBytes, label);
        await assertOpenedFileWithin(rootPath, realPath, stat);
        return { realPath: realPath, size: content.byteLength, content: content };
    } finally {
        await handle.close();
    }
}

function validateManifestShape(manifest, collection, initiativeId) {
    var presentation;
    var manifestId;
    var schemaUri;
    var presentationType;
    var supported;
    var unsupportedReasons = [];
    assertPlainObject(manifest, 'Initiative App 清单');
    schemaUri = requireText(manifest.$schema, 'Initiative App $schema', 512);
    if (!/^[\x21-\x7e]+$/.test(schemaUri)) {
        throw new Error('Initiative App $schema 格式无效');
    }
    if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
        throw new Error('Initiative App schemaVersion 格式无效');
    }
    manifestId = contract.normalizeIdentifier(manifest.id, 'Initiative ID');
    if (manifestId !== initiativeId) {
        throw new Error('Initiative 目录名与清单 ID 不一致');
    }
    presentation = assertPlainObject(manifest.presentation, 'presentation');
    presentationType = requireText(presentation.type, 'presentation.type', 80);
    if (!contract.IDENTIFIER_PATTERN.test(presentationType)) {
        throw new Error('presentation.type 格式无效');
    }
    if (schemaUri !== MANIFEST_SCHEMA_URI) {
        unsupportedReasons.push('$schema');
    }
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        unsupportedReasons.push('schemaVersion');
    }
    if (presentationType !== 'embedded-app') {
        unsupportedReasons.push('presentation.type');
    }
    supported = unsupportedReasons.length === 0;
    if (supported) {
        assertAllowedKeys(manifest, ['$schema', 'schemaVersion', 'id', 'kind', 'title', 'summary', 'presentation'], 'Initiative App 清单');
        assertAllowedKeys(presentation, ['type', 'webRoot', 'entry', 'actions'], 'presentation');
    }
    return {
        schemaUri: schemaUri,
        schemaVersion: manifest.schemaVersion,
        id: manifestId,
        collection: contract.normalizeIdentifier(collection, 'Initiative collection'),
        kind: contract.normalizeIdentifier(manifest.kind, 'Initiative 类型'),
        title: requireText(manifest.title, 'Initiative 标题', 180),
        summary: requireText(manifest.summary, 'Initiative 摘要', 1200),
        presentation: {
            type: presentationType,
            webRoot: supported ? validateRelativePath(presentation.webRoot, '静态应用根') : '',
            entry: supported ? validateRelativePath(presentation.entry, '应用首页') : '',
            actions: supported ? normalizeActions(presentation.actions) : {}
        },
        supported: supported,
        unsupportedReasons: unsupportedReasons
    };
}

async function readManifest(context, candidate) {
    var opened = await readRegularFile(context.openspecRealRoot, candidate.manifestPath, MAX_MANIFEST_BYTES, 'Initiative App 清单');
    var text = opened.content.toString('utf8');
    var manifest;
    try {
        manifest = JSON.parse(text);
    } catch (error) {
        throw new Error('Initiative App JSON 无效');
    }
    return { normalized: validateManifestShape(manifest, candidate.collection, candidate.initiativeId), content: text };
}

async function listCandidates(context) {
    var collectionEntries;
    var candidates = [];
    var candidateOverflow = false;
    try {
        collectionEntries = await readDirectoryEntries(context.openspecRealRoot, MAX_ROOT_ENTRIES, 'openspec 根目录项');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return [];
    }
    collectionEntries = collectionEntries.filter(function (entry) {
        return entry.isDirectory() && !entry.isSymbolicLink() && RESERVED_COLLECTIONS.indexOf(entry.name) === -1 && contract.IDENTIFIER_PATTERN.test(entry.name);
    }).sort(function (left, right) { return left.name.localeCompare(right.name); });

    for (var collectionIndex = 0; collectionIndex < collectionEntries.length; collectionIndex += 1) {
        var collection = collectionEntries[collectionIndex].name;
        var collectionPath = path.join(context.openspecRealRoot, collection);
        var initiativeEntries;
        try {
            initiativeEntries = await readDirectoryEntries(collectionPath, MAX_COLLECTION_ENTRIES, 'Initiative collection 目录项：' + collection);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            continue;
        }
        var sortedInitiatives = initiativeEntries.filter(function (entry) {
            return entry.isDirectory() && !entry.isSymbolicLink() && contract.IDENTIFIER_PATTERN.test(entry.name);
        }).sort(function (left, right) { return left.name.localeCompare(right.name); });
        for (var initiativeIndex = 0; initiativeIndex < sortedInitiatives.length; initiativeIndex += 1) {
            var entry = sortedInitiatives[initiativeIndex];
            var manifestPath = path.join(collectionPath, entry.name, MANIFEST_NAME);
            try {
                await fsPromises.lstat(manifestPath);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    continue;
                }
            }
            if (candidates.length >= MAX_APPS) {
                candidateOverflow = true;
                continue;
            }
            candidates.push({
                collection: collection,
                initiativeId: entry.name,
                initiativeRoot: path.join(collectionPath, entry.name),
                manifestPath: manifestPath
            });
        }
    }
    if (candidateOverflow) {
        throw new Error('Initiative App 候选超过 ' + MAX_APPS + ' 项');
    }
    return candidates;
}

function createScanBudget(limits) {
    var values = limits || {};
    function limit(value, fallback) {
        return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    }
    return {
        fileCount: 0,
        scanEntryCount: 0,
        totalBytes: 0,
        maxFiles: limit(values.maxFiles, MAX_FILES),
        maxScanEntries: limit(values.maxScanEntries, MAX_SCAN_ENTRIES),
        maxTotalBytes: limit(values.maxTotalBytes, MAX_TOTAL_BYTES)
    };
}

async function readStaticSnapshot(context, candidate, validated, includeContent, sharedBudget) {
    var webRoot = path.resolve(candidate.initiativeRoot, validated.normalized.presentation.webRoot);
    var webRootReal;
    var records = [];
    var files = includeContent ? new Map() : null;
    var budget = sharedBudget || createScanBudget();
    var startingBytes = budget.totalBytes;

    await assertNoSymlink(context.openspecRealRoot, webRoot);
    webRootReal = await fsPromises.realpath(webRoot);
    if (!isWithin(candidate.initiativeRoot, webRootReal)) {
        throw new Error('静态应用根超出 Initiative 目录');
    }
    if (!(await fsPromises.stat(webRootReal)).isDirectory()) {
        throw new Error('静态应用根不是目录');
    }

    async function visit(directory, relativeDirectory, depth) {
        if (depth > MAX_TREE_DEPTH) {
            throw new Error('静态应用目录深度超过限制');
        }
        var remainingEntries = Math.max(0, budget.maxScanEntries - budget.scanEntryCount);
        var entries = await readDirectoryEntries(directory, remainingEntries, '静态应用目录项');
        budget.scanEntryCount += entries.length;
        entries.sort(function (left, right) { return left.name.localeCompare(right.name); });
        for (var index = 0; index < entries.length; index += 1) {
            var entry = entries[index];
            var relativePath = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name;
            var target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error('静态应用包含符号链接：' + relativePath);
            }
            if (entry.isDirectory()) {
                await visit(target, relativePath, depth + 1);
            } else if (entry.isFile()) {
                budget.fileCount += 1;
                if (budget.fileCount > budget.maxFiles) {
                    throw new Error('静态应用文件数量超过限制');
                }
                var remainingTotalBytes = Math.max(0, budget.maxTotalBytes - budget.totalBytes);
                var opened = await readRegularFile(webRootReal, target, Math.min(MAX_FILE_BYTES, remainingTotalBytes), '静态应用文件');
                budget.totalBytes += opened.size;
                if (budget.totalBytes > budget.maxTotalBytes) {
                    throw new Error('静态应用文件总量超过限制');
                }
                var digest = crypto.createHash('sha256').update(opened.content).digest('hex');
                records.push({ path: relativePath, size: opened.size, digest: digest });
                if (includeContent) {
                    files.set(relativePath, Buffer.from(opened.content));
                }
            }
        }
    }

    await visit(webRootReal, '', 1);
    if (!records.some(function (record) { return record.path === validated.normalized.presentation.entry; })) {
        throw new Error('应用首页不存在或不是普通文件');
    }
    return {
        files: files,
        records: records,
        webRootReal: webRootReal,
        totalBytes: budget.totalBytes - startingBytes,
        manifestHash: contract.sha256(validated.content),
        sourceHash: contract.sha256(contract.stableJson({ manifest: validated.content, files: records }))
    };
}

function descriptorFromValidated(candidate, validated, snapshot, diagnostic) {
    return {
        schemaVersion: contract.DESCRIPTOR_SCHEMA_VERSION,
        id: validated.normalized.id,
        providerId: PROVIDER_ID,
        collection: validated.normalized.collection,
        type: validated.normalized.kind,
        title: validated.normalized.title,
        summary: validated.normalized.summary,
        goal: '',
        status: 'active',
        health: diagnostic ? 'attention' : 'healthy',
        changeRefs: [],
        presentation: { mode: 'embedded-app' },
        artifacts: [],
        sourceHash: snapshot.sourceHash,
        diagnostics: diagnostic ? [diagnostic] : []
    };
}

function candidateDiagnostic(context, candidate, error) {
    var message = String(error && error.message ? error.message : '未知错误');
    message = message.split(context.openspecRealRoot).join('<openspec>');
    message = message.split(context.projectRoot).join('<project>');
    return contract.diagnostic(
        'INVALID_EMBEDDED_INITIATIVE_APP', 'error', '独立 Initiative App 清单无效',
        candidate.collection + '/' + candidate.initiativeId + '：' + message,
        {
            providerId: PROVIDER_ID,
            initiativeId: contract.IDENTIFIER_PATTERN.test(candidate.initiativeId) ? candidate.initiativeId : '',
            resourceId: candidate.collection + '/' + candidate.initiativeId + '/' + MANIFEST_NAME
        }
    );
}

function unsupportedDiagnostic(candidate, validated) {
    return contract.diagnostic(
        'UNSUPPORTED_EMBEDDED_INITIATIVE_APP', 'warning', '不支持此应用',
        candidate.collection + '/' + candidate.initiativeId + ' 使用当前 OpenSpecGUI 不支持的 ' + validated.normalized.unsupportedReasons.join('、') + '。',
        {
            providerId: PROVIDER_ID,
            initiativeId: candidate.initiativeId,
            resourceId: candidate.collection + '/' + candidate.initiativeId + '/' + MANIFEST_NAME
        }
    );
}

function manifestOnlySnapshot(validated) {
    return {
        manifestHash: contract.sha256(validated.content),
        sourceHash: contract.sha256(contract.stableJson({ manifest: validated.content, unsupported: true }))
    };
}

async function scanProject(context, sharedBudget) {
    var candidates = await listCandidates(context);
    var budget = sharedBudget || createScanBudget();
    var initiatives = [];
    var diagnostics = [];
    var invalidInitiativeIds = [];
    var records = [];
    for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index];
        var manifestLoaded = false;
        try {
            var validated = await readManifest(context, candidate);
            manifestLoaded = true;
            var snapshot;
            if (validated.normalized.supported) {
                snapshot = await readStaticSnapshot(context, candidate, validated, false, budget);
                initiatives.push(descriptorFromValidated(candidate, validated, snapshot, null));
            } else {
                snapshot = manifestOnlySnapshot(validated);
                var unsupported = unsupportedDiagnostic(candidate, validated);
                initiatives.push(descriptorFromValidated(candidate, validated, snapshot, unsupported));
                diagnostics.push(unsupported);
            }
            records.push({ collection: candidate.collection, id: candidate.initiativeId, sourceHash: snapshot.sourceHash });
        } catch (error) {
            if (error.code === 'ENOENT' && !manifestLoaded) {
                continue;
            }
            var invalid = candidateDiagnostic(context, candidate, error);
            diagnostics.push(invalid);
            invalidInitiativeIds.push(candidate.initiativeId);
            records.push({ collection: candidate.collection, id: candidate.initiativeId, error: invalid.message });
        }
    }
    return {
        fingerprint: contract.sha256(contract.stableJson(records)),
        discovery: {
            initiatives: initiatives,
            diagnostics: diagnostics,
            authoritative: invalidInitiativeIds.length === 0,
            invalidInitiativeIds: invalidInitiativeIds
        }
    };
}

function EmbeddedInitiativeAppProvider(options) {
    var settings = options || {};
    this.id = PROVIDER_ID;
    this.schemaVersions = [contract.DESCRIPTOR_SCHEMA_VERSION];
    this.pendingScans = new Map();
    this.scanProject = settings.scanProject || scanProject;
    this.createScanBudget = settings.createScanBudget || function () { return createScanBudget(); };
}

EmbeddedInitiativeAppProvider.prototype.discover = async function (context) {
    var cacheKey = context.openspecRealRoot;
    var scan = this.pendingScans.get(cacheKey);
    if (scan) {
        this.pendingScans.delete(cacheKey);
    } else {
        scan = await this.scanProject(context, this.createScanBudget());
    }
    return scan.discovery;
};

EmbeddedInitiativeAppProvider.prototype.fingerprint = async function (context) {
    var cacheKey = context.openspecRealRoot;
    var scan = await this.scanProject(context, this.createScanBudget());
    var self = this;
    this.pendingScans.set(cacheKey, scan);
    setImmediate(function () {
        if (self.pendingScans.get(cacheKey) === scan) {
            self.pendingScans.delete(cacheKey);
        }
    });
    return scan.fingerprint;
};

EmbeddedInitiativeAppProvider.prototype.load = function () {
    var error = new Error('独立 Initiative App 必须通过原生 View 打开');
    error.code = 'EMBEDDED_APP_REQUIRED';
    return Promise.reject(error);
};

EmbeddedInitiativeAppProvider.prototype.readArtifact = function () {
    var error = new Error('独立 Initiative App 不提供宿主成果读取接口');
    error.code = 'EMBEDDED_APP_REQUIRED';
    return Promise.reject(error);
};

EmbeddedInitiativeAppProvider.prototype.prepareApp = async function (context, descriptor) {
    var candidate = {
        collection: descriptor.collection,
        initiativeId: descriptor.id,
        initiativeRoot: path.join(context.openspecRealRoot, descriptor.collection, descriptor.id),
        manifestPath: path.join(context.openspecRealRoot, descriptor.collection, descriptor.id, MANIFEST_NAME)
    };
    var validated = await readManifest(context, candidate);
    if (!validated.normalized.supported) {
        var unsupported = new Error('当前 OpenSpecGUI 不支持此 Initiative App');
        unsupported.code = 'UNSUPPORTED_INITIATIVE_APP';
        throw unsupported;
    }
    var snapshot = await readStaticSnapshot(context, candidate, validated, true);
    if (snapshot.sourceHash !== descriptor.sourceHash) {
        var stale = new Error('Initiative App 输出已变化，请刷新工作区');
        stale.code = 'STALE_INITIATIVE';
        throw stale;
    }
    return {
        id: descriptor.id,
        collection: descriptor.collection,
        entry: validated.normalized.presentation.entry,
        actions: validated.normalized.presentation.actions,
        manifestHash: snapshot.manifestHash,
        sourceHash: snapshot.sourceHash,
        files: snapshot.files,
        totalBytes: snapshot.totalBytes
    };
};

module.exports = {
    ALLOWED_ACTIONS: ALLOWED_ACTIONS,
    EmbeddedInitiativeAppProvider: EmbeddedInitiativeAppProvider,
    MANIFEST_NAME: MANIFEST_NAME,
    MANIFEST_SCHEMA_URI: MANIFEST_SCHEMA_URI,
    MANIFEST_SCHEMA_VERSION: MANIFEST_SCHEMA_VERSION,
    MAX_APPS: MAX_APPS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_FILES: MAX_FILES,
    MAX_SCAN_ENTRIES: MAX_SCAN_ENTRIES,
    MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
    PROVIDER_ID: PROVIDER_ID,
    RESERVED_COLLECTIONS: RESERVED_COLLECTIONS,
    createScanBudget: createScanBudget,
    isWithin: isWithin,
    listCandidates: listCandidates,
    normalizeActions: normalizeActions,
    readHandleContent: readHandleContent,
    readRegularFile: readRegularFile,
    readStaticSnapshot: readStaticSnapshot,
    scanProject: scanProject,
    validateManifestShape: validateManifestShape,
    validateRelativePath: validateRelativePath
};
