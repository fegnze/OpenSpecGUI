import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { command as runCommand, argvCheck } from './io.mjs';
import * as notifications from './notifications.mjs';

const PHASES = ['validate', 'commit', 'push', 'publish', 'verify'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

async function executableAvailable(program, cwd) {
  const hasPath = path.isAbsolute(program) || /[\\/]/.test(program);
  const locations = hasPath ? [path.resolve(cwd, program)]
    : (process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin')).split(path.delimiter).map(directory => path.resolve(cwd, directory || '.', program));
  const extensions = process.platform === 'win32' && !path.extname(program)
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const location of locations) for (const extension of extensions) {
    try {
      const candidate = `${location}${extension}`;
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return true;
    } catch { /* Continue inspecting paths; never execute the hook as a probe. */ }
  }
  return false;
}

/** Overlay only this run's explicit choices; application credentials stay in the binding. */
export function selectedBinding(binding, selection = {}) {
  const selected = structuredClone(selection);
  return {
    ...binding,
    ...(selected.repositories ? { repositories: selected.repositories } : {}),
    ...(selected.sources ? { sources: selected.sources } : {}),
    ...(selected.handoff ? { handoff: selected.handoff } : {}),
    ...((selected.qa || selected.actors) ? { notifications: {
      ...binding.notifications,
      ...(selected.qa ? { qa: selected.qa } : {}),
      actors: { ...binding.notifications?.actors, ...selected.actors },
    } } : {}),
  };
}

function personalTarget(target) {
  if (!object(target) || !text(target.receive_id) || /EXAMPLE/.test(target.receive_id)) return null;
  const value = target.receive_id.trim();
  const valid = target.receive_id_type === 'open_id' ? /^ou_[A-Za-z0-9]+$/.test(value)
    : target.receive_id_type === 'union_id' ? /^on_[A-Za-z0-9]+$/.test(value)
      : target.receive_id_type === 'user_id' ? /^[A-Za-z0-9_-]{1,128}$/.test(value) && value !== 'all'
        : target.receive_id_type === 'email' && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(value);
  return valid ? { receive_id_type: target.receive_id_type, receive_id: value } : null;
}

async function containedDirectory(root, relative) {
  if (!text(relative) || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || ['.', '..', '.git'].includes(part))) return false;
  let ancestor = path.resolve(root, relative);
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      return (real === root || real.startsWith(`${root}${path.sep}`)) && (await fs.stat(real)).isDirectory();
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
}

