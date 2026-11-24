'use strict';

const path = require('node:path');
const { readJson } = require('./local-config');

/** 同一工作树的归档会修改共享规范，两个归档入口读取同一条本机选择。 */
async function readArchivePolicy(userDataPath, root) {
    const store = await readJson(path.join(userDataPath, 'capabilities', 'registry.json'), null);
    if (!store || store.schema === 1) { return { requireSyncedSpecs: false }; }
    if (store.schema !== 2 || !Array.isArray(store.bindings)) { throw new Error('无法核对归档规则，请检查本机能力登记。'); }
    const selected = store.bindings.filter(entry => entry?.root === root && entry.id === 'archive-synced-specs' &&
        ['codex', 'claude', 'dsh'].includes(entry.host));
    if (selected.some(entry => entry.version !== '1.0.0')) { throw new Error('归档规则版本不受支持，请在工作台核对绑定。'); }
    return { requireSyncedSpecs: selected.length > 0 };
}

module.exports = { readArchivePolicy };
