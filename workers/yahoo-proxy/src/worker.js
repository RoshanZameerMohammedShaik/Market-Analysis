// Yahoo Finance crumb-protected endpoint proxy.
//
// Yahoo's /v10/finance/quoteSummary now requires a `crumb` query param
// signed against a session cookie obtained from finance.yahoo.com.
// Browsers can't replay this through CORS proxies. This Worker fetches
// the crumb server-side (where CORS doesn't apply) and forwards the
// authenticated request, returning a clean JSON payload to the
// GitHub Pages frontend.
//
// What we expose:
//   GET /key-stats?symbol=BBAI
//     → { floatShares, sharesShort, shortPercentOfFloat, sharesOutstanding,
//          heldPercentInsiders, heldPercentInstitutions }
//   GET /health
//     → { ok: true, ts: <epoch> }
//
// Free tier limits: 100K req/day. We cache aggressively (60 min) per
// symbol on the Worker's edge memory. Crumb cached 30 min across all calls.
//
// Phase 6 fixes:
//   - Use headers.getSetCookie() (the proper API for multi-cookie responses
//     in Workers) instead of a single .get('set-cookie'). Cloudflare's fetch
//     concatenates multiple Set-Cookie headers into a single string, which
//     made A1=... extraction fail.
//   - Try multiple cookie sources (fc.yahoo.com, query1, finance.yahoo.com).
//   - Browser-realistic User-Agent so Yahoo doesn't bot-block us.
//   - Build a full cookie jar (A1 + A3 + B + GUC + cmp + EuConsent) instead
//     of just A1, since query2 sometimes requires multiple cookies present.
//   - NEVER set `Cache-Control: max-age` on error responses. A transient
//     bootstrapping failure was getting cached at the CF edge for 10 min,
//     so frontend calls returned stale 502 even after the Worker recovered.
//     Errors now ship `no-store, must-revalidate, max-age=0`.
//
// Deployment:
//   1. cd workers/yahoo-proxy
//   2. npm install -g wrangler
//   3. wrangler login   (or set $env:CLOUDFLARE_API_TOKEN)
//   4. wrangler deploy
//   → prints the *.workers.dev URL; paste into js/penny-tier.js (WORKER_URL).

const CACHE_TTL_MS = 60 * 60 * 1000;
const memCache = new Map();

let crumbCache = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

async function getCrumb() {
    if (crumbCache && Date.now() - crumbCache.ts < CRUMB_TTL_MS) {
        return crumbCache;
    }
    const cookieSources = [
        'https://fc.yahoo.com',
        'https://query1.finance.yahoo.com/v1/test/getcrumb',
        'https://finance.yahoo.com',
    ];

    let a1 = null;
    let cookieJar = null;
    for (const src of cookieSources) {
        try {
            const res = await fetch(src, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
            });
            let cookies = [];
            if (typeof res.headers.getSetCookie === 'function') {
                cookies = res.headers.getSetCookie();
            }
            if (!cookies.length) {
                const single = res.headers.get('set-cookie');
                if (single) cookies = [single];
            }
            const jar = [];
            for (const c of cookies) {
                const match = c.match(/^([A-Za-z0-9_-]+)=([^;]+)/);
                if (!match) continue;
                const [, name, value] = match;
                if (['A1', 'A3', 'A1S', 'B', 'GUC', 'cmp', 'EuConsent'].includes(name)) {
                    jar.push(`${name}=${value}`);
                    if (name === 'A1' || name === 'A3') a1 = `${name}=${value}`;
                }
            }
            if (jar.length) {
                cookieJar = jar.join('; ');
                if (a1) break;
            }
        } catch (_) { /* try next source */ }
    }

    if (!cookieJar) throw new Error('failed to obtain Yahoo session cookie');

    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Cookie': cookieJar,
            'Accept': 'text/plain,*/*;q=0.8',
        },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 5 || /<html/i.test(crumb)) {
        throw new Error(`failed to obtain Yahoo crumb (status ${crumbRes.status}, body len ${crumb.length})`);
    }

    crumbCache = { crumb, cookie: cookieJar, ts: Date.now() };
    return crumbCache;
}

async function fetchKeyStats(symbol) {
    const sym = symbol.toUpperCase();
    const cached = memCache.get(sym);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.body;

    const { crumb, cookie } = await getCrumb();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Cookie': cookie,
        },
    });
    if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
            crumbCache = null;
            const retry = await getCrumb();
            const url2 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(retry.crumb)}`;
            const res2 = await fetch(url2, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Cookie': retry.cookie,
                },
            });
            if (!res2.ok) throw new Error(`yahoo ${res2.status}`);
            const j = await res2.json();
            const body = extract(j);
            memCache.set(sym, { ts: Date.now(), body });
            return body;
        }
        throw new Error(`yahoo ${res.status}`);
    }
    const json = await res.json();
    const body = extract(json);
    memCache.set(sym, { ts: Date.now(), body });
    return body;
}

function num(field) {
    if (field == null) return null;
    if (typeof field === 'number') return field;
    if (typeof field === 'object' && 'raw' in field) return field.raw;
    return null;
}

function extract(json) {
    const stats = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!stats) return null;
    return {
        floatShares:             num(stats.floatShares),
        sharesShort:             num(stats.sharesShort),
        sharesShortPriorMonth:   num(stats.sharesShortPriorMonth),
        shortRatio:              num(stats.shortRatio),
        shortPercentOfFloat:     num(stats.shortPercentOfFloat),
        sharesOutstanding:       num(stats.sharesOutstanding),
        heldPercentInsiders:     num(stats.heldPercentInsiders),
        heldPercentInstitutions: num(stats.heldPercentInstitutions),
    };
}

function corsJson(body, status = 200) {
    // Only cache successful responses on the CF edge. Errors must NOT be
    // cached or a transient failure (e.g. crumb fetch hiccup) gets locked
    // in for 10 min on the user's region.
    const cacheControl = status === 200
        ? 'public, max-age=600'
        : 'no-store, no-cache, must-revalidate, max-age=0';
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Max-Age': '86400',
            'Cache-Control': cacheControl,
        },
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') {
            return corsJson({ ok: true });
        }
        if (url.pathname === '/key-stats') {
            const symbol = url.searchParams.get('symbol');
            if (!symbol) return corsJson({ error: 'symbol required' }, 400);
            try {
                const body = await fetchKeyStats(symbol);
                return corsJson(body || { error: 'no data' });
            } catch (e) {
                return corsJson({ error: String(e.message || e) }, 502);
            }
        }
        if (url.pathname === '/health') {
            return corsJson({ ok: true, ts: Date.now() });
        }
        return corsJson({ error: 'not found', endpoints: ['/key-stats?symbol=AAPL', '/health'] }, 404);
    },
};
