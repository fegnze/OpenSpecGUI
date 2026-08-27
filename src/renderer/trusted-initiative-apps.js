(function (root) {
    'use strict';

    var metrics = { mounts: 0, updates: 0, disposes: 0, routeRequests: 0 };

    function appendText(parent, tagName, text, className) {
        var element = parent.ownerDocument.createElement(tagName);
        element.textContent = text;
        if (className) { element.className = className; }
        parent.appendChild(element);
        return element;
    }

    var fixtureApp = {
        id: 'trusted-fixture-app',
        create: function (options) {
            var rootElement = options.root;
            var mounted = false;
            var disposed = false;

            function render(context) {
                if (disposed) { return; }
                var route = context.route || 'overview';
                if (route === 'failure') {
                    throw new Error('可信 App 测试异常');
                }
                var document = rootElement.ownerDocument;
                var panel = document.createElement('section');
                panel.className = 'trusted-fixture-app';
                panel.setAttribute('aria-labelledby', 'trusted-fixture-title');
                appendText(panel, 'span', 'CUSTOM INITIATIVE APP', 'initiative-kicker');
                var title = appendText(panel, 'h1', context.descriptor.title);
                title.id = 'trusted-fixture-title';
                appendText(panel, 'p', '当前子路由：' + route, 'trusted-fixture-route');
                var actions = document.createElement('div');
                actions.className = 'trusted-fixture-actions';
                ['overview', 'details', 'failure'].forEach(function (targetRoute) {
                    var button = document.createElement('button');
                    button.type = 'button';
                    button.className = targetRoute === 'failure' ? 'secondary-command' : 'segment-button';
                    button.setAttribute('data-fixture-route', targetRoute);
                    button.textContent = targetRoute === 'overview' ? '概览' : (targetRoute === 'details' ? '详情' : '触发异常');
                    actions.appendChild(button);
                });
                panel.appendChild(actions);
                rootElement.replaceChildren(panel);
            }

            function onClick(event) {
                var button = event.target.closest('[data-fixture-route]');
                if (button && rootElement.contains(button)) {
                    metrics.routeRequests += 1;
                    options.api.setRoute(button.getAttribute('data-fixture-route'));
                }
            }

            return {
                mount: function (context) {
                    metrics.mounts += 1;
                    if (!mounted) {
                        rootElement.addEventListener('click', onClick);
                        mounted = true;
                    }
                    render(context);
                },
                update: function (context) {
                    metrics.updates += 1;
                    render(context);
                },
                dispose: function () {
                    metrics.disposes += 1;
                    disposed = true;
                    if (mounted) { rootElement.removeEventListener('click', onClick); }
                    mounted = false;
                    rootElement.replaceChildren();
                }
            };
        }
    };

    var apps = [fixtureApp];
    if (root.OpenSpecResourceProgramApp) {
        apps.unshift(root.OpenSpecResourceProgramApp);
    }
    root.OpenSpecTrustedInitiativeApps = Object.freeze(apps);
    root.OpenSpecTrustedInitiativeAppMetrics = metrics;
}(window));
