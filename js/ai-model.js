// AI Model — LSTM inference in pure JavaScript, ensembled with GBT when available.
//
// Phase 8 addition: tier-aware model selection. When the engine detects
// tier='penny', we use a SEPARATE penny-trained LSTM (lstm_weights_penny.json)
// because penny stocks have wholly different dynamics than mid/large-caps.
// If the penny weights file isn't yet available (first ~2 weeks before the
// Sunday cron has populated it), we transparently fall back to the main LSTM —
// no regression for penny analyses, just unrealized upside until the file lands.
//
// IMPORTANT: feature extraction here MUST match train_model.py and
// train_penny_lstm.py exactly. Any drift biases predictions silently.

import { loadGbtModel, predictGbt, isGbtLoaded } from './xgb-model.js';

const MAIN_KEY = 'main';
const PENNY_KEY = 'penny';
const INTRADAY_KEY = 'intraday';

// Cache parsed model JSON per tier so we don't refetch on every prediction.
// MUST stay in step with GBT_IN_BLEND in ai_infer.py. See the note in
// getAIPrediction for the measurement behind it.
const GBT_IN_BLEND = false;

const modelCache = {};      // { main: {weights, config}, penny: {...} | 'unavailable' }
const loadingPromises = {}; // { main: Promise<bool>, penny: Promise<bool> }

// Lookback bars fetched BEFORE the sequence window so trailing
// indicators have history. ADX needs ~2*period (28) bars of warm-up
// before its first real value, so 30 gives the first sequence bar a
// real ADX instead of the neutral fallback. (Was 21 when the model
// only used RSI/MA/BB which need ≤21.)
const LOOKBACK = 30;

const MODEL_FILES = {
    [MAIN_KEY]: './model/lstm_weights.json',
    [PENNY_KEY]: './model/lstm_weights_penny.json',
    [INTRADAY_KEY]: './model/lstm_weights_intraday.json',
};

async function loadModelForTier(tier) {
    const key = MODEL_FILES[tier] ? tier : MAIN_KEY;
    if (modelCache[key] === 'unavailable') return false;
    if (modelCache[key]) return true;
    if (loadingPromises[key]) return loadingPromises[key];

    const file = MODEL_FILES[key] || MODEL_FILES[MAIN_KEY];
    loadingPromises[key] = (async () => {
        try {
            const res = await fetch(file);
            if (!res.ok) {
                modelCache[key] = 'unavailable';
                return false;
            }
            const data = await res.json();
            modelCache[key] = { config: data.config, weights: data.weights };
            return true;
        } catch (_) {
            modelCache[key] = 'unavailable';
            return false;
        }
    })();
    const ok = await loadingPromises[key];
    loadingPromises[key] = null;
    return ok;
}

export async function loadModel() {
    // Both loads start together AND both are awaited. The GBT load used to be
    // fire-and-forget, which made isGbtLoaded() a RACE between two independent
    // fetches: whichever of xgb_trees.json / lstm_weights.json arrived first decided
    // whether the GBT appeared in the result at all.
    //
    // The parity check caught it as an intermittent 1-in-10 failure -- green here
    // where both files sit in the OS page cache, red on a cold CI runner where the
    // bigger GBT file loses. The same race exists in the browser on a slow
    // connection, and it silently drops the `gbt` field from recorded ledger rows.
    // That field is the ONLY evidence being collected to decide whether to
    // re-enable GBT_IN_BLEND after a retrain, so losing it at random is a data
    // problem, not a cosmetic one.
    //
    // Promise.all keeps the parallelism that motivated the original code. .catch is
    // belt-and-braces: loadGbtModel already swallows its own errors, but a future
    // edit that lets it reject must not take the LSTM down with it.
    const [, mainOk] = await Promise.all([
        loadGbtModel().catch(() => null),
        loadModelForTier(MAIN_KEY),
    ]);
    // Pre-warm main; penny is loaded on demand via getAIPrediction.
    return mainOk;
}

