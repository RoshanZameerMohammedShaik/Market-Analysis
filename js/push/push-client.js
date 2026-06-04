// Closed-tab push client. Bridges the browser's Push API to our
// push-alerts Cloudflare Worker so price alerts reach the user even
// when the app (and tab) is fully closed.
//
// Flow:
//   1. registerServiceWorker() — registers /sw.js (root scope).
//   2. enablePush() — asks notification permission, creates a Push
//      subscription with the worker's VAPID public key.
//   3. syncAlerts(alerts) — POSTs {subscription, alerts} to the worker,
//      which stores them in KV; the worker's cron then watches prices
//      and pushes on a cross.
//
// CONFIG: set PUSH_API to the deployed push-alerts worker URL after
// `wrangler deploy`. Until then push is inert (enablePush throws a clear
// error) — the tab-open crypto alerts in price-alerts.js still work
// regardless, so the app degrades gracefully.
//
// HONEST LIMITS (surfaced in the UI, not hidden here):
//   - Crypto = real-time (Binance, worker-side). Stocks ≈ 15-min delayed
//     (free data). The delay is the data's, not the architecture's.
//   - iOS only delivers Web Push when the app is added to the Home
//     Screen as a PWA (Apple rule, iOS 16.4+). Normal Safari tabs won't.

// Filled in after the push-alerts worker is deployed. Empty = push off.
const PUSH_API = 'https://market-analysis-push-alerts.roshanzameer7866.workers.dev';

let _swReg = null;
let _vapidKey = null;

export function isPushConfigured() {
    return !!PUSH_API;
}

export function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// iOS Safari only fires Web Push from an installed PWA (standalone mode).
export function iosNeedsInstall() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!isIos) return false;
    const standalone = window.navigator.standalone === true ||
        window.matchMedia?.('(display-mode: standalone)').matches;
    return !standalone;
}

export async function registerServiceWorker() {
    if (!isPushSupported()) return null;
    if (_swReg) return _swReg;
    try {
        _swReg = await navigator.serviceWorker.register('./sw.js');
        return _swReg;
    } catch (e) {
        console.warn('[push] SW registration failed:', e);
        return null;
    }
}

async function getVapidKey() {
    if (_vapidKey) return _vapidKey;
    const res = await fetch(`${PUSH_API}/vapidPublicKey`);
    const j = await res.json();
    if (!j.key) throw new Error('push backend has no VAPID key configured');
    _vapidKey = j.key;
    return _vapidKey;
}

function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// Ask permission + create/reuse a push subscription. Returns the
// PushSubscription, or throws with a user-friendly message.
export async function enablePush() {
    if (!isPushConfigured()) throw new Error('Closed-tab push isn\'t set up yet (no backend URL configured).');
    if (!isPushSupported()) throw new Error('This browser doesn\'t support background push.');
    if (iosNeedsInstall()) throw new Error('On iPhone, add this app to your Home Screen first — iOS only delivers push to installed apps.');

    const reg = await registerServiceWorker();
    if (!reg) throw new Error('Couldn\'t register the background service.');

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission was not granted.');

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
        const key = await getVapidKey();
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
        });
    }
    return sub;
}

// Push the current alert thresholds to the backend so the cron watches
// them. `alerts` shape: { "BTC-USD": {above, below}, ... }. Pass the
// subscription you got from enablePush().
export async function syncAlerts(subscription, alerts) {
    if (!isPushConfigured() || !subscription) return { ok: false, reason: 'push-not-configured' };
    const res = await fetch(`${PUSH_API}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, alerts }),
    });
    return res.json();
}

export async function disablePush() {
    if (!_swReg) return { ok: true };
    try {
        const sub = await _swReg.pushManager.getSubscription();
        if (sub) {
            if (isPushConfigured()) {
                await fetch(`${PUSH_API}/unsubscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: sub.endpoint }),
                }).catch(() => {});
            }
            await sub.unsubscribe();
        }
    } catch (_) {}
    return { ok: true };
}

// Convenience: get the active subscription if push is already enabled
// (so the watchlist can re-sync thresholds on change without re-prompting).
export async function getActiveSubscription() {
    if (!isPushSupported()) return null;
    const reg = await registerServiceWorker();
    if (!reg) return null;
    try { return await reg.pushManager.getSubscription(); } catch (_) { return null; }
}
