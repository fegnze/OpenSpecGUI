'use strict';

var path = require('node:path');
var playwright = require('@playwright/test');
var uiFixture = require('./ui-fixture');
var uiHelpers = require('./ui-test-helpers');

var expect = playwright.expect;
var test = playwright.test;
var screenshotStyle = path.join(__dirname, 'visual-test.css');
var fixture;
var electronApp;
var page;

async function screenshot(name, options) {
    await expect(page).toHaveScreenshot(name, Object.assign({
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        stylePath: screenshotStyle
    }, options || {}));
}

test.beforeEach(async function () {
    fixture = await uiFixture.createUiFixture();
    var launched = await uiHelpers.launchWorkbench(fixture, { theme: 'light', userDataName: 'visual-user-data' });
    electronApp = launched.electronApp;
    page = launched.page;
    await uiHelpers.addFixtureProjects(page, fixture);
});

test.afterEach(async function () {
    if (electronApp) {
        await electronApp.close();
    }
    electronApp = null;
    if (fixture) {
        await fixture.cleanup();
    }
    fixture = null;
});

test('关键工作台界面视觉基线', async function () {
    await page.setViewportSize({ width: 1440, height: 930 });
    await page.waitForSelector('.control-header');
    await screenshot('overview-wide-light.png');

    await uiHelpers.setTheme(page, 'dark');
    await screenshot('overview-wide-dark.png');
    await uiHelpers.setTheme(page, 'light');

    await page.locator('.primary-nav [data-route="initiatives"]').click();
    await page.waitForSelector('.initiative-list');
    await screenshot('initiative-list-wide-light.png');
    await page.locator('.initiative-row[data-provider-id="openspec-generic-initiative-v1"]').click();
    await page.waitForSelector('.initiative-detail-grid');
    await page.waitForSelector('[data-initiative-artifact="release-summary"]');
    await uiHelpers.setTheme(page, 'dark');
    await screenshot('initiative-detail-wide-dark.png');
    await uiHelpers.setTheme(page, 'light');
    await page.setViewportSize({ width: 820, height: 640 });
    await screenshot('initiative-detail-minimum-light.png');
    await page.setViewportSize({ width: 1440, height: 930 });
    await page.locator('.primary-nav [data-route="overview"]').click();
    await page.waitForSelector('.control-header');

    await page.locator('#project-picker-button').click();
    await page.waitForSelector('#project-options:not([hidden])');
    await screenshot('project-picker-open-light.png');
    await page.keyboard.press('Escape');

    await page.locator('.metric-block[data-status-filter="ready-to-archive"]').click();
    await page.waitForSelector('.control-table-row[data-entity-id="archive-ready-theme"]');
    await screenshot('overview-ready-filtered-wide-light.png');
    await page.locator('.status-segments [data-status-filter="all"]').click();
    await page.waitForSelector('.execution-lanes');

    await page.locator('.proposal-lane-card[data-entity-id="modern-console"]').click();
    await page.waitForSelector('.task-execution');
    await screenshot('change-detail-wide-light.png');

    await page.setViewportSize({ width: 1180, height: 760 });
    await screenshot('change-detail-compact-light.png');

    await page.setViewportSize({ width: 820, height: 640 });
    await screenshot('change-detail-minimum-light.png');

    await page.locator('.back-button[data-route="overview"]').click();
    await screenshot('overview-minimum-light.png');

    await page.setViewportSize({ width: 1440, height: 930 });
    await page.locator('.primary-nav [data-route="archives"]').click();
    await page.waitForSelector('.document-row-shell');
    await screenshot('archives-wide-light.png');

    await page.locator('.primary-nav [data-route="overview"]').click();
    await page.locator('.proposal-lane-card[data-entity-id="modern-console"]').click();
    await page.locator('[data-panel="documents"]').click();
    await page.waitForSelector('.markdown-body');
    await uiHelpers.setTheme(page, 'dark');
    await screenshot('document-wide-dark.png');

    await uiHelpers.setTheme(page, 'light');
    await page.locator('#project-manage-button').click();
    await page.waitForSelector('#project-dialog[open]');
    await screenshot('project-manager-light.png', {
        mask: [page.locator('.project-registry-copy small')],
        maskColor: '#6b7280'
    });
});
