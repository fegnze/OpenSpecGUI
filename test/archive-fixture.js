'use strict';

var fs = require('node:fs/promises');
var os = require('node:os');
var path = require('node:path');

var PURPOSE = 'Provides a durable and explicit contract for a local example capability used to verify reviewed archive operations and preserve existing scenarios.';

function requirement(name, scenario, statement) {
    return '### Requirement: ' + name + '\nThe system SHALL ' + (statement || 'show the example state.') + '\n\n#### Scenario: ' + scenario + '\n- **WHEN** the user opens the example\n- **THEN** the example state is visible\n';
}

async function createArchiveFixture(options) {
    var settings = options || {};
    var base = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-reviewed-test-'));
    var root = await fs.realpath(path.join(base));
    var project = path.join(root, 'project');
    var changeId = settings.changeId || 'add-example';
    async function write(relative, content) {
        var target = path.join(project, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
        return target;
    }
    await write('package.json', '{"name":"archive-fixture"}\n');
    await write('openspec/config.yaml', 'schema: spec-driven\n');
    var source = 'openspec/changes/' + changeId;
    await write(source + '/.openspec.yaml', 'schema: spec-driven\ncreated: 2026-10-26\n' + (settings.noDelta ? 'skip_specs: true\n' : '') + (settings.retire ? 'retire_capabilities: true\n' : ''));
    await write(source + '/proposal.md', '## Why\nVerify reviewed archive results.\n\n## What Changes\n- Add a local example state.\n\n## Capabilities\n\n### New Capabilities\n- `example`: Displays an example.\n\n### Modified Capabilities\n\n## Impact\nLocal example files.\n');
    await write(source + '/design.md', '## Context\nA local archive fixture.\n');
    await write(source + '/tasks.md', '- [x] 1.1 Existing task\n' + (settings.incomplete ? '- [ ] 1.2 Pending task\n' : ''));
    await write(source + '/evidence/blob.bin', Buffer.from([0, 255, 3, 12, 42]));
    await fs.mkdir(path.join(project, source, 'empty'), { recursive: true });
    var main = '# example Specification\n\n## Purpose\n' + PURPOSE + '\n\n## Requirements\n\n' + requirement('Existing state', 'Existing scenario');
    await write('openspec/specs/example/spec.md', main);
    var delta = settings.delta || '## ADDED Requirements\n\n' + requirement('New state', 'New scenario');
    if (!settings.noDelta) { await write(source + '/specs/example/spec.md', delta); }
    if (settings.fake !== false) {
        var cli = path.join(root, 'fixture-cli.js');
        var fakeSource = [
            '#!/usr/bin/env node',
            "'use strict';",
            "const fs = require('node:fs'); const path = require('node:path');",
            'const args = process.argv.slice(2); const root = process.cwd(); const cmd = args[0];',
            "if(cmd==='list'){const changes=fs.readdirSync(path.join(root,'openspec/changes')).filter(name=>name!=='archive').map(name=>{const taskFile=path.join(root,'openspec/changes',name,'tasks.md');const lines=fs.existsSync(taskFile)?fs.readFileSync(taskFile,'utf8').split('\\n').map(line=>line.match(/^\\s*[-*]\\s*\\[([\\sxX])\\]/)).filter(Boolean):[];return {name,totalTasks:lines.length,completedTasks:lines.filter(line=>line[1].toLowerCase()==='x').length};});console.log(JSON.stringify({root:{path:root},changes}));process.exit(0);}",
            "const change = cmd === 'status' ? args[args.indexOf('--change') + 1] : args[1];",
            "const source = path.join(root, 'openspec/changes', change); const metadata = fs.readFileSync(path.join(source, '.openspec.yaml'), 'utf8');",
            "const delta = path.join(source, 'specs/example/spec.md'); const hasDelta = fs.existsSync(delta);",
            "const output = (value) => console.log(JSON.stringify(Object.assign({root:{path:root,source:'nearest'}},value)));",
            "if (cmd === 'status') { output({artifacts:['proposal','design','tasks','specs'].map(id=>({id,status:id==='specs'&&!hasDelta?'skipped':fs.existsSync(path.join(source,id==='specs'?'specs':id+'.md'))?'done':'ready'})),artifactPaths:{specs:{existingOutputPaths:hasDelta?[delta]:[]}}}); }",
            "else if(cmd==='validate') { output({items:[{id:change,valid:true,issues:[]}]}); }",
            "else if(cmd==='archive') {",
            settings.fakeArchive || "if(hasDelta){const target=path.join(root,'openspec/specs/example/spec.md'); const addition=fs.readFileSync(delta,'utf8').replace('## ADDED Requirements','').trim(); const content=fs.readFileSync(target,'utf8'); if(!content.includes(addition)){fs.writeFileSync(target,content+'\\n'+addition+'\\n');}}",
            "const date=new Date(); const day=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'); const name=/^\\d{4}-\\d{2}-\\d{2}-/.test(change)?change:day+'-'+change; const destination=path.join(root,'openspec/changes/archive',name); fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.renameSync(source,destination); output({archive:{change,archivedAs:name,path:destination,specsUpdated:hasDelta}});",
            "} else { process.exitCode=1; output({status:[{message:'unsupported'}]}); }"
        ].join('\n');
        await fs.writeFile(cli, fakeSource, { mode: 493 });
        settings.cli = cli;
    }
    return { root: project, base: root, changeId: changeId, source: source, main: main, cli: settings.cli, write: write, recoveryDirectory: path.join(root, 'operations'), cleanup: function () { return fs.rm(root, { recursive: true, force: true }); } };
}

module.exports = { createArchiveFixture: createArchiveFixture, requirement: requirement, PURPOSE: PURPOSE };
