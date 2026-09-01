// Macro regime from FRED, and the beta that makes it a PER-SYMBOL signal.
//
// WHY THIS EXISTS
// ---------------
// The engine's `market` source was measured returning 67 for 40 of 41 symbols in a scan. It
// was not broken: getMarketConditionsScore(mode) takes the MODE, not the symbol, so it is
// market-wide by construction and cannot be anything other than near-constant across names.
//
// That matters because a constant cannot rank. The desk now selects cross-sectionally -- top
// decile of the universe -- and adding the same number to every symbol changes no ordering
// whatsoever. A quarter of the nominal weight was being spent on a term that was
// mathematically incapable of affecting selection, while still compressing the range the
// score could span.
//
// Two fixes, both here:
//
//   1. REAL MACRO. Fear/greed and VIX describe today's mood. The yield curve, real rates and
//      unemployment describe the regime, and they are the inputs that actually distinguish a
//      2021 tape from a 2022 one. FRED serves all of them, free and WITHOUT an API key, via
//      the CSV graph endpoint -- so this adds no secret for anyone to manage.
//
//   2. BETA. This is what turns a market-wide reading into a per-symbol one. A weak tape does
//      not hurt every name equally: a 1.6-beta name is far more exposed to it than a
//      0.4-beta one. Scoring `market` as the market's own direction TILTED BY the symbol's
//      measured sensitivity gives a number that legitimately varies per symbol and legitimately
//      affects ranking, instead of a constant wearing a per-symbol label.
//
// Beta is computed from the candles the engine already has, against a benchmark it already
// fetches. No extra network call per symbol.
//
// HONESTY
// -------
// None of this is claimed to add predictive edge. Its measured job is narrower and worth
// stating plainly: stop spending a quarter of the score on a term that cannot rank, and
// replace it with one that can. Whether the replacement carries signal is a question for
// tools/source_ic_check.py against realized outcomes, not for this comment.

import { fetchStockData, fetchWithProxy } from './data.js';

// Daily series unless noted. Chosen because each one answers a different question and all
// are free and key-less; this is not a screen of many series picked for fit.
const SERIES = {
    // 10Y minus 2Y. The single most-watched recession indicator; negative is inversion.
    yieldCurve: { id: 'T10Y2Y', kind: 'level', bullishWhen: 'high', floor: -1.0, cap: 2.5 },
    // 10Y nominal. Rapid RISES compress equity valuations, so the change matters, not the level.
    tenYear: { id: 'DGS10', kind: 'change60', bullishWhen: 'low', floor: -1.5, cap: 1.5 },
    // Volatility. Low is risk-on.
    vix: { id: 'VIXCLS', kind: 'level', bullishWhen: 'low', floor: 10, cap: 45 },
    // Monthly. RISING unemployment is late-cycle; again the change, not the level.
    unemployment: { id: 'UNRATE', kind: 'change12m', bullishWhen: 'low', floor: -1.0, cap: 1.5 },
};

const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
// Macro moves slowly and the series update at most daily, so a long TTL is correct rather
// than merely convenient. It also keeps a 41-symbol scan to ONE fetch per series.
const TTL_MS = 6 * 60 * 60 * 1000;

const _cache = new Map();   // id -> { ts, rows }

async function fetchSeries(id) {
    const hit = _cache.get(id);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.rows;
    try {
        const res = await fetchWithProxy(`${FRED_CSV}${encodeURIComponent(id)}`);
        const text = await res.text();
        const rows = parseFredCsv(text);
        if (rows.length) _cache.set(id, { ts: Date.now(), rows });
        return rows;
    } catch (_) {
        // Return the stale copy if we have one. A macro reading from this morning is far
        // better than abstaining because one fetch failed.
        return hit ? hit.rows : [];
    }
}

/** FRED CSV is `DATE,VALUE` with '.' for missing observations. */
export function parseFredCsv(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const [d, v] = line.split(',');
        if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) continue;   // skips the header too
        const n = Number(String(v).trim());
        // '.' means "no observation": holidays and pre-publication gaps. Dropping the row is
        // right; coercing it to 0 would read as a yield curve of zero.
        if (!Number.isFinite(n)) continue;
        out.push({ date: d.trim(), value: n });
    }
    return out;
}

