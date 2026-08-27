'use strict';

var fs = require('fs');
var path = require('path');
var model = require('./model');

var PROGRAM_CORE_FILES = [
    'requirements.md',
    'program.md',
    'program-orchestration-design.md',
    'target-technical-architecture.md',
    'templates/ai-work-item.md'
];
var LIFECYCLE_ORDER = {
    baseline: 0,
    planning: 1,
    design: 2,
    implementation: 3,
    verification: 4
};
var SCOPE_ORDER = { program: 0, workstream: 1, change: 2 };
var READING_ROLE_ORDER = { conclusion: 0, design: 1, evidence: 2 };
var READING_PRIORITY_ORDER = { primary: 0, supporting: 1 };
var READING_AUTHORITY_ORDER = {
    'program-authority': 0,
    'change-artifact': 1,
    'verification-evidence': 2,
    'implementation-evidence': 3
};
var EVIDENCE_TYPE_ORDER = {
    implementation: 0,
    verification: 1,
    'independent-verification': 2,
    acceptance: 3
};
var WORKSTREAM_TOPICS = {
    'ws-01-foundation': 'program-governance',
    'ws-02-bundle-contract-tooling': 'bundle-contract-tooling',
    'ws-03-browser-runtime': 'browser-runtime',
    'ws-04-lobby-first-screen': 'lobby-first-screen',
    'ws-05-feature-migration': 'feature-migration',
    'ws-06-activity': 'activity',
    'ws-07-lifecycle-memory': 'lifecycle-memory',
    'ws-08-publishing-delta': 'publishing-delta',
    'ws-09-validation-cutover': 'validation-cutover'
};

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

function hasDuplicates(values) {
    return uniqueSorted(values).length !== values.length;
}

function mapBy(values, idField) {
    var result = {};
    (values || []).forEach(function (value) { result[value[idField]] = value; });
    return result;
}

function hiddenPath(relativePath) {
    return relativePath.split('/').some(function (segment) { return segment.charAt(0) === '.'; });
}

function isBrowsableExtension(relativePath) {
    var extension = path.extname(relativePath).toLowerCase();
    return extension === '.md' || extension === '.json' || extension === '.txt';
}

function listGovernedFiles(root, relativePath, traversal) {
    var absolutePath = model.resolveRepositoryPath(root, relativePath);
    var stat;
    var result = [];
    var state = traversal || { entries: 0 };
    state.entries += 1;
    if (state.entries > 10000) {
        throw new Error('artifact catalog exceeds its entry limit');
    }
    if (hiddenPath(relativePath)) {
        return result;
    }
    stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
        throw new Error('symbolic links are not allowed in artifact catalog: ' + relativePath);
    }
    if (stat.isFile()) {
        return isBrowsableExtension(relativePath) ? [relativePath] : [];
    }
    if (!stat.isDirectory()) {
        return result;
    }
    fs.readdirSync(absolutePath).sort().forEach(function (name) {
        var child = path.posix.join(relativePath, name);
        if (name.charAt(0) !== '.') {
            result = result.concat(listGovernedFiles(root, child, state));
        }
    });
    return result;
}

function addRelation(definition, field, value) {
    if (value && definition[field].indexOf(value) === -1) {
        definition[field].push(value);
    }
}

