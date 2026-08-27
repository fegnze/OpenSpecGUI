'use strict';

var fs = require('fs');
var path = require('path');
var artifactCatalog = require('./wtc-resource-program/artifact-catalog');
var model = require('./wtc-resource-program/model');
var schemaValidator = require('./wtc-resource-program/schema-validator');
var hostContract = require('./initiative-contract');

var PROVIDER_ID = 'wtc-resource-program-v1';
var SCHEMA_VERSION = 1;
var PROGRAMS_RELATIVE_PATH = 'openspec/programs';
var MAX_ARTIFACT_BYTES = 2097152;
var MAX_AUTHORITY_BYTES = 4194304;
var MAX_SOURCE_FILE_BYTES = 16777216;
var MAX_PROGRAM_CANDIDATES = 128;
var MAX_CONTRACT_FILES = 256;
var DISCOVERY_AUTHORITY = [
    { key: 'program', file: 'program.json', schema: 'contracts/program.schema.json' },
    { key: 'state', file: 'program-state.json', schema: 'contracts/program-state.schema.json' },
    { key: 'assignments', file: 'assignments.json', schema: 'contracts/assignments.schema.json' },
    { key: 'artifactTaxonomy', file: 'artifact-taxonomy.json',
        schema: 'contracts/artifact-taxonomy.schema.json' }
];
var OUTPUT_SCHEMAS = {
    artifactIndex: 'initiative-artifact-index.schema.json',
    artifactResponse: 'initiative-artifact-response.schema.json',
    descriptor: 'initiative-descriptor.schema.json',
    overviewSnapshot: 'initiative-overview.schema.json'
};
var SCHEMA_KEYS = [
    '$schema', '$id', '$ref', '$defs', 'title', 'type', 'additionalProperties', 'required', 'properties',
    'const', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'minItems',
    'maxItems', 'uniqueItems'
];

function diagnostic(code, severity, message, relativePath) {
    var result = { code: code, message: message, severity: severity };
    if (relativePath) {
        result.relativePath = relativePath;
    }
    return result;
}

function sortDiagnostics(values) {
    return values.sort(function (left, right) {
        return (left.severity + '\0' + left.code + '\0' + left.message + '\0' + (left.relativePath || ''))
            .localeCompare(right.severity + '\0' + right.code + '\0' + right.message + '\0' +
                (right.relativePath || ''));
    });
}

function uniqueSorted(values) {
    var seen = {};
    return (values || []).filter(function (value) {
        if (seen[value]) {
            return false;
        }
        seen[value] = true;
        return true;
    }).sort();
}

function stableClone(value) {
    return JSON.parse(model.stableJson(value));
}

function providerFileError(code, relativePath, message) {
    var error = new Error(message);
    error.providerCode = code;
    error.relativePath = relativePath;
    return error;
}

function normalizedRelativePath(root, absolutePath) {
    return path.relative(root, absolutePath).split(path.sep).join('/');
}

function isWithinBoundary(boundaryPath, targetPath) {
    var relative = path.relative(boundaryPath, targetPath);
    return relative !== '..' && relative.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(relative);
}

function mapFileSystemError(error, relativePath) {
    if (error && error.providerCode) {
        return error;
    }
    if (error && error.code === 'ENOENT') {
        return providerFileError('AUTHORITY_FILE_MISSING', relativePath,
            'Required authority file is missing.');
    }
    return providerFileError('AUTHORITY_FILE_UNREADABLE', relativePath,
        'Required authority file cannot be read.');
}

function diagnosticFromFileError(error, fallbackPath) {
    var stableError = mapFileSystemError(error, fallbackPath);
    return diagnostic(stableError.providerCode, 'error', stableError.message,
        stableError.relativePath || fallbackPath);
}

function safePath(root, boundaryRelativePath, relativePath, expectedType) {
    var repositoryRoot = path.resolve(root);
    var boundaryPath = boundaryRelativePath ?
        model.resolveRepositoryPath(root, boundaryRelativePath) : repositoryRoot;
    var absolutePath = model.resolveRepositoryPath(root, relativePath);
    var parts;
    var cursor = repositoryRoot;
    var stat;
    var realBoundary;
    var realFile;
    if (!isWithinBoundary(boundaryPath, absolutePath)) {
        throw providerFileError('AUTHORITY_PATH_OUTSIDE_BOUNDARY', relativePath,
            'Authority file is outside its trusted boundary.');
    }
    parts = path.relative(repositoryRoot, absolutePath).split(path.sep).filter(function (part) {
        return part && part !== '.';
    });
    try {
        parts.forEach(function (part, index) {
            cursor = path.join(cursor, part);
            stat = fs.lstatSync(cursor);
            if (stat.isSymbolicLink()) {
                throw providerFileError('AUTHORITY_PATH_SYMLINK',
                    normalizedRelativePath(repositoryRoot, cursor),
                    'Authority path contains a symbolic link.');
            }
            if (index < parts.length - 1 && !stat.isDirectory()) {
                throw providerFileError('AUTHORITY_PATH_SEGMENT_INVALID',
                    normalizedRelativePath(repositoryRoot, cursor),
                    'Authority path segment is not a directory.');
            }
        });
        if (!stat || (expectedType === 'file' && !stat.isFile()) ||
                (expectedType === 'directory' && !stat.isDirectory())) {
            throw providerFileError('AUTHORITY_PATH_TYPE_INVALID', relativePath,
                'Authority target has an invalid file type.');
        }
        realBoundary = fs.realpathSync(boundaryPath);
        realFile = fs.realpathSync(absolutePath);
        if (!isWithinBoundary(realBoundary, realFile)) {
            throw providerFileError('AUTHORITY_PATH_OUTSIDE_BOUNDARY', relativePath,
                'Authority file is outside its trusted boundary.');
        }
    } catch (error) {
        throw mapFileSystemError(error, relativePath);
    }
    return absolutePath;
}

function safeFile(root, boundaryRelativePath, relativePath) {
    return safePath(root, boundaryRelativePath, relativePath, 'file');
}

function safeProgramFile(root, programRelativePath, relativePath) {
    return safeFile(root, programRelativePath, relativePath);
}

function safeProgramDirectory(root, programRelativePath, relativePath) {
    return safePath(root, programRelativePath, relativePath, 'directory');
}

function safeRepositoryFile(root, relativePath) {
    return safeFile(root, '', relativePath);
}

