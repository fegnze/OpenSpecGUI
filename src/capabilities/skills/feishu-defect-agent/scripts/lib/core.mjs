import { createHash, randomUUID } from 'node:crypto';

export const SIGNATURE_MARKER = '[Agent缺陷处理]';
const STATES = new Set(['processing', 'done', 'wait_qa', 'handoff', 'cancelled']);
const REFRESH_MS = 300_000;
const IDLE_REFRESH_MS = 1_800_000;
const EMPTY_ROUNDS_BEFORE_BACKOFF = 2;
const own = (value, key) => value != null && Object.hasOwn(value, key);
const actorId = (actor) => String(typeof actor === 'object' && actor !== null ? actor.id ?? '' : actor ?? '').trim();
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function canonical(value, seen = new Set()) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Circular values cannot be serialized');
  if (value instanceof Date) return value.toISOString();
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => canonical(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], seen)]));
  seen.delete(value);
  return result;
}

export function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function timestamp(value, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const result = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError('A valid millisecond timestamp or ISO date is required');
  return result;
}

function truncateUtf8(value, bytes) {
  if (Buffer.byteLength(value) <= bytes) return value;
  if (bytes < 3) return '';
  const budget = bytes - Buffer.byteLength('…');
  let result = '';
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (used + size > budget) break;
    result += char;
    used += size;
  }
  return `${result}…`;
}

/** Return JSON data within the byte budget, including truncation metadata. */
export function boundedSummary(value, maxBytes = 8192) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) throw new RangeError('Summary budget must be at least 64 bytes');
  const cloned = canonical(value);
  const original = JSON.stringify(cloned);
  if (Buffer.byteLength(original) <= maxBytes) return cloned;
  let result = cloned;
  const isRecord = result && typeof result === 'object' && !Array.isArray(result);
  if (isRecord) result._summary = { truncated: true, original_bytes: Buffer.byteLength(original), omitted_items: 0 };
  const encodedBytes = () => Buffer.byteLength(JSON.stringify(result));
  // Shrink long text before dropping array entries. This keeps queue counters and
  // candidate identities usable even when titles or error messages are huge.
  for (let iteration = 0; iteration < 10_000 && encodedBytes() > maxBytes; iteration += 1) {
    const strings = [];
    const arrays = [];
    function visit(node, parent, key) {
      if (typeof node === 'string' && Buffer.byteLength(node) > 16) strings.push({ parent, key, bytes: Buffer.byteLength(node) });
      else if (node && typeof node === 'object') {
        if (Array.isArray(node) && node.length) arrays.push(node);
        for (const [childKey, child] of Object.entries(node)) {
          if (node === result && childKey === '_summary') continue;
          visit(child, node, childKey);
        }
      }
    }
    visit(result, null, null);
    strings.sort((a, b) => b.bytes - a.bytes);
    if (strings.length && strings[0].parent) {
      const entry = strings[0];
      entry.parent[entry.key] = truncateUtf8(entry.parent[entry.key], Math.max(16, Math.floor(entry.bytes / 2)));
      continue;
    }
    arrays.sort((a, b) => b.length - a.length);
    if (arrays.length) {
      arrays[0].pop();
      if (isRecord) result._summary.omitted_items += 1;
      continue;
    }
    break;
  }
  if (encodedBytes() <= maxBytes) return result;
  // Extremely small budgets or objects with thousands of distinct keys need a
  // compact envelope rather than broken JSON or an over-budget "error".
  const envelope = { truncated: true, summary: '' };
  const overhead = Buffer.byteLength(JSON.stringify(envelope));
  envelope.summary = truncateUtf8(original, Math.max(0, maxBytes - overhead));
  while (Buffer.byteLength(JSON.stringify(envelope)) > maxBytes && envelope.summary) {
    envelope.summary = truncateUtf8(envelope.summary, Math.max(0, Buffer.byteLength(envelope.summary) - 8));
  }
  return envelope;
}

function field(raw, name) {
  if (!name || typeof name !== 'string') return { found: false };
  if (own(raw, name)) return { found: true, value: raw[name] };
  let cursor = raw;
  let found = true;
  for (const part of name.split('.')) {
    if (!own(cursor, part)) { found = false; break; }
    cursor = cursor[part];
  }
  if (found) return { found: true, value: cursor };
  if (Array.isArray(raw.fields)) {
    const entry = raw.fields.find((item) => [item.field_key, item.key, item.id].includes(name));
    if (entry) return { found: true, value: entry.field_value ?? entry.value };
  } else if (raw.fields && own(raw.fields, name)) return { found: true, value: raw.fields[name] };
  return { found: false };
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
  return textValue(value.name ?? value.label ?? value.text ?? value.value ?? value.id ?? value.key);
}

export function normalizeIssueState(value) {
  const state = textValue(value).trim().toUpperCase();
  return state === 'REOPENED' ? 'REOPEN' : state;
}

