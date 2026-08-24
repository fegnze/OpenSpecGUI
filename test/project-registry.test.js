'use strict';

var assert = require('node:assert/strict');
var fsPromises = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var test = require('node:test');
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;

async function createProject(root, relativePath, metadata) {
    var projectRoot = path.join(root, relativePath);
    await fsPromises.mkdir(path.join(projectRoot, 'openspec', 'specs'), { recursive: true });
    await fsPromises.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify(typeof metadata === 'string' ? { name: metadata } : metadata), 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    return projectRoot;
}

test('注册表持久化、真实路径去重且移除不删除项目', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-registry-'));
    var projectRoot = await createProject(root, 'Project-A_original', {
        name: 'package-project-a',
        productName: 'Product Project A',
        displayName: 'Display Project A'
    });
    var registryPath = path.join(root, 'user-data', 'projects.json');
    var registry = new ProjectRegistry(registryPath);
    try {
        await registry.load();
        var first = await registry.addPath(projectRoot);
        var second = await registry.addPath(path.join(projectRoot, '.'));
        assert.equal(first.id, second.id);
        assert.equal(first.name, 'Project-A_original');
        assert.equal((await registry.list()).projects.length, 1);

        var restored = new ProjectRegistry(registryPath);
        await restored.load();
        assert.equal(restored.getActive().id, first.id);

        await restored.remove(first.id);
        assert.equal((await restored.list()).projects.length, 0);
        await fsPromises.access(path.join(projectRoot, 'openspec', 'config.yaml'));
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});

test('加载历史注册记录时使用项目目录原名', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-legacy-name-'));
    var projectRoot = await createProject(root, 'world-tour-casino', { productName: 'World Tour Casino' });
    var registryPath = path.join(root, 'user-data', 'projects.json');
    try {
        var realProjectRoot = await fsPromises.realpath(projectRoot);
        var realOpenSpecPath = await fsPromises.realpath(path.join(projectRoot, 'openspec'));
        await fsPromises.mkdir(path.dirname(registryPath), { recursive: true });
        await fsPromises.writeFile(registryPath, JSON.stringify({
            version: 1,
            activeProjectId: 'legacy-project',
            projects: [{
                id: 'legacy-project',
                name: 'World Tour Casino',
                rootPath: realProjectRoot,
                openspecPath: realOpenSpecPath,
                addedAt: '2026-01-01T00:00:00.000Z',
                lastOpenedAt: '2026-01-01T00:00:00.000Z'
            }]
        }), 'utf8');

        var registry = new ProjectRegistry(registryPath);
        await registry.load();
        assert.equal(registry.getActive().name, 'world-tour-casino');
        assert.equal((await registry.list()).projects[0].name, 'world-tour-casino');
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});

test('扫描限制深度并跳过高成本目录和符号链接', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-scan-'));
    var registry = new ProjectRegistry(path.join(root, 'user-data', 'projects.json'), { maxDepth: 4 });
    try {
        await createProject(root, 'team/Project-A', 'package-project-a');
        await createProject(root, 'node_modules/ignored', 'ignored');
        await createProject(root, 'a/b/c/d/e/too-deep', 'too-deep');
        await fsPromises.symlink(path.join(root, 'team'), path.join(root, 'linked-team'));
        await registry.load();
        var candidates = await registry.scan(root);
        assert.deepEqual(candidates.map(function (candidate) { return candidate.name; }), ['Project-A']);
        assert.equal((await registry.list()).projects.length, 0);
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});

test('失效项目可重新关联并保留项目身份', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-relink-'));
    var fallbackRoot = await createProject(root, 'fallback', 'fallback-project');
    var oldRoot = await createProject(root, 'old-location', 'moving-project');
    var newRoot = path.join(root, 'new-location');
    var registry = new ProjectRegistry(path.join(root, 'user-data', 'projects.json'));
    try {
        await registry.load();
        var fallbackProject = await registry.addPath(fallbackRoot);
        var project = await registry.addPath(oldRoot);
        await fsPromises.rename(oldRoot, newRoot);
        assert.equal((await registry.list()).projects.find(function (item) { return item.id === project.id; }).valid, false);

        var restored = new ProjectRegistry(path.join(root, 'user-data', 'projects.json'));
        await restored.load();
        assert.equal(restored.getActive().id, fallbackProject.id);

        var relinked = await restored.relink(project.id, newRoot);
        assert.equal(relinked.id, project.id);
        assert.equal(relinked.name, 'new-location');
        assert.equal((await restored.list()).projects.find(function (item) { return item.id === project.id; }).valid, true);
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});

test('主注册表损坏时恢复最近完整备份', async function () {
    var root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-backup-'));
    var firstRoot = await createProject(root, 'first', 'first');
    var secondRoot = await createProject(root, 'second', 'second');
    var registryPath = path.join(root, 'user-data', 'projects.json');
    var registry = new ProjectRegistry(registryPath);
    try {
        await registry.load();
        await registry.addPath(firstRoot);
        await registry.addPath(secondRoot);
        await fsPromises.writeFile(registryPath, '{broken', 'utf8');

        var recovered = new ProjectRegistry(registryPath);
        await recovered.load();
        var result = await recovered.list();
        assert.match(result.diagnostic, /已恢复/);
        assert.equal(result.projects.length, 1);
        await recovered.save();
        assert.doesNotThrow(function () { JSON.parse(require('node:fs').readFileSync(registryPath, 'utf8')); });
    } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
    }
});
