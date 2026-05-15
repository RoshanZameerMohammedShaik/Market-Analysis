// External / internet tools Mia can call to fill gaps the app doesn't
// already cover. All free, all keyless. Each function returns a small
// JSON-friendly payload — these are designed to fit through the LLM's
// 4kb tool-result truncation in agent.js.

import { fetchWithProxy } from '../data.js';
import { fetchStockNews, fetchCryptoNews } from '../news.js';
import { analyzeNewsSentiment } from '../sentiment.js';
import { fetchOptionsPositioning } from '../options-iv.js';
import { fetchCryptoDerivs } from '../crypto-derivs.js';

// ---- News + sentiment -------------------------------------------------------

export async function fetchNewsAndSentiment({ symbol, mode = 'stock', companyName = '' }) {
    if (!symbol) throw new Error('symbol required');
    const news = mode === 'crypto' ? await fetchCryptoNews(symbol) : await fetchStockNews(symbol, companyName);
    const sentiment = await analyzeNewsSentiment(news);
    return {
        symbol,
        count: news.length,
        topHeadlines: news.slice(0, 6).map(n => ({
            title: n.title,
            source: n.source,
            ageHours: n.date ? Math.round((Date.now() - new Date(n.date).getTime()) / 3_600_000) : null,
        })),
        sentiment: {
            overall: sentiment.overall,
            score: sentiment.score,
            method: sentiment.method,
            reasons: sentiment.reasons,
        },
    };
}

// ---- FRED macro series (no key needed for fred-public json) ----------------
//
// We use the unofficial json mirror via stlouisfed.org's CSV endpoint.
// Series whitelist keeps the surface tight — no arbitrary-URL fetch via Mia.

const FRED_ALLOWED = new Set([
    'DFF',     // Effective Fed Funds Rate
    'DGS10',   // 10-yr Treasury yield
    'DGS2',    // 2-yr Treasury yield
    'T10Y2Y',  // 10y-2y spread
    'UNRATE',  // Unemployment rate
    'CPIAUCSL', // CPI (all urban consumers)
    'PCEPILFE', // Core PCE
    'M2SL',    // M2 money supply
    'WALCL',   // Fed balance sheet
    'DCOILWTICO', // WTI oil
    'GOLDAMGBD228NLBM', // Gold London PM fix
]);

export async function fetchFredSeries({ series, lookbackMonths = 6 }) {
    const id = String(series || '').trim().toUpperCase();
    if (!FRED_ALLOWED.has(id)) {
        return { error: `series '${id}' not in allowlist`, allowed: [...FRED_ALLOWED] };
    }
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
    try {
        const res = await fetchWithProxy(url);
        const text = await res.text();
        const rows = parseFredCsv(text);
        const cutoff = Date.now() - lookbackMonths * 30 * 24 * 3600 * 1000;
        const recent = rows.filter(r => r.date.getTime() > cutoff);
        if (!recent.length) return { error: 'no recent rows' };
        const latest = recent[recent.length - 1];
        const start = recent[0];
        return {
            series: id,
            latest: { date: latest.date.toISOString().slice(0, 10), value: latest.value },
            start:  { date: start.date.toISOString().slice(0, 10), value: start.value },
            change: latest.value != null && start.value != null ? +(latest.value - start.value).toFixed(4) : null,
            pctChange: latest.value != null && start.value != null && start.value !== 0
                ? +(((latest.value - start.value) / start.value) * 100).toFixed(2)
                : null,
            rows: recent.length,
        };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}

function parseFredCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
        const [d, v] = lines[i].split(',');
        if (!d) continue;
        const date = new Date(d);
        if (Number.isNaN(date.getTime())) continue;
        const num = v === '.' || v === '' ? null : parseFloat(v);
        out.push({ date, value: Number.isFinite(num) ? num : null });
    }
    return out.filter(r => r.value != null);
}

