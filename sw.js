// Service Worker for Market Analyzer — closed-tab push notifications.
//
// Lives at the site ROOT so its scope covers the whole app (a SW can
// only control pages at or below its own path). Its ONLY job is push:
// it stays registered after the tab closes, wakes on an incoming Web
// Push from the push-alerts Cloudflare Worker, and shows the
// notification. No offline caching here — that's deliberate; we don't
// want a SW silently serving stale app shells while we ship frequently.

self.addEventListener('install', (event) => {
    // Activate immediately so a freshly-registered SW can receive pushes
    // without waiting for all old tabs to close.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
    const title = data.title || 'Market Analyzer';
    const options = {
        body: data.body || '',
        tag: data.tag || 'ma-price-alert',
        // Re-alert even if a notification with the same tag exists, so a
        // fresh cross is never silently swallowed.
        renotify: true,
        // No icon/badge file: the app ships its icon as an inline SVG
        // data-URI (no binary PNGs in the repo), and a missing ./icons/
        // path renders a broken glyph. Omitting lets the platform use its
        // default browser icon, which looks intentional rather than broken.
        data: data.data || {},
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an existing app tab (or opens one).
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of all) {
            if ('focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow('./');
    })());
});
