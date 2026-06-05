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
export async function readEngineEquityCurve({ symbol = null, horizonDays = 5, startBalance = 10000, fraction = 0.25 } = {}) {
    const rows = await loadLedger();
    if (!rows.length) return { available: false, points: [] };
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
    if (scoped.length < 3) return { available: false, points: [], trades: scoped.length };

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
    const rows = await loadLedger();
    const hKey = String(horizonDays);
    const resolved = rows.filter(r =>
        (r.signal === 'BUY' || r.signal === 'SELL') &&
        r.horizons?.[hKey] && r.horizons[hKey].directionMatch != null
    );
    if (resolved.length < 3) return { available: false, totalResolved: resolved.length };

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
    let resolvedN = 0, hits = 0;
    // capturedPct quality (only on rows that carry it — new rows with a
    // stored target; legacy rows are null and excluded from the average).
    let capN = 0, capSum = 0;
    for (const r of recent) {
        const h1 = r.horizons?.['1'];
        if (h1) {
            resolvedN++;
            if (h1.directionMatch) hits++;
            if (Number.isFinite(h1.capturedPct)) { capN++; capSum += h1.capturedPct; }
        }
    }
    return {
        available: true,
        symbol: symbol || 'all',
        rowsReturned: recent.length,
        totalForSymbol: scoped.length,
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