export function computeFeatures(candles, configOverride) {
    const cfg = configOverride || (modelCache[MAIN_KEY]?.config) || { sequence_length: 20 };
    const seqLen = cfg.sequence_length;

    if (candles.length < seqLen + LOOKBACK) return null;

    const allCandles = candles.slice(-(seqLen + LOOKBACK));
    const close = allCandles.map(c => c.close);
    const high = allCandles.map(c => c.high);
    const low = allCandles.map(c => c.low);
    const volume = allCandles.map(c => c.volume || 0);

    const features = [];

    for (let idx = 0; idx < seqLen; idx++) {
        const j = allCandles.length - seqLen + idx;

        const priceChange = j > 0 ? (close[j] - close[j - 1]) / (close[j - 1] + 1e-8) : 0;
        const highLowRange = (high[j] - low[j]) / (close[j] + 1e-8);

        let rsi = 0.5;
        if (j >= 14) {
            let gains = 0, losses = 0;
            for (let k = j - 13; k <= j; k++) {
                const diff = close[k] - close[k - 1];
                if (diff > 0) gains += diff;
                else losses -= diff;
            }
            rsi = gains / (gains + losses + 1e-8);
        }

        let volRatio = 0.2;
        if (j >= 20) {
            let sum = 0;
            for (let k = j - 20; k <= j; k++) sum += volume[k];
            const avgVol = sum / 21;
            volRatio = Math.min(volume[j] / (avgVol + 1e-8), 5.0) / 5.0;
        }

        let maRatio9 = 0;
        if (j >= 9) {
            let sum = 0;
            for (let k = j - 8; k <= j; k++) sum += close[k];
            const sma9 = sum / 9;
            maRatio9 = (close[j] - sma9) / (sma9 + 1e-8);
        }

        let maRatio21 = 0;
        if (j >= 21) {
            let sum = 0;
            for (let k = j - 20; k <= j; k++) sum += close[k];
            const sma21 = sum / 21;
            maRatio21 = (close[j] - sma21) / (sma21 + 1e-8);
        }

        let bbPosition = 0;
        if (j >= 20) {
            let sum = 0;
            for (let k = j - 19; k <= j; k++) sum += close[k];
            const bbMean = sum / 20;
            let variance = 0;
            for (let k = j - 19; k <= j; k++) variance += (close[k] - bbMean) ** 2;
            const bbStd = Math.sqrt(variance / 20) + 1e-8;
            bbPosition = Math.max(-1, Math.min(1, (close[j] - bbMean) / (2 * bbStd)));
        }

        let momentum = 0;
        if (j >= 5) {
            momentum = (close[j] - close[j - 5]) / (close[j - 5] + 1e-8);
        }

        const row = [
            priceChange * 10,
            highLowRange * 10,
            rsi,
            volRatio,
            maRatio9 * 10,
            maRatio21 * 10,
            bbPosition,
            momentum * 5,
        ];

        // Features 9-11 (ADX / MFI / ATR%) only emitted when the loaded
        // model declares it expects them. An 8-feature model file →
        // featureCount 8 → we stop here. An 11-feature model → we append
        // the three extras. This keeps inference correct against EITHER
        // a still-deployed 8-feature model or a freshly-retrained
        // 11-feature one — no dimension-mismatch window. See
        // shared_features.py VERSION SAFETY note.
        const featureCount = cfg.features || cfg.input_size || 8;
        if (featureCount >= 11) {
            row.push(adxAt(high, low, close, j) / 100);
            row.push(mfiAt(high, low, close, volume, j) / 100);
            row.push(Math.min(atrPctAt(high, low, close, j), 0.5) * 2);
        }

        features.push(row);
    }

    return features;
}

// ── Per-bar indicator helpers (mirror shared_features.py exactly) ──────────

// Wilder ADX over the trailing window ending at bar j. 0..100.
function adxAt(high, low, close, j, period = 14) {
    const start = j - (2 * period);
    if (start < 1) return 20.0;
    let trSum = 0, plusSum = 0, minusSum = 0;
    for (let i = start + 1; i <= start + period; i++) {
        const up = high[i] - high[i - 1];
        const dn = low[i - 1] - low[i];
        const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
        trSum += tr;
        plusSum += (up > dn && up > 0) ? up : 0;
        minusSum += (dn > up && dn > 0) ? dn : 0;
    }
    const dx = [];
    for (let i = start + period + 1; i <= j; i++) {
        const up = high[i] - high[i - 1];
        const dn = low[i - 1] - low[i];
        const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
        trSum = trSum - trSum / period + tr;
        plusSum = plusSum - plusSum / period + ((up > dn && up > 0) ? up : 0);
        minusSum = minusSum - minusSum / period + ((dn > up && dn > 0) ? dn : 0);
        const plusDi = trSum === 0 ? 0 : 100 * plusSum / trSum;
        const minusDi = trSum === 0 ? 0 : 100 * minusSum / trSum;
        const sumDi = plusDi + minusDi;
        dx.push(sumDi === 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / sumDi);
    }
    if (!dx.length) return 20.0;
    const seed = Math.min(period, dx.length);
    let adx = dx.slice(0, seed).reduce((s, v) => s + v, 0) / seed;
    for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
    return adx;
}

