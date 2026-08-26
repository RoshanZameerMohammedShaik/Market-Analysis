"""
Backtester: replays the signal pipeline on Yahoo historical data and
reports whether the predictions actually worked.

What it measures:
  - Hit rate by signal type (BUY / SELL / NEUTRAL)
  - Calibration: does "70% confidence" actually hit 70% of the time?
  - Calibration stratified by liquidity tier (mega/large/mid/small/penny)
  - Calibration stratified by volatility tier (low/mid/high VIX)
  - Calibration recency-weighted (exp decay, 30d half-life)
  - Conformal prediction-interval residuals per signal+confidence bucket
  - Pattern hit rates: per (signal | rsi-bucket | macd-state | bb-state | tier)
  - Per-symbol breakdown
  - Sharpe ratio if you traded every signal
  - Max drawdown

Writes:
    model/backtest_results.json
"""
import argparse
import json
import math
import os
import datetime
import numpy as np
import yfinance as yf

from shared_features import extract_ohlcv, compute_features_at, compute_adx, ENGINE_VERSION
from train_model import SYMBOLS, PERIOD

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
RESULTS_PATH = os.path.join(MODEL_DIR, 'backtest_results.json')
# ENGINE_VERSION is defined in shared_features (dependency-light) and
# imported above so the engine and the calibration aggregator share ONE
# source of truth. Bump it there when directional scoring changes.

# Recency-weighted calibration half-life (days). Most recent observations
# dominate; ~5 half-lives back the weight is ~3%.
RECENCY_HALFLIFE_DAYS = 30.0


def _json_safe(obj):
    """Recursively replace non-finite floats (NaN, +/-Infinity) with None so
    the output is valid JSON. numpy can produce NaN from quantiles/means over
    windows that contain a NaN return, and json.dump's default allow_nan=True
    would emit a bare `NaN` token that browsers refuse to parse. Also coerces
    numpy scalar types to native Python so json can serialize them."""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    # numpy scalars (np.float64 etc.) -> native, then finite-check
    if isinstance(obj, np.floating):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        if diff > 0:
            gains += diff
        else:
            losses -= diff
    avg_gain = gains / period
    avg_loss = losses / period
    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(0, diff)) / period
        avg_loss = (avg_loss * (period - 1) + max(0, -diff)) / period
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def ema(values, period):
    if len(values) < period:
        return None
    multiplier = 2 / (period + 1)
    out = [sum(values[:period]) / period]
    for v in values[period:]:
        out.append((v - out[-1]) * multiplier + out[-1])
    return out


def macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow + signal:
        return None
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    if not ema_fast or not ema_slow:
        return None
    macd_line = []
    start = slow - 1
    for i in range(start, len(closes)):
        fi, si = i - (fast - 1), i - (slow - 1)
        if 0 <= fi < len(ema_fast) and 0 <= si < len(ema_slow):
            macd_line.append(ema_fast[fi] - ema_slow[si])
    if len(macd_line) < signal:
        return None
    sig = ema(macd_line, signal)
    if not sig:
        return None
    last_macd = macd_line[-1]
    last_sig = sig[-1]
    prev_macd = macd_line[-2]
    prev_sig = sig[-2] if len(sig) > 1 else last_sig
    return {
        'macd': last_macd,
        'signal': last_sig,
        'histogram': last_macd - last_sig,
        'crossover': prev_macd <= prev_sig and last_macd > last_sig,
        'crossunder': prev_macd >= prev_sig and last_macd < last_sig,
    }


def bollinger(closes, period=20, std_dev=2):
    if len(closes) < period:
        return None
    sl = closes[-period:]
    sma_v = sum(sl) / period
    var = sum((v - sma_v) ** 2 for v in sl) / period
    std = math.sqrt(var)
    upper = sma_v + std_dev * std
    lower = sma_v - std_dev * std
    return {
        'percent_b': (closes[-1] - lower) / (upper - lower) if upper > lower else 0.5,
    }


def sma(values, period):
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def ma_crossover(closes, short=9, long=21):
    s = sma(closes, short)
    l = sma(closes, long)
    if s is None or l is None:
        return None
    ps = sma(closes[:-1], short)
    pl = sma(closes[:-1], long)
    if ps is None or pl is None:
        return None
    return {
        'bullish_cross': ps <= pl and s > l,
        'bearish_cross': ps >= pl and s < l,
        'bullish': s > l,
    }


def volume_spike(volumes, threshold=1.5):
    if len(volumes) < 21:
        return {'spike': False, 'ratio': 1.0}
    avg = sum(volumes[-21:-1]) / 20
    cur = volumes[-1]
    ratio = cur / avg if avg > 0 else 1.0
    return {'spike': ratio > threshold, 'ratio': ratio}


