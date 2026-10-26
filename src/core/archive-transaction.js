'use strict';

var fs = require('node:fs/promises');
var path = require('node:path');
var files = require('./archive-files');
var planner = require('./archive-plan');

function recordPath(directory, id) {
    if (!/^[a-f0-9]{48}$/.test(id)) { throw files.fail('ARCHIVE_RECORD_INVALID', '归档操作记录无效'); }
    return path.join(directory, id + '.json');
}

function validateRecord(record) {
    if (!record || record.version !== 1 || !path.isAbsolute(record.root) || !/^openspec\/changes\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(record.source) || record.source === 'openspec/changes/archive' || !/^openspec\/changes\/archive\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,220}$/.test(record.destination) || !Array.isArray(record.changes) || record.changes.length > 128) { throw files.fail('ARCHIVE_RECORD_INVALID', '归档恢复记录格式无效'); }
    recordPath('', record.id);
    record.changes.forEach(function (change) {
        if (!/^openspec\/specs\/.+\/spec\.md$/.test(change.path)) { throw files.fail('ARCHIVE_RECORD_INVALID', '归档恢复路径无效'); }
        files.resolveInside(record.root, change.path);
        if (change.backup !== change.path + '.gui-' + record.id + '.bak' || change.staged !== change.path + '.gui-' + record.id + '.next') { throw files.fail('ARCHIVE_RECORD_INVALID', '归档备份路径无效'); }
    });
    files.resolveInside(record.root, record.source);
    files.resolveInside(record.root, record.destination);
}

async function exists(root, relative) {
    var target = await files.assertSafe(root, relative, true);
    try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
}

async function changeDigest(root, relative) {
    if (!await exists(root, relative)) { return null; }
    return files.digest(await files.readTree(root, [relative]), relative);
}

async function save(directory, record) { await files.atomicJson(recordPath(directory, record.id), record); }

async function verifyFiles(record, final) {
    for (var change of record.changes) {
        if (await files.fileHash(record.root, change.path) !== (final ? change.afterHash : change.beforeHash)) { return false; }
    }
    return true;
}

async function settledState(record) {
    var sourceHash = await changeDigest(record.root, record.source);
    var destinationHash = await changeDigest(record.root, record.destination);
    if (!sourceHash && destinationHash === record.changeHash && await verifyFiles(record, true)) { return 'completed'; }
    if (sourceHash === record.changeHash && !destinationHash && await verifyFiles(record, false)) { return 'restored'; }
    return 'needs-recovery';
}

async function recoveries(directory, root) {
    var names;
    try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') { return []; } throw error; }
    var results = [];
    for (var name of names.filter(function (entry) { return /^[a-f0-9]{48}\.json$/.test(entry); }).sort().slice(-1000)) {
        var target = path.join(directory, name);
        var record;
        try {
            record = JSON.parse((await files.readRegular(target, 8 * 1024 * 1024)).content.toString('utf8'));
            validateRecord(record);
            if (record.root !== root || record.state === 'completed' || record.state === 'restored') { continue; }
            var state = await settledState(record);
            if (state !== 'needs-recovery') { record.state = state; await save(directory, record); continue; }
            results.push({ id: record.id, changeId: path.basename(record.source), state: state, source: record.source, destination: record.destination, recordPath: target, files: record.changes.map(function (change) { return change.path; }), message: '归档曾被中断或恢复遇到冲突。请核对原目录、归档目录及操作记录中的备份；手动处理后刷新重新检查。' });
        } catch (error) {
            results.push({ id: name.slice(0, -5), state: 'needs-recovery', recordPath: target, message: '无法安全核对归档记录，请保留记录并修复后重试：' + error.message });
        }
    }
    return results;
}

