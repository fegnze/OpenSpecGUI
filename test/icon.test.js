'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var zlib = require('node:zlib');
var forgeConfig = require('../forge.config');

var projectRoot = path.resolve(__dirname, '..');

function paethPredictor(left, above, upperLeft) {
    var estimate = left + above - upperLeft;
    var leftDistance = Math.abs(estimate - left);
    var aboveDistance = Math.abs(estimate - above);
    var upperLeftDistance = Math.abs(estimate - upperLeft);

    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
        return left;
    }
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function readRgbaPngAlpha(png, x, y) {
    var offset = 8;
    var idat = [];
    var width = png.readUInt32BE(16);
    var height = png.readUInt32BE(20);
    var stride = width * 4;
    var rows = Buffer.alloc(stride * height);

    assert.equal(png[24], 8);
    assert.equal(png[25], 6);
    assert.equal(png[28], 0);

    while (offset < png.length) {
        var length = png.readUInt32BE(offset);
        var type = png.subarray(offset + 4, offset + 8).toString('ascii');
        if (type === 'IDAT') {
            idat.push(png.subarray(offset + 8, offset + 8 + length));
        }
        offset += length + 12;
    }

    var encoded = zlib.inflateSync(Buffer.concat(idat));
    for (var rowIndex = 0; rowIndex < height; rowIndex += 1) {
        var filter = encoded[rowIndex * (stride + 1)];
        var encodedRow = rowIndex * (stride + 1) + 1;
        var decodedRow = rowIndex * stride;
        for (var column = 0; column < stride; column += 1) {
            var raw = encoded[encodedRow + column];
            var left = column >= 4 ? rows[decodedRow + column - 4] : 0;
            var above = rowIndex > 0 ? rows[decodedRow + column - stride] : 0;
            var upperLeft = rowIndex > 0 && column >= 4 ? rows[decodedRow + column - stride - 4] : 0;
            var value = raw;

            if (filter === 1) {
                value += left;
            } else if (filter === 2) {
                value += above;
            } else if (filter === 3) {
                value += Math.floor((left + above) / 2);
            } else if (filter === 4) {
                value += paethPredictor(left, above, upperLeft);
            } else {
                assert.equal(filter, 0);
            }
            rows[decodedRow + column] = value & 255;
        }
    }

    return rows[y * stride + x * 4 + 3];
}

test('专属应用图标母版、生成资产与打包配置保持一致', async function () {
    var source = await fsPromises.readFile(path.join(projectRoot, 'src', 'renderer', 'assets', 'app-icon-source.jpeg'));
    var productMark = await fsPromises.readFile(path.join(projectRoot, 'src', 'renderer', 'assets', 'product-mark.png'));
    var png = await fsPromises.readFile(path.join(projectRoot, 'assets', 'app-icon.png'));
    var icns = await fsPromises.readFile(path.join(projectRoot, 'assets', 'app-icon.icns'));
    var html = await fsPromises.readFile(path.join(projectRoot, 'src', 'renderer', 'index.html'), 'utf8');
    var main = await fsPromises.readFile(path.join(projectRoot, 'src', 'main', 'index.js'), 'utf8');

    assert.deepEqual(Array.from(source.subarray(0, 3)), [255, 216, 255]);
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '2f3b43fdddb305905ff2760ea0101fafefb705848857f369485d7156040559cf');
    assert.equal(crypto.createHash('sha256').update(productMark).digest('hex'), '5c49c033817da45855088ee699d38411cbef711b0bd85209fe3fd53a20baceb8');
    assert.deepEqual(Array.from(productMark.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(productMark.readUInt32BE(16), 512);
    assert.equal(productMark.readUInt32BE(20), 512);
    assert.equal(productMark[25], 6);
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    assert.equal(png[25], 6);
    assert.equal(readRgbaPngAlpha(png, 0, 0), 0);
    assert.equal(readRgbaPngAlpha(png, 1023, 0), 0);
    assert.equal(readRgbaPngAlpha(png, 0, 1023), 0);
    assert.equal(readRgbaPngAlpha(png, 1023, 1023), 0);
    assert.equal(readRgbaPngAlpha(png, 512, 512), 255);
    assert.equal(readRgbaPngAlpha(png, 512, 37), 255);
    assert.equal(readRgbaPngAlpha(png, 39, 512), 255);
    assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
    assert.equal(forgeConfig.packagerConfig.icon, path.join(projectRoot, 'assets', 'app-icon.icns'));
    assert.match(html, /<img src="assets\/product-mark\.png" alt="">/);
    assert.doesNotMatch(html, /assets\/app-icon\.png/);
    assert.match(main, /app\.dock\.setIcon\(appIconPath\)/);
});
