(function () {
    'use strict';

    function node(tag, className, text) {
        var element = document.createElement(tag);
        if (className) { element.className = className; }
        if (text !== undefined) { element.textContent = text; }
        return element;
    }

    function errorMessage(error) {
        return String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    }

    function ArchiveController(options) {
        this.options = options;
        this.dialog = document.getElementById('archive-dialog');
        this.body = document.getElementById('archive-dialog-body');
        this.confirm = document.getElementById('archive-confirm');
        this.cancel = document.getElementById('archive-cancel');
        this.closeButton = document.getElementById('archive-close');
        this.retry = document.getElementById('archive-retry');
        this.status = document.getElementById('archive-dialog-status');
        this.plan = null;
        this.origin = null;
        this.sequence = 0;
        this.committing = false;
        var self = this;
        this.confirm.addEventListener('click', function () { self.commit(); });
        this.cancel.addEventListener('click', function () { self.close(); });
        this.closeButton.addEventListener('click', function () { self.close(); });
        this.retry.addEventListener('click', function () { self.open(self.changeId, self.returnFocus); });
        this.dialog.addEventListener('cancel', function (event) { event.preventDefault(); self.close(); });
        this.dialog.addEventListener('close', function () { if (!self.committing) { self.discard(); } });
    }

    ArchiveController.prototype.request = function (plan) { return { projectId: plan.projectId, revision: plan.revision, planId: plan.planId }; };

    ArchiveController.prototype.discard = function () {
        this.sequence += 1;
        var plan = this.plan;
        this.plan = null;
        if (plan) { this.options.bridge.changes.discardArchive(this.request(plan)).catch(function () {}); }
    };

    ArchiveController.prototype.close = function () {
        if (this.committing) { return; }
        this.discard();
        this.dialog.close();
        if (this.returnFocus && this.returnFocus.isConnected) { this.returnFocus.focus(); }
    };

    ArchiveController.prototype.contextChanged = function (context) {
        this.showRecoveries(context.archiveRecovery || []);
        if (!this.dialog.open || this.committing || !this.origin) { return; }
        if (context.projectId !== this.origin.projectId || context.revision !== this.origin.revision) {
            this.discard();
            this.confirm.hidden = true;
            this.status.textContent = '预览已失效，项目或文件已经变化。请重新检查。';
            this.status.setAttribute('data-state', 'error');
            this.retry.hidden = context.projectId !== this.origin.projectId;
        }
    };

    ArchiveController.prototype.showRecoveries = function (records) {
        var summary = document.getElementById('archive-recovery-summary');
        summary.replaceChildren();
        summary.hidden = !records.length;
        records.forEach(function (record) {
            var section = node('section');
            section.append(node('strong', '', '归档需要恢复' + (record.changeId ? ' · ' + record.changeId : '')));
            section.append(node('p', '', record.message));
            if (record.source) { section.append(node('p', 'archive-path', record.source + ' → ' + record.destination)); }
            section.append(node('p', 'archive-path', '恢复记录：' + record.recordPath));
            summary.append(section);
        });
    };

    ArchiveController.prototype.open = async function (changeId, trigger) {
        if (this.committing) { return; }
        this.discard();
        this.changeId = changeId;
        this.returnFocus = trigger;
        this.origin = this.options.getContext();
        var sequence = ++this.sequence;
        this.body.replaceChildren(node('p', 'archive-loading', '正在检查任务、产物和规范，并生成归档预览…'));
        document.getElementById('archive-dialog-identity').textContent = this.origin.projectName + ' / ' + changeId;
        this.confirm.hidden = true;
        this.retry.hidden = true;
        this.status.textContent = '检查期间不会修改项目文件。';
        this.status.removeAttribute('data-state');
        this.cancel.disabled = false;
        this.closeButton.disabled = false;
        this.cancel.textContent = '取消';
        if (!this.dialog.open) { this.dialog.showModal(); }
        try {
            var plan = await this.options.bridge.changes.prepareArchive({ projectId: this.origin.projectId, revision: this.origin.revision, changeId: changeId });
            if (sequence !== this.sequence || !this.dialog.open) {
                await this.options.bridge.changes.discardArchive(this.request(plan));
                return;
            }
            this.plan = plan;
            this.renderPlan(plan);
        } catch (error) {
            if (sequence !== this.sequence) { return; }
            this.body.replaceChildren(node('h3', '', '暂时无法归档'), node('p', 'archive-error', errorMessage(error)));
            this.status.textContent = '项目文件未发生变化，可继续浏览或修正后重新检查。';
            this.status.setAttribute('data-state', 'error');
            this.retry.hidden = false;
            this.cancel.textContent = '关闭';
        }
    };

    ArchiveController.prototype.renderPlan = function (plan) {
        var self = this;
        this.body.replaceChildren();
        var checks = node('section', 'archive-checks');
        checks.append(node('h3', '', '归档检查'));
        checks.append(node('p', '', '任务 ' + plan.tasks.completed + ' / ' + plan.tasks.total + ' 已完成 · 文档结构校验通过'));
        var artifacts = node('div', 'archive-artifacts');
        plan.artifacts.forEach(function (artifact) {
            artifacts.append(node('span', '', artifact.id + ' · ' + ({ done: '已生成', skipped: '已跳过', ready: '未完成', blocked: '未完成' }[artifact.status] || artifact.status)));
        });
        checks.append(artifacts, node('p', 'archive-note', '任务和文档状态供归档检查参考，请自行确认实现已验收。'));
        this.body.append(checks);
        if (plan.warnings.length) {
            var warnings = node('fieldset', 'archive-warnings');
            warnings.append(node('legend', '', '继续归档前，请确认这些未完成项或提示'));
            plan.warnings.forEach(function (warning) {
                var label = node('label');
                var checkbox = node('input');
                checkbox.type = 'checkbox';
                checkbox.value = warning.id;
                checkbox.setAttribute('data-archive-warning', '');
                checkbox.addEventListener('change', function () { self.confirm.disabled = self.body.querySelectorAll('[data-archive-warning]:not(:checked)').length > 0; });
                label.append(checkbox, node('span', '', '我了解并接受：' + warning.message));
                warnings.append(label);
            });
            this.body.append(warnings);
        }
        var sync = node('section', 'archive-sync-summary');
        sync.append(node('h3', '', plan.syncState === 'needs-sync' ? '正式规范变更 · ' + plan.changes.length + ' 个文件' : '正式规范无需修改'));
        if (plan.syncState !== 'needs-sync') { sync.append(node('p', '', plan.syncState === 'already-synced' ? '增量规范已同步，本次只移动变更目录。' : '此变更没有增量规范，本次只移动变更目录。')); }
        this.body.append(sync);
        plan.changes.forEach(function (change) {
            var details = node('details', 'archive-file-diff');
            details.open = true;
            details.append(node('summary', '', ({ added: '新增', modified: '修改', removed: '删除整个规范（含 Purpose）' }[change.kind]) + ' · ' + change.path));
            var code = node('pre', 'archive-diff');
            code.setAttribute('tabindex', '0');
            code.setAttribute('aria-label', change.path + ' 文件差异');
            change.lines.forEach(function (line) { code.append(node('span', 'archive-diff-line is-' + line.kind, ({ added: '+', removed: '-', context: ' ' }[line.kind]) + line.text)); });
            details.append(code);
            self.body.append(details);
        });
        var movement = node('section', 'archive-movement');
        movement.append(node('h3', '', '归档位置'), node('p', 'archive-path', plan.destination), node('p', 'archive-note', '完整保留变更目录中的元数据、文档和其他文件。'));
        this.body.append(movement);
        this.confirm.textContent = plan.syncState === 'needs-sync' ? '同步规范并归档' : '归档';
        this.confirm.hidden = false;
        this.confirm.disabled = plan.warnings.length > 0;
        this.status.textContent = '确认后将执行以上文件变更。文件变化后需要重新预览。';
    };

    ArchiveController.prototype.commit = async function () {
        if (!this.plan || this.committing || this.confirm.disabled) { return; }
        var plan = this.plan;
        this.committing = true;
        this.options.setBusy(true);
        this.confirm.disabled = true;
        this.cancel.disabled = true;
        this.closeButton.disabled = true;
        this.body.querySelectorAll('input').forEach(function (input) { input.disabled = true; });
        this.status.textContent = '正在同步与归档，请稍候…';
        var success = null;
        try {
            var request = this.request(plan);
            request.acceptedWarnings = Array.from(this.body.querySelectorAll('[data-archive-warning]:checked')).map(function (input) { return input.value; });
            var result = await this.options.bridge.changes.commitArchive(request);
            if (result.state === 'completed') { success = result; }
            else {
                this.status.textContent = result.message;
                this.status.setAttribute('data-state', 'error');
                this.body.append(node('p', 'archive-error', result.state === 'needs-recovery' ? '需要人工恢复。恢复记录：' + result.recordPath : '本次写入已恢复，可重新检查后再试。'));
            }
        } catch (error) {
            this.status.textContent = errorMessage(error);
            this.status.setAttribute('data-state', 'error');
        } finally {
            this.committing = false;
            this.options.setBusy(false);
            this.plan = null;
            this.confirm.hidden = true;
            this.cancel.disabled = false;
            this.closeButton.disabled = false;
            this.cancel.textContent = '关闭';
            this.origin = null;
        }
        if (success) {
            this.dialog.close();
            await this.options.onSuccess(success);
        } else {
            await this.options.onFailure();
            this.retry.hidden = false;
        }
    };

    window.OpenSpecArchiveController = ArchiveController;
}());
