(function () {
    'use strict';

    var active;
    var hosts = { all: '全部宿主', codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness' };
    var outcomes = { context: '已提供上下文', pass: '已放行', deny: '已拒绝', skipped: '已跳过', timeout: '检查超时', error: '执行出错' };
    var localTime = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    function element(tag, text, className) {
        var node = document.createElement(tag);
        if (text) { node.textContent = text; }
        if (className) { node.className = className; }
        return node;
    }

    function button(label, className) {
        var node = element('button', label, className || 'secondary-command');
        node.type = 'button';
        return node;
    }

    function recordRow(record) {
        var row = element('tr');
        var time = element('time', localTime.format(new Date(record.timestamp)));
        time.dateTime = record.timestamp;
        var when = element('td', null, 'hook-record-time');
        when.append(time);
        var event = element('td');
        var toggle = button(record.event, 'hook-record-toggle');
        toggle.setAttribute('aria-expanded', 'false');
        event.append(toggle);
        var decision = element('td');
        var badge = element('span', outcomes[record.decision], 'hook-record-outcome');
        badge.dataset.decision = record.decision;
        decision.append(badge);
        row.append(when, element('td', hosts[record.host]), event, decision, element('td', record.reason));
        toggle.addEventListener('click', function () {
            if (toggle.getAttribute('aria-expanded') === 'true') {
                row.nextElementSibling.remove();
                toggle.setAttribute('aria-expanded', 'false');
                return;
            }
            var detail = element('tr', null, 'hook-record-detail');
            var cell = element('td');
            cell.colSpan = 5;
            var fields = element('dl');
            var bindings = record.bindings.map(function (entry) { return entry.id + '@' + entry.version; });
            fields.append(element('dt', '检查版本'), element('dd', record.checkVersion),
                element('dt', '当次绑定'), element('dd', bindings.length ? bindings.join('、') : '无'));
            cell.append(fields);
            detail.append(cell);
            row.after(detail);
            toggle.setAttribute('aria-expanded', 'true');
        });
        return row;
    }

    function show(page, bridge, project) {
        if (active && active.root.isConnected && active.projectId === project.id) { return; }
        var root = element('section', null, 'hook-records-page');
        var head = element('header', null, 'collection-header');
        var title = element('div');
        title.append(element('span', project.name, 'project-context'), element('h1', '钩子记录'));
        var refresh = button('刷新记录');
        head.append(title, refresh);
        var toolbar = element('div', null, 'hook-record-toolbar');
        var filter = element('label', '宿主');
        var host = element('select');
        host.setAttribute('aria-label', '宿主');
        Object.keys(hosts).forEach(function (id) { host.add(new Option(hosts[id], id)); });
        filter.append(host);
        toolbar.append(filter);
        var notice = element('p', null, 'hook-record-notice');
        notice.setAttribute('role', 'status');
        var table = element('table', null, 'hook-record-table');
        table.setAttribute('aria-label', '项目钩子记录');
        var labels = table.createTHead().insertRow();
        ['时间', '宿主', '事件', '结果', '原因'].forEach(function (label) {
            var cell = element('th', label);
            cell.scope = 'col';
            labels.append(cell);
        });
        var body = table.createTBody();
        var empty = element('div', null, 'hook-record-empty');
        var emptyText = element('p');
        var setup = button('查看宿主接入');
        setup.dataset.route = 'host-setup';
        empty.append(emptyText, element('p', '如果宿主提前终止检查，可能来不及写入回执。'), setup);
        var foot = element('div', null, 'hook-record-foot');
        var count = element('span');
        var more = button('查看更多');
        foot.append(count, more);
        root.append(head, toolbar, notice, table, empty, foot);
        page.replaceChildren(root);

        var generation = 0;
        var ids = new Set();
        var unavailable = new Set();
        var cursor = null;
        function updateControls() {
            table.hidden = foot.hidden = ids.size === 0;
            more.hidden = !cursor;
            count.textContent = '已显示 ' + ids.size + ' 条记录';
        }
        async function load(append) {
            var request = ++generation;
            var payload = { projectId: project.id, host: host.value };
            if (append) { payload.cursor = cursor; }
            refresh.disabled = more.disabled = true;
            empty.hidden = true;
            notice.textContent = '正在读取钩子记录…';
            notice.classList.remove('is-error');
            updateControls();
            try {
                var result = await bridge.hosts.records(payload);
                if (!root.isConnected || request !== generation) { return; }
                if (result.projectId !== project.id) { throw new Error(); }
                if (!append) { ids.clear(); unavailable.clear(); body.replaceChildren(); }
                result.rows.forEach(function (record) {
                    var key = record.host + '/' + record.id;
                    if (!ids.has(key)) { body.append(recordRow(record)); ids.add(key); }
                });
                result.unavailableHosts.forEach(function (id) { unavailable.add(hosts[id]); });
                cursor = result.nextCursor;
                notice.classList.toggle('is-error', unavailable.size > 0);
                notice.textContent = unavailable.size ? Array.from(unavailable).join('、') + ' 的回执读取失败，可刷新记录重试。' : '';
                if (!ids.size && !unavailable.size) {
                    emptyText.textContent = host.value === 'all' ? '此项目暂无钩子回执。' : '此项目暂无 ' + hosts[host.value] + ' 的钩子回执。';
                    empty.hidden = false;
                }
            } catch {
                if (!root.isConnected || request !== generation) { return; }
                notice.classList.add('is-error');
                notice.textContent = append ? '更多回执读取失败，可点击查看更多重试。' : '钩子记录读取失败，可刷新记录重试。';
            } finally {
                if (root.isConnected && request === generation) {
                    refresh.disabled = more.disabled = false;
                    updateControls();
                }
            }
        }
        function reload() { return load(false); }
        refresh.addEventListener('click', reload);
        more.addEventListener('click', function () { if (cursor) { load(true); } });
        host.addEventListener('change', function () {
            body.replaceChildren();
            ids.clear();
            unavailable.clear();
            cursor = null;
            reload();
        });
        active = { root: root, projectId: project.id, refresh: reload };
        reload();
    }

    window.OpenSpecHookRecords = {
        show: show,
        refresh: function () { if (active && active.root.isConnected) { return active.refresh(); } }
    };
}());