/** Read-only startup inspection. This neither starts a Target nor sends test messages. */
export async function prepareProject(binding, {
  cwd = process.cwd(), bindingDir = cwd, input = {}, actor, command = runCommand,
  notificationInspector = notifications.notificationPreflight, projectClient,
} = {}) {
  const diagnostics = [];
  const checks = {};
  const add = (code, message, extra = {}) => diagnostics.push({ code, message, ...extra });
  if (!object(input)) {
    add('PREPARATION_INPUT_REQUIRED', 'Preparation choices must be a JSON object.');
    input = {};
  }
  if (input.repository !== undefined && !object(input.repository)) {
    add('REPOSITORY_SELECTION_REQUIRED', 'Repository selection must provide a path, branch, or project route ID.');
    input = { ...input, repository: {} };
  }
  const mode = input.mode;
  const selection = { mode, sources: structuredClone(input.sources ?? binding.sources), repositories: [], actors: {} };
  if (!['repair', 'triage'].includes(mode)) add('MODE_REQUIRED', 'Select repair or triage before starting the Target.');
  if (mode === 'repair') {
    const fields = ['pipeline', 'destination', 'verification'];
    const missing = fields.filter(key => {
      const value = text(input.release?.[key]);
      return !value || Buffer.byteLength(value) > 240 || /[\u0000-\u001f\u007f]/u.test(value);
    });
    if (missing.length) add('RELEASE_SELECTION_REQUIRED', 'Confirm the missing release choices for this Target without credentials.', { fields: missing });
    else selection.release = Object.fromEntries(fields.map(key => [key, text(input.release[key])]));
  }

  let root, branch, remote;
  try {
    const directory = path.resolve(cwd, input.repository?.path ?? '.');
    const top = await command(['git', 'rev-parse', '--show-toplevel'], { cwd: directory });
    if (top.code !== 0 || !text(top.stdout)) throw Error('not_repository');
    root = await fs.realpath(top.stdout.trim());
    const [branchResult, remoteResult] = await Promise.all([
      command(['git', 'branch', '--show-current'], { cwd: root }),
      command(['git', 'remote', 'get-url', 'origin'], { cwd: root }),
    ]);
    branch = branchResult.code === 0 ? text(branchResult.stdout) : null;
    remote = remoteResult.code === 0 ? text(remoteResult.stdout) : null;
    if (!branch) add('BRANCH_SELECTION_REQUIRED', 'Check out a named branch, then prepare the Target again.');
    if (!remote) add('REMOTE_REQUIRED', 'Configure this repository origin before starting the Target.');
    if (input.repository?.branch !== undefined && input.repository.branch !== branch) add('BRANCH_NOT_CHECKED_OUT', 'Check out the selected branch, then prepare the Target again.', { selected_branch: input.repository.branch, current_branch: branch });
    checks.repository = { root, branch, remote };
  } catch { add('REPOSITORY_REQUIRED', 'Select an accessible Git repository before starting the Target.'); }

  let template;
  const routes = Array.isArray(binding.repositories) ? binding.repositories.filter(object) : [];
  if (binding.repositories !== undefined && (!Array.isArray(binding.repositories) || routes.length !== binding.repositories.length)) add('REPOSITORY_CONFIG', 'Project repository routes must be objects in an array.');
  if (input.repository?.id !== undefined) {
    const matched = routes.filter(route => route.id === input.repository.id);
    if (matched.length === 1) template = matched[0];
    else if (routes.length === 0 && root && input.repository.id === path.basename(root)) template = {};
    else add('REPOSITORY_ROUTE', 'The selected repository ID must identify one project route.', { matches: matched.length });
  } else if (routes.length <= 1) template = routes[0] ?? {};
  else {
    const matched = routes.filter(route => route.remote === remote);
    if (matched.length === 1) template = matched[0];
    else add('REPOSITORY_SELECTION_REQUIRED', 'Select the project repository route before starting the Target.', { candidates: routes.map(route => ({ id: route.id, remote: route.remote })) });
  }
  if (template && root && branch && remote) {
    if (template.remote && template.remote !== remote) add('REPOSITORY_IDENTITY', 'The current origin does not match the selected project repository.');
    const delivery = {};
    for (const [phase, hook] of Object.entries(template.delivery ?? {})) delivery[phase] = Array.isArray(hook) ? { argv: [...hook] } : structuredClone(hook);
    if (mode === 'repair') {
      for (const phase of PHASES) {
        try {
          argvCheck(delivery[phase]?.argv);
          if (!await executableAvailable(delivery[phase].argv[0], root)) add('DELIVERY_EXECUTABLE_REQUIRED', 'Install or correct the project delivery executable before starting repair mode.', { phase });
        } catch { add('DELIVERY_CONFIGURATION_REQUIRED', 'Configure the project delivery hook before starting repair mode.', { phase }); }
      }
    }
    const id = text(template.id) ?? path.basename(root);
    if (id.includes('EXAMPLE')) add('REPOSITORY_CONFIG', 'Set the project repository identifier before starting the Target.');
    selection.repositories = [{ id, path: root, remote, branch, delivery,
      ...(template.channel ? { channel: template.channel } : {}),
      ...(template.match ? { match: structuredClone(template.match) } : {}),
    }];
  }

  if (mode === 'repair') {
    const handoffDirectory = binding.handoff?.directory ?? 'docs/defect-handoffs';
    selection.handoff = { directory: handoffDirectory };
    if (!root || !await containedDirectory(root, handoffDirectory)) add('HANDOFF_DIRECTORY_REQUIRED', 'Select a repository-relative handoff directory that stays within the chosen checkout.');
  }

  const qa = input.qa;
  let qaTarget;
  if (!object(qa) || Number(!!text(qa.chat_id)) + Number(!!text(qa.link)) !== 1) add('QA_SELECTION_REQUIRED', 'Choose this Target notification group with a chat_id or group link.');
  else qaTarget = text(qa.chat_id) ? { receive_id_type: 'chat_id', receive_id: qa.chat_id.trim() } : { link: qa.link.trim() };
  if (qaTarget) {
    try {
      if (typeof notificationInspector !== 'function') throw Error('inspector_missing');
      const inspected = await notificationInspector({ ...binding, notifications: { ...binding.notifications, qa: qaTarget } }, actor, { command, projectClient });
      checks.notifications = inspected.checks ?? {};
      if (inspected.ready === true && inspected.qa?.receive_id_type === 'chat_id' && text(inspected.qa.receive_id)) selection.qa = structuredClone(inspected.qa);
      else if (Array.isArray(inspected.diagnostics) && inspected.diagnostics.length) diagnostics.push(...inspected.diagnostics);
      else add('NOTIFICATION_PREFLIGHT_REQUIRED', 'Resolve notification group access and bot membership before starting the Target.');
    } catch { add('NOTIFICATION_PREFLIGHT_FAILED', 'Notification readiness could not be verified; inspect application permissions and group configuration.'); }
  }

  let target = personalTarget(input.actor_target ?? binding.notifications?.actors?.[actor?.id]);
  if (!actor?.id) add('ACTOR_IDENTITY_REQUIRED', 'Resolve the authenticated project user before starting the Target.');
  else {
    if (!target && input.actor_target === undefined && !binding.notifications?.actors?.[actor.id]) {
      try {
        const resolved = await notifications.resolveCreatorMention(binding, { id: actor.id }, { projectClient, command });
        if (resolved.status === 'resolved') target = personalTarget({ receive_id_type: resolved.id_type, receive_id: resolved.id });
      } catch { /* The actionable diagnostic below does not expose remote bodies. */ }
    }
    if (!target) add('ACTOR_NOTIFICATION_REQUIRED', 'Confirm the current project user IM recipient before starting the Target.');
    else {
      selection.actors[actor.id] = target;
      const plan = notifications.notificationPlan(selectedBinding(binding, selection), actor, {
        kind: mode === 'triage' ? 'triage_result' : 'handoff', request_key: 'startup-readiness',
        issue: { project_key: binding.project_key, work_item_type: binding.work_item_type, id: 'startup-check' },
      }, { command });
      if (!plan.ready) add(mode === 'triage' ? 'ACTOR_NOTIFICATION_REQUIRED' : 'HANDOFF_NOTIFICATION_REQUIRED', 'Resolve personal notification configuration before starting the Target.', { reason: plan.reason });
      else checks.actor_notification = { configured: true, delivery_probe: 'not_sent' };
    }
  }
  return { ready: diagnostics.length === 0, selection, diagnostics, checks,
    ...(binding.notifications?.qa ? { candidates: { qa: structuredClone(binding.notifications.qa) } } : {}) };
}
