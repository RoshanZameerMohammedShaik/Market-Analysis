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

// Cache parsed model JSON per tier so we don't refetch on every prediction.
const modelCache = {};      // { main: {weights, config}, penny: {...} | 'unavailable' }
const loadingPromises = {}; // { main: Promise<bool>, penny: Promise<bool> }

const LOOKBACK = 21;

async function loadModelForTier(tier) {
    const key = tier === PENNY_KEY ? PENNY_KEY : MAIN_KEY;
    if (modelCache[key] === 'unavailable') return false;
    if (modelCache[key]) return true;
    if (loadingPromises[key]) return loadingPromises[key];

    const file = key === PENNY_KEY ? './model/lstm_weights_penny.json' : './model/lstm_weights.json';
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
    // Kick off GBT load in parallel.
    loadGbtModel();
    // Pre-warm main; penny is loaded on demand via getAIPrediction.
    return await loadModelForTier(MAIN_KEY);
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

        features.push([
            priceChange * 10,
            highLowRange * 10,
            rsi,
            volRatio,
            maRatio9 * 10,
            maRatio21 * 10,
            bbPosition,
            momentum * 5,
        ]);
    }

    return features;
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
    const { tier = null } = opts;
    const wantPenny = tier === 'penny';

    let modelKey = MAIN_KEY;
    let modelOk = await loadModelForTier(MAIN_KEY);
    if (wantPenny) {
        const pennyOk = await loadModelForTier(PENNY_KEY);
        if (pennyOk) {
            modelKey = PENNY_KEY;
        }
        // else fall back to main — no regression on penny analyses if file missing.
    }
    if (!modelOk && modelKey !== PENNY_KEY) {
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

    let gbtProb = null;
    if (isGbtLoaded()) {
        try { gbtProb = predictGbt(features[features.length - 1]); } catch (_) {}
    }

    const probability = (gbtProb != null && Number.isFinite(gbtProb)) ? (lstmProb + gbtProb) / 2 : lstmProb;
    const score = Math.round(probability * 100);

    let signal;
    if (probability > 0.6) signal = 'bullish';
    else if (probability < 0.4) signal = 'bearish';
    else signal = 'neutral';

    const modelLabel = modelKey === PENNY_KEY ? 'Penny-LSTM' : 'LSTM';
    const reason = (gbtProb != null)
        ? `AI ensemble (${modelLabel} ${Math.round(lstmProb * 100)}% + GBT ${Math.round(gbtProb * 100)}%): ${score}% probability of upward move`
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
