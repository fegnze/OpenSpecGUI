'use strict';

var childProcess = require('node:child_process');
var fs = require('node:fs/promises');
var path = require('node:path');
var files = require('./archive-files');
var resolveCommands = require('./openspec-cli').resolveCommands;

async function executable(command) {
    var candidates = path.isAbsolute(command) || command.includes(path.sep) ? [path.resolve(command)] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(function (directory) { return path.join(directory, command); });
    for (var candidate of candidates) {
        try { await fs.access(candidate, 1); return await fs.realpath(candidate); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') { throw error; } }
    }
    return null;
}

async function identity(cli) {
    var parts = [];
    for (var target of cli.identityFiles) {
        parts.push(target + '\0' + files.hash(await fs.readFile(target)));
    }
    if (cli.packageRoot) {
        var tree = await files.readTree(cli.packageRoot, ['bin', 'dist', 'schemas', 'package.json'], { maxBytes: 64 * 1024 * 1024 });
        parts.push(files.digest(tree));
    }
    // User schema overrides participate in CLI rule resolution as well.
    if (cli.userDataRoot) {
        parts.push(files.digest(await files.readTree(cli.userDataRoot, ['schemas'])));
    }
    return files.hash(parts.join('\n'));
}

async function resolve(projectRoot, options) {
    for (var command of resolveCommands(projectRoot, options)) {
        var entry = await executable(command);
        if (!entry) { continue; }
        var cli = { command: entry, args: [], identityFiles: [entry], packageRoot: null };
        var header = (await fs.readFile(entry)).subarray(0, 200).toString();
        if (/^#![^\n]*\bnode\b/.test(header) || /\.[cm]?js$/i.test(entry)) {
            // Finder-launched apps often have no Node on PATH. Electron also
            // provides a Node runtime; use it only in its explicit Node mode.
            var runtime = await executable('node') || process.execPath;
            cli.command = runtime;
            cli.args = [entry];
            cli.electronRuntime = Boolean(process.versions.electron && runtime === process.execPath);
            cli.identityFiles.push(runtime);
            var directory = path.dirname(entry);
            for (var index = 0; index < 4; index += 1) {
                try {
                    var metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
                    if (metadata.name === '@fission-ai/openspec') { cli.packageRoot = directory; break; }
                } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
                directory = path.dirname(directory);
            }
        }
        var userHome = require('node:os').homedir();
        var dataHome = process.env.XDG_DATA_HOME || (process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local') : path.join(userHome, '.local', 'share'));
        var userDataRoot = path.join(dataHome, 'openspec');
        try { cli.userDataRoot = await fs.realpath(userDataRoot); } catch (error) { if (error.code !== 'ENOENT') { throw error; } cli.userDataRoot = null; }
        cli.fingerprint = await identity(cli);
        return cli;
    }
    throw files.fail('ARCHIVE_CLI_UNAVAILABLE', '未找到兼容的 OpenSpec CLI，仍可浏览项目。请安装或更新本地 CLI 后重试。');
}

function run(cli, cwd, args, options) {
    var settings = options || {};
    return new Promise(function (resolveResult, reject) {
        var output = [];
        var errors = [];
        var bytes = 0;
        var errorBytes = 0;
        var settled = false;
        var environment = Object.assign({}, process.env, { OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', CI: '1', NO_COLOR: '1' });
        if (cli.electronRuntime) { environment.ELECTRON_RUN_AS_NODE = '1'; }
        var child = childProcess.spawn(cli.command, cli.args.concat(args), { cwd: cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
        var timer = setTimeout(function () { finish(files.fail('ARCHIVE_CLI_TIMEOUT', '归档检查超时，请重试或通过外部工具处理')); child.kill('SIGKILL'); }, settings.timeoutMs || 30000);
        function finish(error, value) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (error) { reject(error); } else { resolveResult(value); }
        }
        child.stdout.on('data', function (chunk) {
            bytes += chunk.length;
            if (bytes > (settings.maxOutputBytes || 4 * 1024 * 1024)) { finish(files.fail('ARCHIVE_LIMIT', 'CLI 输出超过限制，无法生成完整预览')); child.kill('SIGKILL'); }
            else { output.push(chunk); }
        });
        child.stderr.on('data', function (chunk) { errorBytes += chunk.length; if (errorBytes <= 65536) { errors.push(chunk); } });
        child.on('error', function (error) { finish(files.fail('ARCHIVE_CLI_UNAVAILABLE', '无法运行 OpenSpec CLI：' + error.message)); });
        child.on('close', function (code) {
            var value;
            try { value = JSON.parse(Buffer.concat(output).toString('utf8')); }
            catch (error) { finish(files.fail('ARCHIVE_CLI_INCOMPATIBLE', 'CLI 未返回受支持的 JSON 结果，请更新 CLI。' + Buffer.concat(errors).toString('utf8').slice(0, 500))); return; }
            if (code !== 0 || value.archive === null) {
                var diagnostics = value.status || value.issues || value.items || value;
                finish(files.fail('ARCHIVE_VALIDATION_FAILED', '归档检查未通过：' + JSON.stringify(diagnostics).slice(0, 5000))); return;
            }
            finish(null, value);
        });
    });
}

function assertRoot(value, root) {
    if (!value || !value.root || typeof value.root.path !== 'string' || path.resolve(value.root.path) !== root) {
        throw files.fail('ARCHIVE_ROOT_MISMATCH', 'CLI 解析的根目录与当前项目不一致，此项目暂不支持界面归档');
    }
}

module.exports = { resolve: resolve, identity: identity, run: run, assertRoot: assertRoot };
