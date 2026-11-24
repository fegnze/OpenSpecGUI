import { spawn } from 'node:child_process';

const MAX_PAGES = 200;
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class MeegleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MeegleError';
    this.code = code;
    this.details = details;
  }
}

function text(value, label) {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new MeegleError('INVALID_PARAMETER', `${label} must be a non-empty string`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new MeegleError('INVALID_PARAMETER', `${label} must be a positive integer`);
  return value;
}

function jsonParse(source) {
  // Node 22's source context preserves business identifiers larger than 2^53.
  return JSON.parse(source, (_key, value, context) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
      ? context?.source ?? (() => { throw new MeegleError('UNSAFE_NUMBER', 'CLI returned an unsafe numeric identifier'); })()
      : value);
}

/** A short-lived process; never invokes a shell or starts authentication. */
export function runMeegleCommand(argv, { input, timeoutMs = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES, env = {} } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    return Promise.reject(new MeegleError('INVALID_PARAMETER', 'command must be an argv array'));
  }
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxBytes, 'maxBytes');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, MEEGLE_NO_UPDATE_CHECK: '1', MEEGLE_TELEMETRY: 'disabled' },
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    let killTimer;
    const stop = error => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop(new MeegleError('COMMAND_TIMEOUT', 'Meegle command exceeded its timeout')), timeoutMs);
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) return stop(new MeegleError('OUTPUT_LIMIT', 'Meegle command exceeded its output limit'));
      if (!failure) target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new MeegleError('COMMAND_UNAVAILABLE', 'Unable to start the configured Meegle CLI', { system_code: error.code }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failure) return reject(failure);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? 1, signal });
    });
    child.stdin.on('error', () => {}); // Early process exits may close stdin.
    child.stdin.end(input);
  });
}

function businessData(value) {
  if (object(value) && own(value, 'data') && (own(value, 'error') || own(value, 'meta'))) {
    if (value.error) {
      const error = value.error;
      throw new MeegleError(String(error.code ?? 'CLI_ERROR'), String(error.message ?? 'Meegle rejected the operation').slice(0, 600));
    }
    value = value.data;
  }
  if (object(value) && own(value, 'code')) {
    if (![0, '0'].includes(value.code)) {
      throw new MeegleError(String(value.code), String(value.message ?? value.msg ?? 'Meegle business operation failed').slice(0, 600));
    }
    if (own(value, 'data')) value = value.data;
  }
  return value;
}

function listData(data, keys) {
  if (Array.isArray(data)) return { items: data, container: null };
  if (object(data)) {
    for (const key of keys) {
      if (Array.isArray(data[key])) return { items: data[key], container: data };
    }
  }
  throw new MeegleError('UNKNOWN_SCHEMA', 'Unrecognized Meegle list response', { expected_lists: keys });
}

function pagination(data, page, count, seenCount) {
  if (!object(data)) return { known: false };
  const control = object(data.pagination) ? data.pagination : data;
  if (own(control, 'has_more')) {
    if (typeof control.has_more !== 'boolean') throw new MeegleError('UNKNOWN_SCHEMA', 'Pagination has_more must be a boolean');
    if (control.has_more && (control.next_page_token || control.next_cursor)) {
      throw new MeegleError('UNSUPPORTED_PAGINATION', 'This operation returned cursor pagination instead of page numbers');
    }
    return { known: true, more: control.has_more };
  }
  const total = control.total ?? data.total;
  if (Number.isSafeInteger(total) && total >= 0) {
    if (seenCount > total) throw new MeegleError('INCONSISTENT_PAGINATION', 'Returned items exceed the declared total');
    return { known: true, more: seenCount < total };
  }
  // Page length alone is never evidence that a full view has been scanned.
  return { known: false };
}

function fieldValue(value) {
  if (!object(value)) return value;
  if (own(value, 'value')) return value.value;
  if (own(value, 'field_value')) return value.field_value;
  return value;
}

