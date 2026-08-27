'use strict';

var crypto = require('node:crypto');
var protocolModule = require('./embedded-initiative-app-protocol');

var SCHEME = protocolModule.SCHEME;
var MAX_ROUTE_LENGTH = 2048;

function safeRelativeLocation(value) {
    var route = typeof value === 'string' ? value : '';
    var base = SCHEME + '://0123456789abcdef0123456789abcdef/';
    var parsed;
    var rawPath;
    var decodedPath;
    if (!route || route.charAt(0) !== '/' || route.length > MAX_ROUTE_LENGTH || /[\x00-\x1f\x7f\\]/.test(route) || /%(?![0-9a-f]{2})/i.test(route)) {
        return '';
    }
    rawPath = route.split(/[?#]/)[0];
    if (/%(?:00|2e|2f|5c)/i.test(rawPath)) {
        return '';
    }
    try {
        decodedPath = decodeURIComponent(rawPath);
    } catch (error) {
        return '';
    }
    if (decodedPath.split('/').some(function (segment) { return segment === '.' || segment === '..'; })) {
        return '';
    }
    try {
        parsed = new URL(route, base);
    } catch (error) {
        return '';
    }
    if (parsed.origin !== new URL(base).origin || parsed.username || parsed.password) {
        return '';
    }
    return parsed.pathname + parsed.search + parsed.hash;
}

function clampBounds(value, contentSize) {
    var input = value && typeof value === 'object' ? value : {};
    var maxWidth = Math.max(0, Math.floor(Number(contentSize[0]) || 0));
    var maxHeight = Math.max(0, Math.floor(Number(contentSize[1]) || 0));
    var x = Math.max(0, Math.min(maxWidth, Math.round(Number(input.x) || 0)));
    var y = Math.max(0, Math.min(maxHeight, Math.round(Number(input.y) || 0)));
    var width = Math.max(0, Math.min(maxWidth - x, Math.round(Number(input.width) || 0)));
    var height = Math.max(0, Math.min(maxHeight - y, Math.round(Number(input.height) || 0)));
    return { x: x, y: y, width: width, height: height };
}

function sameInstanceOrigin(instance, targetUrl) {
    try {
        var parsed = new URL(targetUrl);
        return parsed.protocol === SCHEME + ':' && parsed.hostname === instance.id && parsed.host === instance.id &&
            !parsed.username && !parsed.password && !parsed.port && protocolModule.rawAuthority(targetUrl) === instance.id;
    } catch (error) {
        return false;
    }
}

function EmbeddedInitiativeAppHost(options) {
    this.WebContentsView = options.WebContentsView;
    this.session = options.session;
    this.service = options.service;
    this.protocol = options.protocol;
    this.windowProvider = options.windowProvider;
    this.current = null;
    this.generation = 0;
}

EmbeddedInitiativeAppHost.prototype.send = function (instance, type, details) {
    var window = this.windowProvider();
    if (!window || window.isDestroyed() || !instance || instance.generation !== this.generation) {
        return;
    }
    window.webContents.send('initiative-app:event', Object.assign({
        instanceId: instance.id,
        type: type
    }, details || {}));
};

EmbeddedInitiativeAppHost.prototype.configureSession = function (appSession, instance) {
    var downloadHandler = function (event) { event.preventDefault(); };
    var requestHandler = function (details, callback) {
        callback({ cancel: !sameInstanceOrigin(instance, details.url) });
    };
    appSession.setPermissionCheckHandler(function () { return false; });
    appSession.setPermissionRequestHandler(function (webContents, permission, callback) { callback(false); });
    appSession.on('will-download', downloadHandler);
    appSession.webRequest.onBeforeRequest({
        urls: ['*://*/*', SCHEME + '://*/*']
    }, requestHandler);
    return function () {
        appSession.setPermissionCheckHandler(null);
        appSession.setPermissionRequestHandler(null);
        appSession.removeListener('will-download', downloadHandler);
        appSession.webRequest.onBeforeRequest(null);
    };
};

EmbeddedInitiativeAppHost.prototype.bindViewEvents = function (instance) {
    var self = this;
    var webContents = instance.view.webContents;

    function reportLocation(targetUrl) {
        if (!sameInstanceOrigin(instance, targetUrl)) {
            return;
        }
        var parsed = new URL(targetUrl);
        var location = safeRelativeLocation(parsed.pathname + parsed.search + parsed.hash);
        if (location) {
            self.send(instance, 'location', { location: location });
        }
    }

    webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
    webContents.on('will-attach-webview', function (event) { event.preventDefault(); });
    webContents.on('will-navigate', function (event, destination) {
        if (!sameInstanceOrigin(instance, destination)) {
            event.preventDefault();
        }
    });
    webContents.on('will-redirect', function (event, destination) {
        if (!sameInstanceOrigin(instance, destination)) {
            event.preventDefault();
        }
    });
    webContents.on('will-frame-navigate', function (event, destination) {
        if (!sameInstanceOrigin(instance, destination)) {
            event.preventDefault();
        }
    });
    webContents.on('did-navigate', function (event, destination) { reportLocation(destination); });
    webContents.on('did-navigate-in-page', function (event, destination) { reportLocation(destination); });
    webContents.on('focus', function () {
        self.send(instance, 'focus', { focused: true });
    });
    webContents.on('blur', function () {
        self.send(instance, 'focus', { focused: false });
    });
    webContents.on('before-input-event', function (event, input) {
        var window;
        if (!input || input.type !== 'keyDown' || input.key !== 'F6' || input.alt || input.control || input.meta || input.shift) {
            return;
        }
        event.preventDefault();
        window = self.windowProvider();
        if (window && !window.isDestroyed()) {
            window.webContents.focus();
            self.send(instance, 'return-focus');
        }
    });
    webContents.on('did-fail-load', function (event, errorCode, errorDescription, validatedUrl, isMainFrame) {
        if (isMainFrame && errorCode !== -3) {
            instance.view.setVisible(false);
            self.send(instance, 'error', { code: 'LOAD_FAILED', message: errorDescription || '独立应用加载失败' });
            self.dispose(instance.id);
        }
    });
    webContents.on('render-process-gone', function (event, details) {
        instance.view.setVisible(false);
        self.send(instance, 'error', { code: 'RENDER_PROCESS_GONE', message: '独立应用渲染进程已退出：' + (details.reason || 'unknown') });
        self.dispose(instance.id);
    });
    webContents.on('unresponsive', function () {
        instance.view.setVisible(false);
        self.send(instance, 'error', { code: 'UNRESPONSIVE', message: '独立应用没有响应' });
        self.dispose(instance.id);
    });
};

EmbeddedInitiativeAppHost.prototype.mount = async function (request) {
    var generation = this.generation + 1;
    var prepared;
    var window;
    var instanceId;
    var appSession;
    var view;
    var instance;
    var route;
    this.generation = generation;
    await this.releaseCurrent();
    if (this.generation !== generation) {
        var superseded = new Error('独立应用挂载请求已失效');
        superseded.code = 'STALE_APP_MOUNT';
        throw superseded;
    }
    prepared = await this.service.prepareEmbeddedInitiativeApp(request);
    if (this.generation !== generation) {
        var stale = new Error('独立应用挂载请求已失效');
        stale.code = 'STALE_APP_MOUNT';
        throw stale;
    }
    window = this.windowProvider();
    if (!window || window.isDestroyed()) {
        throw new Error('主窗口不可用');
    }
    instanceId = crypto.randomBytes(16).toString('hex');
    appSession = this.session.fromPartition('openspec-initiative-app:' + instanceId, { cache: false });
    instance = {
        id: instanceId,
        generation: generation,
        projectId: request.projectId,
        revision: request.revision,
        providerId: request.providerId,
        initiativeId: request.initiativeId,
        manifestHash: prepared.manifestHash,
        sourceHash: prepared.sourceHash,
        files: prepared.files,
        actions: prepared.actions,
        entry: prepared.entry,
        session: appSession,
        view: null,
        visible: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 }
    };
    this.protocol.register(instance);
    this.current = instance;
    try {
        await appSession.protocol.handle(SCHEME, this.protocol.handle.bind(this.protocol));
        instance.sessionCleanup = this.configureSession(appSession, instance);
        view = new this.WebContentsView({
            webPreferences: {
                session: appSession,
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                nodeIntegrationInWorker: false,
                webSecurity: true,
                webviewTag: false,
                allowRunningInsecureContent: false,
                navigateOnDragDrop: false,
                spellcheck: false
            }
        });
        instance.view = view;
        this.bindViewEvents(instance);
        view.setVisible(false);
        window.contentView.addChildView(view);
        route = safeRelativeLocation(request.location) || '/' + prepared.entry;
        await view.webContents.loadURL(SCHEME + '://' + instanceId + route);
        if (this.current !== instance || this.generation !== generation) {
            throw new Error('独立应用挂载请求已失效');
        }
        var actualUrl = view.webContents.getURL();
        if (!sameInstanceOrigin(instance, actualUrl)) {
            throw new Error('独立应用加载到了无效 origin');
        }
        var actualLocation = new URL(actualUrl);
        route = safeRelativeLocation(actualLocation.pathname + actualLocation.search + actualLocation.hash);
        if (!route) {
            throw new Error('独立应用位置超过宿主保存边界');
        }
    } catch (error) {
        if (this.current === instance) {
            await this.releaseCurrent(instance.id);
        }
        throw error;
    }
    return { instanceId: instanceId, location: route };
};

EmbeddedInitiativeAppHost.prototype.updateBounds = function (request) {
    var instance = this.current;
    var window = this.windowProvider();
    if (!instance || request.instanceId !== instance.id || !window || window.isDestroyed()) {
        return { applied: false };
    }
    instance.bounds = clampBounds(request.bounds, window.getContentSize());
    instance.view.setBounds(instance.bounds);
    instance.visible = request.visible !== false && instance.bounds.width > 0 && instance.bounds.height > 0;
    instance.view.setVisible(instance.visible);
    return { applied: true, bounds: instance.bounds };
};

EmbeddedInitiativeAppHost.prototype.setVisible = function (request) {
    var instance = this.current;
    if (!instance || request.instanceId !== instance.id) {
        return { applied: false };
    }
    instance.visible = request.visible === true && instance.bounds.width > 0 && instance.bounds.height > 0;
    instance.view.setVisible(instance.visible);
    return { applied: true };
};

EmbeddedInitiativeAppHost.prototype.focus = function (instanceId) {
    var instance = this.current;
    var window = this.windowProvider();
    if (!instance || instanceId !== instance.id || !instance.visible || !window || window.isDestroyed() || instance.view.webContents.isDestroyed && instance.view.webContents.isDestroyed()) {
        return { applied: false };
    }
    window.focus();
    instance.view.webContents.focus();
    return { applied: instance.view.webContents.isFocused() };
};

EmbeddedInitiativeAppHost.prototype.releaseCurrent = async function (instanceId) {
    var instance = this.current;
    var window = this.windowProvider();
    if (instanceId && (!instance || instanceId !== instance.id)) {
        return { disposed: false };
    }
    this.current = null;
    if (!instance) {
        return { disposed: false };
    }
    try { instance.view.setVisible(false); } catch (error) { /* View may already be destroyed. */ }
    if (window && !window.isDestroyed()) {
        try { window.contentView.removeChildView(instance.view); } catch (error) { /* View may already be detached. */ }
    }
    try { instance.view.webContents.close(); } catch (error) { /* Renderer may already be gone. */ }
    try { if (instance.sessionCleanup) { instance.sessionCleanup(); } } catch (error) { /* Session hooks may already be released. */ }
    try { await instance.session.protocol.unhandle(SCHEME); } catch (error) { /* Session may already be released. */ }
    this.protocol.unregister(instance.id);
    instance.files.clear();
    return { disposed: true };
};

EmbeddedInitiativeAppHost.prototype.dispose = function (instanceId) {
    var instance = this.current;
    if (instanceId && (!instance || instanceId !== instance.id)) {
        return Promise.resolve({ disposed: false });
    }
    this.generation += 1;
    return this.releaseCurrent(instanceId);
};

module.exports = {
    EmbeddedInitiativeAppHost: EmbeddedInitiativeAppHost,
    MAX_ROUTE_LENGTH: MAX_ROUTE_LENGTH,
    clampBounds: clampBounds,
    safeRelativeLocation: safeRelativeLocation,
    sameInstanceOrigin: sameInstanceOrigin
};
