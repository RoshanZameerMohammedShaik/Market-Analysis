"""LSTM + gradient-boosted-tree inference in Python. Mirror of js/ai-model.js
and js/xgb-model.js.

WHY THIS EXISTS
---------------
The daily cron produced the LOCKED, GRADED prediction from three indicators
(RSI, MACD, Bollinger) and nothing else. Every ledger row reads:

    "breakdown": {"technical": {...}, "ai": null, "sentiment": null, "market": null}

Meanwhile the browser runs a four-source blend that includes this very LSTM. So
the prediction the user saw was not the prediction that got locked, and the
accuracy figures described a thinner engine than the product. Grading something
you do not ship makes the numbers meaningless in both directions.

This module gives the cron the same AI the browser has, so `ai` stops being null.

PARITY IS THE WHOLE POINT
-------------------------
Two implementations of one number always drift, and the drift is silent. Every
function here mirrors a specific JS function, named in its docstring, and
tools/ai_sync_check.py asserts they agree to 1e-9 on shared fixtures. If you change
one side, change the other or CI fails.

Numpy only, no torch: the runner should not install a 900 MB dependency to
multiply a 32-unit hidden state.
"""
from __future__ import annotations

import bisect
import json
import math
import os

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')

# Model tiers, mirroring js/ai-model.js. 'penny' is trained in isolation because
# sub-$5 names have a different volatility regime; falls back to main when absent.
MAIN_WEIGHTS = os.path.join(MODEL_DIR, 'lstm_weights.json')
PENNY_WEIGHTS = os.path.join(MODEL_DIR, 'lstm_weights_penny.json')
GBT_TREES = os.path.join(MODEL_DIR, 'xgb_trees.json')

# See the note in ai_prediction(). False because the deployed GBT is
# effectively a constant; MUST be changed in js/ai-model.js at the same time.
GBT_IN_BLEND = False

_cache: dict = {}


def _load_json(path):
    if path in _cache:
        return _cache[path]
    try:
        with open(path, encoding='utf-8') as f:
            _cache[path] = json.load(f)
    except Exception:
        _cache[path] = None
    return _cache[path]


# ── activations ──────────────────────────────────────────────────────────────
def _sigmoid(x):
    """Clamped like js/xgb-model.js sigmoid, which returns 1/0 beyond +/-500 to
    avoid overflow. np.exp would warn and return inf/0 at the same points, so the
    clamp keeps the two languages bit-identical rather than merely close."""
    return np.where(x > 500, 1.0, np.where(x < -500, 0.0, 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))))


# ── LSTM ─────────────────────────────────────────────────────────────────────
def lstm_cell(x, h_prev, c_prev, w, b):
    """Mirror of lstmCell in js/ai-model.js.

    Gate order is PyTorch's: input, forget, cell, output — the weights were
    exported from torch, so reordering here would silently produce a working but
    wrong model rather than an error.
    """
    hidden = h_prev.shape[0]
    combined = np.concatenate([x, h_prev])
    gates = w @ combined + b
    i = _sigmoid(gates[0:hidden])
    f = _sigmoid(gates[hidden:2 * hidden])
    g = np.tanh(gates[2 * hidden:3 * hidden])
    o = _sigmoid(gates[3 * hidden:4 * hidden])
    c_new = f * c_prev + i * g
    return o * np.tanh(c_new), c_new


