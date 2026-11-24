'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const systemBins = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** Finder does not inherit a login shell. Never resolve tooling in the active project. */
async function findCli(name, { home = os.homedir(), baseDirs = systemBins, fallbackDirs = [] } = {}) {
    if (!['meegle', 'lark-cli', 'codex', 'claude', 'dsh'].includes(name)) { throw new Error('不支持的命令行工具'); }
    const versions = path.join(home, '.nvm', 'versions', 'node');
    const entries = await fs.readdir(versions, { withFileTypes: true }).catch(() => []);
    const nvm = entries.filter(e => e.isDirectory() && /^v\d+\.\d+\.\d+$/.test(e.name))
        .map(e => e.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
        .map(v => path.join(versions, v, 'bin'));
    const dirs = name === 'dsh' ? fallbackDirs : [...baseDirs, path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'), ...nvm, ...fallbackDirs];
    for (const dir of dirs) {
        const file = path.join(dir, name);
        try {
            if (!(await fs.stat(file)).isFile()) { continue; }
            await fs.access(file, constants.X_OK);
            return { file, dirs: [...new Set([dir, ...dirs, ...systemBins])] };
        } catch { /* Try the next installation. */ }
    }
    return null;
}

module.exports = { findCli };