/** Map a raw reading onto a 0-100 bullish scale using the series' own documented range. */
function scoreSeries(spec, rows) {
    if (!rows || rows.length < 2) return null;
    const last = rows[rows.length - 1];
    let x;
    if (spec.kind === 'level') {
        x = last.value;
    } else if (spec.kind === 'change60') {
        // ~60 business days back, i.e. a quarter. Clamped so a short series still works.
        const prev = rows[Math.max(0, rows.length - 61)];
        x = last.value - prev.value;
    } else if (spec.kind === 'change12m') {
        const prev = rows[Math.max(0, rows.length - 13)];
        x = last.value - prev.value;
    } else {
        return null;
    }
    if (!Number.isFinite(x)) return null;
    const t = (Math.min(spec.cap, Math.max(spec.floor, x)) - spec.floor) / (spec.cap - spec.floor);
    const bullish = spec.bullishWhen === 'high' ? t : 1 - t;
    return { score: Math.round(bullish * 100), raw: Number(x.toFixed(4)), asOf: last.date };
}

/**
 * The macro regime as one 0-100 bullish score, plus its components.
 *
 * Equal-weighted across whatever resolved. Equal weights because there is no out-of-sample
 * basis for preferring one series over another here, and inventing weights would be the same
 * unvalidated guesswork that the removed signal thresholds were.
 */
export async function getMacroScore() {
    const ids = Object.entries(SERIES);
    const results = await Promise.all(ids.map(async ([key, spec]) => {
        const rows = await fetchSeries(spec.id);
        return [key, scoreSeries(spec, rows)];
    }));
    const components = {};
    const live = [];
    for (const [key, r] of results) {
        components[key] = r;
        if (r) live.push(r.score);
    }
    if (!live.length) {
        return { score: 50, available: false, components, reasons: ['Macro data unavailable'] };
    }
    const score = Math.round(live.reduce((a, b) => a + b, 0) / live.length);
    return {
        score,
        available: true,
        componentsUsed: live.length,
        components,
        reasons: describeMacro(components, score),
    };
}

function describeMacro(c, score) {
    const out = [];
    if (c.yieldCurve) {
        const v = c.yieldCurve.raw;
        out.push(v < 0
            ? `Yield curve inverted (10Y-2Y ${v.toFixed(2)}%), historically late-cycle`
            : `Yield curve positive (10Y-2Y ${v.toFixed(2)}%)`);
    }
    if (c.vix) {
        out.push(`VIX ${c.vix.raw.toFixed(1)}: ${c.vix.raw < 16 ? 'calm' : c.vix.raw < 25 ? 'elevated' : 'stressed'}`);
    }
    if (c.tenYear) {
        const v = c.tenYear.raw;
        out.push(`10Y ${v >= 0 ? 'up' : 'down'} ${Math.abs(v).toFixed(2)}pp over a quarter`);
    }
    if (c.unemployment) {
        const v = c.unemployment.raw;
        out.push(`Unemployment ${v >= 0 ? 'rising' : 'falling'} ${Math.abs(v).toFixed(1)}pp year on year`);
    }
    out.push(`Macro regime ${score}/100 bullish`);
    return out;
}

// ── beta: what makes a market-wide reading per-symbol ────────────────────────

/**
 * Beta of `closes` against `benchmarkCloses`, on overlapping daily returns.
 *
 * Returns null rather than a default when there is not enough overlap. A fabricated beta of
 * 1.0 would silently reinstate exactly the constant this module exists to remove.
 */
