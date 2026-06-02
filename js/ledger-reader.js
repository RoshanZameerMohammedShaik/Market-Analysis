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
    for (const r of recent) {
        const h1 = r.horizons?.['1'];
        if (h1) { resolvedN++; if (h1.directionMatch) hits++; }
    }
    return {
        available: true,
        symbol: symbol || 'all',
        rowsReturned: recent.length,
        totalForSymbol: scoped.length,
        resolved1d: resolvedN,
        hits1d: hits,
        hitRate1dPct: resolvedN ? Math.round((hits / resolvedN) * 100) : null,
        recent,
    };
}