function labelValue(value, label) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (object(value)) {
    if (typeof value.label === 'string') return value.label;
    if (typeof value.name === 'string') return value.name;
    const inner = fieldValue(value);
    if (inner !== value) return labelValue(inner, label);
  }
  throw new MeegleError('UNKNOWN_SCHEMA', `Unable to normalize ${label}`);
}

function ownerIds(value) {
  value = fieldValue(value);
  if (value === null || value === '') return [];
  if (typeof value === 'string') {
    if (value.startsWith('[')) {
      try { value = jsonParse(value); } catch { throw new MeegleError('UNKNOWN_SCHEMA', 'Invalid serialized owner list'); }
    } else return [value];
  }
  if (!Array.isArray(value)) throw new MeegleError('UNKNOWN_SCHEMA', 'Owner value must be a stable ID or list');
  return [...new Set(value.map(owner => {
    if (typeof owner === 'string') return text(owner, 'owner ID');
    if (object(owner)) return text(owner.user_key ?? owner.user_id ?? owner.id ?? owner.key ?? owner.value, 'owner ID');
    throw new MeegleError('UNKNOWN_SCHEMA', 'Owner entry has no stable user ID');
  }))].sort();
}

/** The project creator's stable key, without adding personal details to index rows. */
export function workitemCreator(data) {
  data = businessData(data);
  if (!object(data)) throw new MeegleError('UNKNOWN_SCHEMA', 'Work item response must be an object');
  const creator = data.work_item_attribute?.create_by ?? data.create_by;
  if (creator === undefined || creator === null || creator === '') return null;
  if (typeof creator === 'string' || typeof creator === 'number') return { id: text(creator, 'creator ID'), name: '' };
  if (!object(creator)) throw new MeegleError('UNKNOWN_SCHEMA', 'Work item creator must have a stable project user key');
  return {
    id: text(creator.user_key ?? creator.key ?? creator.id, 'creator ID'),
    name: typeof creator.name === 'string' ? creator.name : '',
  };
}

/** Only recognizes flat rows and the official work_item_attribute/fields shape. */
export function normalizeWorkitem(data, binding) {
  data = businessData(data);
  if (!object(data)) throw new MeegleError('UNKNOWN_SCHEMA', 'Work item response must be an object');
  const attributes = object(data.work_item_attribute) ? data.work_item_attribute : {};
  const values = new Map(Object.entries({ ...attributes, ...data }));
  if (!values.has('name') && typeof attributes.work_item_name === 'string') values.set('name', attributes.work_item_name);
  for (const listName of ['work_item_fields', 'workitem_fields', 'fields']) {
    if (!Array.isArray(data[listName])) continue;
    for (const item of data[listName]) {
      if (!object(item)) throw new MeegleError('UNKNOWN_SCHEMA', 'Invalid work item field entry');
      const key = item.field_key ?? item.key;
      if (typeof key !== 'string') throw new MeegleError('UNKNOWN_SCHEMA', 'Work item field has no key');
      // Field entry `name` is the field's label, not its business value.
      values.set(key, fieldValue(item));
    }
  }
  const mapping = binding.fields ?? {};
  const id = text(data.work_item_id ?? attributes.work_item_id ?? attributes.id ?? data.id, 'work item ID');
  const projectKey = text(binding.project_key, 'project_key');
  const type = text(binding.work_item_type, 'work_item_type');
  const read = (semantic, legacy) => {
    const key = mapping[semantic] ?? mapping[legacy];
    if (typeof key !== 'string' || !values.has(key)) {
      throw new MeegleError('MISSING_FIELD', `Work item is missing the configured ${semantic} field`, { issue_id: id, field: key ?? semantic });
    }
    return values.get(key);
  };
  return {
    key: [projectKey, type, id].map(encodeURIComponent).join('/'),
    id,
    project_key: projectKey,
    work_item_type: type,
    title: labelValue(read('title', 'name'), 'title'),
    state: labelValue(read('state', 'status'), 'state'),
    priority: labelValue(read('priority'), 'priority'),
    owners: ownerIds(read('owners')),
    owners_known: true,
  };
}

