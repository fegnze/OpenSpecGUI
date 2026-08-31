'use strict';

var path = require('node:path');

module.exports = {
    packagerConfig: {
        asar: true,
        overwrite: true,
        icon: path.resolve(__dirname, 'assets', 'app-icon.icns'),
        executableName: 'OpenSpec GUI',
        appBundleId: 'dev.openspec.gui',
        appCategoryType: 'public.app-category.developer-tools',
        ignore: [
            /^\/\.agents(?:\/|$)/,
            /^\/\.claude(?:\/|$)/,
            /^\/openspec(?:\/|$)/,
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