async function verifyPlanOutputs(plan) {
    var tree = await files.capture(plan.root, plan.changeId);
    var originalRest = new Map(Array.from(plan.before).filter(function (entry) { return entry[0] !== 'openspec/specs' && !entry[0].startsWith('openspec/specs/'); }));
    var currentRest = new Map(Array.from(tree).filter(function (entry) { return entry[0] !== 'openspec/specs' && !entry[0].startsWith('openspec/specs/'); }));
    if (files.digest(originalRest) !== files.digest(currentRest)) { throw files.fail('ARCHIVE_STALE', '执行期间 Change、配置或工作流发生变化'); }
    var expected = new Map(Array.from(plan.before).filter(function (entry) { return entry[0].startsWith('openspec/specs/') && entry[1].type === 'file'; }).map(function (entry) { return [entry[0], entry[1].hash]; }));
    var owned = new Set();
    plan.changes.forEach(function (change) {
        if (change.afterHash === null) { expected.delete(change.path); } else { expected.set(change.path, change.afterHash); }
        owned.add(change.path + '.gui-' + plan.id + '.bak');
        owned.add(change.path + '.gui-' + plan.id + '.next');
    });
    for (var original of plan.changes) {
        if (original.beforeHash !== null && await files.fileHash(plan.root, original.path + '.gui-' + plan.id + '.bak') !== original.beforeHash) {
            throw files.fail('ARCHIVE_STALE', '原规范的备份收到外部修改，已保留内容：' + original.path);
        }
    }
    var actual = new Map(Array.from(tree).filter(function (entry) { return entry[0].startsWith('openspec/specs/') && entry[1].type === 'file' && !owned.has(entry[0]); }).map(function (entry) { return [entry[0], entry[1].hash]; }));
    if (JSON.stringify(Array.from(expected).sort()) !== JSON.stringify(Array.from(actual).sort())) { throw files.fail('ARCHIVE_STALE', '执行期间正式规范发生变化'); }
}

async function cleanup(record) {
    for (var change of record.changes) {
        for (var relative of [change.backup, change.staged]) {
            try {
                var expected = relative === change.backup ? change.beforeHash : change.afterHash;
                if (expected !== null && await files.fileHash(record.root, relative) === expected) { await fs.unlink(await files.assertSafe(record.root, relative, false)); }
            } catch (error) { if (error.code !== 'ENOENT') { /* Preserve uncertain backups. */ } }
        }
        if (change.afterHash === null) {
            var directory = path.posix.dirname(change.path);
            while (directory !== 'openspec/specs') {
                try { await fs.rmdir(await files.assertSafe(record.root, directory, false)); }
                catch (error) { break; }
                directory = path.posix.dirname(directory);
            }
        }
    }
}

async function rollback(record) {
    var conflicts = [];
    try {
        var source = await changeDigest(record.root, record.source);
        var destination = await changeDigest(record.root, record.destination);
        if (!source && destination === record.changeHash) {
            await planner.assertAbsent(record.root, record.source);
            await fs.mkdir(files.resolveInside(record.root, record.source));
            await fs.rename(await files.assertSafe(record.root, record.destination, false), files.resolveInside(record.root, record.source));
        } else if (!source || source !== record.changeHash) { conflicts.push(record.source); }
    } catch (error) { conflicts.push(record.source + ': ' + error.message); }
    for (var change of record.changes.slice().reverse()) {
        if (!change.started) { continue; }
        try {
            var backup = await exists(record.root, change.backup);
            var current = await files.fileHash(record.root, change.path);
            if (!backup && current === change.beforeHash) { continue; }
            if (current !== null) {
                if (current !== change.afterHash) { throw files.fail('ARCHIVE_RECOVERY_CONFLICT', '文件已有外部修改'); }
                // Move aside before inspecting again, retaining a racing writer's bytes.
                if (await exists(record.root, change.staged)) {
                    if (await files.fileHash(record.root, change.staged) !== change.afterHash) { throw files.fail('ARCHIVE_RECOVERY_CONFLICT', '暂存文件已有外部修改'); }
                    await fs.unlink(files.resolveInside(record.root, change.staged));
                }
                await fs.rename(await files.assertSafe(record.root, change.path, false), files.resolveInside(record.root, change.staged));
                if (await files.fileHash(record.root, change.staged) !== change.afterHash) { throw files.fail('ARCHIVE_RECOVERY_CONFLICT', '恢复期间文件发生变化，已保留暂存内容'); }
            }
            if (backup) {
                await files.assertSafe(record.root, change.backup, false);
                await fs.link(files.resolveInside(record.root, change.backup), files.resolveInside(record.root, change.path));
                // A late write to the original inode remains visible at the restored path.
                await fs.unlink(files.resolveInside(record.root, change.backup));
                if (await files.fileHash(record.root, change.path) !== change.beforeHash) { throw files.fail('ARCHIVE_RECOVERY_CONFLICT', '原文件收到外部修改，已恢复该内容而非覆盖'); }
            } else if (change.beforeHash !== null) { throw files.fail('ARCHIVE_RECOVERY_CONFLICT', '原文件备份缺失'); }
        } catch (error) { conflicts.push(change.path + ': ' + error.message); }
    }
    if (record.reservation) {
        try {
            var stat = await exists(record.root, record.destination);
            if (stat && stat.ino === record.reservation.ino && stat.dev === record.reservation.dev) { await fs.rmdir(files.resolveInside(record.root, record.destination)); }
        } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') { conflicts.push(record.destination); } }
    }
    if (!conflicts.length) {
        await cleanup(record);
        for (var directory of (record.createdDirs || []).slice().reverse()) {
            try { await fs.rmdir(await files.assertSafe(record.root, directory, false)); } catch (error) { /* Never remove nonempty directories. */ }
        }
    }
    return conflicts;
}

