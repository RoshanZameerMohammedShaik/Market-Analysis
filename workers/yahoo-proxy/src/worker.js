// Yahoo Finance crumb-protected endpoint proxy + auxiliary penny-stock data routes.
//
// Endpoints:
//   GET /key-stats?symbol=BBAI       — Yahoo defaultKeyStatistics (float, short interest)
//   GET /finra-short?symbol=BBAI     — FINRA daily short volume / total volume ratio
//   GET /openinsider?symbol=BBAI     — OpenInsider recent insider buy/sell rows
//   GET /health                       — health probe
//
// All endpoints return CORS-friendly JSON. Errors NEVER cache (we learned).
//
// Free tier: 100K req/day on CF Workers free plan.
//
// Why these endpoints live in the Worker:
//   - Yahoo /v10 needs server-side cookie+crumb dance
//   - FINRA serves daily CSVs from regulatorydata.finra.org with no CORS headers
//   - OpenInsider HTML is gzip + non-CORS; client-side fetch fails through proxies

const CACHE_TTL_MS = 60 * 60 * 1000;
const FINRA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // FINRA updates once a day
const INSIDER_CACHE_TTL_MS = 30 * 60 * 1000;

const keyStatsCache = new Map();
const finraCache = new Map();
const insiderCache = new Map();

let crumbCache = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ============================================================================
// /key-stats — Yahoo defaultKeyStatistics
// ============================================================================

async function getCrumb() {
    if (crumbCache && Date.now() - crumbCache.ts < CRUMB_TTL_MS) return crumbCache;
    const sources = ['https://fc.yahoo.com', 'https://query1.finance.yahoo.com/v1/test/getcrumb', 'https://finance.yahoo.com'];
    let a1 = null, jar = null;
    for (const src of sources) {
        try {
            const res = await fetch(src, {
                redirect: 'manual',
                headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.5' },
            });
            let cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
            if (!cookies.length) {
                const single = res.headers.get('set-cookie');
                if (single) cookies = [single];
            }
            const arr = [];
            for (const c of cookies) {
                const m = c.match(/^([A-Za-z0-9_-]+)=([^;]+)/);
                if (!m) continue;
                if (['A1', 'A3', 'A1S', 'B', 'GUC', 'cmp', 'EuConsent'].includes(m[1])) {
                    arr.push(`${m[1]}=${m[2]}`);
                    if (m[1] === 'A1' || m[1] === 'A3') a1 = `${m[1]}=${m[2]}`;
                }
            }
            if (arr.length) { jar = arr.join('; '); if (a1) break; }
        } catch (_) { /* */ }
    }
    if (!jar) throw new Error('failed to obtain Yahoo session cookie');
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': BROWSER_UA, 'Cookie': jar, 'Accept': 'text/plain' },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 5 || /<html/i.test(crumb)) {
        throw new Error(`failed to obtain Yahoo crumb (status ${crumbRes.status})`);
    }
    crumbCache = { crumb, cookie: jar, ts: Date.now() };
    return crumbCache;
}

