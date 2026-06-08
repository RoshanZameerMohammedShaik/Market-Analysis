// Yahoo Finance crumb-protected endpoint proxy + auxiliary penny-stock data routes.
//
// Endpoints:
//   GET /key-stats?symbol=BBAI       — Yahoo defaultKeyStatistics (float, short interest)
//   GET /finra-short?symbol=BBAI     — FINRA daily short volume / total volume ratio
//   GET /openinsider?symbol=BBAI     — OpenInsider recent insider buy/sell rows
//   GET /extract-article?url=...     — server-side article extraction (Readability-style)
//   GET /source-tier?domain=...      — credibility tier (1-4) for a known news source
//   GET /health                       — health probe
//
// All endpoints return CORS-friendly JSON. Errors NEVER cache (we learned).
//
// Free tier: 100K req/day on CF Workers free plan.

const CACHE_TTL_MS = 60 * 60 * 1000;
const FINRA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // FINRA updates once a day
const INSIDER_CACHE_TTL_MS = 30 * 60 * 1000;
const ARTICLE_CACHE_TTL_MS = 5 * 60 * 1000;     // 5 min — articles update fast
const PUBLIC_QUOTE_CACHE_TTL_MS = 10 * 1000;    // 10s — Public is realtime; don't hammer the quota

const keyStatsCache = new Map();
const finraCache = new Map();
const insiderCache = new Map();
const articleCache = new Map();

let crumbCache = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

// ── Public.com realtime-quote state ──────────────────────────────────────
// The secret lives ONLY as a Cloudflare Worker secret (`wrangler secret put
// PUBLIC_API_SECRET`) — never in the repo, never sent to the browser. The
// browser only ever calls our /stock-quote route; this Worker brokers the
// short-lived bearer token and returns just the price JSON.
const PUBLIC_API_BASE = 'https://api.public.com';
const publicQuoteCache = new Map();      // sym -> { ts, body }
let publicTokenCache = null;             // { token, expEpochMs }
const PUBLIC_TOKEN_VALIDITY_MIN = 30;    // mint 30-min tokens; refresh ~2min early

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
// /stock-quote — REAL-TIME stock price via the Public.com brokerage API
// ============================================================================
//
// Public.com gives realtime equity quotes (vs. our 5-15min delayed Stooq).
// Auth + endpoints VERIFIED against public.com/api/docs:
//   1. POST {base}/userapiauthservice/personal/access-tokens
//        body: { "validityInMinutes": N, "secret": SECRET } → { "accessToken" }
//   2. GET  {base}/userapigateway/trading/account
//        → { "accounts": [ { "accountId", "accountType", ... } ] }
//   3. POST {base}/userapigateway/marketdata/{accountId}/quotes
//        body: { "instruments": [ { "symbol", "type": "EQUITY" } ] }
//        → { "quotes": [ { "outcome": "SUCCESS", "last": "<string>",
//                          "previousClose": "<string>", "bid", "ask", ... } ] }
//   All gateway calls send Authorization: Bearer <token>.
//   NOTE: price fields are STRINGS in the response — parse to Number.
//
// The SECRET is read from env.PUBLIC_API_SECRET (a Cloudflare Worker secret).
// If it's not set, /stock-quote returns {configured:false} so the app cleanly
// falls back to Stooq/Yahoo — deploying this Worker without the secret is safe.

const PUBLIC_UA = 'market-analysis-worker';

