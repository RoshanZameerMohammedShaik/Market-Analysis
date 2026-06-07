// Standalone ledger reader. Extracted from mia/ui-bridge.js so the
// confidence engine can read the live ledger without pulling in the
// whole Mia tool registry (which imports from many engine pieces and
// would create circular dependencies).
//
// One module → one cache. ui-bridge.js re-exports readLedgerHistory
// from here so existing Mia tool callers keep working unchanged.

let _ledgerCache = null;
let _ledgerCacheTs = 0;
const LEDGER_CACHE_MS = 5 * 60 * 1000;

// ── Engine-version provenance gate ──────────────────────────────────────
// The engine's directional scoring changes over time (e.g. the 2026-06-06
// 1-day mean-reversion rebalance that fixed a below-coin-flip inversion).
// Each ledger row is stamped with the engine that produced it
// (record_predictions.py), and model/live_calibration.json carries the
// engineVersion that's running NOW. The "how accurate / how profitable is
// the engine" surfaces (equity curve, accuracy-by-setup, history hit-rate)
// must describe the CURRENT engine — not blend in a retired engine's record,
// which would either inherit its losses (defaming a fix) or its wins
// (inflating a regression). So we scope those reads to current-engine rows.
//
// Self-contained: we read the authoritative current version from
// live_calibration.json (Python-written, static-cached). If it's missing or
// carries no engineVersion (older deploys), we DEGRADE GRACEFULLY to "no
// gate" (show all rows) rather than blanking the app on an infra hiccup —
// honesty without fragility.
// Cache ONLY a successful, non-empty version (truthy). The unavailable
// state ('') is deliberately NOT cached: a transient 404 / network blip
// must NOT lock the gate open for the full TTL — that would ungate every
// surface and surface the RETIRED engine's record (e.g. the pre-rebalance
// 46.7%) as if it were current, the exact dishonesty this gate prevents.
// So on failure we return '' (fail-open for THIS call only) and retry on
// the next call. These reads are user-initiated panel opens, not a hot
// loop, so re-fetching on a rare miss is cheap.
let _engineVersionCache = '';       // '' = not cached / unavailable; truthy = cached version
let _engineVersionCacheTs = 0;

async function currentEngineVersion() {
    if (_engineVersionCache && Date.now() - _engineVersionCacheTs < LEDGER_CACHE_MS) {
        return _engineVersionCache;
    }
    try {
        const res = await fetch('./model/live_calibration.json');
        if (res.ok) {
            const data = await res.json();
            const v = data?.engineVersion || '';
            if (v) {                       // only a real version gets cached
                _engineVersionCache = v;
                _engineVersionCacheTs = Date.now();
                return v;
            }
        }
    } catch (_) { /* fall through to fail-open */ }
    return '';                              // unavailable → ungate this call, retry next
}

// Filter rows to the current engine. When the current version is unknown
// (degraded), returns rows unchanged. Also returns how many rows were set
// aside so callers can show an honest "rebuilding under updated engine"
// state instead of an ambiguous empty one.
//
// CRITICAL fallback (added after the gate was filtering EVERYTHING): the
// committed ledger is overwhelmingly 'unversioned' (the Python cron only
// recently started stamping engineVersion, so only ~171 of ~7,400 rows match
// the current version). Gating hard left the equity curve + accuracy report
// permanently stuck on "rebuilding" with zero data. So: if the current-engine
// subset is too thin to be useful (< MIN_KEPT), we DON'T gate — we return all
// rows ungated. The gate only "bites" once the new engine has actually
// accumulated a meaningful record, which is exactly when retiring the old one
// is the honest thing to do. Until then, showing the full history (clearly the
// engine's real track record) beats showing nothing.
// Gate only once the current engine has a RESOLVED, directional record big
// enough to stand alone. We count kept rows that are actually resolved at the
// 1-day horizon (the product horizon) — raw row count isn't enough because the
// newest rows are mostly unresolved, which would gate to a 0-trade surface.
const MIN_KEPT_RESOLVED = 120;
function isResolvedDirectional(r) {
    if (r.signal !== 'BUY' && r.signal !== 'SELL') return false;
    const h = r.horizons?.['1'];
    return h && h.directionMatch != null;
}
async function scopeToCurrentEngine(rows) {
    const ver = await currentEngineVersion();
    if (!ver) return { rows, retired: 0, gated: false, version: null };
    const kept = [];
    let retired = 0;
    let keptResolved = 0;
    for (const r of rows) {
        if ((r.engineVersion || 'unversioned') === ver) {
            kept.push(r);
            if (isResolvedDirectional(r)) keptResolved++;
        } else retired++;
    }
    // Not enough RESOLVED current-engine rows yet → show full history ungated
    // rather than a blank/forever-rebuilding surface. The gate only bites once
    // the new engine has genuinely accumulated a record worth standing on.
    if (keptResolved < MIN_KEPT_RESOLVED) {
        return { rows, retired: 0, gated: false, version: ver };
    }
    return { rows: kept, retired, gated: true, version: ver };
}

