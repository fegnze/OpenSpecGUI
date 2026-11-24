'use strict';

var fs = require('node:fs/promises');
var path = require('node:path');

var release = process.env.OPENSPEC_GUI_RELEASE_BUILD === '1'
    ? require('./scripts/mac-release').releaseSettings(process.env) : null;

module.exports = {
    hooks: release ? {
        packageAfterCopy: async function (_config, buildPath) {
            var file = path.join(buildPath, 'package.json');
            var metadata = JSON.parse(await fs.readFile(file, 'utf8'));
            metadata.openspecGUIUpdateBaseURL = release.base;
            await fs.writeFile(file, JSON.stringify(metadata, null, 2) + '\n');
        }
    } : {},
    packagerConfig: {
        ...(release ? {
            osxSign: { identity: release.identity },
            osxNotarize: { keychainProfile: release.profile }
        } : {}),
        asar: { unpack: '**/dsh-plugin/index.mjs' },
        overwrite: true,
        icon: path.resolve(__dirname, 'assets', 'app-icon.icns'),
        executableName: require('./package.json').productName,
        appBundleId: 'dev.openspec.gui',
        appCategoryType: 'public.app-category.developer-tools',
        ignore: [
            /^\/\.agents(?:\/|$)/,
            /^\/\.claude(?:\/|$)/,
            /^\/openspec(?:\/|$)/,
            /^\/artifacts(?:\/|$)/,
            /^\/out(?:\/|$)/,
            /^\/docs(?:\/|$)/,
            /^\/test(?:\/|$)/,
            /^\/scripts(?:\/|$)/
        ]
    },
    makers: [
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin']
        }
    ]
};
