'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs/promises');
var path = require('node:path');
var os = require('node:os');
var test = require('node:test');
var WorkbenchService = require('../src/main/workbench-service').WorkbenchService;
var ProjectRegistry = require('../src/main/project-registry').ProjectRegistry;
var fixtures = require('./fixtures');

async function setup(t) {
    var fixture = await fixtures.createFixtureProject();
    t.after(fixture.cleanup);
    var data = await fs.mkdtemp(path.join(os.tmpdir(), 'attachments-data-'));
    t.after(function () { return fs.rm(data, { recursive: true, force: true }); });
    var service = new WorkbenchService(new ProjectRegistry(path.join(data, 'projects.json')), { statusProvider: fixtures.inferredStatusProvider });
    await service.initialize();
    await service.addProjects([fixture.root]);
    return { fixture: fixture, service: service };
}

function scope(loaded, entityType, changeId) {
    return { projectId: loaded.projectId, revision: loaded.revision, entityType: entityType, changeId: changeId };
}

test('工作台快照与普通刷新不访问验收 JSON，展开只读本提案元信息，选中只打开指定文件', async function (t) {
    var { fixture, service } = await setup(t);
    var archive = '2026-01-01-old-change';
    var files = ['add-feature/acceptance/run.json', 'add-feature/acceptance/other.JSON',
        'incomplete-change/other.json', 'archive/' + archive + '/reports/archive.json'];
    for (var file of files) { await fixture.write('openspec/changes/' + file, '{"saved":true}'); }
    await fixture.write('openspec/changes/add-feature/.openspec.json', '{}');
    var accessed = [];
    for (var method of ['lstat', 'stat', 'open', 'realpath', 'readFile']) {
        (function (method, original) {
            t.mock.method(fs, method, function (target) {
                var relative = typeof target === 'string' && target.split('/openspec/changes/')[1];
                if (files.includes(relative)) { accessed.push([method, relative]); }
                return original.apply(fs, arguments);
            });
        }(method, fs[method]));
    }
    var loaded = await service.loadWorkspace(false);
    assert.equal(await service.refreshIfChanged(), false);
    assert.deepEqual(accessed, []);
    assert.doesNotMatch(JSON.stringify(loaded.snapshot), /acceptance\/run\.json|reports\/archive\.json/);
    var active = scope(loaded, 'active', 'add-feature');
    var listing = await service.listAttachments(active);
    assert.deepEqual(listing.files.map(function (f) { return f.path; }), ['acceptance/other.JSON', 'acceptance/run.json']);
    assert.deepEqual(accessed.map(function (entry) { return entry[0]; }), ['lstat', 'lstat']);
    assert.ok(accessed.every(function (entry) { return entry[1].startsWith('add-feature/'); }));
    accessed.length = 0;
    var row = listing.files[1];
    assert.deepEqual(Object.keys(row).sort(), ['id', 'modifiedAt', 'path', 'size']);
    var read = await service.readAttachment({ ...active, id: row.id, offset: 0 });
    assert.equal(read.text, '{"saved":true}');
    assert.ok(accessed.length > 0 && accessed.every(function (entry) { return entry[1] === files[0]; }));
    assert.deepEqual(accessed.filter(function (entry) { return ['open', 'readFile'].includes(entry[0]); }), [['open', files[0]]]);
    var archived = scope(loaded, 'archive', archive);
    var old = await service.listAttachments(archived);
    assert.deepEqual(old.files.map(function (f) { return f.path; }), ['reports/archive.json']);
    await assert.rejects(service.readAttachment({ ...archived, id: row.id, offset: 0 }), /先展开/);
    await assert.rejects(service.listAttachments({ ...active, changeId: '../../other' }), /未登记/);
    await service.loadWorkspace(true);
    await assert.rejects(service.readAttachment({ ...active, id: row.id, offset: 0 }), /切换或刷新/);
});

