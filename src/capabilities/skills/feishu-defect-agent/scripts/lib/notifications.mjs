import { command as runCommand, Fault, argvCheck } from './io.mjs';
import { hash, issueKey } from './core.mjs';
import { formatQaMessage } from './qa-message.mjs';

// Official contracts:
// https://open.feishu.cn/document/server-docs/im-v1/message/create
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token
// https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-structure
// https://open.feishu.cn/api-explorer?project=im&resource=chat.members&apiName=is_in_chat&version=v1
const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';
const CHAT_URL = 'https://open.feishu.cn/open-apis/im/v1/chats';
const RECEIVER_TYPES = new Set(['open_id', 'union_id', 'user_id', 'email', 'chat_id']);
const NOTIFICATION_KINDS = new Set(['wait_qa', 'handoff', 'triage_result']);
const tokenCaches = new WeakMap();

function clip(value, maxBytes) {
  const string = String(value ?? '');
  if (Buffer.byteLength(string) <= maxBytes) return string;
  let output = '';
  let bytes = 0;
  for (const char of string) {
    const size = Buffer.byteLength(char);
    if (bytes + size + 3 > maxBytes) break;
    output += char;
    bytes += size;
  }
  return `${output}…`;
}

function pending(reason, details = {}) { return { status: 'pending', reason, ...details }; }
function fault(code, message, details = {}) { return new Fault(code, message, details); }

/** Resolve project application parameters; callers must never print this value. */
export function notificationCredentials(config = {}, env = process.env) {
  const read = (name) => {
    if (typeof config[name] === 'string' && config[name].trim() && !config[name].includes('EXAMPLE')) return config[name];
    const reference = config[`${name}_env`];
    if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) return undefined;
    return typeof env[reference] === 'string' && env[reference].trim() ? env[reference] : undefined;
  };
  return { app_id: read('app_id'), app_secret: read('app_secret') };
}

function credentialPlan(config, env) {
  const credentials = notificationCredentials(config, env);
  const missing = ['app_id', 'app_secret'].filter(name => !credentials[name]);
  return missing.length ? pending('notification_credentials_missing', { missing: missing.map(name => typeof config[`${name}_env`] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(config[`${name}_env`]) ? config[`${name}_env`] : name) }) : null;
}

function preflightChat(config) {
  const qa = config.qa;
  const id = qa?.chat_id ?? (qa?.receive_id_type === 'chat_id' ? qa.receive_id : undefined);
  if (typeof id === 'string' && /^oc_[A-Za-z0-9]+$/.test(id)) return { receive_id_type: 'chat_id', receive_id: id };
  if (typeof qa?.link === 'string') {
    try {
      const url = new URL(qa.link);
      const values = [...url.searchParams.getAll('chatId'), ...url.searchParams.getAll('chat_id')];
      if (url.protocol === 'https:' && !url.username && !url.password && ['applink.feishu.cn', 'applink.larksuite.com'].includes(url.hostname) && url.pathname === '/client/chat/open' && values.length === 1 && /^oc_[A-Za-z0-9]+$/.test(values[0])) return { receive_id_type: 'chat_id', receive_id: values[0] };
    } catch {}
    return pending('qa_chat_id_required', { message: '该分享链接未提供可核验的 chat_id；请提供群 chat_id，或带 chatId 的飞书打开群链接。不会通过邀请链接自动加群。' });
  }
  return pending('qa_target_missing', { message: '请选择本次 Target 的通知群，输入 chat_id 或飞书群链接。' });
}

