'use strict';

var electron = require('electron');
var HostIntegration = require('./host-integration').HostIntegration;
var path = require('node:path');
var url = require('node:url');
var ProjectRegistry = require('./project-registry').ProjectRegistry;
var WorkbenchService = require('./workbench-service').WorkbenchService;
var createDefaultInitiativeRegistry = require('../core/initiative-providers').createDefaultInitiativeRegistry;
var registerIpc = require('./ipc').registerIpc;
var setupAppUpdates = require('./app-update').setupAppUpdates;
var CapabilityProjectServices = require('./capability-project-services').CapabilityProjectServices;
var CapabilityRegistry = require('./capability-registry').CapabilityRegistry;
var EmbeddedInitiativeAppHost = require('./embedded-initiative-app-host').EmbeddedInitiativeAppHost;
var EmbeddedInitiativeAppProtocol = require('./embedded-initiative-app-protocol').EmbeddedInitiativeAppProtocol;
var INITIATIVE_APP_SCHEME = require('./embedded-initiative-app-protocol').SCHEME;

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
var embeddedAppHost = null;
var backgroundTools = process.argv.includes('--workbench-document-tools');
var uiReady = false;
var toolIdleTimer;
var pendingToolCalls = 0;

function scheduleToolExit() {
    clearTimeout(toolIdleTimer);
    if (backgroundTools && !pendingToolCalls) { toolIdleTimer = setTimeout(function () { if (backgroundTools) { app.quit(); } }, 30000); }
}

// Electron 在主脚本加载后、ready 之前用 app.name 选择系统密钥库。沿用已发布的
// 身份读取旧授权，同时让新旧应用共用单实例锁、会话和项目数据。
var storageName = 'OpenSpec GUI';
var productName = require('../../package.json').productName;
app.setName(storageName);
var dataDirectory = process.env.OPENSPEC_GUI_USER_DATA
    ? path.resolve(process.env.OPENSPEC_GUI_USER_DATA) : path.join(app.getPath('appData'), storageName);
app.setPath('userData', dataDirectory);
app.setPath('sessionData', dataDirectory);
// 密钥库初始化后，先于 Electron 建立系统菜单时恢复可见名称。
app.prependOnceListener('will-finish-launching', function () { app.setName(productName); });

protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}, {
    scheme: INITIATIVE_APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
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
        title: productName,
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
    mainWindow.on('close', function (event) {
        if (service && service.archiveService.busy) { event.preventDefault(); return; }
        if (service) { service.archiveService.invalidate(); }
        if (embeddedAppHost) { embeddedAppHost.dispose(); }
    });
    mainWindow.on('closed', function () { mainWindow = null; });
    mainWindow.loadURL('app://renderer/index.html');
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', function (_event, argv) {
        if (argv.includes('--workbench-document-tools')) { return; }
        backgroundTools = false;
        if (!mainWindow && uiReady) { createWindow(); }
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
            archiveOptions: { getArchivePolicy: function (root) {
                return require('./archive-binding-policy').readArchivePolicy(app.getPath('userData'), root);
            } },
            initiativeRegistry: createDefaultInitiativeRegistry(),
            cliOptions: {
                command: process.env.OPENSPEC_GUI_CLI || '',
                bundledCommand: process.resourcesPath ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec') : ''
            }
        });
        await service.initialize();
        var embeddedProtocol = new EmbeddedInitiativeAppProtocol({ service: service, shell: shell });
        embeddedAppHost = new EmbeddedInitiativeAppHost({
            WebContentsView: electron.WebContentsView,
            session: electron.session,
            service: service,
            protocol: embeddedProtocol,
            windowProvider: function () { return mainWindow; }
        });
        var connectionOptions = { userDataPath: app.getPath('userData'), safeStorage: electron.safeStorage, openExternal: function (url) { return shell.openExternal(url); } };
        var capabilities = new CapabilityRegistry({ userDataPath: app.getPath('userData'), getActive: function () { return registry.getActive(); } });
        try { await capabilities.load(); }
        catch (error) {
            dialog.showErrorBox('无法载入本机能力登记', '请检查工作台用户目录的权限与登记文件后重试。' + '\n' + error.message);
            app.quit();
            return;
        }
        service.options.onInvalidate = function () {
            embeddedAppHost.dispose();
            capabilities.invalidate();
        };
        var projectServices = new CapabilityProjectServices(Object.assign({}, connectionOptions, { getActive: function () { return registry.getActive(); } }));
        var userDataPath = app.getPath('userData');
        try {
            var startDocumentService = require('./document-tool-broker').listen;
            var broker = await startDocumentService(userDataPath, async function (host, input, signal) {
                pendingToolCalls += 1;
                clearTimeout(toolIdleTimer);
                try { return await require('./agent-document-tools').execute(userDataPath, projectServices, host, input, signal); }
                finally { pendingToolCalls -= 1; scheduleToolExit(); }
            });
            app.once('will-quit', function () { broker.close(); });
        } catch (error) { console.error('文档工具服务启动失败', error.message); }
        app.once('will-quit', function () { projectServices.dispose(); });
        var hostIntegration = new HostIntegration({ userDataPath: userDataPath, getActive: function () { return registry.getActive(); },
            maintainInstalledPaths: app.isPackaged });
        await hostIntegration.refreshInstalledPaths();
        registerIpc({
            ipcMain: ipcMain,
            dialog: dialog,
            clipboard: clipboard,
            service: service,
            embeddedAppHost: embeddedAppHost,
            capabilities: capabilities,
            hostIntegration: hostIntegration,
            projectServices: projectServices,
            revealFile: function (file) { shell.showItemInFolder(file); },
            windowProvider: function () { return mainWindow; }
        });
        uiReady = true;
        if (!backgroundTools && !mainWindow) { createWindow(); }
        scheduleToolExit();
        setupAppUpdates({
            electron: electron,
            base: require('../../package.json').openspecGUIUpdateBaseURL,
            archiveBusy: function () { return service.archiveService.busy || service.archiveService.preparing > 0; }
        });

        app.on('before-quit', function (event) {
            if (service.archiveService.busy) {
                event.preventDefault();
                var pending = Array.from(service.archiveService.plans.values()).filter(function (entry) { return entry.promise; }).map(function (entry) { return entry.promise; });
                Promise.allSettled(pending).then(function () { app.quit(); });
            } else { service.archiveService.invalidate(); }
        });

        app.on('activate', function () {
            backgroundTools = false;
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
