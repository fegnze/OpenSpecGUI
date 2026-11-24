(function () {
    'use strict';

    function node(tag, text, className) {
        const el = document.createElement(tag);
        if (text != null) { el.textContent = text; }
        if (className) { el.className = className; }
        return el;
    }

    function button(text, click, primary) {
        const el = node('button', text, primary ? 'primary-command' : 'secondary-command');
        el.type = 'button';
        el.addEventListener('click', click);
        return el;
    }

    function field(group, title, value, onChange, options = {}) {
        const label = node('label', null, 'df-field');
        label.append(node('span', title));
        const input = node(options.choices ? 'select' : 'input');
        if (options.choices) { for (const [key, name] of options.choices) { input.add(new Option(name, key)); } }
        else { input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = options.hint || ''; }
        input.value = value || '';
        input.required = Boolean(options.required);
        input.addEventListener(options.choices ? 'change' : 'input', () => onChange(input.value));
        label.append(input);
        group.append(label);
        return input;
    }

    function section(parent, title) {
        const block = node('details', null, 'df-section');
        block.append(node('summary', title));
        const grid = node('div', null, 'df-grid');
        block.append(grid);
        parent.append(block);
        return grid;
    }

    function setting(parent, values, key, label, options) {
        return field(parent, label, values[key], v => { values[key] = v; }, options);
    }

    function repeated(parent, records, config) {
        const block = node('div', null, 'df-repeater');
        function draw() {
            block.replaceChildren();
            records.forEach((record, index) => {
                const line = node('div', null, 'df-repeat-row');
                config.draw(line, record, index);
                const remove = button('移除', () => { records.splice(index, 1); draw(); block.lastElementChild.focus(); });
                remove.setAttribute('aria-label', '移除' + config.name + ' ' + (index + 1));
                line.append(remove);
                block.append(line);
            });
            block.append(button('添加' + config.name, () => {
                records.push(config.create());
                draw();
                block.children[records.length - 1].querySelector('input,select').focus();
            }));
        }
        draw();
        parent.append(block);
    }

    function settingsForm(values, save) {
        const form = node('form', null, 'df-form');
        const basics = node('div', null, 'df-grid');
        form.append(basics);
        setting(basics, values, 'projectKey', '飞书项目键', { required: true, hint: 'project_key' });
        setting(basics, values, 'workItemType', '工作项类型键', { required: true });
        setting(basics, values, 'host', '项目服务域名', { required: true });
        setting(basics, values, 'profile', 'Meegle 凭证档案', { hint: '默认档案' });

        form.append(node('h3', '默认缺陷来源'));
        repeated(form, values.sources, { name: '来源', create: () => ({ kind: 'view', id: '' }), draw(line, record) {
            setting(line, record, 'kind', '类型', { choices: [['view','视图'],['issue','缺陷']] });
            setting(line, record, 'id', '来源 ID', { required: true });
        } });

        const mappings = section(form, '字段映射');
        for (const [key, title] of Object.entries({ title:'标题', state:'状态', priority:'优先级', owners:'当前状态负责人', description:'描述', attachments:'附件（可选）' })) {
            setting(mappings, values.fields, key, title + '字段', { required: key !== 'attachments' });
        }
        const owner = node('label', null, 'df-check');
        const checked = node('input'); checked.type = 'checkbox'; checked.checked = values.ownerSemantics === 'current_state_operator';
        checked.addEventListener('change', () => { values.ownerSemantics = checked.checked ? 'current_state_operator' : ''; });
        owner.append(checked, node('span','已核对负责人字段表示当前状态的办理人')); mappings.append(owner);
        setting(mappings, values, 'issueUrlTemplate', '缺陷链接模板', { hint:'https://project.feishu.cn/…/{issue_id}' });

        const delivery = section(form, '关联仓库与交付');
        repeated(delivery, values.repositories, { name: '仓库', create: () => ({ id:'', path:'', remote:'', branch:'' }), draw(line, repo) {
            setting(line, repo, 'id', '仓库标识', { required: true });
            setting(line, repo, 'path', '检出目录', { required: true });
            setting(line, repo, 'remote', 'Git 远端');
            setting(line, repo, 'branch', '候选分支');
        } });
        setting(delivery, values, 'handoffDirectory', '交接文档目录');
        setting(delivery, values, 'releaseProvider', '默认发布平台', { hint:'例如 Jenkins' });

        const messages = section(form, '消息应用与身份映射');
        const providers = [['', '未配置'], ['feishu-app', '飞书消息应用']];
        if (values.notificationProvider && !providers.some(([key]) => key === values.notificationProvider)) {
            providers.push([values.notificationProvider, '已有适配器 · ' + values.notificationProvider]);
        }
        setting(messages, values, 'notificationProvider', '消息提供方', { choices: providers });
        setting(messages, values, 'appId', '消息应用 App ID');
        setting(messages, values, 'appIdEnv', 'App ID 环境变量');
        setting(messages, values, 'appSecretEnv', 'App Secret 环境变量名');
        setting(messages, values, 'identityHost', '身份映射 SSH 主机');
        setting(messages, values, 'identityFile', '远端映射文件路径');

        const submit = node('button', '保存项目配置', 'primary-command'); submit.type = 'submit';
        const foot = node('div', null, 'df-form-foot'); foot.append(submit); form.append(foot);
        form.addEventListener('invalid', e => { const fold = e.target.closest('details'); if (fold) { fold.open = true; } }, true);
        form.addEventListener('submit', async e => {
            e.preventDefault(); if (submit.disabled) { return; }
            submit.disabled = true;
            try { await save(); } finally { submit.disabled = false; }
        });
        return form;
    }

    function showAuth({ body, call, isCurrent, message, saved, settings, bridge }) {
        body.append(node('p', '缺陷访问使用个人 Meegle 账号，飞书消息使用项目配置的应用身份。', 'df-note'));
        if (!saved) { body.append(node('p', '项目配置有未保存的修改，请先保存后再核对账号。', 'df-note')); return; }
        if (!settings.configured) { body.append(node('p', '可先检查本机 CLI；保存项目配置后即可核对个人身份。', 'df-note')); }
        const results = node('div');
        const groups = [['meegle','Meegle 项目账号'],['feishu','飞书个人身份'],['notifications','消息应用'],['identityMapping','收件人映射']];
        const check = button('检查账号与权限', () => run('check-auth'));
        body.append(check, results);
        let active = false;
        async function run(action, provider) {
            if (!isCurrent() || active) { return; }
            active = true; check.disabled = true;
            results.querySelectorAll('button').forEach(b => { b.disabled = true; });
            message(action === 'authorize' ? '正在发起官方授权…' : '正在检查账号和本机设置…');
            try {
                const report = await call(action, provider ? { provider } : {});
                if (!isCurrent()) { return; }
                results.replaceChildren(); message('');
                let pending = false;
                for (const [key, title] of groups) {
                    const part = report[key]; if (!part) { continue; }
                    const row = node('section', null, 'df-auth-row');
                    const status = { missing:'缺少工具', configure:'待配置', login:'待登录', pending:'等待授权', verified:'已核验', unverified:'待核验', error:'检查失败' };
                    row.append(node('strong', title + ' · ' + (status[part.state] || '待检查')), node('p', part.message));
                    if (part.userCode) { row.append(node('code', part.userCode)); }
                    if (part.action === 'authorize' && ['feishu','meegle'].includes(key)) {
                        row.append(button('授权' + title, () => run('authorize', key)));
                    }
                    if (part.command) {
                        row.append(node('pre', part.command, 'df-command'), button('复制命令', async () => {
                            try { await bridge.clipboard.write(part.command); if (isCurrent()) { message('命令已复制'); } }
                            catch { if (isCurrent()) { message('无法写入剪贴板', true); } }
                        }));
                    }
                    if (part.state === 'pending') { pending = true; }
                    results.append(row);
                }
                if (pending) { setTimeout(() => { if (isCurrent()) { run('check-auth'); } }, 4500); }
            } catch (e) {
                if (isCurrent()) {
                    message((e.message || '账号检查失败').replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
                    results.querySelectorAll('button').forEach(b => { b.disabled = false; });
                }
            } finally { active = false; check.disabled = false; }
        }
    }

    async function show(ctx) {
        const { container, projectId, isCurrent, bridge } = ctx;
        const api = bridge.capabilities;
        const call = (action, extra) => api.defectConfig({ projectId, host: ctx.host, action, ...extra });
        const label = node('p', '正在读取项目配置…', 'df-feedback');
        label.setAttribute('role', 'status');
        const nav = node('div', null, 'df-tabs');
        nav.setAttribute('role','group'); nav.setAttribute('aria-label','飞书缺陷设置');
        const body = node('div', null, 'df-body');
        container.classList.add('df-setup');
        container.replaceChildren(nav, label, body);
        let selected = '', settings, values, form, sequence = 0, dirty = false;
        const tabs = new Map();
        const err = e => (e.message || '操作失败').replace(/^Error invoking remote method '[^']+': Error: /, '');
        function message(text, error = false) {
            if (!isCurrent()) { return; }
            label.textContent = text || ''; label.classList.toggle('is-error', error);
        }
        function setSettings(result) {
            settings = result; values = structuredClone(result.values); dirty = false;
            form = settingsForm(values, async () => {
                try {
                    const result = await call('save-settings', { revision: settings.revision, values });
                    if (!isCurrent()) { return; }
                    setSettings(result); select('项目配置');
                    message('项目配置已保存到本机');
                } catch (e) { message(err(e), true); }
            });
            form.addEventListener('input', () => { dirty = true; });
            form.addEventListener('change', () => { dirty = true; });
            form.addEventListener('click', e => { if (e.target.closest('.df-repeater button')) { dirty = true; } });
        }
        async function fileAction(action) {
            if (action !== 'reveal' && dirty && !window.confirm('切换配置文件会放弃当前表单中未保存的修改。继续？')) { return; }
            try {
                const result = await call(action);
                if (!isCurrent() || result.canceled || action === 'reveal') { return; }
                const next = await call('read-settings');
                if (!isCurrent()) { return; }
                setSettings(next); select('配置文件'); message(result.message);
            } catch (e) { message(err(e), true); }
        }
        function files() {
            const desc = node('p', '可关联已有的单项目 JSON，或生成本机示例。表单保存的设置可通过同一文件传给 Skill。', 'df-note');
            body.append(desc);
            if (settings.path) {
                const pathInput = field(body, '本机配置路径', settings.path, () => {}); pathInput.readOnly = true;
                body.append(button('在 Finder 中显示', () => fileAction('reveal')));
            }
            const actions = node('div', null, 'df-actions');
            actions.append(button('关联已有 JSON', () => fileAction('link')),button('生成示例配置', () => fileAction('template')));
            body.append(actions);
        }
        function select(name) {
            selected = name; sequence++;
            for (const [key, tab] of tabs) { tab.setAttribute('aria-pressed', String(key === name)); }
            body.replaceChildren(); message('');
            if (name === '项目配置') { body.append(form); }
            else if (name === '配置文件') { files(); }
            else { const id = sequence; showAuth({ body, call, isCurrent: () => isCurrent() && sequence === id, message, saved: !dirty, settings, bridge }); }
        }
        for (const title of ['项目配置','账号与授权','配置文件']) {
            const tab = button(title, () => select(title)); tab.disabled = true; nav.append(tab); tabs.set(title, tab);
        }
        const result = await call('read-settings');
        if (!isCurrent()) { return; }
        setSettings(result);
        for (const tab of tabs.values()) { tab.disabled = false; }
        select('项目配置');
    }

    window.OpenSpecDefectSetup = { show };
}());
