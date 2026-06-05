// Closed-tab Web Push price alerts — Cloudflare Worker.
//
// Two responsibilities:
//   1. HTTP API (CORS JSON) the browser calls to register/update/remove
//      a push subscription + its price thresholds:
//        GET  /vapidPublicKey            → the VAPID public key (for subscribe)
//        POST /subscribe  {subscription, alerts}  → store in KV
//        POST /unsubscribe {endpoint}    → remove from KV
//        GET  /health
//   2. A cron (every minute) that walks every stored subscription, fetches
//      the live price for each armed symbol, and sends a Web Push when a
//      threshold crosses — then disarms that side (one-shot) so it doesn't
//      re-fire every minute.
//
// KV layout: key = `sub:<endpoint-hash>`, value = JSON
//   { subscription, alerts: { "BTC-USD": {above, below}, ... }, updatedAt }
//
// Web Push (VAPID + aes128gcm) is implemented with WebCrypto only — no npm
// push library — so it runs on the Workers runtime as-is.

const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { headers: JSON_HEADERS });

        try {
            if (url.pathname === '/health') return json({ ok: true, ts: Date.now() });

            if (url.pathname === '/vapidPublicKey') {
                return json({ key: env.VAPID_PUBLIC_KEY || null });
            }

            if (url.pathname === '/subscribe' && request.method === 'POST') {
                const body = await request.json();
                const sub = body?.subscription;
                const alerts = body?.alerts || {};
                if (!sub?.endpoint) return json({ error: 'subscription.endpoint required' }, 400);
                const id = await hashEndpoint(sub.endpoint);
                const reg = await loadRegistry(env);
                reg[id] = { subscription: sub, alerts, updatedAt: Date.now() };
                await saveRegistry(env, reg);
                return json({ ok: true, stored: Object.keys(alerts).length, subscribers: Object.keys(reg).length });
            }

            if (url.pathname === '/unsubscribe' && request.method === 'POST') {
                const body = await request.json();
                const endpoint = body?.endpoint;
                if (!endpoint) return json({ error: 'endpoint required' }, 400);
                const id = await hashEndpoint(endpoint);
                const reg = await loadRegistry(env);
                if (reg[id]) { delete reg[id]; await saveRegistry(env, reg); }
                return json({ ok: true });
            }

            return json({ error: 'not found' }, 404);
        } catch (e) {
            return json({ error: e.message || 'worker error' }, 500);
        }
    },

    // Cron entrypoint — fires on the schedule in wrangler.toml.
    async scheduled(event, env, ctx) {
        ctx.waitUntil(checkAllAlerts(env));
    },
};

// ── subscription registry (ONE KV key) ────────────────────────────────
// All subscriptions live under a single key so the per-minute cron costs
// exactly ONE read (and a write only when something fires), instead of a
// list() + N gets. KV free tier: 100K reads/day but only 1K LIST/day —
// the original list()-every-minute design blew the LIST quota (1,440/day)
// regardless of subscriber count. Single-key get() avoids list() entirely.
// Map shape: { [endpointHash]: { subscription, alerts, updatedAt } }.
const REGISTRY_KEY = 'registry';

