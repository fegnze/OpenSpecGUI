'use strict';

var fs = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');
var semver = require('semver');
var files = require('./archive-files');
var cliModule = require('./archive-cli');

var PACKAGE = '@fission-ai/openspec';
var LANGUAGE_PATH = 'scripts/openspec/check_language.js';
// 此版本支持 validateAll(root, officialList)，只在临时目录检查提供的工件。
var LANGUAGE_HASH = 'aa70e6af661185d2a06215385764e334ffa06f39cdaf67aafdca599efa8f6956';

async function readOptional(root, relative) {
    var target = await files.assertSafe(root, relative, true);
    try { return (await files.readRegular(target, files.limits.maxFileBytes)).content; }
    catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
}

async function readJson(root, relative) {
    var bytes = await readOptional(root, relative);
    if (!bytes) { return null; }
    try {
        var json = JSON.parse(bytes.toString('utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json)) { throw new Error(); }
        return json;
    } catch (error) { throw files.fail('ARCHIVE_PROJECT_RULES_INVALID', '无法读取项目归档规则中的 ' + relative); }
}

async function versionRules(root, manifest, cli, worldTour) {
    var declared = (manifest.devDependencies || {})[PACKAGE] || (manifest.dependencies || {})[PACKAGE];
    if (!declared && !worldTour) { return null; }
    var lock = await readJson(root, 'npm-shrinkwrap.json') || await readJson(root, 'package-lock.json');
    var resolved = lock && ((lock.packages || {})['node_modules/' + PACKAGE] || (lock.dependencies || {})[PACKAGE]);
    var locked = resolved && resolved.version;
    var installed = cli.packageRoot && (await readJson(cli.packageRoot, 'package.json')).version;
    var range = typeof declared === 'string' ? semver.validRange(declared) : null;
    var matchesDeclaration = range ? semver.satisfies(installed, range) : Boolean(locked);
    if (!matchesDeclaration || (lock && locked !== installed) || (worldTour && (!locked || !semver.valid(declared)))) {
        throw files.fail('ARCHIVE_CLI_VERSION_MISMATCH', 'OpenSpec CLI 与项目声明或锁文件不一致，请安装并使用项目锁定的版本（声明 ' + (declared || '缺失') + '，锁定 ' + (locked || '缺失') + '，当前 ' + (installed || '未知') + '）');
    }
    return [declared || null, locked || null];
}

async function readLanguageInputs(root, manifest, cli, settings) {
    var command = (manifest.scripts || {})['check:openspec-language'];
    var checker = await readOptional(root, LANGUAGE_PATH);
    if (command !== 'node ' + LANGUAGE_PATH || !checker || files.hash(checker) !== LANGUAGE_HASH) {
        throw files.fail('ARCHIVE_PROJECT_GATE_UNSUPPORTED', 'WorldTourCasino 的 OpenSpec 中文检查入口或版本已变化，请在项目中完成归档，或更新工作台的项目适配');
    }
    var listing = await cliModule.run(cli, root, ['list', '--json'], settings);
    cliModule.assertRoot(listing, root);
    if (!Array.isArray(listing.changes)) { throw files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 缺少活动 Change 列表，无法验证项目语言规则'); }
    var ids = listing.changes.map(function (change) {
        if (!change || typeof change.name !== 'string') { throw files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 的活动 Change 列表无效'); }
        files.inputPaths(change.name);
        return change.name;
    }).sort();
    var relativePaths = ids.flatMap(function (id) {
        return ['proposal.md', 'design.md', 'tasks.md', 'specs'].map(function (artifact) { return 'openspec/changes/' + id + '/' + artifact; });
    });
    var tree = await files.readTree(root, relativePaths, settings.limits);
    return { checker: checker, listing: listing, tree: tree, fingerprint: [LANGUAGE_HASH, ids, files.digest(tree), files.identityDigest(tree)] };
}

async function capture(root, cli, settings) {
    var manifest = await readJson(root, 'package.json') || {};
    var worldTour = manifest.name === 'world-tour-casino';
    var local = settings.getArchivePolicy ? await settings.getArchivePolicy(root) : null;
    var requireSyncedSpecs = worldTour || Boolean(local && local.requireSyncedSpecs);
    var versions = await versionRules(root, manifest, cli, worldTour);
    var language = worldTour ? await readLanguageInputs(root, manifest, cli, settings) : null;
    var fingerprint = files.hash(JSON.stringify([worldTour, requireSyncedSpecs, versions, language && language.fingerprint]));
    return { requireSyncedSpecs: requireSyncedSpecs, language: language, fingerprint: fingerprint };
}

async function verifyLanguage(language) {
    if (!language) { return; }
    var temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-gui-language-')));
    var checker = path.join(temporary, 'check-language.cjs');
    try {
        await files.materialize(temporary, language.tree);
        await fs.writeFile(checker, language.checker, { flag: 'wx', mode: 384 });
        var result = require(checker).validateAll(temporary, language.listing);
        if (result.errors.length) {
            throw files.fail('ARCHIVE_PROJECT_LANGUAGE_FAILED', '项目 OpenSpec 中文检查未通过：\n' + result.errors.join('\n').slice(0, 5000));
        }
    } finally {
        delete require.cache[checker];
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

module.exports = { capture: capture, verifyLanguage: verifyLanguage };
