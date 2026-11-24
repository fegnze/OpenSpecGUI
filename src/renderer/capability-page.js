(function () {
    'use strict';

    var categories = { skill: 'Skills', mcp: 'MCP', tool: 'Tools', rule: '基础规范' };
    var hosts = { codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness' };
    var tools = { command: '本机命令', host: '宿主自带工具', mcp: 'MCP 提供的工具' };
    var providers = ['cv-test1', 'feishu', 'google-drive'];
    var selectedHost = 'codex';
    var active = null;

    function element(tag, text, className) {
        var node = document.createElement(tag);
        if (text != null) { node.textContent = text; }
        if (className) { node.className = className; }
        return node;
    }

    function button(label, action, primary) {
        var node = element('button', label, primary ? 'primary-command' : 'secondary-command');
        node.type = 'button';
        node.addEventListener('click', action);
        return node;
    }

    function field(form, title, node) {
        var label = element('label', null, 'cap-field');
        node.setAttribute('aria-label', title);
        label.append(element('span', title), node);
        form.append(label);
        return node;
    }

    function input(name, placeholder, type) {
        var node = element('input');
        node.name = name;
        node.type = type || 'text';
        node.placeholder = placeholder || '';
        node.autocomplete = 'off';
        node.required = true;
        return node;
    }

    function select(options, value) {
        var node = element('select');
        options.forEach(function (option) { node.add(new Option(option[1], option[0])); });
        node.value = value;
        return node;
    }

    function actions(parent) {
        var bar = element('div', null, 'cap-actions');
        parent.append(bar);
        return bar;
    }

    function versionOf(item, version) {
        return item.versions.find(function (entry) { return entry.version === version; });
    }

    function workspace(options) {
        var root = element('section', null, 'cap-page');
        var list = element('div', null, 'cap-items');
        var split = element('div', null, 'cap-split');
        var counts = element('span', '', 'cap-counts');
        var selectedKind = 'all';
        var selectedItem = null;
        var searchText = '';
        var statusFilter = 'all';
        var status = element('p', '', 'cap-message');
        var panel = element('section', null, 'cap-panel');
        panel.setAttribute('aria-labelledby', 'cap-panel-heading');
        var categoryBar = element('div', null, 'cap-categories');
        var categoryButtons = {};
        var items = [];
        var serial = 0;
        var readId = 0;
        var namedPanelItem = null;
        var statuses = new Map();
        var dialogOpener;
        status.setAttribute('role', 'status');
        panel.hidden = true;
        panel.tabIndex = -1;

        function valid(id) { return root.isConnected && id === serial; }
        function context() { return { projectId: options.projectId, host: selectedHost }; }

        function closePanel(restore) {
            serial += 1;
            panel.querySelectorAll('input[type="password"]').forEach(function (field) { field.value = ''; });
            if (status.classList.contains('is-error')) { message(''); }
            namedPanelItem = null;
            panel.replaceChildren();
            panel.hidden = true;
            split.classList.remove('has-panel');
            split.classList.remove('cap-wide-inspector');
            if (restore) {
                var rowButton = selectedItem && list.querySelector('[data-capability-id="' + CSS.escape(selectedItem) + '"] button');
                var target = dialogOpener && dialogOpener.isConnected ? dialogOpener : rowButton;
                if (target) { target.focus(); }
            }
        }

        function openPanel(title, item) {
            var wasClosed = panel.hidden;
            closePanel(false);
            if (wasClosed) { dialogOpener = document.activeElement; }
            panel.hidden = false;
            split.classList.add('has-panel');
            var head = element('div', null, 'cap-panel-head');
            var heading = element('h2', title);
            heading.id = 'cap-panel-heading';
            var close = button('×', function () { closePanel(true); });
            close.setAttribute('aria-label', '关闭检查器');
            close.title = '关闭检查器（Esc）';
            if (item) {
                namedPanelItem = item;
                addRenameControl(head, heading, item);
            } else { head.append(heading); }
            head.append(close);
            panel.append(head);
            panel.focus();
            return serial;
        }
        panel.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closePanel(true); }
        });

        /** 只更新标题和清单，保留连接面板中的令牌输入及展开状态。 */
        function addRenameControl(head, heading, item) {
            var group = element('div', null, 'cap-panel-title');
            var rename = button('重命名', edit);
            rename.className = 'cap-rename-link';
            group.append(heading, rename);
            head.append(group);
            function edit() {
                var expectedName = item.name;
                var form = element('form', null, 'cap-rename-form');
                var name = field(form, '显示名称', input('display-name'));
                name.value = expectedName;
                name.maxLength = 120;
                var hint = element('p', '本机所有项目共用此名称。', 'cap-detail');
                hint.id = 'cap-rename-hint';
                name.setAttribute('aria-describedby', hint.id);
                var save = element('button', '保存', 'primary-command');
                save.type = 'submit';
                var cancel = button('取消', finish);
                var error = element('p', '', 'cap-rename-error');
                error.setAttribute('role', 'alert');
                var busy = false;
                function finish() {
                    form.remove();
                    rename.hidden = false;
                    rename.focus();
                }
                form.append(hint, error);
                actions(form).append(save, cancel);
                head.after(form);
                rename.hidden = true;
                name.focus();
                name.select();
                form.addEventListener('keydown', function (event) {
                    if (event.key === 'Escape' && !event.isComposing) {
                        event.preventDefault();
                        if (!busy) { finish(); }
                    }
                });
                form.addEventListener('submit', async function (event) {
                    event.preventDefault();
                    if (busy) { return; }
                    var nextName = name.value.trim();
                    if (!nextName) { error.textContent = '请输入显示名称。'; name.focus(); return; }
                    if (nextName === expectedName) { finish(); return; }
                    var operation = serial;
                    busy = true;
                    name.readOnly = true;
                    save.disabled = true;
                    cancel.disabled = true;
                    error.textContent = '';
                    try {
                        var saved = await options.bridge.capabilities.rename(Object.assign(context(), {
                            id: item.id, expectedName: expectedName, name: nextName
                        }));
                        if (valid(operation)) {
                            item.name = saved.name;
                            heading.textContent = saved.name;
                            finish();
                            message('显示名称已保存。');
                        }
                        // 改名适用于所有项目；返回时只更新当前可见清单。
                        if (active && active.root.isConnected) { await active.refresh(); }
                    } catch (reason) {
                        if (!valid(operation)) { return; }
                        var refreshed = await load(true);
                        if (!valid(operation)) { return; }
                        var latest = refreshed && refreshed.find(function (entry) { return entry.id === item.id; });
                        if (latest && latest.name !== expectedName) {
                            expectedName = latest.name;
                            error.textContent = '当前显示名称已变为“' + latest.name + '”。要使用你输入的名称，请再次保存。';
                            save.textContent = '覆盖保存';
                        } else {
                            error.textContent = problem(reason);
                        }
                        busy = false;
                        name.readOnly = false;
                        save.disabled = false;
                        cancel.disabled = false;
                        name.focus();
                    }
                });
            }
        }

        function problem(error) {
            return String(error && error.message || '操作未完成。').replace(/^Error invoking remote method '[^']+': Error: /, '');
        }

        function message(text, isError) {
            status.textContent = text || '';
            status.classList.toggle('is-error', Boolean(isError));
        }

        function copyField(parent, title, text, actionLabel) {
            var line = element('div', null, 'cap-source cap-copy');
            var value = field(line, title, input('copy-value'));
            value.value = text;
            value.readOnly = true;
            var copy = button(actionLabel, function () {
                run(copy, async function (id) {
                    await options.bridge.clipboard.write(text);
                    if (valid(id)) { message('已复制。'); }
                });
            });
            line.append(copy);
            parent.append(line);
        }

        async function run(control, operation) {
            var id = serial;
            control.disabled = true;
            message('');
            try { await operation(id); }
            catch (error) { if (valid(id)) { message(problem(error), true); } }
            finally { if (valid(id) && control.isConnected) { control.disabled = false; } }
        }

        async function preview(request, id) {
            var plan = await options.bridge.capabilities.preview(Object.assign(context(), request));
            if (!valid(id)) { return; }
            openPanel('预览更改');
            panel.append(element('h3', plan.summary));
            var changes = element('ul');
            (plan.details || []).forEach(function (detail) { changes.append(element('li', detail)); });
            panel.append(changes);
            var applyButton = button('确认应用', function () {
                run(applyButton, async function (applyId) {
                    await options.bridge.capabilities.apply({ planId: plan.planId, projectId: context().projectId });
                    if (!valid(applyId)) { return; }
                    closePanel(true);
                    message('工作台配置已更新。');
                    await load();
                });
            }, true);
            actions(panel).append(button('取消', function () { closePanel(true); }), applyButton);
        }

        function submitForm(form, label, callback) {
            var submit = element('button', label, 'primary-command');
            submit.type = 'submit';
            actions(form).append(submit);
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                run(submit, callback);
            });
        }

        function showBinding(item) {
            var bound = item.bindings.project;
            openPanel('配置项目绑定');
            panel.append(element('p', item.name + ' · ' + hosts[selectedHost] + ' · ' + options.projectName));
            var form = element('form', null, 'cap-form');
            var choices = item.versions.slice();
            if (bound && item.pinnedVersion && !versionOf(item, bound)) { choices.unshift(item.pinnedVersion); }
            var version = field(form, '采用版本', select(choices.map(function (entry) {
                return [entry.version, entry.version + (entry.version === bound ? '（当前）' : '')];
            }), bound || item.latest));
            var source = element('p', '', 'cap-detail');
            function updateSource() {
                var entry = choices.find(function (choice) { return choice.version === version.value; });
                source.textContent = entry && entry.source || '';
            }
            version.addEventListener('change', updateSource);
            updateSource();
            form.append(source);
            if (item.pinnedVersion && !versionOf(item, bound)) { form.append(element('p', '当前工作树保留此前固定的版本。', 'cap-detail')); }
            submitForm(form, '预览绑定', function (op) {
                return preview({ operation: 'bind', id: item.id, version: version.value, scope: 'project' }, op);
            });
            if (bound) {
                var remove = button('预览解除绑定', function () {
                    run(remove, function (op) { return preview({ operation: 'unbind', id: item.id, scope: 'project' }, op); });
                });
                form.lastElementChild.append(remove);
            }
            panel.append(form);
        }

        function isReadOnlyFeishu(item) {
            return item.provider === 'feishu' && item.effectiveVersion === '1.0.0';
        }

        function needsFeishuWriteGrant(item, record) {
            return item.provider === 'feishu' && !isReadOnlyFeishu(item) &&
                record.connected && !(record.scopes || []).includes('docx:document');
        }

        function needsFeishuToolGrant(item, record) {
            return item.provider === 'feishu' && item.effectiveVersion === '3.0.0' && record.connected &&
                ['wiki:node:read', 'docs:document.comment:create'].some(function (scope) {
                    return !(record.scopes || []).includes(scope);
                });
        }

        function documentPrompts(item) {
            var details = element('details', null, 'cap-document');
            details.append(element('summary', '在 Agent 中验证'));
            details.append(element('p', selectedHost === 'dsh' ?
                '从当前工作树打开新的 DeepSeek Harness 会话，调用已绑定的原生工具。' :
                '从当前工作树打开新的 ' + hosts[selectedHost] + ' 会话，使用启动时提供的工作台命令调用文档工具。', 'cap-detail'));
            if (item.provider === 'feishu') {
                var current = item.effectiveVersion === '3.0.0';
                details.append(element('p', current ? '将示例链接替换为本人可访问的 docx 或 wiki 文档链接。' :
                    '当前固定版本支持 docx 文档。将示例链接替换为本人可访问的 /docx/ 链接。', 'cap-detail'));
                copyField(details, '读取验证提示词', '用工作台的飞书文档工具读取〈文档链接〉，返回正文开头的一句话。', '复制读取提示词');
                if (current) {
                    copyField(details, '批注验证提示词', '用工作台的飞书文档工具，在〈测试文档链接〉的文末添加一条“测试”批注，返回评论 ID、所在段落链接，以及该段是否列出了这条评论。', '复制批注提示词');
                }
            } else {
                copyField(details, '读取验证提示词', '用工作台的 Google Drive 工具列出最多 3 个可见文件的名称、ID 和类型。', '复制读取提示词');
            }
            return details;
        }

        async function connectionForm(item) {
            var provider = item.provider;
            var id = openPanel(item.name, item);
            if (provider === 'feishu' && item.latest !== item.effectiveVersion) {
                panel.append(element('p', '当前项目固定使用 ' + item.effectiveVersion + '。升级后可授权读取知识库文档及添加批注。', 'cap-detail'));
                var upgrade = button(isReadOnlyFeishu(item) ? '升级为读写版本' : '升级文档工具', function () {
                    run(upgrade, function (op) {
                        return preview({ operation: 'bind', id: item.id, version: item.latest, scope: 'project' }, op);
                    });
                });
                actions(panel).append(upgrade);
            }
            var api = options.bridge.connections;
            var record;
            try { record = await api.status(Object.assign(context(), { provider: provider })); }
            catch (error) { if (valid(id)) { message(problem(error), true); } return; }
            if (!valid(id)) { return; }
            var feishu = provider === 'feishu';
            var oauth = provider !== 'cv-test1';
            var scopeContext = Object.assign(context(), { provider: provider });
            var attempt = 0;
            var state = element('p', '', 'cap-connection-state');
            var verifiedAt = element('p', '', 'cap-detail');
            var grant = element('p', '', 'cap-detail');
            panel.append(state, verifiedAt, grant);
            if (record.serverVersion) { panel.append(element('p', '服务端报告版本 ' + record.serverVersion, 'cap-detail')); }
            if (record.toolNames && record.toolNames.length) { panel.append(element('p', '服务端工具 ' + record.toolNames.join('、'), 'cap-detail')); }
            var form = element('form', null, 'cap-form');
            var fields = {};
            if (provider === 'cv-test1') {
                fields.token = field(form, '访问令牌', input('token', '', 'password'));
                if (selectedHost === 'dsh') {
                    panel.append(element('p', '可在工作台验证当前项目的 CV 连接。要在 DeepSeek Harness 会话中调用服务，请在宿主的 MCP 配置中接入。', 'cap-detail'));
                } else {
                    var instructions = element('details', null, 'cap-document');
                    instructions.append(element('summary', '接入 Claude Code'));
                    instructions.append(element('p', '在目标项目目录打开终端，将占位符替换为个人令牌，然后运行 Claude Code 的接入命令。', 'cap-detail'));
                    var template = 'claude mcp add --transport http cv-test1 https://slots-team-test-server-v0.me2zengame.com/social-server/mcp --header "Authorization: Bearer atk_你的token"';
                    copyField(instructions, 'Claude Code 命令模板', template, '复制命令模板');
                    panel.append(instructions);
                }
            } else {
                fields.clientId = field(form, feishu ? 'App ID' : 'OAuth Client ID', input('clientId'));
                fields.clientSecret = field(form, feishu ? 'App Secret' : 'OAuth Client Secret', input('clientSecret', '', 'password'));
                if (feishu) {
                    fields.documentId = field(form, '验证用飞书文档', input('documentId', item.effectiveVersion === '3.0.0' ?
                        '文档 ID、/docx/ 或 /wiki/ 链接' : '文档 ID 或 /docx/ 链接'));
                    form.append(element('p', '在应用后台登记回调地址 ' + (record.redirectUri || 'http://127.0.0.1:47921/oauth/callback'), 'cap-detail'));
                } else {
                    form.append(element('p', '使用桌面应用类型的 OAuth 客户端，在系统浏览器完成授权。', 'cap-detail'));
                }
            }
            var submit;
            var cancel;
            if (oauth) {
                var bar = actions(form);
                submit = element('button', '在浏览器中授权', 'primary-command');
                submit.type = 'submit';
                cancel = button('取消本次授权', function () { authorize(true); });
                bar.append(submit, cancel);
                form.addEventListener('submit', function (event) {
                    event.preventDefault();
                    authorize(false);
                });
            } else {
                submitForm(form, '保存令牌', async function (op) {
                    var settings = { token: fields.token.value.trim() };
                    fields.token.value = '';
                    var connected = await api.connect(Object.assign({}, scopeContext, { settings: settings }));
                    if (valid(op)) { message(connected.message || connected.label || '连接设置已更新。'); await connectionForm(item); }
                });
            }
            panel.append(form);
            var reuse = button('使用已有个人授权', function () {
                run(reuse, async function (op) {
                    var settings = {};
                    if (provider === 'feishu') {
                        settings.documentId = fields.documentId.value.trim();
                        if (!settings.documentId) { fields.documentId.reportValidity(); return; }
                    }
                    await api.reuse(Object.assign(context(), { provider: provider, settings: settings }));
                    if (valid(op)) { message('已关联个人授权，请验证当前项目的连接。'); await connectionForm(item); }
                });
            });
            actions(panel).append(reuse);
            var verify = button(feishu ? '验证文档访问' : '验证只读访问', function () {
                run(verify, async function (op) {
                    var result = await api.verify(Object.assign(context(), { provider: provider }));
                    if (valid(op)) { message(result.message || result.label || '访问验证已完成。'); await connectionForm(item); }
                });
            });
            var disconnect = button('解除连接', function () {
                openPanel('解除连接');
                panel.append(element('p', '解除当前项目在 ' + hosts[selectedHost] + ' 中的 ' + item.name + ' 连接。'));
                var confirm = button('确认解除', function () {
                    run(confirm, async function (op) {
                        await api.disconnect(Object.assign(context(), { provider: provider }));
                        if (valid(op)) { message('连接已解除。'); await connectionForm(item); }
                    });
                }, true);
                actions(panel).append(button('取消', function () { connectionForm(item); }), confirm);
            });
            var connectionActions = actions(panel);
            connectionActions.append(verify, disconnect);

            function renderStatus(next) {
                record = next;
                var waiting = record.state === 'authorizing';
                statuses.set(provider, record);
                draw();
                state.textContent = waiting ? '等待浏览器授权。可以继续在浏览器操作，也可以直接重新授权。' :
                    record.label || record.message || (record.connected ? '已连接' : '尚未连接');
                verifiedAt.hidden = !record.verifiedAt;
                verifiedAt.textContent = record.verifiedAt ? '上次验证 ' + record.verifiedAt : '';
                grant.hidden = !record.scopes?.length;
                grant.textContent = grant.hidden ? '' : (record.connected ? '已授权范围 ' : '申请范围 ') + record.scopes.join(' · ');
                reuse.parentElement.hidden = waiting || !record.canReuse;
                connectionActions.hidden = waiting || !record.connected;
                if (oauth) {
                    submit.textContent = waiting ? '重新授权' : (needsFeishuWriteGrant(item, record) ? '重新授权以启用读写' :
                        (needsFeishuToolGrant(item, record) ? '补充知识库和评论授权' : '在浏览器中授权'));
                    form.noValidate = waiting;
                    cancel.hidden = !waiting;
                    cancel.disabled = false;
                }
            }

            // 重开面板或刷新窗口后，原提交的 Promise 属于旧页面。只在等待这次回调时读取状态。
            function followPending(version) {
                if (record.state !== 'authorizing') { return; }
                setTimeout(async function () {
                    if (!valid(id) || version !== attempt) { return; }
                    try {
                        var latest = await api.status(scopeContext);
                        if (!valid(id) || version !== attempt) { return; }
                        if (latest.state !== 'authorizing') { renderStatus(latest); return; }
                    } catch (error) { if (valid(id) && version === attempt) { message(problem(error), true); } }
                    if (valid(id) && version === attempt) { followPending(version); }
                }, 1000);
            }

            function connect(resumeSettings) {
                var settings = {};
                if (!resumeSettings) {
                    Object.keys(fields).forEach(function (key) { settings[key] = fields[key].value.trim(); });
                }
                return api.connect(Object.assign({}, scopeContext, { settings: settings }));
            }

            var edits = 0;
            form.addEventListener('input', function () { edits += 1; });
            async function authorize(canceling) {
                var resumeSettings = record.state === 'authorizing' && Object.values(fields).every(function (field) { return !field.value.trim(); });
                if (!canceling && !resumeSettings && !form.reportValidity()) { return; }
                var version = ++attempt;
                var submittedEdits = edits;
                message('');
                if (canceling) { cancel.disabled = true; }
                else { renderStatus(Object.assign({}, record, { state: 'authorizing', message: '请在系统浏览器完成授权。' })); }
                try {
                    var result = await (canceling ? api.cancelAuthorization(scopeContext) : connect(resumeSettings));
                    if (!valid(id) || version !== attempt) { return; }
                    if (!canceling && submittedEdits === edits) { fields.clientSecret.value = ''; }
                    renderStatus(result);
                } catch (error) {
                    if (!valid(id) || version !== attempt) { return; }
                    message(problem(error), true);
                    try {
                        var latest = await api.status(scopeContext);
                        if (valid(id) && version === attempt) { renderStatus(latest); }
                    } catch (_) { if (valid(id) && version === attempt) { cancel.disabled = false; } }
                }
                if (valid(id) && version === attempt) { followPending(version); }
            }

            renderStatus(record);
            if (oauth) { followPending(attempt); }
        }

        async function defectSettings() {
            var id = openPanel('飞书缺陷项目设置');
            if (selectedHost === 'dsh') {
                panel.append(element('p', '使用飞书缺陷脚本时，通过 --binding 指定「配置文件」里的本机配置路径。', 'cap-detail'));
            }
            split.classList.add('cap-wide-inspector');
            var container = element('div', null, 'cap-defect-setup');
            panel.append(container);
            try {
                await window.OpenSpecDefectSetup.show({
                    container: container, bridge: options.bridge, projectId: options.projectId,
                    projectName: options.projectName, host: selectedHost, isCurrent: function () { return valid(id); },
                    notify: function (text, isError) { if (valid(id)) { message(text, isError); } },
                    close: function () { if (valid(id)) { closePanel(true); } }
                });
            } catch (error) { if (valid(id)) { message(problem(error), true); } }
        }

        function versionDetails(item, shown) {
            var details = element('details', null, 'cap-document');
            details.append(element('summary', '版本详情'), element('p', '来源 ' + shown.source, 'cap-detail'));
            if (item.endpoint) { details.append(element('p', '服务地址 ' + item.endpoint, 'cap-detail')); }
            if (item.kind === 'skill' && item.pinnedVersion && item.effectiveVersion !== item.latest) {
                details.append(element('p', '此工作树仍固定使用旧版 Skill。需要新版的项目或宿主功能时，可在项目绑定中预览并切换版本。', 'cap-detail'));
            }
            details.append(element('p', shown.digest ? 'SHA-256 ' + shown.digest : 'SHA-256 在绑定预览中核对。', 'cap-detail'));
            if (item.effectiveVersion && shown.localEntry) { copyField(details, '本机入口路径', shown.localEntry, '复制入口路径'); }
            Object.entries(shown.requirements || {}).forEach(function (requirement) {
                details.append(element('p', requirement[0] + ' = ' + requirement[1], 'cap-detail'));
            });
            if (shown.content) { details.append(element('pre', shown.content)); }
            return details;
        }

        function inspect(item) {
            selectedItem = item.id;
            list.querySelectorAll('[data-capability-id]').forEach(function (row) {
                var selected = row.dataset.capabilityId === item.id;
                row.classList.toggle('is-selected', selected);
                row.querySelector('.cap-item-link').setAttribute('aria-pressed', String(selected));
            });
            openPanel(item.name, item);
            var shown = item.pinnedVersion || versionOf(item, item.latest);
            var identity = element('p', categories[item.kind] + '  /  ' + item.id, 'cap-identity');
            panel.append(identity);
            var legacyDocument = item.provider === 'feishu' && item.effectiveVersion && item.effectiveVersion !== '3.0.0';
            if (item.description) { panel.append(element('p', legacyDocument ? '当前固定版本可通过 Agent 读取飞书 docx 正文。' : item.description)); }
            var commands = actions(panel);
            commands.append(button('项目绑定', function () { showBinding(item); }, true));
            if (item.effectiveVersion) {
                if (providers.includes(item.provider)) { commands.append(button('连接设置', function () { connectionForm(item); })); }
                if (item.id === 'feishu-defect-agent') { commands.append(button('项目设置', defectSettings)); }
                if (item.provider === 'feishu' || item.provider === 'google-drive') { panel.append(documentPrompts(item)); }
            }
            if (item.scopeHint && !legacyDocument) { panel.append(element('p', item.scopeHint, 'cap-detail')); }
            if (item.toolType) {
                panel.append(element('p', '工具来源  ' + (tools[item.toolType] || '应用内置'), 'cap-detail'));
            }
            if (shown) { panel.append(versionDetails(item, shown)); }
        }

        function connectionState(item) {
            var record = statuses.get(item.provider);
            if (!record) { return ''; }
            if (record.state === 'authorizing') { return '授权中'; }
            if (needsFeishuWriteGrant(item, record)) { return '待授权读写'; }
            if (needsFeishuToolGrant(item, record)) { return '待补充授权'; }
            if (record.state === 'verified' || record.verifiedAt) { return '已验证'; }
            if (record.connected) { return '待验证'; }
            if (record.state === 'disconnected' || record.state === 'unconfigured') { return item.provider === 'cv-test1' ? '待连接' : '待授权'; }
            return record.state ? '待连接' : '状态未知';
        }

        function compactSource(entry) {
            var origin = entry && (entry.origin || entry.source) || '—';
            if (origin.startsWith('https://')) { return new URL(origin).hostname; }
            if (origin.startsWith('/')) { return '本机 · ' + origin.split('/').pop(); }
            return origin.split(' · ')[0].split('@')[0];
        }

        function draw() {
            var focused = list.contains(document.activeElement) && document.activeElement.closest('[data-capability-id]');
            var focusedId = focused && focused.dataset.capabilityId;
            list.replaceChildren();
            var visible = items.filter(function (item) {
                if (selectedKind !== 'all' && selectedKind !== item.kind) { return false; }
                if (statusFilter === 'bound' && !item.effectiveVersion || statusFilter === 'unbound' && item.effectiveVersion) { return false; }
                var version = item.pinnedVersion || versionOf(item, item.latest);
                return !searchText || [item.name, item.id, compactSource(version)].join(' ').toLowerCase().includes(searchText);
            });
            var enabled = items.filter(function (item) { return Boolean(item.effectiveVersion); }).length;
            counts.textContent = '共 ' + items.length + ' 项  ·  已绑定 ' + enabled + ' 项';
            var table = element('table', null, 'cap-table');
            table.setAttribute('aria-label', '项目能力清单');
            var header = table.createTHead().insertRow();
            var fields = [['name','名称'], ['kind','类别'], ['version','版本'], ['state','状态'], ['source','来源'], ['options','选项']];
            fields.forEach(function (col) {
                var cell = element('th', col[1], 'cap-col-' + col[0]);
                cell.scope = 'col';
                header.append(cell);
            });
            var rows = table.createTBody();
            visible.forEach(function (item) {
                var row = rows.insertRow();
                var selected = selectedItem === item.id;
                row.dataset.capabilityId = item.id;
                row.classList.toggle('is-selected', selected);
                var name = row.insertCell();
                var kind = element('span', ({ skill:'S', mcp:'M', tool:'T', rule:'R' })[item.kind], 'cap-glyph is-' + item.kind);
                kind.setAttribute('aria-hidden', 'true');
                var link = button(item.name, function () { inspect(item); });
                link.className = 'cap-item-link';
                link.setAttribute('aria-pressed', String(selected));
                name.className = 'cap-col-name';
                name.append(kind, link);
                var shown = item.pinnedVersion || versionOf(item, item.latest);
                var bindingStatus = item.effectiveVersion ? '已绑定' : '未绑定';
                var labels = [categories[item.kind], shown ? shown.version : '—', bindingStatus, compactSource(shown)];
                labels.forEach(function (text, index) {
                    var cell = row.insertCell();
                    cell.className = 'cap-col-' + fields[index + 1][0];
                    if (index === 2) {
                        var badge = element('span', text, 'cap-state');
                        if (text === '已绑定' || text === '已验证') { badge.classList.add('is-enabled'); }
                        if (text.startsWith('待') || text === '状态未知') { badge.classList.add('is-pending'); }
                        cell.append(badge);
                        var account = connectionState(item);
                        if (item.effectiveVersion && account) { cell.append(element('small', account, 'cap-account-state')); }
                    } else {
                        cell.textContent = text;
                        if (index === 3 && shown) { cell.title = shown.origin || shown.source; }
                    }
                });
                var command = button('›', function () { inspect(item); });
                command.setAttribute('aria-label', '管理' + item.name);
                command.title = '管理' + item.name;
                command.className = 'cap-row-action';
                var last = row.insertCell();
                last.className = 'cap-col-options';
                last.append(command);
                row.addEventListener('click', function (event) { if (!event.target.closest('button')) { inspect(item); } });
            });
            list.append(table);
            if (!visible.length) {
                list.append(element('p', items.length ? '没有符合筛选条件的能力。' : '此版本尚未收录能力。', 'cap-empty'));
            }
            if (!enabled) { list.append(element('p', '此项目尚未启用能力。', 'cap-detail')); }
            if (focusedId) {
                var focusRow = list.querySelector('[data-capability-id="' + CSS.escape(focusedId) + '"] .cap-item-link');
                if (focusRow) { focusRow.focus(); }
            }
        }

        list.addEventListener('keydown', function (event) {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { return; }
            var current = event.target.closest('tr[data-capability-id]');
            if (!current) { return; }
            var rows = Array.from(list.querySelectorAll('tr[data-capability-id]'));
            var index = rows.indexOf(current);
            if (event.key === 'Home') { index = 0; }
            if (event.key === 'End') { index = rows.length - 1; }
            if (event.key === 'ArrowDown') { index = Math.min(rows.length - 1, index + 1); }
            if (event.key === 'ArrowUp') { index = Math.max(0, index - 1); }
            event.preventDefault();
            rows[index].querySelector('.cap-item-link').focus();
        });

        async function load(catalogOnly) {
            var current = ++readId;
            try {
                var result = await options.bridge.capabilities.list(context());
                if (!root.isConnected || current !== readId) { return; }
                items = result.items;
                release.textContent = result.appVersion ? '工作台 ' + result.appVersion : '';
                var previous = result.recovery || {};
                recovery.hidden = !previous.globalBindings && !previous.customItems;
                if (!recovery.hidden) {
                    recoveryNote.textContent = '旧版全局绑定 ' + (previous.globalBindings || 0) + ' 项，自定义能力 ' + (previous.customItems || 0) + ' 项。原始记录已备份；请在当前工作树和宿主中手动启用需要的目录能力。';
                    recoveryPath.value = previous.backupPath || '';
                    recoveryPath.parentElement.hidden = !previous.backupPath;
                }
                if (namedPanelItem) {
                    var updated = items.find(function (item) { return item.id === namedPanelItem.id; });
                    if (updated) {
                        namedPanelItem.name = updated.name;
                        panel.querySelector('#cap-panel-heading').textContent = updated.name;
                    }
                }
                draw();
                if (catalogOnly === true) { return items; }
                var connections = items.filter(function (item) { return item.effectiveVersion && providers.includes(item.provider); });
                await Promise.all(connections.map(async function (item) {
                    try {
                        var record = await options.bridge.connections.status(Object.assign(context(), { provider: item.provider }));
                        if (root.isConnected && current === readId && !statuses.has(item.provider)) { statuses.set(item.provider, record); }
                    } catch (_) {
                        if (root.isConnected && current === readId && !statuses.has(item.provider)) { statuses.set(item.provider, { label: '连接状态不可用' }); }
                    }
                }));
                if (root.isConnected && current === readId && panel.hidden) { draw(); }
            } catch (error) {
                if (!root.isConnected || current !== readId) { return; }
                list.replaceChildren(button('重新读取', load));
                message(problem(error), true);
            }
        }

        var header = element('header', null, 'collection-header cap-header');
        var heading = element('div');
        heading.append(element('span', options.projectName, 'project-context'), element('h1', '能力绑定'));
        var headerActions = actions(header);
        var host = field(headerActions, '宿主', select(Object.entries(hosts), selectedHost));
        host.addEventListener('change', function () {
            selectedHost = host.value;
            statuses.clear();
            closePanel(false);
            selectedItem = null;
            list.replaceChildren();
            message('');
            load();
        });
        header.prepend(heading);
        root.append(header);
        var line = element('div', null, 'cap-toolbar');
        categoryBar.setAttribute('role', 'group');
        categoryBar.setAttribute('aria-label', '能力类别');
        var filterLabels = Object.assign({ all: '全部' }, categories);
        Object.keys(filterLabels).forEach(function (kind) {
            var control = button(filterLabels[kind], function () {
                closePanel(false);
                message('');
                selectedItem = null;
                selectedKind = kind;
                Object.keys(categoryButtons).forEach(function (key) { categoryButtons[key].setAttribute('aria-pressed', String(key === kind)); });
                draw();
            });
            control.setAttribute('aria-pressed', String(selectedKind === kind));
            categoryBar.append(control);
            categoryButtons[kind] = control;
        });
        var filterBar = element('div', null, 'cap-filters');
        var search = input('filter', '名称或来源', 'search');
        search.required = false;
        search.setAttribute('aria-label', '筛选能力');
        var stateFilter = select([['all', '所有绑定'], ['bound', '已绑定'], ['unbound', '未绑定']], 'all');
        stateFilter.setAttribute('aria-label', '绑定状态');
        function filter() {
            closePanel(false);
            selectedItem = null;
            searchText = search.value.trim().toLowerCase();
            statusFilter = stateFilter.value;
            draw();
        }
        search.addEventListener('input', filter);
        stateFilter.addEventListener('change', filter);
        filterBar.append(search, stateFilter);
        line.append(categoryBar, filterBar);
        var foot = element('div', null, 'cap-table-foot');
        foot.append(counts);
        var release = element('span');
        foot.append(release);
        var recovery = element('details', null, 'cap-document cap-recovery');
        recovery.hidden = true;
        var recoveryNote = element('p', '', 'cap-detail');
        recovery.append(element('summary', '旧版记录'), recoveryNote);
        var recoveryPath = field(recovery, '原始备份路径', input('recovery-path'));
        recoveryPath.readOnly = true;
        var tableRegion = element('div', null, 'cap-table-region');
        tableRegion.append(list, foot, recovery);
        split.append(tableRegion, panel);
        root.append(line, status, split);
        options.page.replaceChildren(root);
        var unmount = new MutationObserver(function () {
            if (!root.isConnected) { unmount.disconnect(); closePanel(false); }
        });
        unmount.observe(options.page, { childList: true });
        load();
        return { root: root, refresh: function () { statuses.clear(); return load(); } };
    }

    window.OpenSpecCapabilityPage = {
        show: function (options) {
            var key = JSON.stringify([options.view, options.projectId]);
            if (active && active.key === key && active.root.isConnected) { return; }
            active = workspace(options);
            active.key = key;
        },
        refresh: function () {
            if (active && active.root.isConnected) { return active.refresh(); }
        }
    };
}());
