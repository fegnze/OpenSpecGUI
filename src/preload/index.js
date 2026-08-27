'use strict';

var contextBridge = require('electron').contextBridge;
var ipcRenderer = require('electron').ipcRenderer;

function invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('openSpecGUI', Object.freeze({
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
