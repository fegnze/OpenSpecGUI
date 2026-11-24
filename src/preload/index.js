'use strict';

var contextBridge = require('electron').contextBridge;
var ipcRenderer = require('electron').ipcRenderer;

function invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('openSpecGUI', Object.freeze({
    hosts: Object.freeze({
        inspect: function () { return ipcRenderer.invoke('hosts:inspect'); },
        verification: function () { return ipcRenderer.invoke('hosts:verification'); },
        records: function (request) { return invoke('hosts:records', request); },
        install: function (request) { return invoke('hosts:install', request); },
        remove: function (request) { return invoke('hosts:remove', request); }
    }),
    capabilities: Object.freeze({
        list: function (request) { return invoke('capabilities:list', request); },
        rename: function (request) { return invoke('capabilities:rename', request); },
        preview: function (request) { return invoke('capabilities:preview', request); },
        apply: function (request) { return invoke('capabilities:apply', request); },
        defectConfig: function (request) { return invoke('capabilities:defect-config', request); }
    }),
    connections: Object.freeze({
        status: function (request) { return invoke('connections:status', request); },
        connect: function (request) { return invoke('connections:connect', request); },
        cancelAuthorization: function (request) { return invoke('connections:cancelAuthorization', request); },
        reuse: function (request) { return invoke('connections:reuse', request); },
        verify: function (request) { return invoke('connections:verify', request); },
        disconnect: function (request) { return invoke('connections:disconnect', request); }
    }),
    projects: Object.freeze({
        list: function () { return invoke('projects:list'); },
        add: function (request) { return invoke('projects:add', request || {}); },
        scan: function (request) { return invoke('projects:scan', request || {}); },
        select: function (projectId) { return invoke('projects:select', { projectId: projectId }); },
        remove: function (projectId) { return invoke('projects:remove', { projectId: projectId }); },
        relink: function (projectId, path) { return invoke('projects:relink', { projectId: projectId, path: path }); }
    }),
    workspace: Object.freeze({
        load: function () { return invoke('workspace:load'); },
        refresh: function () { return invoke('workspace:refresh'); },
        checkUpdates: function () { return invoke('workspace:check-updates'); },
        onChanged: function (callback) {
            var listener = function () { callback(); };
            ipcRenderer.on('workspace:changed', listener);
            return function () { ipcRenderer.removeListener('workspace:changed', listener); };
        }
    }),
    changes: Object.freeze({
        prepareArchive: function (request) { return invoke('changes:prepare-archive', request); },
        commitArchive: function (request) { return invoke('changes:commit-archive', request); },
        discardArchive: function (request) { return invoke('changes:discard-archive', request); }
    }),
    attachments: Object.freeze({
        list: function (request) { return invoke('attachments:list', request); },
        read: function (request) { return invoke('attachments:read', request); }
    }),
    documents: Object.freeze({
        read: function (request) { return invoke('documents:read', request); }
    }),
    initiatives: Object.freeze({
        load: function (request) { return invoke('initiatives:load', request); },
        readArtifact: function (request) { return invoke('initiatives:read-artifact', request); }
    }),
    initiativeApp: Object.freeze({
        mount: function (request) { return invoke('initiative-app:mount', request); },
        updateBounds: function (request) { return invoke('initiative-app:update-bounds', request); },
        setVisible: function (request) { return invoke('initiative-app:set-visible', request); },
        focus: function (instanceId) { return invoke('initiative-app:focus', { instanceId: instanceId || '' }); },
        dispose: function (instanceId) { return invoke('initiative-app:dispose', { instanceId: instanceId || '' }); },
        onEvent: function (callback) {
            var listener = function (event, payload) { callback(payload); };
            ipcRenderer.on('initiative-app:event', listener);
            return function () { ipcRenderer.removeListener('initiative-app:event', listener); };
        }
    }),
    clipboard: Object.freeze({
        write: function (text) { return invoke('clipboard:write', { text: text }); }
    })
}));