// Money Flow Index over the trailing window ending at bar j. 0..100.
function mfiAt(high, low, close, volume, j, period = 14) {
    if (j < period) return 50.0;
    let posFlow = 0, negFlow = 0;
    for (let i = j - period + 1; i <= j; i++) {
        const tp = (high[i] + low[i] + close[i]) / 3;
        const tpPrev = (high[i - 1] + low[i - 1] + close[i - 1]) / 3;
        const mf = tp * volume[i];
        if (tp > tpPrev) posFlow += mf;
        else if (tp < tpPrev) negFlow += mf;
    }
    if (negFlow === 0) return posFlow > 0 ? 100.0 : 50.0;
    const ratio = posFlow / negFlow;
    return 100 - (100 / (1 + ratio));
}

// ATR as a fraction of price over the trailing window ending at bar j.
function atrPctAt(high, low, close, j, period = 14) {
    if (j < period) return 0.02;
    let trSum = 0;
    for (let i = j - period + 1; i <= j; i++) {
        trSum += Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    }
    return (trSum / period) / (close[j] + 1e-8);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); }
function tanh(x) { const ex = Math.exp(2 * Math.max(-500, Math.min(500, x))); return (ex - 1) / (ex + 1); }
function relu(x) { return Math.max(0, x); }
function matmul(matrix, vector) { return matrix.map(row => row.reduce((sum, val, i) => sum + val * vector[i], 0)); }
function addVectors(a, b) { return a.map((val, i) => val + b[i]); }

function lstmCell(input, hPrev, cPrev, weights, biases) {
    const hiddenSize = hPrev.length;
    const combinedInput = [...input, ...hPrev];
    const gates = addVectors(matmul(weights, combinedInput), biases);
    const i = gates.slice(0, hiddenSize).map(sigmoid);
    const f = gates.slice(hiddenSize, 2 * hiddenSize).map(sigmoid);
    const g = gates.slice(2 * hiddenSize, 3 * hiddenSize).map(tanh);
    const o = gates.slice(3 * hiddenSize, 4 * hiddenSize).map(sigmoid);
    const cNew = cPrev.map((c, idx) => f[idx] * c + i[idx] * g[idx]);
    const hNew = cNew.map((c, idx) => o[idx] * tanh(c));
    return { h: hNew, c: cNew };
}

function runLSTMWith(features, modelData) {
    if (!modelData || !modelData.weights || !modelData.config) return null;
    const weights = modelData.weights;
    const { hidden_size, num_layers } = modelData.config;

    let h = Array.from({ length: num_layers }, () => new Array(hidden_size).fill(0));
    let c = Array.from({ length: num_layers }, () => new Array(hidden_size).fill(0));

    for (const timestep of features) {
        let layerInput = timestep;
        for (let layer = 0; layer < num_layers; layer++) {
            const ihW = weights[`lstm.weight_ih_l${layer}`];
            const hhW = weights[`lstm.weight_hh_l${layer}`];
            const ihB = weights[`lstm.bias_ih_l${layer}`];
            const hhB = weights[`lstm.bias_hh_l${layer}`];
            if (!ihW || !hhW) return null;
            const combinedW = ihW.map((row, i) => [...row, ...hhW[i]]);
            const combinedB = ihB.map((b, i) => b + hhB[i]);
            const result = lstmCell(layerInput, h[layer], c[layer], combinedW, combinedB);
            h[layer] = result.h;
            c[layer] = result.c;
            layerInput = result.h;
        }
    }

    const lastHidden = h[num_layers - 1];
    const fc1W = weights['fc1.weight'];
    const fc1B = weights['fc1.bias'];
    if (!fc1W || !fc1B) return null;
    let fc1Out = addVectors(matmul(fc1W, lastHidden), fc1B).map(relu);
    const fc2W = weights['fc2.weight'];
    const fc2B = weights['fc2.bias'];
    if (!fc2W || !fc2B) return null;
    const output = fc2W[0].reduce((sum, w, i) => sum + w * fc1Out[i], 0) + fc2B[0];
    return sigmoid(output);
}

/**
 * Phase 8: tier-aware model selection.
 * If tier='penny' AND penny weights are available → use penny model (isolated).
 * Otherwise → use main model (default + fallback).
 */
