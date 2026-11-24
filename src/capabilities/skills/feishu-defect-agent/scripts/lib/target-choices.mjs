import fs from 'node:fs/promises';
import path from 'node:path';

const RUN_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['complete', 'idle_exit', 'fault', 'stopped']);
const MAX_CANDIDATES = 3;
const MAX_CHECKPOINTS = 64;
const STAT_BATCH = 32;
const isText = value => typeof value === 'string' && Boolean(value.trim());

function projectChoice(run, runId, { actorId, bindingKey }) {
  if (!isText(actorId) || !isText(bindingKey) || run?.id !== runId || run.actor?.id !== actorId || run.binding_key !== bindingKey || !TERMINAL.has(run.status)) return null;
  const { mode, repositories, sources, qa, release } = run.selection ?? {};
  if (!['repair', 'triage'].includes(mode) || repositories?.length !== 1 || !Array.isArray(sources) || !sources.length) return null;
  const { id, path: repoPath, branch } = repositories[0] ?? {};
  if (![id, repoPath, branch].every(isText) || qa?.receive_id_type !== 'chat_id' || !isText(qa.receive_id)) return null;
  if (!sources.every(source => ['issue', 'view'].includes(source?.kind) && isText(source.id))) return null;
  return {
    run_id: runId,
    mode,
    repository: { id, path: repoPath, branch },
    sources: sources.map(({ kind, id }) => ({ kind, id })),
    qa: { chat_id: qa.receive_id, ...(isText(qa.name) ? { name: qa.name } : {}) },
    ...(mode === 'repair' && [release?.pipeline, release?.destination, release?.verification].every(isText)
      ? { release: { pipeline: release.pipeline, destination: release.destination, verification: release.verification } } : {}),
  };
}

async function checkpointStat(store, runId) {
  const runDir = path.join(store.root, runId);
  try {
    if (!(await fs.lstat(runDir)).isDirectory()) return null;
    const stat = await fs.lstat(path.join(runDir, 'run.json'));
    return stat.isFile() ? { runId, mtime: stat.mtimeMs } : null;
  } catch { return null; }
}

async function loadChoice(store, runId, scope) {
  try { return projectChoice(await store.load(runId), runId, scope); }
  catch { return null; }
}

/** Re-read and scope-check the chosen checkpoint; a candidate is not a preparation receipt. */
export async function previousTargetChoice(store, runId, scope) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || !await checkpointStat(store, runId)) return null;
  return loadChoice(store, runId, scope);
}

export async function recentTargetChoices(store, scope) {
  let entries;
  try { entries = await fs.readdir(store.root, { withFileTypes: true }); }
  catch { return []; }
  const runIds = entries.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(entry => entry.name);
  const newest = [];
  // Rank cheaply by stat before opening any potentially large run checkpoints.
  for (let i = 0; i < runIds.length; i += STAT_BATCH) {
    const ranks = await Promise.all(runIds.slice(i, i + STAT_BATCH).map(runId => checkpointStat(store, runId)));
    newest.push(...ranks.filter(Boolean));
    newest.sort((a, b) => b.mtime - a.mtime || a.runId.localeCompare(b.runId));
    newest.splice(MAX_CHECKPOINTS);
  }
  const seen = new Set();
  const candidates = [];
  for (const { runId } of newest) {
    const choice = await loadChoice(store, runId, scope);
    if (!choice) continue;
    const key = JSON.stringify([choice.mode, choice.repository, choice.sources.map(source => JSON.stringify(source)).sort(), choice.qa.chat_id, choice.release]);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(choice);
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return candidates;
}