function readJsonFile(absolutePath, relativePath) {
    try {
        if (fs.lstatSync(absolutePath).size > MAX_AUTHORITY_BYTES) {
            throw providerFileError('AUTHORITY_FILE_TOO_LARGE', relativePath,
                'Authority JSON exceeds the fixed size limit.');
        }
        return model.readJson(absolutePath);
    } catch (error) {
        if (error && error.providerCode) {
            throw error;
        }
        throw providerFileError('AUTHORITY_JSON_INVALID', relativePath,
            'Authority JSON is invalid.');
    }
}

function readProgramDirectory(root, programRelativePath, relativePath) {
    var absolutePath = safeProgramDirectory(root, programRelativePath, relativePath);
    try {
        var names = fs.readdirSync(absolutePath).sort();
        if (names.length > MAX_CONTRACT_FILES) {
            throw providerFileError('AUTHORITY_DIRECTORY_TOO_LARGE', relativePath,
                'Authority directory exceeds the fixed entry limit.');
        }
        return names;
    } catch (error) {
        throw mapFileSystemError(error, relativePath);
    }
}

function sha256File(absolutePath, relativePath) {
    try {
        if (fs.lstatSync(absolutePath).size > MAX_SOURCE_FILE_BYTES) {
            throw providerFileError('SOURCE_FILE_TOO_LARGE', relativePath,
                'Provider source file exceeds the fixed hashing limit.');
        }
        return model.sha256File(absolutePath);
    } catch (error) {
        throw mapFileSystemError(error, relativePath);
    }
}

function readTextFile(absolutePath, relativePath) {
    try {
        return fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
        throw mapFileSystemError(error, relativePath);
    }
}

function readJson(relativeRoot, root, fileName) {
    var relativePath = path.posix.join(relativeRoot, fileName);
    return readJsonFile(safeProgramFile(root, relativeRoot, relativePath), relativePath);
}

function validateSidecar(sidecar, directoryName) {
    var errors = [];
    var allowed = ['$schema', 'schemaVersion', 'providerId', 'initiativeId', 'summary'];
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
        return ['sidecar must be an object'];
    }
    Object.keys(sidecar).forEach(function (key) {
        if (allowed.indexOf(key) === -1) {
            errors.push('unsupported sidecar field: ' + key);
        }
    });
    if (sidecar.$schema !== 'contracts/initiative-provider.schema.json') {
        errors.push('sidecar schema path is unsupported');
    }
    if (sidecar.schemaVersion !== SCHEMA_VERSION) {
        errors.push('sidecar schemaVersion is unsupported');
    }
    if (sidecar.providerId !== PROVIDER_ID) {
        errors.push('sidecar providerId is unsupported');
    }
    if (sidecar.initiativeId !== directoryName ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sidecar.initiativeId || '')) {
        errors.push('sidecar initiativeId must match its directory');
    }
    if (typeof sidecar.summary !== 'string' || !sidecar.summary || sidecar.summary.length > 240) {
        errors.push('sidecar summary must contain 1 to 240 characters');
    }
    return uniqueSorted(errors);
}

function validateSchemaDefinition(schema, label) {
    var errors = [];
    var nodes = 0;

    function visit(node, location, isSchemaMap, depth) {
        nodes += 1;
        if (nodes > 10000 || depth > 64) {
            errors.push(location + ' exceeds schema complexity limits');
            return;
        }
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            errors.push(location + ' must be a schema object');
            return;
        }
        if (isSchemaMap) {
            Object.keys(node).forEach(function (key) {
                visit(node[key], location + '.' + key, false, depth + 1);
            });
            return;
        }
        Object.keys(node).forEach(function (key) {
            if (SCHEMA_KEYS.indexOf(key) === -1) {
                errors.push(location + ' uses unsupported schema keyword ' + key);
            }
        });
        if (node.$ref && !/^#(?:\/|$)/.test(node.$ref) &&
                !/^initiative-artifact-index\.schema\.json#\//.test(node.$ref) &&
                node.$ref !== 'initiative-diagnostic.schema.json') {
            errors.push(location + ' uses unsupported schema reference ' + node.$ref);
        }
        if (node.type === 'object') {
            if (node.additionalProperties !== false) {
                errors.push(location + ' object schema must set additionalProperties=false');
            }
            if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
                errors.push(location + ' object schema must define properties');
            }
        }
        if (node.type === 'array' && !node.items) {
            errors.push(location + ' array schema must define items');
        }
        if (node.properties) {
            visit(node.properties, location + '.properties', true, depth + 1);
        }
        if (node.$defs) {
            visit(node.$defs, location + '.$defs', true, depth + 1);
        }
        if (node.items) {
            visit(node.items, location + '.items', false, depth + 1);
        }
    }

    visit(schema, label || '$schema', false, 0);
    return uniqueSorted(errors);
}

function validateAuthorityDocument(root, relativeRoot, definition) {
    var documentPath = path.posix.join(relativeRoot, definition.file);
    var schemaPath = path.posix.join(relativeRoot, definition.schema);
    var document = readJsonFile(safeProgramFile(root, relativeRoot, documentPath), documentPath);
    var schema = readJsonFile(safeProgramFile(root, relativeRoot, schemaPath), schemaPath);
    var errors = validateSchemaDefinition(schema, schemaPath);
    errors = errors.concat(schemaValidator.validate(schema, document));
    if (errors.length) {
        throw providerFileError('AUTHORITY_SCHEMA_INVALID', documentPath,
            'Authority JSON does not satisfy its fixed schema.');
    }
    return document;
}

function validateDeclaredAuthorityFiles(root, relativeRoot, documents) {
    (documents.program.workstreams || []).forEach(function (workstream) {
        var relativePath = path.posix.join(relativeRoot, workstream.document);
        safeProgramFile(root, relativeRoot, relativePath);
    });
    (documents.state.contractLocks || []).forEach(function (lock) {
        (lock.paths || []).forEach(function (relativePath) {
            safeRepositoryFile(root, relativePath);
        });
    });
}

/**
 * 发现项目中声明式 Resource Program Initiative，不执行项目代码。
 * @param {string} root - 仓库根目录。
 * @returns {Object} 稳定候选与诊断。
 */