export async function loadLedger() {
    if (_ledgerCache && Date.now() - _ledgerCacheTs < LEDGER_CACHE_MS) {
        return _ledgerCache;
    }
    const year = new Date().getUTCFullYear();
    try {
        const res = await fetch(`./model/ledger/${year}.jsonl`);
        if (!res.ok) {
            _ledgerCache = [];
            _ledgerCacheTs = Date.now();
            return _ledgerCache;
        }
        const text = await res.text();
        const rows = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { rows.push(JSON.parse(t)); } catch (_) {}
        }
        _ledgerCache = rows;
        _ledgerCacheTs = Date.now();
        return _ledgerCache;
    } catch (_) {
        _ledgerCache = [];
        _ledgerCacheTs = Date.now();
        return _ledgerCache;
    }
}

// Chronological confidence + outcome trail for ONE symbol, for the
// per-symbol confidence-trend mini chart. Returns up to `limit` most
// recent rows (oldest→newest) each with { date, confidence, signal,
// outcome } where outcome is 'hit' | 'miss' | null (unresolved). The
// chart plots confidence as a line and dots each resolved point green
// (hit) or red (miss), so the user can see whether the engine's
// conviction on this name has been earned.
export async function readSymbolConfidenceTrend({ symbol, limit = 30 } = {}) {
    const rows = await loadLedger();
    if (!rows.length || !symbol) return { available: false, points: [] };
    const sym = String(symbol).toUpperCase();
    const scoped = rows
        .filter(r => r.symbol === sym && Number.isFinite(r.confidence))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!scoped.length) return { available: false, points: [] };
    const lim = Math.max(2, Math.min(60, Number(limit) || 30));
    const recent = scoped.slice(-lim);
    const points = recent.map(r => {
        const h1 = r.horizons?.['1'];
        let outcome = null;
        // != null catches BOTH undefined (unresolved) AND null (NO_TRADE,
        // which resolve_outcomes writes as directionMatch:null). Without
        // this, a NO_TRADE/unresolved row plotted as a red "miss" dot.
        if (h1 && h1.directionMatch != null) outcome = h1.directionMatch ? 'hit' : 'miss';
        return { date: r.date, confidence: r.confidence, signal: r.signal, outcome };
    });
    return { available: true, symbol: sym, points };
}

