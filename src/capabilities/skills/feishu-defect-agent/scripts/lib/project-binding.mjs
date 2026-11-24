import path from 'node:path';
import fs from 'node:fs/promises';
import { workbenchBinding } from './workbench-binding.mjs';
import { fileURLToPath } from 'node:url';
import { command, Fault, readJson, validateBinding } from './io.mjs';

export const projectBindingsPath = fileURLToPath(new URL('../../projects.local.json', import.meta.url));

export async function readProjectBinding(projectName) {
  const details = { project: projectName, path: projectBindingsPath };
  let projects;
  try {
    projects = await readJson(projectBindingsPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Fault('BINDING_REQUIRED', 'Create the Skill project configuration and add this project.', details);
  }
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    throw new Fault('INVALID_BINDING', 'Expected an object keyed by project directory name.', details);
  }
  if (!Object.hasOwn(projects, projectName)) {
    throw new Fault('BINDING_REQUIRED', 'Add this project to the Skill project configuration.', details);
  }
  const binding = validateBinding(projects[projectName]);
  if (binding.notifications?.app_secret !== undefined) {
    throw new Fault('INVALID_BINDING', 'Use a credential reference in the Skill project configuration.', details);
  }
  return binding;
}

export async function currentProjectBinding() {
  const root = await command(['git', 'rev-parse', '--show-toplevel']);
  if (root.code !== 0 || !root.stdout.trim()) {
    throw new Fault('BINDING_REQUIRED', 'Run from the target Git checkout or specify --binding FILE.');
  }
  const checkoutRoot = root.stdout.replace(/\r?\n$/, '');
  const local = await workbenchBinding(await fs.realpath(checkoutRoot));
  if (local) return local;
  const projectName = path.basename(checkoutRoot);
  const binding = await readProjectBinding(projectName);
  return { binding, bindingPath: projectBindingsPath, bindingDir: checkoutRoot, projectName };
}
