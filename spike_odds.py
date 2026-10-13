"""Spike odds, inference: the chance the next session moves at least 2x this stock's normal daily
move, either way. The model, its validation and every definition are in tools/train_spike_model.py;
this file computes the same features from a symbol's completed daily bars and applies the exported
trees and their out-of-sample calibration.

Run nightly by tools/write_vol_slice.py, which publishes the odds beside each volatility forecast
and grades them the next night (model/spike_record.json).
"""
import datetime
import json
import math
import os
import statistics

import vol_forecast as vf

K = 2.0
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model', 'spike_model.json')
MIN_BARS = 282            # 250 sessions of spike history, each judged by the 30-session sigma before it


def load_model(path=MODEL_PATH):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def extras(bars, next_iso, earn_next, to_earn):
    """The spike model's own features at the last bar. None when the history is too short."""
    if len(bars) < MIN_BARS:
        return None
    c = [b['close'] for b in bars]
    if min(c) <= 0:
        return None
    n = len(c)
    r = [None] + [math.log(c[i] / c[i - 1]) for i in range(1, n)]

    def sig30(i):
        return statistics.stdev(r[i - 29:i + 1]) if i >= 30 else None

    def big(i):
        s = sig30(i - 1)
        return 1.0 if (s is not None and abs(r[i]) >= K * s) else 0.0

    nd = datetime.date.fromisoformat(next_iso)
    last = bars[-1].get('date')
    last_month = datetime.date.fromisoformat(last).month if last else nd.month
    return {
        'sig30': sig30(n - 1),
        'earn_next': 1.0 if earn_next else 0.0,
        'to_earn': float(min(max(to_earn, 1), 20)) if to_earn else 20.0,
        'spk60': sum(big(i) for i in range(n - 60, n)) / 60,
        'spk250': sum(big(i) for i in range(n - 250, n)) / 250,
        'l_px': math.log(c[-1]),
        'month_end': 1.0 if nd.month != last_month else 0.0,
        'opex': 1.0 if (nd.weekday() == 4 and 15 <= nd.day <= 21) else 0.0,
    }


def predict(model, vol_feats, extra):
    """-> {'p': calibrated probability, 'move': the 2x threshold as a fraction, 'base': base rate}."""
    if not model or not vol_feats or not extra or not extra.get('sig30'):
        return None
    feats = {**vol_feats, **extra}
    x = [feats.get(k, float('nan')) for k in model['features']]
    raw = 1 / (1 + math.exp(-vf._raw(model['model'], x)))
    cal = model['calibration']
    p = vf._interp(cal['x'], cal['y'], raw)
    return {'p': p, 'move': K * extra['sig30'], 'base': model['walkForward']['baseRate']}
