'use strict';

var fs = require('node:fs');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var contract = require('./initiative-contract');

var FIXTURE_FILE = 'initiative-host-fixture.json';

async function readFixture(context) {
    var filePath = path.join(context.openspecRoot, FIXTURE_FILE);
    var handle;
    try {
        handle = await fsPromises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        var stat = await handle.stat();
        if (!stat.isFile() || stat.size > 4096) {
            throw new Error('可信 App 测试夹具无效');
        }
        var content = (await handle.readFile()).toString('utf8');
        var parsed = JSON.parse(content);
        if (!parsed || parsed.enabled !== true || Object.keys(parsed).some(function (key) { return key !== 'enabled'; })) {
            throw new Error('可信 App 测试夹具格式无效');
        }
        return { content: content, enabled: true };
    } catch (error) {
        if (error && error.code === 'ENOENT') { return { content: '', enabled: false }; }
        throw error;
    } finally {
        if (handle) { await handle.close(); }
    }
}

function TrustedFixtureInitiativeProvider() {
    this.id = 'trusted-fixture-provider-v1';
    this.schemaVersions = [1];
}

TrustedFixtureInitiativeProvider.prototype.fingerprint = async function (context) {
    var fixture = await readFixture(context);
    return contract.sha256(fixture.content || 'fixture-disabled');
};

TrustedFixtureInitiativeProvider.prototype.discover = async function (context) {
    var fixture = await readFixture(context);
    if (!fixture.enabled) { return []; }
    return [{
        schemaVersion: 1,
        id: 'custom-host-fixture',
        providerId: this.id,
        type: 'host-contract-test',
        title: '可信 App Host 验收专项',
        summary: '验证宿主真实接线、子路由、错误边界与清理生命周期。',
        goal: '只执行应用打包时注册的静态可信 App。',
        status: 'active',
        health: 'healthy',
        changeRefs: [],
        presentation: { mode: 'custom', appId: 'trusted-fixture-app' },
        artifacts: [],
        sourceHash: contract.sha256(fixture.content),
        diagnostics: []
    }];
};

TrustedFixtureInitiativeProvider.prototype.load = function (context, descriptor) {
    return Promise.resolve({ descriptor: descriptor, artifactIndex: [] });
};

TrustedFixtureInitiativeProvider.prototype.readArtifact = function () {
    return Promise.reject(new Error('可信 App 测试夹具不提供成果'));
};

module.exports = {
    TrustedFixtureInitiativeProvider: TrustedFixtureInitiativeProvider
};
