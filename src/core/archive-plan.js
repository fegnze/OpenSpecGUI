'use strict';

var crypto = require('node:crypto');
var fs = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var files = require('./archive-files');
var cliModule = require('./archive-cli');

function localDate(now) {
    var date = now ? new Date(now()) : new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function archiveName(changeId, date) { return /^\d{4}-\d{2}-\d{2}-/.test(changeId) ? changeId : date + '-' + changeId; }

function diffLines(before, after) {
    var left = before === null ? [] : before.split('\n');
    var right = after === null ? [] : after.split('\n');
    var start = 0;
    var end = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) { start += 1; }
    while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) { end += 1; }
    return left.slice(0, start).map(function (text) { return { kind: 'context', text: text }; })
        .concat(left.slice(start, left.length - end).map(function (text) { return { kind: 'removed', text: text }; }))
        .concat(right.slice(start, right.length - end).map(function (text) { return { kind: 'added', text: text }; }))
        .concat(end ? left.slice(-end).map(function (text) { return { kind: 'context', text: text }; }) : []);
}

async function assertAbsent(root, relative) {
    var target = await files.assertSafe(root, relative, true);
    try { await fs.lstat(target); }
    catch (error) { if (error.code === 'ENOENT') { return; } throw error; }
    throw files.fail('ARCHIVE_DESTINATION_EXISTS', '归档目标已存在，不会覆盖：' + relative);
}

