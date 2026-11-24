import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export class Fault extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function readJson(file) {
  const source = await fs.readFile(file, 'utf8');
  try { return JSON.parse(source); }
  catch { throw new Fault('INVALID_JSON', 'Configuration or checkpoint is not valid JSON', { path: file }); }
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  return file;
}
export function argvCheck(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Fault('INVALID_ARGV', 'Trusted commands require a nonempty argv array');
}
export function command(argv, { cwd, input, timeoutMs = 120000, maxBytes = 32 * 1024 * 1024, env = {} } = {}) {
  argvCheck(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0, failure, killTimer;
    const out = [], err = [];
    const stop = error => { if (failure) return; failure = error; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); };
    const timer = setTimeout(() => stop(new Fault('COMMAND_TIMEOUT', 'Command timed out; reconcile external effects before retrying')), timeoutMs);
    const collect = target => chunk => { bytes += chunk.length; if (bytes > maxBytes) stop(new Fault('OUTPUT_LIMIT', 'Command output exceeded the private artifact limit')); else target.push(chunk); };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    child.once('error', error => { clearTimeout(timer); reject(new Fault('COMMAND_UNAVAILABLE', 'Configured command could not start', { system_code: error.code })); });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); if (failure) reject(failure); else resolve({ code: code ?? 1, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
    child.stdin.on('error', () => {}); child.stdin.end(input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input));
  });
}
export function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Fault('INVALID_BINDING', 'Project binding must be an object');
  const missing = [];
  for (const key of ['host', 'project_key', 'work_item_type']) if (typeof binding[key] !== 'string' || !binding[key].trim()) missing.push(key);
  if (binding.version !== 1) missing.push('version=1');
  if (binding.release_provider !== undefined && (typeof binding.release_provider !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(binding.release_provider))) missing.push('release_provider must be a provider name, not a URL or job');
  if (!Array.isArray(binding.sources) || !binding.sources.length || binding.sources.some(x => !['issue', 'view'].includes(x.kind) || typeof x.id !== 'string' || !x.id)) missing.push('sources');
  for (const key of ['title', 'state', 'priority', 'owners', 'description']) if (typeof binding.fields?.[key] !== 'string') missing.push(`fields.${key}`);
  for (const [key, value] of Object.entries(binding)) if (/token|password|secret$/i.test(key) && value) missing.push(`remove credential:${key}`);
  const checked = structuredClone(binding);
  if (checked.notifications?.app_secret !== undefined) {
    if (typeof checked.notifications.app_secret !== 'string' || !checked.notifications.app_secret.trim()) missing.push('notifications.app_secret must be a nonempty project application secret');
    delete checked.notifications.app_secret;
  }
  if (/"(?:access_token|refresh_token|app_secret|client_secret)"\s*:/.test(JSON.stringify(checked))) missing.push('personal tokens must remain outside project configuration');
  if (binding.budgets) for (const key of ['candidate_limit', 'summary_max_bytes', 'worker_result_max_bytes']) {
    const value = binding.budgets[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (key.includes('bytes') ? 1024 : 1) || value > (key.includes('bytes') ? 65536 : 20))) missing.push(`budgets.${key}`);
  }
  if (missing.length) throw new Fault('INVALID_BINDING', 'Shared binding needs correction', { missing });
  return binding;
}
export async function repository(binding, bindingDir, issue, runCommand = command) {
  const routes = (binding.repositories ?? []).filter(repo => !repo.match || issue[repo.match.field] === repo.match.equals);
  if (routes.length !== 1) throw new Fault('REPOSITORY_ROUTE', 'Issue must match exactly one repository', { matches: routes.length });
  const route = routes[0];
  if (![route.id, route.path, route.remote, route.branch].every(x => typeof x === 'string' && x && !x.includes('EXAMPLE'))) throw new Fault('REPOSITORY_CONFIG', 'Repository id, path, authoritative remote and target branch are required');
  const cwd = await fs.realpath(path.resolve(bindingDir, route.path));
  const remote = await runCommand(['git', 'remote', 'get-url', 'origin'], { cwd });
  const branch = await runCommand(['git', 'branch', '--show-current'], { cwd });
  if (remote.code || branch.code || remote.stdout.trim() !== route.remote || branch.stdout.trim() !== route.branch) throw new Fault('REPOSITORY_IDENTITY', 'Repository remote or checked-out branch does not match its binding');
  return { ...route, cwd };
}
export class Store {
  constructor({ bindingPath, bindingDir, projectName, stateDir }) {
    this.bindingPath = path.resolve(bindingPath);
    this.bindingDir = bindingDir ?? path.dirname(this.bindingPath);
    const stateKey = projectName ? ['project', projectName] : this.bindingPath;
    this.root = path.resolve(stateDir ?? path.join(os.homedir(), '.cache', 'feishu-defect-agent', digest(stateKey).slice(0, 20)));
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await fs.realpath(this.root);
    const probe = await command(['git', '-C', this.root, 'rev-parse', '--show-toplevel']);
    if (probe.code === 0) {
      const ignored = await command(['git', '-C', this.root, 'check-ignore', '-q', this.root]);
      if (ignored.code !== 0) throw new Fault('STATE_NOT_PRIVATE', 'Runtime directory inside a repository must be ignored by Git');
    }
    await fs.chmod(this.root, 0o700);
  }
  runDir(id) { if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id ?? '')) throw new Fault('INVALID_RUN', 'Invalid run identifier'); return path.join(this.root, id); }
  async load(id) { return readJson(path.join(this.runDir(id), 'run.json')); }
  async save(run) { return atomicJson(path.join(this.runDir(run.id), 'run.json'), run); }
  preparationPath(id) { this.runDir(id); return path.join(this.root, 'preparations', `${id}.json`); }
  async preparation(id) { return readJson(this.preparationPath(id)); }
  async savePreparation(record) { return atomicJson(this.preparationPath(record.id), record); }
  async artifact(run, label, value) { return atomicJson(path.join(this.runDir(run.id), 'artifacts', `${digest(label).slice(0, 20)}.json`), value); }
}
