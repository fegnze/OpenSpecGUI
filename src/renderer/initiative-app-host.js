(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.OpenSpecInitiativeApps = api;
    }
}(typeof window === 'undefined' ? null : window, function (root) {
    'use strict';

    function EmbeddedInitiativeAppHost(rootElement, bridge, callbacks) {
        if (!rootElement || rootElement.nodeType !== 1) {
            throw new Error('Initiative App 占位区无效');
        }
        this.root = rootElement;
        this.bridge = bridge;
        this.callbacks = callbacks || {};
        this.instanceId = '';
        this.generation = 0;
        this.resizeObserver = null;
        this.frame = 0;
        this.visible = true;
        this.disposed = false;
        this.location = '';
        this.removeEventListener = bridge.onEvent(this.handleEvent.bind(this));
        this.handleWindowResize = this.scheduleBounds.bind(this);
        root.addEventListener('resize', this.handleWindowResize);
        root.document.addEventListener('scroll', this.handleWindowResize, true);
        if (root.visualViewport) {
            root.visualViewport.addEventListener('resize', this.handleWindowResize);
            root.visualViewport.addEventListener('scroll', this.handleWindowResize);
        }
    }

    EmbeddedInitiativeAppHost.prototype.handleEvent = function (event) {
        if (!event || event.instanceId !== this.instanceId) {
            return;
        }
        if (event.type === 'location') {
            this.location = event.location || '';
            if (typeof this.callbacks.onLocation === 'function') {
                this.callbacks.onLocation(this.location);
            }
        } else if (event.type === 'error' && typeof this.callbacks.onError === 'function') {
            this.visible = false;
            this.callbacks.onError(new Error(event.message || '独立 Initiative App 加载失败'));
        } else if (event.type === 'return-focus' && typeof this.callbacks.onReturnFocus === 'function') {
            this.callbacks.onReturnFocus();
        }
    };

    EmbeddedInitiativeAppHost.prototype.scheduleBounds = function () {
        var self = this;
        if (!this.instanceId || this.frame || this.disposed) {
            return;
        }
        this.frame = root.requestAnimationFrame(function () {
            self.frame = 0;
            self.syncBounds();
        });
    };

    EmbeddedInitiativeAppHost.prototype.syncBounds = function () {
        if (!this.instanceId || !this.root.isConnected || this.disposed) {
            return Promise.resolve(false);
        }
        var rect = this.root.getBoundingClientRect();
        var left = Math.max(0, rect.left);
        var top = Math.max(0, rect.top);
        var right = Math.min(root.innerWidth, rect.right);
        var bottom = Math.min(root.innerHeight, rect.bottom);
        return this.bridge.updateBounds({
            instanceId: this.instanceId,
            bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
            visible: this.visible && !document.hidden
        }).then(function (result) { return Boolean(result && result.applied); });
    };

    EmbeddedInitiativeAppHost.prototype.mount = async function (request) {
        var generation = this.generation + 1;
        var result;
        this.generation = generation;
        this.disposed = false;
        result = await this.bridge.mount(request);
        if (this.generation !== generation || this.disposed) {
            await this.bridge.dispose(result.instanceId);
            return false;
        }
        this.instanceId = result.instanceId;
        this.location = result.location || '';
        this.visible = true;
        if (typeof this.callbacks.onLocation === 'function') {
            this.callbacks.onLocation(this.location);
        }
        this.resizeObserver = new root.ResizeObserver(this.scheduleBounds.bind(this));
        this.resizeObserver.observe(this.root);
        await this.syncBounds();
        return true;
    };

    EmbeddedInitiativeAppHost.prototype.setVisible = function (visible) {
        this.visible = visible === true;
        if (!this.instanceId) {
            return Promise.resolve({ applied: false });
        }
        if (this.visible) {
            this.scheduleBounds();
        }
        return this.bridge.setVisible({ instanceId: this.instanceId, visible: this.visible && !document.hidden });
    };

    EmbeddedInitiativeAppHost.prototype.focus = function () {
        if (!this.instanceId || !this.visible || this.disposed) {
            return Promise.resolve({ applied: false });
        }
        return this.bridge.focus(this.instanceId);
    };

    EmbeddedInitiativeAppHost.prototype.dispose = async function () {
        var instanceId = this.instanceId;
        this.generation += 1;
        this.disposed = true;
        this.instanceId = '';
        this.location = '';
        if (this.frame) {
            root.cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.removeEventListener) {
            this.removeEventListener();
            this.removeEventListener = null;
        }
        root.removeEventListener('resize', this.handleWindowResize);
        root.document.removeEventListener('scroll', this.handleWindowResize, true);
        if (root.visualViewport) {
            root.visualViewport.removeEventListener('resize', this.handleWindowResize);
            root.visualViewport.removeEventListener('scroll', this.handleWindowResize);
        }
        return this.bridge.dispose(instanceId || '');
    };

    return { EmbeddedInitiativeAppHost: EmbeddedInitiativeAppHost };
}));