def atr(candles, period=14):
    """Average True Range over the candle dicts. Mirrors js/analysis.js
    calculateATR exactly (Wilder smoothing). candles: list of dicts with
    high/low/close. Returns None if not enough bars."""
    if len(candles) < period + 1:
        return None
    trs = []
    for i in range(1, len(candles)):
        high = candles[i]['high']
        low = candles[i]['low']
        prev_close = candles[i - 1]['close']
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    a = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        a = (a * (period - 1) + trs[i]) / period
    return a


def expected_move_for(candles, signal, confidence):
    """Directional expected-move DISTANCE (in price) the engine is implicitly
    predicting, mirroring the ATR-based target math in js/analysis.js
    calculatePriceTargets. This is stored on the ledger row so record_outcomes
    can grade capturedPct = actual_move / expected_move WITHOUT re-deriving
    anything (no JS<->Python drift — the row stores the number it's graded on).

    We use the daily-horizon ATR multiplier (0.8) since the 1d horizon is the
    primary scored one, and the confidence-scaled factor from the JS BUY/SELL
    branches. Returns a POSITIVE distance, or None when ATR is unavailable."""
    a = atr(candles, 14)
    if not a or a <= 0:
        return None
    expected_move = a * 0.8  # timeframe='today' multiplier (js analysis.js:537)
    cf = confidence / 100.0
    if signal == 'BUY':
        # predictedHigh = current + expectedMove*(0.8 + cf*0.7)  (js:542)
        dist = expected_move * (0.8 + cf * 0.7)
    elif signal == 'SELL':
        # predictedLow = current - expectedMove*(0.8 + cf*0.7)  (js:546)
        dist = expected_move * (0.8 + cf * 0.7)
    else:
        dist = expected_move * 0.6
    return round(dist, 4)


def _bollinger_bands(closes, period=20, std_dev=2):
    """Full Bollinger band edges (upper/middle/lower) for the price-target
    clamps. The module's bollinger() returns only percent_b; the target math
    needs the band edges, mirroring js/analysis.js calculateBollingerBands."""
    if len(closes) < period:
        return None
    sl = closes[-period:]
    mid = sum(sl) / period
    var = sum((v - mid) ** 2 for v in sl) / period
    std = math.sqrt(var)
    return {'upper': mid + std_dev * std, 'middle': mid, 'lower': mid - std_dev * std}


def _rp(v):
    """Round a price to a precision appropriate to its magnitude.

    A fixed 2 decimals is wrong for anything under a dollar: it collapses a
    forecast range to zero width. Mirrors the sub-$1 handling in
    js/forecast-band.js so the cron and the browser format alike.
    """
    if v is None:
        return None
    try:
        av = abs(float(v))
    except (TypeError, ValueError):
        return None
    if av >= 1:
        return round(float(v), 2)
    if av >= 0.01:
        return round(float(v), 4)
    return round(float(v), 8)


