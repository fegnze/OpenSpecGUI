'use strict';

var electron = require('electron');
var path = require('node:path');
var url = require('node:url');
var ProjectRegistry = require('./project-registry').ProjectRegistry;
var WorkbenchService = require('./workbench-service').WorkbenchService;
var registerIpc = require('./ipc').registerIpc;

var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var clipboard = electron.clipboard;
var dialog = electron.dialog;
var ipcMain = electron.ipcMain;
var net = electron.net;
var protocol = electron.protocol;
var shell = electron.shell;
var appIconPath = path.resolve(__dirname, '..', '..', 'assets', 'app-icon.png');
var mainWindow = null;
var service = null;

if (process.env.OPENSPEC_GUI_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.OPENSPEC_GUI_USER_DATA));
}

protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

function isWithin(rootPath, targetPath) {
    var relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function registerAppProtocol() {
    var rendererRoot = path.resolve(__dirname, '..', 'renderer');
    protocol.handle('app', function (request) {
        var requestUrl = new URL(request.url);
        var requestedPath = decodeURIComponent(requestUrl.pathname || '/index.html');
        var relativePath = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
        var target = path.resolve(rendererRoot, relativePath);
        if (requestUrl.host !== 'renderer' || !isWithin(rendererRoot, target)) {
            return new Response('Not found', { status: 404 });
        }
        return net.fetch(url.pathToFileURL(target).toString());
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        title: 'OpenSpec GUI',
        width: 1440,
        height: 930,
        minWidth: 820,
        minHeight: 640,
        icon: appIconPath,
        backgroundColor: '#eef1ef',
        show: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });

    mainWindow.webContents.setWindowOpenHandler(function (details) {
        if (/^https:\/\//i.test(details.url)) {
            shell.openExternal(details.url);
        }
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-attach-webview', function (event) { event.preventDefault(); });
    mainWindow.webContents.on('will-navigate', function (event, destination) {
        if (!destination.startsWith('app://renderer/')) {
            event.preventDefault();
        }
    });
    mainWindow.once('ready-to-show', function () { mainWindow.show(); });
    mainWindow.on('focus', async function () {
        if (service && await service.refreshIfChanged()) {
            mainWindow.webContents.send('workspace:changed');
        }
    });
    mainWindow.on('closed', function () { mainWindow = null; });
    mainWindow.loadURL('app://renderer/index.html');
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', function () {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async function () {
        registerAppProtocol();
        if (process.platform === 'darwin' && app.dock) {
            app.dock.setIcon(appIconPath);
        }
        electron.session.defaultSession.setPermissionCheckHandler(function () { return false; });
        electron.session.defaultSession.setPermissionRequestHandler(function (webContents, permission, callback) { callback(false); });
        var registry = new ProjectRegistry(path.join(app.getPath('userData'), 'projects.json'));
        service = new WorkbenchService(registry, {
            now: process.env.OPENSPEC_GUI_TEST_NOW || '',
            cliOptions: {
                command: process.env.OPENSPEC_GUI_CLI || '',
                bundledCommand: process.resourcesPath ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec') : ''
            }
        });
        await service.initialize();
        registerIpc({
            ipcMain: ipcMain,
            dialog: dialog,
            clipboard: clipboard,
            service: service,
            windowProvider: function () { return mainWindow; }
        });
        createWindow();

        app.on('activate', function () {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });

    app.on('window-all-closed', function () {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
}
