'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var fs = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');
var createFixture = require('./archive-fixture').createArchiveFixture;

test('受限 PATH 下发现 nvm CLI，使用同版本 Node，并保留项目与显式配置优先级', async function () {
    var fixture = await createFixture();
    try {
        var nvm = path.join(fixture.base, 'custom-nvm');
        var oldBin = path.join(nvm, 'versions/node/v9.9.0/bin');
        var bin = path.join(nvm, 'versions/node/v22.20.0/bin');
        await fs.mkdir(oldBin, { recursive: true });
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(path.join(oldBin, 'openspec'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 493 });
        await fs.symlink(fixture.cli, path.join(bin, 'openspec'));
        await fs.symlink(process.execPath, path.join(bin, 'node'));
        var script = 'const cli=require("./src/core/openspec-cli");const archive=require("./src/core/archive-cli");(async()=>{const status=await cli.readOfficialStatuses(process.argv[1]);const resolved=await archive.resolve(process.argv[1]);console.log(JSON.stringify({source:status.source,command:status.command,runtime:resolved.command}));})().catch(e=>{console.error(e);process.exitCode=1;});';
        function read() {
            return JSON.parse(childProcess.execFileSync(process.execPath, ['-e', script, fixture.root], {
                cwd: path.resolve(__dirname, '..'),
                env: Object.assign({}, process.env, { PATH: '/usr/bin:/bin', HOME: fixture.base, NVM_DIR: nvm, NVM_BIN: '', VOLTA_HOME: path.join(fixture.base, '.volta'), OPENSPEC_GUI_CLI: '' }),
                encoding: 'utf8'
            }));
        }
        var result = read();
        assert.equal(result.source, 'cli');
        assert.equal(result.command, path.join(bin, 'openspec'));
        assert.equal(result.runtime, await fs.realpath(process.execPath));
        var localBin = path.join(fixture.root, 'node_modules/.bin');
        await fs.mkdir(localBin, { recursive: true });
        await fs.symlink(fixture.cli, path.join(localBin, 'openspec'));
        assert.equal(read().command, path.join(localBin, 'openspec'));
        var cli = require('../src/core/openspec-cli');
        var commands = cli.resolveCommands(fixture.root, { command: fixture.cli });
        assert.deepEqual(commands.slice(0, 2), [path.join(localBin, 'openspec'), fixture.cli]);
    } finally { await fixture.cleanup(); }
});
