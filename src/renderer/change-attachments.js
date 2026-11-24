(function () {
    'use strict';

    function displaySize(bytes) {
        if (bytes < 1024) { return bytes + ' B'; }
        if (bytes < 1048576) { return (bytes / 1024).toFixed(1) + ' KiB'; }
        return (bytes / 1048576).toFixed(1) + ' MiB';
    }

    /** 为当前提案创建折叠的只读附件区。仅用户展开或翻页时发送读取请求。 */
    function create(attachments, context, isCurrent) {
        var details = document.createElement('details');
        details.className = 'change-attachments';
        details.innerHTML = '<summary>验收记录</summary><div class="attachment-body">' +
            '<p class="attachment-status" role="status"></p><ul class="attachment-files" aria-label="JSON 验收记录"></ul>' +
            '<section class="attachment-reader" aria-label="验收记录内容" hidden><div class="attachment-toolbar">' +
            '<strong class="attachment-title"></strong><button type="button" class="secondary-command attachment-prev">上一段</button>' +
            '<button type="button" class="secondary-command attachment-next">下一段</button></div>' +
            '<pre tabindex="0" aria-label="验收记录原文"></pre></section></div>';
        var status = details.querySelector('[role="status"]');
        var list = details.querySelector('ul');
        var reader = details.querySelector('.attachment-reader');
        var title = reader.querySelector('strong');
        var preview = reader.querySelector('pre');
        var previous = reader.querySelector('.attachment-prev');
        var next = reader.querySelector('.attachment-next');
        var generation = 0;
        var selected = null;
        var offsets = [];
        var segment = null;

        function current(request) {
            return generation === request && details.isConnected && details.open && isCurrent();
        }

        function clear() {
            list.replaceChildren();
            status.textContent = '';
            reader.hidden = true;
            preview.textContent = '';
            selected = null;
            offsets = [];
            segment = null;
        }

        async function readPage(history) {
            var request = ++generation;
            var offset = history[history.length - 1];
            reader.hidden = false;
            title.textContent = selected.path;
            preview.textContent = '';
            previous.disabled = true;
            next.disabled = true;
            status.textContent = '正在读取 ' + selected.path;
            try {
                var part = await attachments.read(Object.assign({}, context, { id: selected.id, offset: offset }));
                if (!current(request)) { return; }
                offsets = history;
                segment = part;
                preview.textContent = part.text;
                preview.scrollTop = 0;
                preview.scrollLeft = 0;
                previous.disabled = history.length === 1;
                next.disabled = part.done;
                status.textContent = part.totalBytes ? '第 ' + history.length + ' 段 · 字节 ' +
                    (offset + 1).toLocaleString() + '–' + part.nextOffset.toLocaleString() +
                    ' / ' + part.totalBytes.toLocaleString() : '空文件';
            } catch (error) {
                if (!current(request)) { return; }
                reader.hidden = true;
                status.textContent = '无法读取验收记录。' + error.message + ' 收起后展开可重新取得清单。';
            }
        }

        function fileRow(file) {
            var row = document.createElement('li');
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'attachment-file';
            button.setAttribute('aria-pressed', 'false');
            var label = document.createElement('span');
            label.textContent = file.path;
            var size = document.createElement('small');
            size.textContent = displaySize(file.size);
            button.append(label, size);
            button.addEventListener('click', function () {
                if (!details.open || !isCurrent()) { return; }
                var last = list.querySelector('[aria-pressed="true"]');
                if (last) { last.setAttribute('aria-pressed', 'false'); }
                button.setAttribute('aria-pressed', 'true');
                selected = file;
                readPage([0]);
            });
            row.append(button);
            return row;
        }

        details.addEventListener('toggle', async function () {
            var request = ++generation;
            clear();
            if (!current(request)) { return; }
            status.textContent = '正在读取验收记录清单…';
            try {
                var result = await attachments.list(context);
                if (!current(request)) { return; }
                var rows = document.createDocumentFragment();
                result.files.forEach(function (file) { rows.append(fileRow(file)); });
                list.append(rows);
                status.textContent = result.files.length ? result.files.length + ' 个 JSON 文件' : '此提案没有 JSON 验收记录。';
            } catch (error) {
                if (current(request)) { status.textContent = '无法读取验收记录清单。' + error.message + ' 收起后展开可重试。'; }
            }
        });

        previous.addEventListener('click', function () { if (offsets.length > 1) { readPage(offsets.slice(0, -1)); } });
        next.addEventListener('click', function () { if (segment && !segment.done) { readPage(offsets.concat(segment.nextOffset)); } });
        return details;
    }

    window.OpenSpecChangeAttachments = { create: create };
}());
