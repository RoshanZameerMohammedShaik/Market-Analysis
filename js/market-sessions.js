// Exchange trading sessions, holidays included. MIRRORS market_sessions.py.
//
// Read from model/market_sessions.json, published nightly from the exchange_calendars library
// (tools/write_market_sessions.py). Before this every session count was weekdays only, so a
// holiday shifted each later band row by one: Tokyo is shut 2026-10-12, NSE 2026-10-02, HKEX
// 2026-10-01. Outside the published window, or before the file has loaded, the weekday rule
// applies, exactly as before, and coveredBy() says which one a caller got.
//
// Synchronous by design: the band labels and earnings check are synchronous. core.js loads the
// file at boot; Node checks hand it in with setMarketSessions().

const URL_ = 'model/market_sessions.json';
let _data = null;
let _promise = null;

export function setMarketSessions(d) {
    if (d?.markets) {
        for (const m of Object.values(d.markets)) m._set = new Set(m.sessions || []);
        _data = d;
    } else {
        _data = null;
    }
    return _data;
}

export function loadMarketSessions() {
    if (_promise) return _promise;
    _promise = (async () => {
        try {
            const r = await fetch(URL_, { cache: 'no-cache' });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
            return setMarketSessions(await r.json());
        } catch (_) { return null; }
    })();
    return _promise;
}

const market = (region) => _data?.markets?.[String(region || '').toUpperCase()] || null;

/** True when the ISO date is inside the published holiday window for this region. */
export function coveredBy(region, iso) {
    const m = market(region);
    return !!m && m.sessions.length > 0 && iso >= m.sessions[0] && iso <= m.to;
}

/** Is `iso` a trading session? `days` are the weekdays the exchange trades (0 = Sunday). */
export function isSession(region, iso, days = [1, 2, 3, 4, 5]) {
    const m = market(region);
    if (m && coveredBy(region, iso)) return m._set.has(iso);
    return days.includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
}

/** The exchange's published holidays from `fromIso` on (for labels and explanations). */
export function holidaysFrom(region, fromIso) {
    const m = market(region);
    return m ? (m.holidays || []).filter(h => h >= fromIso) : [];
}