async function loadRegistry(env) {
    try {
        const raw = await env.ALERTS_KV.get(REGISTRY_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}
async function saveRegistry(env, reg) {
    await env.ALERTS_KV.put(REGISTRY_KEY, JSON.stringify(reg));
}

// ── price fetching ───────────────────────────────────────────────────

// Crypto (…-USD) → Binance real-time. Stocks → Stooq (≈15-min delayed,
// the free-data limit). Returns a number or null.
async function fetchLivePrice(symbol) {
    const s = String(symbol).toUpperCase();
    const cryptoMatch = s.match(/^([A-Z0-9]+)-USD$/);
    if (cryptoMatch) {
        try {
            const pair = `${cryptoMatch[1]}USDT`;
            const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
            if (!r.ok) return null;
            const j = await r.json();
            const p = parseFloat(j.price);
            return Number.isFinite(p) ? p : null;
        } catch (_) { return null; }
    }
    // Stock via Stooq CSV.
    try {
        const stooqSym = s.includes('.') ? s.toLowerCase() : `${s.toLowerCase()}.us`;
        const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`);
        if (!r.ok) return null;
        const text = await r.text();
        const lines = text.trim().split('\n');
        if (lines.length < 2) return null;
        const cols = lines[1].split(',');
        const close = parseFloat(cols[6]);
        return Number.isFinite(close) && close > 0 ? close : null;
    } catch (_) { return null; }
}

// ── cron: check every subscription's armed thresholds ──────────────────

async function checkAllAlerts(env) {
    // ONE read per tick — the whole registry under a single key. No list().
    const reg = await loadRegistry(env);
    const ids = Object.keys(reg);
    if (!ids.length) return;

    // Union of symbols across all subs so each price is fetched ONCE per
    // tick, not per-subscriber.
    const symbolSet = new Set();
    for (const id of ids) {
        const alerts = reg[id]?.alerts;
        if (alerts) for (const sym of Object.keys(alerts)) symbolSet.add(sym);
    }
    if (!symbolSet.size) return;

    const prices = {};
    await Promise.all([...symbolSet].map(async (sym) => {
        prices[sym] = await fetchLivePrice(sym);
    }));

    let dirty = false;   // only write the registry back if something changed
    for (const id of ids) {
        const rec = reg[id];
        if (!rec?.alerts) continue;
        let removeSub = false;
        for (const [sym, thr] of Object.entries(rec.alerts)) {
            const price = prices[sym];
            if (price == null) continue;
            let fired = null;
            if (thr.above != null && price >= thr.above) fired = { dir: 'above', level: thr.above };
            else if (thr.below != null && price <= thr.below) fired = { dir: 'below', level: thr.below };
            if (fired) {
                const ok = await sendPush(env, rec.subscription, {
                    title: `${sym} ${fired.dir === 'above' ? '↑' : '↓'} ${formatPrice(price)}`,
                    body: `Crossed ${fired.dir} your alert at ${formatPrice(fired.level)}.`,
                    tag: `ma-price-${sym}-${fired.dir}`,
                    data: { symbol: sym, price },
                });
                if (ok === 'gone') { removeSub = true; break; }
                // One-shot: clear the side that fired so it doesn't repeat.
                if (fired.dir === 'above') thr.above = null; else thr.below = null;
                if (thr.above == null && thr.below == null) delete rec.alerts[sym];
                dirty = true;
            }
        }
        if (removeSub) { delete reg[id]; dirty = true; continue; }
        // Drop subs that have no armed alerts left so the registry stays lean.
        if (rec.alerts && Object.keys(rec.alerts).length === 0) { delete reg[id]; dirty = true; }
    }

    if (dirty) await saveRegistry(env, reg);
}

function formatPrice(p) {
    if (!Number.isFinite(p)) return '—';
    if (p >= 1000) return '$' + p.toFixed(2);
    if (p >= 1) return '$' + p.toFixed(3);
    if (p >= 0.01) return '$' + p.toFixed(4);
    return '$' + p.toFixed(8);
}

// ── Web Push (VAPID + aes128gcm) via WebCrypto ─────────────────────────
// Returns true on success, 'gone' if the subscription is dead (404/410)
// so the caller can prune it, false on other failures.

async function sendPush(env, subscription, payloadObj) {
    try {
        const payload = new TextEncoder().encode(JSON.stringify(payloadObj));
        const encrypted = await encryptPayload(subscription, payload);
        const audience = new URL(subscription.endpoint).origin;
        const jwt = await makeVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

        const res = await fetch(subscription.endpoint, {
            method: 'POST',
            headers: {
                'TTL': '86400',
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
            },
            body: encrypted,
        });
        if (res.status === 404 || res.status === 410) return 'gone';
        return res.ok;
    } catch (_) {
        return false;
    }
}

// VAPID JWT: ES256-signed { aud, exp, sub }. Key is the VAPID private key
// (base64url raw d). We import it as a P-256 private key for signing.
async function makeVapidJwt(audience, subject, publicKeyB64, privateKeyB64) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64url(JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: subject || 'mailto:noreply@example.com',
    }));
    const unsigned = `${header}.${body}`;
    const key = await importVapidPrivateKey(privateKeyB64, publicKeyB64);
    const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)
    );
    return `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;
}

// Import the raw 32-byte VAPID private scalar (d) + the 65-byte public
// point into a JWK so WebCrypto can sign with it.
async function importVapidPrivateKey(privateKeyB64, publicKeyB64) {
    const d = b64urlDecode(privateKeyB64);
    const pub = b64urlDecode(publicKeyB64);   // 65 bytes: 0x04 || X(32) || Y(32)
    const x = pub.slice(1, 33);
    const y = pub.slice(33, 65);
    const jwk = {
        kty: 'EC', crv: 'P-256',
        d: b64urlBytes(d), x: b64urlBytes(x), y: b64urlBytes(y),
        ext: true,
    };
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// aes128gcm payload encryption (RFC 8291). Derives a shared secret via
// ECDH between an ephemeral key and the subscription's p256dh, runs the
// HKDF ladder, and AES-GCM-encrypts the payload with the RFC-8188 header.
async function encryptPayload(subscription, payload) {
    const clientPub = b64urlDecode(subscription.keys.p256dh);  // 65 bytes
    const authSecret = b64urlDecode(subscription.keys.auth);   // 16 bytes

    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephemeralPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey)); // 65 bytes

    const clientKey = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256);
    const sharedSecret = new Uint8Array(sharedBits);

    // PRK_key = HKDF(auth, sharedSecret, "WebPush: info\0"||clientPub||serverPub, 32)
    const keyInfo = concat(
        new TextEncoder().encode('WebPush: info\0'), clientPub, ephemeralPubRaw
    );
    const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(salt, ikm, concat(new TextEncoder().encode('Content-Encoding: aes128gcm\0')), 16);
    const nonce = await hkdf(salt, ikm, concat(new TextEncoder().encode('Content-Encoding: nonce\0')), 12);

    // RFC 8188 body: salt(16) || rs(4, big-endian) || idlen(1) || keyid(idlen) || ciphertext
    const recordSize = 4096;
    const rs = new Uint8Array(4);
    new DataView(rs.buffer).setUint32(0, recordSize, false);
    const header = concat(salt, rs, new Uint8Array([ephemeralPubRaw.length]), ephemeralPubRaw);

    // Plaintext gets a 0x02 delimiter (last record) appended per RFC 8291.
    const plaintext = concat(payload, new Uint8Array([0x02]));
    const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce }, aesKey, plaintext
    ));
    return concat(header, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
    const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
    );
    return new Uint8Array(bits);
}

// ── small helpers ──────────────────────────────────────────────────────

function concat(...arrs) {
    const len = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
}
function b64url(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function b64urlBytes(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
async function hashEndpoint(endpoint) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
    return b64urlBytes(new Uint8Array(digest)).slice(0, 24);
}
