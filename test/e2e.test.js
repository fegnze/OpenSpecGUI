'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var fs = require('node:fs');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var uiFixture = require('./ui-fixture');
var uiHelpers = require('./ui-test-helpers');

function waitForExit(child, timeoutMs) {
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
            child.kill('SIGKILL');
            reject(new Error('第二个应用实例未及时退出'));
        }, timeoutMs);
        child.once('exit', function (code) {
            clearTimeout(timer);
            resolve(code);
        });
        child.once('error', function (error) {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function assertFixedSidebarScroll(page, context) {
    var before = await page.evaluate(function () {
        var workspace = document.querySelector('.workspace');
        var sidebar = document.querySelector('.sidebar');
        var toolbar = document.querySelector('.toolbar');
        var status = document.querySelector('.sidebar-status');
        var sidebarRect = sidebar.getBoundingClientRect();
        var statusRect = status.getBoundingClientRect();

        workspace.scrollTop = 0;
        document.scrollingElement.scrollTop = 0;
        return {
            appHeight: document.querySelector('.app-shell').getBoundingClientRect().height,
            viewportHeight: window.innerHeight,
            workspaceCanScroll: workspace.scrollHeight > workspace.clientHeight,
            sidebar: { top: sidebarRect.top, bottom: sidebarRect.bottom },
            toolbarTop: toolbar.getBoundingClientRect().top,
            statusVisible: statusRect.width > 0 && statusRect.height > 0,
            status: { top: statusRect.top, bottom: statusRect.bottom }
        };
    });

    assert.equal(before.workspaceCanScroll, true, context + ' 缺少可滚动的右侧长内容');
    assert.equal(before.appHeight, before.viewportHeight, context + ' 应用外壳未锁定到窗口高度');
    await page.locator('.page').hover();
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(function () {
        return document.querySelector('.workspace').scrollTop > 0;
    });

    var after = await page.evaluate(function () {
        var workspace = document.querySelector('.workspace');
        var sidebar = document.querySelector('.sidebar');
        var toolbar = document.querySelector('.toolbar');
        var status = document.querySelector('.sidebar-status');
        var sidebarRect = sidebar.getBoundingClientRect();
        var statusRect = status.getBoundingClientRect();
        return {
            documentScrollTop: document.scrollingElement.scrollTop,
            workspaceScrollTop: workspace.scrollTop,
            sidebar: { top: sidebarRect.top, bottom: sidebarRect.bottom },
            toolbarTop: toolbar.getBoundingClientRect().top,
            status: { top: statusRect.top, bottom: statusRect.bottom }
        };
    });

    assert.equal(after.documentScrollTop, 0, context + ' 不应滚动根文档');
    assert.ok(after.workspaceScrollTop > 0, context + ' 右侧 workspace 未响应滚轮');
    assert.deepEqual(after.sidebar, before.sidebar, context + ' 侧边栏位置随内容滚动');
    assert.equal(after.toolbarTop, before.toolbarTop, context + ' 工具栏位置随内容滚动');
    if (before.statusVisible) {
        assert.deepEqual(after.status, before.status, context + ' 侧边栏底部状态随内容滚动');
        assert.ok(after.status.top >= 0 && after.status.bottom <= before.viewportHeight, context + ' 侧边栏底部状态不可见');
    }
    await page.evaluate(function () {
        document.querySelector('.workspace').scrollTop = 0;
    });
}

async function readClipboard(electronApp) {
    return electronApp.evaluate(function (electron) { return electron.clipboard.readText(); });
}

async function waitForCopyFeedback(page) {
    await page.waitForFunction(function () {
        var toast = document.getElementById('toast');
        return toast && !toast.hidden && toast.textContent === '提案名已复制';
    });
}

test('独立 Electron 应用完成多项目任务工作流与视觉验收', { timeout: 180000 }, async function () {
    var fixture = await uiFixture.createUiFixture();
    var temporaryRoot = fixture.root;
    var projectAlpha = fixture.primaryProject;
    var projectBeta = fixture.secondaryProject;
    var artifacts = path.resolve(__dirname, '..', 'artifacts');
    var electronApp;
    var launched;
    try {
        await fsPromises.mkdir(artifacts, { recursive: true });
        launched = await uiHelpers.launchWorkbench(fixture, { theme: 'light' });
        electronApp = launched.electronApp;
        var page = launched.page;
        assert.match(await page.locator('.onboarding-state h1').textContent(), /没有已添加的项目/);
        assert.match(await page.locator('.brand-mark img').getAttribute('src'), /assets\/product-mark\.png$/);
        assert.equal(await page.locator('.brand-mark img').evaluate(function (image) {
            return image.complete && image.naturalWidth === 512 && image.naturalHeight === 512;
        }), true);

        var windowChromeRegions = await page.evaluate(function () {
            return {
                toolbar: getComputedStyle(document.querySelector('.toolbar')).webkitAppRegion,
                search: getComputedStyle(document.querySelector('.search-field')).webkitAppRegion,
                refresh: getComputedStyle(document.querySelector('#refresh-button')).webkitAppRegion
            };
        });
        assert.deepEqual(windowChromeRegions, {
            toolbar: 'drag',
            search: 'no-drag',
            refresh: 'no-drag'
        });

        var scan = await page.evaluate(function (root) { return window.openSpecGUI.projects.scan({ path: root }); }, temporaryRoot);
        assert.equal(scan.candidates.length, 2);

        await uiHelpers.addFixtureProjects(page, fixture);
        var activeProjectId = await page.evaluate(async function () {
            return (await window.openSpecGUI.projects.list()).activeProjectId;
        });
        var registeredProjectNames = await page.evaluate(async function () {
            return (await window.openSpecGUI.projects.list()).projects.map(function (project) { return project.name; });
        });
        assert.deepEqual(registeredProjectNames.sort(), ['atlas-workbench', 'empty-specs']);
        assert.equal(await page.locator('.project-option[aria-selected="true"]').getAttribute('data-project-option'), activeProjectId);
        assert.match(await page.locator('#project-picker-button').textContent(), /atlas-workbench/);
        assert.equal(await page.locator('.proposal-lane').count(), 3);
        assert.equal(await page.locator('.proposal-lane-card').count(), 3);
        assert.equal(await page.locator('.control-table-row').count(), 0);
        assert.deepEqual(await page.locator('.proposal-lane h2').allTextContents(), ['进行中', '待归档', '需要处理']);
        assert.equal(await page.locator('.primary-nav [data-route]').count(), 4);
        assert.equal(await page.locator('[data-route="changes"]').count(), 0);
        var overviewProgress = await page.locator('.proposal-lane-card[data-entity-id="modern-console"] .progress-bar').evaluate(function (progressBar) {
            var segments = Array.from(progressBar.querySelectorAll('.progress-segment'));
            var partial = segments.find(function (segment) { return segment.classList.contains('is-partial'); });
            var rect = progressBar.getBoundingClientRect();
            return {
                display: getComputedStyle(progressBar).display,
                width: rect.width,
                height: rect.height,
                segmentCount: segments.length,
                segmentsHaveSize: segments.every(function (segment) {
                    var segmentRect = segment.getBoundingClientRect();
                    return segmentRect.width > 0 && segmentRect.height > 0;
                }),
                filledCount: segments.filter(function (segment) { return segment.classList.contains('is-filled'); }).length,
                partialClass: partial ? partial.className : ''
            };
        });
        assert.equal(overviewProgress.display, 'grid');
        assert.ok(overviewProgress.width > 0 && overviewProgress.height > 0);
        assert.equal(overviewProgress.segmentCount, 10);
        assert.equal(overviewProgress.segmentsHaveSize, true);
        assert.equal(overviewProgress.filledCount, 8);
        assert.match(overviewProgress.partialClass, /partial-3/);
        await uiHelpers.assertNoSeriousA11yViolations(page, '首页');
        await uiHelpers.assertNoPageOverflow(page, '宽桌面首页');
        await uiHelpers.assertReachable(page, ['#project-picker-button', '#project-manage-button', '#refresh-button', '[data-route="overview"]'], '首页');
        var laneCopyButton = page.locator('.proposal-lane-card-shell[data-entity-id="modern-console"] [data-action="copy-proposal-name"]');
        var laneCopyHash = await page.evaluate(function () { return window.location.hash; });
        assert.equal(await laneCopyButton.getAttribute('aria-label'), '复制提案名 modern-console');
        await laneCopyButton.focus();
        await page.keyboard.press('Enter');
        await waitForCopyFeedback(page);
        assert.equal(await readClipboard(electronApp), 'modern-console');
        assert.equal(await page.evaluate(function () { return window.location.hash; }), laneCopyHash);
        assert.equal(await laneCopyButton.getAttribute('aria-label'), '已复制提案名 modern-console');
        assert.equal(await page.locator('.control-header h1').textContent(), '当前执行');

        await page.locator('#project-picker-button').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('#project-options:not([hidden])');
        assert.equal(await page.locator('.project-option').count(), 2);
        await uiHelpers.assertNoSeriousA11yViolations(page, '项目选择菜单');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#project-options').getAttribute('hidden'), '');
        assert.equal(await page.evaluate(function () { return document.activeElement && document.activeElement.id; }), 'project-picker-button');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#project-options:not([hidden])');
        await page.keyboard.press('Home');
        await page.keyboard.press('Enter');
        await page.waitForFunction(function () { return document.title.indexOf('empty-specs') === 0; });
        assert.equal(await page.locator('#project-picker-button').getAttribute('aria-expanded'), 'false');
        await page.locator('#project-picker-button').focus();
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('#project-options:not([hidden])');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.waitForFunction(function () { return document.title.indexOf('atlas-workbench') === 0; });

        await page.locator('#project-manage-button').click();
        await page.waitForSelector('#project-dialog[open]');
        assert.equal(await page.locator('.project-registry-row').count(), 2);
        await uiHelpers.assertNoSeriousA11yViolations(page, '项目管理对话框');
        await uiHelpers.assertReachable(page, ['[data-project-action="add"]', '[data-project-action="scan"]', '[data-project-action="close"]'], '项目管理对话框');
        await page.screenshot({ path: path.join(artifacts, 'project-manager.png'), fullPage: true });
        await page.locator('[data-project-action="close"]').click();

        await page.locator('#project-manage-button').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('#project-dialog[open]');
        await page.locator('.project-registry-row', { hasText: 'empty-specs' }).locator('[data-project-action="select"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(function () { return document.title.indexOf('empty-specs') === 0; });
        assert.equal(await page.locator('.proposal-lane-card').count(), 0);
        assert.match(await page.locator('.compact-empty').textContent(), /没有活跃提案/);
        await page.locator('#project-manage-button').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('#project-dialog[open]');
        await page.locator('.project-registry-row', { hasText: 'atlas-workbench' }).locator('[data-project-action="select"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(function () { return document.title.indexOf('atlas-workbench') === 0; });
        assert.equal(await page.locator('.execution-lanes').count(), 1);
        assert.equal(await page.locator('.task-queue, [data-role="task-queue"]').count(), 0);

        assert.deepEqual(await page.locator('.metric-strip [data-status-filter]').evaluateAll(function (buttons) {
            return buttons.map(function (button) { return button.getAttribute('data-status-filter'); });
        }), ['all', 'in-progress', 'ready-to-archive', 'attention']);
        await page.locator('.metric-block[data-status-filter="ready-to-archive"]').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.control-table-row').count(), 1);
        assert.equal(await page.locator('.control-table-row').getAttribute('data-entity-id'), 'archive-ready-theme');
        assert.equal(await page.locator('.proposal-list-toolbar h2').textContent(), '待归档提案');
        assert.equal(await page.locator('.metric-block[data-status-filter="ready-to-archive"]').getAttribute('aria-pressed'), 'true');
        var tableCopyButton = page.locator('.control-table-row-shell[data-entity-id="archive-ready-theme"] [data-action="copy-proposal-name"]');
        var filteredHash = await page.evaluate(function () { return window.location.hash; });
        await tableCopyButton.click();
        await waitForCopyFeedback(page);
        assert.equal(await readClipboard(electronApp), 'archive-ready-theme');
        assert.equal(await page.evaluate(function () { return window.location.hash; }), filteredHash);
        assert.equal(await page.locator('.metric-block[data-status-filter="ready-to-archive"]').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await page.locator('.status-segments [data-status-filter]').evaluateAll(function (buttons) {
            return buttons.map(function (button) { return button.getAttribute('data-status-filter'); });
        }), ['all', 'in-progress', 'ready-to-archive', 'attention']);
        await page.locator('.metric-block[data-status-filter="attention"]').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.proposal-list-toolbar h2').textContent(), '需要处理的提案');
        await page.locator('.status-segments [data-status-filter="attention"]').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.control-table-row').count(), 1);

        await page.locator('.primary-nav [data-route="specs"]').click();
        await page.waitForSelector('.collection-header');
        assert.equal(await page.locator('[data-action="copy-proposal-name"]').count(), 0);
        await page.locator('.primary-nav [data-route="overview"]').click();
        await page.waitForSelector('.control-header');
        assert.equal(await page.locator('.control-header h1').textContent(), '当前执行');
        assert.equal(await page.locator('.metric-block').count(), 4);
        assert.equal(await page.locator('.proposal-lane-card').count(), 3);
        assert.equal(await page.locator('.control-table-row').count(), 0);
        assert.equal(await page.locator('.overview-heading h2').textContent(), '执行状态');
        assert.equal(await page.locator('.metric-block[data-status-filter="all"]').getAttribute('aria-pressed'), 'true');
        assert.doesNotMatch(await page.evaluate(function () { return window.location.hash; }), /status=/);

        await page.evaluate(function () { window.location.hash = 'view=changes&status=attention'; });
        await page.waitForFunction(function () {
            var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
            return params.get('view') === 'overview' && Boolean(params.get('project')) && !params.has('status');
        });
        assert.equal(await page.locator('.control-header h1').textContent(), '当前执行');
        assert.equal(await page.locator('.metric-block').count(), 4);
        assert.equal(await page.locator('.proposal-lane-card').count(), 3);
        assert.equal(await page.locator('.control-table-row').count(), 0);
        assert.equal(await page.locator('.metric-block[data-status-filter="all"]').getAttribute('aria-pressed'), 'true');

        await page.locator('.primary-nav [data-route="initiatives"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.initiative-list');
        assert.equal(await page.locator('.initiative-row').count(), 2);
        assert.match(await page.locator('.initiative-row[data-provider-id="openspec-generic-initiative-v1"]').textContent(), /发布准备专项/);
        assert.equal(await page.locator('.initiative-diagnostics li').count(), 1);
        assert.match(await page.locator('.initiative-diagnostics').textContent(), /INVALID_GENERIC_INITIATIVE|schemaVersion/i);
        assert.equal(await page.locator('.control-table-row').count(), 2);
        assert.equal(await page.locator('[data-change-scope="independent"]').getAttribute('aria-pressed'), 'true');
        await page.locator('[data-change-scope="all"]').click();
        assert.equal(await page.locator('.control-table-row').count(), 3);
        assert.equal(await page.locator('[data-change-scope="all"]').getAttribute('aria-pressed'), 'true');
        await uiHelpers.assertNoSeriousA11yViolations(page, 'Initiative 列表');
        await uiHelpers.assertNoPageOverflow(page, 'Initiative 列表');
        await uiHelpers.assertTextFits(page, ['.initiative-row-copy strong', '.initiative-row-copy p', '.initiative-diagnostics li'], 'Initiative 列表');
        await uiHelpers.assertReachable(page, ['[data-route="overview"]', '.initiative-row', '[data-change-scope="independent"]'], 'Initiative 列表');

        await page.locator('.initiative-row[data-provider-id="openspec-generic-initiative-v1"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.initiative-detail-grid');
        assert.match(await page.locator('.initiative-detail-header h1').textContent(), /发布准备专项/);
        assert.equal(await page.locator('.initiative-reference').count(), 2);
        await page.waitForSelector('[data-initiative-artifact="release-summary"]');
        await page.locator('[data-initiative-artifact="release-summary"]').click();
        await page.waitForSelector('.initiative-artifact-reader .markdown-body');
        assert.match(await page.locator('.initiative-artifact-reader .markdown-body').textContent(), /核心交付链路已就绪/);
        assert.match(await page.evaluate(function () { return window.location.hash; }), /provider=openspec-generic-initiative-v1/);
        assert.match(await page.evaluate(function () { return window.location.hash; }), /project=/);
        assert.match(await page.evaluate(function () { return window.location.hash; }), /artifact=release-summary/);
        await fsPromises.writeFile(path.join(projectAlpha, 'openspec', 'initiatives', 'release-readiness', 'summary.md'), '# 发布结论\n\n外部更新已被条件刷新捕获。\n', 'utf8');
        await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
        await page.waitForFunction(function () {
            var article = document.querySelector('.initiative-artifact-reader .markdown-body');
            return article && article.textContent.indexOf('外部更新已被条件刷新捕获') !== -1;
        });
        assert.match(await page.evaluate(function () { return window.location.hash; }), /artifact=release-summary/);
        await page.locator('#refresh-button').click();
        await page.waitForSelector('.initiative-artifact-reader .markdown-body');
        assert.match(await page.evaluate(function () { return window.location.hash; }), /artifact=release-summary/);
        await page.setViewportSize({ width: 820, height: 640 });
        await uiHelpers.assertNoPageOverflow(page, '820x640 Initiative 详情');
        await uiHelpers.assertNoControlOverlap(page, '820x640 Initiative 详情');
        await uiHelpers.assertNoSeriousA11yViolations(page, '820x640 Initiative 详情');
        await uiHelpers.assertTextFits(page, ['.initiative-detail-header h1', '.initiative-goal p', '.initiative-artifact strong'], '820x640 Initiative 详情');
        await page.setViewportSize({ width: 1440, height: 930 });
        await page.locator('.back-button[data-route="initiatives"]').click();
        await page.waitForSelector('.initiative-list');
        await page.locator('.primary-nav [data-route="overview"]').click();
        await page.waitForSelector('.control-header');

        await page.locator('.proposal-lane-card[data-entity-id="modern-console"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.task-execution');
        assert.equal(await page.locator('.task-row').count(), 6);
        assert.equal(await page.locator('.detail-score strong').textContent(), '83%');
        assert.equal(await page.locator('.detail-score .progress-segment.partial-3').count(), 1);
        var taskDetailCopy = page.locator('.change-state-line [data-action="copy-proposal-name"]');
        var taskDetailHash = await page.evaluate(function () { return window.location.hash; });
        await taskDetailCopy.click();
        await waitForCopyFeedback(page);
        assert.equal(await readClipboard(electronApp), 'modern-console');
        assert.equal(await page.evaluate(function () { return window.location.hash; }), taskDetailHash);
        await page.setViewportSize({ width: 1440, height: 640 });
        await assertFixedSidebarScroll(page, '宽桌面提案详情');
        await page.setViewportSize({ width: 1440, height: 930 });
        await uiHelpers.assertNoSeriousA11yViolations(page, '提案详情');
        await uiHelpers.assertNoPageOverflow(page, '宽桌面提案详情');
        await uiHelpers.assertTextFits(page, ['.change-identity h1', '.next-action-banner strong', '.task-title'], '提案详情');
        await uiHelpers.assertStableControlSizes(page, ['.detail-tabs button', '.context-document'], '提案详情');
        await uiHelpers.assertReachable(page, ['[data-route="overview"]', '[data-panel="tasks"]', '[data-panel="documents"]'], '提案详情');
        await page.locator('[data-action="locate-current-task"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.task-row.is-target');
        assert.equal(await page.evaluate(function () { return document.activeElement && document.activeElement.id; }), 'task-24');
        await page.screenshot({ path: path.join(artifacts, 'desktop-task-detail.png'), fullPage: true });
        await page.setViewportSize({ width: 1180, height: 760 });
        await assertFixedSidebarScroll(page, '紧凑桌面提案详情');
        await uiHelpers.assertNoPageOverflow(page, '紧凑桌面提案详情');
        await uiHelpers.assertNoControlOverlap(page, '紧凑桌面提案详情');
        await page.locator('#project-picker-button').click();
        await page.waitForSelector('#project-options:not([hidden])');
        var compactProjectMenu = await page.locator('#project-options').evaluate(function (menu) {
            var rect = menu.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
        });
        assert.ok(compactProjectMenu.top >= 0 && compactProjectMenu.bottom <= compactProjectMenu.viewportHeight,
            '紧凑桌面项目菜单被固定外壳裁切：' + JSON.stringify(compactProjectMenu));
        await page.keyboard.press('Escape');
        await electronApp.evaluate(function (electron, factor) {
            electron.BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor);
        }, 1.25);
        await uiHelpers.assertNoPageOverflow(page, '125% 缩放提案详情');
        await electronApp.evaluate(function (electron, factor) {
            electron.BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor);
        }, 1);
        await page.setViewportSize({ width: 820, height: 640 });
        await assertFixedSidebarScroll(page, '最小窗口提案详情');
        await uiHelpers.assertNoPageOverflow(page, '最小窗口提案详情');
        await uiHelpers.assertNoControlOverlap(page, '最小窗口提案详情');
        await page.setViewportSize({ width: 1440, height: 930 });

        await page.locator('[data-panel="documents"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.markdown-body');
        assert.equal(await page.locator('.detail-meta [data-action="copy-proposal-name"]').getAttribute('aria-label'), '复制提案名 modern-console');
        var securityState = await page.evaluate(function () {
            var image = document.querySelector('.markdown-body img');
            return {
                pwned: window.__openspecPwned,
                scriptCount: document.querySelectorAll('.markdown-body script').length,
                imageSource: image ? image.getAttribute('src') : null,
                imageHandler: image ? image.getAttribute('onerror') : null,
                requireType: typeof window.require,
                apiKeys: Object.keys(window.openSpecGUI).sort()
            };
        });
        assert.equal(securityState.pwned, undefined);
        assert.equal(securityState.scriptCount, 0);
        assert.equal(securityState.imageSource, null);
        assert.equal(securityState.imageHandler, null);
        assert.equal(securityState.requireType, 'undefined');
        assert.deepEqual(securityState.apiKeys, ['clipboard', 'documents', 'initiativeApp', 'initiatives', 'projects', 'workspace']);
        await uiHelpers.assertNoSeriousA11yViolations(page, '文档阅读');
        await uiHelpers.assertNoPageOverflow(page, '文档阅读');
        await uiHelpers.assertReachable(page, ['[data-panel="tasks"]', '[data-mode="rendered"]', '[data-mode="raw"]', '[data-action="copy-path"]'], '文档阅读');
        await page.screenshot({ path: path.join(artifacts, 'desktop-document-security.png'), fullPage: true });
        await page.setViewportSize({ width: 820, height: 640 });
        await uiHelpers.assertNoPageOverflow(page, '最小窗口文档阅读');
        await uiHelpers.assertNoControlOverlap(page, '最小窗口文档阅读');
        await uiHelpers.assertTextFits(page, ['.document-detail-header h1', '.document-tab'], '最小窗口文档阅读');
        await page.locator('[data-panel="tasks"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.task-execution');
        await page.locator('.back-button').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.control-header');
        await page.setViewportSize({ width: 820, height: 640 });
        await uiHelpers.assertNoPageOverflow(page, '最小窗口首页');
        await uiHelpers.assertNoControlOverlap(page, '最小窗口首页');
        await uiHelpers.assertTextFits(page, ['.lane-card-copy strong', '.control-state', '.brand-copy strong'], '最小窗口首页');
        await uiHelpers.assertStableControlSizes(page, ['.primary-nav button', '.metric-block', '.icon-button'], '最小窗口首页');
        await uiHelpers.assertReachable(page, ['#toolbar-project-button', '#refresh-button', '.proposal-lane-card'], '最小窗口首页');
        await page.locator('#toolbar-project-button').click();
        await page.waitForSelector('#project-dialog[open]');
        assert.match(await page.locator('#toolbar-project-name').textContent(), /atlas-workbench/);
        await page.locator('[data-project-action="close"]').click();
        await page.screenshot({ path: path.join(artifacts, 'minimum-overview.png'), fullPage: true });

        await page.locator('.proposal-lane-card[data-entity-id="resolve-import-diagnostics"]').click();
        await page.waitForSelector('.compact-task-state');
        assert.match(await page.locator('.current-task-focus').textContent(), /tasks\.md|任务清单/);
        assert.ok(await page.locator('.context-document').count() >= 1);
        await page.locator('.context-panel > summary').click();
        assert.equal(await page.locator('.context-panel').getAttribute('open'), null);
        await page.locator('.context-panel > summary').click();
        await uiHelpers.assertNoSeriousA11yViolations(page, '无任务提案详情');
        await uiHelpers.assertNoPageOverflow(page, '无任务提案详情');
        await page.locator('.back-button[data-route="overview"]').click();

        await page.locator('.proposal-lane-card[data-entity-id="archive-ready-theme"]').click();
        await page.waitForSelector('.task-execution');
        assert.equal(await page.locator('.detail-score strong').textContent(), '100%');
        assert.match(await page.locator('.current-task-focus').textContent(), /归档/);
        assert.equal(await page.locator('[data-action="locate-current-task"]').count(), 0);
        assert.equal(await page.locator('.task-row.is-completed').count(), 4);
        await page.locator('.back-button[data-route="overview"]').click();

        var registry = await page.evaluate(function () { return window.openSpecGUI.projects.list(); });
        var beta = registry.projects.find(function (project) { return project.name === 'empty-specs'; });
        var movedBeta = path.join(temporaryRoot, 'empty-specs-moved');
        await fsPromises.rename(projectBeta, movedBeta);
        await page.locator('#toolbar-project-button').click();
        await page.waitForSelector('#project-dialog[open]');
        var invalidProjectRow = page.locator('.project-registry-row', { hasText: 'empty-specs' });
        await invalidProjectRow.waitFor();
        assert.equal(await invalidProjectRow.getAttribute('class'), 'project-registry-row is-invalid');
        assert.match(await invalidProjectRow.textContent(), /路径失效/);
        await page.locator('[data-project-action="close"]').click();
        var relink = await page.evaluate(function (input) { return window.openSpecGUI.projects.relink(input.id, input.path); }, { id: beta.id, path: movedBeta });
        var relinkedBeta = relink.registry.projects.find(function (project) { return project.id === beta.id; });
        assert.equal(relinkedBeta.rootPath, await fsPromises.realpath(movedBeta));
        assert.equal(relinkedBeta.name, 'empty-specs-moved');
        await page.locator('#toolbar-project-button').click();
        await page.waitForSelector('#project-dialog[open]');
        var restoredProjectRow = page.locator('.project-registry-row', { hasText: 'empty-specs-moved' });
        assert.doesNotMatch(await restoredProjectRow.getAttribute('class'), /is-invalid/);
        page.once('dialog', function (dialog) { dialog.accept(); });
        await restoredProjectRow.locator('[data-project-action="remove"]').click();
        await restoredProjectRow.waitFor({ state: 'detached' });
        await page.locator('[data-project-action="close"]').click();
        var removed = await page.evaluate(function () { return window.openSpecGUI.projects.list(); });
        assert.equal(removed.projects.some(function (project) { return project.id === beta.id; }), false);

        var repositoryProjectId = await page.evaluate(async function (root) {
            var result = await window.openSpecGUI.projects.add({ paths: [root] });
            return result.added[0].id;
        }, uiHelpers.repositoryRoot);
        await page.evaluate(function (projectId) {
            history.replaceState(null, '', '#view=overview&project=' + encodeURIComponent(projectId));
        }, repositoryProjectId);
        await page.reload();
        await page.waitForSelector('.control-header');
        var repositoryContext = await page.evaluate(function () {
            return { title: document.title, project: document.querySelector('#project-picker-name').textContent };
        });
        assert.deepEqual(repositoryContext, { title: 'OpenSpecGUI · OpenSpec GUI', project: 'OpenSpecGUI' });
        await page.locator('.primary-nav [data-route="archives"]').click();
        await page.waitForSelector('.document-row[data-entity-id="2026-08-24-refine-workbench-visual-system"]');
        var archiveListCopy = page.locator('.document-row-shell[data-entity-id="2026-08-24-refine-workbench-visual-system"] [data-action="copy-proposal-name"]');
        var archiveListHash = await page.evaluate(function () { return window.location.hash; });
        await archiveListCopy.click();
        await waitForCopyFeedback(page);
        assert.equal(await readClipboard(electronApp), '2026-08-24-refine-workbench-visual-system');
        assert.equal(await page.evaluate(function () { return window.location.hash; }), archiveListHash);
        assert.equal(await page.locator('.collection-header h1').textContent(), '归档记录');
        await page.locator('.document-row[data-entity-id="2026-08-24-refine-workbench-visual-system"]').click();
        await page.waitForSelector('.markdown-body');
        await page.locator('.document-tab', { hasText: 'Tasks 原文' }).click();
        await page.waitForFunction(function () {
            return document.querySelectorAll('.markdown-body input[type="checkbox"]').length >= 39;
        });
        var archiveDetailCopy = page.locator('.detail-meta [data-action="copy-proposal-name"]');
        await page.evaluate(function () { document.querySelector('.workspace').scrollTop = 240; });
        var archiveDetailState = await page.evaluate(function () {
            return { hash: window.location.hash, scrollTop: document.querySelector('.workspace').scrollTop };
        });
        await archiveDetailCopy.evaluate(function (button) { button.click(); });
        await waitForCopyFeedback(page);
        assert.equal(await readClipboard(electronApp), '2026-08-24-refine-workbench-visual-system');
        assert.deepEqual(await page.evaluate(function () {
            return { hash: window.location.hash, scrollTop: document.querySelector('.workspace').scrollTop };
        }), archiveDetailState);
        await page.setViewportSize({ width: 1180, height: 760 });
        await assertFixedSidebarScroll(page, '真实大型归档紧凑详情');
        await uiHelpers.assertNoPageOverflow(page, '真实大型归档紧凑详情');
        await page.setViewportSize({ width: 820, height: 640 });
        await assertFixedSidebarScroll(page, '真实大型归档最小详情');
        await uiHelpers.assertNoPageOverflow(page, '真实大型归档最小详情');
        await uiHelpers.assertTextFits(page, ['.document-detail-header h1', '.markdown-body li'], '真实大型归档详情');
        var atlas = registry.projects.find(function (project) { return project.name === 'atlas-workbench'; });
        await page.evaluate(function (projectId) { return window.openSpecGUI.projects.select(projectId); }, atlas.id);
        await page.evaluate(function (projectId) {
            history.replaceState(null, '', '#view=overview&project=' + encodeURIComponent(projectId));
        }, atlas.id);
        await page.reload();
        await page.waitForFunction(function () { return document.title.indexOf('atlas-workbench') === 0; });

        var refreshed = await page.evaluate(function () { return window.openSpecGUI.workspace.refresh(); });
        assert.equal(refreshed.snapshot.project.name, 'atlas-workbench');
        assert.equal(refreshed.snapshot.generatedAt, fixture.fixedNow);

        var second = childProcess.spawn(launched.electronExecutable, launched.applicationArguments, {
            env: launched.environment,
            stdio: 'ignore'
        });
        assert.equal(await waitForExit(second, 8000), 0);
        assert.equal((await electronApp.windows()).length, 1);

        await electronApp.close();
        electronApp = null;
        var standalone = childProcess.spawn(launched.electronExecutable, launched.applicationArguments, {
            env: launched.environment,
            stdio: 'ignore'
        });
        await new Promise(function (resolve) { setTimeout(resolve, 1800); });
        if (fs.existsSync('/usr/sbin/lsof')) {
            var listening = '';
            try {
                listening = childProcess.execFileSync('/usr/sbin/lsof', ['-a', '-p', String(standalone.pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
            } catch (error) {
                listening = error.stdout || '';
            }
            assert.equal(listening.trim(), '');
        }
        var standaloneExit = waitForExit(standalone, 8000);
        standalone.kill('SIGTERM');
        await standaloneExit;
    } finally {
        if (electronApp) {
            await electronApp.close();
        }
        await fixture.cleanup();
    }
});

test('embedded Initiative App 以独立 WebContentsView 原样运行并保持路由与边界', { timeout: 60000 }, async function (context) {
    var fixture = await uiFixture.createUiFixture();
    var electronApp;
    try {
        var launched = await uiHelpers.launchWorkbench(fixture, {
            theme: 'light',
            userDataName: 'embedded-app-user-data'
        });
        electronApp = launched.electronApp;
        var page = launched.page;

        async function readEmbeddedState() {
            return electronApp.evaluate(async function (electron) {
                var child = electron.webContents.getAllWebContents().find(function (contents) {
                    return contents.getURL().startsWith('openspec-initiative-app://');
                });
                if (!child || child.isDestroyed()) { return null; }
                return child.executeJavaScript('({url:location.pathname+location.search+location.hash,title:document.title,ready:Boolean(window.__embeddedInitiativeReady),width:window.innerWidth,height:window.innerHeight,text:document.body.textContent})').then(function (state) {
                    state.webContentsId = child.id;
                    state.focused = child.isFocused();
                    return state;
                });
            });
        }

        async function waitForEmbedded(predicate) {
            var deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                var value = await readEmbeddedState();
                if (value && predicate(value)) { return value; }
                await new Promise(function (resolve) { setTimeout(resolve, 60); });
            }
            throw new Error('等待 embedded Initiative App 超时');
        }

        await uiHelpers.addFixtureProjects(page, fixture);
        await page.setViewportSize({ width: 1440, height: 930 });
        await page.locator('.primary-nav [data-route="initiatives"]').click();
        await page.waitForSelector('.initiative-list');
        var programInitiative = page.locator('.initiative-row[data-provider-id="openspec-embedded-app-v1"]');
        assert.equal(await programInitiative.count(), 1);
        assert.match(await programInitiative.textContent(), /交付专项/);
        await programInitiative.click();
        await page.waitForSelector('.initiative-app-boundary');
        var hostBounds = await page.locator('.initiative-app-boundary').boundingBox();
        var initial = await waitForEmbedded(function (value) {
            return value.ready && Math.abs(value.width - hostBounds.width) <= 2 && Math.abs(value.height - hostBounds.height) <= 2;
        });
        assert.equal(initial.url, '/index.html');
        assert.equal(initial.title, '交付专项');
        assert.match(initial.text, /项目自有应用独立运行/);
        assert.equal(await page.locator('.initiative-app-boundary h1').count(), 0);
        assert.ok(Math.abs(initial.width - hostBounds.width) <= 2);
        assert.ok(Math.abs(initial.height - hostBounds.height) <= 2);

        var windowFocused = await electronApp.evaluate(async function (electron) {
            electron.app.focus({ steal: true });
            var window = electron.BrowserWindow.getAllWindows()[0];
            window.show();
            window.focus();
            var deadline = Date.now() + 1000;
            while (!window.isFocused() && Date.now() < deadline) {
                await new Promise(function (resolve) { setTimeout(resolve, 25); });
            }
            return window.isFocused();
        });
        await page.bringToFront();
        if (windowFocused) {
            var focusCommand = page.locator('[data-action="focus-initiative-app"]');
            await focusCommand.focus();
            await page.keyboard.press('Enter');
            await waitForEmbedded(function (value) { return value.focused; });
            await electronApp.evaluate(function (electron) {
                var child = electron.webContents.getAllWebContents().find(function (contents) {
                    return contents.getURL().startsWith('openspec-initiative-app://');
                });
                child.sendInputEvent({ type: 'keyDown', keyCode: 'F6' });
                child.sendInputEvent({ type: 'keyUp', keyCode: 'F6' });
            });
            await page.waitForFunction(function () {
                return document.activeElement && document.activeElement.getAttribute('data-action') === 'focus-initiative-app';
            });
        } else {
            context.diagnostic('macOS 未授予测试窗口前台焦点，跳过 OS focus/F6 往返检查');
        }

        await electronApp.evaluate(async function (electron) {
            var child = electron.webContents.getAllWebContents().find(function (contents) {
                return contents.getURL().startsWith('openspec-initiative-app://');
            });
            await child.executeJavaScript('document.querySelector("a").click()');
        });
        await waitForEmbedded(function (value) { return value.url === '/details.html?view=design#current'; });
        await page.waitForFunction(function () { return window.location.hash.indexOf('details.html') !== -1; });
        var deepLink = await page.evaluate(function () { return window.location.hash; });
        await page.reload();
        var restored = await waitForEmbedded(function (value) { return value.url === '/details.html?view=design#current'; });
        assert.equal(await page.evaluate(function () { return window.location.hash; }), deepLink);

        await fsPromises.writeFile(path.join(fixture.primaryProject, 'openspec', 'programs', 'delivery-suite', 'dashboard', 'details.html'), '<!doctype html><html><body><h1>专项设计详情已刷新</h1><a href="index.html">返回</a></body></html>\n', 'utf8');
        await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
        var refreshed = await waitForEmbedded(function (value) {
            return value.url === '/details.html?view=design#current' && value.text.indexOf('已刷新') !== -1;
        });
        assert.notEqual(refreshed.webContentsId, restored.webContentsId);
        assert.equal(await page.evaluate(function () { return window.location.hash; }), deepLink);

        await page.setViewportSize({ width: 820, height: 640 });
        hostBounds = await page.locator('.initiative-app-boundary').boundingBox();
        var compact = await waitForEmbedded(function (value) {
            return Math.abs(value.width - hostBounds.width) <= 2 && Math.abs(value.height - hostBounds.height) <= 2;
        });
        assert.ok(Math.abs(compact.width - hostBounds.width) <= 2);
        assert.ok(Math.abs(compact.height - hostBounds.height) <= 2);
        await uiHelpers.assertNoPageOverflow(page, '820x640 embedded Initiative App shell');
        await page.locator('#toolbar-project-button').click();
        await page.waitForSelector('#project-dialog[open]');
        await page.locator('.project-registry-row', { hasText: 'empty-specs' }).locator('[data-project-action="select"]').click();
        await page.waitForSelector('.control-header');
        assert.equal(await readEmbeddedState(), null);
    } finally {
        if (electronApp) { await electronApp.close(); }
        await fixture.cleanup();
    }
});