async function fetchKeyStats(symbol) {
    const sym = symbol.toUpperCase();
    const cached = keyStatsCache.get(sym);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.body;

    const { crumb, cookie } = await getCrumb();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
    let res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } });
    if (!res.ok && (res.status === 401 || res.status === 403)) {
        crumbCache = null;
        const retry = await getCrumb();
        const url2 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(retry.crumb)}`;
        res = await fetch(url2, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': retry.cookie } });
    }
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const json = await res.json();
    const body = extractKeyStats(json);
    keyStatsCache.set(sym, { ts: Date.now(), body });
    return body;
}

function num(field) {
    if (field == null) return null;
    if (typeof field === 'number') return field;
    if (typeof field === 'object' && 'raw' in field) return field.raw;
    return null;
}

function extractKeyStats(json) {
    const stats = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!stats) return null;
    return {
        floatShares: num(stats.floatShares),
        sharesShort: num(stats.sharesShort),
        sharesShortPriorMonth: num(stats.sharesShortPriorMonth),
        shortRatio: num(stats.shortRatio),
        shortPercentOfFloat: num(stats.shortPercentOfFloat),
        sharesOutstanding: num(stats.sharesOutstanding),
        heldPercentInsiders: num(stats.heldPercentInsiders),
        heldPercentInstitutions: num(stats.heldPercentInstitutions),
    };
}

// ============================================================================
// /finra-short — FINRA daily short-volume CSV
// ============================================================================

let finraDayCache = null;

function yyyymmdd(d) {
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function getLatestFinraDay() {
    if (finraDayCache && Date.now() - finraDayCache.ts < FINRA_CACHE_TTL_MS) return finraDayCache;
    const today = new Date();
    for (let back = 1; back <= 6; back++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - back);
        const dateStr = yyyymmdd(d);
        const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
            if (!res.ok) continue;
            const text = await res.text();
            if (!text || text.length < 200) continue;
            const rows = new Map();
            const lines = text.split(/\r?\n/);
            for (let i = 1; i < lines.length; i++) {
                const p = lines[i].split('|');
                if (p.length < 5) continue;
                const sym = p[1]?.trim().toUpperCase();
                if (!sym) continue;
                rows.set(sym, {
                    short: parseInt(p[2], 10) || 0,
                    exempt: parseInt(p[3], 10) || 0,
                    total: parseInt(p[4], 10) || 0,
                });
            }
            if (rows.size < 100) continue;
            finraDayCache = { date: dateStr, rows, ts: Date.now() };
            return finraDayCache;
        } catch (_) { /* */ }
    }
    throw new Error('FINRA file not found in last 6 days');
}

async function fetchFinraShort(symbol) {
    const sym = symbol.toUpperCase();
    const cached = finraCache.get(sym);
    if (cached && Date.now() - cached.ts < FINRA_CACHE_TTL_MS) return cached.body;
    const day = await getLatestFinraDay();
    const row = day.rows.get(sym);
    if (!row) {
        const body = { date: day.date, found: false };
        finraCache.set(sym, { ts: Date.now(), body });
        return body;
    }
    const ratio = row.total > 0 ? row.short / row.total : null;
    const body = {
        date: day.date,
        found: true,
        shortVolume: row.short,
        shortExempt: row.exempt,
        totalVolume: row.total,
        shortVolumeRatio: ratio != null ? +ratio.toFixed(4) : null,
    };
    finraCache.set(sym, { ts: Date.now(), body });
    return body;
}

// ============================================================================
// /openinsider — recent insider buy/sell rows scraped from OpenInsider HTML
// ============================================================================

async function fetchOpenInsider(symbol) {
    const sym = symbol.toUpperCase();
    const cached = insiderCache.get(sym);
    if (cached && Date.now() - cached.ts < INSIDER_CACHE_TTL_MS) return cached.body;

    const url = `http://openinsider.com/screener?s=${encodeURIComponent(sym)}&fd=30&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&xs=1&xa=1&xd=1&xg=1&xf=1&xm=1&xx=1&xc=1&xw=1&excludeDerivRelated=1&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=20&page=1`;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' } });
        if (!res.ok) throw new Error(`openinsider ${res.status}`);
        const html = await res.text();
        const tableMatch = html.match(/<table[^>]*class="tinytable"[\s\S]*?<\/table>/i);
        if (!tableMatch) {
            const body = { found: false, rows: [] };
            insiderCache.set(sym, { ts: Date.now(), body });
            return body;
        }
        const tableHtml = tableMatch[0];
        const trs = tableHtml.match(/<tr[\s\S]*?<\/tr>/g) || [];
        const rows = [];
        for (const tr of trs) {
            const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => stripHtml(m[1]));
            if (tds.length < 11) continue;
            const filingDate = tds[1];
            const tradeDate = tds[2];
            if (!/\d{4}-\d{2}-\d{2}/.test(filingDate)) continue;
            const ticker = tds[3];
            const insider = tds[4];
            const title = tds[5];
            const tradeType = tds[6];
            const price = parseFloat(tds[7].replace(/[$,]/g, '')) || null;
            const qty = parseInt(tds[8].replace(/[+,]/g, ''), 10) || null;
            const value = parseFloat(tds[11].replace(/[$,+]/g, '')) || null;
            rows.push({ filingDate, tradeDate, ticker, insider, title, tradeType, price, qty, value });
            if (rows.length >= 20) break;
        }
        const body = {
            found: rows.length > 0,
            count: rows.length,
            rows,
            netBuyValue: rows.reduce((s, r) => {
                if (!r.value) return s;
                if (/Purchase|Buy/i.test(r.tradeType)) return s + r.value;
                if (/Sale|Sell/i.test(r.tradeType)) return s - r.value;
                return s;
            }, 0),
            buyCount: rows.filter(r => /Purchase|Buy/i.test(r.tradeType)).length,
            sellCount: rows.filter(r => /Sale|Sell/i.test(r.tradeType)).length,
        };
        insiderCache.set(sym, { ts: Date.now(), body });
        return body;
    } catch (e) {
        throw new Error(String(e.message || e));
    }
}