function buildDefinitions(root, artifacts) {
    var programBase = artifacts.programRelativePath;
    var definitions = {};
    var changeById = mapBy(artifacts.program.changes, 'changeId');

    if (typeof programBase !== 'string' || !programBase) {
        throw new Error('Resource Program relative path is required');
    }

    function add(relativePath, fixedScope) {
        var absolutePath;
        var stat;
        if (typeof relativePath !== 'string' || hiddenPath(relativePath) || !isBrowsableExtension(relativePath)) {
            return null;
        }
        absolutePath = model.resolveRepositoryPath(root, relativePath);
        if (!fs.existsSync(absolutePath)) {
            return null;
        }
        stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('artifact path must be a regular file: ' + relativePath);
        }
        if (!definitions[relativePath]) {
            definitions[relativePath] = {
                assignmentIds: [],
                changeIds: [],
                evidenceRoles: [],
                fixedScope: fixedScope || null,
                gateIds: [],
                path: relativePath,
                workstreamIds: []
            };
        } else if (fixedScope && !definitions[relativePath].fixedScope) {
            definitions[relativePath].fixedScope = fixedScope;
        }
        return definitions[relativePath];
    }

    PROGRAM_CORE_FILES.forEach(function (relativePath) {
        add(path.posix.join(programBase, relativePath), 'program');
    });
    artifacts.program.workstreams.forEach(function (workstream) {
        var definition = add(path.posix.join(programBase, workstream.document), 'workstream');
        if (definition) {
            addRelation(definition, 'workstreamIds', workstream.workstreamId);
        }
    });
    ['decisions', 'evidence'].forEach(function (directory) {
        listGovernedFiles(root, path.posix.join(programBase, directory)).forEach(function (relativePath) {
            add(relativePath, directory === 'decisions' ? 'program' : null);
        });
    });
    artifacts.program.changes.forEach(function (change) {
        var openSpec = model.readChangeArtifacts(root, change.changeId);
        var changePaths = [];
        if (!openSpec.directoryExists || openSpec.unsafe) {
            return;
        }
        if (openSpec.proposalExists) { changePaths.push(openSpec.relativePath + '/proposal.md'); }
        if (openSpec.designExists) { changePaths.push(openSpec.relativePath + '/design.md'); }
        if (openSpec.tasksExists) { changePaths.push(openSpec.relativePath + '/tasks.md'); }
        changePaths = changePaths.concat(openSpec.specFiles);
        changePaths.forEach(function (relativePath) {
            var definition = add(relativePath, 'change');
            if (definition) {
                addRelation(definition, 'changeIds', change.changeId);
                addRelation(definition, 'workstreamIds', change.workstreamId);
            }
        });
    });
    artifacts.state.gates.forEach(function (gateState) {
        var gate = artifacts.program.gates.filter(function (candidate) {
            return candidate.gateId === gateState.gateId;
        })[0];
        (gateState.evidence || []).forEach(function (relativePath) {
            var definition = add(relativePath, null);
            if (!definition) {
                return;
            }
            addRelation(definition, 'gateIds', gateState.gateId);
            (gate ? gate.requiredChanges : []).forEach(function (changeId) {
                addRelation(definition, 'changeIds', changeId);
                if (changeById[changeId]) {
                    addRelation(definition, 'workstreamIds', changeById[changeId].workstreamId);
                }
            });
        });
    });
    artifacts.assignments.assignments.forEach(function (assignment) {
        [
            { paths: assignment.implementationEvidence, role: 'implementation-evidence' },
            { paths: assignment.verificationEvidence, role: 'verification-evidence' }
        ].forEach(function (entry) {
            (entry.paths || []).forEach(function (relativePath) {
                var definition = add(relativePath, null);
                if (!definition) {
                    return;
                }
                addRelation(definition, 'assignmentIds', assignment.assignmentId);
                addRelation(definition, 'changeIds', assignment.changeId);
                addRelation(definition, 'evidenceRoles', entry.role);
                if (changeById[assignment.changeId]) {
                    addRelation(definition, 'workstreamIds', changeById[assignment.changeId].workstreamId);
                }
            });
        });
    });
    return Object.keys(definitions).sort().map(function (relativePath) { return definitions[relativePath]; });
}

/**
 * 只枚举 Provider source hash 所需的成果白名单，不读取成果正文。
 * @param {string} root 仓库根目录
 * @param {Object} artifacts Program 权威文档
 * @returns {Object[]} 稳定排序的成果定义
 */
function listArtifactDefinitions(root, artifacts) {
    return buildDefinitions(root, artifacts).map(function (definition) {
        return JSON.parse(JSON.stringify(definition));
    });
}