function discoverPrograms(root) {
    var programsPath = model.resolveRepositoryPath(root, PROGRAMS_RELATIVE_PATH);
    var candidates = [];
    var diagnostics = [];
    var ids = {};
    var programNames;
    var programsStat;
    if (!fs.existsSync(programsPath)) {
        return { candidates: [], diagnostics: [] };
    }
    try {
        programsStat = fs.lstatSync(programsPath);
        programNames = fs.readdirSync(programsPath).sort();
    } catch (error) {
        return { candidates: [], diagnostics: [diagnostic('PROGRAMS_ROOT_UNREADABLE', 'error',
            'openspec/programs cannot be read.', PROGRAMS_RELATIVE_PATH)] };
    }
    if (programsStat.isSymbolicLink() || !programsStat.isDirectory()) {
        return { candidates: [], diagnostics: [diagnostic('PROGRAMS_ROOT_UNSAFE', 'error',
            'openspec/programs must be a regular directory', PROGRAMS_RELATIVE_PATH)] };
    }
    if (programNames.length > MAX_PROGRAM_CANDIDATES) {
        return { candidates: [], diagnostics: [diagnostic('PROGRAM_LIMIT_EXCEEDED', 'error',
            'openspec/programs exceeds the fixed candidate limit', PROGRAMS_RELATIVE_PATH)] };
    }
    programNames.forEach(function (name) {
        var relativeRoot = path.posix.join(PROGRAMS_RELATIVE_PATH, name);
        var absoluteRoot = model.resolveRepositoryPath(root, relativeRoot);
        var sidecarPath = path.posix.join(relativeRoot, 'initiative-provider.json');
        var programPath = path.posix.join(relativeRoot, 'program.json');
        var sidecar;
        var program;
        var authority = {};
        var sidecarSchema;
        var errors;
        var stat;
        try {
            stat = fs.lstatSync(absoluteRoot);
            if (stat.isSymbolicLink()) {
                diagnostics.push(diagnostic('PROGRAM_ROOT_SYMLINK', 'error',
                    'Resource Program candidate may not be a symbolic link', relativeRoot));
                return;
            }
            if (!stat.isDirectory()) {
                return;
            }
            if (!fs.existsSync(model.resolveRepositoryPath(root, sidecarPath))) {
                if (fs.existsSync(model.resolveRepositoryPath(root, programPath))) {
                    diagnostics.push(diagnostic('SIDECAR_MISSING', 'error',
                        'program.json has no initiative-provider.json signature', relativeRoot));
                }
                return;
            }
            sidecar = readJsonFile(safeProgramFile(root, relativeRoot, sidecarPath), sidecarPath);
            sidecarSchema = readJsonFile(safeProgramFile(root, relativeRoot,
                path.posix.join(relativeRoot, 'contracts/initiative-provider.schema.json')),
                path.posix.join(relativeRoot, 'contracts/initiative-provider.schema.json'));
            errors = validateSidecar(sidecar, name);
            errors = errors.concat(validateSchemaDefinition(sidecarSchema,
                path.posix.join(relativeRoot, 'contracts/initiative-provider.schema.json')));
            errors = errors.concat(schemaValidator.validate(sidecarSchema, sidecar));
            if (errors.length) {
                errors.forEach(function (message) {
                    diagnostics.push(diagnostic('SIDECAR_INVALID', 'error', message, sidecarPath));
                });
                return;
            }
            if (!fs.existsSync(model.resolveRepositoryPath(root, programPath))) {
                diagnostics.push(diagnostic('PROGRAM_ENTRY_MISSING', 'error',
                    'signed candidate has no fixed program.json entry', relativeRoot));
                return;
            }
            DISCOVERY_AUTHORITY.forEach(function (definition) {
                authority[definition.key] = validateAuthorityDocument(root, relativeRoot, definition);
            });
            program = authority.program;
            if (program.programId !== name || program.programId !== sidecar.initiativeId) {
                diagnostics.push(diagnostic('PROGRAM_ID_MISMATCH', 'error',
                    'Program, Initiative and directory IDs must match', programPath));
                return;
            }
            if (authority.state.programId !== name || authority.assignments.programId !== name ||
                    authority.artifactTaxonomy.programId !== name) {
                diagnostics.push(diagnostic('AUTHORITY_ID_MISMATCH', 'error',
                    'Program authority document IDs must match the Initiative ID', relativeRoot));
                return;
            }
            validateDeclaredAuthorityFiles(root, relativeRoot, authority);
            if (ids[sidecar.initiativeId]) {
                diagnostics.push(diagnostic('DUPLICATE_INITIATIVE_ID', 'error',
                    'duplicate Initiative ID: ' + sidecar.initiativeId, relativeRoot));
                return;
            }
            ids[sidecar.initiativeId] = true;
            candidates.push({
                initiativeId: sidecar.initiativeId,
                programRelativePath: relativeRoot,
                providerId: PROVIDER_ID,
                schemaVersion: SCHEMA_VERSION,
                summary: sidecar.summary
            });
        } catch (error) {
            diagnostics.push(diagnosticFromFileError(error, relativeRoot));
        }
    });
    return { candidates: candidates.sort(function (left, right) {
        return left.initiativeId.localeCompare(right.initiativeId);
    }), diagnostics: sortDiagnostics(diagnostics) };
}

function loadDocuments(root, candidate) {
    var relativeRoot = candidate.programRelativePath;
    return {
        initiativeProvider: readJson(relativeRoot, root, 'initiative-provider.json'),
        program: readJson(relativeRoot, root, 'program.json'),
        state: readJson(relativeRoot, root, 'program-state.json'),
        assignments: readJson(relativeRoot, root, 'assignments.json'),
        artifactTaxonomy: readJson(relativeRoot, root, 'artifact-taxonomy.json'),
        programRelativePath: relativeRoot
    };
}