def price_targets(candles, signal, confidence, timeframe='today'):
    """Possible + probable price-target bands, LOCKED at market open.

    Mirrors js/analysis.js calculatePriceTargets EXACTLY — same ATR multiplier
    (0.8 for the day horizon), same confidence-scaled possible-band distances,
    the same Bollinger-width and recent-high/low clamps, and the same
    probable-band math. Storing this on the ledger row at open means the
    browser displays the SAME band the engine committed to at the open price,
    held all day and graded by close — one engine, one number, no JS<->Python
    re-derivation drift. Anchored to the open price (candles[-1].close, which
    is the entry the row locks). Returns None when there isn't enough data."""
    if not candles or len(candles) < 20:
        return None
    current_price = candles[-1]['close']
    a = atr(candles, 14)
    if not a or current_price <= 0:
        return None
    recent = candles[-20:]
    recent_high = max(c['high'] for c in recent)
    recent_low = min(c['low'] for c in recent)
    closes = [c['close'] for c in candles]
    bb = _bollinger_bands(closes, 20, 2)
    atr_mult = 0.8 if timeframe == 'today' else 1.2
    expected_move = a * atr_mult
    cf = confidence / 100.0

    if signal == 'BUY':
        predicted_high = current_price + expected_move * (0.8 + cf * 0.7)
        predicted_low = current_price - expected_move * (0.3 + (1 - cf) * 0.3)
    elif signal == 'SELL':
        predicted_high = current_price + expected_move * (0.3 + (1 - cf) * 0.3)
        predicted_low = current_price - expected_move * (0.8 + cf * 0.7)
    else:
        predicted_high = current_price + expected_move * 0.6
        predicted_low = current_price - expected_move * 0.6

    if bb:
        max_up = current_price + (bb['upper'] - bb['middle']) * 2
        max_down = current_price - (bb['middle'] - bb['lower']) * 2
        predicted_high = min(predicted_high, max_up)
        predicted_low = max(predicted_low, max_down)

    if predicted_high > recent_high * 1.05:
        predicted_high = recent_high + (predicted_high - recent_high) * 0.5
    if predicted_low < recent_low * 0.95:
        predicted_low = recent_low - (recent_low - predicted_low) * 0.5

    # The clamps above can CROSS the two levels. If a symbol has crashed,
    # recent_high sits below the locked price, the high clamp drags
    # predicted_high down past predicted_low, and the stored range inverts.
    # Measured on the live ledger: 2,486 of 18,814 rows with targets (13.2%)
    # were inverted or zero-width. An inverted range makes "price stayed inside"
    # impossible, so such a row can ONLY ever be scored as a hit, which silently
    # inflated every range-hit statistic.
    #
    # Repair rather than discard: re-centre a minimum-width band on the locked
    # price using the same expected move, so the row stays gradable and honest.
    if predicted_high <= predicted_low:
        half = max(abs(expected_move) * 0.5, current_price * 0.002)
        predicted_high = current_price + half
        predicted_low = max(current_price - half, current_price * 0.01)

    high_pct = ((predicted_high - current_price) / current_price) * 100
    low_pct = ((predicted_low - current_price) / current_price) * 100

    # Probable band — narrower zone biased toward the called direction.
    probable_inner = 0.18 + (1 - cf) * 0.18
    probable_outer = 0.45 + (1 - cf) * 0.20
    if signal == 'BUY':
        probable_high = current_price + expected_move * probable_outer
        probable_low = current_price - expected_move * probable_inner
    elif signal == 'SELL':
        probable_high = current_price + expected_move * probable_inner
        probable_low = current_price - expected_move * probable_outer
    else:
        probable_high = current_price + expected_move * 0.30
        probable_low = current_price - expected_move * 0.30
    probable_high = min(probable_high, predicted_high)
    probable_low = max(probable_low, predicted_low)
    probable_high_pct = ((probable_high - current_price) / current_price) * 100
    probable_low_pct = ((probable_low - current_price) / current_price) * 100

    return {
        'currentPrice': round(current_price, 4),   # == the locked open entry
        # Precision must scale with price. round(x, 2) quantizes a sub-dollar
        # quote to whole cents, which on a $0.09 name makes predictedHigh and
        # predictedLow IDENTICAL: a zero-width range that any tick breaks out of.
        # Observed on 2026-08-24 for DOGE-USD (0.0900/0.0900), KAS-USD
        # (0.0300/0.0300), MANTA-USD and SCRT-USD, all recorded as "BROKE OUT"
        # purely because the stored range had no width. Sub-dollar names are a
        # large share of this universe, so this silently poisoned every
        # range-hit statistic derived from the ledger.
        'predictedHigh': _rp(predicted_high),
        'predictedLow': _rp(predicted_low),
        'highPercent': round(high_pct, 2),
        'lowPercent': round(low_pct, 2),
        'probableHigh': _rp(probable_high),
        'probableLow': _rp(probable_low),
        'probableHighPercent': round(probable_high_pct, 2),
        'probableLowPercent': round(probable_low_pct, 2),
        'expectedMove': _rp(expected_move),
        'atr': _rp(a),
        'support': _rp(recent_low),
        'resistance': _rp(recent_high),
        'timeframe': timeframe,
    }