function markdownTitle(content, relativePath) {
    var heading = content.match(/^#\s+(.+)$/m);
    return heading ? heading[1].replace(/[`*_]/g, '').trim() : path.basename(relativePath, path.extname(relativePath));
}

function contentSummary(content) {
    var paragraph = content.split(/\r?\n\r?\n/).filter(function (block) {
        var trimmed = block.trim();
        return trimmed && trimmed.charAt(0) !== '#' && trimmed.indexOf('```') !== 0;
    })[0] || '';
    return paragraph.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/[`*_>#|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function markdownSections(markdown) {
    var lines = markdown.match(/[^\n]*(?:\n|$)/g) || [];
    var headings = [];
    var offset = 0;
    var fence = '';
    lines.forEach(function (rawLine) {
        var line = rawLine.replace(/\r?\n$/, '');
        var fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
        var headingMatch;
        if (fenceMatch) {
            if (!fence) {
                fence = fenceMatch[1].charAt(0);
            } else if (fence === fenceMatch[1].charAt(0)) {
                fence = '';
            }
        } else if (!fence) {
            headingMatch = line.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/);
            if (headingMatch) {
                headings.push({
                    bodyOffset: offset + rawLine.length,
                    endOffset: markdown.length,
                    heading: headingMatch[2].replace(/[ \t]+#+[ \t]*$/, '').trim(),
                    level: headingMatch[1].length,
                    sourceIndex: headings.length,
                    startOffset: offset
                });
            }
        }
        offset += rawLine.length;
    });
    headings.forEach(function (heading, index) {
        var nextIndex = index + 1;
        while (nextIndex < headings.length && headings[nextIndex].level > heading.level) {
            nextIndex += 1;
        }
        heading.endOffset = nextIndex < headings.length ? headings[nextIndex].startOffset : markdown.length;
        heading.body = markdown.slice(heading.bodyOffset, heading.endOffset).trim();
        heading.summary = contentSummary(heading.body);
    });
    return headings;
}

function artifactKind(relativePath) {
    var basename = path.basename(relativePath).toLowerCase();
    if (basename === 'requirements.md') { return 'requirements'; }
    if (basename === 'program.md') { return 'program'; }
    if (basename === 'program-orchestration-design.md') { return 'program-design'; }
    if (basename === 'target-technical-architecture.md') { return 'architecture'; }
    if (/\/workstreams\//.test(relativePath)) { return 'workstream'; }
    if (/\/decisions\/adr-/i.test(relativePath)) { return 'adr'; }
    if (/\/decisions\//.test(relativePath)) { return 'decision-index'; }
    if (basename === 'proposal.md') { return 'proposal'; }
    if (basename === 'design.md') { return 'design'; }
    if (basename === 'tasks.md') { return 'tasks'; }
    if (/\/specs\/.+\/spec\.md$/.test(relativePath)) { return 'spec'; }
    if (/\/templates\//.test(relativePath)) { return 'template'; }
    if (/\/evidence\//.test(relativePath) && path.extname(relativePath).toLowerCase() === '.json') {
        return 'evidence-data';
    }
    if (/\/evidence\//.test(relativePath)) { return 'evidence'; }
    return 'document';
}

function artifactLifecycle(kind, definition) {
    if (kind === 'proposal' || kind === 'tasks' || kind === 'spec') { return 'planning'; }
    if (kind === 'design' || kind === 'program-design' || kind === 'architecture' || kind === 'adr') {
        return 'design';
    }
    if (definition.evidenceRoles.indexOf('verification-evidence') !== -1) { return 'verification'; }
    if (definition.evidenceRoles.indexOf('implementation-evidence') !== -1) { return 'implementation'; }
    if (/verification|walkthrough|render-report|reverification/.test(definition.path)) { return 'verification'; }
    if (/implementation|current-state/.test(definition.path)) { return 'implementation'; }
    return 'baseline';
}

function artifactAuthority(kind, definition) {
    if (kind === 'requirements' || kind === 'program' || kind === 'program-design' ||
            kind === 'architecture' || kind === 'workstream' || kind === 'adr' ||
            kind === 'decision-index' || kind === 'template') {
        return 'program-authority';
    }
    if (kind === 'proposal' || kind === 'design' || kind === 'tasks' || kind === 'spec') {
        return 'change-artifact';
    }
    if (definition.evidenceRoles.indexOf('verification-evidence') !== -1 ||
            /verification|walkthrough|render-report|reverification/.test(definition.path)) {
        return 'verification-evidence';
    }
    if (definition.evidenceRoles.indexOf('implementation-evidence') !== -1 ||
            /implementation|current-state/.test(definition.path)) {
        return 'implementation-evidence';
    }
    return 'program-authority';
}

function artifactScope(definition) {
    if (definition.fixedScope) {
        return definition.fixedScope;
    }
    if (definition.changeIds.length === 1) { return 'change'; }
    if (definition.workstreamIds.length === 1) { return 'workstream'; }
    return 'program';
}

function defaultTopics(kind, definition) {
    var topics = [];
    definition.workstreamIds.forEach(function (workstreamId) {
        if (WORKSTREAM_TOPICS[workstreamId]) { topics.push(WORKSTREAM_TOPICS[workstreamId]); }
    });
    if (kind === 'architecture' || kind === 'adr') { topics.push('technical-architecture'); }
    if (kind === 'program' || kind === 'program-design' || kind === 'requirements' || kind === 'template') {
        topics.push('program-governance');
    }
    if (/resource-source-baseline/.test(definition.path)) { topics.push('resource-source-baseline'); }
    return uniqueSorted(topics.length ? topics : ['program-governance']);
}

function relatedStatuses(definition, artifacts) {
    var changeState = mapBy(artifacts.state.changes, 'changeId');
    var gateState = mapBy(artifacts.state.gates, 'gateId');
    var assignmentState = mapBy(artifacts.assignments.assignments, 'assignmentId');
    var result = [];
    definition.changeIds.forEach(function (changeId) {
        var openSpec = model.readChangeArtifacts(artifacts.root, changeId);
        result.push({ entityId: changeId, entityType: 'change', status: changeState[changeId].status });
        if (openSpec.archived) {
            result.push({ entityId: changeId, entityType: 'change-location', status: 'archived' });
        }
    });
    definition.gateIds.forEach(function (gateId) {
        result.push({ entityId: gateId, entityType: 'gate', status: gateState[gateId].status });
    });
    definition.assignmentIds.forEach(function (assignmentId) {
        result.push({
            entityId: assignmentId,
            entityType: 'assignment',
            status: assignmentState[assignmentId].status
        });
    });
    return result.sort(function (left, right) {
        return (left.entityType + '\0' + left.entityId).localeCompare(right.entityType + '\0' + right.entityId);
    });
}

function artifactCurrency(artifact) {
    return artifact.scope === 'change' && /\/openspec\/changes\/archive\//.test('/' + artifact.path) ?
        'historical' : 'current';
}

function orderedEvidenceTypes(values) {
    return uniqueSorted(values).sort(function (left, right) {
        return EVIDENCE_TYPE_ORDER[left] - EVIDENCE_TYPE_ORDER[right];
    });
}

function artifactEvidenceTypes(artifact, artifacts) {
    var types = [];
    var assignmentById = mapBy(artifacts.assignments.assignments, 'assignmentId');
    var gateById = mapBy(artifacts.state.gates, 'gateId');
    if (artifact.authority === 'implementation-evidence') {
        types.push('implementation');
    }
    if (artifact.authority === 'verification-evidence') {
        types.push('verification');
    }
    artifact.assignmentIds.forEach(function (assignmentId) {
        var assignment = assignmentById[assignmentId];
        if (assignment && (assignment.verificationEvidence || []).indexOf(artifact.path) !== -1) {
            types.push('independent-verification');
        }
    });
    artifact.gateIds.forEach(function (gateId) {
        if (gateById[gateId] && gateById[gateId].status === 'passed') {
            types.push('acceptance');
        }
    });
    if (artifact.kind === 'evidence' && !types.length) {
        types.push('verification');
    }
    return orderedEvidenceTypes(types);
}

function compareArtifacts(left, right) {
    var leftKey = [
        SCOPE_ORDER[left.scope], left.scopeId, LIFECYCLE_ORDER[left.lifecycle], left.kind, left.title, left.path
    ].join('\0');
    var rightKey = [
        SCOPE_ORDER[right.scope], right.scopeId, LIFECYCLE_ORDER[right.lifecycle], right.kind, right.title, right.path
    ].join('\0');
    return leftKey.localeCompare(rightKey);
}

function buildBaseArtifacts(root, artifacts) {
    var artifactIds = {};
    var programArtifacts = Object.create(artifacts);
    programArtifacts.root = root;
    return buildDefinitions(root, artifacts).map(function (definition) {
        var absolutePath = model.resolveRepositoryPath(root, definition.path);
        var rawContent = fs.readFileSync(absolutePath, 'utf8');
        var format = path.extname(definition.path).slice(1).toLowerCase() || 'text';
        var kind = artifactKind(definition.path);
        var scope = artifactScope(definition);
        var artifactId = 'artifact-' + model.sha256(definition.path).slice(0, 16);
        var content = format === 'json' ? model.stableJson(JSON.parse(rawContent)) : rawContent;
        var title = markdownTitle(rawContent, definition.path);
        var changeTitle;
        var kindTitle;
        var scopeId = artifacts.program.programId;
        if (artifactIds[artifactId]) {
            throw new Error('duplicate artifact ID: ' + artifactId);
        }
        artifactIds[artifactId] = true;
        definition.assignmentIds = uniqueSorted(definition.assignmentIds);
        definition.changeIds = uniqueSorted(definition.changeIds);
        definition.gateIds = uniqueSorted(definition.gateIds);
        definition.workstreamIds = uniqueSorted(definition.workstreamIds);
        if (scope === 'change' && (title === 'design' || title === 'tasks' || title === 'spec')) {
            changeTitle = model.readChangeArtifacts(root, definition.changeIds[0]).title;
            kindTitle = { design: 'Design', spec: 'Spec', tasks: 'Tasks' }[kind];
            title = changeTitle + ' / ' + (kindTitle || kind);
        }
        if (scope === 'change') { scopeId = definition.changeIds[0]; }
        if (scope === 'workstream') { scopeId = definition.workstreamIds[0]; }
        var result = {
            artifactId: artifactId,
            assignmentIds: definition.assignmentIds,
            authority: artifactAuthority(kind, definition),
            changeIds: definition.changeIds,
            content: content,
            featured: false,
            format: format,
            gateIds: definition.gateIds,
            kind: kind,
            lifecycle: artifactLifecycle(kind, definition),
            path: definition.path,
            relatedStatuses: relatedStatuses(definition, programArtifacts),
            scope: scope,
            scopeId: scopeId,
            summary: contentSummary(rawContent),
            title: title,
            topics: defaultTopics(kind, definition),
            workstreamIds: definition.workstreamIds
        };
        result.currency = artifactCurrency(result);
        result.evidenceTypes = artifactEvidenceTypes(result, artifacts);
        return result;
    }).sort(compareArtifacts);
}

function validateTaxonomy(artifacts, baseArtifacts, taxonomy) {
    var errors = [];
    var artifactByPath = mapBy(baseArtifacts, 'path');
    var topicById = {};
    var annotationByPath = {};
    var workstreamById = mapBy(artifacts.program.workstreams, 'workstreamId');
    var changeById = mapBy(artifacts.program.changes, 'changeId');
    (taxonomy.topics || []).forEach(function (topic) {
        if (topicById[topic.topicId]) {
            errors.push('duplicate topic: ' + topic.topicId);
        }
        topicById[topic.topicId] = topic;
    });
    (taxonomy.annotations || []).forEach(function (annotation) {
        var artifact;
        var headingCounts = {};
        var sections;
        if (annotationByPath[annotation.path]) {
            errors.push('duplicate annotation path: ' + annotation.path);
        }
        annotationByPath[annotation.path] = annotation;
        artifact = artifactByPath[annotation.path];
        if (!artifact) {
            errors.push('annotation path is outside the artifact catalog: ' + annotation.path);
        }
        ['topics', 'relatedWorkstreamIds', 'relatedChangeIds'].forEach(function (field) {
            if (hasDuplicates(annotation[field] || [])) {
                errors.push('annotation ' + annotation.path + ' has duplicate ' + field);
            }
        });
        (annotation.topics || []).forEach(function (topicId) {
            if (!topicById[topicId]) { errors.push('unknown topic: ' + topicId); }
        });
        (annotation.relatedWorkstreamIds || []).forEach(function (workstreamId) {
            if (!workstreamById[workstreamId]) { errors.push('unknown Workstream: ' + workstreamId); }
        });
        (annotation.relatedChangeIds || []).forEach(function (changeId) {
            if (!changeById[changeId]) { errors.push('unknown Change: ' + changeId); }
        });
        if ((annotation.readingSections || []).length && artifact && artifact.format !== 'md') {
            errors.push('reading sections require Markdown: ' + annotation.path);
        }
        sections = artifact && artifact.format === 'md' ? markdownSections(artifact.content) : [];
        (annotation.readingSections || []).forEach(function (readingSection) {
            var matches;
            if (headingCounts[readingSection.heading]) {
                errors.push('duplicate reading section: ' + annotation.path + ' # ' + readingSection.heading);
            }
            headingCounts[readingSection.heading] = (headingCounts[readingSection.heading] || 0) + 1;
            if (!READING_ROLE_ORDER.hasOwnProperty(readingSection.role)) {
                errors.push('unknown reading role: ' + readingSection.role);
            }
            if (!READING_PRIORITY_ORDER.hasOwnProperty(readingSection.priority)) {
                errors.push('unknown reading priority: ' + readingSection.priority);
            }
            matches = sections.filter(function (section) {
                return section.heading === readingSection.heading;
            });
            if (matches.length !== 1) {
                errors.push('reading heading must exist exactly once: ' + annotation.path + ' # ' +
                    readingSection.heading);
            } else if (!matches[0].summary) {
                errors.push('reading section must contain readable text: ' + annotation.path + ' # ' +
                    readingSection.heading);
            }
        });
    });
    return errors.sort();
}

function compareReadingSections(left, right) {
    var leftHistorical = left.currency === 'historical' ? 1 : 0;
    var rightHistorical = right.currency === 'historical' ? 1 : 0;
    var leftKey = [
        READING_ROLE_ORDER[left.role],
        leftHistorical,
        READING_AUTHORITY_ORDER[left.authority],
        READING_PRIORITY_ORDER[left.priority],
        left.topics[0] || '',
        left.artifactTitle,
        left.heading,
        left.sectionId
    ].join('\0');
    var rightKey = [
        READING_ROLE_ORDER[right.role],
        rightHistorical,
        READING_AUTHORITY_ORDER[right.authority],
        READING_PRIORITY_ORDER[right.priority],
        right.topics[0] || '',
        right.artifactTitle,
        right.heading,
        right.sectionId
    ].join('\0');
    return leftKey.localeCompare(rightKey);
}

function extractReadingSections(artifacts, taxonomy) {
    var artifactByPath = mapBy(artifacts, 'path');
    var result = [];
    (taxonomy.annotations || []).forEach(function (annotation) {
        var artifact = artifactByPath[annotation.path];
        var sourceSections;
        if (!artifact || !(annotation.readingSections || []).length) {
            return;
        }
        sourceSections = markdownSections(artifact.content);
        annotation.readingSections.forEach(function (definition) {
            var source = sourceSections.filter(function (section) {
                return section.heading === definition.heading;
            })[0];
            var evidenceTypes = artifact.evidenceTypes.slice();
            if (definition.role === 'evidence' && !evidenceTypes.length) {
                evidenceTypes = ['verification'];
            }
            result.push({
                artifactId: artifact.artifactId,
                artifactTitle: artifact.title,
                assignmentIds: artifact.assignmentIds,
                authority: artifact.authority,
                changeIds: artifact.changeIds,
                currency: artifact.currency,
                evidenceTypes: evidenceTypes,
                gateIds: artifact.gateIds,
                heading: source.heading,
                headingLevel: source.level,
                lifecycle: artifact.lifecycle,
                path: artifact.path,
                priority: definition.priority,
                relatedStatuses: artifact.relatedStatuses,
                role: definition.role,
                scope: artifact.scope,
                scopeId: artifact.scopeId,
                sectionId: 'section-' + model.sha256(
                    artifact.artifactId + '\0' + source.heading + '\0' + source.sourceIndex).slice(0, 16),
                sourceIndex: source.sourceIndex,
                summary: source.summary,
                topics: artifact.topics,
                workstreamIds: artifact.workstreamIds
            });
        });
    });
    return result.sort(compareReadingSections);
}

function mergeTaxonomy(artifacts, baseArtifacts, taxonomy) {
    var annotations = mapBy(taxonomy.annotations || [], 'path');
    var errors = validateTaxonomy(artifacts, baseArtifacts, taxonomy);
    if (errors.length) {
        throw new Error(errors.join('\n'));
    }
    return baseArtifacts.map(function (artifact) {
        var annotation = annotations[artifact.path];
        var result = JSON.parse(JSON.stringify(artifact));
        if (!annotation) {
            return result;
        }
        result.topics = uniqueSorted(result.topics.concat(annotation.topics || []));
        result.workstreamIds = uniqueSorted(result.workstreamIds.concat(annotation.relatedWorkstreamIds || []));
        result.changeIds = uniqueSorted(result.changeIds.concat(annotation.relatedChangeIds || []));
        result.featured = annotation.featured === true;
        return result;
    }).sort(compareArtifacts);
}

function nearestHeading(markdown, offset) {
    var expression = /^(#{1,6})\s+(.+)$/gm;
    var match;
    var heading = '';
    match = expression.exec(markdown);
    while (match && match.index < offset) {
        heading = match[2].replace(/[`*_]/g, '').trim();
        match = expression.exec(markdown);
    }
    return heading;
}