function validateDocuments(root, documents) {
    var errors = [];
    var changeIds = {};
    var gateIds = {};
    if (documents.program.programId !== documents.initiativeProvider.initiativeId ||
            documents.state.programId !== documents.program.programId ||
            documents.assignments.programId !== documents.program.programId) {
        errors.push(diagnostic('DOCUMENT_ID_MISMATCH', 'error', 'Program document IDs do not agree'));
    }
    (documents.program.changes || []).forEach(function (change) {
        var resolved;
        var artifacts;
        if (changeIds[change.changeId]) {
            errors.push(diagnostic('DUPLICATE_CHANGE', 'error', 'duplicate Change: ' + change.changeId));
            return;
        }
        changeIds[change.changeId] = true;
        resolved = model.resolveChangeDirectory(root, change.changeId);
        artifacts = model.readChangeArtifacts(root, change.changeId);
        if (!resolved.directoryExists || resolved.unsafe || !artifacts.proposalExists ||
                !artifacts.designExists || !artifacts.tasksExists || !artifacts.specFiles.length) {
            errors.push(diagnostic('CHANGE_UNRESOLVED', 'error',
                'registered Change is missing, ambiguous or unsafe: ' + change.changeId));
        }
    });
    (documents.program.gates || []).forEach(function (gate) {
        if (gateIds[gate.gateId]) {
            errors.push(diagnostic('DUPLICATE_GATE', 'error', 'duplicate gate: ' + gate.gateId));
        }
        gateIds[gate.gateId] = true;
        (gate.requiredChanges || []).forEach(function (changeId) {
            if (!changeIds[changeId]) {
                errors.push(diagnostic('GATE_CHANGE_UNREGISTERED', 'error',
                    'gate references unregistered Change: ' + gate.gateId + ' -> ' + changeId));
            }
        });
    });
    (documents.program.milestones || []).forEach(function (milestone) {
        if (!gateIds[milestone.gateId]) {
            errors.push(diagnostic('MILESTONE_GATE_UNREGISTERED', 'error',
                'milestone references unregistered gate: ' + milestone.milestoneId + ' -> ' + milestone.gateId));
        }
    });
    (documents.state.changes || []).forEach(function (change) {
        if (!changeIds[change.changeId]) {
            errors.push(diagnostic('STATE_CHANGE_UNREGISTERED', 'error',
                'state references unregistered Change: ' + change.changeId));
        }
    });
    (documents.state.gates || []).forEach(function (gate) {
        if (!gateIds[gate.gateId]) {
            errors.push(diagnostic('STATE_GATE_UNREGISTERED', 'error',
                'state references unregistered gate: ' + gate.gateId));
        }
    });
    (documents.assignments.assignments || []).forEach(function (assignment) {
        if (!changeIds[assignment.changeId]) {
            errors.push(diagnostic('ASSIGNMENT_CHANGE_UNREGISTERED', 'error',
                'assignment references unregistered Change: ' + assignment.changeId));
        }
    });
    (documents.state.contractLocks || []).forEach(function (lock) {
        var calculatedHash;
        if (!changeIds[lock.producerChangeId]) {
            errors.push(diagnostic('CONTRACT_PRODUCER_UNREGISTERED', 'error',
                'contract lock references unregistered producer Change: ' + lock.lockId));
        }
        (lock.consumerChangeIds || []).forEach(function (changeId) {
            if (!changeIds[changeId]) {
                errors.push(diagnostic('CONTRACT_CONSUMER_UNREGISTERED', 'error',
                    'contract lock references unregistered consumer Change: ' + lock.lockId + ' -> ' + changeId));
            }
        });
        try {
            calculatedHash = model.sha256((lock.paths || []).slice().sort().map(function (relativePath) {
                return relativePath + '\0' + sha256File(safeRepositoryFile(root, relativePath), relativePath);
            }).join('\n'));
            if (calculatedHash !== lock.sha256) {
                errors.push(diagnostic('CONTRACT_HASH_MISMATCH', 'error',
                    'contract lock hash does not match its declared files: ' + lock.lockId));
            }
        } catch (error) {
            errors.push(diagnostic('CONTRACT_PATH_INVALID', 'error',
                'contract lock contains an unreadable or unsafe file: ' + lock.lockId));
        }
    });
    (documents.state.blockers || []).forEach(function (blocker) {
        if (!changeIds[blocker.changeId]) {
            errors.push(diagnostic('BLOCKER_CHANGE_UNREGISTERED', 'error',
                'blocker references unregistered Change: ' + blocker.blockerId));
        }
    });
    return sortDiagnostics(errors);
}

function documentValidationError(diagnostics) {
    var error = new Error(diagnostics.map(function (item) {
        return item.code + ': ' + item.message;
    }).join('\n'));
    error.providerCode = diagnostics.length === 1 ? diagnostics[0].code : 'PROGRAM_DOCUMENT_INVALID';
    return error;
}

function safeCatalogFile(root, documents, repositoryPaths, relativePath) {
    var programRoot = documents.programRelativePath;
    var programAbsolute = model.resolveRepositoryPath(root, programRoot);
    var absolutePath = model.resolveRepositoryPath(root, relativePath);
    var matched;
    if (repositoryPaths[relativePath]) {
        return safeRepositoryFile(root, relativePath);
    }
    if (isWithinBoundary(programAbsolute, absolutePath)) {
        return safeProgramFile(root, programRoot, relativePath);
    }
    (documents.program.changes || []).some(function (change) {
        var resolved = model.resolveChangeDirectory(root, change.changeId);
        var boundaryRelativePath;
        if (!resolved.directoryExists || resolved.unsafe ||
                !isWithinBoundary(resolved.absolutePath, absolutePath)) {
            return false;
        }
        boundaryRelativePath = normalizedRelativePath(path.resolve(root), resolved.absolutePath);
        matched = safeFile(root, boundaryRelativePath, relativePath);
        return true;
    });
    if (!matched) {
        throw providerFileError('ARTIFACT_PATH_OUTSIDE_BOUNDARY', relativePath,
            'Artifact source is outside its registered boundary.');
    }
    return matched;
}

function sourceRecords(root, documents, catalog) {
    var programRoot = documents.programRelativePath;
    var repositoryPaths = {};
    var contractsRelativePath = path.posix.join(programRoot, 'contracts');
    var paths = [
        path.posix.join(programRoot, 'initiative-provider.json'),
        path.posix.join(programRoot, 'program.json'),
        path.posix.join(programRoot, 'program-state.json'),
        path.posix.join(programRoot, 'assignments.json'),
        path.posix.join(programRoot, 'artifact-taxonomy.json'),
        path.posix.join(programRoot, 'contracts/program.schema.json'),
        path.posix.join(programRoot, 'contracts/program-state.schema.json'),
        path.posix.join(programRoot, 'contracts/assignments.schema.json'),
        path.posix.join(programRoot, 'contracts/artifact-taxonomy.schema.json')
    ];
    readProgramDirectory(root, programRoot, contractsRelativePath)
        .filter(function (name) { return /^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/.test(name); })
        .forEach(function (name) {
            var relativePath = path.posix.join(programRoot, 'contracts', name);
            var schema = readJsonFile(safeProgramFile(root, programRoot, relativePath), relativePath);
            var schemaErrors = validateSchemaDefinition(schema, relativePath);
            if (schemaErrors.length) {
                throw providerFileError('AUTHORITY_SCHEMA_INVALID', relativePath,
                    'Authority schema uses an unsupported or unsafe shape.');
            }
            paths.push(relativePath);
        });
    (documents.program.workstreams || []).forEach(function (workstream) {
        paths.push(path.posix.join(programRoot, workstream.document));
    });
    (documents.state.contractLocks || []).forEach(function (lock) {
        (lock.paths || []).forEach(function (relativePath) {
            repositoryPaths[relativePath] = true;
        });
        paths = paths.concat(lock.paths || []);
    });
    paths = paths.concat((catalog.artifacts || []).map(function (artifact) { return artifact.path; }));
    return uniqueSorted(paths).map(function (relativePath) {
        return { path: relativePath, sha256: sha256File(
            safeCatalogFile(root, documents, repositoryPaths, relativePath), relativePath) };
    });
}