function commentEntry(item) {
  if (!object(item)) throw new MeegleError('UNKNOWN_SCHEMA', 'Comment must be an object');
  const author = item.author ?? item.creator;
  const id = text(item.comment_id ?? item.id, 'comment ID');
  const authorId = text(item.author_id ?? item.user_key ?? (object(author) ? author.user_key ?? author.id : author), 'comment author ID');
  const createdAt = item.created_at ?? item.create_time;
  // Server timestamps provide a verifiable order; do not fabricate local time.
  if ((typeof createdAt !== 'string' && typeof createdAt !== 'number') || createdAt === '') {
    throw new MeegleError('UNKNOWN_SCHEMA', 'Comment has no server creation time', { comment_id: id });
  }
  const content = item.content;
  if (typeof content !== 'string') throw new MeegleError('UNKNOWN_SCHEMA', 'Comment content must be a string', { comment_id: id });
  return { id, author_id: authorId, created_at: createdAt, content };
}

function diagnostic(error, context = {}) {
  return { code: error.code ?? 'READ_FAILED', message: String(error.message ?? 'Meegle read failed').slice(0, 600), ...error.details, ...context };
}

export class MeegleClient {
  constructor({ command = ['meegle'], profile, host, runCommand = runMeegleCommand, timeoutMs = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value || value.includes('\0'))) {
      throw new MeegleError('INVALID_PARAMETER', 'command must be a non-empty argv array');
    }
    if (profile !== undefined) text(profile, 'profile');
    if (host !== undefined && (typeof host !== 'string' || !/^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i.test(host))) {
      throw new MeegleError('INVALID_PARAMETER', 'host must be a host name without a path or credentials');
    }
    this.command = [...command];
    this.profile = profile;
    this.host = host;
    this.runCommand = runCommand;
    this.timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.maxBytes = positiveInteger(maxBytes, 'maxBytes');
  }

  async call(operation, parameters, directFlags = []) {
    const argv = [...this.command, ...operation, '--format', 'json', '--envelope', ...directFlags];
    if (this.profile !== undefined) argv.push('--profile', this.profile);
    if (parameters !== undefined) argv.push('--params', JSON.stringify(parameters));
    const env = { MEEGLE_NO_UPDATE_CHECK: '1', MEEGLE_TELEMETRY: 'disabled' };
    if (this.host) env.MEEGLE_HOST = this.host;
    const result = await this.runCommand(argv, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, env });
    if (!result || typeof result.stdout !== 'string') throw new MeegleError('INVALID_RUNNER_RESULT', 'Meegle runner did not return stdout');
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr ?? '') > this.maxBytes) {
      throw new MeegleError('OUTPUT_LIMIT', 'Meegle command exceeded its output limit');
    }
    let parsed;
    try { parsed = jsonParse(result.stdout); } catch (error) {
      if (error instanceof MeegleError) throw error;
      throw new MeegleError(result.code === 0 ? 'INVALID_JSON' : 'CLI_ERROR', 'Meegle did not return structured JSON', { exit_code: result.code });
    }
    const data = businessData(parsed);
    // The official auth status command exits 1 for a structured "no local token" result.
    const loggedOut = result.code === 1 && !result.signal && operation.join(' ') === 'auth status' && data?.authenticated === false;
    if (result.code !== 0 && !loggedOut) throw new MeegleError('CLI_ERROR', 'Meegle command failed', { exit_code: result.code });
    if (object(parsed?.meta) && (parsed.meta.truncated || parsed.meta.stopped_reason)) {
      throw new MeegleError('INCOMPLETE_RESPONSE', 'Meegle returned a truncated response');
    }
    return data;
  }

  async identity() {
    const data = await this.call(['user', 'me']);
    if (!object(data)) throw new MeegleError('UNKNOWN_SCHEMA', 'Current-user response must be an object');
    return { id: text(data.user_key, 'current user_key'), name: data.name_cn ?? data.name_en ?? data.name ?? '' };
  }

  /** Exact project-user lookup; project keys are never treated as Feishu IM IDs. */
  async person(userKey, projectKey) {
    userKey = text(userKey, 'userKey');
    const parameters = { user_keys: [userKey] };
    if (projectKey !== undefined) parameters.project_key = text(projectKey, 'projectKey');
    const data = await this.call(['user', 'search'], parameters);
    const { items } = listData(data, ['users', 'user_list', 'list']);
    const matches = items.filter(item => object(item) && String(item.user_key ?? '') === userKey);
    if (matches.length !== 1) throw new MeegleError('UNRESOLVED_PERSON', 'Project user lookup did not return one exact stable user key');
    const person = matches[0];
    const result = {
      id: text(person.user_key, 'user_key'),
      name: person.name_cn ?? person.name_en ?? person.name ?? '',
    };
    if (typeof result.name !== 'string') throw new MeegleError('UNKNOWN_SCHEMA', 'Project user name must be a string');
    // `out_id` is source evidence only; its IM namespace must be independently verified.
    for (const field of ['email', 'mobile', 'out_id']) {
      if (typeof person[field] === 'string' && person[field].trim()) result[field] = person[field].trim();
    }
    // Keep the source namespace unverified. Never coerce through Number: CLI JSON
    // decoding preserves the original digits of IDs beyond the safe integer range.
    if (typeof person.lark_user_id === 'string' && person.lark_user_id.trim()) {
      result.lark_user_id = person.lark_user_id.trim();
    } else if (typeof person.lark_user_id === 'number') {
      if (!Number.isSafeInteger(person.lark_user_id)) throw new MeegleError('UNSAFE_NUMBER', 'Project lark_user_id was already decoded as an unsafe number');
      result.lark_user_id = String(person.lark_user_id);
    }
    return result;
  }

  async doctor() {
    const status = await this.call(['auth', 'status']);
    if (status?.authenticated === false) throw new MeegleError('AUTHENTICATION_REQUIRED', 'No usable Meegle login in this profile; guide the user through official authorization');
    if (status?.authenticated !== true) throw new MeegleError('UNKNOWN_SCHEMA', 'Meegle auth status did not establish whether the profile is authenticated');
    if (this.host && status.host && status.host !== this.host) throw new MeegleError('HOST_MISMATCH', 'Authenticated host differs from the project binding');
    try { return { identity: await this.identity() }; }
    catch (error) {
      if (error.code === '401') throw new MeegleError('AUTHENTICATION_REQUIRED', 'Meegle rejected the current login; guide the user through official reauthorization');
      throw error;
    }
  }

  // `url decode` is a local command; it does not read dynamic --params.
  decode(url) { return this.call(['url', 'decode'], undefined, ['--url', text(url, 'url')]); }

  async project(simpleName) {
    const raw = await this.call(['project', 'search'], { project_key: text(simpleName, 'simpleName'), page_num: 1 });
    if (object(raw) && raw.project_key) return raw;
    const { items } = listData(raw, ['list', 'projects', 'project_list']);
    if (items.length !== 1 || !items[0]?.project_key) throw new MeegleError('AMBIGUOUS_PROJECT', 'Project search did not return one authoritative project');
    return items[0];
  }

  async metadata(method, projectKey, type) {
    const items = [];
    const raw = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.call(['workitem', method], { project_key: text(projectKey, 'projectKey'), work_item_type: text(type, 'type'), page_num: page });
      raw.push(data);
      const current = listData(data, ['list', 'fields', 'roles', 'field_list', 'role_list']);
      items.push(...current.items);
      const progress = pagination(current.container, page, current.items.length, items.length);
      if (!progress.known) return { items, complete: false, diagnostics: [{ code: 'UNKNOWN_PAGINATION', message: 'Metadata pagination completeness is unknown' }], raw };
      if (!progress.more) return { items, complete: true, diagnostics: [], raw };
      if (!current.items.length) throw new MeegleError('INCONSISTENT_PAGINATION', 'Metadata page is empty while more pages are declared');
    }
    throw new MeegleError('PAGE_LIMIT', 'Metadata scan exceeded its page limit');
  }

  fields(projectKey, type) { return this.metadata('meta-fields', projectKey, type); }
  roles(projectKey, type) { return this.metadata('meta-roles', projectKey, type); }

  view(projectKey, viewId, fields, page = 1) {
    return this.call(['view', 'get'], { project_key: text(projectKey, 'projectKey'), view_id: text(viewId, 'viewId'), fields: this.indexFields(fields), page_num: positiveInteger(page, 'page') });
  }

  get(projectKey, issueId, fields) {
    if (!Array.isArray(fields) || !fields.length || fields.some(value => typeof value !== 'string' || !value || value === '_all')) {
      throw new MeegleError('INVALID_PARAMETER', 'Explicit fields are required; _all is not supported');
    }
    return this.call(['workitem', 'get'], { project_key: text(projectKey, 'projectKey'), work_item_id: text(issueId, 'issueId'), fields: [...new Set(fields)] });
  }

  indexFields(fields) {
    if (!Array.isArray(fields) || !fields.length || fields.some(value => typeof value !== 'string' || !value || value === '_all')) {
      throw new MeegleError('INVALID_PARAMETER', 'Explicit index fields are required');
    }
    return [...new Set(fields)];
  }

  async comments(projectKey, issueId) {
    projectKey = text(projectKey, 'projectKey');
    issueId = text(issueId, 'issueId');
    const items = [];
    const diagnostics = [];
    const raw = [];
    const ids = new Set();
    const pages = new Set();
    let received = 0;
    let bytes = 0;
    let firstTotal;
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        // Verified on the installed official CLI: comment list accepts page_num.
        // Do not use its timestamp filters as an assumed stable change cursor.
        const data = await this.call(['comment', 'list'], { project_key: projectKey, work_item_id: issueId, page_num: page });
        bytes += Buffer.byteLength(JSON.stringify(data));
        if (bytes > this.maxBytes) throw new MeegleError('COMMENT_OUTPUT_LIMIT', 'Comment scan exceeded its cumulative byte limit');
        raw.push({ page, data });
        const current = listData(data, ['list', 'comments', 'comment_list']);
        const control = object(current.container?.pagination) ? current.container.pagination : current.container;
        if (own(control, 'page_num') && control.page_num !== page) throw new MeegleError('INCONSISTENT_PAGINATION', 'Comment response page number differs from its request');
        const total = control?.total ?? current.container?.total;
        if (total !== undefined) {
          if (!Number.isSafeInteger(total) || total < 0) throw new MeegleError('UNKNOWN_SCHEMA', 'Comment total must be a nonnegative integer');
          if (firstTotal !== undefined && total !== firstTotal) throw new MeegleError('COMMENT_SET_CHANGED', 'Comment total changed during pagination; retry a fresh complete scan');
          firstTotal ??= total;
        }
        received += current.items.length;
        const fingerprint = JSON.stringify(current.items);
        if (current.items.length && pages.has(fingerprint)) throw new MeegleError('REPEATED_PAGE', 'Comment scan repeated an earlier page');
        pages.add(fingerprint);
        for (const entry of current.items) {
          const normalized = commentEntry(entry);
          if (ids.has(normalized.id)) throw new MeegleError('DUPLICATE_COMMENT', 'A comment ID appeared more than once during pagination');
          ids.add(normalized.id);
          items.push(normalized);
        }
        const progress = pagination(current.container, page, current.items.length, received);
        if (!progress.known) throw new MeegleError('INCOMPLETE_COMMENTS', 'Comment completeness cannot be confirmed from response metadata');
        if (!progress.more) return { items, complete: true, diagnostics, raw };
        if (!current.items.length) throw new MeegleError('INCONSISTENT_PAGINATION', 'Comment page is empty while more comments are declared');
      } catch (error) {
        diagnostics.push(diagnostic(error, { page }));
        return { items, complete: false, diagnostics, raw };
      }
    }
    diagnostics.push({ code: 'PAGE_LIMIT', message: 'Comment scan exceeded its page limit', max_pages: MAX_PAGES });
    return { items, complete: false, diagnostics, raw };
  }

  addComment(projectKey, issueId, content) {
    return this.call(['comment', 'add'], { project_key: text(projectKey, 'projectKey'), work_item_id: text(issueId, 'issueId'), content: text(content, 'content') });
  }

  transitions(projectKey, issueId, type, userKey) {
    return this.call(['workflow', 'list-state-transitions'], { project_key: text(projectKey, 'projectKey'), work_item_id: text(issueId, 'issueId'), work_item_type: text(type, 'type'), user_key: text(userKey, 'userKey') });
  }

  required(projectKey, issueId, stateKey) {
    return this.call(['workflow', 'list-state-required'], { project_key: text(projectKey, 'projectKey'), work_item_id: text(issueId, 'issueId'), state_key: text(stateKey, 'stateKey'), mode: 'unfinished' });
  }

  transition(projectKey, issueId, transitionId) {
    return this.call(['workflow', 'transition-state'], { project_key: text(projectKey, 'projectKey'), work_item_id: text(issueId, 'issueId'), transition_id: text(transitionId, 'transitionId') });
  }

  relation(projectKey, issueId, fields = {}) {
    return this.call(['relation', 'list'], { ...fields, project_key: text(projectKey, 'projectKey'), work_item_id: text(issueId, 'issueId') });
  }

  async scan(binding) {
    const issues = new Map();
    const diagnostics = [];
    const raw = [];
    if (!Array.isArray(binding.sources) || !binding.sources.length) throw new MeegleError('INVALID_PARAMETER', 'At least one issue or view source is required');
    const mapping = binding.fields ?? {};
    const fields = this.indexFields([mapping.title ?? mapping.name, mapping.state ?? mapping.status, mapping.priority, mapping.owners]);
    const retain = (entry, source) => {
      try {
        const issue = normalizeWorkitem(entry, binding);
        const previous = issues.get(issue.key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(issue)) {
          diagnostics.push({ code: 'CONFLICTING_INDEX', message: 'A work item changed during the scan', issue_id: issue.id, source });
        }
        issues.set(issue.key, issue);
      } catch (error) { diagnostics.push(diagnostic(error, { source })); }
    };
    for (const configured of binding.sources) {
      const source = { kind: configured.kind, id: configured.id };
      try {
        text(source.id, 'source ID');
        if (source.kind === 'issue') {
          const data = await this.get(binding.project_key, source.id, fields);
          raw.push({ source, page: 1, data });
          retain(data, source);
          continue;
        }
        if (source.kind !== 'view') throw new MeegleError('INVALID_PARAMETER', 'Source kind must be issue or view');
        let seenCount = 0;
        let finished = false;
        const pageFingerprints = new Set();
        for (let page = 1; page <= MAX_PAGES; page++) {
          const data = await this.view(binding.project_key, source.id, fields, page);
          raw.push({ source, page, data });
          const current = listData(data, ['list', 'work_items', 'work_item_list', 'items']);
          seenCount += current.items.length;
          for (const item of current.items) retain(item, source);
          const progress = pagination(current.container, page, current.items.length, seenCount);
          if (!progress.known) throw new MeegleError('UNKNOWN_PAGINATION', 'View pagination completeness is unknown');
          if (!progress.more) { finished = true; break; }
          if (!current.items.length) throw new MeegleError('INCONSISTENT_PAGINATION', 'View page is empty while more pages are declared');
          const fingerprint = JSON.stringify(current.items);
          if (pageFingerprints.has(fingerprint)) throw new MeegleError('REPEATED_PAGE', 'View repeated a page while declaring more items');
          pageFingerprints.add(fingerprint);
        }
        if (!finished) throw new MeegleError('PAGE_LIMIT', 'View scan exceeded its page limit');
      } catch (error) { diagnostics.push(diagnostic(error, { source })); }
    }
    return { issues: [...issues.values()], complete: diagnostics.length === 0, diagnostics, raw };
  }
}