def generate_prediction(candles):
    if len(candles) < 30:
        return {'signal': 'NEUTRAL', 'confidence': 0, 'indicators': None}

    closes = [c['close'] for c in candles]
    volumes = [c['volume'] for c in candles if c['volume'] > 0]

    rsi_v = rsi(closes)
    macd_v = macd(closes)
    bb_v = bollinger(closes)
    cross_v = ma_crossover(closes)
    vol_v = volume_spike(volumes)

    # ── Horizon-aware mean-reversion vs momentum tilt ────────────────────
    # This Python path records the NEXT-DAY (short-horizon) ledger call —
    # exactly the path the live ledger proved was a failed momentum-chaser
    # (1d: momentum bets 31-35%, mean-reversion bets 61-66%, as-issued 46.7%).
    # So at this short horizon we up-weight mean-reversion (RSI/BB) and damp
    # momentum (MACD/MA-cross/5-bar), GATED by the ADX regime so a trending
    # tape eases the tilt back. MUST stay in sync with js/analysis.js
    # generatePrediction (short-horizon branch). A re-scoring backtest put
    # the optimum near mean-reversion weight ~0.7; these factors approximate
    # that while bounded.
    highs = [c['high'] for c in candles]
    lows = [c['low'] for c in candles]
    adx_v = compute_adx(highs, lows, closes)
    if adx_v is None:
        mr_tilt, mom_tilt = 1.4, 0.6          # unknown regime -> lean reversion
    elif adx_v > 25:
        mr_tilt, mom_tilt = 1.15, 0.85        # trending -> only mild reversion lean
    elif adx_v < 20:
        mr_tilt, mom_tilt = 1.6, 0.45         # ranging -> strong reversion, suppress momentum
    else:
        mr_tilt, mom_tilt = 1.4, 0.6          # transitional

    bull = bear = total = 0.0

    if rsi_v is not None:                      # RSI extremes = mean-reversion
        w = 2 * mr_tilt
        total += w
        if rsi_v < 30: bull += w
        elif rsi_v < 40: bull += w * 0.5
        elif rsi_v > 70: bear += w
        elif rsi_v > 60: bear += w * 0.5

    if macd_v:                                 # MACD = momentum
        w = 2.5 * mom_tilt
        total += w
        if macd_v['crossover']: bull += w
        elif macd_v['crossunder']: bear += w
        elif macd_v['histogram'] > 0 and macd_v['macd'] > 0: bull += w * 0.6
        elif macd_v['histogram'] < 0 and macd_v['macd'] < 0: bear += w * 0.6
        elif macd_v['histogram'] > 0: bull += w * 0.2
        else: bear += w * 0.2

    if bb_v:                                   # Bollinger %b = mean-reversion
        w = 2 * mr_tilt
        total += w
        if bb_v['percent_b'] < 0: bull += w
        elif bb_v['percent_b'] < 0.2: bull += w * 0.75
        elif bb_v['percent_b'] > 1: bear += w
        elif bb_v['percent_b'] > 0.8: bear += w * 0.75

    if cross_v:                                # MA cross = momentum/trend
        w = 2 * mom_tilt
        total += w
        if cross_v['bullish_cross']: bull += w
        elif cross_v['bearish_cross']: bear += w
        elif cross_v['bullish']: bull += w * 0.5
        else: bear += w * 0.5

    if vol_v and len(volumes) > 20:            # volume confirmation (neutral)
        total += 1.5
        if vol_v['spike']:
            if closes[-1] > closes[-2]: bull += 1.5
            else: bear += 1.5

    # 5-bar price momentum = momentum signal
    wmo = 1 * mom_tilt
    total += wmo
    recent = closes[-5:]
    momentum = (recent[-1] - recent[0]) / recent[0] * 100
    if momentum > 2: bull += wmo
    elif momentum < -2: bear += wmo

    if total == 0:
        return {'signal': 'NEUTRAL', 'confidence': 0, 'indicators': None}
    net = bull - bear
    norm = net / total
    abs_norm = abs(norm)
    confidence = round(min(88, 42 + abs_norm * 35 + (abs_norm ** 0.7) * 15))
    if norm > 0.12: signal = 'BUY'
    elif norm < -0.12: signal = 'SELL'
    else: signal = 'NEUTRAL'

    # Abstain gate — mirror of the JS engine (see js/analysis.js). When
    # the bull/bear edge is at chance levels OR the engine returned
    # NEUTRAL with low confidence, emit NO_TRADE so calibration metrics
    # reflect what users actually see (we don't log NO_TRADE rows as
    # predictions). Threshold-driven, not enumerated rules.
    if abs_norm < 0.10:
        signal = 'NO_TRADE'
    elif signal == 'NEUTRAL' and confidence < 50:
        signal = 'NO_TRADE'

    indicators = {'rsi': rsi_v, 'macd': macd_v, 'bb': bb_v}
    # weightedScore: the 0-100 bull scale (50 = neutral) the JS learner
    # (calibration-thresholds.js) needs to derive buy/sell SCORE thresholds.
    # The ledger previously stored only signal+confidence, so the learner saw
    # no weightedScore on any row and was STUCK on bootstrap (60/40) forever.
    # norm in [-1,+1] maps linearly: +1 -> 100 bullish, -1 -> 0 bearish.
    weighted_score = round(50 + norm * 50, 2)
    # dispersion: a 0-80 "evidence disagreement" proxy so the learner's
    # dispersion-penalty bands have data. The JS engine measures spread across
    # 4 named sources; this Python engine has only bull/bear tallies, so we
    # use the share of evidence that pulled AGAINST the net direction —
    # higher = more conflicted. Scaled to the learner's 0-80 bucket range.
    conflicting = min(bull, bear)
    dispersion = round((conflicting / total) * 80, 1) if total else 0
    # Directional expected-move distance this prediction implies, stored on
    # the row so record_outcomes can grade capturedPct without re-deriving
    # the target (drift-proof: the row carries the number it's graded on).
    # Only meaningful for directional calls; None for NEUTRAL/NO_TRADE.
    expected_move = None
    if signal in ('BUY', 'SELL'):
        expected_move = expected_move_for(candles, signal, confidence)
    # Full possible + probable price-target bands, locked at open right after
    # the signal — the browser reads these directly instead of re-deriving an
    # approximate band from expectedMove. Computed for directional calls (the
    # bands are direction-shaped); None for NEUTRAL/NO_TRADE.
    targets = None
    if signal in ('BUY', 'SELL'):
        targets = price_targets(candles, signal, confidence)
    return {'signal': signal, 'confidence': confidence, 'indicators': indicators,
            'weightedScore': weighted_score, 'dispersion': dispersion,
            'expectedMove': expected_move, 'priceTargets': targets,
            'engineVersion': ENGINE_VERSION}