export async function getAIPrediction(candles, opts = {}) {
    const { tier = null, intraday = false } = opts;
    const wantPenny = tier === 'penny';

    let modelKey = MAIN_KEY;
    let modelOk = await loadModelForTier(MAIN_KEY);
    // Intraday model takes precedence on the Today horizon (when caller
    // passes intraday:true AND supplied 1h candles). It is NOT used for
    // penny stocks — those keep their dedicated penny dynamics, which
    // matter more than the intraday granularity for sub-$5 names.
    if (intraday && !wantPenny) {
        const intradayOk = await loadModelForTier(INTRADAY_KEY);
        if (intradayOk) {
            modelKey = INTRADAY_KEY;
        }
        // else fall back to main daily model — no regression if the
        // intraday weights file hasn't shipped yet.
    } else if (wantPenny) {
        const pennyOk = await loadModelForTier(PENNY_KEY);
        if (pennyOk) {
            modelKey = PENNY_KEY;
        }
        // else fall back to main — no regression on penny analyses if file missing.
    }
    if (!modelOk && modelKey === MAIN_KEY) {
        return { score: 50, available: false, reason: 'AI model not loaded' };
    }

    const modelData = modelCache[modelKey];
    if (!modelData || modelData === 'unavailable') {
        return { score: 50, available: false, reason: 'AI model unavailable' };
    }

    const features = computeFeatures(candles, modelData.config);
    if (!features) {
        return { score: 50, available: false, reason: 'Insufficient data for AI model (need 41+ candles)' };
    }

    const lstmProb = runLSTMWith(features, modelData);
    if (lstmProb === null) {
        return { score: 50, available: false, reason: 'AI inference failed' };
    }

    // Ensure the GBT is loaded rather than merely hoping someone called loadModel().
    // isGbtLoaded() alone was a latent bug independent of the race above: this
    // function never triggered the load, so ANY caller reaching getAIPrediction
    // without going through loadModel() got gbt:null forever. The only two callers
    // that do call it (js/ui/core.js and bot/advise.mjs) both did so without
    // awaiting, so in practice this was decided by fetch timing.
    //
    // Awaiting is close to free: loadGbtModel returns the cached model immediately
    // once status has left 'unloaded', so only the first call ever pays.
    let gbtProb = null;
    await loadGbtModel().catch(() => null);
    if (isGbtLoaded()) {
        try { gbtProb = predictGbt(features[features.length - 1]); } catch (_) {}
    }

    // The GBT has NO DISCRIMINATION and must not dilute the LSTM.
    //
    // Measured on 600 real market states (20 symbols x 30 recent sessions):
    //     GBT   19 distinct outputs, min 0.529, 100.0% bullish, 60% on 0.646
    //     LSTM  594 distinct outputs, range 0.018-0.842, 46.0% bullish
    //
    // The GBT never says "down". It is a near-constant bullish offset, which is
    // also why it measures 51.79% against a label whose base rate is 53.58%.
    // Averaging it 50/50 compressed the LSTM's range, shifted every score up, and
    // let a constant OVERRIDE an informative call: DY came out LSTM 0.376
    // (bearish) blended with GBT 0.646 to 0.511, i.e. neutral. The only model with
    // an opinion was outvoted by one that never has one.
    //
    // gbtProb is still REPORTED below, so nothing is lost and it can be
    // re-evaluated after a retrain. Only the headline blend changes.
    // Flip GBT_IN_BLEND back on once a retrained GBT shows two-sided output; the
    // ai_sync_check parity test will hold you to changing ai_infer.py too.
    const probability = (GBT_IN_BLEND && gbtProb != null && Number.isFinite(gbtProb))
        ? (lstmProb + gbtProb) / 2
        : lstmProb;
    const score = Math.round(probability * 100);

    let signal;
    if (probability > 0.6) signal = 'bullish';
    else if (probability < 0.4) signal = 'bearish';
    else signal = 'neutral';

    const modelLabel = modelKey === PENNY_KEY ? 'Penny-LSTM'
        : modelKey === INTRADAY_KEY ? 'Intraday-LSTM (1h)'
        : 'LSTM';
    const reason = (GBT_IN_BLEND && gbtProb != null)
        ? `AI ensemble (${modelLabel} ${Math.round(lstmProb * 100)}% + GBT ${Math.round(gbtProb * 100)}%): ${score}% probability of upward move`
        : (gbtProb != null)
            ? `AI pattern recognition (${modelLabel} only): ${score}% probability of upward move. `
              + `GBT (${Math.round(gbtProb * 100)}%) recorded but excluded: no measurable discrimination.`
            : `AI pattern recognition (${modelLabel} only): ${score}% probability of upward move`;

    return {
        score, available: true,
        probability: Math.round(probability * 1000) / 1000,
        modelTier: modelKey,
        lstm: { score: Math.round(lstmProb * 100), probability: Math.round(lstmProb * 1000) / 1000 },
        gbt: gbtProb != null ? { score: Math.round(gbtProb * 100), probability: Math.round(gbtProb * 1000) / 1000 } : null,
        signal, reason,
    };
}