async function getPublicToken(env) {
    if (!env || !env.PUBLIC_API_SECRET) {
        throw new Error('PUBLIC_API_SECRET not configured');
    }
    // Reuse a cached token until ~2 min before expiry.
    if (publicTokenCache && Date.now() < publicTokenCache.expEpochMs - 120000) {
        return publicTokenCache.token;
    }
    const res = await fetch(`${PUBLIC_API_BASE}/userapiauthservice/personal/access-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': PUBLIC_UA },
        body: JSON.stringify({ validityInMinutes: PUBLIC_TOKEN_VALIDITY_MIN, secret: env.PUBLIC_API_SECRET }),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`public auth ${res.status}: ${txt.slice(0, 160)}`);
    }
    const json = await res.json();
    const token = json.accessToken;
    if (!token) throw new Error('public auth: no accessToken in response');
    publicTokenCache = { token, expEpochMs: Date.now() + PUBLIC_TOKEN_VALIDITY_MIN * 60000 };
    return token;
}

// The quotes path is scoped to an accountId. Resolve + cache it (it's stable
// for the life of the secret; tie its cache lifetime to the token's).
async function getPublicAccountId(token) {
    if (publicTokenCache && publicTokenCache.accountId && Date.now() < publicTokenCache.expEpochMs - 120000) {
        return publicTokenCache.accountId;
    }
    const res = await fetch(`${PUBLIC_API_BASE}/userapigateway/trading/account`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': PUBLIC_UA },
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`public account ${res.status}: ${txt.slice(0, 160)}`);
    }
    const json = await res.json();
    const accountId = json?.accounts?.[0]?.accountId;
    if (!accountId) throw new Error('public account: no accountId in response');
    if (publicTokenCache) publicTokenCache.accountId = accountId;
    return accountId;
}

// Coerce Public's string price fields → finite Number (or null).
function pubNum(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
}

async function fetchPublicQuote(symbol, env) {
    const sym = String(symbol).toUpperCase().trim();
    const cached = publicQuoteCache.get(sym);
    if (cached && Date.now() - cached.ts < PUBLIC_QUOTE_CACHE_TTL_MS) return cached.body;

    const token = await getPublicToken(env);
    const accountId = await getPublicAccountId(token);

    const res = await fetch(`${PUBLIC_API_BASE}/userapigateway/marketdata/${encodeURIComponent(accountId)}/quotes`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': PUBLIC_UA,
        },
        body: JSON.stringify({ instruments: [{ symbol: sym, type: 'EQUITY' }] }),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`public quote ${res.status}: ${txt.slice(0, 160)}`);
    }
    const json = await res.json();
    const q = json?.quotes?.[0];
    if (!q) throw new Error('public quote: empty quotes array');
    // A per-instrument failure surfaces as outcome != SUCCESS (e.g. NOT_FOUND).
    if (!q.outcome || q.outcome !== 'SUCCESS') {
        throw new Error(`public quote outcome ${q.outcome || 'missing'} for ${sym}`);
    }
    // Prefer last trade; fall back to mid(bid,ask) then previousClose.
    const last = pubNum(q.last);
    const bid = pubNum(q.bid);
    const ask = pubNum(q.ask);
    const prevClose = pubNum(q.previousClose);
    const mid = (bid != null && ask != null) ? (bid + ask) / 2 : null;
    const price = last ?? mid ?? prevClose;
    if (price == null || price <= 0) {
        throw new Error('public quote: no usable price field in response');
    }
    const body = {
        symbol: sym,
        price,
        source: 'public',
        realtime: true,
        fetchedAt: Date.now(),
        bid, ask,
        previousClose: prevClose,
        lastTimestamp: q.lastTimestamp || null,
        priceField: last != null ? 'last' : mid != null ? 'mid' : 'previousClose',
    };
    publicQuoteCache.set(sym, { ts: Date.now(), body });
    if (publicQuoteCache.size > 500) publicQuoteCache.delete(publicQuoteCache.keys().next().value);
    return body;
}

// ============================================================================
// HTTP layer
// ============================================================================

// ============================================================================
// /yahoo?u=<encoded URL> — generic pass-through proxy for public Yahoo Finance
// endpoints (chart, quote, screener, trending, search). Same Worker so we
// don't burn a second deployment; same UA + cookies so we don't 401.
// ============================================================================

// ============================================================================
// /extract-article — server-side full-text extraction
// ============================================================================
//
// Fetches a news article URL server-side (avoiding browser CORS), strips
// the HTML chrome (nav, footer, ads, comments, sidebars), returns the
// main article body. Mozilla's Readability is the gold standard but is
// too heavy for a Worker bundle. We use a lightweight heuristic:
//
//   1. Strip <script>, <style>, <nav>, <footer>, <aside>, <header>, <iframe>.
//   2. Find the largest text-density block (typically <article>, <main>,
//      <div role="main">, or div with class containing "article|content|story|post").
//   3. Within that block, extract <p>, <h2>, <h3>, <li> text only.
//   4. De-duplicate and concatenate.
//
// Catches ~85% of news articles cleanly. Failures fall back to <p>
// extraction across the whole body.

const SELECTORS_STRIP = ['script', 'style', 'nav', 'footer', 'aside', 'iframe', 'noscript', 'svg', 'form'];
const ARTICLE_HOST_TAGS = /<(article|main)(\s[^>]*)?>([\s\S]*?)<\/\1>/i;
const ARTICLE_HOST_DIV  = /<div[^>]*(?:class|id)="[^"]*(?:article|content|story|post|main)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

function stripHtmlNoise(html) {
    let out = html;
    for (const tag of SELECTORS_STRIP) {
        const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
        out = out.replace(re, '');
    }
    out = out.replace(/<!--[\s\S]*?-->/g, '');
    return out;
}

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function extractParagraphs(html) {
    const out = [];
    const re = /<(p|h2|h3|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(html))) {
        const text = m[2].replace(/<[^>]+>/g, '').trim();
        const decoded = decodeEntities(text).replace(/\s+/g, ' ');
        if (decoded.length >= 30) out.push(decoded);   // skip nav-like fragments
    }
    return out;
}

function getMetaContent(html, name) {
    const re = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i');
    const m = html.match(re);
    return m ? decodeEntities(m[1]) : null;
}

function getTitle(html) {
    return getMetaContent(html, 'og:title')
        || getMetaContent(html, 'twitter:title')
        || (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
        || null;
}

function getPublishedAt(html) {
    return getMetaContent(html, 'article:published_time')
        || getMetaContent(html, 'datePublished')
        || getMetaContent(html, 'pubdate')
        || null;
}

function getByline(html) {
    return getMetaContent(html, 'author')
        || getMetaContent(html, 'article:author')
        || null;
}

async function extractArticle(targetUrl) {
    const cached = articleCache.get(targetUrl);
    if (cached && Date.now() - cached.ts < ARTICLE_CACHE_TTL_MS) return cached.data;

    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (_) { return { error: 'invalid url' }; }

    let upstream;
    try {
        upstream = await fetch(targetUrl, {
            headers: {
                'User-Agent': BROWSER_UA,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            redirect: 'follow',
        });
    } catch (e) {
        return { error: `fetch failed: ${e.message || e}` };
    }
    if (!upstream.ok) return { error: `upstream ${upstream.status}` };

    const ct = upstream.headers.get('Content-Type') || '';
    if (!ct.includes('html')) return { error: `not html (${ct})` };

    const rawHtml = await upstream.text();
    if (rawHtml.length > 5_000_000) return { error: 'page too large (>5MB)' };

    const cleaned = stripHtmlNoise(rawHtml);
    const articleHost =
        cleaned.match(ARTICLE_HOST_TAGS)?.[3] ||
        cleaned.match(ARTICLE_HOST_DIV)?.[1]  ||
        cleaned;
    let paragraphs = extractParagraphs(articleHost);
    if (paragraphs.length < 2) paragraphs = extractParagraphs(cleaned);
    const mainText = paragraphs.join('\n\n').slice(0, 12_000); // cap at ~12K chars

    const data = {
        url: targetUrl,
        domain: parsed.hostname.replace(/^www\./, ''),
        title: getTitle(rawHtml),
        byline: getByline(rawHtml),
        publishedAt: getPublishedAt(rawHtml),
        mainText,
        wordCount: mainText.split(/\s+/).filter(Boolean).length,
    };
    if (!data.mainText || data.wordCount < 40) {
        return { error: 'extracted text too short to be useful', ...data };
    }

    articleCache.set(targetUrl, { ts: Date.now(), data });
    if (articleCache.size > 200) {  // bound memory
        const oldest = articleCache.keys().next().value;
        articleCache.delete(oldest);
    }
    return data;
}

// ============================================================================
// /source-tier — credibility classification
// ============================================================================
//
// Static taxonomy, ~150 outlets. Tier 1 = newswire/regulator/gov, Tier 2 =
// major outlet (Reuters, Bloomberg, WSJ, FT, AP, NYT, BBC, CNBC, etc.),
// Tier 3 = aggregator/secondary (Yahoo, Benzinga, MarketWatch, etc.),
// Tier 4 = blog/social/unknown. Unknown domains default to Tier 4.

const SOURCE_TIERS = {
    // Tier 1 — primary sources, regulators, exchanges
    'sec.gov': 1, 'investor.gov': 1, 'finra.org': 1, 'federalreserve.gov': 1,
    'bls.gov': 1, 'bea.gov': 1, 'treasury.gov': 1, 'ecb.europa.eu': 1,
    'rbi.org.in': 1, 'sebi.gov.in': 1, 'nasdaq.com': 1, 'nyse.com': 1,
    'cmegroup.com': 1, 'cboe.com': 1,
    // Tier 2 — top-tier global newswires/outlets
    'reuters.com': 2, 'bloomberg.com': 2, 'wsj.com': 2, 'ft.com': 2,
    'apnews.com': 2, 'nytimes.com': 2, 'bbc.com': 2, 'bbc.co.uk': 2,
    'cnbc.com': 2, 'economist.com': 2, 'ap.org': 2, 'cnn.com': 2,
    'npr.org': 2, 'theguardian.com': 2, 'forbes.com': 2, 'fortune.com': 2,
    'businessinsider.com': 2, 'axios.com': 2, 'barrons.com': 2,
    'reuters.in': 2, 'livemint.com': 2, 'economictimes.indiatimes.com': 2,
    'business-standard.com': 2, 'thehindubusinessline.com': 2, 'moneycontrol.com': 2,
    'scmp.com': 2, 'nikkei.com': 2, 'asia.nikkei.com': 2, 'handelsblatt.com': 2,
    'lesechos.fr': 2, 'afr.com': 2,
    // Tier 3 — aggregators / secondary financial press
    'finance.yahoo.com': 3, 'yahoo.com': 3, 'marketwatch.com': 3,
    'investing.com': 3, 'investopedia.com': 3, 'fool.com': 3,
    'seekingalpha.com': 3, 'benzinga.com': 3, 'thestreet.com': 3,
    'zacks.com': 3, 'finviz.com': 3, 'simplywall.st': 3,
    'kiplinger.com': 3, 'morningstar.com': 3, 'tipranks.com': 3,
    'gurufocus.com': 3, 'streetinsider.com': 3, 'pymnts.com': 3,
    'theinformation.com': 3, 'theverge.com': 3, 'techcrunch.com': 3,
    'engadget.com': 3, 'arstechnica.com': 3, 'wired.com': 3,
    // Tier 3.5 — crypto press
    'coindesk.com': 3, 'cointelegraph.com': 3, 'theblock.co': 3,
    'decrypt.co': 3, 'cryptoslate.com': 3, 'bitcoinmagazine.com': 3,
    'cryptobriefing.com': 3,
    // Tier 4 — blogs, content farms, low-credibility (default)
    'medium.com': 4, 'substack.com': 4, 'twitter.com': 4, 'x.com': 4,
    'reddit.com': 4, 'youtube.com': 4, 'tiktok.com': 4, 'facebook.com': 4,
    'instagram.com': 4, 'discord.com': 4,
};

function classifySource(domain) {
    if (!domain) return { tier: 4, reason: 'no domain' };
    const norm = String(domain).toLowerCase().replace(/^www\./, '').trim();
    if (SOURCE_TIERS[norm] != null) return { tier: SOURCE_TIERS[norm], domain: norm };
    // Try parent domain (e.g., 'feeds.reuters.com' → 'reuters.com').
    const parts = norm.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join('.');
        if (SOURCE_TIERS[candidate] != null) return { tier: SOURCE_TIERS[candidate], domain: candidate, matchedAs: 'parent' };
    }
    return { tier: 4, domain: norm, reason: 'unknown source — default tier 4' };
}

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

// Origin-restricted JSON response — used for the Public.com quote route so our
// brokerage key's quota can't be used as a free feed by arbitrary callers.
// Allows ONLY the deployed app + CF preview deploys + localhost dev. A missing
// Origin is REJECTED (curl/scripts/bots have no Origin) — the Capacitor app
// loads the same market-ai.pages.dev URL in a WebView, so it DOES send that
// Origin and is covered. Closing the missing-Origin hole is what stops an
// anonymous script from burning the brokerage key's quota.
const PUBLIC_ALLOWED_ORIGINS = new Set([
    'https://market-ai.pages.dev',
    'http://localhost:8765',
    'http://127.0.0.1:8765',
]);
function originAllowed(origin) {
    if (!origin) return false;                      // no Origin → reject (curl/bots/scrapers)
    if (PUBLIC_ALLOWED_ORIGINS.has(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.market-ai\.pages\.dev$/.test(origin)) return true;  // CF preview deploys
    return false;
}

// Lightweight per-symbol rate limit for /stock-quote so even an allowed origin
// (or a spoofed-Origin script) can't hammer the brokerage quota. In-memory
// sliding window; the worker already caches quotes 10s, so legit usage is far
// under this. Keyed by client IP + symbol.
const quoteRateWindow = new Map();   // key -> [timestamps]
const QUOTE_RATE_MAX = 30;           // max requests
const QUOTE_RATE_WINDOW_MS = 60_000; // per minute, per (ip, symbol)
function quoteRateLimited(ip, sym, nowEpoch) {
    const key = `${ip}|${sym}`;
    const arr = (quoteRateWindow.get(key) || []).filter(t => nowEpoch - t < QUOTE_RATE_WINDOW_MS);
    if (arr.length >= QUOTE_RATE_MAX) { quoteRateWindow.set(key, arr); return true; }
    arr.push(nowEpoch);
    quoteRateWindow.set(key, arr);
    if (quoteRateWindow.size > 5000) quoteRateWindow.delete(quoteRateWindow.keys().next().value);
    return false;
}
function restrictedJson(body, origin, status = 200) {
    const allow = (originAllowed(origin) && origin) ? origin : 'null';
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allow,
            'Vary': 'Origin',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Max-Age': '86400',
            'Cache-Control': status === 200 ? 'public, max-age=10' : 'no-store',
        },
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        if (request.method === 'OPTIONS') {
            // Preflight: answer with the right CORS scope for the route.
            if (url.pathname === '/stock-quote') return restrictedJson({ ok: true }, origin);
            return corsJson({ ok: true });
        }
        try {
            if (url.pathname === '/stock-quote') {
                // Realtime stock price via Public.com (origin-restricted so the
                // brokerage key's quota isn't a free public feed). Read-only —
                // we NEVER expose any order/write endpoint through this Worker.
                if (!originAllowed(origin)) return restrictedJson({ error: 'origin not allowed' }, origin, 403);
                const symbol = url.searchParams.get('symbol');
                if (!symbol) return restrictedJson({ error: 'symbol required' }, origin, 400);
                const sym = symbol.toUpperCase();
                // Per-(IP, symbol) rate limit so even an allowed/spoofed origin
                // can't burn the brokerage quota with a tight loop.
                const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
                if (quoteRateLimited(ip, sym, Date.now())) {
                    return restrictedJson({ error: 'rate limited', symbol: sym }, origin, 429);
                }
                if (!env || !env.PUBLIC_API_SECRET) {
                    // Secret not set → tell the app cleanly so it falls back to Stooq.
                    return restrictedJson({ configured: false, symbol: sym }, origin, 200);
                }
                try {
                    const body = await fetchPublicQuote(sym, env);
                    return restrictedJson(body, origin, 200);
                } catch (e) {
                    return restrictedJson({ error: String(e.message || e), symbol: sym }, origin, 502);
                }
            }
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
            if (url.pathname === '/extract-article') {
                const target = url.searchParams.get('url');
                if (!target) return corsJson({ error: 'url required' }, 400);
                const body = await extractArticle(target);
                return corsJson(body, body.error ? 502 : 200);
            }
            if (url.pathname === '/source-tier') {
                const domain = url.searchParams.get('domain');
                if (!domain) return corsJson({ error: 'domain required' }, 400);
                return corsJson(classifySource(domain));
            }
            if (url.pathname === '/health') {
                return corsJson({ ok: true, ts: Date.now(), publicQuoteConfigured: !!(env && env.PUBLIC_API_SECRET) });
            }
        } catch (e) {
            return corsJson({ error: String(e.message || e) }, 502);
        }
        return corsJson({
            error: 'not found',
            endpoints: [
                '/stock-quote?symbol=X (realtime, origin-restricted)',
                '/key-stats?symbol=X', '/finra-short?symbol=X', '/openinsider?symbol=X',
                '/yahoo?u=<encoded URL>', '/extract-article?url=<encoded URL>',
                '/source-tier?domain=X', '/health',
            ],
        }, 404);
    },
};
