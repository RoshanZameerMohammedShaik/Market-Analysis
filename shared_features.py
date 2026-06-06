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
import time
import numpy as np

SEQUENCE_LENGTH = 20
FEATURES = 11

# ── Labeling ──────────────────────────────────────────────────────────────
# Triple-barrier labeling (López de Prado). Instead of "did the very next
# bar close up?", we ask: starting from bar i, does price touch the UPPER
# barrier (+k·ATR) before the LOWER barrier (−k·ATR) within the next
# LABEL_HORIZON bars? Label 1 = upper first (a real up-move materialized),
# 0 = lower first. If NEITHER barrier is touched in the window, fall back to
# the sign of the terminal-bar return so no sample is dropped (preserves
# dataset size + keeps the old behavior for flat windows).
#
# Why this is better than binary next-bar: the old label rewarded a +0.01%
# tick identically to a clean +5% run and called a setup that dipped 4% then
# closed +0.1% a "win". Triple-barrier teaches the model the difference
# between a setup that actually went somewhere and noise — directly targeting
# the magnitude-blindness that kept 1-day accuracy near coin-flip.
LABEL_HORIZON = 5        # bars to look forward for a barrier touch
LABEL_BARRIER_ATR = 1.5  # barrier distance in ATRs (symmetric)
_ATR_LABEL_PERIOD = 14


def _atr_at_label(high, low, close, i, period=_ATR_LABEL_PERIOD):
    """ATR over the `period` bars ENDING at bar i (no lookahead). Returns a
    price distance, or None if not enough history."""
    if i < period:
        return None
    tr_sum = 0.0
    for k in range(i - period + 1, i + 1):
        tr_sum += max(high[k] - low[k], abs(high[k] - close[k - 1]), abs(low[k] - close[k - 1]))
    atr = tr_sum / period
    return atr if atr > 0 else None


def triple_barrier_label(close, high, low, i,
                         horizon=LABEL_HORIZON, k=LABEL_BARRIER_ATR):
    """Label for the setup AT bar i, using only bars i+1..i+horizon (no
    lookahead beyond the horizon). 1 = up-barrier touched first, 0 = down
    first; if neither, sign of the terminal close vs entry. Returns None
    when there aren't enough forward bars OR ATR is unavailable (caller
    should skip — these are the last few bars per symbol)."""
    n = len(close)
    if i + 1 >= n:
        return None
    atr = _atr_at_label(high, low, close, i)
    if atr is None:
        # No volatility scale yet → fall back to next-bar sign (old behavior).
        return 1 if (i + 1 < n and close[i + 1] > close[i]) else 0
    entry = close[i]
    upper = entry + k * atr
    lower = entry - k * atr
    end = min(n - 1, i + horizon)
    for j in range(i + 1, end + 1):
        # Intrabar: an up-move is confirmed if the bar's HIGH reaches upper;
        # a down-move if the LOW reaches lower. If both in the same bar
        # (rare, wide bar), treat as the close direction for that bar to
        # avoid an arbitrary tie.
        hit_up = high[j] >= upper
        hit_dn = low[j] <= lower
        if hit_up and hit_dn:
            return 1 if close[j] >= entry else 0
        if hit_up:
            return 1
        if hit_dn:
            return 0
    # Neither barrier touched in the window → terminal-bar direction.
    return 1 if close[end] >= entry else 0


def robust_download(symbol, *, period=None, interval='1d', start=None, end=None,
                    retries=3, throttle=0.4, **kwargs):
    """yfinance download with bounded retry + throttle, so Yahoo rate-limiting
    DEGRADES GRACEFULLY instead of hanging for hours.

    The cron's train_walkforward.py once ran 3h17m then failed because the
    plain `yf.download` loop over ~530 symbols hit Yahoo throttling and
    yfinance's internal retry/backoff stacked up per symbol. This wraps the
    call so each symbol gets at most `retries` attempts with exponential
    backoff, and a tiny `throttle` sleep BETWEEN symbols spreads the request
    rate so we trip the limiter far less often. Returns an empty DataFrame-ish
    None on persistent failure; callers already handle empties by skipping.

    Imported lazily so non-training code paths don't require yfinance.
    """
    import yfinance as yf  # lazy — only training/backtest scripts need it
    last_err = None
    for attempt in range(retries):
        try:
            if start is not None or end is not None:
                df = yf.download(symbol, start=start, end=end, interval=interval,
                                 progress=False, **kwargs)
            else:
                df = yf.download(symbol, period=period, interval=interval,
                                 progress=False, **kwargs)
            # Polite spacing between symbols — the single biggest lever for
            # not getting rate-limited across a 500-symbol sweep.
            if throttle:
                time.sleep(throttle)
            return df
        except Exception as e:  # noqa: BLE001 — yfinance raises a grab-bag
            last_err = e
            # Exponential backoff: 1s, 2s, 4s — gives a transient throttle
            # time to clear without the multi-hour pileup the old loop hit.
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    if last_err is not None:
        raise last_err
    return None
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
    # Stop LABEL_HORIZON bars before the end so EVERY label has its full
    # forward window — no shorter-horizon (inconsistent) labels on the tail.
    # max(..., start_i) guards tiny series so the range can't go negative.
    end_i = max(start_i, len(close) - LABEL_HORIZON)
    for i in range(start_i, end_i):
        label = triple_barrier_label(close, high, low, i)
        if label is None:
            continue
        window = [
            compute_features_at(close, high, low, volume, j)
            for j in range(i - sequence_length, i)
        ]
        features.append(window)
        labels.append(label)
    return features, labels


def compute_flat_features(df):
    """(X, y) for tree models."""
    close, high, low, volume = extract_ohlcv(df)
    X = []
    y = []
    start_i = max(SEQUENCE_LENGTH, LOOKBACK)
    # Label decision bar is i-1 with a forward window of LABEL_HORIZON, so
    # stop LABEL_HORIZON-1 short of the last index for a full window each.
    end_i = max(start_i, len(close) - LABEL_HORIZON + 1)
    for i in range(start_i, end_i):
        # Features are computed AT bar i-1 (the last bar the model "sees");
        # the triple-barrier label is for the setup AT i-1 too, so feature
        # and label share the same decision bar — no lookahead.
        label = triple_barrier_label(close, high, low, i - 1)
        if label is None:
            continue
        X.append(compute_features_at(close, high, low, volume, i - 1))
        y.append(label)
    return X, y