/** Verify startup notification prerequisites without sending a probe or joining. */
export async function notificationPreflight(binding, actor, options = {}) {
  const config = binding.notifications;
  const checks = { app_token: false, bot_in_chat: false, chat_read: false, message_send: 'not_probed' };
  const failed = (code, message, details = {}) => ({ ready: false, diagnostics: [{ code, message, ...details }], checks });
  if (!config || !['feishu-app', 'command'].includes(config.provider)) return failed('NOTIFICATION_PROVIDER_MISSING', '请先配置项目的飞书消息应用或通知适配器。');
  const qa = preflightChat(config);
  if (qa.reason === 'qa_target_missing') return failed(qa.reason.toUpperCase(), qa.message);
  if (config.provider === 'command') {
    const argv = config.preflight?.argv;
    try { argvCheck(argv); } catch { return failed('NOTIFICATION_PREFLIGHT_MISSING', '请为通知适配器配置只读 preflight.argv，启动前核验目标群和机器人入群状态。'); }
    let receipt;
    try {
      const result = await (options.command ?? runCommand)(argv, { input: { version: 1, phase: 'preflight', actor: { id: actor?.id }, qa: qa.status === 'pending' ? config.qa : qa }, timeoutMs: 120000, maxBytes: 65536 });
      if (result.code !== 0) return failed('NOTIFICATION_PREFLIGHT_FAILED', '通知适配器的启动前检查未成功，请检查配置后重新准备。');
      receipt = JSON.parse(result.stdout);
    } catch { return failed('NOTIFICATION_PREFLIGHT_FAILED', '通知适配器未返回可核验的启动前检查结果。'); }
    if (receipt.ready !== true || receipt.bot_in_chat !== true || receipt.qa?.receive_id_type !== 'chat_id' || !/^oc_[A-Za-z0-9]+$/.test(receipt.qa.receive_id ?? '') || (qa.status !== 'pending' && receipt.qa.receive_id !== qa.receive_id)) return failed('NOTIFICATION_PREFLIGHT_NOT_READY', '通知适配器必须确认选定群 chat_id 及机器人已入群；请完成配置后重新准备。');
    return { ready: true, diagnostics: [], qa: { receive_id_type: 'chat_id', receive_id: receipt.qa.receive_id, ...(typeof receipt.qa.name === 'string' ? { name: clip(receipt.qa.name, 160) } : {}) }, checks: { provider: 'command', bot_in_chat: true, message_send: 'not_probed' } };
  }
  if (qa.status === 'pending') return failed(qa.reason.toUpperCase(), qa.message);
  const credentialsMissing = credentialPlan(config, options.env ?? process.env);
  if (credentialsMissing) return failed('NOTIFICATION_CREDENTIALS_MISSING', '请先配置项目 app_id/app_secret，或其环境变量引用。', { missing: credentialsMissing.missing });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return failed('NOTIFICATION_FETCH_UNAVAILABLE', '当前 Node.js 未提供 fetch，无法核验飞书通知配置。');
  let accessToken;
  try { accessToken = await token(config, fetchImpl, options.env ?? process.env, options.now ?? Date.now()); }
  catch { return failed('NOTIFICATION_APP_AUTH', '项目飞书应用鉴权未通过，请核对 app_id/app_secret 及应用启用状态。'); }
  if (typeof accessToken !== 'string') return failed('NOTIFICATION_APP_AUTH', '项目飞书应用鉴权未通过，请补齐应用参数。');
  checks.app_token = true;
  const read = async (suffix) => {
    const response = await fetchImpl(`${CHAT_URL}/${encodeURIComponent(qa.receive_id)}${suffix}`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    const result = await response.json();
    return { valid: response.ok && result.code === 0, data: result.data, remote_code: typeof result.code === 'number' ? result.code : null, http_status: response.status };
  };
  try {
    const membership = await read('/members/is_in_chat');
    if (!membership.valid || typeof membership.data?.is_in_chat !== 'boolean') return failed('QA_BOT_MEMBERSHIP_UNVERIFIED', '无法核验机器人是否在群中；请确认群 ID、同租户、应用机器人能力，以及查询群成员状态所需权限。', { remote_code: membership.remote_code, http_status: membership.http_status });
    if (!membership.data.is_in_chat) return failed('QA_BOT_NOT_IN_CHAT', '请在所选飞书群的「设置 → 群机器人」中添加项目应用机器人，完成后重新检查。');
    checks.bot_in_chat = true;
    const group = await read('');
    if (!group.valid || !group.data || group.data.chat_mode === 'p2p') return failed('QA_CHAT_UNVERIFIED', '无法读取所选通知群；请核对 chat_id 和读取群信息权限，并选择群聊。', { remote_code: group.remote_code, http_status: group.http_status });
    checks.chat_read = true;
    return { ready: true, diagnostics: [], qa: { ...qa, ...(typeof group.data.name === 'string' ? { name: clip(group.data.name, 160) } : {}) }, checks };
  } catch { return failed('QA_CHAT_CHECK_FAILED', '群检查暂未完成，请确认网络与应用权限后重新准备；未发送消息或自动加群。'); }
}

function targetFor(config, actor, kind) {
  if (kind === 'triage_result' && (typeof actor?.id !== 'string' || !actor.id.trim())) return pending('actor_im_mapping_missing');
  const target = kind === 'wait_qa' ? config.qa : config.actors?.[actor?.id];
  if (!target) return pending(kind === 'wait_qa' ? 'qa_target_missing' : 'actor_im_mapping_missing');
  if (!RECEIVER_TYPES.has(target.receive_id_type) || typeof target.receive_id !== 'string' || !target.receive_id.trim() || target.receive_id.includes('EXAMPLE')) {
    return pending('notification_target_not_configured');
  }
  if (kind === 'wait_qa' && target.receive_id_type !== 'chat_id') return pending('qa_target_must_be_chat');
  if (kind === 'triage_result' && (target.receive_id_type === 'chat_id' || /^all$/i.test(target.receive_id.trim()))) return pending('actor_target_must_be_personal');
  return { receive_id_type: target.receive_id_type, receive_id: target.receive_id };
}

function issueLink(binding, issue) {
  let value = issue.url ?? issue.link;
  if (!value && typeof binding.issue_url_template === 'string') {
    value = binding.issue_url_template.replace(/\{(project_key|work_item_type|issue_id)\}/g, (_, name) => encodeURIComponent(String(name === 'issue_id' ? issue.id : issue[name] ?? binding[name] ?? '')));
  }
  if (!value || typeof value !== 'string' || value.includes('EXAMPLE') || /\{[^}]+\}/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function buildCard(payload) {
  const { issue, kind, summary, questions, handoff_path, creator_mention } = payload;
  const metadata = `缺陷：${clip(issue.title || issue.id, 512)}\n优先级：${clip(issue.priority || '未标明', 80)}`;
  const intro = kind === 'wait_qa' ? metadata : kind === 'triage_result' ? `${metadata}\n\n仅为排查结论\n${summary}` : `${metadata}\n${summary}`;
  const elements = [{ tag: 'div', text: { tag: 'plain_text', content: intro } }];
  if (kind === 'wait_qa' && creator_mention?.status === 'resolved') elements.push({ tag: 'div', text: { tag: 'lark_md', content: `请 <at id=${creator_mention.id}></at> 补充缺陷信息。` } });
  else if (kind === 'wait_qa' && issue.creator?.name) elements.push({ tag: 'div', text: { tag: 'plain_text', content: `缺陷创建者：${clip(issue.creator.name, 160)}` } });
  if (kind === 'wait_qa') {
    const content = formatQaMessage(payload);
    if (content) elements.push({ tag: 'div', text: { tag: 'plain_text', content } });
  } else if (kind === 'handoff' && questions.length) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `待裁决事项：\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}` } });
  }
  if (kind === 'handoff' && handoff_path) elements.push({ tag: 'div', text: { tag: 'plain_text', content: `交接资料：${clip(handoff_path, 2048)}` } });
  elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看缺陷' }, type: 'primary', url: issue.url }] });
  const [template, label] = kind === 'wait_qa' ? ['orange', '缺陷补证'] : kind === 'triage_result' ? ['blue', '缺陷排查结论'] : ['red', '缺陷交接'];
  return { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: clip(`${label} · ${issue.title || issue.id}`, 200) } }, elements };
}