// ---- Reddit sentiment -------------------------------------------------------
//
// Reddit's old.reddit.com search endpoint returns JSON with no auth.

export async function fetchRedditSentiment({ symbol, subreddit = 'stocks+wallstreetbets+investing', limit = 20 }) {
    if (!symbol) throw new Error('symbol required');
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(symbol)}&restrict_sr=1&sort=new&limit=${limit}`;
    try {
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const posts = (json?.data?.children || []).map(c => c.data).filter(Boolean);
        if (!posts.length) return { symbol, count: 0, summary: 'no recent posts' };
        const summary = simpleRedditSentiment(posts);
        return {
            symbol,
            subreddit,
            count: posts.length,
            ageHoursOldest: Math.round((Date.now() / 1000 - posts[posts.length - 1].created_utc) / 3600),
            ageHoursNewest: Math.round((Date.now() / 1000 - posts[0].created_utc) / 3600),
            sentiment: summary.label,
            score: summary.score,
            bullishPosts: summary.bull,
            bearishPosts: summary.bear,
            topPosts: posts.slice(0, 4).map(p => ({
                title: p.title?.slice(0, 120) || '',
                score: p.score,
                comments: p.num_comments,
                subreddit: p.subreddit,
            })),
        };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}

const REDDIT_BULL = ['moon','calls','buy','long','rip','squeeze','breakout','bullish','undervalued','rally','strong'];
const REDDIT_BEAR = ['puts','short','sell','dump','crash','bag','bagholder','rugpull','bearish','overvalued','collapse'];

function simpleRedditSentiment(posts) {
    let bull = 0, bear = 0;
    for (const p of posts) {
        const text = ((p.title || '') + ' ' + (p.selftext || '')).toLowerCase();
        if (REDDIT_BULL.some(w => text.includes(w))) bull++;
        if (REDDIT_BEAR.some(w => text.includes(w))) bear++;
    }
    const total = bull + bear;
    const score = total > 0 ? (bull - bear) / total : 0;
    let label;
    if (score > 0.25) label = 'bullish';
    else if (score < -0.25) label = 'bearish';
    else label = 'mixed';
    return { label, score: +score.toFixed(2), bull, bear };
}

// ---- SEC EDGAR --------------------------------------------------------------

export async function fetchSecRecentFilings({ symbol, limit = 5 }) {
    if (!symbol) throw new Error('symbol required');
    try {
        const map = await secTickerMap();
        const cik = map[symbol.toUpperCase()];
        if (!cik) return { error: `no SEC CIK for ${symbol}` };
        const padded = String(cik).padStart(10, '0');
        const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const recent = json?.filings?.recent;
        if (!recent?.form) return { error: 'no recent filings' };
        const out = [];
        for (let i = 0; i < recent.form.length && out.length < limit; i++) {
            out.push({
                form: recent.form[i],
                filingDate: recent.filingDate[i],
                primaryDocument: recent.primaryDocument[i],
                accessionNumber: recent.accessionNumber[i],
            });
        }
        return { symbol: symbol.toUpperCase(), cik: padded, name: json.name, filings: out };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}

let _secMapCache = null;
async function secTickerMap() {
    if (_secMapCache) return _secMapCache;
    const url = 'https://www.sec.gov/files/company_tickers.json';
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const out = {};
    for (const k of Object.keys(json)) {
        const row = json[k];
        if (row?.ticker && row?.cik_str != null) out[String(row.ticker).toUpperCase()] = row.cik_str;
    }
    _secMapCache = out;
    return out;
}

// ---- Options / derivs surface readers ---------------------------------------

export async function fetchOptionsView({ symbol }) {
    if (!symbol) throw new Error('symbol required');
    return await fetchOptionsPositioning(symbol);
}

export async function fetchCryptoDerivativesView({ coinId }) {
    if (!coinId) throw new Error('coinId required');
    return await fetchCryptoDerivs(coinId);
}
