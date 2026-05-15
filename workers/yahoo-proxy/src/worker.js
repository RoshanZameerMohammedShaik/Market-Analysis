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
//
// Free tier limits: 100K req/day. We cache aggressively (60 min) per
// symbol on the Worker's edge KV-style memory.
//
// Deployment (one-time):
//   1. cd workers/yahoo-proxy
//   2. npm install -g wrangler
//   3. wrangler login
//   4. wrangler deploy
//   → prints the *.workers.dev URL; paste into js/penny-tier.js (WORKER_URL).

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 min
const memCache = new Map(); // symbol → { ts, body }

// Crumb cache. Yahoo crumbs typically last hours; we refetch every 30 min.
let crumbCache = null; // { crumb, cookie, ts }
const CRUMB_TTL_MS = 30 * 60 * 1000;

async function getCrumb() {
    if (crumbCache && Date.now() - crumbCache.ts < CRUMB_TTL_MS) {
        return crumbCache;
    }
    // Step 1: hit a Yahoo finance page to receive a session cookie.
    const homeRes = await fetch('https://fc.yahoo.com', {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Market-Analysis-Worker)' },
    });
    const cookieHeader = homeRes.headers.get('set-cookie') || '';
    // Extract just the A1=... bit; CF Workers concatenate Set-Cookie headers.
    const a1 = cookieHeader.match(/A1=[^;]+/)?.[0];
    if (!a1) throw new Error('failed to obtain Yahoo session cookie');

    // Step 2: fetch the crumb token using that cookie.
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Market-Analysis-Worker)',
            'Cookie': a1,
        },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 5) throw new Error('failed to obtain Yahoo crumb');

    crumbCache = { crumb, cookie: a1, ts: Date.now() };
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
            'User-Agent': 'Mozilla/5.0 (compatible; Market-Analysis-Worker)',
            'Cookie': cookie,
        },
    });
    if (!res.ok) {
        // Crumb may have rotated; bust cache and retry once.
        if (res.status === 401 || res.status === 403) {
            crumbCache = null;
            const retry = await getCrumb();
            const url2 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(retry.crumb)}`;
            const res2 = await fetch(url2, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Market-Analysis-Worker)',
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
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Max-Age': '86400',
            'Cache-Control': 'public, max-age=600',
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