// Past engine signals for ONE symbol, shaped for drawing as markers on
// the price chart. Each entry: { date (YYYY-MM-DD), time (UNIX secs),
// entry (price), signal (BUY/SELL/NEUTRAL/NO_TRADE), confidence,
// outcome ('hit'|'miss'|null), pctMove }. Only directional calls
// (BUY/SELL) are returned by default since those are the ones worth
// marking on the chart; NEUTRAL/NO_TRADE are sit-outs.
export async function readSymbolSignalMarkers({ symbol, directionalOnly = true } = {}) {
    const rows = await loadLedger();
    if (!rows.length || !symbol) return { available: false, markers: [] };
    const sym = String(symbol).toUpperCase();
    const scoped = rows
        .filter(r => r.symbol === sym && r.date && Number.isFinite(r.entry))
        .filter(r => !directionalOnly || r.signal === 'BUY' || r.signal === 'SELL')
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!scoped.length) return { available: false, markers: [] };
    const markers = scoped.map(r => {
        const h1 = r.horizons?.['1'];
        let outcome = null;
        // != null catches BOTH undefined (unresolved) AND null (NO_TRADE,
        // which resolve_outcomes writes as directionMatch:null). Without
        // this, a NO_TRADE/unresolved row plotted as a red "miss" dot.
        if (h1 && h1.directionMatch != null) outcome = h1.directionMatch ? 'hit' : 'miss';
        // lightweight-charts wants `time` as a UTC day stamp; our candle
        // series uses UNIX-seconds, so convert the YYYY-MM-DD date the
        // same way (midnight UTC) for a clean alignment to the bar.
        const time = Math.floor(Date.parse(`${r.date}T00:00:00Z`) / 1000);
        return {
            date: r.date,
            time,
            entry: r.entry,
            signal: r.signal,
            confidence: r.confidence,
            outcome,
            pctMove: h1?.pctMove ?? null,
        };
    });
    return { available: true, symbol: sym, markers };
}

// "If you'd followed the engine" — a hypothetical equity curve.
//
// Walks the resolved ledger in chronological order and accrues the
// return of every directional call at the chosen horizon, as if each
// signal were one trade:
//   BUY  → trade return = +pctMove   (you go long, you earn the move)
//   SELL → trade return = -pctMove   (you go short, you earn the inverse)
// pctMove is the % price change from entry to the horizon close, already
// stored per row. directionMatch is the engine's own hit flag; we don't
// rely on it for P&L (we use the signed move) but expose hit stats too.
//
// POSITION SIZING — fixed fractional. Each trade deploys a constant
// `fraction` of the *current* balance (default 25%), so the curve
// reflects the engine's directional EDGE without the volatility-drag
// artifact you get from betting 100% of the account on every one of
// ~2,000 sequential near-coinflip trades (that pins any such series to
// ~zero and tells you nothing about edge — it's a sizing pathology, not
// a verdict on the signals). Fixed-fractional is the standard, honest
// way to visualize a signal's cumulative edge; the per-trade average
// return (avgTradePct, sizing-independent) is also returned as the
// purest edge stat. We surface avg-per-trade + win rate alongside the
// dollar figure so the proof never rests on the arbitrary sizing alone.
//
// Returns { available, points:[{date, balance, equityPct}], trades,
// wins, winRatePct, avgTradePct, finalPct, finalBalance, horizonDays,
// startBalance, fraction } or available:false when the ledger is thin.
// `symbol` optional (scopes to one ticker); omit for the whole universe.
export async function readEngineEquityCurve({ symbol = null, horizonDays = 1, startBalance = 10000, fraction = 0.25 } = {}) {
    const allRows = await loadLedger();
    if (!allRows.length) return { available: false, points: [] };
    // Scope to the CURRENT engine: "would you have made money following the
    // engine" must mean the engine you're using now, not a retired one whose
    // P&L is irrelevant (and, for the pre-rebalance engine, misleadingly bad).
    const { rows, retired, gated, version } = await scopeToCurrentEngine(allRows);
    const hKey = String(horizonDays);
    const f = Math.max(0.01, Math.min(1, Number(fraction) || 0.25));
    let scoped = rows.filter(r =>
        (r.signal === 'BUY' || r.signal === 'SELL') &&
        r.horizons?.[hKey] &&
        Number.isFinite(r.horizons[hKey].pctMove) &&
        r.horizons[hKey].directionMatch != null
    );
    if (symbol) {
        const sym = String(symbol).toUpperCase();
        scoped = scoped.filter(r => r.symbol === sym);
    }
    // Chronological by prediction date so the curve reads left→right in time.
    scoped.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.predictedAt).localeCompare(String(b.predictedAt)));
    if (scoped.length < 3) {
        // Distinguish "engine just changed, rebuilding" from "genuinely empty"
        // so the UI can say which — see trust-panel's rebuilding copy.
        return { available: false, points: [], trades: scoped.length, rebuilding: gated && retired >= 3, retiredTrades: retired, engineVersion: version };
    }

    let balance = startBalance;
    let wins = 0;
    let retSum = 0;
    const points = [{ date: scoped[0].date, balance: +balance.toFixed(2), equityPct: 0 }];
    for (const r of scoped) {
        const h = r.horizons[hKey];
        const move = h.pctMove / 100;              // pctMove is in percent
        const tradeReturn = r.signal === 'BUY' ? move : -move;
        retSum += tradeReturn;
        balance *= (1 + f * tradeReturn);          // fixed-fractional sizing
        if (h.directionMatch) wins++;
        points.push({
            date: r.date,
            balance: +balance.toFixed(2),
            equityPct: +(((balance - startBalance) / startBalance) * 100).toFixed(2),
        });
    }
    return {
        available: true,
        symbol: symbol ? String(symbol).toUpperCase() : 'all',
        horizonDays,
        startBalance,
        fraction: f,
        engineVersion: version,
        retiredTrades: retired,   // rows excluded as prior-engine (for honest framing)
        trades: scoped.length,
        wins,
        winRatePct: Math.round((wins / scoped.length) * 100),
        // Pure, sizing-independent edge: mean signed return per trade.
        avgTradePct: +((retSum / scoped.length) * 100).toFixed(3),
        finalBalance: +balance.toFixed(2),
        finalPct: +(((balance - startBalance) / startBalance) * 100).toFixed(2),
        points,
    };
}