async function prepare(projectRoot, changeId, options) {
    var settings = options || {};
    var cli = await cliModule.resolve(projectRoot, settings.cliOptions);
    var before = await files.capture(projectRoot, changeId, settings.limits);
    var source = 'openspec/changes/' + changeId;
    var date = localDate(settings.now);
    var name = archiveName(changeId, date);
    var destination = 'openspec/changes/archive/' + name;
    await assertAbsent(projectRoot, destination);
    var liveStatus = await cliModule.run(cli, projectRoot, ['status', '--change', changeId, '--json'], settings);
    cliModule.assertRoot(liveStatus, projectRoot);
    var temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-archive-')));
    try {
        await files.materialize(temporary, before);
        var status = await cliModule.run(cli, temporary, ['status', '--change', changeId, '--json'], settings);
        cliModule.assertRoot(status, temporary);
        if (!Array.isArray(status.artifacts) || !status.artifactPaths) { throw files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 缺少归档检查所需的产物状态，请更新 CLI'); }
        var listing = await cliModule.run(cli, temporary, ['list', '--json'], settings);
        cliModule.assertRoot(listing, temporary);
        var listed = Array.isArray(listing.changes) ? listing.changes.filter(function (change) { return change.name === changeId; }) : [];
        if (listed.length !== 1 || !Number.isSafeInteger(listed[0].totalTasks) || !Number.isSafeInteger(listed[0].completedTasks) || listed[0].completedTasks < 0 || listed[0].totalTasks < listed[0].completedTasks) { throw files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 未提供选中变更的完整任务统计'); }
        var tasks = { completed: listed[0].completedTasks, total: listed[0].totalTasks };
        var validation = await cliModule.run(cli, temporary, ['validate', changeId, '--type', 'change', '--strict', '--no-interactive', '--json'], settings);
        cliModule.assertRoot(validation, temporary);
        if (!Array.isArray(validation.items) || validation.items.length !== 1 || validation.items[0].id !== changeId || validation.items[0].valid !== true) {
            throw files.fail('ARCHIVE_VALIDATION_FAILED', 'CLI 未确认所选变更通过结构校验');
        }
        var result = await cliModule.run(cli, temporary, ['archive', changeId, '--json', '--yes'], settings);
        cliModule.assertRoot(result, temporary);
        if (!result.archive || result.archive.change !== changeId || result.archive.archivedAs !== name || path.resolve(result.archive.path) !== files.resolveInside(temporary, destination)) {
            throw files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 归档结果与预期目标不一致，请重新检查或更新 CLI');
        }
        var after = await files.readTree(temporary, await fs.readdir(temporary), settings.limits);
        if (after.has(source) || files.digest(before, source) !== files.digest(after, destination)) {
            throw files.fail('ARCHIVE_RESULT_INVALID', 'CLI 未完整保留 Change 的文件和目录，无法归档');
        }
        for (var item of after) {
            var relative = item[0];
            var value = item[1];
            var inSpecs = relative === 'openspec/specs' || relative.startsWith('openspec/specs/');
            var inArchive = relative === destination || relative.startsWith(destination + '/');
            var container = ['openspec', 'openspec/changes', 'openspec/changes/archive'].includes(relative) && value.type === 'directory';
            if (inArchive || container) { continue; }
            if (inSpecs) {
                var previous = before.get(relative);
                var changed = !previous || previous.type !== value.type || previous.hash !== value.hash;
                if (value.type === 'file' && changed && !/^openspec\/specs\/.+\/spec\.md$/.test(relative)) { throw files.fail('ARCHIVE_RESULT_INVALID', 'CLI 修改了非正式规范文件：' + relative); }
            } else {
                var old = before.get(relative);
                if (!old || old.type !== value.type || old.hash !== value.hash || old.mode !== value.mode) { throw files.fail('ARCHIVE_RESULT_INVALID', 'CLI 修改了归档范围之外的内容：' + relative); }
            }
        }
        for (var original of before) {
            if (original[0] === source || original[0].startsWith(source + '/') || original[0] === 'openspec/specs' || original[0].startsWith('openspec/specs/')) { continue; }
            if (original[1].type !== 'missing' && !after.has(original[0])) { throw files.fail('ARCHIVE_RESULT_INVALID', 'CLI 删除了归档范围之外的内容'); }
        }
        var paths = Array.from(new Set(Array.from(before.keys()).concat(Array.from(after.keys())))).filter(function (relative) { return /^openspec\/specs\/.+\/spec\.md$/.test(relative); }).sort();
        var changes = [];
        var previewBytes = 0;
        for (var specPath of paths) {
            var oldFile = before.get(specPath);
            var newFile = after.get(specPath);
            if (oldFile && oldFile.type !== 'file' || newFile && newFile.type !== 'file') { throw files.fail('ARCHIVE_RESULT_INVALID', '正式规范文件类型不受支持'); }
            if ((oldFile && oldFile.hash) === (newFile && newFile.hash)) { continue; }
            var oldText = oldFile ? oldFile.content.toString('utf8') : null;
            var newText = newFile ? newFile.content.toString('utf8') : null;
            if (oldFile && !Buffer.from(oldText).equals(oldFile.content) || newFile && !Buffer.from(newText).equals(newFile.content)) { throw files.fail('ARCHIVE_RESULT_INVALID', '正式规范必须是 UTF-8 文本'); }
            previewBytes += (oldFile ? oldFile.content.length : 0) + (newFile ? newFile.content.length : 0);
            if (previewBytes > (settings.maxPreviewBytes || 1024 * 1024) || changes.length >= 128) { throw files.fail('ARCHIVE_LIMIT', '规范差异超过完整预览限制，请通过外部工具处理'); }
            changes.push({ path: specPath, kind: !oldFile ? 'added' : (!newFile ? 'removed' : 'modified'), before: oldText, after: newText, beforeHash: oldFile ? oldFile.hash : null, afterHash: newFile ? newFile.hash : null, mode: oldFile ? oldFile.mode : newFile.mode });
        }
        // Unrelated spec files must also be preserved, including non-Markdown files.
        for (var originalSpec of before) {
            if (originalSpec[0].startsWith('openspec/specs/') && originalSpec[1].type === 'file' && !/^openspec\/specs\/.+\/spec\.md$/.test(originalSpec[0])) {
                if (!after.has(originalSpec[0]) || after.get(originalSpec[0]).hash !== originalSpec[1].hash) { throw files.fail('ARCHIVE_RESULT_INVALID', 'CLI 丢弃了规范目录中的其他文件'); }
            }
        }
        var warnings = status.artifacts.filter(function (artifact) { return artifact.status !== 'done' && artifact.status !== 'skipped'; }).map(function (artifact) { return { id: 'artifact:' + artifact.id, message: '产物尚未完成：' + artifact.id }; });
        if (tasks.completed < tasks.total) { warnings.push({ id: 'tasks:incomplete', message: '仍有 ' + (tasks.total - tasks.completed) + ' 项任务未完成' }); }
        (result.archive.warnings || []).forEach(function (warning, index) { warnings.push({ id: 'cli:' + index, message: String(warning) }); });
        var currentInputs = await files.capture(projectRoot, changeId, settings.limits);
        var currentCli = await cliModule.resolve(projectRoot, settings.cliOptions);
        if (files.digest(before) !== files.digest(currentInputs) || files.identityDigest(before) !== files.identityDigest(currentInputs) || cli.fingerprint !== currentCli.fingerprint) {
            throw files.fail('ARCHIVE_STALE', '预检期间文件或 CLI 已变化，请重新检查');
        }
        await assertAbsent(projectRoot, destination);
        var deltaPaths = status.artifactPaths.specs && status.artifactPaths.specs.existingOutputPaths;
        if (deltaPaths !== undefined && !Array.isArray(deltaPaths)) { throw files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 增量规范路径无效'); }
        return {
            id: crypto.randomBytes(24).toString('hex'), root: projectRoot, changeId: changeId, source: source, destination: destination, archivedAs: name,
            date: date, createdAt: Date.now(), cli: cli, cliOptions: settings.cliOptions, before: before, inputHash: files.digest(before), inputIdentity: files.identityDigest(before), changeHash: files.digest(before, source), changes: changes,
            preview: { changeId: changeId, destination: destination, archivedAs: name, tasks: { completed: tasks.completed, total: tasks.total }, artifacts: status.artifacts.map(function (artifact) { return { id: artifact.id, status: artifact.status }; }), warnings: warnings, syncState: changes.length ? 'needs-sync' : (deltaPaths && deltaPaths.length ? 'already-synced' : 'no-delta'), changes: changes.map(function (change) { return { path: change.path, kind: change.kind, lines: diffLines(change.before, change.after) }; }) }
        };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function revalidate(plan, options) {
    var settings = options || {};
    var inputs = await files.capture(plan.root, plan.changeId, settings.limits);
    var currentCli = await cliModule.resolve(plan.root, plan.cliOptions);
    if (Date.now() - plan.createdAt > (settings.planTtlMs || 10 * 60 * 1000) || archiveName(plan.changeId, localDate(settings.now)) !== plan.archivedAs || plan.inputHash !== files.digest(inputs) || plan.inputIdentity !== files.identityDigest(inputs) || plan.cli.fingerprint !== currentCli.fingerprint) {
        throw files.fail('ARCHIVE_STALE', '预览已失效，文件、CLI 或日期发生变化，请重新检查');
    }
    await assertAbsent(plan.root, plan.destination);
}

module.exports = { prepare: prepare, revalidate: revalidate, assertAbsent: assertAbsent, localDate: localDate, archiveName: archiveName, diffLines: diffLines };
