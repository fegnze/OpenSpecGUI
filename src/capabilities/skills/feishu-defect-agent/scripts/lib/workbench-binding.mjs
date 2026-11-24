import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, Fault, validateBinding } from './io.mjs';

function invalidInstall() {
  return new Fault('WORKBENCH_INSTALL_INVALID', '请在工作台中重新绑定飞书缺陷 Skill。');
}

async function privateDirectory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) {
    throw invalidInstall();
  }
}

async function readBoundedJson(file, limit, privateFile) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (privateFile ? constants.O_NOFOLLOW : 0);
  const handle = await fs.open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || (privateFile && ((stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())))) {
      throw new Fault('INVALID_BINDING', '绑定记录无法安全读取。');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size) throw new Fault('INVALID_BINDING', '绑定记录已变化，请重试。');
    // JSON.parse 可能将输入片段写到错误消息里，统一返回固定诊断。
    try { return JSON.parse(bytes.toString('utf8', 0, total)); }
    catch { throw new Fault('INVALID_BINDING', '请在工作台核对绑定 JSON。'); }
  } finally { await handle.close(); }
}

const needsInput = '请用真实项目参数替换 EXAMPLE 占位值，再返回工作台检查。';

export class BindingError extends Fault {
    constructor(message, code = 'INVALID_BINDING') { super(code, message); }
}

export function checkSettings(value, depth = 0, allowPlaceholders = false) {
    if (depth > 32) { throw new BindingError('绑定文件嵌套过深'); }
    if (typeof value === 'string') {
        if (!allowPlaceholders && /\bEXAMPLE_[A-Z0-9_]+/.test(value)) { throw new BindingError(needsInput, 'BINDING_REQUIRED'); }
        if (/\b(?:Bearer|Basic)\s+[^\s]+|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|https?:\/\/[^\s/?#]+@|[?&](?:access_token|refresh_token|app_secret|client_secret|api_key|token|password)=[^&#\s]+/i.test(value)) {
            throw new BindingError('绑定文件包含内嵌凭据，请改用环境变量引用');
        }
    }
    if (!value || typeof value !== 'object') { return; }
    for (const [key, child] of Object.entries(value)) {
        if (/(?:token|secret|password|passwd|authorization|apikey|privatekey|cookie)$/i.test(key.replace(/[_-]/g, ''))) {
            throw new BindingError('绑定文件包含内嵌凭据字段，请改用环境变量引用');
        }
        if (/_env$/i.test(key) && (typeof child !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(child))) {
            throw new BindingError('凭据引用必须填写环境变量名称');
        }
        checkSettings(child, depth + 1, allowPlaceholders);
    }
}

export function validateWorkbenchValues(data) {
    checkSettings(data);
    try { validateBinding(data); }
    catch { throw new BindingError('请核对单项目绑定的 version、host、project_key、work_item_type、sources、fields 和可选配置'); }
    if (['title', 'state', 'priority', 'owners', 'description'].some(key => !data.fields[key].trim())) {
        throw new BindingError('飞书字段映射不能为空');
    }
}

// 只从正在执行的真实 Skill 位置和应用已登记的版本识别用户目录。
export async function workbenchBinding(checkoutRoot) {
  const moduleFile = await fs.realpath(fileURLToPath(import.meta.url));
  const versionDir = path.resolve(path.dirname(moduleFile), '../..');
  const versions = path.dirname(versionDir);
  const store = path.dirname(versions);
  const version = path.basename(versionDir);
  if (path.basename(versions) !== 'versions' || path.basename(store) !== 'capabilities' || !/^[a-f0-9]{64}$/.test(version)) return null;
  const dataDir = path.dirname(store);
  const relative = path.relative(checkoutRoot, dataDir);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw invalidInstall();
  for (const dir of [dataDir, store, versions, versionDir]) await privateDirectory(dir);
  const registry = await readBoundedJson(path.join(store, 'registry.json'), 32 * 1024 * 1024, true);
  const entry = path.join(versionDir, 'SKILL.md');
  const item = registry?.records?.find(row => row.id === 'feishu-defect-agent' && row.kind === 'skill');
  const selectedVersion = item?.versions?.find(v => v.builtin && v.digest === version && v.localEntry === entry);
  if (registry?.schema !== 2 || !selectedVersion || !Array.isArray(registry.bindings)) throw invalidInstall();
  const requested = process.env.FEISHU_DEFECT_AGENT_HOST || (process.env.CLAUDECODE ? 'claude' : process.env.CODEX_THREAD_ID ? 'codex' : '');
  const matches = registry.bindings.filter(b => b.id === item.id && b.root === checkoutRoot && b.version === selectedVersion.version &&
      ['codex', 'claude'].includes(b.host) && (!requested || requested === b.host));
  if (matches.length !== 1) {
    throw new Fault('BINDING_REQUIRED', '请在当前工作树和宿主启用此 Skill。若从终端使用多个绑定，请指定 FEISHU_DEFECT_AGENT_HOST=codex 或 claude。');
  }
  const projectKey = digest(checkoutRoot);
  const scopes = path.join(dataDir, 'capability-projects');
  const worktree = path.join(scopes, projectKey);
  const hostDir = path.join(worktree, matches[0].host);
  const settings = path.join(hostDir, 'feishu-defect-bindings');
  const project = path.join(settings, projectKey);
  try {
    for (const dir of [scopes, worktree, hostDir, settings, project]) await privateDirectory(dir);
    const record = await readBoundedJson(path.join(project, 'reference.json'), 32 * 1024, true);
    if (typeof record?.path !== 'string' || !path.isAbsolute(record.path) || path.extname(record.path).toLowerCase() !== '.json') {
      throw new Fault('INVALID_BINDING', '请在工作台重新关联当前工作树的配置。');
    }
    const binding = await readBoundedJson(record.path, 512 * 1024, false);
    validateWorkbenchValues(binding);
    // 与显式 --binding 使用相同文件身份、相对路径基准和运行历史。
    return { binding, bindingPath: record.path };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Fault('BINDING_REQUIRED', '请在工作台打开当前工作树并完成飞书缺陷设置。');
    throw error;
  }
}
