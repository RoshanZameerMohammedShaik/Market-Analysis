// AI Model — LSTM inference in pure JavaScript
// Loads pre-trained weights from JSON, runs forward pass in browser

let modelWeights = null;
let modelConfig = null;
let modelLoaded = false;
let modelLoading = false;

// ─── MODEL LOADING ───────────────────────────────────────────────────────────

export async function loadModel() {
    if (modelLoaded) return true;
    if (modelLoading) {
        // Wait for ongoing load
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

// ─── FEATURE COMPUTATION (same as training) ──────────────────────────────────

export function computeFeatures(candles) {
    const seqLen = modelConfig ? modelConfig.sequence_length : 20;

    if (candles.length < seqLen + 1) return null;

    // Take last seqLen candles
    const window = candles.slice(-seqLen);
    const allCandles = candles.slice(-(seqLen + 21)); // Extra for lookback calcs

    const features = [];

    for (let idx = 0; idx < window.length; idx++) {
        const j = allCandles.length - seqLen + idx;
        const close = allCandles.map(c => c.close);
        const high = allCandles.map(c => c.high);
        const low = allCandles.map(c => c.low);
        const volume = allCandles.map(c => c.volume || 0);

        // 1. Price change
        const priceChange = j > 0 ? (close[j] - close[j - 1]) / (close[j - 1] + 1e-8) : 0;

        // 2. High-low range
        const highLowRange = (high[j] - low[j]) / (close[j] + 1e-8);

        // 3. RSI approximation
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

        // 4. Volume ratio
        let volRatio = 0.5;
        if (j >= 20) {
            const avgVol = volume.slice(j - 20, j).reduce((a, b) => a + b, 0) / 20;
            volRatio = Math.min(volume[j] / (avgVol + 1e-8), 5.0) / 5.0;
        }

        // 5. MA ratio 9
        let maRatio9 = 0;
        if (j >= 9) {
            const sma9 = close.slice(j - 8, j + 1).reduce((a, b) => a + b, 0) / 9;
            maRatio9 = (close[j] - sma9) / (sma9 + 1e-8);
        }

        // 6. MA ratio 21
        let maRatio21 = 0;
        if (j >= 21) {
            const sma21 = close.slice(j - 20, j + 1).reduce((a, b) => a + b, 0) / 21;
            maRatio21 = (close[j] - sma21) / (sma21 + 1e-8);
        }

        // 7. Bollinger Band position
        let bbPosition = 0;
        if (j >= 20) {
            const bbWindow = close.slice(j - 19, j + 1);
            const bbMean = bbWindow.reduce((a, b) => a + b, 0) / 20;
            const bbStd = Math.sqrt(bbWindow.reduce((s, v) => s + Math.pow(v - bbMean, 2), 0) / 20) + 1e-8;
            bbPosition = Math.max(-1, Math.min(1, (close[j] - bbMean) / (2 * bbStd)));
        }

        // 8. Momentum (5-day)
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

    // Gates: input, forget, cell, output (all packed in one weight matrix)
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

    // Initialize hidden states
    let h = Array.from({ length: num_layers }, () => new Array(hidden_size).fill(0));
    let c = Array.from({ length: num_layers }, () => new Array(hidden_size).fill(0));

    // Process each timestep
    for (const timestep of features) {
        let layerInput = timestep;

        for (let layer = 0; layer < num_layers; layer++) {
            // Get weights for this layer
            const ihW = modelWeights[`lstm.weight_ih_l${layer}`];
            const hhW = modelWeights[`lstm.weight_hh_l${layer}`];
            const ihB = modelWeights[`lstm.bias_ih_l${layer}`];
            const hhB = modelWeights[`lstm.bias_hh_l${layer}`];

            if (!ihW || !hhW) return null;

            // Combine ih and hh weights/biases for the cell
            const inputSize = layerInput.length;
            const combinedW = ihW.map((row, i) => [...row, ...hhW[i]]);
            const combinedB = ihB.map((b, i) => b + hhB[i]);

            const result = lstmCell(layerInput, h[layer], c[layer], combinedW, combinedB);
            h[layer] = result.h;
            c[layer] = result.c;

            layerInput = result.h; // Next layer input is this layer's hidden
        }
    }

    // Final hidden state -> FC layers
    const lastHidden = h[num_layers - 1];

    // FC1: hidden_size -> 16
    const fc1W = modelWeights['fc1.weight'];
    const fc1B = modelWeights['fc1.bias'];
    if (!fc1W || !fc1B) return null;

    let fc1Out = addVectors(matmul(fc1W, lastHidden), fc1B).map(relu);

    // FC2: 16 -> 1
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
        return { score: 50, available: false, reason: 'Insufficient data for AI model' };
    }

    const probability = runLSTM(features);
    if (probability === null) {
        return { score: 50, available: false, reason: 'AI inference failed' };
    }

    // Convert probability (0-1) to 0-100 bullish score
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
