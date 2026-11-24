import path from 'node:path';
import { command, Fault, readJson } from './io.mjs';
import { notificationCredentials } from './notifications.mjs';

const USES_IDENTITIES = new Set([
  'prepare', 'start', 'park', 'triage-result', 'retry-notification',
  'update-notification', 'reconcile', 'resume',
]);

function validateMap(mapping, appId, requireApp = false) {
  if (mapping?.version !== 1 || !mapping.actors ||
      typeof mapping.actors !== 'object' || Array.isArray(mapping.actors)) {
    throw new Fault('IDENTITY_MAP', 'Expected a version 1 identity map with an actors object');
  }
  if ((requireApp || mapping.app_id !== undefined) && (!appId || mapping.app_id !== appId)) {
    throw new Fault('IDENTITY_APP_MISMATCH', 'The identity map does not identify the current notification app');
  }
  return mapping;
}

export async function readRemoteMap({ host, file } = {}, appId, runCommand = command) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) ||
      typeof file !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(file)) {
    throw new Fault('IDENTITY_SOURCE_CONFIG', 'The identity source requires an SSH host alias and an absolute mapping file path');
  }
  if (!appId) throw new Fault('IDENTITY_APP_MISMATCH', 'Configure the current notification app before reading its shared identity map');
  // Only validated path characters can be interpolated into the remote shell.
  const read = `set -e
    test -f '${file}'
    test ! -L '${file}'
    case "$(uname -s)" in
      Darwin) mode=$(stat -f %Lp '${file}') ;;
      Linux) mode=$(stat -c %a '${file}') ;;
      *) exit 1 ;;
    esac
    test "$mode" = 600
    cat '${file}'`;
  let result;
  try {
    result = await runCommand([
      'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
      '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', host, read,
    ], { timeoutMs: 8000, maxBytes: 1024 * 1024 });
  } catch {
    throw new Fault('IDENTITY_SOURCE_UNAVAILABLE', 'Could not read the shared identity map');
  }
  if (result.code !== 0) throw new Fault('IDENTITY_SOURCE_UNAVAILABLE', 'Could not read the shared identity map');
  let mapping;
  try { mapping = JSON.parse(result.stdout); }
  catch { throw new Fault('IDENTITY_MAP', 'The shared identity map is not valid JSON'); }
  return validateMap(mapping, appId, true);
}

export async function loadIdentityMappings({ binding, stateDir, identityMap, operation, runCommand }) {
  if (!USES_IDENTITIES.has(operation)) return {};
  const appId = notificationCredentials(binding.notifications).app_id;
  let local = {};
  try {
    local = validateMap(await readJson(identityMap ?? path.join(stateDir, 'identities.json')), appId);
  } catch (error) {
    if (identityMap || error.code !== 'ENOENT') throw error;
  }
  if (identityMap || binding.identity_source === undefined) return local;
  const shared = await readRemoteMap(binding.identity_source ?? {}, appId, runCommand);
  return { ...shared, actors: { ...local.actors, ...shared.actors } };
}
