'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var fsPromises = require('node:fs/promises');
var path = require('node:path');
var test = require('node:test');

var fixtureRoot = path.join(__dirname, 'fixtures', 'wtc-resource-program-v1');

test('WTC Resource Program v1 契约 fixture 版本、快照与 source hash 已冻结', async function () {
    var contract = JSON.parse(await fsPromises.readFile(path.join(fixtureRoot, 'fixture-contract.json'), 'utf8'));
    assert.equal(contract.providerId, 'wtc-resource-program-v1');
    assert.equal(contract.schemaVersion, 1);
    assert.match(contract.sourceHash, /^[a-f0-9]{64}$/);
    var fileNames = Object.keys(contract.files).sort();
    for (var index = 0; index < fileNames.length; index += 1) {
        var fileName = fileNames[index];
        var content = await fsPromises.readFile(path.join(fixtureRoot, fileName));
        assert.equal(crypto.createHash('sha256').update(content).digest('hex'), contract.files[fileName], fileName + ' hash 漂移');
    }
    var schemaNames = Object.keys(contract.schemas).sort();
    for (var schemaIndex = 0; schemaIndex < schemaNames.length; schemaIndex += 1) {
        var schemaName = schemaNames[schemaIndex];
        var schemaContent = await fsPromises.readFile(path.join(
            __dirname, '..', 'src', 'core', 'contracts', 'wtc-resource-program-v1', schemaName
        ));
        assert.equal(crypto.createHash('sha256').update(schemaContent).digest('hex'),
            contract.schemas[schemaName], schemaName + ' 内置 schema hash 漂移');
    }
    var sidecar = JSON.parse(await fsPromises.readFile(path.join(fixtureRoot, 'initiative-provider.json'), 'utf8'));
    var canonical = JSON.parse(await fsPromises.readFile(path.join(fixtureRoot, 'canonical-input.json'), 'utf8'));
    var expectedDescriptor = JSON.parse(await fsPromises.readFile(path.join(fixtureRoot, 'expected-descriptor.json'), 'utf8'));
    var expectedOverview = JSON.parse(await fsPromises.readFile(path.join(fixtureRoot, 'expected-overview.json'), 'utf8'));
    assert.equal(sidecar.providerId, contract.providerId);
    assert.equal(canonical.providerId, contract.providerId);
    assert.equal(expectedDescriptor.sourceHash, contract.sourceHash);
    assert.equal(expectedOverview.sourceHash, contract.sourceHash);
});
