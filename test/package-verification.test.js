'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var asar = require('@electron/asar');
var verifier = require('../scripts/verify-package');

async function createFixturePackage() {
    var projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-package-source-'));
    var outputRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-package-output-'));
    var appPath = path.join(outputRoot, 'OpenSpec GUI-darwin-arm64', 'OpenSpec GUI.app');
    var asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');

    await fsPromises.mkdir(path.join(projectRoot, 'src', 'main'), { recursive: true });
    await fsPromises.mkdir(path.join(projectRoot, 'src', 'renderer'), { recursive: true });
    await fsPromises.writeFile(path.join(projectRoot, 'src', 'main', 'index.js'), 'module.exports = "main";\n');
    await fsPromises.writeFile(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'module.exports = "renderer";\n');
    await fsPromises.writeFile(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'body { color: #000; }\n');
    await fsPromises.mkdir(path.dirname(asarPath), { recursive: true });
    await asar.createPackage(projectRoot, asarPath);

    return {
        projectRoot: projectRoot,
        outputRoot: outputRoot,
        asarPath: asarPath,
        cleanup: async function () {
            await fsPromises.rm(projectRoot, { recursive: true, force: true });
            await fsPromises.rm(outputRoot, { recursive: true, force: true });
        }
    };
}

test('验证脚本接受与当前工作区一致的架构包', async function () {
    var fixture = await createFixturePackage();
    try {
        var result = verifier.verifyPackage({ arch: 'arm64', projectRoot: fixture.projectRoot, outputRoot: fixture.outputRoot });
        assert.equal(result.arch, 'arm64');
        assert.equal(result.sourceFileCount, 3);
        assert.match(result.sourceDigest, /^[a-f0-9]{64}$/);
    } finally {
        await fixture.cleanup();
    }
});

test('验证脚本拒绝与当前工作区不一致的旧包', async function () {
    var fixture = await createFixturePackage();
    try {
        await fsPromises.writeFile(path.join(fixture.projectRoot, 'src', 'renderer', 'app.js'), 'module.exports = "updated";\n');
        assert.throws(function () {
            verifier.verifyPackage({ arch: 'arm64', projectRoot: fixture.projectRoot, outputRoot: fixture.outputRoot });
        }, { code: 'SOURCE_MISMATCH' });
    } finally {
        await fixture.cleanup();
    }
});

test('验证脚本拒绝缺失的应用包', async function () {
    var fixture = await createFixturePackage();
    try {
        await fsPromises.rm(path.dirname(path.dirname(path.dirname(fixture.asarPath))), { recursive: true, force: true });
        assert.throws(function () {
            verifier.verifyPackage({ arch: 'arm64', projectRoot: fixture.projectRoot, outputRoot: fixture.outputRoot });
        }, { code: 'APP_MISSING' });
    } finally {
        await fixture.cleanup();
    }
});

test('验证脚本拒绝错误或不支持的目标架构', async function () {
    var fixture = await createFixturePackage();
    try {
        assert.throws(function () {
            verifier.verifyPackage({ arch: 'x64', projectRoot: fixture.projectRoot, outputRoot: fixture.outputRoot });
        }, { code: 'APP_MISSING' });
        assert.throws(function () {
            verifier.verifyPackage({ arch: 'universal', projectRoot: fixture.projectRoot, outputRoot: fixture.outputRoot });
        }, { code: 'ARCH_UNSUPPORTED' });
    } finally {
        await fixture.cleanup();
    }
});

test('验证脚本要求明确的架构参数', function () {
    assert.throws(function () {
        verifier.verifyPackage(verifier.parseArguments([]));
    }, { code: 'ARCH_UNSUPPORTED' });
    assert.deepEqual(verifier.parseArguments(['--arch', 'arm64']), { arch: 'arm64' });
});
