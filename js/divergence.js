// Pivot-based divergence detection across RSI, MACD-histogram, OBV.
//
// Why: bullish/bearish divergences are one of the highest-edge
// classical signals in retail TA. Price makes a new extreme but
// the underlying momentum/volume-flow indicator does NOT — a leading
// signal that the move is running out of fuel.
//
// We only trust divergences when 2+ indicators agree. Single-indicator
// divergences are noisy.

const PIVOT_LOOKBACK = 5; // bars on each side

function findPivots(values, kind /* 'high' | 'low' */) {
    const piv = [];
    for (let i = PIVOT_LOOKBACK; i < values.length - PIVOT_LOOKBACK; i++) {
        let isPivot = true;
        for (let k = 1; k <= PIVOT_LOOKBACK; k++) {
            if (kind === 'high') {
                if (values[i] <= values[i - k] || values[i] <= values[i + k]) { isPivot = false; break; }
            } else {
                if (values[i] >= values[i - k] || values[i] >= values[i + k]) { isPivot = false; break; }
            }
        }
        if (isPivot) piv.push({ idx: i, value: values[i] });
    }
    return piv;
}

function macdHistogramSeries(closes) {
    // Replicate the engine's MACD line then derive histogram series.
    const fast = 12, slow = 26, sig = 9;
    if (closes.length < slow + sig) return [];
    const ema = (vals, p) => {
        const m = 2 / (p + 1);
        const out = [vals.slice(0, p).reduce((a, b) => a + b, 0) / p];
        for (let i = p; i < vals.length; i++) out.push((vals[i] - out[out.length - 1]) * m + out[out.length - 1]);
        return out;
    };
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const macd = [];
    const start = slow - 1;
    for (let i = start; i < closes.length; i++) {
        const fi = i - (fast - 1), si = i - (slow - 1);
        if (fi >= 0 && si >= 0 && fi < ef.length && si < es.length) macd.push(ef[fi] - es[si]);
    }
    if (macd.length < sig) return [];
    const sigLine = ema(macd, sig);
    const hist = [];
    for (let i = 0; i < sigLine.length; i++) hist.push(macd[i + (macd.length - sigLine.length)] - sigLine[i]);
    return hist;
}

function rsiSeries(closes, period = 14) {
    if (closes.length < period + 1) return [];
    const out = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    let avgG = gains / period, avgL = losses / period;
    out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
        avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
        out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
    }
    return out;
}

function obvSeries(closes, volumes) {
    if (closes.length !== volumes.length || closes.length < 2) return [];
    const out = [0];
    for (let i = 1; i < closes.length; i++) {
        const prev = out[out.length - 1];
        if (closes[i] > closes[i - 1]) out.push(prev + (volumes[i] || 0));
        else if (closes[i] < closes[i - 1]) out.push(prev - (volumes[i] || 0));
        else out.push(prev);
    }
    return out;
}

/**
 * Returns {
 *   bullish: { confirmedBy: ['rsi','macd','obv'], strength: 0..1, reason: "..." } | null,
 *   bearish: same | null,
 * }
 */
export function detectDivergences(candles) {
    if (!candles || candles.length < 60) return { bullish: null, bearish: null };
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume || 0);

    const indicators = {
        rsi: rsiSeries(closes),
        macd: macdHistogramSeries(closes),
        obv: obvSeries(closes, volumes),
    };

    // Align indicator series to the same length as price by trimming the front.
    const trim = name => {
        const s = indicators[name];
        if (!s || s.length === 0) return null;
        return { full: s, offset: closes.length - s.length };
    };

    const priceLowsP = findPivots(lows, 'low');
    const priceHighsP = findPivots(highs, 'high');

    // Bullish divergence: last 2 price-low pivots show LOWER LOW;
    // indicator at the same indices shows HIGHER LOW.
    function checkBullish() {
        if (priceLowsP.length < 2) return null;
        const [a, b] = priceLowsP.slice(-2);
        if (b.value >= a.value) return null; // not a lower low
        const confirmedBy = [];
        ['rsi','macd','obv'].forEach(name => {
            const t = trim(name);
            if (!t) return;
            const ai = a.idx - t.offset, bi = b.idx - t.offset;
            if (ai < 0 || bi < 0 || bi >= t.full.length) return;
            if (t.full[bi] > t.full[ai]) confirmedBy.push(name);
        });
        if (confirmedBy.length < 2) return null;
        return {
            confirmedBy,
            strength: Math.min(1, confirmedBy.length / 3),
            reason: `Bullish divergence: lower low in price, higher low in ${confirmedBy.join(' + ')}`,
        };
    }

    function checkBearish() {
        if (priceHighsP.length < 2) return null;
        const [a, b] = priceHighsP.slice(-2);
        if (b.value <= a.value) return null; // not a higher high
        const confirmedBy = [];
        ['rsi','macd','obv'].forEach(name => {
            const t = trim(name);
            if (!t) return;
            const ai = a.idx - t.offset, bi = b.idx - t.offset;
            if (ai < 0 || bi < 0 || bi >= t.full.length) return;
            if (t.full[bi] < t.full[ai]) confirmedBy.push(name);
        });
        if (confirmedBy.length < 2) return null;
        return {
            confirmedBy,
            strength: Math.min(1, confirmedBy.length / 3),
            reason: `Bearish divergence: higher high in price, lower high in ${confirmedBy.join(' + ')}`,
        };
    }

    return { bullish: checkBullish(), bearish: checkBearish() };
}