function hashSourceRecords(records) {
    return model.sha256(records.slice().sort(function (left, right) {
        return left.path.localeCompare(right.path);
    }).map(function (record) {
        var digest = record.sha256 || model.sha256(String(record.content || ''));
        return record.path + '\0' + digest;
    }).join('\n'));
}

function deriveSummaryStatus(documents, diagnostics, changeLocations) {
    var value = 'complete';
    if ((diagnostics || []).some(function (item) { return item.severity === 'error'; })) {
        value = 'invalid';
    } else if ((documents.state.blockers || []).some(function (blocker) { return blocker.status === 'open'; })) {
        value = 'blocked';
    } else if ((documents.state.changes || []).some(function (change) { return change.status === 'needs-review'; })) {
        value = 'needs-review';
    } else if ((documents.state.changes || []).some(function (change) { return change.status !== 'accepted'; }) ||
            (documents.state.gates || []).some(function (gate) { return gate.status !== 'passed'; }) ||
            (changeLocations || []).some(function (change) { return !change.archived; })) {
        value = 'in-progress';
    }
    return { authority: 'derived', value: value };
}

function changeSnapshots(root, documents) {
    var states = {};
    (documents.state.changes || []).forEach(function (change) { states[change.changeId] = change; });
    return (documents.program.changes || []).map(function (change) {
        var artifacts = model.readChangeArtifacts(root, change.changeId);
        var state = states[change.changeId] || { blockerIds: [], status: 'planned' };
        return {
            archived: artifacts.archived,
            blockerIds: (state.blockerIds || []).slice().sort(),
            changeId: change.changeId,
            kind: change.kind,
            resourceSourceAccess: change.resourceSourceAccess,
            risk: change.risk,
            status: state.status,
            tasks: { completed: artifacts.tasks.completed, total: artifacts.tasks.total },
            title: artifacts.title,
            workstreamId: change.workstreamId
        };
    }).sort(function (left, right) { return left.changeId.localeCompare(right.changeId); });
}

function artifactMetadata(catalog) {
    var diagramsByArtifact = {};
    (catalog.diagrams || []).forEach(function (diagram) {
        diagramsByArtifact[diagram.artifactId] = diagramsByArtifact[diagram.artifactId] || [];
        diagramsByArtifact[diagram.artifactId].push(diagram.diagramId);
    });
    return (catalog.artifacts || []).map(function (artifact) {
        return {
            artifactId: artifact.artifactId,
            assignmentIds: artifact.assignmentIds.slice(),
            authority: artifact.authority,
            changeIds: artifact.changeIds.slice(),
            currency: artifact.currency,
            diagramIds: (diagramsByArtifact[artifact.artifactId] || []).slice().sort(),
            evidenceTypes: artifact.evidenceTypes.slice(),
            gateIds: artifact.gateIds.slice(),
            kind: artifact.kind,
            lifecycle: artifact.lifecycle,
            mediaType: { md: 'text/markdown', json: 'application/json', txt: 'text/plain' }[artifact.format] || 'text/plain',
            path: artifact.path,
            readingSectionIds: (artifact.readingSectionIds || []).slice(),
            scope: artifact.scope,
            scopeId: artifact.scopeId,
            summary: artifact.summary,
            title: artifact.title,
            topics: artifact.topics.slice(),
            workstreamIds: artifact.workstreamIds.slice()
        };
    });
}

function readableSummary(summary, title, relativePath) {
    if (typeof summary === 'string' && summary.trim()) {
        return summary;
    }
    if (typeof title === 'string' && title.trim()) {
        return title.trim().slice(0, 1000);
    }
    return String(relativePath || 'Resource Program artifact').slice(0, 1000);
}

function normalizeOutputSummaries(values, titleField) {
    return stableClone(values || []).map(function (item) {
        item.summary = readableSummary(item.summary, item[titleField], item.path);
        return item;
    });
}

function buildOutputs(input) {
    var documents = input.documents;
    var changes = input.changes;
    var artifacts = normalizeOutputSummaries(input.artifacts, 'title');
    var readingSections = normalizeOutputSummaries(input.catalog.readingSections, 'heading');
    var sourceHash = hashSourceRecords(input.sourceRecords);
    var status = deriveSummaryStatus(documents, input.diagnostics, changes);
    var healthStatus = 'healthy';
    if (status.value === 'invalid') {
        healthStatus = 'invalid';
    } else if ((input.diagnostics || []).length) {
        healthStatus = 'degraded';
    }
    var descriptor = {
        health: { diagnostics: stableClone(input.diagnostics || []), status: healthStatus },
        initiativeId: documents.program.programId,
        kind: 'resource-program',
        presentationMode: 'specialized-app',
        providerId: PROVIDER_ID,
        relatedChangeIds: changes.map(function (change) { return change.changeId; }).sort(),
        schemaVersion: SCHEMA_VERSION,
        sourceHash: sourceHash,
        summary: documents.initiativeProvider.summary,
        summaryStatus: status,
        title: documents.program.title
    };
    var overview = {
        assignments: stableClone(documents.assignments.assignments || []).sort(function (left, right) {
            return left.assignmentId.localeCompare(right.assignmentId);
        }),
        blockers: stableClone(documents.state.blockers || []).sort(function (left, right) {
            return left.blockerId.localeCompare(right.blockerId);
        }),
        changes: stableClone(changes),
        contracts: {
            consumptions: stableClone(documents.state.contractConsumptions || []),
            impactReviews: stableClone(documents.state.impactReviews || []),
            locks: stableClone(documents.state.contractLocks || [])
        },
        gates: (documents.program.gates || []).map(function (gate) {
            var state = (documents.state.gates || []).filter(function (item) { return item.gateId === gate.gateId; })[0] ||
                { evidence: [], status: 'pending' };
            return {
                evidence: (state.evidence || []).slice().sort(),
                gateId: gate.gateId,
                requiredChanges: gate.requiredChanges.slice().sort(),
                requiredEvidence: gate.requiredEvidence.slice().sort(),
                status: state.status,
                title: gate.title,
                type: gate.type
            };
        }).sort(function (left, right) { return left.gateId.localeCompare(right.gateId); }),
        initiativeId: documents.program.programId,
        milestones: (documents.program.milestones || []).map(function (milestone) {
            var gate = (documents.state.gates || []).filter(function (item) {
                return item.gateId === milestone.gateId;
            })[0] || { status: 'pending' };
            return { gateId: milestone.gateId, milestoneId: milestone.milestoneId,
                status: gate.status, title: milestone.title };
        }).sort(function (left, right) { return left.milestoneId.localeCompare(right.milestoneId); }),
        program: { programId: documents.program.programId, title: documents.program.title },
        providerId: PROVIDER_ID,
        schemaVersion: SCHEMA_VERSION,
        sourceHash: sourceHash,
        summaryStatus: status,
        workstreams: stableClone(documents.program.workstreams || []).sort(function (left, right) {
            return left.workstreamId.localeCompare(right.workstreamId);
        })
    };
    var index = {
        artifacts: artifacts,
        diagrams: stableClone((input.catalog.diagrams || []).map(function (diagram) {
            return {
                artifactId: diagram.artifactId,
                diagramId: diagram.diagramId,
                renderable: diagram.renderable,
                sourceHeading: diagram.sourceHeading,
                sourceIndex: diagram.sourceIndex,
                standing: diagram.standing,
                type: diagram.type
            };
        })),
        initiativeId: documents.program.programId,
        providerId: PROVIDER_ID,
        readingSections: readingSections,
        schemaVersion: SCHEMA_VERSION,
        sourceHash: sourceHash,
        topics: stableClone(input.catalog.topics || [])
    };
    return { artifactIndex: index, descriptor: descriptor, overviewSnapshot: overview };
}