function mermaidType(source) {
    var declaration = '';
    source.split(/\r?\n/).some(function (line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed.indexOf('%%') === 0) {
            return false;
        }
        declaration = trimmed;
        return true;
    });
    return (declaration.match(/^([A-Za-z][A-Za-z0-9-]*)/) || [null, 'unknown'])[1];
}

function isKnownMermaidType(type) {
    return /^(?:architecture-beta|block-beta|c4[a-z]+|classdiagram|erdiagram|flowchart|gantt|gitgraph|graph|journey|kanban|mindmap|packet-beta|pie|quadrantchart|requirementdiagram|sankey-beta|sequencediagram|statediagram(?:-v2)?|timeline|treemap-beta|xychart-beta|zenuml)$/i.test(type);
}

function diagramStanding(artifact) {
    var archived = (artifact.relatedStatuses || []).some(function (status) {
        return status.entityType === 'change-location' && status.status === 'archived';
    });
    if (artifact.kind === 'architecture') { return 'target-architecture'; }
    if (artifact.kind === 'program-design') { return 'program-orchestration'; }
    if (artifact.authority === 'change-artifact') {
        return archived ? 'historical-change' : 'change-supporting';
    }
    return 'supporting-evidence';
}

function extractDiagrams(artifacts) {
    var explicitIds = {};
    var diagrams = [];
    artifacts.filter(function (artifact) { return artifact.format === 'md'; }).forEach(function (artifact) {
        var expression = /```mermaid[ \t]*\r?\n([\s\S]*?)```/gi;
        var match;
        var index = 0;
        match = expression.exec(artifact.content);
        while (match) {
            var heading = nearestHeading(artifact.content, match.index);
            var explicit = heading.match(/\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,})\b/);
            var diagramId;
            var type;
            index += 1;
            diagramId = explicit ? explicit[1] : 'diagram-' +
                model.sha256(artifact.artifactId + '\0' + index).slice(0, 16);
            if (explicit && explicitIds[diagramId]) {
                throw new Error('duplicate explicit Diagram ID: ' + diagramId + ' in ' + artifact.path);
            }
            if (explicit) { explicitIds[diagramId] = artifact.path; }
            type = mermaidType(match[1]);
            diagrams.push({
                artifactId: artifact.artifactId,
                assignmentIds: artifact.assignmentIds,
                authority: artifact.authority,
                changeIds: artifact.changeIds,
                diagramId: diagramId,
                explicitId: explicit ? explicit[1] : null,
                featured: artifact.featured,
                gateIds: artifact.gateIds,
                lifecycle: artifact.lifecycle,
                renderable: isKnownMermaidType(type),
                sourceHeading: heading || artifact.title,
                sourceIndex: index,
                sourcePath: artifact.path,
                sourceText: match[1].trim(),
                standing: diagramStanding(artifact),
                topics: artifact.topics,
                type: type,
                workstreamIds: artifact.workstreamIds
            });
            match = expression.exec(artifact.content);
        }
    });
    return diagrams.sort(function (left, right) {
        var leftIndex = ('000000' + left.sourceIndex).slice(-6);
        var rightIndex = ('000000' + right.sourceIndex).slice(-6);
        return (left.sourcePath + '\0' + leftIndex + '\0' + left.diagramId)
            .localeCompare(right.sourcePath + '\0' + rightIndex + '\0' + right.diagramId);
    });
}

