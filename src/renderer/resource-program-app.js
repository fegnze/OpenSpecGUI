(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.OpenSpecResourceProgramApp = api.app;
        root.OpenSpecResourceProgramAppInternals = api;
    }
}(typeof window === 'undefined' ? null : window, function (runtime) {
    'use strict';

    var APP_ID = 'resource-program-v1';
    var LENSES = ['conclusions', 'design', 'evidence', 'all'];
    var NAV_ITEMS = ['overview', 'workstreams', 'changes', 'governance', 'artifacts'];
    var ALLOWED_MARKDOWN_TAGS = [
        'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'HR', 'IMG', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'TABLE', 'TBODY',
        'TD', 'TH', 'THEAD', 'TR', 'UL'
    ];
    var diagramSequence = 0;

    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function safeId(value) {
        var text = String(value || '');
        return /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(text) ? text : '';
    }

    function sameId(left, right) {
        return String(left || '').toLowerCase() === String(right || '').toLowerCase();
    }

    function normaliseLens(value) {
        return LENSES.indexOf(value) === -1 ? 'conclusions' : value;
    }

    function parseRoute(value) {
        var parts = String(value || 'overview').split('/').filter(Boolean).slice(0, 8);
        var first = parts[0] || 'overview';
        var knownRoute = NAV_ITEMS.indexOf(first) !== -1 || first === 'change' || first === 'tasks' || first === 'artifact';
        var route = {
            view: knownRoute ? first : 'not-found',
            changeId: '',
            taskFilter: 'open',
            lens: 'conclusions',
            artifactId: '',
            sectionId: '',
            diagramId: ''
        };
        if (first === 'change' || first === 'tasks') {
            route.view = 'change';
            route.changeId = safeId(parts[1]);
            route.taskFilter = first === 'tasks' && parts[2] === 'all' ? 'all' : 'open';
        } else if (first === 'artifacts') {
            route.view = 'artifacts';
            route.lens = normaliseLens(parts[1]);
        } else if (first === 'artifact') {
            route.view = 'artifact';
            route.lens = normaliseLens(parts[1]);
            route.artifactId = safeId(parts[2]);
            if (parts[3] === 'section') { route.sectionId = safeId(parts[4]); }
            if (parts[5] === 'diagram') { route.diagramId = safeId(parts[6]); }
            if (parts[3] === 'diagram') { route.diagramId = safeId(parts[4]); }
        }
        return route;
    }

    function buildRoute(route) {
        var view = route && route.view ? route.view : 'overview';
        if (view === 'change') {
            return 'change/' + safeId(route.changeId);
        }
        if (view === 'tasks') {
            return 'tasks/' + safeId(route.changeId) + '/' + (route.taskFilter === 'all' ? 'all' : 'open');
        }
        if (view === 'artifacts') {
            return 'artifacts/' + normaliseLens(route.lens);
        }
        if (view === 'artifact') {
            var value = 'artifact/' + normaliseLens(route.lens) + '/' + safeId(route.artifactId);
            if (route.sectionId) { value += '/section/' + safeId(route.sectionId); }
            if (route.diagramId) { value += (route.sectionId ? '/diagram/' : '/diagram/') + safeId(route.diagramId).toLowerCase(); }
            return value;
        }
        return NAV_ITEMS.indexOf(view) === -1 ? 'overview' : view;
    }

    function taskCounts(value) {
        var counts = value && typeof value === 'object' ? value : {};
        var total = Number.isInteger(counts.total) && counts.total >= 0 ? counts.total : 0;
        var completed = Number.isInteger(counts.completed) && counts.completed >= 0 ? Math.min(counts.completed, total) : 0;
        return { completed: completed, total: total, open: total - completed };
    }

    function parseTasksMarkdown(markdown) {
        var group = '任务';
        var groups = [];
        var byTitle = Object.create(null);
        String(markdown || '').split(/\r?\n/).forEach(function (line) {
            var heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
            var task = /^\s*[-*]\s+\[([ xX])\]\s+([0-9]+\.[0-9]+)\s+(.+?)\s*$/.exec(line);
            if (heading) {
                group = heading[1];
            } else if (task) {
                if (!byTitle[group]) {
                    byTitle[group] = { title: group, items: [] };
                    groups.push(byTitle[group]);
                }
                byTitle[group].items.push({ id: task[2], title: task[3], completed: task[1].toLowerCase() === 'x' });
            }
        });
        return groups;
    }

    function flattenTasks(groups) {
        return asArray(groups).reduce(function (items, group) { return items.concat(asArray(group.items)); }, []);
    }

    function artifactForTasks(index, changeId) {
        return asArray(index && index.artifacts).find(function (artifact) {
            var belongs = asArray(artifact.changeIds).some(function (id) { return sameId(id, changeId); });
            return belongs && (artifact.kind === 'change-tasks' || /(^|\/)tasks\.md$/i.test(artifact.path || ''));
        }) || null;
    }

    function lensMatches(item, lens) {
        if (lens === 'all') { return item.entryType === 'artifact'; }
        if (item.entryType !== 'section') { return false; }
        if (lens === 'conclusions') { return item.role === 'conclusion'; }
        if (lens === 'design') { return item.role === 'design' || item.lifecycle === 'design'; }
        return item.role === 'evidence' || item.lifecycle === 'verification' || item.authority === 'implementation-evidence' || item.authority === 'verification-evidence';
    }

    function searchableText(item) {
        return [item.title, item.artifactTitle, item.heading, item.summary, item.path, item.kind, item.lifecycle]
            .concat(asArray(item.topics), asArray(item.evidenceTypes), asArray(item.changeIds), asArray(item.workstreamIds))
            .join(' ').toLowerCase();
    }

    function selectArtifactEntries(index, lens, query, topic) {
        var artifacts = asArray(index && index.artifacts).map(function (item) {
            var copy = Object.assign({}, item);
            copy.entryType = 'artifact';
            return copy;
        });
        var sections = asArray(index && index.readingSections).map(function (item) {
            var copy = Object.assign({}, item);
            copy.entryType = 'section';
            return copy;
        });
        var term = String(query || '').trim().toLowerCase();
        var topicId = String(topic || 'all');
        return artifacts.concat(sections).filter(function (item) {
            return lensMatches(item, normaliseLens(lens)) &&
                (!term || searchableText(item).indexOf(term) !== -1) &&
                (topicId === 'all' || asArray(item.topics).indexOf(topicId) !== -1);
        });
    }

    function safeMarkdownUrl(value, allowImage) {
        var url = String(value || '').trim();
        if (/^#[A-Za-z0-9_-]+$/.test(url) || /^https:\/\//i.test(url) || /^mailto:/i.test(url)) { return url; }
        if (allowImage && /^data:image\/(png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(url)) { return url; }
        return '';
    }

    function sanitizeMarkdown(markdown, document) {
        var fragment = document.createDocumentFragment();
        if (!runtime || !runtime.marked || typeof runtime.marked.parse !== 'function') {
            var fallback = document.createElement('pre');
            fallback.className = 'rp-raw-source';
            fallback.textContent = String(markdown || '');
            fragment.appendChild(fallback);
            return fragment;
        }
        var template = document.createElement('template');
        template.innerHTML = runtime.marked.parse(String(markdown || ''), { gfm: true, breaks: false });
        Array.from(template.content.querySelectorAll('*')).forEach(function (element) {
            if (ALLOWED_MARKDOWN_TAGS.indexOf(element.tagName) === -1) {
                element.replaceWith(document.createTextNode(element.textContent || ''));
                return;
            }
            Array.from(element.attributes).forEach(function (attribute) {
                var name = attribute.name.toLowerCase();
                var keep = (element.tagName === 'A' && (name === 'href' || name === 'title')) ||
                    (element.tagName === 'IMG' && (name === 'src' || name === 'alt' || name === 'title')) ||
                    (element.tagName === 'INPUT' && (name === 'type' || name === 'checked' || name === 'disabled')) ||
                    (element.tagName === 'CODE' && name === 'class' && /^language-mermaid$/i.test(attribute.value));
                if (!keep) { element.removeAttribute(attribute.name); }
            });
            if (element.tagName === 'A') {
                var href = safeMarkdownUrl(element.getAttribute('href'), false);
                if (!href) { element.removeAttribute('href'); }
                else if (/^https:/i.test(href)) { element.setAttribute('href', href); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); }
            }
            if (element.tagName === 'IMG') {
                var src = safeMarkdownUrl(element.getAttribute('src'), true);
                if (src) { element.setAttribute('src', src); } else { element.removeAttribute('src'); }
                if (!element.hasAttribute('alt')) { element.setAttribute('alt', ''); }
            }
            if (element.tagName === 'INPUT') {
                if ((element.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
                    element.replaceWith(document.createTextNode(element.textContent || ''));
                } else {
                    element.disabled = true;
                }
            }
        });
        fragment.appendChild(template.content);
        return fragment;
    }

    function validateMermaidSvg(svg, document) {
        var template = document.createElement('template');
        template.innerHTML = String(svg || '').trim();
        var rootSvg = template.content.firstElementChild;
        if (!rootSvg || rootSvg.tagName.toLowerCase() !== 'svg' || template.content.querySelector('script,foreignObject,iframe,object,embed,audio,video')) {
            throw new Error('图形输出未通过安全校验');
        }
        Array.from(template.content.querySelectorAll('style')).forEach(function (style) {
            if (/@import|url\s*\(\s*(?!#[A-Za-z0-9_-]+\s*\))/i.test(style.textContent || '')) {
                throw new Error('图形样式包含外部资源');
            }
        });
        Array.from(template.content.querySelectorAll('*')).forEach(function (element) {
            Array.from(element.attributes).forEach(function (attribute) {
                var name = attribute.name.toLowerCase();
                var value = attribute.value || '';
                if (name.indexOf('on') === 0 || name === 'srcdoc' || (/href$/.test(name) && value && value.charAt(0) !== '#') || (/url\s*\(/i.test(value) && !/url\s*\(\s*#[A-Za-z0-9_-]+\s*\)/i.test(value))) {
                    throw new Error('图形输出包含不允许的属性');
                }
            });
        });
        Array.from(rootSvg.querySelectorAll('style')).forEach(function (style) { style.remove(); });
        return rootSvg;
    }

    function statusLabel(value) {
        var labels = {
            active: '进行中', accepted: '已验收', archived: '已归档', blocked: '受阻', failed: '失败',
            healthy: '健康', 'in-progress': '推进中', passed: '已通过', pending: '待处理', planned: '已规划',
            ready: '就绪', rework: '返工', reviewing: '评审中', verification: '复验中'
        };
        return labels[value] || value || '未知';
    }

    function statusTone(value) {
        if (value === 'passed' || value === 'accepted' || value === 'archived' || value === 'healthy') { return 'positive'; }
        if (value === 'failed' || value === 'blocked' || value === 'rework') { return 'negative'; }
        return 'attention';
    }

    function badge(value) {
        return '<span class="rp-badge is-' + statusTone(value) + '">' + escapeHtml(statusLabel(value)) + '</span>';
    }

    function listEmpty(title, detail) {
        return '<div class="rp-empty"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(detail) + '</span></div>';
    }

    function createAppInstance(options) {
        var rootElement = options.root;
        var document = rootElement.ownerDocument;
        var view = document.defaultView || runtime;
        var hostApi = options.api;
        var context = options.context;
        var data = null;
        var route = parseRoute(context.route);
        var mounted = false;
        var disposed = false;
        var loadGeneration = 0;
        var readGeneration = 0;
        var taskGeneration = 0;
        var observer = null;
        var artifactQuery = '';
        var artifactTopic = 'all';

        function requestRoute(nextRoute) {
            return hostApi.setRoute(buildRoute(nextRoute));
        }

        function resetObserver() {
            if (observer) { observer.disconnect(); }
            observer = null;
        }

        function renderShell(body) {
            var overview = data.overview;
            var summary = overview.summaryStatus || {};
            var navView = route.view === 'artifact' ? 'artifacts' : (route.view === 'change' ? 'changes' : route.view);
            rootElement.innerHTML = '<div class="resource-program-app">' +
                '<header class="rp-header"><div><span class="rp-kicker">RESOURCE PROGRAM · ' + escapeHtml(overview.initiativeId) + '</span><h1>' + escapeHtml(overview.program.title) + '</h1><p>' + escapeHtml(context.descriptor.summary || '以受治理的 Workstream、Change、门禁与成果推进复杂专项。') + '</p></div><div class="rp-authority"><span>摘要状态</span><strong>' + escapeHtml(statusLabel(summary.value)) + '</strong><small>' + escapeHtml(summary.authority || 'derived') + ' · ' + escapeHtml(data.sourceHash.slice(0, 10)) + '</small></div></header>' +
                '<nav class="rp-nav" aria-label="Resource Program 视图">' + [
                    ['overview', '总览'], ['workstreams', 'Workstreams'], ['changes', 'Changes'], ['governance', '治理'], ['artifacts', '成果阅读']
                ].map(function (item) {
                    return '<button type="button" data-rp-route="' + item[0] + '"' + (navView === item[0] ? ' aria-current="page"' : '') + '>' + item[1] + '</button>';
                }).join('') + '</nav><main class="rp-workspace">' + body + '</main></div>';
        }

        function renderLoading() {
            rootElement.innerHTML = '<div class="resource-program-app"><div class="rp-loading" role="status"><span></span><strong>正在读取 Program 权威快照</strong><small>仅加载当前 Initiative 的受控数据</small></div></div>';
        }

        function renderFailure(error) {
            rootElement.innerHTML = '<div class="resource-program-app"><section class="rp-failure" role="alert"><span>RESOURCE PROGRAM</span><h2>专项数据无法读取</h2><p>' + escapeHtml(error && error.message ? error.message : 'Provider 返回了无效快照。') + '</p><button type="button" data-rp-action="retry">重试</button></section></div>';
        }

        function metric(label, value, detail) {
            return '<div class="rp-metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(detail || '') + '</small></div>';
        }

        function renderOverview() {
            var overview = data.overview;
            var changes = asArray(overview.changes);
            var completeTasks = changes.reduce(function (sum, change) { return sum + taskCounts(change.tasks).completed; }, 0);
            var allTasks = changes.reduce(function (sum, change) { return sum + taskCounts(change.tasks).total; }, 0);
            var pendingGates = asArray(overview.gates).filter(function (gate) { return gate.status !== 'passed'; });
            var workstreams = asArray(overview.workstreams);
            var body = '<section class="rp-metrics" aria-label="Program 指标">' +
                metric('Workstreams', workstreams.length, '交付边界') +
                metric('Changes', changes.length, changes.filter(function (item) { return item.archived; }).length + ' 已归档') +
                metric('Tasks', completeTasks + ' / ' + allTasks, allTasks ? Math.round(completeTasks / allTasks * 100) + '%' : '无任务') +
                metric('Gates', asArray(overview.gates).filter(function (item) { return item.status === 'passed'; }).length + ' / ' + asArray(overview.gates).length, pendingGates.length + ' 待关闭') + '</section>' +
                '<div class="rp-overview-grid"><section class="rp-section"><header><div><span>交付地图</span><h2>Workstreams</h2></div><button type="button" data-rp-route="workstreams">查看全部</button></header><div class="rp-workstream-list">' +
                (workstreams.length ? workstreams.slice(0, 9).map(function (stream) {
                    var count = changes.filter(function (change) { return sameId(change.workstreamId, stream.workstreamId); }).length;
                    return '<div class="rp-workstream-row"><span>' + escapeHtml(stream.workstreamId) + '</span><strong>' + escapeHtml(stream.name) + '</strong><p>' + escapeHtml(stream.objective) + '</p><small>' + count + ' Changes</small></div>';
                }).join('') : listEmpty('尚无 Workstream', 'Provider 未返回交付边界。')) + '</div></section>' +
                '<aside class="rp-attention"><section><header><span>门禁状态</span><strong>' + pendingGates.length + '</strong></header>' + (pendingGates.length ? pendingGates.slice(0, 6).map(function (gate) { return '<div class="rp-attention-row"><span>' + escapeHtml(gate.title) + '</span>' + badge(gate.status) + '</div>'; }).join('') : listEmpty('门禁全部通过', '当前没有未关闭门禁。')) + '</section><section><header><span>阻塞项</span><strong>' + asArray(overview.blockers).length + '</strong></header>' + (asArray(overview.blockers).length ? asArray(overview.blockers).slice(0, 6).map(function (blocker) { return '<div class="rp-attention-row"><span>' + escapeHtml(blocker.title || blocker.blockerId) + '</span>' + badge(blocker.status) + '</div>'; }).join('') : listEmpty('没有阻塞项', 'Program 当前未登记 blocker。')) + '</section></aside></div>';
            renderShell(body);
        }

        function renderWorkstreams() {
            var overview = data.overview;
            var changes = asArray(overview.changes);
            var streams = asArray(overview.workstreams);
            renderShell('<section class="rp-section rp-wide-section"><header><div><span>交付边界</span><h2>Workstreams</h2></div><strong>' + streams.length + '</strong></header><div class="rp-stream-groups">' + (streams.length ? streams.map(function (stream) {
                var streamChanges = changes.filter(function (change) { return sameId(change.workstreamId, stream.workstreamId); });
                return '<section class="rp-stream-group"><div class="rp-stream-identity"><span>' + escapeHtml(stream.workstreamId) + '</span><h3>' + escapeHtml(stream.name) + '</h3><p>' + escapeHtml(stream.objective) + '</p><small>' + streamChanges.length + ' Changes</small></div><div class="rp-stream-changes">' + (streamChanges.length ? streamChanges.map(changeButton).join('') : listEmpty('尚未登记 Change', '该 Workstream 目前只有边界定义。')) + '</div></section>';
            }).join('') : listEmpty('尚无 Workstream', '当前 Program 没有可展示的 Workstream。')) + '</div></section>');
        }

        function changeButton(change) {
            var counts = taskCounts(change.tasks);
            return '<button class="rp-change-row" type="button" data-rp-change="' + escapeHtml(change.changeId) + '"><span><small>' + escapeHtml(change.workstreamId || '未分组') + '</small><strong>' + escapeHtml(change.title) + '</strong><em>' + escapeHtml(change.changeId) + '</em></span>' + badge(change.status) + '<span class="rp-progress"><i style="width:' + (counts.total ? Math.round(counts.completed / counts.total * 100) : 0) + '%"></i></span><small>' + counts.completed + ' / ' + counts.total + '</small></button>';
        }

        function renderChanges() {
            var changes = asArray(data.overview.changes);
            renderShell('<section class="rp-section rp-wide-section"><header><div><span>OpenSpec 生命周期</span><h2>Changes</h2></div><strong>' + changes.length + '</strong></header><div class="rp-change-list">' + (changes.length ? changes.map(changeButton).join('') : listEmpty('尚无 Change', 'Program 未引用任何 OpenSpec Change。')) + '</div></section>');
        }

        function governanceRows(items, idKey, titleKey) {
            return items.length ? items.map(function (item) {
                var identity = item[idKey] || item.lockId || item.assignmentId || item.blockerId || item.gateId || item.milestoneId || item.changeId || item.consumerChangeId || item.producerChangeId || 'registered-item';
                var title = item[titleKey] || item.title || item.objective || item.lockId || item.contractId || item.consumerChangeId || item.producerChangeId || identity;
                var state = item.status || item.verdict || (Number.isInteger(item.revision) ? 'revision ' + item.revision : 'pending');
                return '<div class="rp-governance-row"><span><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(identity) + '</small></span>' + badge(state) + '</div>';
            }).join('') : listEmpty('没有登记项', '当前分类为空。');
        }

        function renderGovernance() {
            var overview = data.overview;
            var contracts = overview.contracts || {};
            var groups = [
                ['Gates', asArray(overview.gates), 'gateId', 'title'],
                ['Milestones', asArray(overview.milestones), 'milestoneId', 'title'],
                ['Contract locks', asArray(contracts.locks), 'contractId', 'title'],
                ['Blockers', asArray(overview.blockers), 'blockerId', 'title'],
                ['Assignments', asArray(overview.assignments), 'assignmentId', 'objective']
            ];
            renderShell('<div class="rp-governance-grid">' + groups.map(function (group) {
                return '<section class="rp-section rp-governance-group"><header><div><span>治理对象</span><h2>' + group[0] + '</h2></div><strong>' + group[1].length + '</strong></header>' + governanceRows(group[1], group[2], group[3]) + '</section>';
            }).join('') + '<section class="rp-section rp-governance-group"><header><div><span>契约消费</span><h2>Consumptions / reviews</h2></div><strong>' + (asArray(contracts.consumptions).length + asArray(contracts.impactReviews).length) + '</strong></header>' + governanceRows(asArray(contracts.consumptions).concat(asArray(contracts.impactReviews)), 'contractId', 'consumerId') + '</section></div>');
        }

        function renderChange() {
            var change = asArray(data.overview.changes).find(function (item) { return sameId(item.changeId, route.changeId); });
            if (!change) {
                renderShell('<section class="rp-failure"><span>CHANGE</span><h2>Change 不存在</h2><p>深链接中的 Change 已移除或不属于当前 Program。</p><button type="button" data-rp-route="changes">返回 Changes</button></section>');
                return;
            }
            var counts = taskCounts(change.tasks);
            var assignments = asArray(data.overview.assignments).filter(function (item) { return sameId(item.changeId, change.changeId); });
            renderShell('<button class="rp-back" type="button" data-rp-route="changes">返回 Changes</button><header class="rp-change-header"><div><span>' + escapeHtml(change.workstreamId) + ' · ' + escapeHtml(change.changeId) + '</span><h2>' + escapeHtml(change.title) + '</h2><p>' + escapeHtml(change.kind) + ' · risk ' + escapeHtml(change.risk) + ' · resource ' + escapeHtml(change.resourceSourceAccess) + '</p></div><div>' + badge(change.status) + '<strong>' + counts.completed + ' / ' + counts.total + '</strong><small>官方 tasks</small></div></header><div class="rp-change-grid"><section class="rp-section"><header><div><span>任务回顾</span><h2>执行清单</h2></div><div class="rp-segments"><button type="button" data-rp-tasks="open" aria-pressed="' + (route.taskFilter === 'open') + '">未完成 ' + counts.open + '</button><button type="button" data-rp-tasks="all" aria-pressed="' + (route.taskFilter === 'all') + '">全部 ' + counts.total + '</button></div></header><div data-rp-task-results><div class="rp-inline-loading">正在读取官方 tasks.md…</div></div></section><aside class="rp-change-context"><section><span>启动依赖</span>' + (asArray(change.startRequires).length ? asArray(change.startRequires).map(function (id) { return '<code>' + escapeHtml(id) + '</code>'; }).join('') : '<small>无</small>') + '</section><section><span>验收依赖</span>' + (asArray(change.acceptRequires).length ? asArray(change.acceptRequires).map(function (id) { return '<code>' + escapeHtml(id) + '</code>'; }).join('') : '<small>无</small>') + '</section><section><span>Assignments</span>' + (assignments.length ? assignments.map(function (item) { return '<div><strong>' + escapeHtml(item.objective) + '</strong><small>' + escapeHtml(item.assignmentId) + '</small>' + badge(item.status) + '</div>'; }).join('') : '<small>无</small>') + '</section></aside></div>');
            loadTasks(change);
        }

        function renderTaskResults(change, groups) {
            var container = rootElement.querySelector('[data-rp-task-results]');
            if (!container) { return; }
            var all = flattenTasks(groups);
            var shown = route.taskFilter === 'all' ? all : all.filter(function (item) { return !item.completed; });
            var official = taskCounts(change.tasks);
            var mismatch = all.length !== official.total || all.filter(function (item) { return item.completed; }).length !== official.completed;
            container.innerHTML = (mismatch ? '<div class="rp-warning">成果解析计数 ' + all.filter(function (item) { return item.completed; }).length + ' / ' + all.length + '，与官方摘要 ' + official.completed + ' / ' + official.total + ' 不一致。</div>' : '') + (shown.length ? groups.map(function (group) {
                var items = asArray(group.items).filter(function (item) { return route.taskFilter === 'all' || !item.completed; });
                if (!items.length) { return ''; }
                return '<section class="rp-task-group"><h3>' + escapeHtml(group.title) + '</h3>' + items.map(function (item) { return '<div class="rp-task-row is-' + (item.completed ? 'done' : 'open') + '"><input type="checkbox" disabled' + (item.completed ? ' checked' : '') + ' aria-label="' + escapeHtml(item.completed ? '已完成' : '未完成') + '"><code>' + escapeHtml(item.id) + '</code><span>' + escapeHtml(item.title) + '</span></div>'; }).join('') + '</section>';
            }).join('') : listEmpty(route.taskFilter === 'all' ? '没有任务' : '所有任务均已完成', route.taskFilter === 'all' ? '官方 tasks.md 当前没有任务项。' : '切换到“全部”可回顾完整执行记录。'));
        }

        function loadTasks(change) {
            var taskArtifact = artifactForTasks(data.index, change.changeId);
            var generation = taskGeneration + 1;
            taskGeneration = generation;
            if (!taskArtifact) {
                var container = rootElement.querySelector('[data-rp-task-results]');
                if (container) { container.innerHTML = listEmpty('任务正文未登记', 'Provider 只返回了官方计数，没有可按稳定 ID 读取的 tasks.md。'); }
                return;
            }
            hostApi.readArtifact(data.sourceHash, taskArtifact.artifactId).then(function (payload) {
                if (disposed || generation !== taskGeneration || !sameId(route.changeId, change.changeId)) { return; }
                renderTaskResults(change, parseTasksMarkdown(payload.content));
            }).catch(function (error) {
                if (disposed || generation !== taskGeneration) { return; }
                var container = rootElement.querySelector('[data-rp-task-results]');
                if (container) { container.innerHTML = listEmpty('任务读取失败', error.message || '任务成果已失效。'); }
            });
        }

        function topicOptions() {
            return '<option value="all">全部主题</option>' + asArray(data.index.topics).map(function (topic) {
                var id = topic.topicId;
                return '<option value="' + escapeHtml(id) + '"' + (artifactTopic === id ? ' selected' : '') + '>' + escapeHtml(topic.name || topic.label || id) + '</option>';
            }).join('');
        }

        function lensLabel(lens) {
            return { conclusions: '关键结论', design: '方案设计', evidence: '验证证据', all: '全部档案' }[lens];
        }

        function artifactEntryButton(item) {
            var title = item.entryType === 'section' ? item.heading : item.title;
            var detail = item.entryType === 'section' ? item.artifactTitle : item.path;
            var sectionId = item.entryType === 'section' ? item.sectionId : '';
            return '<button class="rp-artifact-row" type="button" data-rp-artifact="' + escapeHtml(item.artifactId) + '" data-rp-section="' + escapeHtml(sectionId) + '"><span><small>' + escapeHtml(item.entryType === 'section' ? item.role : item.lifecycle) + ' · ' + escapeHtml(item.authority) + '</small><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(item.summary || '') + '</p><em>' + escapeHtml(detail) + '</em></span><span class="rp-artifact-meta">' + asArray(item.topics).slice(0, 2).map(function (topic) { return '<i>' + escapeHtml(topic) + '</i>'; }).join('') + '</span></button>';
        }

        function renderArtifactResults() {
            var target = rootElement.querySelector('[data-rp-artifact-results]');
            if (!target) { return; }
            var entries = selectArtifactEntries(data.index, route.lens, artifactQuery, artifactTopic);
            target.innerHTML = '<div class="rp-result-count"><strong>' + entries.length + '</strong><span>' + escapeHtml(lensLabel(route.lens)) + '</span></div>' + (entries.length ? entries.map(artifactEntryButton).join('') : listEmpty('没有匹配成果', '调整关键词、主题或阅读视角。'));
        }

        function renderArtifacts() {
            var counts = {};
            LENSES.forEach(function (lens) { counts[lens] = selectArtifactEntries(data.index, lens, '', 'all').length; });
            renderShell('<section class="rp-artifact-browser"><header class="rp-artifact-toolbar"><div class="rp-lenses" aria-label="阅读视角">' + LENSES.map(function (lens) { return '<button type="button" data-rp-lens="' + lens + '" aria-pressed="' + (route.lens === lens) + '"><span>' + lensLabel(lens) + '</span><strong>' + counts[lens] + '</strong></button>'; }).join('') + '</div><div class="rp-artifact-filters"><label><span class="sr-only">搜索成果</span><input type="search" data-rp-query placeholder="搜索标题、摘要或内容分类" value="' + escapeHtml(artifactQuery) + '"></label><label><span class="sr-only">主题</span><select data-rp-topic>' + topicOptions() + '</select></label></div></header><div class="rp-artifact-results" data-rp-artifact-results></div></section>');
            renderArtifactResults();
        }

        function artifactById(id) {
            return asArray(data.index.artifacts).find(function (item) { return sameId(item.artifactId, id); }) || null;
        }

        function sectionForRoute() {
            return asArray(data.index.readingSections).find(function (item) { return sameId(item.sectionId, route.sectionId) && sameId(item.artifactId, route.artifactId); }) || null;
        }

        function diagramForRoute() {
            return asArray(data.index.diagrams).find(function (item) { return sameId(item.diagramId, route.diagramId) && sameId(item.artifactId, route.artifactId); }) || null;
        }

        function diagramBlock(source, metadata) {
            var block = document.createElement('section');
            block.className = 'rp-diagram';
            block.setAttribute('data-rp-diagram-id', metadata ? metadata.diagramId : 'unregistered');
            block.setAttribute('data-rp-render-state', 'idle');
            block.setAttribute('data-rp-diagram-scale', '1');
            var header = document.createElement('header');
            var identity = document.createElement('span');
            identity.textContent = metadata ? metadata.diagramId : 'MERMAID';
            var controls = document.createElement('div');
            controls.className = 'rp-diagram-controls';
            controls.innerHTML = '<span class="rp-diagram-zoom"><button type="button" data-rp-diagram-zoom="out" aria-label="缩小图形" title="缩小">−</button><button type="button" data-rp-diagram-zoom="reset" aria-label="恢复图形比例" title="恢复比例">1:1</button><button type="button" data-rp-diagram-zoom="in" aria-label="放大图形" title="放大">+</button></span><button type="button" data-rp-diagram-mode="graphic" aria-pressed="true">图形</button><button type="button" data-rp-diagram-mode="source" aria-pressed="false">源码</button>' + (metadata ? '<button type="button" data-rp-diagram-link="' + escapeHtml(metadata.diagramId) + '">固定链接</button>' : '');
            header.appendChild(identity);
            header.appendChild(controls);
            var canvas = document.createElement('div');
            canvas.className = 'rp-diagram-canvas';
            var graphic = document.createElement('div');
            graphic.className = 'rp-diagram-graphic';
            graphic.innerHTML = '<div class="rp-diagram-idle">滚动到此处后渲染图形</div>';
            var raw = document.createElement('pre');
            raw.className = 'rp-diagram-source';
            raw.hidden = true;
            var code = document.createElement('code');
            code.textContent = source;
            raw.appendChild(code);
            canvas.appendChild(graphic);
            canvas.appendChild(raw);
            block.appendChild(header);
            block.appendChild(canvas);
            block.__resourceProgramMermaidSource = source;
            return block;
        }

        function decorateArtifact(fragment, artifact) {
            var headings = Array.from(fragment.querySelectorAll('h1,h2,h3,h4,h5,h6'));
            var sections = asArray(data.index.readingSections).filter(function (item) { return sameId(item.artifactId, artifact.artifactId); });
            sections.forEach(function (section) {
                var matches = headings.filter(function (heading) { return heading.textContent.trim() === section.heading.trim(); });
                var heading = matches.length === 1 ? matches[0] : headings[section.sourceIndex];
                if (heading) { heading.setAttribute('data-rp-section-id', section.sectionId); }
            });
            var diagrams = asArray(data.index.diagrams).filter(function (item) { return sameId(item.artifactId, artifact.artifactId); }).slice().sort(function (left, right) { return left.sourceIndex - right.sourceIndex; });
            Array.from(fragment.querySelectorAll('pre > code.language-mermaid')).forEach(function (code, index) {
                var pre = code.parentElement;
                var block = diagramBlock(code.textContent, diagrams[index] || null);
                pre.replaceWith(block);
            });
        }

        function renderArtifact() {
            var artifact = artifactById(route.artifactId);
            if (!artifact) {
                renderShell('<section class="rp-failure"><span>ARTIFACT</span><h2>成果不存在</h2><p>深链接中的成果 ID 未登记或已失效。</p><button type="button" data-rp-route="artifacts/' + route.lens + '">返回成果阅读</button></section>');
                return;
            }
            renderShell('<button class="rp-back" type="button" data-rp-route="artifacts/' + route.lens + '">返回' + lensLabel(route.lens) + '</button><header class="rp-artifact-header"><div><span>' + escapeHtml(artifact.lifecycle) + ' · ' + escapeHtml(artifact.authority) + '</span><h2>' + escapeHtml(artifact.title) + '</h2><p>' + escapeHtml(artifact.summary) + '</p><small>' + escapeHtml(artifact.path) + '</small></div><div><strong>' + asArray(artifact.diagramIds).length + '</strong><span>图表</span></div></header><div class="rp-artifact-reading"><aside class="rp-artifact-outline"><span>文档定位</span>' + asArray(data.index.readingSections).filter(function (item) { return sameId(item.artifactId, artifact.artifactId); }).map(function (item) { return '<button type="button" data-rp-section-link="' + escapeHtml(item.sectionId) + '"><strong>' + escapeHtml(item.heading) + '</strong><small>' + escapeHtml(item.role) + '</small></button>'; }).join('') + '</aside><article class="rp-markdown" data-rp-reader><div class="rp-inline-loading">正在读取成果正文…</div></article></div>');
            loadArtifact(artifact);
        }

        function observeDiagrams() {
            resetObserver();
            var blocks = Array.from(rootElement.querySelectorAll('.rp-diagram'));
            if (!blocks.length) { return; }
            if (view && typeof view.IntersectionObserver === 'function') {
                observer = new view.IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            observer.unobserve(entry.target);
                            renderDiagram(entry.target);
                        }
                    });
                }, { rootMargin: '160px 0px' });
                blocks.forEach(function (block) { observer.observe(block); });
            } else {
                blocks.forEach(renderDiagram);
            }
        }

        function renderDiagram(block) {
            if (!block || block.getAttribute('data-rp-render-state') !== 'idle') { return Promise.resolve(); }
            var mermaid = view && view.mermaid;
            var graphic = block.querySelector('.rp-diagram-graphic');
            block.setAttribute('data-rp-render-state', 'rendering');
            graphic.innerHTML = '<div class="rp-diagram-idle">正在渲染…</div>';
            if (!mermaid || typeof mermaid.render !== 'function') {
                block.setAttribute('data-rp-render-state', 'failed');
                graphic.innerHTML = '<div class="rp-diagram-error">本地图形引擎不可用，可切换到源码。</div>';
                return Promise.resolve();
            }
            if (view.__openspecResourceProgramMermaidTheme !== context.theme) {
                mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    deterministicIds: true,
                    suppressErrorRendering: true,
                    htmlLabels: false,
                    maxEdges: 1000,
                    maxTextSize: 100000,
                    flowchart: { htmlLabels: false },
                    theme: context.theme === 'dark' ? 'dark' : 'neutral'
                });
                view.__openspecResourceProgramMermaidReady = true;
                view.__openspecResourceProgramMermaidTheme = context.theme;
            }
            diagramSequence += 1;
            return Promise.resolve(mermaid.render('rp-mermaid-' + diagramSequence, block.__resourceProgramMermaidSource)).then(function (result) {
                if (disposed || !block.isConnected) { return; }
                var svg = validateMermaidSvg(result.svg, document);
                graphic.replaceChildren(svg);
                svg.style.width = (Number(block.getAttribute('data-rp-diagram-scale')) * 100) + '%';
                svg.style.maxWidth = 'none';
                block.setAttribute('data-rp-render-state', 'rendered');
            }).catch(function (error) {
                if (disposed || !block.isConnected) { return; }
                block.setAttribute('data-rp-render-state', 'failed');
                graphic.innerHTML = '<div class="rp-diagram-error">图形无法渲染：' + escapeHtml(error.message || '语法错误') + '</div>';
            });
        }

        function focusArtifactTarget() {
            var section = sectionForRoute();
            var diagram = diagramForRoute();
            var target = null;
            if (diagram) {
                target = Array.from(rootElement.querySelectorAll('.rp-diagram')).find(function (block) { return sameId(block.getAttribute('data-rp-diagram-id'), diagram.diagramId); });
                if (target) { renderDiagram(target); }
            }
            if (!target && section) { target = rootElement.querySelector('[data-rp-section-id="' + section.sectionId + '"]'); }
            if (target && view && typeof view.requestAnimationFrame === 'function') {
                view.requestAnimationFrame(function () {
                    target.setAttribute('tabindex', '-1');
                    target.scrollIntoView({ block: 'start' });
                    target.focus({ preventScroll: true });
                });
            }
        }

        function loadArtifact(artifact) {
            var generation = readGeneration + 1;
            readGeneration = generation;
            hostApi.readArtifact(data.sourceHash, artifact.artifactId).then(function (payload) {
                if (disposed || generation !== readGeneration || !sameId(route.artifactId, artifact.artifactId)) { return; }
                var reader = rootElement.querySelector('[data-rp-reader]');
                if (!reader) { return; }
                if (payload.mediaType === 'text/markdown') {
                    var fragment = sanitizeMarkdown(payload.content, document);
                    decorateArtifact(fragment, artifact);
                    reader.replaceChildren(fragment);
                    observeDiagrams();
                    focusArtifactTarget();
                } else {
                    var raw = document.createElement('pre');
                    raw.className = 'rp-raw-source';
                    raw.textContent = payload.content;
                    reader.replaceChildren(raw);
                }
            }).catch(function (error) {
                if (disposed || generation !== readGeneration) { return; }
                var reader = rootElement.querySelector('[data-rp-reader]');
                if (reader) { reader.innerHTML = listEmpty('成果读取失败', error.message || '成果已经失效。'); }
            });
        }

        function render() {
            if (!data || disposed) { return; }
            resetObserver();
            route = parseRoute(context.route);
            if (route.view === 'overview') { renderOverview(); }
            else if (route.view === 'workstreams') { renderWorkstreams(); }
            else if (route.view === 'changes') { renderChanges(); }
            else if (route.view === 'change') { renderChange(); }
            else if (route.view === 'governance') { renderGovernance(); }
            else if (route.view === 'artifact') { renderArtifact(); }
            else if (route.view === 'artifacts') { renderArtifacts(); }
            else { renderShell('<section class="rp-failure"><span>ROUTE</span><h2>专项页面不存在</h2><p>深链接中的 Resource Program 子路由不受支持。</p><button type="button" data-rp-route="overview">返回 Program 总览</button></section>'); }
        }

        function validatePayload(payload) {
            var overview = payload && (payload.overviewSnapshot || payload.overview);
            var index = payload && (payload.artifactIndex || payload.index);
            if (!overview || !index || !overview.program || !overview.sourceHash || overview.sourceHash !== index.sourceHash) {
                throw new Error('Resource Program Provider 返回了不完整或版本不一致的快照');
            }
            if (!sameId(overview.providerId, context.providerId) || !sameId(overview.initiativeId, context.initiativeId)) {
                throw new Error('Resource Program Provider 身份与当前深链接不一致');
            }
            return { overview: overview, index: index, sourceHash: overview.sourceHash };
        }

        function load() {
            var generation = loadGeneration + 1;
            loadGeneration = generation;
            renderLoading();
            return hostApi.load().then(function (payload) {
                if (disposed || generation !== loadGeneration) { return false; }
                data = validatePayload(payload);
                render();
                return true;
            }).catch(function (error) {
                if (!disposed && generation === loadGeneration) { renderFailure(error); }
                return false;
            });
        }

        function onClick(event) {
            var target = event.target.closest('button');
            if (!target || !rootElement.contains(target)) { return; }
            if (target.hasAttribute('data-rp-route')) { requestRoute(parseRoute(target.getAttribute('data-rp-route'))); }
            else if (target.hasAttribute('data-rp-change')) { requestRoute({ view: 'change', changeId: target.getAttribute('data-rp-change') }); }
            else if (target.hasAttribute('data-rp-tasks')) { requestRoute({ view: 'tasks', changeId: route.changeId, taskFilter: target.getAttribute('data-rp-tasks') }); }
            else if (target.hasAttribute('data-rp-lens')) { requestRoute({ view: 'artifacts', lens: target.getAttribute('data-rp-lens') }); }
            else if (target.hasAttribute('data-rp-artifact')) { requestRoute({ view: 'artifact', lens: route.lens, artifactId: target.getAttribute('data-rp-artifact'), sectionId: target.getAttribute('data-rp-section') }); }
            else if (target.hasAttribute('data-rp-section-link')) { requestRoute({ view: 'artifact', lens: route.lens, artifactId: route.artifactId, sectionId: target.getAttribute('data-rp-section-link') }); }
            else if (target.hasAttribute('data-rp-diagram-link')) {
                var diagramBlockElement = target.closest('.rp-diagram');
                var preceding = diagramBlockElement.previousElementSibling;
                while (preceding && !preceding.hasAttribute('data-rp-section-id')) { preceding = preceding.previousElementSibling; }
                requestRoute({ view: 'artifact', lens: route.lens, artifactId: route.artifactId, sectionId: preceding ? preceding.getAttribute('data-rp-section-id') : route.sectionId, diagramId: target.getAttribute('data-rp-diagram-link') });
            } else if (target.hasAttribute('data-rp-diagram-zoom')) {
                var zoomBlock = target.closest('.rp-diagram');
                var zoomAction = target.getAttribute('data-rp-diagram-zoom');
                var currentScale = Number(zoomBlock.getAttribute('data-rp-diagram-scale')) || 1;
                var nextScale = zoomAction === 'reset' ? 1 : Math.max(0.5, Math.min(2, currentScale + (zoomAction === 'in' ? 0.25 : -0.25)));
                zoomBlock.setAttribute('data-rp-diagram-scale', String(nextScale));
                target.parentElement.querySelector('[data-rp-diagram-zoom="reset"]').textContent = nextScale === 1 ? '1:1' : Math.round(nextScale * 100) + '%';
                var zoomSvg = zoomBlock.querySelector('.rp-diagram-graphic svg');
                if (zoomSvg) { zoomSvg.style.width = (nextScale * 100) + '%'; zoomSvg.style.maxWidth = 'none'; }
            } else if (target.hasAttribute('data-rp-diagram-mode')) {
                var block = target.closest('.rp-diagram');
                var mode = target.getAttribute('data-rp-diagram-mode');
                block.querySelector('.rp-diagram-graphic').hidden = mode === 'source';
                block.querySelector('.rp-diagram-source').hidden = mode !== 'source';
                Array.from(block.querySelectorAll('[data-rp-diagram-mode]')).forEach(function (button) { button.setAttribute('aria-pressed', String(button === target)); });
                if (mode === 'graphic') { renderDiagram(block); }
            } else if (target.getAttribute('data-rp-action') === 'retry') { load(); }
        }

        function onInput(event) {
            if (event.target.matches('[data-rp-query]')) {
                artifactQuery = event.target.value;
                renderArtifactResults();
            } else if (event.target.matches('[data-rp-topic]')) {
                artifactTopic = event.target.value;
                renderArtifactResults();
            }
        }

        return {
            mount: function (nextContext) {
                if (disposed) { return Promise.resolve(false); }
                context = nextContext;
                route = parseRoute(context.route);
                if (!mounted) {
                    rootElement.addEventListener('click', onClick);
                    rootElement.addEventListener('input', onInput);
                    rootElement.addEventListener('change', onInput);
                    mounted = true;
                }
                return load();
            },
            update: function (nextContext) {
                if (disposed) { return Promise.resolve(false); }
                var identityChanged = !context || context.projectId !== nextContext.projectId || context.revision !== nextContext.revision || context.initiativeId !== nextContext.initiativeId || (context.descriptor && nextContext.descriptor && context.descriptor.sourceHash !== nextContext.descriptor.sourceHash);
                context = nextContext;
                route = parseRoute(context.route);
                if (identityChanged || !data) { return load(); }
                render();
                return Promise.resolve(true);
            },
            dispose: function () {
                disposed = true;
                loadGeneration += 1;
                readGeneration += 1;
                taskGeneration += 1;
                resetObserver();
                if (mounted) {
                    rootElement.removeEventListener('click', onClick);
                    rootElement.removeEventListener('input', onInput);
                    rootElement.removeEventListener('change', onInput);
                }
                mounted = false;
                rootElement.replaceChildren();
                return Promise.resolve();
            }
        };
    }

    var app = {
        id: APP_ID,
        create: function (options) {
            if (!options || !options.root || !options.api || typeof options.api.load !== 'function' || typeof options.api.readArtifact !== 'function' || typeof options.api.setRoute !== 'function') {
                throw new Error('Resource Program App 宿主 API 不完整');
            }
            return createAppInstance(options);
        }
    };

    return {
        APP_ID: APP_ID,
        app: app,
        artifactForTasks: artifactForTasks,
        buildRoute: buildRoute,
        parseRoute: parseRoute,
        parseTasksMarkdown: parseTasksMarkdown,
        selectArtifactEntries: selectArtifactEntries,
        validateMermaidSvg: validateMermaidSvg
    };
}));
