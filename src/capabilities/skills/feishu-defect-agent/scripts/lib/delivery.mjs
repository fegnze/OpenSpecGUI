import fs from 'node:fs/promises';
import path from 'node:path';
import { Fault, argvCheck, command, digest, repository } from './io.mjs';

const PHASES = ['validate', 'commit', 'push', 'publish', 'verify'];
const EFFECTS = new Set(['commit', 'push', 'publish']);
const confirmed = record => ['confirmed', 'inherited'].includes(record?.status);
const now = () => new Date().toISOString();

function pathsChecked(values) {
  if (!Array.isArray(values)) throw new Fault('REVIEW_REQUIRED', 'Reviewed changed_paths are required');
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) {
      throw new Fault('INVALID_PATH', 'changed_paths must contain exact repository-relative file paths');
    }
    return value;
  }))].sort();
}

function dirtyPaths(status) {
  if (typeof status !== 'string') throw new Fault('BASELINE_REQUIRED', 'Baseline status must be the original porcelain-v1 -z output');
  const entries = status.split('\0');
  const result = [];
  for (let index = 0; index < entries.length && entries[index]; index++) {
    const entry = entries[index];
    if (!/^.{2} /.test(entry)) throw new Fault('BASELINE_REQUIRED', 'Unrecognized porcelain baseline');
    result.push({ code: entry.slice(0, 2), path: entry.slice(3) });
    if (/[RC]/.test(entry.slice(0, 2))) {
      const previous = entries[++index];
      if (!previous) throw new Fault('BASELINE_REQUIRED', 'Incomplete rename record in baseline');
      result.push({ code: entry.slice(0, 2), path: previous });
    }
  }
  return result;
}

async function git(runCommand, cwd, args, options = {}) {
  const result = await runCommand(['git', ...args], { cwd, maxBytes: 8 * 1024 * 1024, ...options });
  if (result.code !== 0) throw new Fault('GIT_CHECK_FAILED', 'Repository verification failed', { operation: args[0], exit_code: result.code });
  return result.stdout;
}

async function fingerprints(cwd, paths) {
  const result = {};
  for (const relative of paths) {
    const absolute = path.join(cwd, relative);
    // Parent symlinks could escape the bound checkout even with a relative path.
    let parentPath = path.dirname(absolute);
    let parent;
    while (parent === undefined) {
      try { parent = await fs.realpath(parentPath); } catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(parentPath) === parentPath) throw error;
        parentPath = path.dirname(parentPath);
      }
    }
    if (parent !== cwd && !parent.startsWith(`${cwd}${path.sep}`)) throw new Fault('PATH_ESCAPE', 'Reviewed path escapes the repository');
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) result[relative] = { mode: 'symlink', hash: digest(await fs.readlink(absolute)) };
      else if (stat.isFile()) result[relative] = { mode: stat.mode & 0o111 ? 'executable' : 'file', hash: digest(await fs.readFile(absolute)) };
      else throw new Fault('INVALID_PATH', 'Review individual files rather than directories');
    } catch (error) {
      if (error.code === 'ENOENT') result[relative] = { mode: 'deleted' };
      else throw error;
    }
  }
  return result;
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function parseHook(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}
function publication(data, expectedCommit, expectedId) {
  const value = data?.publication;
  if (!value || typeof value.id !== 'string' || !value.id || value.source_commit !== expectedCommit || (expectedId && value.id !== expectedId)) {
    throw new Fault('PUBLICATION_EVIDENCE', 'Publication must identify the verified deployment/version and its exact source commit');
  }
  return { id: value.id, source_commit: value.source_commit };
}
function summary(task, phase) {
  const record = task.delivery.phases[phase];
  return { phase, status: record?.status, repository_id: task.delivery.repository_id, channel: task.delivery.channel, evidence: record?.evidence, artifact: record?.artifact };
}