def classify_tier(price, avg_volume):
    p = float(price) if price is not None else 0.0
    v = float(avg_volume) if avg_volume is not None else 0.0
    if p < 1: return 'penny'
    if p < 5 or v < 100_000: return 'small'
    if p < 20 or v < 1_000_000: return 'mid'
    if p < 100 or v < 10_000_000: return 'large'
    return 'mega'


def classify_vol_tier(vix):
    if vix is None:
        return None
    try:
        v = float(vix)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v) or v <= 0:
        return None
    if v < 16: return 'low'
    if v < 22: return 'mid'
    return 'high'


def rsi_bucket(rsi_v):
    if rsi_v is None: return 'X'
    if rsi_v < 30: return 'OS'
    if rsi_v < 45: return 'L'
    if rsi_v < 55: return 'M'
    if rsi_v < 70: return 'H'
    return 'OB'


def macd_state(macd_v):
    if not macd_v: return 'X'
    if macd_v.get('crossover'): return 'XU'
    if macd_v.get('crossunder'): return 'XD'
    if macd_v.get('histogram', 0) > 0: return 'P'
    if macd_v.get('histogram', 0) < 0: return 'N'
    return 'F'


def bb_state(bb_v):
    if not bb_v: return 'X'
    pb = bb_v.get('percent_b', 0.5)
    if pb < 0: return 'B'
    if pb < 0.2: return 'L'
    if pb > 1: return 'A'
    if pb > 0.8: return 'H'
    return 'M'


def encode_pattern(signal, indicators, tier):
    i = indicators or {}
    return '|'.join([
        signal or 'X',
        rsi_bucket(i.get('rsi')),
        macd_state(i.get('macd')),
        bb_state(i.get('bb')),
        tier or 'X',
    ])


def fetch_vix_map(period=PERIOD):
    try:
        df = yf.download('^VIX', period=period, interval='1d', progress=False)
        if df.empty:
            return {}
        try:
            close = df['Close']
            if hasattr(close, 'to_frame') and close.ndim > 1:
                close = close.iloc[:, 0]
        except KeyError:
            close = df.xs('Close', axis=1, level=0).iloc[:, 0]
        out = {}
        for ts, val in close.items():
            try:
                key = ts.strftime('%Y-%m-%d')
                fv = float(val)
                if not math.isnan(fv):
                    out[key] = fv
            except Exception:
                continue
        return out
    except Exception as e:
        print(f"  [warn] VIX fetch failed: {e} — vol_tier will be skipped")
        return {}


def backtest_symbol(symbol, period=PERIOD, since=None, vix_map=None):
    df = yf.download(symbol, period=period, interval='1d', progress=False)
    if len(df) < 60:
        return None
    if since:
        df = df[df.index >= since]
        if len(df) < 60:
            return None

    close, high, low, volume = extract_ohlcv(df)
    n = len(close)

    predictions = []
    for i in range(50, n - 1):
        candles = [
            {'open': c, 'close': c, 'high': h, 'low': l, 'volume': v}
            for c, h, l, v in zip(close[max(0, i - 49):i + 1], high[max(0, i - 49):i + 1], low[max(0, i - 49):i + 1], volume[max(0, i - 49):i + 1])
        ]
        pred = generate_prediction(candles)
        actual_up = close[i + 1] > close[i]
        return_pct = (close[i + 1] - close[i]) / close[i] * 100
        recent_vol = volume[max(0, i - 20):i + 1]
        avg_vol = float(recent_vol.mean()) if len(recent_vol) > 0 else 0
        tier = classify_tier(close[i], avg_vol)
        date_str = str(df.index[i].date())
        vix_level = (vix_map or {}).get(date_str)
        vol_tier = classify_vol_tier(vix_level)
        pattern = encode_pattern(pred['signal'], pred.get('indicators'), tier)
        predictions.append({
            'date': date_str,
            'signal': pred['signal'],
            'confidence': pred['confidence'],
            'actual_up': bool(actual_up),
            'return': float(return_pct),
            'tier': tier,
            'vol_tier': vol_tier,
            'pattern': pattern,
        })
    return predictions