function semantic(raw, binding, name) {
  if (own(raw, name)) return { found: true, value: raw[name] };
  return field(raw, binding.fields?.[name] ?? name);
}

export function issueKey(issue) {
  if (nonempty(issue?.key)) return issue.key;
  if (nonempty(issue?.issue_key)) return issue.issue_key;
  const project = issue?.project_key;
  const type = issue?.work_item_type ?? issue?.work_item_type_key;
  const id = issue?.id ?? issue?.issue_id ?? issue?.work_item_id;
  if ([project, type, id].some((part) => part === undefined || part === null || String(part).trim() === '')) {
    throw new TypeError('Issue identity requires project_key, work_item_type and id');
  }
  return [project, type, id].map((part) => encodeURIComponent(String(part))).join('/');
}

export function normalizeIssue(raw, binding = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Issue must be an object');
  const id = raw.id ?? raw.issue_id ?? raw.work_item_id;
  const project_key = raw.project_key ?? binding.project_key;
  const work_item_type = raw.work_item_type ?? raw.work_item_type_key ?? binding.work_item_type ?? binding.work_item_type_key;
  if ([id, project_key, work_item_type].some((part) => part === undefined || part === null || String(part).trim() === '')) {
    throw new TypeError('Issue identity requires project_key, work_item_type and id');
  }
  const ownerField = semantic(raw, binding, 'owners');
  let sourceOwners = ownerField.value;
  if (sourceOwners && !Array.isArray(sourceOwners) && typeof sourceOwners === 'object' && own(sourceOwners, 'value')) sourceOwners = sourceOwners.value;
  if (typeof sourceOwners === 'string' && sourceOwners.trim()) sourceOwners = [sourceOwners];
  const owners = Array.isArray(sourceOwners) ? sourceOwners.map((owner) => {
    if (typeof owner === 'object' && owner !== null) return actorId(owner.id ?? owner.user_key ?? owner.user_id ?? owner.key);
    return actorId(owner);
  }) : [];
  const owners_known = raw.owners_known !== false && ownerField.found && Array.isArray(sourceOwners) && owners.every(Boolean);
  const issue = {
    key: issueKey({ ...raw, id, project_key, work_item_type }),
    id: String(id), project_key: String(project_key), work_item_type: String(work_item_type),
    title: textValue(semantic(raw, binding, 'title').value),
    state: normalizeIssueState(semantic(raw, binding, 'state').value),
    priority: textValue(semantic(raw, binding, 'priority').value).trim().toUpperCase(),
    owners: [...new Set(owners.filter(Boolean))].sort(), owners_known,
  };
  for (const name of ['description', 'attachments', 'module', 'tags', 'updated_at']) {
    const entry = semantic(raw, binding, name);
    if (entry.found) issue[name] = entry.value;
  }
  return issue;
}

export function rankIssues(issues, actor, binding = {}) {
  const currentActor = actorId(actor);
  if (!currentActor) throw new TypeError('Current actor identity is unresolved');
  const limit = binding.budgets?.candidate_limit ?? binding.candidate_limit ?? 5;
  const maxBytes = binding.budgets?.summary_max_bytes ?? binding.summary_max_bytes ?? 8192;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('candidate_limit must be a positive integer');
  const actionable = new Set((binding.actionable_states ?? binding.policy?.actionable_states ?? ['OPEN', 'REOPEN', 'EVIDENCE_LACK']).map(normalizeIssueState));
  const counts = { input: issues.length, unique: 0, duplicates: 0, invalid: 0, eligible: 0, self: 0, unassigned: 0, other_owner: 0, unknown_owner: 0, non_actionable: 0 };
  const seen = new Set();
  const eligible = [];
  for (const raw of issues) {
    let issue;
    try { issue = normalizeIssue(raw, binding); } catch { counts.invalid += 1; continue; }
    if (seen.has(issue.key)) { counts.duplicates += 1; continue; }
    seen.add(issue.key);
    counts.unique += 1;
    if (!issue.owners_known) { counts.unknown_owner += 1; continue; }
    const owner_match = issue.owners.includes(currentActor) ? 'self' : issue.owners.length === 0 ? 'unassigned' : 'other';
    if (owner_match === 'other') { counts.other_owner += 1; continue; }
    if (!actionable.has(issue.state)) { counts.non_actionable += 1; continue; }
    counts[owner_match] += 1;
    eligible.push({ key: issue.key, id: issue.id, project_key: issue.project_key, work_item_type: issue.work_item_type, title: truncateUtf8(issue.title, 512), state: issue.state, priority: issue.priority, owners: issue.owners, owners_known: true, owner_match });
  }
  const priority = new Map(['BLOCKER', 'CRITICAL', 'MAJOR', 'NORMAL', 'MINOR', 'TRIVIAL'].map((name, index) => [name, index]));
  eligible.sort((a, b) => {
    const blocker = (issue) => issue.priority === 'BLOCKER' && ['OPEN', 'REOPEN'].includes(issue.state) ? 0 : 1;
    return blocker(a) - blocker(b) || (priority.get(a.priority) ?? 100) - (priority.get(b.priority) ?? 100) || a.key.localeCompare(b.key, 'en', { numeric: true });
  });
  counts.eligible = eligible.length;
  const result = { candidates: eligible.slice(0, limit), counts, total: counts.unique, retained: Math.min(limit, eligible.length), omitted: Math.max(0, eligible.length - limit) };
  // Never truncate a machine identity or owner list into a different identity.
  // If identities alone exceed the budget, omit the entire candidate instead.
  while (result.candidates.length && Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    const longest = [...result.candidates].sort((a, b) => Buffer.byteLength(b.title) - Buffer.byteLength(a.title))[0];
    if (Buffer.byteLength(longest.title) > 32) longest.title = truncateUtf8(longest.title, Math.max(32, Math.floor(Buffer.byteLength(longest.title) / 2)));
    else result.candidates.pop();
    result.retained = result.candidates.length;
    result.omitted = eligible.length - result.retained;
  }
  return boundedSummary(result, maxBytes);
}

function signatureShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.version === 1 && nonempty(value.issue_key) && nonempty(actorId(value.actor))
    && nonempty(value.run_id) && STATES.has(value.state)
    && (typeof value.recorded_at === 'number' ? Number.isFinite(value.recorded_at) : nonempty(value.recorded_at) && Number.isFinite(Date.parse(value.recorded_at)));
}

export function encodeSignature(signature) {
  if (!signatureShape(signature)) throw new TypeError('Invalid version 1 Agent state signature');
  const payload = Buffer.from(JSON.stringify(canonical(signature)), 'utf8').toString('base64url');
  return `${SIGNATURE_MARKER}v1.${payload}`;
}

/** Parse the entire payload after a standalone marker, never prose fragments. */
export function parseSignature(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  const markers = [...trimmed.matchAll(/(^|\n)\[Agent缺陷处理\]/gu)];
  if (!markers.length) return null;
  const last = markers.at(-1);
  const offset = last.index + last[1].length;
  try {
    const payload = trimmed.slice(offset + SIGNATURE_MARKER.length).trim();
    let json = payload;
    if (payload.startsWith('v1.')) {
      const encoded = payload.slice(3);
      // Node's Base64 decoder accepts padding, whitespace and noncanonical
      // trailing bits. Machine signatures accept only canonical Base64URL.
      if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) return null;
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    const signature = JSON.parse(json);
    return signatureShape(signature) ? signature : null;
  } catch { return null; }
}

export function owns(signatureOrResult, run) {
  const signature = signatureOrResult?.signature ?? signatureOrResult;
  if (!signatureShape(signature) || !run || signatureOrResult?.status === 'unknown') return false;
  return signature.run_id === run.id && actorId(signature.actor) === actorId(run.actor)
    && (run.issue_key === undefined || signature.issue_key === run.issue_key);
}

function sameOwner(a, b) {
  return a.issue_key === b.issue_key && a.run_id === b.run_id && actorId(a.actor) === actorId(b.actor);
}

function confirmsTakeover(next, previous) {
  const takeover = next.takeover;
  if (!takeover || takeover.confirmed !== true || takeover.previous_stopped === false) return false;
  const prior = takeover.from ?? takeover;
  return actorId(prior.actor ?? prior.actor_id) === actorId(previous.actor) && prior.run_id === previous.run_id;
}

/** Fold complete, server-ordered comments without letting stale terminal writes release a new owner. */
export function latestSignature(comments, key, options = {}) {
  const unknown = (reason) => ({ status: 'unknown', reason });
  if (options.complete !== true) return unknown('comments_incomplete');
  if (options.orderReliable === false || options.ordered === false) return unknown('comment_order_unreliable');
  const records = [];
  for (const [index, comment] of comments.entries()) {
    const signature = parseSignature(comment.content);
    if (!signature || signature.issue_key !== key) continue;
    if (!nonempty(actorId(comment.author_id))) return unknown('signature_author_unverified');
    if (actorId(comment.author_id) !== actorId(signature.actor)) continue;
    if (options.agentIds && !options.agentIds.map(actorId).includes(actorId(signature.actor))) continue;
    records.push({ signature, comment, index });
  }
  if (!records.length) return { status: 'none', signature: null };
  const explicitOrder = ['asc', 'desc'].includes(options.order) && options.orderReliable === true;
  if (explicitOrder) {
    if (options.order === 'desc') records.reverse();
  } else {
    const times = records.map(({ comment }) => {
      try { return timestamp(comment.created_at); } catch { return NaN; }
    });
    if (times.some((time) => !Number.isFinite(time)) || new Set(times).size !== times.length) return unknown('comment_order_unreliable');
    records.forEach((record, index) => { record.time = times[index]; });
    records.sort((a, b) => a.time - b.time);
  }
  let active = null;
  let latest = null;
  let conflict = false;
  let ignored = 0;
  for (const { signature } of records) {
    if (signature.state === 'processing') {
      if (!active || sameOwner(signature, active)) { active = signature; latest = signature; }
      else if (confirmsTakeover(signature, active)) { active = signature; latest = signature; conflict = false; }
      else { conflict = true; ignored += 1; }
    } else if (active && sameOwner(signature, active)) {
      active = null;
      latest = signature;
    } else if (!active && (!latest || sameOwner(signature, latest))) latest = signature;
    else ignored += 1;
  }
  if (conflict) return unknown('conflicting_processing');
  return { status: 'known', signature: active ?? latest, ignored };
}

