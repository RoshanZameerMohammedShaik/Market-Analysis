"""
Backtester: replays the signal pipeline on Yahoo historical data and
reports whether the predictions actually worked.

What it measures:
  - Hit rate by signal type (BUY / SELL / NEUTRAL)
  - Calibration: does "70% confidence" actually hit 70% of the time?
  - Calibration stratified by liquidity tier (mega/large/mid/small/penny)
  - Calibration stratified by volatility tier (low/mid/high VIX)
  - Conformal prediction-interval residuals per signal+confidence bucket
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
import numpy as np
import yfinance as yf

from shared_features import extract_ohlcv, compute_features_at
from train_model import SYMBOLS, PERIOD

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
RESULTS_PATH = os.path.join(MODEL_DIR, 'backtest_results.json')

# ─── Indicator implementations (must mirror js/analysis.js exactly) ──────


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


# ─── Single-timeframe prediction (mirrors js/analysis.js generatePrediction) ─


def generate_prediction(candles):
    if len(candles) < 30:
        return {'signal': 'NEUTRAL', 'confidence': 0}

    closes = [c['close'] for c in candles]
    volumes = [c['volume'] for c in candles if c['volume'] > 0]

    rsi_v = rsi(closes)
    macd_v = macd(closes)
    bb_v = bollinger(closes)
    cross_v = ma_crossover(closes)
    vol_v = volume_spike(volumes)

    bull = bear = total = 0.0

    if rsi_v is not None:
        total += 2
        if rsi_v < 30: bull += 2
        elif rsi_v < 40: bull += 1
        elif rsi_v > 70: bear += 2
        elif rsi_v > 60: bear += 1

    if macd_v:
        total += 2.5
        if macd_v['crossover']: bull += 2.5
        elif macd_v['crossunder']: bear += 2.5
        elif macd_v['histogram'] > 0 and macd_v['macd'] > 0: bull += 1.5
        elif macd_v['histogram'] < 0 and macd_v['macd'] < 0: bear += 1.5
        elif macd_v['histogram'] > 0: bull += 0.5
        else: bear += 0.5

    if bb_v:
        total += 2
        if bb_v['percent_b'] < 0: bull += 2
        elif bb_v['percent_b'] < 0.2: bull += 1.5
        elif bb_v['percent_b'] > 1: bear += 2
        elif bb_v['percent_b'] > 0.8: bear += 1.5

    if cross_v:
        total += 2
        if cross_v['bullish_cross']: bull += 2
        elif cross_v['bearish_cross']: bear += 2
        elif cross_v['bullish']: bull += 1
        else: bear += 1

    if vol_v and len(volumes) > 20:
        total += 1.5
        if vol_v['spike']:
            if closes[-1] > closes[-2]: bull += 1.5
            else: bear += 1.5

    total += 1
    recent = closes[-5:]
    momentum = (recent[-1] - recent[0]) / recent[0] * 100
    if momentum > 2: bull += 1
    elif momentum < -2: bear += 1

    if total == 0:
        return {'signal': 'NEUTRAL', 'confidence': 0}
    net = bull - bear
    norm = net / total
    abs_norm = abs(norm)
    confidence = round(min(88, 42 + abs_norm * 35 + (abs_norm ** 0.7) * 15))
    if norm > 0.12: signal = 'BUY'
    elif norm < -0.12: signal = 'SELL'
    else: signal = 'NEUTRAL'
    return {'signal': signal, 'confidence': confidence}


def classify_tier(price, avg_volume):
    p = float(price) if price is not None else 0.0
    v = float(avg_volume) if avg_volume is not None else 0.0
    if p < 1: return 'penny'
    if p < 5 or v < 100_000: return 'small'
    if p < 20 or v < 1_000_000: return 'mid'
    if p < 100 or v < 10_000_000: return 'large'
    return 'mega'


def classify_vol_tier(vix):
    """Mirror of js/calibration.js classifyVolTier. None if VIX missing."""
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


def fetch_vix_map(period=PERIOD):
    """One-shot fetch of ^VIX. Returns dict keyed by 'YYYY-MM-DD' isodate."""
    try:
        df = yf.download('^VIX', period=period, interval='1d', progress=False)
        if df.empty:
            return {}
        # Robust column access across yfinance versions (sometimes MultiIndex)
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


# ─── Backtest loop ──────────────────────────────────────────────────────


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
        avg_vol = sum(recent_vol) / len(recent_vol) if recent_vol else 0
        tier = classify_tier(close[i], avg_vol)
        date_str = str(df.index[i].date())
        vix_level = (vix_map or {}).get(date_str)
        vol_tier = classify_vol_tier(vix_level)
        predictions.append({
            'date': date_str,
            'signal': pred['signal'],
            'confidence': pred['confidence'],
            'actual_up': bool(actual_up),
            'return': float(return_pct),
            'tier': tier,
            'vol_tier': vol_tier,
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


def summarize(predictions):
    total = len(predictions)
    by_signal = {'BUY': [], 'SELL': [], 'NEUTRAL': []}
    for p in predictions:
        by_signal[p['signal']].append(p)

    out = {'total': total, 'by_signal': {}}
    for sig, ps in by_signal.items():
        if not ps:
            out['by_signal'][sig] = {'count': 0}
            continue
        if sig == 'BUY':
            hits = sum(1 for p in ps if p['actual_up'])
        elif sig == 'SELL':
            hits = sum(1 for p in ps if not p['actual_up'])
        else:
            hits = sum(1 for p in ps if p['actual_up'])
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

    if directional:
        out['conformal'] = {
            'alpha': 0.30,
            'buckets': conformal_buckets(directional, alpha=0.30),
            'method': 'split-conformal residual quantile of |daily return %|',
        }

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
    for sym in symbols:
        preds = backtest_symbol(sym, since=args.since, vix_map=vix_map)
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

    overall = summarize(all_preds)
    print("\n─── OVERALL ───")
    print(f"Total predictions: {overall['total']}")
    for sig, stats in overall['by_signal'].items():
        if stats.get('count'):
            print(f"  {sig}: {stats['hit_rate']}% hit rate (n={stats['count']}, avg confidence {stats['avg_confidence']}%)")
    print("\nCalibration (predicted → actual):")
    for b in overall['calibration']:
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
        json.dump(results, f, indent=2)
    print(f"\n✓ Results written to {RESULTS_PATH}")