/** Check routing and local configuration only. This never requests a token or sends. */
export function notificationPlan(binding, actor, request, options = {}) {
  if (!NOTIFICATION_KINDS.has(request?.kind) || typeof request.request_key !== 'string' || !request.request_key.trim()) return pending('notification_request_invalid');
  const config = binding.notifications;
  if (!config || !['feishu-app', 'command'].includes(config.provider)) return pending('notification_provider_missing');
  const target = targetFor(config, actor, request.kind);
  if (target.status === 'pending') return target;
  const url = issueLink(binding, request.issue ?? {});
  if (!url) return pending('issue_link_missing');
  try { issueKey(request.issue); } catch { return pending('notification_issue_identity_missing'); }
  if (config.provider === 'feishu-app') {
    const env = options.env ?? process.env;
    const missing = credentialPlan(config, env);
    if (missing) return missing;
    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') return pending('fetch_unavailable');
  } else {
    const argv = config.argv ?? config.command?.argv ?? (Array.isArray(config.command) ? config.command : undefined);
    if (!argv) return pending('notification_command_missing');
    try { argvCheck(argv); } catch { return pending('notification_command_invalid'); }
    if (typeof (options.command ?? runCommand) !== 'function') return pending('notification_command_invalid');
  }
  return { ready: true, provider: config.provider, target, issue_url: url };
}

