'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var progress = require('../src/renderer/progress');

test('分段进度保留末段的精确部分填充', function () {
    assert.deepEqual(progress.segmentFillPercents(0, 10), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(progress.segmentFillPercents(83, 10), [100, 100, 100, 100, 100, 100, 100, 100, 30, 0]);
    assert.deepEqual(progress.segmentFillPercents(91, 10), [100, 100, 100, 100, 100, 100, 100, 100, 100, 10]);
    assert.deepEqual(progress.segmentFillPercents(100, 10), [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
});