def run_lstm(features, model_data):
    """Mirror of runLSTMWith in js/ai-model.js. Returns P(up) or None.

    `features` is (timesteps, n_features), oldest first.
    """
    if not model_data or 'weights' not in model_data or 'config' not in model_data:
        return None
    w = model_data['weights']
    cfg = model_data['config']
    hidden, layers = cfg['hidden_size'], cfg['num_layers']

    # Concatenating ih|hh once per layer instead of per timestep: the JS rebuilds
    # it inside the loop, which is the same arithmetic and 20x the work.
    packed = []
    for layer in range(layers):
        ih, hh = w.get(f'lstm.weight_ih_l{layer}'), w.get(f'lstm.weight_hh_l{layer}')
        ib, hb = w.get(f'lstm.bias_ih_l{layer}'), w.get(f'lstm.bias_hh_l{layer}')
        if ih is None or hh is None:
            return None
        packed.append((np.hstack([np.array(ih, dtype=np.float64),
                                  np.array(hh, dtype=np.float64)]),
                       np.array(ib, dtype=np.float64) + np.array(hb, dtype=np.float64)))

    h = [np.zeros(hidden) for _ in range(layers)]
    c = [np.zeros(hidden) for _ in range(layers)]
    for step in features:
        inp = np.asarray(step, dtype=np.float64)
        for layer in range(layers):
            mat, bias = packed[layer]
            h[layer], c[layer] = lstm_cell(inp, h[layer], c[layer], mat, bias)
            inp = h[layer]

    for key in ('fc1.weight', 'fc1.bias', 'fc2.weight', 'fc2.bias'):
        if key not in w:
            return None
    fc1 = np.maximum(np.array(w['fc1.weight'], dtype=np.float64) @ h[layers - 1]
                     + np.array(w['fc1.bias'], dtype=np.float64), 0.0)   # ReLU
    out = float(np.array(w['fc2.weight'], dtype=np.float64)[0] @ fc1
                + np.array(w['fc2.bias'], dtype=np.float64)[0])
    return float(_sigmoid(np.array(out)))


# ── gradient-boosted trees ───────────────────────────────────────────────────
def _traverse(tree, row):
    """Mirror of traverseTree in js/xgb-model.js. Flat node list; a node with 'v'
    is a leaf. The 1000-step safety bound is kept so a malformed export cannot
    spin forever."""
    idx = 0
    for _ in range(1000):
        if idx < 0 or idx >= len(tree):
            return 0.0
        node = tree[idx]
        if not node:
            return 0.0
        if 'v' in node:
            return float(node['v'])
        idx = node['l'] if row[node['f']] < node['t'] else node['r']
    return 0.0


def _isotonic_step(cal, raw):
    """Mirror of isotonicStep in js/xgb-model.js: a STEP function, not a linear
    interpolation. Returns y at the largest x <= raw, clamped at both ends."""
    xs, ys = cal.get('X_thresholds'), cal.get('y_thresholds')
    if not xs or not ys:
        return raw
    if raw <= xs[0]:
        return float(ys[0])
    if raw >= xs[-1]:
        return float(ys[-1])
    return float(ys[bisect.bisect_right(xs, raw) - 1])


def predict_gbt(row):
    """Mirror of predictGbt in js/xgb-model.js. Calibrated P(up), or None.

    Extra trailing features are ignored, so an 11-element vector is safe against
    the deployed 8-feature model.
    """
    m = _load_json(GBT_TREES)
    if not m or 'trees' not in m:
        return None
    if row is None or len(row) < m.get('n_features', 0):
        return None
    total = float(m.get('base_score') or 0.0)
    for tree in m['trees']:
        total += _traverse(tree, row)
    raw = float(_sigmoid(np.array(total)))
    cals = m.get('calibrators') or []
    if not cals:
        return raw
    return float(sum(_isotonic_step(c, raw) for c in cals) / len(cals))


