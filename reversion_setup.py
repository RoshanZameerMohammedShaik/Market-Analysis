"""The pullback setup, Python side. MIRRORS js/reversion-setup.js; tools/reversion_sync_check.py
holds them together. The rule and every number behind it are in tools/calibrate_reversion.py.

  ENTRY  at the close of a session where RSI(2) < 10, price is above its 200-day average, and the
         name trades $50M+ a day (US listings)
  EXIT   at the open after the first close above the 5-day average, at most 10 sessions; no stop
"""
from __future__ import annotations

import json
import os

from forecast_band import range_sigma
from trend_gate import trend_state, MIN_PRICE, MIN_DOLLAR_VOL

_HERE = os.path.dirname(os.path.abspath(__file__))
CAL_PATH = os.path.join(_HERE, 'model', 'reversion_calibration.json')
RSI2_MAX = 10.0
MA_TRIGGER = 5

_cal = None


def load_calibration(path=None):
    global _cal
    if _cal is not None and path is None:
        return _cal
    try:
        with open(path or CAL_PATH, encoding='utf-8') as f:
            c = json.load(f)
        c = c if c.get('cells') and c.get('pooled') else None
    except Exception:
        c = None
    if path is None:
        _cal = c
    return c


def rsi_ewm(closes, n=2):
    """pandas ewm(alpha=1/n, adjust=False) RSI over close-to-close changes; None without losses."""
    up = dn = None
    a = 1.0 / n
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        g, l = (d if d > 0 else 0.0), (-d if d < 0 else 0.0)
        if up is None:
            up, dn = g, l
        else:
            up, dn = (1 - a) * up + a * g, (1 - a) * dn + a * l
    if up is None or not (dn > 0):
        return None
    return 100 - 100 / (1 + up / dn)


def _tier(sigma, edges):
    for lo, hi, name in edges:
        if lo <= sigma < hi:
            return name
    return edges[-1][2]


def _vix_band(vix, bands):
    if vix is None or vix != vix:
        return None
    for lo, hi, name in bands:
        if lo <= vix < hi:
            return name
    return bands[-1][2]


def evaluate(candles, region, vix, cal=None):
    """candles: dicts with close/high/low/volume, oldest first. Same contract as the JS."""
    cal = cal or load_calibration()
    if not cal or str(region or '').upper() != 'NYSE':
        return None
    bars = [c for c in candles if c.get('close') and c.get('high') and c.get('low')
            and c['close'] > 0 and c['low'] > 0 and c['high'] >= c['low']]
    if len(bars) < 200:
        return None
    closes = [c['close'] for c in bars]
    trend = trend_state(closes, [c.get('volume') or 0 for c in bars])
    px = closes[-1]
    r2 = rsi_ewm(closes[-60:], 2)
    trigger = sum(closes[-MA_TRIGGER:]) / MA_TRIGGER
    sigma = range_sigma(bars, 30)
    edges = [tuple(e) for e in cal.get('tierEdges', [])]
    tier = _tier(sigma, edges) if sigma and edges else None
    band = _vix_band(vix, [tuple(b) for b in cal.get('vixBands', [])])
    key = f'{tier}:{band}' if tier and band else None
    cell = cal['cells'].get(key) if key else None
    out = {'rsi2': round(r2, 1) if r2 is not None else None, 'trigger': trigger,
           'ma200': trend.get('ma200'), 'tier': tier, 'vixBand': band, 'cell': cell,
           'heldOut': cal.get('cellsHeldOut', {}).get(key) if key else None, 'price': px}
    reason = None
    if not trend.get('known'):
        reason = 'not enough history for a 200-day average'
    elif not trend['above200']:
        reason = 'price is below its 200-day average, where this setup does not hold'
    elif px < MIN_PRICE:
        reason = 'price is under $5'
    elif trend['dollarVol20'] < MIN_DOLLAR_VOL:
        reason = 'it trades under $50M a day, where costs eat the edge'
    if reason:
        return {**out, 'eligible': False, 'active': False, 'reason': reason}
    active = r2 is not None and r2 < RSI2_MAX
    reliable = bool(cell and cell['n'] >= cal.get('minCellN', 150) and cell['netBpsLo95'] > 0)
    return {**out, 'eligible': True, 'active': active, 'reliable': reliable}
