'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var electron = require('playwright-core')._electron;

var repositoryRoot = path.resolve(__dirname, '..');
var axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function launchWorkbench(fixture, options) {
    var settings = options || {};
    var userData = path.join(fixture.root, settings.userDataName || 'user-data');
    var electronExecutable = process.env.OPENSPEC_GUI_EXECUTABLE || require('electron');
    var applicationArguments = process.env.OPENSPEC_GUI_EXECUTABLE ? [] : [repositoryRoot];
    var environment = Object.assign({}, process.env, {
        OPENSPEC_GUI_USER_DATA: userData,
        OPENSPEC_GUI_CLI: path.join(fixture.root, 'missing-openspec'),
        OPENSPEC_GUI_TEST_NOW: fixture.fixedNow,
        PATH: '/usr/bin:/bin',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    });
    var electronApp = await electron.launch({
        executablePath: electronExecutable,
        args: applicationArguments,
        env: environment
    });
    var page = await electronApp.firstWindow();
    await page.evaluate(function (theme) {
        localStorage.setItem('openspec-workbench-theme', theme);
    }, settings.theme || 'light');
    await page.reload();
    await page.waitForSelector('.onboarding-state');
    return {
        electronApp: electronApp,
        page: page,
        electronExecutable: electronExecutable,
        applicationArguments: applicationArguments,
        environment: environment
    };
}

async function addFixtureProjects(page, fixture) {
    await page.evaluate(function (paths) {
        return window.openSpecGUI.projects.add({ paths: paths });
    }, [fixture.secondaryProject, fixture.primaryProject]);
    await page.reload();
    await page.waitForSelector('.control-header');
}

async function setTheme(page, theme) {
    await page.locator('#theme-select').selectOption(theme);
    await page.waitForFunction(function (expected) {
        return document.documentElement.getAttribute('data-resolved-theme') === expected;
    }, theme);
}

async function assertNoSeriousA11yViolations(page, context) {
    await page.evaluate(axeSource);
    var results = await page.evaluate(async function () {
        return window.axe.run(document, {
            resultTypes: ['violations'],
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
        });
    });
    var violations = results.violations.filter(function (violation) {
        return violation.impact === 'serious' || violation.impact === 'critical';
    });
    assert.equal(violations.length, 0, context + ' 存在严重可访问性问题：\n' + violations.map(function (violation) {
        return violation.id + ' (' + violation.impact + '): ' + violation.help + '\n' + violation.nodes.map(function (node) {
            return '  ' + node.target.join(' ') + ': ' + node.failureSummary;
        }).join('\n');
    }).join('\n'));
}

async function assertNoPageOverflow(page, context) {
    var metrics = await page.evaluate(function () {
        return {
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            bodyWidth: document.body.scrollWidth
        };
    });
    assert.ok(metrics.documentWidth <= metrics.viewportWidth && metrics.bodyWidth <= metrics.viewportWidth,
        context + ' 出现页面级横向滚动：' + JSON.stringify(metrics));
}

async function assertTextFits(page, selectors, context) {
    var failures = await page.evaluate(function (requestedSelectors) {
        var entries = [];
        requestedSelectors.forEach(function (selector) {
            document.querySelectorAll(selector).forEach(function (element) {
                var style = getComputedStyle(element);
                var clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
                var clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
                var lineClamp = style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '';
                var clipped = (clipsX && element.scrollWidth > element.clientWidth + 1) ||
                    ((clipsY || lineClamp) && element.scrollHeight > element.clientHeight + 1);
                if (clipped) {
                    entries.push({ selector: selector, text: (element.textContent || '').trim().slice(0, 100) });
                }
            });
        });
        return entries;
    }, selectors);
    assert.deepEqual(failures, [], context + ' 存在关键文本截断：' + JSON.stringify(failures));
}

async function assertStableControlSizes(page, selectors, context) {
    var failures = await page.evaluate(function (requestedSelectors) {
        var entries = [];
        requestedSelectors.forEach(function (selector) {
            document.querySelectorAll(selector).forEach(function (element) {
                if (element.getClientRects().length === 0) { return; }
                var rect = element.getBoundingClientRect();
                if (rect.width < 26 || rect.height < 26) {
                    entries.push({ selector: selector, width: rect.width, height: rect.height });
                }
            });
        });
        return entries;
    }, selectors);
    assert.deepEqual(failures, [], context + ' 存在不稳定或过小控件：' + JSON.stringify(failures));
}

async function assertReachable(page, selectors, context) {
    var failures = [];
    for (var index = 0; index < selectors.length; index += 1) {
        var selector = selectors[index];
        var locator = page.locator(selector).first();
        if (await locator.count() === 0 || !await locator.isVisible() || !await locator.isEnabled()) {
            failures.push(selector);
        }
    }
    assert.deepEqual(failures, [], context + ' 存在不可达主要操作：' + failures.join(', '));
}

async function assertNoControlOverlap(page, context) {
    var failures = await page.evaluate(function () {
        var controls = Array.from(document.querySelectorAll('button, input, select, summary, a[href]')).filter(function (element) {
            var rect = element.getBoundingClientRect();
            return element.getClientRects().length && rect.width > 0 && rect.height > 0;
        });
        var overlaps = [];
        controls.forEach(function (left, leftIndex) {
            var leftRect = left.getBoundingClientRect();
            controls.slice(leftIndex + 1).forEach(function (right) {
                if (left.contains(right) || right.contains(left)) { return; }
                var rightRect = right.getBoundingClientRect();
                var overlapWidth = Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left);
                var overlapHeight = Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top);
                if (overlapWidth > 2 && overlapHeight > 2) {
                    overlaps.push({
                        left: left.id || left.getAttribute('aria-label') || left.textContent.trim().slice(0, 32),
                        right: right.id || right.getAttribute('aria-label') || right.textContent.trim().slice(0, 32)
                    });
                }
            });
        });
        return overlaps;
    });
    assert.deepEqual(failures, [], context + ' 存在控件重叠：' + JSON.stringify(failures));
}

module.exports = {
    addFixtureProjects: addFixtureProjects,
    assertNoPageOverflow: assertNoPageOverflow,
    assertNoControlOverlap: assertNoControlOverlap,
    assertNoSeriousA11yViolations: assertNoSeriousA11yViolations,
    assertReachable: assertReachable,
    assertStableControlSizes: assertStableControlSizes,
    assertTextFits: assertTextFits,
    launchWorkbench: launchWorkbench,
    repositoryRoot: repositoryRoot,
    setTheme: setTheme
};