export function evidenceFingerprint({ description = '', attachments = [], comments = [] } = {}) {
  const ordinaryComments = comments.filter((comment) => {
    const signature = parseSignature(comment.content);
    return !signature || !actorId(comment.author_id) || actorId(signature.actor) !== actorId(comment.author_id);
  }).map((comment) => canonical({ id: comment.id ?? null, author_id: comment.author_id ?? null, created_at: comment.created_at ?? null, content: comment.content ?? '' }));
  const ordered = (items) => items.map((item) => canonical(item)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hash({ description, attachments: ordered(attachments), comments: ordered(ordinaryComments) });
}

export function createRun(binding, actor, options = {}) {
  const id = actorId(actor);
  if (!id) throw new TypeError('Current actor identity is unresolved');
  const now = timestamp(options.now, Date.now());
  return { version: 1, id: options.id ?? options.run_id ?? randomUUID(), actor: { ...(typeof actor === 'object' ? actor : {}), id }, binding_key: options.binding_key ?? hash(binding), created_at: now, next_refresh_at: now, empty_rounds: 0, round_count: 0, status: 'running', issues: {}, effects: {}, host: options.host ?? {} };
}

export function ensureTask(run, rawIssue) {
  const issue = normalizeIssue(rawIssue);
  const previous = run.issues[issue.key];
  if (previous) {
    if (issue.state === 'REOPEN' && normalizeIssueState(previous.issue_state) !== 'REOPEN' && ['done', 'cancelled', 'handoff'].includes(previous.status)) {
      const { previous_attempts = [], ...snapshot } = previous;
      const task = { key: issue.key, id: issue.id, title: issue.title, status: 'queued', issue_state: issue.state, attempt: previous.attempt + 1, created_at: run.last_refresh_at ?? run.created_at, previous_attempts: [...previous_attempts, snapshot] };
      run.issues[issue.key] = task;
      return task;
    }
    previous.title = issue.title;
    previous.issue_state = issue.state;
    return previous;
  }
  const task = { key: issue.key, id: issue.id, title: issue.title, status: 'queued', issue_state: issue.state, attempt: 1, created_at: run.last_refresh_at ?? run.created_at, previous_attempts: [] };
  run.issues[issue.key] = task;
  return task;
}

/** Advance only real scans; missed wall-clock intervals never invent empty rounds. */
export function advanceRound(run, { complete, actionableCount = 0, activeCount = 0, uncertainCount = 0, now = Date.now() } = {}) {
  now = timestamp(now);
  for (const count of [actionableCount, activeCount, uncertainCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Round counts must be nonnegative integers');
  }
  if (run.status !== 'running') return run;
  if (now < run.next_refresh_at) { run.last_round_outcome = 'not_due'; return run; }
  run.last_refresh_at = now;
  run.next_refresh_at = now + REFRESH_MS;
  if (complete !== true || !actorId(run.actor)) {
    run.last_round_outcome = actorId(run.actor) ? 'incomplete' : 'identity_unknown';
    run.empty_rounds = 0;
    run.consecutive_read_failures = (run.consecutive_read_failures ?? 0) + 1;
    return run;
  }
  run.consecutive_read_failures = 0;
  const initialScan = !run.round_count;
  run.round_count = (run.round_count ?? 0) + 1;
  if (actionableCount > 0 || activeCount > 0 || uncertainCount > 0) {
    run.empty_rounds = 0;
    run.last_round_outcome = actionableCount > 0 || activeCount > 0 ? 'active' : 'uncertain';
  } else {
    if (!initialScan) run.empty_rounds = (run.empty_rounds ?? 0) + 1;
    run.last_round_outcome = 'empty';
    if (run.empty_rounds >= EMPTY_ROUNDS_BEFORE_BACKOFF) run.next_refresh_at = now + IDLE_REFRESH_MS;
  }
  return run;
}
