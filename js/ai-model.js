// AI Model — LSTM inference in pure JavaScript
// Loads pre-trained weights from JSON, runs forward pass in browser.
//
// IMPORTANT: feature extraction here MUST match train_model.py exactly,
// otherwise the LSTM sees a different feature distribution at inference
// than it learned at training time. Any drift between the two is silent
// and biases predictions in unpredictable ways.

let modelWeights = null;
let modelConfig = null;
let modelLoaded = false;
let modelLoading = false;

// Required lookback for the longest indicator window (sma21 / vol_ratio).
// Combined with sequence_length, this is the minimum number of candles
// needed to compute features without any indicator falling back to its
// boundary default.
const LOOKBACK = 21;

// ─── MODEL LOADING ───────────────────────────────────────────────────────────

export async function loadModel() {
    if (modelLoaded) return true;
    if (modelLoading) {
        while (modelLoading) await new Promise(r => setTimeout(r, 100));
        return modelLoaded;
    }

    modelLoading = true;
    try {
        const res = await fetch('./model/lstm_weights.json');
        if (!res.ok) {
            modelLoading = false;
            return false;
        }
        const data = await res.json();
        modelConfig = data.config;
        modelWeights = data.weights;
        modelLoaded = true;
        modelLoading = false;
        return true;
    } catch (e) {
        modelLoading = false;
        return false;
    }
}

// ─── FEATURE COMPUTATION (must match train_model.py exactly) ─────────────────

export function computeFeatures(candles) {
    const seqLen = modelConfig ? modelConfig.sequence_length : 20;

    // Need seqLen window + LOOKBACK history so the smallest j satisfies
    // every indicator's minimum lookback (sma21 needs j >= 21).
    if (candles.length < seqLen + LOOKBACK) return null;

    const allCandles = candles.slice(-(seqLen + LOOKBACK));
    const close = allCandles.map(c => c.close);
    const high = allCandles.map(c => c.high);
    const low = allCandles.map(c => c.low);
    const volume = allCandles.map(c => c.volume || 0);

    const features = [];

    for (let idx = 0; idx < seqLen; idx++) {
        const j = allCandles.length - seqLen + idx;

        // 1. Price change (1-bar return)
        const priceChange = j > 0 ? (close[j] - close[j - 1]) / (close[j - 1] + 1e-8) : 0;

        // 2. High-low range as fraction of close
        const highLowRange = (high[j] - low[j]) / (close[j] + 1e-8);

        // 3. RSI approximation over 14 bars
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

        // 4. Volume ratio: current volume vs 21-bar average INCLUDING current bar.
        //    train_model.py uses volume[j-20:j+1] → 21 bars including j.
        //    Boundary default 0.2 mirrors training's volume[j]/volume[j] = 1.0
        //    after the /5.0 normalization.
        let volRatio = 0.2;
        if (j >= 20) {
            let sum = 0;
            for (let k = j - 20; k <= j; k++) sum += volume[k];
            const avgVol = sum / 21;
            volRatio = Math.min(volume[j] / (avgVol + 1e-8), 5.0) / 5.0;
        }

        // 5. MA ratio: close vs 9-bar SMA
        let maRatio9 = 0;
        if (j >= 9) {
            let sum = 0;
            for (let k = j - 8; k <= j; k++) sum += close[k];
            const sma9 = sum / 9;
            maRatio9 = (close[j] - sma9) / (sma9 + 1e-8);
        }

        // 6. MA ratio: close vs 21-bar SMA
        let maRatio21 = 0;
        if (j >= 21) {
            let sum = 0;
            for (let k = j - 20; k <= j; k++) sum += close[k];
            const sma21 = sum / 21;
            maRatio21 = (close[j] - sma21) / (sma21 + 1e-8);
        }

        // 7. Bollinger Band position (20-bar window, 2 std dev)
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

        // 8. Momentum: 5-bar rate of change
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

// ─── LSTM FORWARD PASS ───────────────────────────────────────────────────────

function sigmoid(x) {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function tanh(x) {
    const ex = Math.exp(2 * Math.max(-500, Math.min(500, x)));
    return (ex - 1) / (ex + 1);
}

function relu(x) {
    return Math.max(0, x);
}

function matmul(matrix, vector) {
    return matrix.map(row => row.reduce((sum, val, i) => sum + val * vector[i], 0));
}

function addVectors(a, b) {
    return a.map((val, i) => val + b[i]);
}

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

function runLSTM(features) {
    if (!modelWeights || !modelConfig) return null;

    const { hidden_size, num_layers } = modelConfig;

    let h = Array.from({ length: num_layers }, () => new Array(hidden_size).fill(0));
    let c = Array.from({ length: num_layers }, () => new Array(hidden_size).fill(0));

    for (const timestep of features) {
        let layerInput = timestep;

        for (let layer = 0; layer < num_layers; layer++) {
            const ihW = modelWeights[`lstm.weight_ih_l${layer}`];
            const hhW = modelWeights[`lstm.weight_hh_l${layer}`];
            const ihB = modelWeights[`lstm.bias_ih_l${layer}`];
            const hhB = modelWeights[`lstm.bias_hh_l${layer}`];

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

    const fc1W = modelWeights['fc1.weight'];
    const fc1B = modelWeights['fc1.bias'];
    if (!fc1W || !fc1B) return null;

    let fc1Out = addVectors(matmul(fc1W, lastHidden), fc1B).map(relu);

    const fc2W = modelWeights['fc2.weight'];
    const fc2B = modelWeights['fc2.bias'];
    if (!fc2W || !fc2B) return null;

    const output = fc2W[0].reduce((sum, w, i) => sum + w * fc1Out[i], 0) + fc2B[0];
    return sigmoid(output);
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

export async function getAIPrediction(candles) {
    const loaded = await loadModel();
    if (!loaded) {
        return { score: 50, available: false, reason: 'AI model not loaded' };
    }

    const features = computeFeatures(candles);
    if (!features) {
        return { score: 50, available: false, reason: 'Insufficient data for AI model (need 41+ candles)' };
    }

    const probability = runLSTM(features);
    if (probability === null) {
        return { score: 50, available: false, reason: 'AI inference failed' };
    }

    const score = Math.round(probability * 100);

    let signal;
    if (probability > 0.6) signal = 'bullish';
    else if (probability < 0.4) signal = 'bearish';
    else signal = 'neutral';

    return {
        score,
        available: true,
        probability: Math.round(probability * 1000) / 1000,
        signal,
        reason: `AI pattern recognition: ${Math.round(probability * 100)}% probability of upward move`,
    };
}