/** The caller must recheck Feishu responsibility and signature ownership first. */
export async function deliveryPhase({ run, task, binding, bindingDir, phase, input = {}, io }) {
  if (!run?.id || !task?.key || !io?.save || !io?.artifact) throw new Fault('DELIVERY_CONTEXT', 'Persisted run, issue task and artifact storage are required');
  if (![...PHASES, 'reconcile', 'inherit'].includes(phase)) throw new Fault('INVALID_PHASE', 'Unknown delivery phase');
  const runCommand = io.command ?? command;
  const issue = { ...(task.issue ?? {}), ...task };
  const repo = await repository(binding, bindingDir, issue, runCommand);
  const channel = repo.channel ?? repo.id;
  const existing = task.delivery;
  if (existing && (existing.repository_id !== repo.id || existing.channel !== channel || existing.cwd !== repo.cwd)) {
    throw new Fault('DELIVERY_ROUTE_CHANGED', 'Resume the original delivery route instead of moving an unfinished transaction');
  }
  for (const other of Object.values(run.issues ?? {})) {
    if (other.key === task.key || !other.delivery) continue;
    const otherDelivery = other.delivery;
    const sameChannel = otherDelivery.cwd === repo.cwd || otherDelivery.channel === channel;
    if (sameChannel && !confirmed(otherDelivery.phases?.verify) && otherDelivery.active !== false) {
      throw new Fault('DELIVERY_CHANNEL_BUSY', 'Another issue has an unfinished transaction on this repository or release channel', { issue_key: other.key });
    }
  }
  const delivery = task.delivery ??= { version: 1, repository_id: repo.id, cwd: repo.cwd, channel, phases: {}, active: true };
  const baseline = input.baseline ?? task.baseline;
  const baselineHead = typeof baseline === 'string' ? baseline : baseline?.head;
  const head = (await git(runCommand, repo.cwd, ['rev-parse', 'HEAD'])).trim();
  const { pipeline, destination, verification } = run.selection?.release ?? {};
  const release = pipeline && destination && verification ? { pipeline, destination, verification } : undefined;
  const payload = () => ({ version: 1, run_id: run.id, issue_key: task.key, repository_id: repo.id, channel, release, baseline: delivery.baseline, changed_paths: delivery.changed_paths ?? [], commit_oid: delivery.commit_oid, publication: delivery.publication, inherited_from: delivery.inherited_from });
  const hook = async (configuration, label) => {
    argvCheck(configuration?.argv);
    const result = await runCommand(configuration.argv, {
      cwd: repo.cwd, input: JSON.stringify(payload()), timeoutMs: configuration.timeout_ms ?? 120_000,
      maxBytes: configuration.max_bytes ?? 8 * 1024 * 1024,
    });
    const artifact = await io.artifact(`${task.key}:delivery:${label}:${Date.now()}`, result);
    return { result, artifact, data: parseHook(result) };
  };

  if (phase === 'inherit') {
    if (Object.keys(delivery.phases).length) throw new Fault('DELIVERY_ALREADY_STARTED', 'Do not replace an existing delivery transaction with inherited evidence');
    const source = run.issues?.[input.source_issue_key]?.delivery;
    if (!source || input.source_issue_key === task.key || !confirmed(source.phases?.verify) || !source.commit_oid || !source.publication || source.repository_id !== repo.id || source.channel !== channel) {
      throw new Fault('INHERITED_FIX_UNVERIFIED', 'Reference an already verified fix on the same repository and release channel');
    }
    delivery.inherited_from = input.source_issue_key;
    delivery.commit_oid = source.commit_oid;
    delivery.publication = { ...source.publication };
    for (const inherited of ['commit', 'push', 'publish']) delivery.phases[inherited] = { status: 'inherited', recorded_at: now(), evidence: { source_issue_key: input.source_issue_key, commit_oid: source.commit_oid, publication: { ...source.publication } } };
    await io.save(run);
    return { phase, status: 'confirmed', source_issue_key: input.source_issue_key, commit_oid: source.commit_oid, publication: delivery.publication };
  }

  if (phase === 'reconcile') {
    const target = input.target_phase;
    if (!PHASES.includes(target) || !['intent', 'unknown'].includes(delivery.phases[target]?.status)) throw new Fault('NO_UNKNOWN_EFFECT', 'Only an intent or unknown phase needs reconciliation');
    const configuration = repo.delivery?.reconcile?.[target];
    if (!configuration) throw new Fault('RECONCILE_UNAVAILABLE', 'Configure a read-only reconciliation hook before retrying an uncertain operation');
    const checked = await hook(configuration, `reconcile-${target}`);
    const record = delivery.phases[target];
    record.reconciliations ??= [];
    record.reconciliations.push({ artifact: checked.artifact, recorded_at: now(), status: checked.data?.status ?? 'unknown' });
    if (checked.result.code === 0 && checked.data?.status === 'not_applied') {
      record.status = 'not_applied';
      record.artifact = checked.artifact;
      await io.save(run);
      return summary(task, target);
    }
    if (checked.result.code !== 0 || checked.data?.status !== 'confirmed') {
      record.status = 'unknown';
      await io.save(run);
      return summary(task, target);
    }
    try {
      await confirm(target, checked.data);
      record.status = 'confirmed';
      record.artifact = checked.artifact;
      record.evidence = evidence(target);
      if (target === 'verify') delivery.active = false;
      await io.save(run);
      return summary(task, target);
    } catch (error) {
      record.status = 'unknown';
      await io.save(run);
      throw error;
    }
  }

  const record = delivery.phases[phase];
  if (confirmed(record)) return summary(task, phase);
  if (record && ['intent', 'unknown'].includes(record.status)) throw new Fault('RECONCILE_REQUIRED', 'Reconcile the saved operation before executing it again', { phase });
  if (delivery.inherited_from && ['commit', 'push', 'publish'].includes(phase)) throw new Fault('INHERITED_FIX', 'An inherited fix must not create an empty commit or publication');
  const previous = PHASES[PHASES.indexOf(phase) - 1];
  if (previous && !confirmed(delivery.phases[previous])) throw new Fault('PHASE_ORDER', `Confirm ${previous} before ${phase}`);
  if (phase === 'verify' && !confirmed(delivery.phases.validate)) throw new Fault('PHASE_ORDER', 'Validate this duplicate independently before verifying its inherited publication');
  if (phase === 'validate') {
    if (input.reviewed !== true) throw new Fault('REVIEW_REQUIRED', 'Main-agent review must be explicit');
    const paths = pathsChecked(input.changed_paths);
    if (!paths.length && !delivery.inherited_from) throw new Fault('EMPTY_CHANGE', 'A new delivery needs real reviewed changes');
    if (!baselineHead || head !== baselineHead) throw new Fault('BASELINE_CHANGED', 'Repository HEAD differs from the investigation baseline');
    const baselineStatus = typeof baseline === 'object' ? baseline.status : '';
    const dirtyBaseline = new Set(dirtyPaths(baselineStatus).map(entry => entry.path));
    if (paths.some(value => dirtyBaseline.has(value))) throw new Fault('BASELINE_DIRTY_PATH', 'Reviewed changes overlap a pre-existing dirty path');
    const status = dirtyPaths(await git(runCommand, repo.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    if (status.some(entry => !paths.includes(entry.path) && !dirtyBaseline.has(entry.path))) throw new Fault('UNREVIEWED_CHANGES', 'Working tree contains new changes outside this issue review');
    if (paths.some(value => !status.some(entry => entry.path === value))) throw new Fault('EMPTY_CHANGE', 'Every reviewed path must contain a real change');
    delivery.baseline = { head: baselineHead, status: baselineStatus };
    delivery.changed_paths = paths;
    delivery.review_fingerprint = await fingerprints(repo.cwd, paths);
  } else {
    const expected = delivery.commit_oid ?? delivery.baseline.head;
    if (head !== expected) throw new Fault('BASELINE_CHANGED', 'Repository HEAD changed after the reviewed delivery stage');
    if (!same(await fingerprints(repo.cwd, delivery.changed_paths), delivery.review_fingerprint)) throw new Fault('REVIEW_CHANGED', 'Reviewed file contents changed; validate again after main-agent review');
  }
  const configuration = repo.delivery?.[phase];
  argvCheck(configuration?.argv);
  if (phase === 'commit') {
    const staged = (await git(runCommand, repo.cwd, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    if (staged.some(value => !delivery.changed_paths.includes(value))) throw new Fault('UNRELATED_STAGED_CHANGES', 'Preserve unrelated staging and isolate this issue before committing');
  }
  delivery.phases[phase] = { status: 'intent', recorded_at: now(), before_head: head };
  await io.save(run); // Durable intent precedes staging and the trusted hook.
  try {
    if (phase === 'commit' && configuration.stage !== 'hook') await git(runCommand, repo.cwd, ['--literal-pathspecs', 'add', '--', ...delivery.changed_paths]);
    const executed = await hook(configuration, phase);
    delivery.phases[phase].artifact = executed.artifact;
    if (executed.result.code !== 0) throw new Fault('DELIVERY_COMMAND_FAILED', 'Trusted delivery hook failed; inspect its artifact', { phase, exit_code: executed.result.code });
    await confirm(phase, executed.data);
    delivery.phases[phase].status = 'confirmed';
    delivery.phases[phase].confirmed_at = now();
    delivery.phases[phase].evidence = evidence(phase);
    if (phase === 'verify') delivery.active = false;
    await io.save(run);
    return summary(task, phase);
  } catch (error) {
    delivery.phases[phase].status = EFFECTS.has(phase) || phase === 'verify' ? 'unknown' : 'failed';
    delivery.phases[phase].error_code = error.code ?? 'DELIVERY_ERROR';
    await io.save(run);
    throw error;
  }

  async function confirm(target, data) {
    const currentHead = (await git(runCommand, repo.cwd, ['rev-parse', 'HEAD'])).trim();
    if (target === 'validate') {
      if (currentHead !== delivery.baseline.head || !same(await fingerprints(repo.cwd, delivery.changed_paths), delivery.review_fingerprint)) {
        throw new Fault('VALIDATION_CHANGED_SOURCE', 'Validation changed reviewed source or repository HEAD');
      }
    } else if (target === 'commit') {
      const ancestry = (await git(runCommand, repo.cwd, ['rev-list', '--parents', '-n', '1', currentHead])).trim().split(/\s+/);
      if (ancestry.length !== 2 || ancestry[1] !== delivery.baseline.head) throw new Fault('COMMIT_NOT_INDEPENDENT', 'The issue must create exactly one new commit on its recorded baseline');
      const committed = (await git(runCommand, repo.cwd, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', currentHead])).split('\0').filter(Boolean).sort();
      if (!committed.length || !same(committed, delivery.changed_paths)) throw new Fault('COMMIT_PATHS_MISMATCH', 'Commit paths differ from the exact issue review');
      await git(runCommand, repo.cwd, ['--literal-pathspecs', 'diff', '--exit-code', currentHead, '--', ...delivery.changed_paths]);
      if (!same(await fingerprints(repo.cwd, delivery.changed_paths), delivery.review_fingerprint)) throw new Fault('COMMIT_CONTENT_MISMATCH', 'Committed files differ from the reviewed content');
      delivery.commit_oid = currentHead;
    } else if (target === 'push') {
      if (currentHead !== delivery.commit_oid) throw new Fault('BASELINE_CHANGED', 'Only the confirmed issue commit may be pushed');
      const remote = (await git(runCommand, repo.cwd, ['ls-remote', '--exit-code', 'origin', `refs/heads/${repo.branch}`])).trim().split(/\s+/);
      if (remote[0] !== delivery.commit_oid || remote[1] !== `refs/heads/${repo.branch}`) throw new Fault('REMOTE_COMMIT_MISMATCH', 'Remote target branch does not contain the exact issue commit');
    } else if (target === 'publish') {
      delivery.publication = publication(data, delivery.commit_oid);
    } else if (target === 'verify') {
      if (data?.verified !== true) throw new Fault('PUBLICATION_UNVERIFIED', 'Verification hook did not confirm the deployed artifact');
      publication(data, delivery.commit_oid, delivery.publication?.id);
    }
  }
  function evidence(target) {
    if (target === 'validate') return { baseline: delivery.baseline.head, reviewed_paths: delivery.changed_paths };
    if (target === 'commit' || target === 'push') return { commit_oid: delivery.commit_oid };
    return { commit_oid: delivery.commit_oid, publication: delivery.publication, ...(delivery.inherited_from ? { source_issue_key: delivery.inherited_from } : {}) };
  }
}
