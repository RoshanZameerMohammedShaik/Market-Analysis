"""
Single source of truth for engineered features used by:
  - train_model.py        (LSTM training)
  - train_walkforward.py  (LSTM with walk-forward CV)
  - train_xgboost.py      (XGBoost + isotonic calibration)
  - backtest.py           (replays the signal pipeline)

The browser (js/ai-model.js, js/analysis.js) duplicates this logic in
JavaScript. Both sides MUST stay in sync.

The LSTM now uses 11 features (FEATURES, compute_features_at):
  0-7  original 8 (price change, range, RSI, vol ratio, MA9, MA21, BB pos, momentum)
  8    ADX/100         — trend STRENGTH (real trend vs chop)
  9    MFI/100         — volume-weighted RSI (institutional flow)
  10   ATR%            — smoothed volatility regime (normalized)

VERSION SAFETY: the browser reads the model's config.features and only
sends as many features as the deployed model declares. An 8-feature
model file → JS sends 8; an 11-feature model → JS sends 11. So bumping
this file to 11 does NOT break inference against an still-deployed
8-feature model — the new dims only flow once the retrain ships an
11-feature lstm_weights.json. Self-healing, no mismatch window.
"""
import math
import numpy as np

SEQUENCE_LENGTH = 20
FEATURES = 11
# 30 bars of warm-up before the sequence window so ADX (~2*period=28
# bars) has a real value at the first sequence bar. Was 21 when the
# model used only RSI/MA/BB. Mirrors js/ai-model.js LOOKBACK.
LOOKBACK = 30


def extract_ohlcv(df):
    if hasattr(df.columns, 'levels'):
        df.columns = df.columns.get_level_values(0)
    return (
        df['Close'].values.flatten().astype(float),
        df['High'].values.flatten().astype(float),
        df['Low'].values.flatten().astype(float),
        df['Volume'].values.flatten().astype(float),
    )


def _adx_at(high, low, close, j, period=14):
    """Wilder ADX over the trailing window ending at bar j. Returns 0..100.
    Needs ~2*period bars of history; returns neutral 20 before that.
    Mirrors js/ai-model.js adxAt exactly."""
    start = j - (2 * period)
    if start < 1:
        return 20.0  # neutral-ish trend strength before enough history
    tr_sum = plus_sum = minus_sum = 0.0
    # First `period` bars seed the Wilder smoothing.
    for i in range(start + 1, start + period + 1):
        up = high[i] - high[i - 1]
        dn = low[i - 1] - low[i]
        tr = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        tr_sum += tr
        plus_sum += up if (up > dn and up > 0) else 0
        minus_sum += dn if (dn > up and dn > 0) else 0
    dx_values = []
    for i in range(start + period + 1, j + 1):
        up = high[i] - high[i - 1]
        dn = low[i - 1] - low[i]
        tr = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        tr_sum = tr_sum - tr_sum / period + tr
        plus_sum = plus_sum - plus_sum / period + (up if (up > dn and up > 0) else 0)
        minus_sum = minus_sum - minus_sum / period + (dn if (dn > up and dn > 0) else 0)
        plus_di = 0 if tr_sum == 0 else 100 * plus_sum / tr_sum
        minus_di = 0 if tr_sum == 0 else 100 * minus_sum / tr_sum
        sum_di = plus_di + minus_di
        dx_values.append(0 if sum_di == 0 else 100 * abs(plus_di - minus_di) / sum_di)
    if not dx_values:
        return 20.0
    adx = sum(dx_values[:period]) / min(period, len(dx_values))
    for i in range(period, len(dx_values)):
        adx = (adx * (period - 1) + dx_values[i]) / period
    return adx


def _mfi_at(high, low, close, volume, j, period=14):
    """Money Flow Index over the trailing window ending at bar j. 0..100.
    Mirrors js/ai-model.js mfiAt exactly."""
    if j < period:
        return 50.0
    pos_flow = neg_flow = 0.0
    for i in range(j - period + 1, j + 1):
        tp = (high[i] + low[i] + close[i]) / 3
        tp_prev = (high[i - 1] + low[i - 1] + close[i - 1]) / 3
        mf = tp * volume[i]
        if tp > tp_prev:
            pos_flow += mf
        elif tp < tp_prev:
            neg_flow += mf
    if neg_flow == 0:
        return 100.0 if pos_flow > 0 else 50.0
    ratio = pos_flow / neg_flow
    return 100 - (100 / (1 + ratio))


def _atr_pct_at(high, low, close, j, period=14):
    """Average True Range as a fraction of price, over the trailing window
    ending at bar j. Volatility regime, normalized so it's comparable
    across a $2 penny and a $400 mega-cap. Mirrors js/ai-model.js atrPctAt."""
    if j < period:
        return 0.02  # ~2% default before enough history
    tr_sum = 0.0
    for i in range(j - period + 1, j + 1):
        tr = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        tr_sum += tr
    atr = tr_sum / period
    return atr / (close[j] + 1e-8)