async function commit(plan, directory, options) {
    var settings = options || {};
    await planner.revalidate(plan, settings);
    if ((await recoveries(directory, plan.root)).length) { throw files.fail('ARCHIVE_RECOVERY_REQUIRED', '此项目有未决归档恢复状态，请处理后重试'); }
    var record = { version: 1, id: plan.id, root: plan.root, source: plan.source, destination: plan.destination, changeHash: plan.changeHash, state: 'writing', createdDirs: [], changes: plan.changes.map(function (change) { return Object.assign({}, change, { backup: change.path + '.gui-' + plan.id + '.bak', staged: change.path + '.gui-' + plan.id + '.next', started: false }); }) };
    validateRecord(record);
    await save(directory, record);
    async function hook(stage, change) { if (settings.onStep) { await settings.onStep(stage, record, change); } }
    try {
        await files.ensureParent(record.root, record.destination, record.createdDirs);
        await fs.mkdir(await files.assertSafe(record.root, record.destination, true));
        var reservation = await fs.lstat(files.resolveInside(record.root, record.destination));
        record.reservation = { ino: reservation.ino, dev: reservation.dev };
        await save(directory, record);
        await hook('reserved');
        if (plan.inputHash !== files.digest(await files.capture(plan.root, plan.changeId))) { throw files.fail('ARCHIVE_STALE', '执行前项目文件发生变化'); }
        for (var change of record.changes) {
            await files.ensureParent(record.root, change.path, record.createdDirs);
            if (await files.fileHash(record.root, change.path) !== change.beforeHash) { throw files.fail('ARCHIVE_STALE', '正式规范发生变化：' + change.path); }
            change.started = true;
            await save(directory, record);
            if (change.after !== null) { await files.writeExclusive(await files.assertSafe(record.root, change.staged, true), Buffer.from(change.after), change.mode); }
            if (change.before !== null) {
                await planner.assertAbsent(record.root, change.backup);
                await fs.rename(await files.assertSafe(record.root, change.path, false), files.resolveInside(record.root, change.backup));
                if (await files.fileHash(record.root, change.backup) !== change.beforeHash) { throw files.fail('ARCHIVE_STALE', '正式规范在写入时发生变化，已保留备份'); }
            }
            await hook('backed-up', change);
            if (change.after !== null) {
                await files.assertSafe(record.root, change.path, true);
                await fs.link(files.resolveInside(record.root, change.staged), files.resolveInside(record.root, change.path));
                await fs.unlink(files.resolveInside(record.root, change.staged));
            }
            await save(directory, record);
            await hook('file-written', change);
        }
        await verifyPlanOutputs(plan);
        await hook('before-move');
        var currentReservation = await exists(record.root, record.destination);
        if (!currentReservation || currentReservation.ino !== reservation.ino || currentReservation.dev !== reservation.dev || (await fs.readdir(files.resolveInside(record.root, record.destination))).length) { throw files.fail('ARCHIVE_DESTINATION_EXISTS', '归档目标在执行期间被占用'); }
        // Recheck immediately after any injected or asynchronous boundary.
        await verifyPlanOutputs(plan);
        await fs.rename(await files.assertSafe(record.root, record.source, false), await files.assertSafe(record.root, record.destination, false));
        await hook('moved');
        if (await settledState(record) !== 'completed') { throw files.fail('ARCHIVE_RESULT_INVALID', '最终文件结果与预览不一致'); }
        record.state = 'completed';
        await save(directory, record);
        await cleanup(record);
        return { state: 'completed', changeId: plan.changeId, archivedAs: plan.archivedAs, destination: plan.destination, specsUpdated: plan.changes.length > 0, warnings: plan.preview.warnings };
    } catch (error) {
        var conflicts = await rollback(record);
        record.state = conflicts.length ? 'needs-recovery' : 'restored';
        record.error = error.message;
        record.conflicts = conflicts;
        await save(directory, record);
        return { state: record.state, changeId: plan.changeId, destination: plan.destination, message: error.message + (conflicts.length ? '；部分文件需要人工恢复，请保留操作记录与备份。' : '；本次写入已恢复。'), conflicts: conflicts, recordPath: recordPath(directory, record.id), warnings: plan.preview.warnings };
    }
}

module.exports = { commit: commit, recoveries: recoveries, settledState: settledState, validateRecord: validateRecord };