function validateOutputSchemas(root, programRelativePath, outputs) {
    var diagnosticSchema = readJson(path.posix.join(programRelativePath, 'contracts'), root,
        'initiative-diagnostic.schema.json');
    var referencedSchemas = {};
    validateSchemaDefinition(diagnosticSchema,
        path.posix.join(programRelativePath, 'contracts/initiative-diagnostic.schema.json')).forEach(function (message) {
        throw new Error(message);
    });
    referencedSchemas[diagnosticSchema.$id] = diagnosticSchema;
    Object.keys(OUTPUT_SCHEMAS).filter(function (key) { return key !== 'artifactResponse'; }).forEach(function (key) {
        var schema = readJson(path.posix.join(programRelativePath, 'contracts'), root, OUTPUT_SCHEMAS[key]);
        var errors = validateSchemaDefinition(schema,
            path.posix.join(programRelativePath, 'contracts', OUTPUT_SCHEMAS[key]));
        errors = errors.concat(schemaValidator.validate(schema, outputs[key], referencedSchemas));
        if (errors.length) {
            throw new Error(OUTPUT_SCHEMAS[key] + ': ' + errors.join('; '));
        }
    });
}

function validateDescriptorSchema(root, programRelativePath, descriptor) {
    var contractsPath = path.posix.join(programRelativePath, 'contracts');
    var diagnosticSchema = readJson(contractsPath, root, 'initiative-diagnostic.schema.json');
    var descriptorSchema = readJson(contractsPath, root, OUTPUT_SCHEMAS.descriptor);
    var referencedSchemas = {};
    var errors;
    validateSchemaDefinition(diagnosticSchema,
        path.posix.join(contractsPath, 'initiative-diagnostic.schema.json')).forEach(function (message) {
        throw new Error(message);
    });
    validateSchemaDefinition(descriptorSchema,
        path.posix.join(contractsPath, OUTPUT_SCHEMAS.descriptor)).forEach(function (message) {
        throw new Error(message);
    });
    referencedSchemas[diagnosticSchema.$id] = diagnosticSchema;
    errors = schemaValidator.validate(descriptorSchema, descriptor, referencedSchemas);
    if (errors.length) {
        throw new Error(OUTPUT_SCHEMAS.descriptor + ': ' + errors.join('; '));
    }
}

function buildProgramDescriptorFromCandidate(root, candidate) {
    var documents;
    var diagnostics;
    var definitions;
    var definitionPaths;
    var changes;
    var records;
    var outputs;
    documents = loadDocuments(root, candidate);
    diagnostics = validateDocuments(root, documents);
    if (diagnostics.some(function (item) { return item.severity === 'error'; })) {
        throw documentValidationError(diagnostics);
    }
    definitions = artifactCatalog.listArtifactDefinitions(root, documents);
    definitionPaths = {};
    definitions.forEach(function (definition) { definitionPaths[definition.path] = true; });
    (documents.artifactTaxonomy.annotations || []).forEach(function (annotation) {
        if (!definitionPaths[annotation.path]) {
            throw new Error('taxonomy annotation is outside the artifact whitelist: ' + annotation.path);
        }
    });
    changes = changeSnapshots(root, documents);
    records = sourceRecords(root, documents, {
        artifacts: definitions.map(function (definition) { return { path: definition.path }; })
    });
    outputs = buildOutputs({
        artifacts: [],
        catalog: { diagrams: [], readingSections: [], topics: [] },
        changes: changes,
        diagnostics: diagnostics,
        documents: documents,
        sourceRecords: records
    });
    validateDescriptorSchema(root, candidate.programRelativePath, outputs.descriptor);
    return { descriptor: outputs.descriptor, sourceRecords: records };
}

function buildProgramDescriptor(root, initiativeId) {
    var discovery = discoverPrograms(root);
    var candidate = discovery.candidates.filter(function (item) {
        return item.initiativeId === initiativeId;
    })[0];
    if (!candidate) {
        throw new Error('Initiative is not a valid discovered Resource Program: ' + initiativeId);
    }
    return buildProgramDescriptorFromCandidate(root, candidate);
}

/**
 * 构建指定 Resource Program 的只读 Provider 输出。
 * @param {string} root - 仓库根目录。
 * @param {string} initiativeId - Initiative ID。
 * @returns {Object} descriptor、overviewSnapshot、artifactIndex 和内部 source records。
 */
