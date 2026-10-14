// How much of the pullback setup's hit rate comes from its exit rule (model/setup_baseline.json,
// written by tools/calibrate_setup_baseline.py). The setups list and the cards show it beside the
// setup's own rate, because "67% sold above their entry" reads as an edge in the odds when the
// same exit does about as well on any uptrending stock below its 5-day average. The edge is size.

let _b = null;
let _p = null;

export async function loadSetupBaseline() {
    if (_b !== null) return _b || null;
    if (_p) return _p;
    _p = (async () => {
        try {
            const r = await fetch('model/setup_baseline.json', { cache: 'no-cache' });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('not json');
            const j = await r.json();
            _b = j && j.baseN && Number.isFinite(j.baseSoldAbove) ? j : false;
        } catch (_) { _b = false; }
        return _b || null;
    })();
    return _p;
}

/** For tests: inject a baseline (or null to clear). */
export function setSetupBaseline(b) { _b = b || false; _p = null; }

const pct1 = (x) => `${(x * 100).toFixed(1)}%`;

/** The comparison in plain words, or '' when the file is missing. */
export function baselineSentence(b, { lead = 'Most of that rate comes from the exit rule itself' } = {}) {
    if (!b || !Number.isFinite(b.baseSoldAbove)) return '';
    const size = Number.isFinite(b.excessPayBps) ? b.excessPayBps / 100 : null;
    return `${lead}: any uptrending stock bought below its 5-day average with the same exit sold above its entry `
        + `${pct1(b.baseSoldAbove)} of the time (${b.baseN.toLocaleString()} trades, ${b.from}-${b.to}), `
        + `against ${pct1(b.setupSoldAbove)} for these sharper dips.`
        + (size == null ? ''
            : size >= 0 ? ` What the dip adds is size: about ${size.toFixed(2)}% more per trade than an ordinary dip bought the same day.`
            : ` And it earned ${Math.abs(size).toFixed(2)}% less per trade than an ordinary dip bought the same day.`);
}
