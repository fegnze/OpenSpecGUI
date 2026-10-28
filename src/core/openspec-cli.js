'use strict';

var childProcess = require('node:child_process');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var DEFAULT_TIMEOUT_MS = 5000;
var MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function addCommand(commands, value) {
    if (typeof value === 'string' && value.trim() && commands.indexOf(value.trim()) === -1) {
        commands.push(value.trim());
    }
}

function resolveCommands(projectRoot, options) {
    var settings = options || {};
    var commands = [];
    var localCommand = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec');

    if (fs.existsSync(localCommand)) {
        addCommand(commands, localCommand);
    }
    addCommand(commands, settings.command);
    addCommand(commands, process.env.OPENSPEC_GUI_CLI);
    if (settings.bundledCommand && fs.existsSync(settings.bundledCommand)) {
        addCommand(commands, settings.bundledCommand);
    }
    addCommand(commands, process.platform === 'win32' ? 'openspec.cmd' : 'openspec');
    if (process.platform !== 'win32') {
        // Finder does not inherit the PATH configured by a user's shell.
        var home = os.homedir();
        if (process.env.NVM_BIN && fs.existsSync(path.join(process.env.NVM_BIN, 'openspec'))) {
            addCommand(commands, path.join(process.env.NVM_BIN, 'openspec'));
        }
        var versions = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
        try {
            fs.readdirSync(versions).filter(function (name) { return /^v\d+\.\d+\.\d+$/.test(name); })
                .sort(function (left, right) { return right.localeCompare(left, 'en', { numeric: true }); })
                .forEach(function (version) {
                    var command = path.join(versions, version, 'bin', 'openspec');
                    if (fs.existsSync(command)) { addCommand(commands, command); }
                });
        } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) { throw error; } }
        [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'),
            path.join(process.env.VOLTA_HOME || path.join(home, '.volta'), 'bin'),
            '/opt/homebrew/bin', '/usr/local/bin'].forEach(function (directory) {
            var command = path.join(directory, 'openspec');
            if (fs.existsSync(command)) { addCommand(commands, command); }
        });
    }
    return commands;
}

async function executable(command) {
    var candidates = path.isAbsolute(command) || command.includes(path.sep) ? [path.resolve(command)] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(function (directory) { return path.join(directory, command); });
    for (var candidate of candidates) {
        try { await fs.promises.access(candidate, fs.constants.X_OK); return await fs.promises.realpath(candidate); }
        catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) { throw error; } }
    }
    return null;
}

async function resolveInvocation(command) {
    var entry = await executable(command);
    if (!entry) { return null; }
    var cli = { entry: entry, command: entry, args: [], identityFiles: [entry] };
    var handle = await fs.promises.open(entry, 'r');
    var header = Buffer.alloc(200);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    if (/^#![^\n]*\bnode\b/.test(header.toString()) || /\.[cm]?js$/i.test(entry)) {
        // Prefer the Node installed with a version-managed CLI. Electron's
        // explicit Node mode also works when no standalone runtime is present.
        var sibling = path.isAbsolute(command) ? await executable(path.join(path.dirname(command), 'node')) : null;
        var runtime = sibling || await executable('node') || process.execPath;
        cli.command = runtime;
        cli.args = [entry];
        cli.electronRuntime = Boolean(process.versions.electron && runtime === process.execPath);
        cli.identityFiles.push(runtime);
    }
    return cli;
}

function parseOutput(output) {
    var parsed = JSON.parse(output);
    var items = new Map();
    if (!parsed || !Array.isArray(parsed.changes)) {
        throw new Error('结构化输出缺少 changes 数组');
    }
    parsed.changes.forEach(function (item) {
        if (item && typeof item.name === 'string') {
            items.set(item.name, item);
        }
    });
    return items;
}

async function runCommand(command, projectRoot, settings) {
    var cli;
    try { cli = await resolveInvocation(command); }
    catch (error) { return { ok: false, missing: false, diagnostic: error.message }; }
    if (!cli) { return { ok: false, missing: true, diagnostic: '未找到 OpenSpec CLI：' + command }; }
    return new Promise(function (resolve) {
        var output = '';
        var errorOutput = '';
        var settled = false;
        var child;
        var timer;

        function finish(result) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(result);
        }

        try {
            var environment = Object.assign({}, process.env);
            if (cli.electronRuntime) { environment.ELECTRON_RUN_AS_NODE = '1'; }
            child = childProcess.spawn(cli.command, cli.args.concat(['list', '--json']), {
                cwd: projectRoot,
                env: environment,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            finish({ ok: false, missing: error.code === 'ENOENT', diagnostic: error.message });
            return;
        }

        timer = setTimeout(function () {
            child.kill('SIGKILL');
            finish({ ok: false, missing: false, diagnostic: 'OpenSpec CLI 响应超时' });
        }, settings.timeoutMs || DEFAULT_TIMEOUT_MS);

        child.stdout.on('data', function (chunk) {
            output += chunk.toString('utf8');
            if (Buffer.byteLength(output) > (settings.maxOutputBytes || MAX_OUTPUT_BYTES)) {
                child.kill('SIGKILL');
                finish({ ok: false, missing: false, diagnostic: 'OpenSpec CLI 输出超过限制' });
            }
        });
        child.stderr.on('data', function (chunk) {
            errorOutput += chunk.toString('utf8');
            if (Buffer.byteLength(errorOutput) > MAX_OUTPUT_BYTES) {
                errorOutput = errorOutput.slice(0, MAX_OUTPUT_BYTES);
            }
        });
        child.on('error', function (error) {
            finish({ ok: false, missing: error.code === 'ENOENT', diagnostic: error.message });
        });
        child.on('close', function (code) {
            if (settled) {
                return;
            }
            if (code !== 0) {
                finish({
                    ok: false,
                    missing: false,
                    diagnostic: (errorOutput.trim() || ('OpenSpec CLI 退出码：' + code)).slice(0, 600)
                });
                return;
            }
            try {
                finish({ ok: true, items: parseOutput(output), command: command });
            } catch (error) {
                finish({ ok: false, missing: false, diagnostic: '无法解析 OpenSpec CLI 输出：' + error.message });
            }
        });
    });
}

/**
 * 读取官方 OpenSpec 活跃提案状态，不通过 shell 执行命令。
 * @param {string} projectRoot 项目根目录
 * @param {object} [options] 调用选项
 * @returns {Promise<object>} 状态来源、条目映射和诊断信息
 */
async function readOfficialStatuses(projectRoot, options) {
    var settings = options || {};
    var commands = resolveCommands(projectRoot, settings);
    var diagnostics = [];

    for (var index = 0; index < commands.length; index += 1) {
        var result = await runCommand(commands[index], projectRoot, settings);
        if (result.ok) {
            return { source: 'cli', items: result.items, diagnostic: null, command: result.command };
        }
        diagnostics.push(result.diagnostic);
        if (!result.missing) {
            break;
        }
    }

    return {
        source: 'inferred',
        items: new Map(),
        diagnostic: diagnostics.filter(Boolean).join('；').slice(0, 800) || 'OpenSpec CLI 不可用',
        command: null
    };
}

module.exports = {
    readOfficialStatuses: readOfficialStatuses,
    resolveCommands: resolveCommands,
    resolveInvocation: resolveInvocation
};