function buildProgramProvider(root, initiativeId) {
    var discovery = discoverPrograms(root);
    var candidate = discovery.candidates.filter(function (item) { return item.initiativeId === initiativeId; })[0];
    var documents;
    var diagnostics;
    var catalog;
    var changes;
    var records;
    var outputs;
    if (!candidate) {
        throw new Error('Initiative is not a valid discovered Resource Program: ' + initiativeId);
    }
    documents = loadDocuments(root, candidate);
    diagnostics = validateDocuments(root, documents);
    if (diagnostics.some(function (item) { return item.severity === 'error'; })) {
        throw documentValidationError(diagnostics);
    }
    catalog = artifactCatalog.buildArtifactCatalog(root, documents, documents.artifactTaxonomy);
    changes = changeSnapshots(root, documents);
    records = sourceRecords(root, documents, catalog);
    outputs = buildOutputs({ artifacts: artifactMetadata(catalog), catalog: catalog, changes: changes,
        diagnostics: diagnostics, documents: documents, sourceRecords: records });
    validateOutputSchemas(root, candidate.programRelativePath, outputs);
    outputs.sourceRecords = records;
    return outputs;
}

function allowedArtifactRoots(root, documents) {
    var roots = [model.resolveRepositoryPath(root, documents.programRelativePath)];
    (documents.program.changes || []).forEach(function (change) {
        var resolved = model.resolveChangeDirectory(root, change.changeId);
        if (resolved.directoryExists && !resolved.unsafe) {
            roots.push(resolved.absolutePath);
        }
    });
    return roots;
}

function validateArtifactFile(root, relativePath, allowedRoots) {
    var absolutePath = model.resolveRepositoryPath(root, relativePath);
    var repositoryRoot = path.resolve(root);
    var allowedRoot = allowedRoots.filter(function (candidateRoot) {
        return isWithinBoundary(candidateRoot, absolutePath);
    })[0];
    var stat;
    if (!allowedRoot) {
        throw new Error('artifact resolves outside its Program and registered Changes');
    }
    absolutePath = safePath(root, normalizedRelativePath(repositoryRoot, allowedRoot),
        relativePath, 'file');
    stat = fs.lstatSync(absolutePath);
    if (stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error('artifact exceeds the response size limit');
    }
    return absolutePath;
}

/**
 * 通过当前 source hash 和稳定成果 ID 惰性读取单个成果。
 * @param {string} root - 仓库根目录。
 * @param {Object} request - 严格读取请求。
 * @returns {Object} 成果响应。
 */
function readArtifact(root, request) {
    var allowedKeys = ['initiativeId', 'sourceHash', 'artifactId', 'sectionId', 'diagramId'];
    var outputs;
    var metadata;
    var candidate;
    var documents;
    var absolutePath;
    var roots;
    var content;
    var response;
    var artifactIndexSchema;
    var responseSchemas = {};
    if (!request || Object.keys(request).some(function (key) { return allowedKeys.indexOf(key) === -1; })) {
        throw new Error('artifact request contains unsupported fields');
    }
    if (!/^artifact-[a-f0-9]{16}$/.test(request.artifactId || '')) {
        throw new Error('artifactId is invalid');
    }
    outputs = buildProgramProvider(root, request.initiativeId);
    if (request.sourceHash !== outputs.descriptor.sourceHash) {
        throw new Error('artifact request uses a stale sourceHash');
    }
    metadata = outputs.artifactIndex.artifacts.filter(function (artifact) {
        return artifact.artifactId === request.artifactId;
    })[0];
    if (!metadata) {
        throw new Error('artifactId is not in the current whitelist');
    }
    if (request.sectionId && metadata.readingSectionIds.indexOf(request.sectionId) === -1) {
        throw new Error('sectionId does not belong to the artifact');
    }
    if (request.diagramId && metadata.diagramIds.indexOf(request.diagramId) === -1) {
        throw new Error('diagramId does not belong to the artifact');
    }
    candidate = discoverPrograms(root).candidates.filter(function (item) {
        return item.initiativeId === request.initiativeId;
    })[0];
    documents = loadDocuments(root, candidate);
    roots = allowedArtifactRoots(root, documents);
    absolutePath = validateArtifactFile(root, metadata.path, roots);
    content = readTextFile(absolutePath, metadata.path);
    response = {
        artifactId: metadata.artifactId,
        content: content,
        initiativeId: request.initiativeId,
        mediaType: metadata.mediaType,
        metadata: metadata,
        providerId: PROVIDER_ID,
        schemaVersion: SCHEMA_VERSION,
        sourceHash: request.sourceHash
    };
    artifactIndexSchema = readJson(path.posix.join(candidate.programRelativePath, 'contracts'), root,
        OUTPUT_SCHEMAS.artifactIndex);
    validateSchemaDefinition(artifactIndexSchema,
        path.posix.join(candidate.programRelativePath, 'contracts', OUTPUT_SCHEMAS.artifactIndex)).forEach(function (message) {
        throw new Error('artifact index schema: ' + message);
    });
    responseSchemas[artifactIndexSchema.$id] = artifactIndexSchema;
    var responseSchema = readJson(path.posix.join(candidate.programRelativePath, 'contracts'), root,
        OUTPUT_SCHEMAS.artifactResponse);
    validateSchemaDefinition(responseSchema,
        path.posix.join(candidate.programRelativePath, 'contracts', OUTPUT_SCHEMAS.artifactResponse)).forEach(function (message) {
        throw new Error('artifact response schema: ' + message);
    });
    schemaValidator.validate(responseSchema, response, responseSchemas).forEach(function (message) {
        throw new Error('artifact response schema: ' + message);
    });
    return response;
}

/**
 * 从无文件系统 canonical 输入构建跨仓库契约输出。
 * @param {Object} input - 版本化 fixture 输入。
 * @returns {Object} 确定性输出。
 */
function buildContractFixture(input) {
    if (!input || input.schemaVersion !== SCHEMA_VERSION || input.providerId !== PROVIDER_ID ||
            !input.documents || !input.catalog || !Array.isArray(input.sourceRecords)) {
        throw new Error('canonical fixture input is invalid or incompatible');
    }
    return buildOutputs({
        artifacts: stableClone(input.artifacts || []),
        catalog: stableClone(input.catalog),
        changes: stableClone(input.changes || []),
        diagnostics: stableClone(input.diagnostics || []),
        documents: stableClone(input.documents),
        sourceRecords: stableClone(input.sourceRecords)
    });
}

function hostDiagnostic(item, initiativeId) {
    var resourceId = item.relativePath || '';
    if (resourceId.length > 160) {
        resourceId = resourceId.slice(0, 160);
    }
    return hostContract.diagnostic(
        item.code || 'RESOURCE_PROGRAM_INVALID',
        item.severity || 'error',
        'Resource Program 契约诊断',
        item.message || 'Resource Program 无法通过固定契约校验。',
        {
            providerId: PROVIDER_ID,
            initiativeId: initiativeId || '',
            resourceId: resourceId
        }
    );
}