async function token(config, fetchImpl, env, now) {
  const missing = credentialPlan(config, env);
  if (missing) return missing;
  const { app_id: appId, app_secret: appSecret } = notificationCredentials(config, env);
  let cache = tokenCaches.get(fetchImpl);
  if (!cache) { cache = new Map(); tokenCaches.set(fetchImpl, cache); }
  const cacheKey = hash({ appId, appSecret });
  const cached = cache.get(cacheKey);
  if (cached && cached.expires_at > now + 30_000) return cached.token;
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
  } catch {
    throw fault('NOTIFICATION_AUTH', 'Could not obtain the application token; no message was sent');
  }
  let result;
  try { result = await response.json(); } catch { throw fault('NOTIFICATION_AUTH', 'Token service did not return valid JSON; no message was sent'); }
  if (!response.ok || result.code !== 0 || typeof result.access_token !== 'string' || !result.access_token) {
    throw fault('NOTIFICATION_AUTH', 'Application token was rejected; no message was sent', { remote_code: result.code ?? null, http_status: response.status });
  }
  if (!Number.isFinite(result.expires_in) || result.expires_in <= 0) throw fault('NOTIFICATION_AUTH', 'Token response has no valid expiry; no message was sent');
  cache.set(cacheKey, { token: result.access_token, expires_at: now + result.expires_in * 1000 });
  return result.access_token;
}

