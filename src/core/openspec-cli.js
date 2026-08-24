'use strict';

var childProcess = require('node:child_process');
var fs = require('node:fs');
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
    return commands;
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

function runCommand(command, projectRoot, settings) {
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
            child = childProcess.spawn(command, ['list', '--json'], {
                cwd: projectRoot,
                env: process.env,
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
    resolveCommands: resolveCommands
};
