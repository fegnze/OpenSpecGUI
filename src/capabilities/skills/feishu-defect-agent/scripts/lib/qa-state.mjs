import { normalizeIssueState } from './core.mjs';

const EVIDENCE_LACK = 'EVIDENCE_LACK';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const stateKey = value => object(value) ? text(value.key ?? value.state_key ?? value.id ?? value.value) : text(value);
const stateName = value => object(value) ? text(value.name ?? value.label ?? value.state_name) : text(value);
const exact = value => value === EVIDENCE_LACK;
const diagnostic = error => ({ code: typeof error?.code === 'string' ? error.code : 'STATE_INSPECTION_FAILED' });

function transitionTarget(item) {
  return text(item.target_state_key ?? item.to_state_key ?? item.to_state?.key ?? item.target_state?.key ?? item.state_key);
}
function incomplete(value) {
  return value?.complete === false || value?.truncated === true || value?.has_more === true || value?.pagination?.has_more === true || !!text(value?.next_page_token) || !!text(value?.pagination?.next_page_token);
}

/** `list-state-required(mode=unfinished)` is read-only and never fills unknown values. */
export function inspectRequiredState(required) {
  if (incomplete(required)) return { ready: false, reason: 'evidence_lack_required_schema_unknown' };
  if (object(required) && Object.keys(required).length === 0) return { ready: true };
  if (Array.isArray(required?.form_items)) {
    if (required.form_items.some(item => !object(item) || typeof item.finished !== 'boolean')) return { ready: false, reason: 'evidence_lack_required_schema_unknown' };
    return required.form_items.some(item => !item.finished)
      ? { ready: false, reason: 'evidence_lack_required_fields_unfinished' } : { ready: true };
  }
  const unfinished = Array.isArray(required) ? required : required?.fields ?? required?.list ?? required?.required_fields;
  if (!Array.isArray(unfinished)) return { ready: false, reason: 'evidence_lack_required_schema_unknown' };
  return unfinished.length ? { ready: false, reason: 'evidence_lack_required_fields_unfinished' } : { ready: true };
}

/** Inspect the actual workflow only; the caller owns mutation, intent and readback. */
export async function inspectEvidenceState({ client, binding, actor, issueId, currentState, artifact }) {
  const paths = {};
  const currentKey = stateKey(currentState);
  const currentName = stateName(currentState);
  const pending = (reason, extra = {}) => ({ status: 'pending', reason, current_state: currentState, changed: false, ...paths, ...extra });
  const confirmed = (target) => ({ status: 'confirmed', supported: true, target, current_state: currentState, changed: false, reason: 'already_evidence_lack', ...paths });
  const save = async (label, value) => typeof artifact === 'function' ? artifact(label, value) : undefined;

  let options;
  try {
    options = await client.transitions(binding.project_key, issueId, binding.work_item_type, actor.id);
    paths.options_path = await save(`qa-state-options-${issueId}`, options);
  } catch (error) {
    // An authoritative current-state label is enough to avoid a redundant write.
    if (exact(currentName) || exact(currentKey)) return confirmed(currentKey ?? EVIDENCE_LACK);
    return pending('evidence_lack_transitions_unavailable', { diagnostic: diagnostic(error) });
  }
  if (exact(currentName) || exact(currentKey)) return confirmed(currentKey ?? EVIDENCE_LACK);
  const list = Array.isArray(options) ? options : options?.transition ?? options?.transitions ?? options?.list ?? options?.state_transitions;
  if (!Array.isArray(list) || incomplete(options) || list.some(item => !object(item))) return pending('evidence_lack_transition_schema_unknown');
  const candidates = list.filter(item => [item.state_name, item.name, item.target_state?.name, item.to_state?.name].some(value => exact(text(value))) || exact(transitionTarget(item)));
  if (candidates.length > 1) return pending('evidence_lack_transition_ambiguous');

  let selected = candidates[0];
  let target = selected && transitionTarget(selected);
  if (selected && !target) return pending('evidence_lack_target_unknown');
  if (!selected) {
    let metadata;
    try {
      metadata = await client.fields(binding.project_key, binding.work_item_type);
      paths.metadata_path = await save(`qa-state-metadata-${issueId}`, metadata);
    } catch (error) { return pending('evidence_lack_metadata_unavailable', { diagnostic: diagnostic(error) }); }
    if (metadata?.complete !== true || !Array.isArray(metadata.items) || (metadata.diagnostics?.length ?? 0) > 0 || incomplete(metadata)) return pending('evidence_lack_metadata_incomplete');
    const fields = metadata.items.filter(item => object(item) && (item.field_key ?? item.key) === binding.fields.state);
    if (fields.length !== 1) return pending('evidence_lack_metadata_schema_unknown');
    const states = fields[0].option ?? fields[0].options ?? fields[0].select_options;
    if (!Array.isArray(states) || !states.length || states.some(item => !object(item) || !text(item.option_id ?? item.key ?? item.id) || !text(item.option_name ?? item.name ?? item.label))) return pending('evidence_lack_metadata_schema_unknown');
    const configured = states.filter(item => exact(text(item.option_name ?? item.name ?? item.label)) || exact(text(item.option_id ?? item.key ?? item.id)));
    if (configured.length > 1) return pending('evidence_lack_metadata_ambiguous');
    if (!configured.length) {
      if (![currentKey, currentName].some(value => ['OPEN', 'REOPEN'].includes(normalizeIssueState(value)))) return pending('evidence_lack_source_state_unexpected');
      return { status: 'confirmed', supported: false, changed: false, reason: 'evidence_lack_not_configured', current_state: currentState, ...paths };
    }
    target = text(configured[0].option_id ?? configured[0].key ?? configured[0].id);
    if (currentKey === target) return confirmed(target);
    // A transition may expose only the authoritative opaque destination key.
    const reachable = list.filter(item => transitionTarget(item) === target);
    if (reachable.length > 1) return pending('evidence_lack_transition_ambiguous', { supported: true, target });
    if (!reachable.length) return pending('evidence_lack_transition_unavailable', { supported: true, target });
    selected = reachable[0];
  }
  if (currentKey === target) return confirmed(target);
  const transitionId = text(selected.transition_id ?? selected.id);
  if (!transitionId) return pending('evidence_lack_transition_id_unknown', { supported: true, target });
  let required;
  try {
    required = await client.required(binding.project_key, issueId, target);
    paths.required_path = await save(`qa-state-required-${issueId}-${target}`, required);
  } catch (error) { return pending('evidence_lack_required_unavailable', { supported: true, target, diagnostic: diagnostic(error) }); }
  const inspection = inspectRequiredState(required);
  if (!inspection.ready) return pending(inspection.reason, { supported: true, target });
  return { status: 'ready', supported: true, target, transition_id: transitionId, source_state: currentState, ...paths };
}