def calibration_buckets(directional):
    buckets = []
    for lo in range(40, 100, 10):
        hi = lo + 10
        in_bucket = [p for p in directional if lo <= p['confidence'] < hi]
        if not in_bucket:
            continue
        hits = sum(
            1 for p in in_bucket
            if (p['signal'] == 'BUY' and p['actual_up']) or (p['signal'] == 'SELL' and not p['actual_up'])
        )
        buckets.append({
            'bucket': f'{lo}-{hi}%',
            'count': len(in_bucket),
            'predicted': round(sum(p['confidence'] for p in in_bucket) / len(in_bucket), 2),
            'actual': round(hits / len(in_bucket) * 100, 2),
        })
    return buckets


def calibration_buckets_weighted(directional, halflife_days=RECENCY_HALFLIFE_DAYS, today=None):
    """Recency-weighted calibration. weight = 2^(-age_days / halflife).

    Predicted is unweighted average of confidence (label space). Actual is
    weighted hit rate. Count is rounded sum of weights so JS calibration.js
    can use the same n>=30 gate as other strata.
    """
    if not directional:
        return []
    if today is None:
        today = datetime.date.today()
    buckets = []
    for lo in range(40, 100, 10):
        hi = lo + 10
        in_bucket = [p for p in directional if lo <= p['confidence'] < hi]
        if not in_bucket:
            continue
        wsum = 0.0
        whits = 0.0
        conf_sum = 0.0
        for p in in_bucket:
            try:
                d = datetime.date.fromisoformat(p['date'])
                age = (today - d).days
            except Exception:
                age = 0
            w = 0.5 ** (max(0, age) / float(halflife_days))
            wsum += w
            is_hit = (p['signal'] == 'BUY' and p['actual_up']) or (p['signal'] == 'SELL' and not p['actual_up'])
            if is_hit:
                whits += w
            conf_sum += p['confidence']
        if wsum < 1.0:
            continue
        buckets.append({
            'bucket': f'{lo}-{hi}%',
            'count': int(round(wsum)),
            'predicted': round(conf_sum / len(in_bucket), 2),
            'actual': round((whits / wsum) * 100, 2),
        })
    return buckets


def conformal_buckets(directional, alpha=0.30):
    buckets = {}
    for sig in ('BUY', 'SELL'):
        sig_preds = [p for p in directional if p['signal'] == sig]
        for lo in range(40, 100, 10):
            hi = lo + 10
            in_bucket = [p for p in sig_preds if lo <= p['confidence'] < hi]
            if not in_bucket:
                continue
            residuals = [abs(p['return']) for p in in_bucket]
            q = float(np.quantile(residuals, 1 - alpha)) if residuals else 0
            buckets[f'{sig}-{lo}-{hi}'] = {
                'n': len(in_bucket),
                'q70_pct': round(q, 3),
                'mean_abs_return_pct': round(float(np.mean(residuals)), 3),
            }
        if sig_preds:
            residuals = [abs(p['return']) for p in sig_preds]
            q = float(np.quantile(residuals, 1 - alpha))
            buckets[f'{sig}-any'] = {
                'n': len(sig_preds),
                'q70_pct': round(q, 3),
                'mean_abs_return_pct': round(float(np.mean(residuals)), 3),
            }
    return buckets


def pattern_hit_rates(directional, min_n=30):
    counts = {}
    for p in directional:
        key = p.get('pattern')
        if not key:
            continue
        c = counts.setdefault(key, {'n': 0, 'hits': 0})
        c['n'] += 1
        is_hit = (p['signal'] == 'BUY' and p['actual_up']) or (p['signal'] == 'SELL' and not p['actual_up'])
        if is_hit: c['hits'] += 1
    out = {}
    for key, c in counts.items():
        if c['n'] >= min_n:
            out[key] = {'n': c['n'], 'hit_rate': round(c['hits'] / c['n'], 3)}
    return out