def compute_features_at(close, high, low, volume, j):
    """11-feature vector at index j. Mirrors js/ai-model.js exactly."""
    price_change = (close[j] - close[j - 1]) / (close[j - 1] + 1e-8) if j > 0 else 0
    high_low_range = (high[j] - low[j]) / (close[j] + 1e-8)

    if j >= 14:
        gains = sum(max(0, close[k] - close[k - 1]) for k in range(j - 13, j + 1))
        losses = sum(max(0, close[k - 1] - close[k]) for k in range(j - 13, j + 1))
        rsi = gains / (gains + losses + 1e-8)
    else:
        rsi = 0.5

    if j >= 20:
        avg_vol = np.mean(volume[j - 20:j + 1])
        vol_ratio = min(volume[j] / (avg_vol + 1e-8), 5.0) / 5.0
    else:
        vol_ratio = 0.2

    if j >= 9:
        sma9 = np.mean(close[j - 8:j + 1])
        ma_ratio_9 = (close[j] - sma9) / (sma9 + 1e-8)
    else:
        ma_ratio_9 = 0

    if j >= 21:
        sma21 = np.mean(close[j - 20:j + 1])
        ma_ratio_21 = (close[j] - sma21) / (sma21 + 1e-8)
    else:
        ma_ratio_21 = 0

    if j >= 20:
        bb_window = close[j - 19:j + 1]
        bb_mean = np.mean(bb_window)
        bb_std = np.std(bb_window) + 1e-8
        bb_position = max(-1, min(1, (close[j] - bb_mean) / (2 * bb_std)))
    else:
        bb_position = 0

    momentum = (close[j] - close[j - 5]) / (close[j - 5] + 1e-8) if j >= 5 else 0

    # New features 9-11. Each is bounded so it doesn't dominate the
    # un-normalized scale of the others.
    adx = _adx_at(high, low, close, j) / 100.0            # 0..1
    mfi = _mfi_at(high, low, close, volume, j) / 100.0    # 0..1
    atr_pct = min(_atr_pct_at(high, low, close, j), 0.5) * 2  # cap 50% vol → 0..1

    return [
        price_change * 10,
        high_low_range * 10,
        rsi,
        vol_ratio,
        ma_ratio_9 * 10,
        ma_ratio_21 * 10,
        bb_position,
        momentum * 5,
        adx,
        mfi,
        atr_pct,
    ]


# ─── ADX (mirrors js/analysis.js calculateADX) ───────────────────────────────────

def compute_adx(highs, lows, closes, period=14):
    n = len(closes)
    if n < period * 2 + 1:
        return None
    tr = [0.0] * n
    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    for i in range(1, n):
        up_move = highs[i] - highs[i - 1]
        down_move = lows[i - 1] - lows[i]
        tr[i] = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        plus_dm[i] = up_move if (up_move > down_move and up_move > 0) else 0
        minus_dm[i] = down_move if (down_move > up_move and down_move > 0) else 0

    sm_tr = sum(tr[1:period + 1])
    sm_plus = sum(plus_dm[1:period + 1])
    sm_minus = sum(minus_dm[1:period + 1])
    dx_values = []
    for i in range(period + 1, n):
        sm_tr = sm_tr - sm_tr / period + tr[i]
        sm_plus = sm_plus - sm_plus / period + plus_dm[i]
        sm_minus = sm_minus - sm_minus / period + minus_dm[i]
        plus_di = 0 if sm_tr == 0 else 100 * sm_plus / sm_tr
        minus_di = 0 if sm_tr == 0 else 100 * sm_minus / sm_tr
        sum_di = plus_di + minus_di
        dx = 0 if sum_di == 0 else 100 * abs(plus_di - minus_di) / sum_di
        dx_values.append(dx)
    if len(dx_values) < period:
        return None
    adx = sum(dx_values[:period]) / period
    for i in range(period, len(dx_values)):
        adx = (adx * (period - 1) + dx_values[i]) / period
    return adx


def compute_mfi(highs, lows, closes, volumes, period=14):
    n = len(closes)
    if n < period + 1:
        return None
    tp = [(highs[i] + lows[i] + closes[i]) / 3 for i in range(n)]
    pos_flow = neg_flow = 0.0
    start = max(1, n - period)
    for i in range(start, n):
        money_flow = tp[i] * volumes[i]
        if tp[i] > tp[i - 1]: pos_flow += money_flow
        elif tp[i] < tp[i - 1]: neg_flow += money_flow
    if neg_flow == 0: return 100
    ratio = pos_flow / neg_flow
    return 100 - (100 / (1 + ratio))


def compute_sequences(df, sequence_length=SEQUENCE_LENGTH):
    """(sequence, label) pairs for an LSTM.

    Start at max(sequence_length, LOOKBACK) so every bar in every window
    has warmed-up trailing indicators (ADX needs ~28 bars). Drops a few
    early samples per symbol but every feature value is real, not a
    cold-start fallback. Mirrors the JS runtime which fetches LOOKBACK
    extra bars before the live sequence window."""
    close, high, low, volume = extract_ohlcv(df)
    features = []
    labels = []
    start_i = max(sequence_length, LOOKBACK)
    for i in range(start_i, len(close) - 1):
        window = [
            compute_features_at(close, high, low, volume, j)
            for j in range(i - sequence_length, i)
        ]
        features.append(window)
        next_change = (close[i + 1] - close[i]) / close[i]
        labels.append(1 if next_change > 0 else 0)
    return features, labels


def compute_flat_features(df):
    """(X, y) for tree models."""
    close, high, low, volume = extract_ohlcv(df)
    X = []
    y = []
    start_i = max(SEQUENCE_LENGTH, LOOKBACK)
    for i in range(start_i, len(close) - 1):
        X.append(compute_features_at(close, high, low, volume, i - 1))
        next_change = (close[i + 1] - close[i]) / close[i]
        y.append(1 if next_change > 0 else 0)
    return X, y
