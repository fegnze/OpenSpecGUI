(function () {
    'use strict';

    var active;
    var pendingWrite;
    var receiptTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
    var statusLabels = {
        available: '可接入', missing: '未检测到', incompatible: '版本不兼容',
        'needs-trust': '待信任', configured: '已配置 · 待验证',
        conflict: '配置冲突', disabled: '已禁用', unknown: '待核对'
    };

    function element(tag, text, className) {
        var node = document.createElement(tag);
        if (text) { node.textContent = text; }
        if (className) { node.className = className; }
        return node;
    }

    function supportedEvents(host) {
        var events = element('dl', '', 'host-events');
        events.setAttribute('aria-label', host.name + ' 支持的事件');
        host.events.forEach(function (event) {
            var pending = event.supported == null || host.status === 'missing' || host.status === 'unknown';
            var description = element('dd');
            description.append(element('span', pending ? '待核对' : (event.supported ? '支持' : '不支持'), 'host-event-status'));
            if (event.detail) { description.append(document.createTextNode(event.detail)); }
            events.append(element('dt', event.name), description);
        });
        return events;
    }

    function configuration(host) {
        var details = element('details', '', 'host-configuration');
        var summary = element('summary', host.targets.length ? '查看接入配置' : '查看宿主详情');
        summary.setAttribute('aria-label', host.name + ' · ' + summary.textContent);
        details.append(summary);
        details.addEventListener('toggle', function () {
            if (!details.open || details.childElementCount > 1) { return; }
            if ((host.canInstall || host.canRemove) && host.events.length) { details.append(supportedEvents(host)); }
            if (host.executable) {
                var location = element('p', '宿主程序', 'host-target');
                location.append(element('code', host.executable));
                details.append(location);
            }
            host.targets.forEach(function (target) {
                var targetBlock = element('div', '', 'host-target');
                targetBlock.append(element('p', target.description), element('code', target.path));
                if (target.preview) {
                    var codeBlock = element('pre');
                    codeBlock.append(element('code', target.preview));
                    targetBlock.append(codeBlock);
                }
                details.append(targetBlock);
            });
        });
        return details;
    }

    function hostActions(host, onAction) {
        var block = element('div', '', 'host-actions');
        var summary = element('dl', '', 'host-action-summary');
        function field(label, value) {
            var description = element('dd');
            description.append(element('code', value));
            summary.append(element('dt', label), description);
        }
        field('当前用户配置', host.configurationPath);
        field('共享钩子程序', host.runnerPath);
        if (host.canInstall && host.installEvents.length) { field('接入事件', host.installEvents.join('、')); }
        if (host.canRemove && host.removeEvents.length) { field('解除事件', host.removeEvents.join('、')); }
        block.append(summary);
        if (host.canInstall) {
            block.append(element('p', '钩子以当前用户身份运行。', 'host-permission'));
        }
        var commands = element('div', '', 'host-commands');
        function command(action, label, className) {
            var button = element('button', label, className);
            button.type = 'button';
            button.addEventListener('click', function () { onAction(host, action); });
            commands.append(button);
        }
        if (host.canInstall) { command('install', '一键接入', 'primary-command'); }
        if (host.canRemove) { command('remove', '解除接入', 'secondary-command'); }
        block.append(commands);
        return block;
    }

    function verificationEvents(host) {
        return host.id === 'dsh' ? ['system-prompt/assemble', 'tools.guard'] : ['SessionStart', 'PreToolUse'];
    }

    function verificationPrompt(host, project, since) {
        var isHarness = host.id === 'dsh';
        var events = verificationEvents(host).join('、');
        var receiptPath = project ? host.receiptsDirectory + '/' + project.id + '/' + host.id : host.receiptsDirectory;
        var lines = [
            '请在本次 ' + host.name + ' 新会话中验证 Agent Workbench 的原生接入。仅采用 ' + since + ' 之后的本机回执。',
            project ? '目标工作树为 ' + JSON.stringify(project.rootPath) + '。若当前目录不属于该工作树，请提示在目标项目新建会话并结束本次验证。' :
                '请确定本次会话所在的已登记工作树根目录。',
            isHarness ? '保持会话工作目录在项目内。在系统临时目录中新建一个独占临时目录，用宿主原生 write 工具向其中的新文件写入一行 OK，随后清理本次临时文件和目录。工作台的 tools.guard 覆盖 write、edit、apply_patch，核对原生 write 的回执即可。' :
                '用' + (host.id === 'claude' ? ' Claude Code 的 Bash 工具' : ' Codex 的终端工具') + '执行一次 pwd -P，触发工具调用前的检查。',
            '只读查看 ' + JSON.stringify(receiptPath) + (project ? ' 中' : ' 下各项目 ' + host.id + ' 子目录中') +
                '本次时间范围的新回执，核对 root、host 与 ' + events + '。保留项目文件原样，请勿手动运行钩子或生成回执。',
            '逐项报告事件、时间、decision 和原因。skipped 表示已触发并跳过检查，timeout 表示检查超时，error 表示执行出错。缺少回执、无权读取或有并发会话无法归属时，标为未确认。'
        ];
        return lines.join('\n');
    }

    function verification(host, project, clipboard) {
        var block = element('div', '', 'host-verification');
        var copy = element('button', '复制验证提示词', 'secondary-command');
        copy.type = 'button';
        var hint = element('span', '先复制，再在目标项目新建 ' + host.name + ' 会话并粘贴。', 'host-verification-hint');
        var feedback = element('span', '', 'host-verification-feedback');
        feedback.setAttribute('role', 'status');
        var details = element('details', '', 'host-verification-preview');
        details.append(element('summary', '查看验证提示词'));
        var body = element('pre');
        function prepare() {
            body.textContent = verificationPrompt(host, project, new Date().toISOString());
            if (!body.parentNode) { details.append(body); }
            return body.textContent;
        }
        details.addEventListener('toggle', function () {
            if (details.open && !body.parentNode) { prepare(); }
        });
        copy.addEventListener('click', async function () {
            copy.disabled = true;
            var text = prepare();
            try {
                await clipboard.write(text);
                feedback.textContent = '已复制';
            } catch {
                details.open = true;
                feedback.textContent = '复制失败，可手动复制或重试。';
            } finally { copy.disabled = false; }
        });
        block.append(copy, hint, feedback, details);
        return block;
    }

    function hostRow(host, onAction, project, clipboard) {
        var row = element('section', '', 'host-row');
        row.dataset.host = host.id;
        var identity = element('header', '', 'host-identity');
        identity.append(element('h2', host.name));
        if (host.version) { identity.append(element('code', host.version)); }
        var info = element('div', '', 'host-info');
        var state = element('strong', statusLabels[host.status] || statusLabels.unknown, 'host-status');
        state.dataset.status = host.status;
        info.append(state, element('p', host.detail, 'host-explanation'));
        if (host.canInstall || host.canRemove) { info.append(hostActions(host, onAction)); }
        else if (host.events.length) { info.append(supportedEvents(host)); }
        if (host.nextSteps.length) {
            var steps = element('ul', '', 'host-steps');
            host.nextSteps.forEach(function (step) { steps.append(element('li', step)); });
            info.append(steps);
        }
        if (host.receiptsDirectory && (host.status === 'configured' || host.status === 'needs-trust')) {
            info.append(verification(host, project, clipboard));
        }
        if (host.targets.length || host.executable) { info.append(configuration(host)); }
        row.append(identity, info);
        return row;
    }

    function showReceiptStatus(row, host, project, receipts) {
        var label = '已配置 · 待验证';
        var kind = 'configured';
        var detail = project.name + ' 尚无此宿主的钩子回执。';
        var events = verificationEvents(host);
        var observed = events.filter(function (event) { return receipts && receipts[event]; });
        var names = { context: '已提供项目上下文', pass: '已放行', deny: '已拦截', skipped: '已跳过', error: '执行出错', timeout: '检查超时' };
        if (!receipts) {
            label = '已配置 · 回执待核对';
            kind = 'unknown';
            detail = '暂时无法读取当前项目的钩子回执。';
        } else if (observed.length) {
            if (observed.some(function (event) { return receipts[event].decision === 'error'; })) {
                label = '已配置 · 钩子执行出错';
                kind = 'verification-error';
            } else if (observed.some(function (event) { return receipts[event].decision === 'timeout'; })) {
                label = '已配置 · 检查超时';
                kind = 'verification-error';
            } else if (observed.length === events.length) {
                label = '已配置 · 钩子已触发';
            } else {
                label = '已配置 · 部分钩子已触发';
                kind = 'verification-partial';
            }
            if (observed.length === events.length && observed.every(function (event) {
                return receipts[event].decision === 'skipped' && receipts[event].reason === '此工作树和宿主没有生效绑定';
            })) {
                detail = project.name + ' 已收到 ' + events.join(' 和 ') + ' 的回执。两项最近均因没有生效绑定而跳过检查。';
            } else {
                detail = project.name + ' 的最近回执显示 ' + events.map(function (event) {
                    var receipt = receipts[event];
                    return event + ' ' + (receipt ? names[receipt.decision] : '待触发');
                }).join('，') + '。';
            }
            var latest = Math.max(...observed.map(function (event) { return Date.parse(receipts[event].timestamp); }));
            detail += ' 最近触发于 ' + receiptTime.format(latest) + '。';
        }
        var state = row.querySelector('.host-status');
        var explanation = row.querySelector('.host-explanation');
        if (state.textContent !== label) { state.textContent = label; }
        if (state.dataset.status !== kind) { state.dataset.status = kind; }
        if (explanation.textContent !== detail) { explanation.textContent = detail; }
    }

    // 宿主 CLI 只在主动检测时运行。可见页面仅轮询当前项目的轻量回执摘要。
    function watchReceipts(page, root, project, hosts, rows) {
        var stopped = false;
        var reading = false;
        var timer;
        var observer = new MutationObserver(function () { if (!root.isConnected) { stop(); } });
        function stop() {
            stopped = true;
            clearTimeout(timer);
            observer.disconnect();
            document.removeEventListener('visibilitychange', update);
            window.removeEventListener('focus', update);
        }
        async function update() {
            clearTimeout(timer);
            if (stopped || document.hidden || reading) { return; }
            reading = true;
            try {
                var result = await hosts.verification();
                if (stopped || !root.isConnected || document.hidden || result.projectId !== project.id) { return; }
                rows.forEach(function (entry) { showReceiptStatus(entry.row, entry.host, project, result.hosts[entry.host.id]); });
            } catch {
                if (!stopped && root.isConnected && !document.hidden) {
                    rows.forEach(function (entry) { showReceiptStatus(entry.row, entry.host, project, null); });
                }
            } finally {
                reading = false;
                if (!stopped && root.isConnected && !document.hidden) { timer = setTimeout(update, 3000); }
            }
        }
        observer.observe(page, { childList: true });
        document.addEventListener('visibilitychange', update);
        window.addEventListener('focus', update);
        update();
        return stop;
    }

    function show(page, bridge, project) {
        var hosts = bridge.hosts;
        var projectKey = project ? JSON.stringify([project.id, project.rootPath]) : '';
        if (active && active.root.isConnected && active.projectKey === projectKey) { return; }
        var root = element('div', '', 'host-setup');
        var header = element('header', '', 'collection-header');
        var title = element('div');
        title.append(element('span', '本机', 'project-context'), element('h1', '宿主接入'));
        var inspect = element('button', '重新检测', 'secondary-command');
        inspect.type = 'button';
        header.append(title, inspect);
        var status = element('p', '', 'host-inspection-status');
        status.setAttribute('role', 'status');
        var list = element('div');
        var stopWatching;
        root.append(header, status, list);
        page.replaceChildren(root);
        function setBusy(busy) {
            inspect.disabled = busy;
            list.querySelectorAll('.host-commands button').forEach(function (button) { button.disabled = busy; });
            list.setAttribute('aria-busy', String(busy));
        }
        function display(result) {
            var rows = [];
            list.replaceChildren(...result.hosts.map(function (host) {
                var row = hostRow(host, apply, project, bridge.clipboard);
                if (project && host.verificationEligible) { rows.push({ host: host, row: row }); }
                return row;
            }));
            if (rows.length) { stopWatching = watchReceipts(page, root, project, hosts, rows); }
        }
        async function inspectHosts(message) {
            try {
                var result = await hosts.inspect();
                if (!root.isConnected) { return; }
                display(result);
                status.textContent = message ? message + ' 已重新检测，请核对后重试。' : '';
            } catch (error) {
                if (!root.isConnected) { return; }
                list.replaceChildren();
                status.textContent = (message ? message + ' ' : '') + '宿主检测失败。请重新检测。';
            }
        }
        async function refresh() {
            if (inspect.disabled) { return; }
            if (stopWatching) { stopWatching(); }
            setBusy(true);
            status.textContent = '正在检测本机宿主…';
            try {
                // 离开页面时已提交的操作仍会完成。回来后读取操作结束时的配置。
                if (pendingWrite) { await pendingWrite.catch(function () {}); }
                if (root.isConnected) { await inspectHosts(); }
            } finally { setBusy(false); }
        }
        async function apply(host, action) {
            if (inspect.disabled || pendingWrite) { return; }
            if (stopWatching) { stopWatching(); }
            setBusy(true);
            var installing = action === 'install';
            status.textContent = (installing ? '正在接入 ' : '正在解除 ') + host.name + '…';
            try {
                pendingWrite = hosts[action]({ host: host.id, planId: host.planId }).finally(function () { pendingWrite = null; });
                var result = await pendingWrite;
                if (!root.isConnected) { return; }
                display(result);
                status.textContent = host.name + (installing ? ' 已完成本机接入配置。' : ' 已移除工作台登记的配置。');
            } catch (error) {
                if (root.isConnected) {
                    var detail = (error.message || '').replace(/^Error invoking remote method 'hosts:(?:install|remove)': (?:Error: )?/, '');
                    await inspectHosts(host.name + (installing ? ' 接入失败。' : ' 解除失败。') + detail);
                }
            } finally {
                setBusy(false);
            }
        }
        active = { root: root, refresh: refresh, projectKey: projectKey };
        inspect.addEventListener('click', refresh);
        refresh();
    }

    window.OpenSpecHostSetup = {
        show: show,
        refresh: function () { if (active && active.root.isConnected) { return active.refresh(); } }
    };
}());