def summarize(predictions):
    total = len(predictions)
    # NO_TRADE is the engine abstaining; we surface a count for visibility
    # but it never gets a hit-rate (there's no direction to score against).
    by_signal = {'BUY': [], 'SELL': [], 'NEUTRAL': [], 'NO_TRADE': []}
    for p in predictions:
        by_signal.setdefault(p['signal'], []).append(p)

    out = {'total': total, 'by_signal': {}}
    for sig, ps in by_signal.items():
        if not ps:
            out['by_signal'][sig] = {'count': 0}
            continue
        if sig == 'BUY':
            hits = sum(1 for p in ps if p['actual_up'])
        elif sig == 'SELL':
            hits = sum(1 for p in ps if not p['actual_up'])
        elif sig == 'NEUTRAL':
            hits = sum(1 for p in ps if p['actual_up'])
        else:  # NO_TRADE — no directional bet, so no hit-rate
            out['by_signal'][sig] = {
                'count': len(ps),
                'avg_confidence': round(sum(p['confidence'] for p in ps) / len(ps), 2),
                'note': 'abstained — not scored',
            }
            continue
        out['by_signal'][sig] = {
            'count': len(ps),
            'hit_rate': round(hits / len(ps) * 100, 2),
            'avg_confidence': round(sum(p['confidence'] for p in ps) / len(ps), 2),
        }

    directional = [p for p in predictions if p['signal'] in ('BUY', 'SELL')]
    out['calibration'] = calibration_buckets(directional)

    by_tier = {}
    for tier in ('mega', 'large', 'mid', 'small', 'penny'):
        tier_pred = [p for p in directional if p.get('tier') == tier]
        if len(tier_pred) >= 30:
            by_tier[tier] = calibration_buckets(tier_pred)
    if by_tier:
        out['calibration_by_tier'] = by_tier

    by_vol = {}
    for vol_tier in ('low', 'mid', 'high'):
        vt_pred = [p for p in directional if p.get('vol_tier') == vol_tier]
        if len(vt_pred) >= 30:
            by_vol[vol_tier] = calibration_buckets(vt_pred)
    if by_vol:
        out['calibration_by_vol_tier'] = by_vol

    # Recency-weighted calibration (priority 1 in js/calibration.js).
    if directional:
        weighted = calibration_buckets_weighted(directional, halflife_days=RECENCY_HALFLIFE_DAYS)
        if weighted:
            out['calibration_recency_weighted'] = weighted

    if directional:
        out['conformal'] = {
            'alpha': 0.30,
            'buckets': conformal_buckets(directional, alpha=0.30),
            'method': 'split-conformal residual quantile of |daily return %|',
        }
        ph = pattern_hit_rates(directional)
        if ph:
            out['pattern_hit_rates'] = ph

    rets = []
    for p in directional:
        if p['signal'] == 'BUY': rets.append(p['return'] / 100)
        elif p['signal'] == 'SELL': rets.append(-p['return'] / 100)
    if rets:
        rets_arr = np.array(rets)
        mean = rets_arr.mean()
        std = rets_arr.std()
        sharpe = (mean / std * math.sqrt(252)) if std > 0 else 0
        equity = np.cumprod(1 + rets_arr)
        peak = np.maximum.accumulate(equity)
        drawdown = (equity - peak) / peak
        max_dd = float(drawdown.min())
        out['pnl'] = {
            'trades': len(rets),
            'total_return': round((float(equity[-1]) - 1) * 100, 2),
            'sharpe': round(float(sharpe), 2),
            'max_drawdown': round(max_dd * 100, 2),
        }
    else:
        out['pnl'] = {'trades': 0}
    return out


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', help='Backtest a single symbol instead of all')
    parser.add_argument('--since', help='ISO date, e.g. 2023-01-01')
    args = parser.parse_args()

    os.makedirs(MODEL_DIR, exist_ok=True)

    print("Fetching ^VIX history for vol-tier classification...")
    vix_map = fetch_vix_map(PERIOD)
    print(f"  Loaded {len(vix_map)} VIX daily closes.")

    symbols = [args.symbol] if args.symbol else SYMBOLS
    print(f"Backtesting {len(symbols)} symbol(s)...")

    per_symbol = {}
    all_preds = []
    errors = 0
    for sym in symbols:
        # Per-symbol isolation: a single symbol throwing (yfinance error,
        # malformed/NaN data, an indicator edge case) must NOT fail the whole
        # backtest job. Previously an unguarded throw here killed the entire
        # GitHub Action ("All jobs have failed"). Now we log + skip and keep
        # going; the run still produces backtest_results.json from the rest.
        try:
            preds = backtest_symbol(sym, since=args.since, vix_map=vix_map)
        except Exception as e:
            errors += 1
            print(f"  {sym}: ERROR — {type(e).__name__}: {e}")
            continue
        if not preds:
            print(f"  {sym}: skipped (insufficient data)")
            continue
        per_symbol[sym] = summarize(preds)
        all_preds.extend(preds)
        s = per_symbol[sym]
        buy_hr = s['by_signal'].get('BUY', {}).get('hit_rate', 0)
        sell_hr = s['by_signal'].get('SELL', {}).get('hit_rate', 0)
        sharpe = s['pnl'].get('sharpe', 0)
        print(f"  {sym}: BUY {buy_hr}%, SELL {sell_hr}%, Sharpe {sharpe}, n={s['total']}")
    if errors:
        print(f"\n{errors} symbol(s) errored and were skipped (job continues).")

    overall = summarize(all_preds)
    print("\n─── OVERALL ───")
    print(f"Total predictions: {overall['total']}")
    for sig, stats in overall['by_signal'].items():
        if not stats.get('count'):
            continue
        # NO_TRADE has no hit_rate (abstain — nothing to score). summarize()
        # writes a 'note' key for those rows; print that instead so the
        # overall summary still surfaces NO_TRADE counts without crashing.
        if 'hit_rate' not in stats:
            note = stats.get('note', 'no hit rate')
            print(f"  {sig}: n={stats['count']}, avg confidence {stats['avg_confidence']}% ({note})")
            continue
        print(f"  {sig}: {stats['hit_rate']}% hit rate (n={stats['count']}, avg confidence {stats['avg_confidence']}%)")
    print("\nCalibration (predicted → actual):")
    for b in overall['calibration']:
        diff = b['actual'] - b['predicted']
        flag = '  ' if abs(diff) < 5 else ' ⚠'
        print(f"  {b['bucket']:>10}: predicted {b['predicted']:>5.1f}% → actual {b['actual']:>5.1f}% (n={b['count']}){flag}")
    if overall.get('calibration_recency_weighted'):
        print("\nCalibration (recency-weighted, 30d half-life):")
        for b in overall['calibration_recency_weighted']:
            diff = b['actual'] - b['predicted']
            flag = '  ' if abs(diff) < 5 else ' ⚠'
            print(f"  {b['bucket']:>10}: predicted {b['predicted']:>5.1f}% → actual {b['actual']:>5.1f}% (n={b['count']}){flag}")
    if overall.get('calibration_by_tier'):
        print("\nCalibration by liquidity tier:")
        for tier, buckets in overall['calibration_by_tier'].items():
            n = sum(b['count'] for b in buckets)
            print(f"  {tier}: {len(buckets)} buckets, n={n}")
    if overall.get('calibration_by_vol_tier'):
        print("\nCalibration by volatility tier:")
        for vt, buckets in overall['calibration_by_vol_tier'].items():
            n = sum(b['count'] for b in buckets)
            print(f"  {vt}: {len(buckets)} buckets, n={n}")
    if overall.get('pattern_hit_rates'):
        print(f"\nPattern hit rates: {len(overall['pattern_hit_rates'])} patterns with n>=30")
        items = sorted(overall['pattern_hit_rates'].items(), key=lambda x: x[1]['hit_rate'])
        print("  Worst 5:")
        for k, v in items[:5]:
            print(f"    {k}: {v['hit_rate']:.2f} (n={v['n']})")
        print("  Best 5:")
        for k, v in items[-5:]:
            print(f"    {k}: {v['hit_rate']:.2f} (n={v['n']})")
    if overall.get('conformal'):
        print("\nConformal intervals (alpha=0.30, 70% coverage):")
        for key, b in sorted(overall['conformal']['buckets'].items()):
            print(f"  {key}: ±{b['q70_pct']}% (n={b['n']})")
    if overall['pnl'].get('trades'):
        print(f"\nPnL: {overall['pnl']['total_return']}% return, Sharpe {overall['pnl']['sharpe']}, max DD {overall['pnl']['max_drawdown']}%")

    results = {
        'method': 'historical replay of signal pipeline',
        'overall': overall,
        'per_symbol': per_symbol,
    }
    with open(RESULTS_PATH, 'w') as f:
        # allow_nan=False forces an error instead of emitting bare NaN/Infinity
        # tokens, which are INVALID JSON: the browser's JSON.parse throws on
        # them, and that single throw was killing ALL of calibration.js's
        # loadCalibration() (it bailed before even loading live calibration —
        # so confidence silently fell back to raw/uncalibrated). We sanitize
        # first (NaN/Inf -> null), THEN dump strictly so any future non-finite
        # leak fails the cron loudly instead of shipping unparseable JSON.
        json.dump(_json_safe(results), f, indent=2, allow_nan=False)
    print(f"\n✓ Results written to {RESULTS_PATH}")
