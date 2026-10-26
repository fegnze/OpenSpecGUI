'use strict';

var files = require('../core/archive-files');
var planner = require('../core/archive-plan');
var transaction = require('../core/archive-transaction');

function ChangeArchiveService(options) {
    this.options = options || {};
    this.plans = new Map();
    this.preparing = 0;
    this.epoch = 0;
    this.busy = false;
}

ChangeArchiveService.prototype.invalidate = function () {
    this.epoch += 1;
    var self = this;
    this.plans.forEach(function (entry, id) { if (!entry.promise) { clearTimeout(entry.timer); self.plans.delete(id); } });
};

ChangeArchiveService.prototype.recoveries = function (root) { return transaction.recoveries(this.options.recoveryDirectory, root); };

ChangeArchiveService.prototype.prepare = async function (request) {
    var pendingCount = Array.from(this.plans.values()).filter(function (entry) { return !entry.promise; }).length;
    if (this.busy || this.preparing >= 2 || pendingCount >= 2) { throw files.fail('ARCHIVE_BUSY', '已有归档操作或预览，请完成或取消后重试'); }
    if ((await this.recoveries(request.root)).length) { throw files.fail('ARCHIVE_RECOVERY_REQUIRED', '此项目存在未决归档恢复状态，请查看工作台中的恢复说明'); }
    var epoch = this.epoch;
    this.preparing += 1;
    try {
        var plan = await planner.prepare(request.root, request.changeId, this.options);
        if (this.epoch !== epoch || this.busy) { throw files.fail('ARCHIVE_STALE', '预检期间项目已切换或刷新，请重新检查'); }
        var retainedBytes = 0;
        this.plans.forEach(function (entry) { if (!entry.promise) { entry.plan.before.forEach(function (value) { retainedBytes += value.content ? value.content.length : 0; }); } });
        plan.before.forEach(function (value) { retainedBytes += value.content ? value.content.length : 0; });
        if (retainedBytes > 96 * 1024 * 1024) { throw files.fail('ARCHIVE_LIMIT', '归档预览占用超过限制，请关闭其他预览后重试'); }
        var self = this;
        var entry = { plan: plan, projectId: request.projectId, revision: request.revision };
        entry.timer = setTimeout(function () { if (!entry.promise) { self.plans.delete(plan.id); } }, this.options.planTtlMs || 10 * 60 * 1000);
        entry.timer.unref();
        this.plans.set(plan.id, entry);
        return Object.assign({ planId: plan.id, projectId: request.projectId, revision: request.revision }, plan.preview);
    } finally { this.preparing -= 1; }
};

ChangeArchiveService.prototype.entry = function (request) {
    var entry = this.plans.get(request.planId);
    if (!entry || entry.projectId !== request.projectId || entry.revision !== request.revision) { throw files.fail('ARCHIVE_STALE', '归档预览已失效，请重新检查'); }
    return entry;
};

ChangeArchiveService.prototype.discard = function (request) {
    var entry = this.plans.get(request.planId);
    if (entry && entry.projectId === request.projectId && entry.revision === request.revision && !entry.promise) {
        clearTimeout(entry.timer);
        this.plans.delete(request.planId);
    }
    return { discarded: true };
};

ChangeArchiveService.prototype.commit = function (request) {
    var entry = this.entry(request);
    if (entry.promise) { return entry.promise; }
    if (this.busy || this.preparing) { throw files.fail('ARCHIVE_BUSY', '归档检查或写入正在执行，请稍后重试'); }
    var accepted = request.acceptedWarnings || [];
    if (entry.plan.preview.warnings.some(function (warning) { return accepted.indexOf(warning.id) === -1; }) || accepted.some(function (id) { return !entry.plan.preview.warnings.some(function (warning) { return warning.id === id; }); })) { throw files.fail('ARCHIVE_WARNINGS_REQUIRED', '请先明确接受预览中列出的未完成项和警告'); }
    var self = this;
    this.busy = true;
    clearTimeout(entry.timer);
    entry.promise = transaction.commit(entry.plan, this.options.recoveryDirectory, this.options).finally(function () {
        self.busy = false;
        entry.plan.before.clear();
        entry.plan.changes = [];
        entry.plan.preview.changes = [];
        entry.timer = setTimeout(function () { self.plans.delete(request.planId); }, 10 * 60 * 1000);
        entry.timer.unref();
        if (self.plans.size > 32) {
            for (var old of self.plans) {
                if (old[1] !== entry && old[1].promise) { clearTimeout(old[1].timer); self.plans.delete(old[0]); break; }
            }
        }
    });
    return entry.promise;
};

module.exports = { ChangeArchiveService: ChangeArchiveService };