async function sendFeishu(config, target, payload, { fetch: fetchImpl = globalThis.fetch, env = process.env, now = Date.now() }) {
  if (typeof fetchImpl !== 'function') return pending('fetch_unavailable');
  const accessToken = await token(config, fetchImpl, env, now);
  if (typeof accessToken !== 'string') return accessToken;
  const body = { receive_id: target.receive_id, msg_type: 'interactive', content: JSON.stringify(payload.card), uuid: payload.uuid };
  if (Buffer.byteLength(JSON.stringify(body)) > 30 * 1024) throw fault('INVALID_NOTIFICATION', 'Notification exceeds the official card message size limit');
  let response;
  try {
    response = await fetchImpl(`${MESSAGE_URL}?receive_id_type=${encodeURIComponent(target.receive_id_type)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
  } catch {
    throw fault('NOTIFICATION_UNKNOWN', 'Message result is unknown; reconcile the existing intent before retrying', { request_uuid: payload.uuid });
  }
  let result;
  try { result = await response.json(); } catch { throw fault('NOTIFICATION_UNKNOWN', 'Message response cannot be verified; reconcile before retrying', { request_uuid: payload.uuid, http_status: response.status }); }
  if (response.status >= 500) throw fault('NOTIFICATION_UNKNOWN', 'Message service returned an uncertain server error; reconcile before retrying', { request_uuid: payload.uuid, http_status: response.status });
  if (!response.ok || result.code !== 0) throw fault('NOTIFICATION_REJECTED', 'Message service rejected the card', { remote_code: result.code ?? null, http_status: response.status, remote_message: clip(result.msg ?? result.message ?? '', 600), request_uuid: payload.uuid });
  if (typeof result.data?.message_id !== 'string' || !result.data.message_id) throw fault('NOTIFICATION_UNKNOWN', 'Success response omitted the message identifier; reconcile before retrying', { request_uuid: payload.uuid });
  return { status: 'confirmed', reference: result.data.message_id, provider: 'feishu-app', message_id: result.data.message_id, ...(typeof result.data.chat_id === 'string' ? { chat_id: result.data.chat_id } : {}), request_uuid: payload.uuid };
}

async function sendCommand(config, target, payload, command) {
  const argv = config.argv ?? config.command?.argv ?? (Array.isArray(config.command) ? config.command : undefined);
  if (!argv) return pending('notification_command_missing');
  argvCheck(argv);
  let result;
  try {
    result = await command(argv, { input: { ...payload, target }, timeoutMs: 120_000, maxBytes: 1024 * 1024 });
  } catch (error) {
    if (error.code === 'COMMAND_UNAVAILABLE') throw fault('NOTIFICATION_UNAVAILABLE', 'Notification command could not start');
    throw fault('NOTIFICATION_UNKNOWN', 'Notification command result is unknown; reconcile before retrying', { request_uuid: payload.uuid });
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { throw fault('NOTIFICATION_UNKNOWN', 'Notification command returned no verifiable receipt', { request_uuid: payload.uuid }); }
  if (result.code !== 0) throw fault('NOTIFICATION_UNKNOWN', 'Notification command exited without a confirmed result', { request_uuid: payload.uuid, exit_code: result.code });
  if (receipt.status === 'pending') return pending(clip(receipt.reason ?? 'notification_command_pending', 256));
  if (receipt.status === 'rejected') throw fault('NOTIFICATION_REJECTED', 'Notification command rejected the card');
  if (receipt.status !== 'confirmed' || typeof receipt.reference !== 'string' || !receipt.reference) throw fault('NOTIFICATION_UNKNOWN', 'Notification command did not confirm a traceable message', { request_uuid: payload.uuid });
  return { status: 'confirmed', reference: receipt.reference, provider: 'command', ...(typeof receipt.message_id === 'string' ? { message_id: receipt.message_id } : {}), request_uuid: payload.uuid };
}

function mentionIdentity(projectKey, target, method) {
  if (target?.receive_id_type === 'open_id' && /^ou_[A-Za-z0-9]+$/.test(target.receive_id ?? '')) return { status: 'resolved', project_user_key: projectKey, id_type: 'open_id', id: target.receive_id, method };
  if (target?.receive_id_type === 'user_id' && /^[A-Za-z0-9_-]{1,128}$/.test(target.receive_id ?? '') && target.receive_id !== 'all') return { status: 'resolved', project_user_key: projectKey, id_type: 'user_id', id: target.receive_id, method };
  return pending('creator_mention_identity_type_unsupported');
}

/** Resolve a project creator to an IM identity without matching display names. */
export async function resolveCreatorMention(binding, creator, options = {}) {
  if (!creator?.id) return pending('issue_creator_missing');
  const config = binding.notifications ?? {};
  const explicit = config.actors?.[creator.id];
  if (explicit) return mentionIdentity(creator.id, explicit, 'explicit_project_user_mapping');
  if (config.provider !== 'feishu-app' || typeof options.projectClient?.person !== 'function') return pending('creator_im_mapping_missing');
  let person;
  try { person = await options.projectClient.person(creator.id); } catch { return pending('project_creator_profile_unavailable'); }
  if (person?.id !== creator.id) return pending('project_creator_identity_mismatch');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let accessToken;
  try { accessToken = await token(config, fetchImpl, options.env ?? process.env, options.now ?? Date.now()); }
  catch { return pending('creator_contact_authorization_unavailable'); }
  if (typeof accessToken !== 'string') return pending('creator_contact_authorization_unavailable');
  try {
    const unionCandidate = person.union_id ?? (/^on_[A-Za-z0-9]+$/.test(person.out_id ?? '') ? person.out_id : null);
    if (unionCandidate) {
      const response = await fetchImpl(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(unionCandidate)}?user_id_type=union_id`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
      const data = await response.json(); const user = data.data?.user;
      if (response.ok && data.code === 0 && user?.union_id === unionCandidate && /^ou_[A-Za-z0-9]+$/.test(user.open_id ?? '')) return mentionIdentity(creator.id, { receive_id_type: 'open_id', receive_id: user.open_id }, 'project_external_id_verified_by_contact_union_id');
    }
    if (typeof person.lark_user_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(person.lark_user_id)) {
      const response = await fetchImpl(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(person.lark_user_id)}?user_id_type=user_id`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
      const data = await response.json(); const user = data.data?.user;
      if (response.ok && data.code === 0 && String(user?.user_id) === person.lark_user_id && /^ou_[A-Za-z0-9]+$/.test(user?.open_id ?? '')) return mentionIdentity(creator.id, { receive_id_type: 'open_id', receive_id: user.open_id }, 'project_lark_user_id_verified_by_contact_user_id');
    }
    if (typeof person.email === 'string' && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(person.email)) {
      const response = await fetchImpl('https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ emails: [person.email], include_resigned: false }), signal: AbortSignal.timeout(20000), redirect: 'error' });
      const data = await response.json(); const users = data.data?.user_list;
      const matches = Array.isArray(users) ? users.filter(user => typeof user.email === 'string' && user.email.toLowerCase() === person.email.toLowerCase()) : [];
      if (response.ok && data.code === 0 && matches.length === 1) return mentionIdentity(creator.id, { receive_id_type: 'open_id', receive_id: matches[0].user_id }, 'project_email_to_im_open_id');
    }
    return pending('creator_im_identity_unresolved');
  } catch { return pending('creator_contact_lookup_failed'); }
}

async function prepareNotification(binding, actor, request, options) {
  if (!NOTIFICATION_KINDS.has(request?.kind)) throw fault('INVALID_NOTIFICATION', 'Notification kind must be wait_qa, handoff or triage_result');
  if (typeof request.request_key !== 'string' || !request.request_key.trim()) throw fault('INVALID_NOTIFICATION', 'A stable request_key is required before sending');
  const plan = notificationPlan(binding, actor, request, options);
  if (!plan.ready) return plan;
  const config = binding.notifications;
  const { target, issue_url: url } = plan;
  const key = issueKey(request.issue);
  const payload = {
    version: 1, kind: request.kind, request_key: request.request_key,
    issue: { key, id: request.issue.id, title: clip(request.issue.title, 512), priority: clip(request.issue.priority, 80), url, ...(request.kind !== 'triage_result' && request.issue.creator ? { creator: { id: request.issue.creator.id, name: clip(request.issue.creator.name, 160) } } : {}) },
    summary: clip(request.summary, 4000), questions: (Array.isArray(request.questions) ? request.questions : []).slice(0, 10).map((question) => clip(question, 512)),
    ...(request.handoff_path ? { handoff_path: clip(request.handoff_path, 2048) } : {}),
  };
  if (request.kind === 'wait_qa') payload.creator_mention = await resolveCreatorMention(binding, request.issue.creator, options);
  payload.card = buildCard(payload);
  // The API deduplicates this UUID for only one hour. It is not a durable send
  // ledger and never authorizes a retry of an unknown prior request.
  payload.uuid = hash({ key, kind: request.kind, request_key: request.request_key, target, card: payload.card }).slice(0, 40);
  return { target, payload };
}

/** Send one already-authorized intent. The caller persists intent and recovery state. */
export async function notify(binding, actor, request, options = {}) {
  const prepared = await prepareNotification(binding, actor, request, options);
  if (prepared.status === 'pending') return prepared;
  const { target, payload } = prepared;
  const config = binding.notifications;
  const receipt = await (config.provider === 'command'
    ? sendCommand(config, target, payload, options.command ?? runCommand)
    : sendFeishu(config, target, payload, options));
  return { ...receipt, ...(payload.creator_mention ? { creator_mention: { ...payload.creator_mention, status: receipt.status === 'confirmed' && payload.creator_mention.status === 'resolved' ? 'included' : payload.creator_mention.status } } : {}) };
}

/** Replace the existing card; this does not promise a new notification alert. */
export async function updateNotification(binding, actor, request, previous, options = {}) {
  if (binding.notifications?.provider !== 'feishu-app') return pending('notification_update_provider_unsupported');
  if (previous?.status !== 'confirmed' || !/^om_[A-Za-z0-9]+$/.test(previous.message_id ?? '') || previous.provider !== 'feishu-app') return pending('confirmed_message_id_required');
  const prepared = await prepareNotification(binding, actor, request, options);
  if (prepared.status === 'pending') return prepared;
  const { target, payload } = prepared;
  if (payload.creator_mention?.status !== 'resolved') return pending('creator_mention_unresolved', { creator_mention: payload.creator_mention });
  if (options.expectedCreatorId && options.expectedCreatorId !== payload.creator_mention.id) return pending('creator_mention_identity_changed');
  if (previous.chat_id && target.receive_id_type === 'chat_id' && target.receive_id !== previous.chat_id) return pending('notification_update_destination_changed');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const accessToken = await token(binding.notifications, fetchImpl, options.env ?? process.env, options.now ?? Date.now());
  if (typeof accessToken !== 'string') return accessToken;
  const url = `${MESSAGE_URL}/${encodeURIComponent(previous.message_id)}`;
  let response, data;
  try {
    response = await fetchImpl(url, { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: JSON.stringify(payload.card) }), signal: AbortSignal.timeout(20000), redirect: 'error' });
    data = await response.json();
  } catch { throw fault('NOTIFICATION_UNKNOWN', 'Card update result is unknown; do not create a replacement message'); }
  if (response.status >= 500) throw fault('NOTIFICATION_UNKNOWN', 'Card update result is uncertain');
  if (!response.ok || data.code !== 0) throw fault('NOTIFICATION_REJECTED', 'Card update was rejected', { remote_code: data.code ?? null, http_status: response.status, remote_message: clip(data.msg ?? '', 600) });
  try {
    const checked = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    const receipt = await checked.json(); const item = receipt.data?.items?.find(message => message.message_id === previous.message_id);
    if (!checked.ok || receipt.code !== 0 || !item || item.deleted === true || item.msg_type !== 'interactive' || (target.receive_id_type === 'chat_id' && item.chat_id !== target.receive_id) || !hasMention(item, payload.creator_mention.id)) throw Error('Message or creator mention readback mismatch');
  } catch { throw fault('NOTIFICATION_UNKNOWN', 'Updated card could not be confirmed by message readback'); }
  return { ...previous, status: 'confirmed', creator_mention: { ...payload.creator_mention, status: 'included' }, update: 'confirmed', alert: 'not_guaranteed_for_message_update' };
}

function hasMention(message, id) {
  const keys = new Set((message.mentions ?? []).filter(mention => mention.id?.open_id === id || mention.id?.user_id === id || mention.user_id === id || (mention.id === id && ['open_id', 'user_id'].includes(mention.id_type))).map(mention => mention.key).filter(Boolean));
  let body;
  try { body = JSON.parse(message.body?.content); } catch { return false; }
  const visit = node => {
    if (!node || typeof node !== 'object') return false;
    if (node.tag === 'at' && (node.user_id === id || node.id === id || keys.has(node.user_id))) return true;
    if (['lark_md', 'markdown'].includes(node.tag) && typeof (node.content ?? node.text) === 'string' && (node.content ?? node.text).includes(`<at id=${id}></at>`)) return true;
    return Object.values(node).some(value => Array.isArray(value) ? value.some(visit) : visit(value));
  };
  return visit(body);
}

/** Read-only reconciliation of an already attempted edit. Never patches or sends. */
export async function verifyNotificationMention(binding, previous, expected, options = {}) {
  const verified = mentionIdentity(expected?.project_user_key, { receive_id_type: expected?.id_type, receive_id: expected?.id }, 'verified_message_readback');
  if (verified.status !== 'resolved' || !/^om_[A-Za-z0-9]+$/.test(previous?.message_id ?? '')) return pending('creator_mention_proof_missing');
  const config = binding.notifications;
  if (config?.provider !== 'feishu-app') return pending('notification_update_provider_unsupported');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const accessToken = await token(config, fetchImpl, options.env ?? process.env, options.now ?? Date.now());
  if (typeof accessToken !== 'string') return accessToken;
  let response, data;
  try { response = await fetchImpl(`${MESSAGE_URL}/${encodeURIComponent(previous.message_id)}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000), redirect: 'error' }); data = await response.json(); }
  catch { return pending('creator_mention_readback_unavailable'); }
  const message = data.data?.items?.find(item => item.message_id === previous.message_id);
  if (!response.ok || data.code !== 0 || !message || message.deleted === true || message.msg_type !== 'interactive' || (previous.chat_id && message.chat_id !== previous.chat_id) || !hasMention(message, expected.id)) return pending('creator_mention_not_confirmed');
  return { ...previous, status: 'confirmed', creator_mention: { ...expected, status: 'included' }, update: 'confirmed', alert: 'not_guaranteed_for_message_update', mention_update: { status: 'confirmed' } };
}