test('附件分页保留跨片的 UTF-8 字符，文件替换及陈旧清单须重新选择', async function (t) {
    var { fixture, service } = await setup(t);
    var content = '"' + 'x'.repeat(65533) + '🍊' + 'y'.repeat(68000) + '"';
    var file = path.join(fixture.root, 'openspec/changes/add-feature/results/a.json');
    await fixture.write('openspec/changes/add-feature/results/a.json', content);
    var req = scope(await service.loadWorkspace(), 'active', 'add-feature');
    var first = await service.listAttachments(req);
    var params = { ...req, id: first.files[0].id };
    var next = 0;
    var text = '';
    var pages = 0;
    do {
        var chunk = await service.readAttachment({ ...params, offset: next });
        assert.equal(chunk.offset, next);
        assert.equal(chunk.totalBytes, Buffer.byteLength(content));
        assert.ok(Buffer.byteLength(chunk.text) <= 65536);
        assert.equal(chunk.nextOffset - next, Buffer.byteLength(chunk.text));
        text += chunk.text;
        next = chunk.nextOffset;
        pages++;
    } while (!chunk.done);
    assert.equal(pages, 3);
    assert.equal(text, content);
    await assert.rejects(service.readAttachment({ ...params, offset: next + 1 }), /位置无效/);
    var replacement = file + '.tmp';
    await fs.writeFile(replacement, content);
    await fs.rename(replacement, file);
    await assert.rejects(service.readAttachment({ ...params, offset: 0 }), /已变化/);
    var updated = await service.listAttachments(req);
    await assert.rejects(service.readAttachment({ ...params, offset: 0 }), /先展开/);
    var fresh = { ...req, id: updated.files[0].id };
    await fs.rename(path.dirname(file), path.dirname(file) + '-moved');
    await fs.symlink(path.dirname(file) + '-moved', path.dirname(file));
    await assert.rejects(service.readAttachment({ ...fresh, offset: 0 }), /已变化/);
});

test('提案目录仅列普通 JSON 文件，目录链接、文件链接和多链接文件均不会签发读取票据', async function (t) {
    var { fixture, service } = await setup(t);
    var dir = path.join(fixture.root, 'openspec/changes/add-feature');
    var outside = path.join(fixture.root, 'outside.json');
    await fs.writeFile(outside, '{}');
    await fs.link(outside, path.join(dir, 'hard.json'));
    await fs.symlink(outside, path.join(dir, 'linked.json'));
    await fs.symlink(fixture.root, path.join(dir, 'external'));
    var req = scope(await service.loadWorkspace(false), 'active', 'add-feature');
    assert.deepEqual(await service.listAttachments(req), { files: [] });
    await assert.rejects(service.readAttachment({ ...req, id: 'arbitrary.json', offset: 0 }), /先展开/);
});

test('同一提案并发展开共享票据，切换项目后迟到的清单不能交付', async function (t) {
    var { fixture, service } = await setup(t);
    await fixture.write('openspec/changes/add-feature/a.json', '{}');
    var other = await fixtures.createFixtureProject();
    t.after(other.cleanup);
    var initial = service.registry.getActive().id;
    await service.addProjects([other.root]);
    var target = service.registry.getActive().id;
    await service.selectProject(initial);
    var req = scope(await service.loadWorkspace(false), 'active', 'add-feature');
    var module = require('../src/core/change-attachments');
    var original = module.listFiles;
    var release;
    var calls = 0;
    t.mock.method(module, 'listFiles', async function (root, directory) {
        calls += 1;
        await new Promise(function (resolve) { release = resolve; });
        return original(root, directory);
    });
    var first = service.listAttachments(req);
    var second = service.listAttachments(req);
    assert.equal(calls, 1);
    release();
    var [one, two] = await Promise.all([first, second]);
    assert.equal(one.files[0].id, two.files[0].id);
    assert.equal((await service.readAttachment({ ...req, id: two.files[0].id, offset: 0 })).text, '{}');
    var pending = service.listAttachments(req);
    await service.selectProject(target);
    release();
    await assert.rejects(pending, /切换|刷新/);
});
