(function () {
    window.GRSAI_STATIC_DEPLOY = true;

    function showStaticToast(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
            return;
        }
        console[type === 'error' ? 'error' : 'log'](message);
    }

    function installAuditEndpoint() {
        if (window.AdminAuditClient) {
            window.AdminAuditClient.endpoint = window.GRSAI_ADMIN_AUDIT_ENDPOINT || '/api/admin/generation-log';
        }
    }

    function installFetchGuard() {
        if (window.__grsaiStaticFetchGuardInstalled) return;
        window.__grsaiStaticFetchGuardInstalled = true;
        const originalFetch = window.fetch.bind(window);
        const blockedApiPrefixes = [
            '/api/upload',
            '/api/generate',
            '/api/task',
            '/api/file',
            '/outputs/',
            '/uploads/'
        ];

        window.fetch = function staticDeployFetch(input, init) {
            const url = typeof input === 'string' ? input : input?.url;
            if (url) {
                let path = url;
                try { path = new URL(url, window.location.href).pathname; } catch (error) { /* keep raw url */ }
                if (blockedApiPrefixes.some(prefix => path === prefix || path.startsWith(prefix))) {
                    showStaticToast('静态版不支持旧服务器接口，请刷新后使用浏览器本地图库与直连生图流程。', 'error');
                    return Promise.resolve(new Response(JSON.stringify({ success: false, error: 'Server API is disabled in static deployment.' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }
            }
            return originalFetch(input, init);
        };
    }

    function boot() {
        installAuditEndpoint();
        installFetchGuard();
        window.setTimeout(installAuditEndpoint, 0);
        window.setTimeout(installAuditEndpoint, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
