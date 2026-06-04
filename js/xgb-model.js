// Pure-JS XGBoost runtime that consumes model/xgb_trees.json (produced by
// train_xgboost.py). No deps. ~80 lines.
//
// File shape:
//   {
//     base_score: number,
//     n_features: 8,
//     trees: [ [ {f, t, l, r} | {v}, ... ], ... ],   // each tree is a flat array
//     calibrators: [ { X_thresholds: [...], y_thresholds: [...] }, ... ]
//   }
//
// Inference:
//   sum_leaves = sum_t( traverse(trees[t], features) )
//   raw = sigmoid(sum_leaves)
//   final = mean( isotonic_step(c, raw) for c in calibrators )

let model = null;
let status = 'unloaded'; // 'unloaded' | 'loaded' | 'unavailable'

export async function loadGbtModel() {
    if (status !== 'unloaded') return model;
    try {
        const res = await fetch('./model/xgb_trees.json');
        if (!res.ok) { status = 'unavailable'; return null; }
        const data = await res.json();
        if (!data?.trees || !Array.isArray(data.trees)) {
            status = 'unavailable'; return null;
        }
        model = data;
        status = 'loaded';
        return model;
    } catch (_) {
        status = 'unavailable';
        return null;
    }
}

export function isGbtLoaded() { return status === 'loaded'; }

function sigmoid(x) {
    if (x > 500) return 1;
    if (x < -500) return 0;
    return 1 / (1 + Math.exp(-x));
}

// Walk a single flat tree until we hit a leaf.
function traverseTree(tree, features) {
    let idx = 0;
    let safety = 0;
    while (safety < 1000) {
        const node = tree[idx];
        if (!node) return 0;
        if ('v' in node) return node.v;
        const goLeft = features[node.f] < node.t;
        idx = goLeft ? node.l : node.r;
        if (idx < 0) return 0;
        safety++;
    }
    return 0;
}

// Step-function isotonic calibration: find the largest X_threshold <= raw,
// return the corresponding y_threshold. If raw is below all, return y[0];
// above all, return y[-1].
function isotonicStep(cal, raw) {
    const xs = cal.X_thresholds;
    const ys = cal.y_thresholds;
    if (!xs?.length || !ys?.length) return raw;
    if (raw <= xs[0]) return ys[0];
    if (raw >= xs[xs.length - 1]) return ys[ys.length - 1];
    // Binary search.
    let lo = 0, hi = xs.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (xs[mid] <= raw) lo = mid;
        else hi = mid - 1;
    }
    return ys[lo];
}

/**
 * Predict probability of upward move from a feature vector. The vector
 * must have AT LEAST model.n_features elements (8 for old models, 11
 * after the ADX/MFI/ATR expansion). Extra trailing elements are
 * ignored by the trees, so an 11-element vector against an old
 * 8-feature model is safe — it just doesn't use the new dims until
 * the XGBoost model also retrains. Returns null when model not loaded.
 * Output is a calibrated probability in [0, 1].
 */
export function predictGbt(featureRow) {
    if (status !== 'loaded' || !model) return null;
    if (!Array.isArray(featureRow) || featureRow.length < model.n_features) return null;
    let sum = model.base_score || 0;
    for (const tree of model.trees) {
        sum += traverseTree(tree, featureRow);
    }
    const raw = sigmoid(sum);
    if (!model.calibrators?.length) return raw;
    let calSum = 0;
    for (const c of model.calibrators) calSum += isotonicStep(c, raw);
    return calSum / model.calibrators.length;
}
