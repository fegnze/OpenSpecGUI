'use strict';

var path = require('node:path');
var defineConfig = require('@playwright/test').defineConfig;

module.exports = defineConfig({
    testDir: './test',
    testMatch: 'visual.spec.js',
    timeout: 60000,
    fullyParallel: false,
    workers: 1,
    reporter: [['line']],
    outputDir: 'artifacts/visual-results',
    snapshotPathTemplate: path.join('{testDir}', 'visual-baselines', '{arg}{ext}'),
    expect: {
        toHaveScreenshot: {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixelRatio: 0.001,
            scale: 'css'
        }
    }
});