export function computeBeta(closes, benchmarkCloses, minPoints = 40) {
    if (!Array.isArray(closes) || !Array.isArray(benchmarkCloses)) return null;
    // Align to the SHORTEST from the right: both series end at the most recent bar, and
    // aligning from the left would pair a symbol's Monday with the benchmark's Thursday.
    const n = Math.min(closes.length, benchmarkCloses.length);
    if (n < minPoints + 1) return null;
    const a = closes.slice(closes.length - n);
    const b = benchmarkCloses.slice(benchmarkCloses.length - n);

    const ra = [], rb = [];
    for (let i = 1; i < n; i++) {
        if (!(a[i - 1] > 0) || !(b[i - 1] > 0)) continue;
        ra.push(a[i] / a[i - 1] - 1);
        rb.push(b[i] / b[i - 1] - 1);
    }
    if (ra.length < minPoints) return null;
    const ma = ra.reduce((s, x) => s + x, 0) / ra.length;
    const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
    let cov = 0, varb = 0;
    for (let i = 0; i < ra.length; i++) {
        cov += (ra[i] - ma) * (rb[i] - mb);
        varb += (rb[i] - mb) ** 2;
    }
    if (!(varb > 0)) return null;
    const beta = cov / varb;
    if (!Number.isFinite(beta)) return null;
    // Clamp to a plausible range. Beyond this it is an artefact of a thin or gappy series,
    // not a real sensitivity, and it would dominate the tilt below.
    return Math.max(-1.0, Math.min(3.0, Number(beta.toFixed(4))));
}

/**
 * Tilt a market-wide score by a symbol's own sensitivity to the market.
 *
 * beta 1 leaves it unchanged. A high-beta name amplifies the market's DEVIATION FROM
 * NEUTRAL in both directions -- more exposed to a weak tape and to a strong one alike --
 * while a low-beta name is pulled toward 50 because the market matters less to it.
 *
 * This is the whole point: the output varies per symbol, so it can affect a cross-sectional
 * ranking, which a market-wide constant never could.
 */
export function betaAdjustedMarketScore(marketScore, beta) {
    if (!Number.isFinite(marketScore)) return null;
    if (!Number.isFinite(beta)) return Math.round(marketScore);   // no beta: leave it alone
    const deviation = marketScore - 50;
    return Math.round(Math.max(0, Math.min(100, 50 + deviation * beta)));
}


// ── the benchmark a symbol's beta is measured against ────────────────────────

// Cached per mode, because beta needs the SAME benchmark series for every symbol in a scan
// and refetching it 264 times would dominate the run. One fetch per mode per TTL.
const _bench = new Map();   // mode -> { ts, closes }
const BENCH_TTL_MS = 60 * 60 * 1000;

// Equities against the S&P; crypto against BTC. Beta versus the S&P for an altcoin is close
// to meaningless -- crypto's common factor is bitcoin, not equities -- and using one
// benchmark for both would produce a number that looks valid and measures nothing.
const BENCHMARKS = { stock: '^GSPC', crypto: 'BTC-USD' };

/** ~6 months of benchmark closes. 3mo left too few points after holidays for a stable beta. */
export async function getBenchmarkCloses(mode = 'stock') {
    const key = mode === 'crypto' ? 'crypto' : 'stock';
    const hit = _bench.get(key);
    if (hit && Date.now() - hit.ts < BENCH_TTL_MS) return hit.closes;
    try {
        const data = await fetchStockData(BENCHMARKS[key], '6mo', '1d');
        const closes = (data?.candles || []).map(c => c.close).filter(c => c > 0);
        if (closes.length >= 40) {
            _bench.set(key, { ts: Date.now(), closes });
            return closes;
        }
        return hit ? hit.closes : [];
    } catch (_) {
        return hit ? hit.closes : [];
    }
}

/**
 * Blend the two market-wide readings, then make the result PER-SYMBOL via beta.
 *
 * `conditions` is today's mood (fear/greed, VIX, breadth) and `macro` is the regime (yield
 * curve, rates, unemployment). Both are market-wide, so blending them changes nothing about
 * the fact that neither can rank symbols; the beta tilt is what fixes that.
 *
 * Equal weight between mood and regime: there is no out-of-sample basis for preferring one,
 * and picking a split by feel is the guesswork this codebase keeps having to remove.
 */
export function marketScoreForSymbol(conditions, macro, beta) {
    const parts = [];
    if (conditions && conditions.available !== false && Number.isFinite(conditions.score)) {
        parts.push(conditions.score);
    }
    if (macro && macro.available && Number.isFinite(macro.score)) parts.push(macro.score);
    if (!parts.length) return { score: 50, available: false, beta: null, marketWide: null };
    const marketWide = parts.reduce((a, b) => a + b, 0) / parts.length;
    return {
        score: betaAdjustedMarketScore(marketWide, beta),
        available: true,
        beta: Number.isFinite(beta) ? beta : null,
        marketWide: Math.round(marketWide),
        componentsUsed: parts.length,
    };
}
