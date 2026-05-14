// Macro regime detection. Computes a single tag from VIX trajectory,
// S&P 500 trend, and DXY (dollar). Cached for 10 min so we don't hit
// the data sources repeatedly per analysis.

import { fetchWithProxy } from './data.js';

let cache = null; // { regime, components, ts }
const TTL_MS = 10 * 60 * 1000;

async function fetchClose(symbol, range = '5d') {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    const closes = r?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
    return closes;
}

export async function getMacroRegime() {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache;

    const out = { regime: 'neutral', components: {}, ts: Date.now() };
    try {
        const [vix, sp, dxy] = await Promise.allSettled([
            fetchClose('%5EVIX', '1mo'),
            fetchClose('%5EGSPC', '1mo'),
            fetchClose('DX-Y.NYB', '1mo'),
        ]);

        // VIX: higher = more fear. Levels: <15 calm, 15-20 normal, 20-30 elevated, >30 panic.
        if (vix.status === 'fulfilled' && vix.value.length > 5) {
            const v = vix.value;
            const cur = v[v.length - 1];
            const prev5 = v[Math.max(0, v.length - 6)];
            const trend = cur - prev5;
            out.components.vix = { level: cur, change5d: trend };
        }

        // S&P 500: 5d and 10d % change.
        if (sp.status === 'fulfilled' && sp.value.length > 10) {
            const s = sp.value;
            const cur = s[s.length - 1];
            const back5 = s[s.length - 6];
            const back10 = s[s.length - 11];
            out.components.sp500 = {
                pct5d: ((cur - back5) / back5) * 100,
                pct10d: ((cur - back10) / back10) * 100,
            };
        }

        // DXY (dollar): rising dollar = pressure on growth + risk assets.
        if (dxy.status === 'fulfilled' && dxy.value.length > 5) {
            const d = dxy.value;
            const pct5d = ((d[d.length - 1] - d[d.length - 6]) / d[d.length - 6]) * 100;
            out.components.dxy = { pct5d };
        }

        // Combine into regime label.
        const v = out.components.vix?.level;
        const sp5 = out.components.sp500?.pct5d;
        const dxy5 = out.components.dxy?.pct5d || 0;

        let regime = 'neutral';
        if (v != null && sp5 != null) {
            const fearOn = v > 22;
            const fearOff = v < 16;
            const spUp = sp5 > 1.0;
            const spDown = sp5 < -1.0;
            const dollarStrong = dxy5 > 1.0;
            if (fearOff && spUp && !dollarStrong) regime = 'risk-on';
            else if (fearOn && spDown) regime = 'risk-off';
            else if (Math.abs(sp5) < 0.5 && Math.abs(dxy5) < 0.5 && v < 22) regime = 'neutral';
            else regime = 'transition';
        }
        out.regime = regime;
    } catch (e) {
        out.error = e.message;
    }
    cache = out;
    return out;
}

// Used by sector-relative scoring: how should signals be weighted given the regime?
export function regimeBias(regime) {
    switch (regime) {
        case 'risk-on':    return { momentum: +1, meanReversion: 0, pen: 0 };
        case 'risk-off':   return { momentum: -2, meanReversion: +1, pen: 3 };
        case 'transition': return { momentum: 0, meanReversion: 0, pen: 1 };
        default:           return { momentum: 0, meanReversion: 0, pen: 0 };
    }
}
