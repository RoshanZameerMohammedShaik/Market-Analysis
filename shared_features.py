"""
Single source of truth for the 8 engineered features used by:
  - train_model.py        (LSTM training)
  - train_walkforward.py  (LSTM with walk-forward CV)
  - train_xgboost.py      (XGBoost + isotonic calibration)
  - backtest.py           (replays the signal pipeline)

The browser (js/ai-model.js) duplicates this logic in JavaScript. Both
sides MUST stay in sync — see the matching comment in js/ai-model.js.
"""
import numpy as np

SEQUENCE_LENGTH = 20
FEATURES = 8
LOOKBACK = 21  # longest indicator window (sma21 / vol_ratio)


def extract_ohlcv(df):
    """Pull flat OHLCV arrays out of a yfinance DataFrame, handling MultiIndex."""
    if hasattr(df.columns, 'levels'):
        df.columns = df.columns.get_level_values(0)
    return (
        df['Close'].values.flatten().astype(float),
        df['High'].values.flatten().astype(float),
        df['Low'].values.flatten().astype(float),
        df['Volume'].values.flatten().astype(float),
    )


def compute_features_at(close, high, low, volume, j):
    """Compute the 8-feature vector at index j. Returns list of length 8.

    Mirrors js/ai-model.js computeFeatures() exactly.
    """
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


def compute_sequences(df, sequence_length=SEQUENCE_LENGTH):
    """Compute (sequence, label) pairs for an LSTM. Each sequence is shape (seq_len, FEATURES)."""
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
    """Compute (X, y) for tree models — flatten the sequence into one row per sample.

    Each row is the 8-feature vector at the LAST bar of the window. Trees don't
    need the full sequence and overfit on it.
    """
    close, high, low, volume = extract_ohlcv(df)

    X = []
    y = []

    for i in range(SEQUENCE_LENGTH, len(close) - 1):
        X.append(compute_features_at(close, high, low, volume, i - 1))
        next_change = (close[i + 1] - close[i]) / close[i]
        y.append(1 if next_change > 0 else 0)

    return X, y