function initiativeIdFromDiagnostic(item) {
    var parts = String(item.relativePath || '').split('/');
    var initiativeId = parts.length >= 3 && parts[0] === 'openspec' && parts[1] === 'programs' ? parts[2] : '';
    return hostContract.IDENTIFIER_PATTERN.test(initiativeId) ? initiativeId : '';
}

function hostDescriptor(output) {
    var descriptor = output.descriptor;
    return {
        schemaVersion: hostContract.DESCRIPTOR_SCHEMA_VERSION,
        id: descriptor.initiativeId,
        providerId: PROVIDER_ID,
        type: descriptor.kind,
        title: descriptor.title,
        summary: descriptor.summary,
        goal: '',
        status: descriptor.summaryStatus.value,
        health: descriptor.health.status,
        changeRefs: descriptor.relatedChangeIds.map(function (changeId) {
            return { id: changeId, relationship: 'owned' };
        }),
        presentation: { mode: 'custom', appId: 'resource-program-v1' },
        artifacts: [],
        sourceHash: descriptor.sourceHash,
        diagnostics: (descriptor.health.diagnostics || []).map(function (item) {
            return hostDiagnostic(item, descriptor.initiativeId);
        })
    };
}

function fingerprintOpenSpecInputs(root) {
    var discovery = discoverPrograms(root);
    var records = discovery.diagnostics.map(function (item) {
        return {
            code: item.code,
            message: item.message,
            relativePath: item.relativePath || ''
        };
    });
    discovery.candidates.forEach(function (candidate) {
        try {
            records.push({
                initiativeId: candidate.initiativeId,
                sourceHash: buildProgramDescriptorFromCandidate(root, candidate).descriptor.sourceHash
            });
        } catch (error) {
            records.push({
                initiativeId: candidate.initiativeId,
                error: error && error.providerCode ? error.providerCode :
                    String(error && error.message ? error.message : error).slice(0, 500)
            });
        }
    });
    return model.sha256(hostContract.stableJson(records));
}

/**
 * 读取受信任的 WTC Resource Program v1 声明式契约。
 * 仓库内容不能注册模块、命令、URL 或其他执行入口。
 */
function WtcResourceProgramProvider() {
    this.id = PROVIDER_ID;
    this.schemaVersions = [hostContract.DESCRIPTOR_SCHEMA_VERSION];
}

WtcResourceProgramProvider.prototype.fingerprint = function (context) {
    return Promise.resolve(fingerprintOpenSpecInputs(context.projectRoot));
};

WtcResourceProgramProvider.prototype.discover = function (context) {
    var discovery = discoverPrograms(context.projectRoot);
    var initiatives = [];
    var diagnostics = [];
    var invalidInitiativeIds = [];

    discovery.diagnostics.forEach(function (item) {
        var initiativeId = initiativeIdFromDiagnostic(item);
        diagnostics.push(hostDiagnostic(item, initiativeId));
        if (initiativeId) {
            invalidInitiativeIds.push(initiativeId);
        }
    });
    discovery.candidates.forEach(function (candidate) {
        try {
            initiatives.push(hostDescriptor(buildProgramDescriptor(context.projectRoot, candidate.initiativeId)));
        } catch (error) {
            diagnostics.push(hostDiagnostic({
                code: error && error.providerCode ? error.providerCode : 'RESOURCE_PROGRAM_INVALID',
                severity: 'error',
                message: String(error && error.message ? error.message : error).slice(0, 500),
                relativePath: candidate.programRelativePath
            }, candidate.initiativeId));
            invalidInitiativeIds.push(candidate.initiativeId);
        }
    });
    invalidInitiativeIds = uniqueSorted(invalidInitiativeIds);
    return Promise.resolve({
        authoritative: invalidInitiativeIds.length === 0,
        initiatives: initiatives.sort(function (left, right) { return left.id.localeCompare(right.id); }),
        diagnostics: diagnostics,
        invalidInitiativeIds: invalidInitiativeIds
    });
};

WtcResourceProgramProvider.prototype.load = function (context, descriptor) {
    var outputs = buildProgramProvider(context.projectRoot, descriptor.id);
    if (descriptor.providerId !== PROVIDER_ID || outputs.descriptor.sourceHash !== descriptor.sourceHash) {
        var error = new Error('Resource Program snapshot is stale');
        error.code = 'STALE_INITIATIVE';
        return Promise.reject(error);
    }
    return Promise.resolve({
        descriptor: hostDescriptor(outputs),
        overviewSnapshot: outputs.overviewSnapshot,
        artifactIndex: outputs.artifactIndex,
        sourceHash: outputs.descriptor.sourceHash
    });
};

WtcResourceProgramProvider.prototype.readArtifact = function (context, descriptor, request) {
    if (descriptor.providerId !== PROVIDER_ID || request.sourceHash !== descriptor.sourceHash) {
        var error = new Error('Resource Program artifact request is stale');
        error.code = 'STALE_INITIATIVE';
        return Promise.reject(error);
    }
    try {
        return Promise.resolve(readArtifact(context.projectRoot, {
            initiativeId: descriptor.id,
            sourceHash: request.sourceHash,
            artifactId: request.artifactId
        }));
    } catch (readError) {
        return Promise.reject(readError);
    }
};

module.exports = {
    MAX_ARTIFACT_BYTES: MAX_ARTIFACT_BYTES,
    MAX_AUTHORITY_BYTES: MAX_AUTHORITY_BYTES,
    MAX_SOURCE_FILE_BYTES: MAX_SOURCE_FILE_BYTES,
    PROVIDER_ID: PROVIDER_ID,
    SCHEMA_VERSION: SCHEMA_VERSION,
    WtcResourceProgramProvider: WtcResourceProgramProvider,
    buildContractFixture: buildContractFixture,
    buildProgramDescriptor: buildProgramDescriptor,
    buildProgramProvider: buildProgramProvider,
    deriveSummaryStatus: deriveSummaryStatus,
    discoverPrograms: discoverPrograms,
    hashSourceRecords: hashSourceRecords,
    hostDescriptor: hostDescriptor,
    readArtifact: readArtifact,
    validateArtifactFile: validateArtifactFile,
    validateSidecar: validateSidecar,
    validateSchemaDefinition: validateSchemaDefinition
};