# ── the public call ──────────────────────────────────────────────────────────
def ai_prediction(candles, tier=None):
    """The cron's equivalent of getAIPrediction in js/ai-model.js.

    candles: list of {'open','high','low','close','volume'}, oldest first.
    tier:    'penny' selects the isolated penny model when its weights exist.

    Returns a dict shaped like the JS result so the ledger's `ai` breakdown and
    the browser's agree field-for-field:
        {score, available, probability, modelTier, lstm, gbt, signal, reason}

    `available` False is returned rather than a fabricated 50, so a missing model
    is visible in the ledger instead of looking like a neutral opinion.
    """
    from shared_features import compute_features_at

    want_penny = tier == 'penny'
    model_key, model_data = 'main', _load_json(MAIN_WEIGHTS)
    if want_penny:
        penny = _load_json(PENNY_WEIGHTS)
        if penny:
            model_key, model_data = 'penny', penny
    if not model_data:
        return {'score': 50, 'available': False, 'reason': 'AI model not loaded'}

    cfg = model_data.get('config') or {}
    seq_len = int(cfg.get('sequence_length') or 20)
    # The DEPLOYED model declares how many features it wants. It is currently 8
    # while shared_features computes 11 (ADX, MFI, ATR% were added and the model
    # was never retrained), so the extras are trimmed here exactly as
    # js/ai-model.js:159 skips them. Feeding 11 into an 8-input matrix would be a
    # shape error at best and a silently misaligned model at worst.
    n_feat = int(cfg.get('features') or cfg.get('input_size') or 8)

    close = [c['close'] for c in candles]
    high = [c['high'] for c in candles]
    low = [c['low'] for c in candles]
    volume = [c.get('volume') or 0 for c in candles]
    # 21 bars of warm-up are needed before the 21-SMA feature is real, plus the
    # sequence itself.
    if len(close) < seq_len + 22:
        return {'score': 50, 'available': False, 'reason': 'not enough bars for AI'}

    rows = []
    for j in range(len(close) - seq_len, len(close)):
        rows.append(compute_features_at(close, high, low, volume, j)[:n_feat])
    feats = np.array(rows, dtype=np.float64)
    if not np.all(np.isfinite(feats)):
        return {'score': 50, 'available': False, 'reason': 'AI features not finite'}

    lstm_p = run_lstm(feats, model_data)
    if lstm_p is None:
        return {'score': 50, 'available': False, 'reason': 'AI inference failed'}

    gbt_p = predict_gbt(rows[-1])

    # the GBT has no discrimination and must not dilute the LSTM.
    # 
    # Measured on 600 REAL market states (20 symbols x 30 recent sessions):
    # 
    #     GBT   19 distinct outputs, min 0.529, 100.0% bullish, 60% of mass on 0.646
    #     LSTM  594 distinct outputs, range 0.018-0.842, 46.0% bullish
    # 
    # The GBT never says "down". It is a near-constant bullish offset, which is also why
    # it measures 51.79% against a label whose base rate is 53.58%. Averaging it 50/50
    # with the LSTM did three harmful things: compressed the LSTM's range, shifted every
    # score upward, and let a constant OVERRIDE an informative call. Live example, DY:
    # LSTM 0.376 (bearish) blended with GBT 0.646 became 0.511, i.e. neutral. The one
    # model that had an opinion was outvoted by one that never does.
    # 
    # Both sub-scores are still RECORDED separately (lstm/gbt fields), so nothing is lost
    # and the GBT can be re-evaluated after a retrain. Only the headline blend changes.
    # 
    # Flip GBT_IN_BLEND back on once a retrained GBT demonstrates two-sided output; the
    # parity check will hold you to changing both languages together.
    prob = (lstm_p + gbt_p) / 2 if (GBT_IN_BLEND and gbt_p is not None
                                    and math.isfinite(gbt_p)) else lstm_p
    score = int(round(prob * 100))
    signal = 'bullish' if prob > 0.6 else 'bearish' if prob < 0.4 else 'neutral'
    label = 'Penny-LSTM' if model_key == 'penny' else 'LSTM'
    # Must not say "ensemble" when only one model is in the blend. The string is
    # user-visible (it reaches the signal card's reason list) and is also what a
    # future reader would trust when auditing how a call was made, so claiming a
    # two-model ensemble while using one would be a quiet lie in the audit trail.
    if GBT_IN_BLEND and gbt_p is not None:
        reason = (f'AI ensemble ({label} {round(lstm_p * 100)}% + GBT '
                  f'{round(gbt_p * 100)}%): {score}% probability of upward move')
    elif gbt_p is not None:
        reason = (f'AI pattern recognition ({label} only): {score}% probability of '
                  f'upward move. GBT ({round(gbt_p * 100)}%) recorded but excluded: '
                  f'no measurable discrimination.')
    else:
        reason = (f'AI pattern recognition ({label} only): {score}% probability of '
                  f'upward move')

    return {
        'score': score,
        'available': True,
        'probability': round(prob, 3),
        'modelTier': model_key,
        'lstm': {'score': int(round(lstm_p * 100)), 'probability': round(lstm_p, 3)},
        'gbt': None if gbt_p is None else {'score': int(round(gbt_p * 100)),
                                           'probability': round(gbt_p, 3)},
        'signal': signal,
        'reason': reason,
    }
