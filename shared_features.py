"""
Single source of truth for engineered features used by:
  - train_model.py        (LSTM training)
  - train_walkforward.py  (LSTM with walk-forward CV)
  - train_xgboost.py      (XGBoost + isotonic calibration)
  - backtest.py           (replays the signal pipeline)

The browser (js/ai-model.js, js/analysis.js) duplicates this logic in
JavaScript. Both sides MUST stay in sync.

The LSTM uses 8 features (FEATURES, compute_features_at). The newer
ADX and MFI indicators feed the rules-based pipeline (js/analysis.js)
but are not yet in the LSTM input — adding them requires a retrain,
which the GitHub Action workflow will handle on schedule.
"""
import math
import numpy as np

SEQUENCE_LENGTH = 20
FEATURES = 8
LOOKBACK = 21


def extract_ohlcv(df):
    if hasattr(df.columns, 'levels'):
        df.columns = df.columns.get_level_values(0)
    return (
        df['Close'].values.flatten().astype(float),
        df['High'].values.flatten().astype(float),
        df['Low'].values.flatten().astype(float),
        df['Volume'].values.flatten().astype(float),
    )


def compute_features_at(close, high, low, volume, j):
    """8-feature vector at index j. Mirrors js/ai-model.js exactly."""
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

    return [
        price_change * 10,
        high_low_range * 10,
        rsi,
        vol_ratio,
        ma_ratio_9 * 10,
        ma_ratio_21 * 10,
        bb_position,
        momentum * 5,
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
    """(sequence, label) pairs for an LSTM."""
    close, high, low, volume = extract_ohlcv(df)
    features = []
    labels = []
    for i in range(sequence_length, len(close) - 1):
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
    for i in range(SEQUENCE_LENGTH, len(close) - 1):
        X.append(compute_features_at(close, high, low, volume, i - 1))
        next_change = (close[i + 1] - close[i]) / close[i]
        y.append(1 if next_change > 0 else 0)
    return X, y
