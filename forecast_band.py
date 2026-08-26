"""Calibrated High/Low forecast bands. Python side.

THE ONE Python implementation. tools/band_sync_check.py imports from here rather
than keeping its own copy, and record_predictions.py uses it so the ledger stores
the same band the browser draws. js/forecast-band.js is the mirror, and the parity
job fails the build if the two drift.

Why this exists at all: the cron was writing the OLD ATR-and-confidence-scaled
targets into the ledger while the browser had already switched to the calibrated
band. So the scorecard was grading a forecast nobody sees. Containment measured
52.6% on 2026-08-24 where the calibrated band delivers 80.0%.

Method, identical to the JS:
  1. daily sigma = max(Parkinson high-low, close-to-close), with data guards
  2. scale by sqrt(horizon)
  3. band = price * exp(+/- z * sigma * sqrt(h)), z LOADED from calibration
     per (volatility tier, horizon), never assumed

Guards exist because live symbols print high == low on 60 of 60 days, which
collapses Parkinson to 0.00% and mislabels a violent penny stock as "calm".
"""
import json
import math
import os
import statistics

from price_round import round_price

_HERE = os.path.dirname(os.path.abspath(__file__))
CAL_PATH = os.path.join(_HERE, 'model', 'band_calibration.json')

# MUST match js/forecast-band.js and tools/calibrate_bands.py.
MIN_PRICE = 0.01
MAX_SIGMA = 0.50
MIN_LIVE_BARS = 20
VOL_LOOKBACK = 30

_cal = None
_cal_tried = False


def load_calibration(path=None):
    """Load and memoise model/band_calibration.json. None if unavailable."""
    global _cal, _cal_tried
    if _cal is not None:
        return _cal
    if _cal_tried and path is None:
        return None
    _cal_tried = True
    try:
        with open(path or CAL_PATH, encoding='utf-8') as f:
            c = json.load(f)
        if not c.get('z') or not isinstance(c.get('targetConfidence'), (int, float)):
            return None
        _cal = c
        return _cal
    except Exception:
        return None


def range_sigma(candles, n=VOL_LOOKBACK):
    """Daily sigma over the last n candles, robust to untraded days.

    candles: iterable of dicts with 'high', 'low', 'close'.

    Parkinson is ~5x more efficient than close-to-close WHEN the asset trades
    continuously, but collapses toward zero on a name that prints high == low.
    Close-to-close cannot be hidden that way, so max() never understates.
    """
    if not candles:
        return None
    tail = list(candles)[-n:]
    good = [c for c in tail
            if c.get('high') and c.get('low')
            and c['high'] > 0 and c['low'] > 0 and c['high'] >= c['low']]
    if len(good) < math.ceil(n * 0.7):
        return None

    live = sum(1 for c in good if c['high'] > c['low'] * 1.0000001)
    pk = 0.0
    if live >= MIN_LIVE_BARS:
        pk = math.sqrt(statistics.mean([math.log(c['high'] / c['low']) ** 2 for c in good])
                       / (4 * math.log(2)))

    rets = []
    for i in range(1, len(tail)):
        a, b = tail[i - 1].get('close'), tail[i].get('close')
        if a and b and a > 0 and b > 0:
            rets.append(math.log(b / a))
    cc = statistics.stdev(rets) if len(rets) > 5 else 0.0

    s = max(pk, cc)
    return s if 0 < s <= MAX_SIGMA else None


def tier_for(sigma, tier_edges):
    for lo, hi, name in tier_edges:
        if lo <= sigma < hi:
            return name
    return tier_edges[-1][2]


def forecast_bands(candles, current_price, mode='perDay', cal=None):
    """7-day High/Low band. Returns None when it cannot be stated honestly.

    mode='perDay'     day h's OWN session extremes. What the UI shows.
    mode='cumulative' the running extremes across h days. Wider, and the correct
                      basis for a STOP, since a stop can be hit on any day.
    """
    c = cal or load_calibration()
    if not c:
        return None
    try:
        price = float(current_price)
    except (TypeError, ValueError):
        return None
    if not (price > 0):
        return None
    # Sub-penny assets are EXCLUDED from the calibration sample (see MIN_PRICE in
    # tools/calibrate_bands.py), so the z values were never validated at this
    # price scale and applying them here is extrapolation. The band is still
    # returned, because hiding it would blank 39 of 170 crypto names including
    # SHIB, BONK and FLOKI, but it is flagged so the UI cannot claim a measured
    # confidence for it. This is exactly the distinction the `calibrated` flag
    # exists to carry: show the number, label what backs it.
    below_cal_floor = price < MIN_PRICE

    sigma = range_sigma(candles, c.get('volLookbackDays', VOL_LOOKBACK))
    if not sigma:
        return None

    edges = [tuple(e) for e in c['tierEdges']]
    tier = tier_for(sigma, edges)
    table = c['z'] if mode == 'cumulative' else c.get('zPerDay') or c['z']
    if tier not in table:
        return None

    days = []
    for h in c['horizons']:
        z = table[tier].get(str(h))
        if z is None:
            continue
        dist = z * sigma * math.sqrt(h)
        hi = price * math.exp(dist)
        lo = price * math.exp(-dist)
        days.append({'day': h, 'low': round_price(lo), 'high': round_price(hi),
                     'widthPct': round((hi / price - 1) * 100, 2)})
    if not days:
        return None
    return {
        'mode': mode,
        'calibrated': not below_cal_floor,
        'uncalibratedReason': 'sub-penny: outside calibration sample' if below_cal_floor else None,
        'confidence': round(c['targetConfidence'] * 100),
        'sigmaDaily': round(sigma * 100, 2),
        'volTier': tier,
        'calibratedAt': c.get('generatedAt'),
        'days': days,
    }
