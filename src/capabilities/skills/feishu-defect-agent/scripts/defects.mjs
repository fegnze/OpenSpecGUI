#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { Store, readJson, Fault } from './lib/io.mjs';
import { currentProjectBinding } from './lib/project-binding.mjs';
import { loadIdentityMappings } from './lib/identity-map.mjs';
import { MeegleClient } from './lib/meegle.mjs';
import { Runtime } from './lib/runtime.mjs';
import { boundedSummary } from './lib/core.mjs';

const HELP = {
  usage: 'node defects.mjs COMMAND [--binding FILE] [--state-dir DIR] [--profile PERSONAL_PROFILE] [--identity-map FILE] [--run ID] [--issue ID] [--input FILE] [--phase PHASE]; uses an explicit binding first, otherwise the current worktree settings in Agent Workbench, or projects.local.json for standalone installations',
  runtime: 'Node.js >=22. Raw data and logs go to protected local files; stdout contains bounded JSON only.',
  commands: {
    doctor: 'Read identity, field/role metadata and binding diagnostics; never logs in.',
    choices: 'List recent finished Target selections for the current project and authenticated user.',
    prepare: 'Inspect startup prerequisites without creating a Target. Input {mode:repair|triage,reuse_run_id?,repository?:{path,branch?,id?},qa?:{chat_id|link},sources?,release?:{pipeline,destination,verification},actor_target?,target?}. Mode is explicit; reuse copies only unmodified choices.',
    start: 'Create one run after readiness and human selection. Input {preparation_id,confirmed:true}; rechecks prerequisites, expires after 10 minutes, and reuses the same run on repeated start.',
    refresh: 'Perform one due complete minimal-index scan. Not-due calls do not invent rounds.',
    status: 'Read local next candidates only; no remote I/O.',
    resume: 'Verify original actor/binding, reconcile comments and show checkpoint; refresh when due.',
    stop: 'Record an explicitly requested stop. Input {reason,workers_stopped?:true}; preserves signatures, pending work and unknown effects.',
    suspend: 'After lost authority, stop the actual worker and record local handoff. Input {worker_stopped:true,reason}; preserves external signatures.',
    detail: 'Read selected issue details/comments into a private artifact; output only its path.',
    relations: 'Read actual workitem relations on demand into a private artifact; --input supplies CLI relation parameters.',
    begin: 'Recheck owner/state/signature; write and read back the processing signature.',
    handover: 'Input {takeover:{actor:{id},run_id,confirmed:true,previous_stopped:true}}; explicit human confirmation required.',
    worker: 'Prepare worker prompt artifact; main Agent invokes actual native subAgent tool.',
    'worker-result': 'Input {conclusion,changed_paths:[],tests:[{command,result,evidence?}],evidence:[],unresolved:[],log_paths:[]}.',
    deliver: 'Phase validate|commit|push|publish|verify|inherit|reconcile. validate input {reviewed:true,changed_paths:[]}; inherit {source_issue_key}; reconcile {target_phase}.',
    transition: 'Without input: save authoritative options. Input {transition_id,target_state,delivery_verified:true}; requires no unfinished mandatory fields.',
    finish: 'Input {reviewed:true,summary?}; verified delivery and state readback required before writing done.',
    'triage-result': 'Triage only. Input {summary}; record the investigation conclusion in a defect comment and send a private card to the current actor without changing defect state.',
    park: 'Input {kind:wait_qa,questions:[...],summary?} or {kind:handoff,summary,questions?:[]}; write shared recovery baseline and notify configured destination.',
    'sync-qa-state': 'Inspect a parked wait_qa request and synchronize the actual EVIDENCE_LACK workflow state when configured; keep OPEN/REOPEN when absent. Reconcile unknown effects first; never marks a product fix.',
    'handoff-result': 'Input {commit_oid}; verify the exact generated document commit and remote ancestry, then synchronize its shared handoff receipt.',
    'retry-notification': 'Continue known-not-sent pending notifications or original-run durable intents/receipts; never blindly resend unknown results.',
    'update-notification': 'Update the existing confirmed QA card with a verified creator mention; preserves message ID and does not promise a new alert.',
    reconcile: 'Read back unknown comment intents; never resend uncertain writes.',
    'host-link': 'Input {host:codex|claude-code,capabilities?,goal_id?,tasks?}; record actual native IDs or explicit degradation, never creates fake entities.'
  }
};
function options(argv) {
  const command = argv.shift(); const flags = {};
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!['--binding', '--state-dir', '--profile', '--identity-map', '--run', '--issue', '--input', '--phase', '--transition'].includes(flag) || !argv.length || argv[0].startsWith('--')) throw new Fault('USAGE', 'Unknown flag or missing value');
    if (flags[flag]) throw new Fault('USAGE', 'Repeated flags are not accepted');
    flags[flag] = argv.shift();
  }
  return { command, flags, help: !command || command === '--help' || command === '-h' };
}
export async function main(argv = process.argv.slice(2)) {
  const args = options([...argv]); if (args.help) return HELP;
  const { command: op, flags } = args;
  if (!Object.hasOwn(HELP.commands, op)) throw new Fault('USAGE', 'Unknown command; use --help');
  const bindingPath = flags['--binding'];
  const { binding, ...location } = bindingPath
    ? { binding: await readJson(bindingPath), bindingPath }
    : await currentProjectBinding();
  const store = new Store({ ...location, stateDir: flags['--state-dir'] }); await store.init();
  const client = new MeegleClient({ profile: flags['--profile'] ?? binding.cli?.profile, host: binding.host });
  const identityMappings = await loadIdentityMappings({
    binding, stateDir: store.root, identityMap: flags['--identity-map'], operation: op,
  });
  const runtime = new Runtime({ binding, store, client, identityMappings });
  const input = flags['--input'] ? await readJson(flags['--input']) : {};
  if (op === 'doctor') return runtime.doctor();
  if (op === 'choices') return runtime.choices();
  if (op === 'prepare') return runtime.prepare(input);
  if (op === 'start') return runtime.start(input);
  if (!flags['--run']) throw new Fault('USAGE', '--run is required');
  const run = await runtime.load(flags['--run'], { identity: op !== 'status' });
  if (op === 'status') return runtime.status(run);
  if (op === 'resume') return runtime.resume(run);
  if (op === 'reconcile') return runtime.reconcile(run);
  if (op === 'stop') return runtime.stop(run, input);
  if (op === 'refresh') return runtime.refresh(run);
  if (op === 'host-link') return runtime.hostLink(run, input);
  const task = runtime.task(run, flags['--issue']);
  if (op === 'detail') return runtime.detail(run, task);
  if (op === 'relations') return runtime.relations(run, task, input);
  if (op === 'begin') return runtime.begin(run, task);
  if (op === 'handover') return runtime.begin(run, task, input.takeover);
  if (op === 'worker') return runtime.worker(run, task);
  if (op === 'worker-result') return runtime.workerResult(run, task, input);
  if (op === 'deliver') return runtime.deliver(run, task, flags['--phase'], input);
  if (op === 'transition') return runtime.transition(run, task, { ...input, ...(flags['--transition'] ? { transition_id: flags['--transition'] } : {}) });
  if (op === 'finish') return runtime.finish(run, task, input);
  if (op === 'triage-result') return runtime.triageResult(run, task, input);
  if (op === 'park') return runtime.park(run, task, input);
  if (op === 'sync-qa-state') return runtime.syncQaState(run, task);
  if (op === 'handoff-result') return runtime.handoffResult(run, task, input);
  if (op === 'suspend') return runtime.suspend(run, task, input);
  if (op === 'retry-notification') return runtime.retryNotification(run, task);
  if (op === 'update-notification') return runtime.updateNotification(run, task);
}
const entry = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(boundedSummary({ error: { code: error.code ?? 'OPERATION_FAILED', message: String(error.message ?? 'Operation failed').slice(0, 600), details: error.details ?? {} } }, 8192))}\n`);
    process.exitCode = 1;
  }
}