function stripHtml(s) {
    let str = String(s || '');
    // Drop JS-tooltip attribute residue first (onmouseover=Tip('...'), onmouseout=UnTip()).
    // OpenInsider wraps the ticker cell in <a onmouseover="Tip('...', DELAY, 1)" onmouseout="UnTip()">...</a>;
    // when our regex strips the <a> tag itself, the attribute string still lingers if
    // the inner content contains a stray quote. Drop these explicitly first.
    str = str.replace(/onmouseover\s*=\s*"[^"]*"/gi, '');
    str = str.replace(/onmouseout\s*=\s*"[^"]*"/gi, '');
    str = str.replace(/Tip\([^)]*\)/g, '');
    str = str.replace(/UnTip\(\)/g, '');
    // Now strip tags.
    str = str.replace(/<[^>]+>/g, '');
    // Drop any leftover stray punctuation that JS-attribute fragments leave behind.
    str = str.replace(/^[",\s)>]+/, '');
    str = str.replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
    return str;
}

// ============================================================================
// HTTP layer
// ============================================================================

// ============================================================================
// /yahoo?u=<encoded URL> — generic pass-through proxy for public Yahoo Finance
// endpoints (chart, quote, screener, trending, search). Same Worker so we
// don't burn a second deployment; same UA + cookies so we don't 401.
// ============================================================================

const ALLOWED_HOSTS = new Set([
    'query1.finance.yahoo.com',
    'query2.finance.yahoo.com',
]);

async function proxyYahoo(targetUrl) {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (_) { return corsJson({ error: 'invalid target URL' }, 400); }
    if (!ALLOWED_HOSTS.has(parsed.host)) {
        return corsJson({ error: `host not allowed: ${parsed.host}` }, 400);
    }

    // Some public endpoints (v7/finance/quote) now require the crumb+cookie
    // dance. Reuse the cached crumb for those; for the rest, plain UA is fine.
    const needsCrumb = /\/v7\/finance\/quote/.test(parsed.pathname);
    let cookie = '';
    if (needsCrumb) {
        try {
            const c = await getCrumb();
            cookie = c.cookie;
            // Append crumb if not already present.
            if (!parsed.searchParams.has('crumb')) {
                parsed.searchParams.set('crumb', c.crumb);
            }
        } catch (e) { /* fall through; some quote calls work without */ }
    }

    const headers = {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.5',
    };
    if (cookie) headers['Cookie'] = cookie;

    const upstream = await fetch(parsed.toString(), { headers });
    const text = await upstream.text();
    const cacheControl = upstream.ok
        ? 'public, max-age=60'
        : 'no-store, no-cache, must-revalidate, max-age=0';
    return new Response(text, {
        status: upstream.status,
        headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Max-Age': '86400',
            'Cache-Control': cacheControl,
        },
    });
}

function corsJson(body, status = 200) {
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
        if (request.method === 'OPTIONS') return corsJson({ ok: true });
        try {
            if (url.pathname === '/key-stats') {
                const symbol = url.searchParams.get('symbol');
                if (!symbol) return corsJson({ error: 'symbol required' }, 400);
                const body = await fetchKeyStats(symbol);
                return corsJson(body || { error: 'no data' });
            }
            if (url.pathname === '/finra-short') {
                const symbol = url.searchParams.get('symbol');
                if (!symbol) return corsJson({ error: 'symbol required' }, 400);
                const body = await fetchFinraShort(symbol);
                return corsJson(body);
            }
            if (url.pathname === '/openinsider') {
                const symbol = url.searchParams.get('symbol');
                if (!symbol) return corsJson({ error: 'symbol required' }, 400);
                const body = await fetchOpenInsider(symbol);
                return corsJson(body);
            }
            if (url.pathname === '/yahoo') {
                const target = url.searchParams.get('u');
                if (!target) return corsJson({ error: 'u (target URL) required' }, 400);
                const body = await proxyYahoo(target);
                return body; // proxyYahoo returns a fully-formed Response
            }
            if (url.pathname === '/health') {
                return corsJson({ ok: true, ts: Date.now() });
            }
        } catch (e) {
            return corsJson({ error: String(e.message || e) }, 502);
        }
        return corsJson({
            error: 'not found',
            endpoints: ['/key-stats?symbol=X', '/finra-short?symbol=X', '/openinsider?symbol=X', '/yahoo?u=<encoded URL>', '/health'],
        }, 404);
    },
};