/**
 * 构建确定性的工程档案与 Mermaid 图表目录。
 * @param {string} root - 仓库根目录。
 * @param {Object} artifacts - Program 机器工件。
 * @param {Object} [taxonomy] - 可替换的 taxonomy fixture。
 * @returns {Object} 工程档案目录。
 */
function buildArtifactCatalog(root, artifacts, taxonomy) {
    var baseArtifacts = buildBaseArtifacts(root, artifacts);
    var selectedTaxonomy = taxonomy || artifacts.artifactTaxonomy;
    var mergedArtifacts = mergeTaxonomy(artifacts, baseArtifacts, selectedTaxonomy);
    var diagrams = extractDiagrams(mergedArtifacts);
    var readingSections = extractReadingSections(mergedArtifacts, selectedTaxonomy);
    var readingSectionsByArtifact = {};
    readingSections.forEach(function (section) {
        readingSectionsByArtifact[section.artifactId] = readingSectionsByArtifact[section.artifactId] || [];
        readingSectionsByArtifact[section.artifactId].push(section.sectionId);
    });
    mergedArtifacts.forEach(function (artifact) {
        artifact.readingSectionIds = readingSectionsByArtifact[artifact.artifactId] || [];
    });
    return {
        artifacts: mergedArtifacts,
        diagrams: diagrams,
        evidenceTypes: Object.keys(EVIDENCE_TYPE_ORDER),
        lifecycles: Object.keys(LIFECYCLE_ORDER),
        readingSections: readingSections,
        readingRoles: Object.keys(READING_ROLE_ORDER),
        topics: selectedTaxonomy.topics.slice().sort(function (left, right) {
            return left.topicId.localeCompare(right.topicId);
        })
    };
}

module.exports = {
    buildArtifactCatalog: buildArtifactCatalog,
    buildBaseArtifacts: buildBaseArtifacts,
    compareArtifacts: compareArtifacts,
    compareReadingSections: compareReadingSections,
    extractDiagrams: extractDiagrams,
    extractReadingSections: extractReadingSections,
    listArtifactDefinitions: listArtifactDefinitions,
    listGovernedFiles: listGovernedFiles,
    markdownSections: markdownSections,
    mergeTaxonomy: mergeTaxonomy,
    validateTaxonomy: validateTaxonomy
};
