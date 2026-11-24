'use strict';

const path = require('node:path');
const planner = require('../core/archive-plan');
const { fail } = require('../core/archive-files');
const transaction = require('../core/archive-transaction');
const { readArchivePolicy } = require('./archive-binding-policy');

function parseArguments(args) {
    const [action, changeId, flag, review, ...rest] = args;
    if (!changeId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(changeId) || changeId === 'archive') {
        throw fail('ARCHIVE_CHANGE_INVALID', '请指定要检查的活跃 Change ID。');
    }
    if (action === 'preflight' && args.length === 2) { return { action, changeId }; }
    if (action !== 'commit' || flag !== '--review' || !/^[0-9a-f]{64}$/.test(review || '') || rest.length % 2) {
        throw fail('ARCHIVE_ARGUMENTS_INVALID', '先运行 --archive preflight <change>，确认写入后再运行 --archive commit <change> --review <fingerprint>。');
    }
    const warnings = [];
    for (let index = 0; index < rest.length; index += 2) {
        if (rest[index] !== '--accept-warning' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(rest[index + 1])) {
            throw fail('ARCHIVE_ARGUMENTS_INVALID', '警告确认需要使用 --accept-warning <id>。');
        }
        warnings.push(rest[index + 1]);
    }
    return { action, changeId, review, warnings };
}

/** 预检与写入分别调用；写入前复核当前工作树和用户已查看的全部输入。 */
async function archiveFromAgent({ args, project, userDataPath }) {
    const request = parseArguments(args);
    if (!project) { throw fail('ARCHIVE_PROJECT_MISSING', '请在工作台已登记的 OpenSpec 项目中运行归档检查。'); }
    const root = project.rootPath;
    const recoveryDirectory = path.join(userDataPath, 'archive-operations');
    const pending = await transaction.recoveries(recoveryDirectory, root);
    if (pending.length) {
        return { status: 'blocked', code: 'ARCHIVE_RECOVERY_REQUIRED', projectId: project.id, root,
            changeId: request.changeId, message: '请在工作台查看未决归档的恢复说明。', recoveries: pending };
    }
    const options = { getArchivePolicy: projectRoot => readArchivePolicy(userDataPath, projectRoot), cliOptions: {
        command: process.env.OPENSPEC_GUI_CLI,
        bundledCommand: process.resourcesPath && path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec')
    } };
    const plan = await planner.prepare(root, request.changeId, options);
    if (request.action === 'preflight') {
        return { status: 'ready', projectId: project.id, root, ...plan.preview };
    }
    if (request.review !== plan.reviewFingerprint) {
        throw fail('ARCHIVE_STALE', '项目、Change 或预检依据已变化，请重新检查并审阅当前结果。');
    }
    const warnings = plan.preview.warnings.map(warning => warning.id).sort();
    if (JSON.stringify(warnings) !== JSON.stringify(request.warnings.sort())) {
        throw fail('ARCHIVE_WARNINGS_REQUIRED', '请先明确接受预检结果列出的警告，并逐项传入 --accept-warning。');
    }
    const result = await transaction.commit(plan, recoveryDirectory, options);
    if (result.state !== 'completed') {
        const code = result.state === 'restored' ? 'ARCHIVE_WRITE_RESTORED' : 'ARCHIVE_RECOVERY_REQUIRED';
        return { status: 'blocked', code, projectId: project.id, root, ...result };
    }
    return { status: 'archived', projectId: project.id, root, changeId: result.changeId, destination: result.destination };
}

module.exports = { archiveFromAgent };