// Accuracy broken down by SETUP CONTEXT — the indicator conditions
// stored on each ledger row at prediction time. Answers "which setups
// does the engine read well?" honestly, using only data we actually
// logged (rsi, macd histogram, bb %b, signal direction).
//
// NOTE on regime: we deliberately do NOT claim a trending/ranging or
// risk-on/off breakdown — ADX and the macro regime aren't stored per
// row, so reconstructing them retroactively would be a guess. The
// dimensions below are all derived from real logged fields.
//
// Each dimension returns buckets with { label, resolved, hits, hitRate,
// enough } where `enough` flags >= MIN_N so the UI can dim thin buckets
// instead of trusting a 3-sample rate. 1-day horizon.
export async function readAccuracyBySetup({ horizonDays = 1, minN = 20 } = {}) {
    const allRows = await loadLedger();
    // Current-engine only: "which setups does the engine read well" must
    // describe how it scores NOW. A retired engine's setup hit-rates can be
    // the opposite of the current one's (the rebalance literally flipped the
    // momentum-vs-mean-reversion edge), so blending them is worse than useless.
    const { rows, retired, gated, version } = await scopeToCurrentEngine(allRows);
    const hKey = String(horizonDays);
    const resolved = rows.filter(r =>
        (r.signal === 'BUY' || r.signal === 'SELL') &&
        r.horizons?.[hKey] && r.horizons[hKey].directionMatch != null
    );
    if (resolved.length < 3) {
        return { available: false, totalResolved: resolved.length, rebuilding: gated && retired >= 3, retiredRows: retired, engineVersion: version };
    }

    // Generic bucketer: classify each row into a label, tally hit/total.
    const tally = (classify) => {
        const m = new Map();
        for (const r of resolved) {
            const label = classify(r);
            if (label == null) continue;
            const slot = m.get(label) || { resolved: 0, hits: 0 };
            slot.resolved++;
            if (r.horizons[hKey].directionMatch) slot.hits++;
            m.set(label, slot);
        }
        return [...m.entries()].map(([label, s]) => ({
            label,
            resolved: s.resolved,
            hits: s.hits,
            hitRate: s.resolved ? Math.round((s.hits / s.resolved) * 100) : null,
            enough: s.resolved >= minN,
        }));
    };

    // Stable display order per dimension (not alphabetical noise).
    const order = (arr, seq) => arr.sort((a, b) => seq.indexOf(a.label) - seq.indexOf(b.label));

    const byDirection = order(tally(r => r.signal), ['BUY', 'SELL']);

    const byRsi = order(tally(r => {
        const v = r.indicators?.rsi;
        if (!Number.isFinite(v)) return null;
        if (v < 30) return 'Oversold (RSI<30)';
        if (v > 70) return 'Overbought (RSI>70)';
        return 'Neutral RSI';
    }), ['Oversold (RSI<30)', 'Neutral RSI', 'Overbought (RSI>70)']);

    const byMomentum = order(tally(r => {
        const h = r.indicators?.macd?.histogram;
        if (!Number.isFinite(h)) return null;
        return h >= 0 ? 'Bullish momentum (MACD+)' : 'Bearish momentum (MACD−)';
    }), ['Bullish momentum (MACD+)', 'Bearish momentum (MACD−)']);

    const byBand = order(tally(r => {
        const b = r.indicators?.bb?.percent_b;
        if (!Number.isFinite(b)) return null;
        if (b < 0.33) return 'Lower band (cheap)';
        if (b > 0.67) return 'Upper band (extended)';
        return 'Mid band';
    }), ['Lower band (cheap)', 'Mid band', 'Upper band (extended)']);

    const overall = {
        resolved: resolved.length,
        hits: resolved.filter(r => r.horizons[hKey].directionMatch).length,
    };
    overall.hitRate = Math.round((overall.hits / overall.resolved) * 100);
    // Avg target-capture across rows that carry it (new, target-stored rows).
    const capRows = resolved.filter(r => Number.isFinite(r.horizons[hKey].capturedPct));
    overall.avgCapturedPct = capRows.length
        ? Math.round(capRows.reduce((s, r) => s + r.horizons[hKey].capturedPct, 0) / capRows.length)
        : null;
    overall.capturedSampleN = capRows.length;

    return {
        available: true,
        horizonDays,
        minN,
        engineVersion: version,
        retiredRows: retired,
        overall,
        dimensions: [
            { key: 'direction', title: 'By signal direction', buckets: byDirection },
            { key: 'rsi', title: 'By RSI zone at entry', buckets: byRsi },
            { key: 'momentum', title: 'By MACD momentum', buckets: byMomentum },
            { key: 'band', title: 'By Bollinger position', buckets: byBand },
        ],
    };
}

