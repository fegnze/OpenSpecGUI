'use strict';

const path = require('node:path');
const example = require('../capabilities/skills/feishu-defect-agent/assets/binding.example.json');

const fieldNames = ['title', 'state', 'priority', 'owners', 'description', 'attachments'];
const repoFields = ['id', 'path', 'remote', 'branch'];
const optional = (object, key, value) => { if (value) { object[key] = value; } else { delete object[key]; } };
const display = value => typeof value === 'string' && !/\bEXAMPLE_[A-Z0-9_]+/.test(value) ? value : '';

function formValues(binding, root, base) {
    const config = binding ?? {
        host: example.host, work_item_type: example.work_item_type, fields: example.fields,
        repositories: [{ id: 'current', path: root }], sources: [{ kind: 'view', id: '' }],
        handoff: example.handoff
    };
    const notes = config.notifications || {};
    return {
        host: display(config.host), projectKey: display(config.project_key), workItemType: display(config.work_item_type),
        issueUrlTemplate: display(config.issue_url_template), ownerSemantics: display(config.owners_semantics),
        profile: display(config.cli?.profile),
        sources: (config.sources || []).map(row => ({ kind: display(row.kind), id: display(row.id) })),
        fields: Object.fromEntries(fieldNames.map(key => [key, display(config.fields?.[key])])),
        repositories: (config.repositories || []).map(row => {
            const repo = Object.fromEntries(repoFields.map(key => [key, display(row[key])]));
            if (repo.path) { repo.path = path.resolve(base, repo.path); }
            return repo;
        }),
        handoffDirectory: display(config.handoff?.directory), releaseProvider: display(config.release_provider),
        notificationProvider: display(notes.provider), appId: display(notes.app_id), appIdEnv: display(notes.app_id_env),
        appSecretEnv: display(notes.app_secret_env), identityHost: display(config.identity_source?.host),
        identityFile: display(config.identity_source?.file)
    };
}

function approvedKeys(object, keys) {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key))) {
        throw new Error('表单含有不支持的字段，请重新打开配置');
    }
}

function text(input, label, required = false) {
    if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) { throw new Error(label + '填写无效'); }
    const value = input.trim();
    if (required && !value) { throw new Error('请填写' + label); }
    return value;
}

function matchValue(value, pattern, label) {
    if (value && !pattern.test(value)) { throw new Error(label + '格式无效'); }
}

function formRows(rows, allowedKeys, keyOf, previous, label, build) {
    if (!Array.isArray(rows) || rows.length > 1000) { throw new Error(label + '列表无效'); }
    const remaining = new Map(previous.map(row => [keyOf(row), row]));
    const ids = new Set();
    const result = rows.map(row => {
        approvedKeys(row, allowedKeys);
        const id = keyOf(row);
        if (ids.has(id)) { throw new Error(label + '标识重复'); }
        ids.add(id);
        const saved = { ...remaining.get(id) };
        remaining.delete(id);
        build(row, saved);
        return saved;
    });
    for (const removed of remaining.values()) {
        if (Object.keys(removed).some(key => !allowedKeys.includes(key))) {
            throw new Error('原' + label + '含有高级配置。请保留其标识，或在原配置中明确修改。');
        }
    }
    return result;
}

function updateBinding(original, values, root, base) {
    const current = formValues(original, root, base);
    approvedKeys(values, Object.keys(current));
    const form = { ...current, ...values };
    const binding = structuredClone(original || { version: 1 });
    for (const key of Object.keys(current)) {
        if (!['fields', 'sources', 'repositories'].includes(key)) { form[key] = text(form[key], key); }
    }
    binding.host = text(form.host, '飞书项目域名', true);
    matchValue(binding.host, /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i, '飞书项目域名');
    binding.project_key = text(form.projectKey, '项目键', true);
    binding.work_item_type = text(form.workItemType, '工作项类型', true);
    optional(binding, 'issue_url_template', form.issueUrlTemplate);
    if (form.ownerSemantics !== current.ownerSemantics && !['', 'current_state_operator'].includes(form.ownerSemantics)) { throw new Error('负责人字段含义无效'); }
    optional(binding, 'owners_semantics', form.ownerSemantics);

    approvedKeys(form.fields, fieldNames);
    binding.fields = { ...binding.fields };
    for (const key of fieldNames) {
        optional(binding.fields, key, text(form.fields[key] ?? current.fields[key], '字段 ' + key, key !== 'attachments'));
    }
    binding.sources = formRows(form.sources, ['kind', 'id'], row => row.kind + ':' + text(row.id, '缺陷或视图 ID', true), binding.sources || [], '缺陷来源', (row, saved) => {
        if (!['view', 'issue'].includes(row.kind)) { throw new Error('缺陷来源只支持视图或缺陷'); }
        saved.kind = row.kind;
        saved.id = text(row.id, '缺陷或视图 ID', true);
    });
    if (!binding.sources.length) { throw new Error('请至少添加一个缺陷来源'); }
    binding.repositories = formRows(form.repositories, repoFields, row => text(row.id, '仓库标识', true), binding.repositories || [], '仓库', (row, saved) => {
        saved.id = text(row.id, '仓库标识', true);
        const location = text(row.path ?? '', '仓库路径');
        optional(saved, 'path', location && path.resolve(base, location));
        optional(saved, 'remote', text(row.remote ?? '', '仓库远端'));
        optional(saved, 'branch', text(row.branch ?? '', '仓库分支'));
    });
    if (form.handoffDirectory && (path.isAbsolute(form.handoffDirectory) || form.handoffDirectory.split(/[\\/]/).includes('..'))) {
        throw new Error('交接文档目录必须是仓库内的相对路径');
    }
    if (form.profile !== current.profile) { matchValue(form.profile, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, '个人 profile'); }
    optional(binding, 'release_provider', form.releaseProvider);
    for (const [group, key, value] of [['handoff', 'directory', form.handoffDirectory], ['cli', 'profile', form.profile]]) {
        const settings = { ...binding[group] };
        optional(settings, key, value);
        optional(binding, group, Object.keys(settings).length && settings);
    }
    if (form.notificationProvider !== current.notificationProvider && !['', 'feishu-app'].includes(form.notificationProvider)) {
        throw new Error('请选择内置飞书消息应用');
    }
    for (const name of ['appIdEnv', 'appSecretEnv']) { matchValue(form[name], /^[A-Za-z_][A-Za-z_0-9]*$/, '环境变量名称'); }
    const notifications = { ...binding.notifications };
    for (const [key, value] of Object.entries({ provider: form.notificationProvider, app_id: form.appId, app_id_env: form.appIdEnv, app_secret_env: form.appSecretEnv })) {
        optional(notifications, key, value);
    }
    optional(binding, 'notifications', Object.keys(notifications).length && notifications);
    if (Boolean(form.identityHost) !== Boolean(form.identityFile)) { throw new Error('身份映射需要同时填写 SSH 主机别名和远程文件'); }
    matchValue(form.identityHost, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'SSH 主机别名');
    matchValue(form.identityFile, /^\/[a-zA-Z0-9_./-]+$/, '远程身份文件');
    const identity = { ...binding.identity_source };
    optional(identity, 'host', form.identityHost);
    optional(identity, 'file', form.identityFile);
    optional(binding, 'identity_source', Object.keys(identity).length && identity);
    return binding;
}

module.exports = { formValues, updateBinding };
