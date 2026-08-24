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
        onChanged: function (callback) {
            var listener = function () { callback(); };
            ipcRenderer.on('workspace:changed', listener);
            return function () { ipcRenderer.removeListener('workspace:changed', listener); };
        }
    }),
    documents: Object.freeze({
        read: function (request) { return invoke('documents:read', request); }
    }),
    clipboard: Object.freeze({
        write: function (text) { return invoke('clipboard:write', { text: text }); }
    })
}));