export async function readLedgerHistory({ symbol, limit = 10 } = {}) {
    const rows = await loadLedger();
    if (!rows.length) {
        return { available: false, note: 'Ledger not seeded yet — needs at least one cron run.' };
    }
    let scoped = rows;
    if (symbol) {
        const sym = String(symbol).toUpperCase();
        scoped = rows.filter(r => r.symbol === sym);
    }
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const recent = scoped.slice(-lim);
    // The recent-rows LOG is factual history (any engine genuinely predicted
    // these), so we show it as-is. But the headline HIT-RATE is an
    // engine-accuracy claim, so we compute it over CURRENT-engine rows only —
    // mixing a retired engine's outcomes into "how accurate is it" would be
    // dishonest right after a scoring change.
    const ver = await currentEngineVersion();
    let resolvedN = 0, hits = 0;
    let capN = 0, capSum = 0;
    let retiredResolved = 0;
    for (const r of recent) {
        const h1 = r.horizons?.['1'];
        if (!h1 || h1.directionMatch == null) continue;
        const isCurrent = !ver || (r.engineVersion || 'unversioned') === ver;
        if (!isCurrent) { retiredResolved++; continue; }
        resolvedN++;
        if (h1.directionMatch) hits++;
        if (Number.isFinite(h1.capturedPct)) { capN++; capSum += h1.capturedPct; }
    }
    return {
        available: true,
        symbol: symbol || 'all',
        rowsReturned: recent.length,
        totalForSymbol: scoped.length,
        engineVersion: ver || null,
        // True when the hit-rate is blank only because recent resolved rows
        // belong to a retired engine — i.e. the record is rebuilding, not absent.
        rebuilding: !!ver && resolvedN === 0 && retiredResolved >= 3,
        resolved1d: resolvedN,
        hits1d: hits,
        hitRate1dPct: resolvedN ? Math.round((hits / resolvedN) * 100) : null,
        // Avg % of the predicted move captured (quality, not just direction).
        // null until enough rows carry a stored target.
        avgCapturedPct: capN ? Math.round(capSum / capN) : null,
        capturedSampleN: capN,
        recent,
    };
}
