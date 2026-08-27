(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.OpenSpecInitiativeApps = api;
    }
}(typeof window === 'undefined' ? null : window, function () {
    'use strict';

    function InitiativeAppRegistry(apps) {
        this.apps = new Map();
        (apps || []).forEach(this.register.bind(this));
    }

    InitiativeAppRegistry.prototype.register = function (app) {
        if (!app || typeof app.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(app.id)) {
            throw new Error('Initiative App ID 无效');
        }
        if (this.apps.has(app.id) || typeof app.create !== 'function') {
            throw new Error('Initiative App 注册无效：' + app.id);
        }
        this.apps.set(app.id, app);
    };

    InitiativeAppRegistry.prototype.get = function (appId) {
        return this.apps.get(appId) || null;
    };

    function InitiativeAppHost(rootElement, registry, hostApi) {
        if (!rootElement || rootElement.nodeType !== 1) {
            throw new Error('Initiative App 挂载根无效');
        }
        this.root = rootElement;
        this.registry = registry;
        this.hostApi = Object.freeze(hostApi || {});
        this.current = null;
        this.generation = 0;
        this.returnFocus = null;
    }

    InitiativeAppHost.prototype.mount = async function (appId, context, returnFocus) {
        await this.dispose(false);
        var app = this.registry.get(appId);
        if (!app) {
            throw new Error('Initiative App 未安装：' + appId);
        }
        this.returnFocus = returnFocus && returnFocus.isConnected ? returnFocus : null;
        var generation = this.generation + 1;
        this.generation = generation;
        var mountRoot = this.root.ownerDocument.createElement('section');
        mountRoot.className = 'initiative-app-root';
        mountRoot.setAttribute('data-initiative-app', appId);
        this.root.replaceChildren(mountRoot);
        try {
            var instance = await app.create(Object.freeze({ root: mountRoot, api: this.hostApi, context: context }));
            if (generation !== this.generation) {
                if (instance && typeof instance.dispose === 'function') { await instance.dispose(); }
                return false;
            }
            if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') {
                throw new Error('Initiative App 必须实现 update/dispose');
            }
            this.current = { id: appId, instance: instance, root: mountRoot };
            if (typeof instance.mount === 'function') {
                await instance.mount(context);
            }
            return true;
        } catch (error) {
            if (generation === this.generation) {
                this.root.replaceChildren();
            }
            throw error;
        }
    };

    InitiativeAppHost.prototype.update = function (context) {
        if (!this.current) {
            return Promise.resolve(false);
        }
        var instance = this.current.instance;
        return Promise.resolve().then(function () {
            return instance.update(context);
        }).then(function () { return true; });
    };

    InitiativeAppHost.prototype.dispose = async function (restoreFocus) {
        this.generation += 1;
        var current = this.current;
        this.current = null;
        if (current) {
            try {
                await current.instance.dispose();
            } finally {
                if (current.root.isConnected) { current.root.remove(); }
            }
        }
        this.root.replaceChildren();
        if (restoreFocus !== false && this.returnFocus && this.returnFocus.isConnected) {
            this.returnFocus.focus();
        }
        this.returnFocus = null;
    };

    return {
        InitiativeAppHost: InitiativeAppHost,
        InitiativeAppRegistry: InitiativeAppRegistry
    };
}));
