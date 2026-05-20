"""
Record open-of-day predictions for every symbol in a given region.

Usage:
    python record_predictions.py --region NYSE
    python record_predictions.py --region CRYPTO

Writes one append-only JSONL row per symbol per day to:
    model/ledger/<year>.jsonl

Schema (predicted phase):
    {
      "symbol":           "AAPL",
      "region":           "NYSE",
      "date":             "2026-05-20",            // ISO trading date
      "predictedAt":      "2026-05-20T13:30:00Z",  // UTC timestamp of prediction
      "entry":            187.50,                   // price at prediction
      "signal":           "BUY",                    // BUY / SELL / NEUTRAL
      "confidence":       68,                       // 0-100
      "indicators":       { "rsi": 52, "macdHist": 0.3, ... },
      "horizons":         { "1": null, "3": null, "5": null, "10": null, "20": null }
    }

The "horizons" dict gets filled in by record_outcomes.py as each
forward window matures.
"""
import argparse
import datetime
import json
import os

import yfinance as yf

from backtest import generate_prediction
from shared_features import extract_ohlcv
from ledger_universe import symbols_for_region, region_for, HORIZONS_DAYS

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')


def ledger_path_for(date_iso: str) -> str:
    year = date_iso[:4]
    return os.path.join(LEDGER_DIR, f'{year}.jsonl')


def already_predicted_today(path: str, date_iso: str, symbol: str) -> bool:
    """Avoid duplicate predictions if a cron retries."""
    if not os.path.exists(path):
        return False
    needle = f'"date": "{date_iso}"'
    sym_needle = f'"symbol": "{symbol}"'
    with open(path, 'r') as f:
        for line in f:
            if needle in line and sym_needle in line:
                return True
    return False


def fetch_recent_candles(symbol: str, period='6mo'):
    """Pull the trailing window needed to compute indicators (RSI, MACD, BB, etc.)."""
    df = yf.download(symbol, period=period, interval='1d', progress=False, auto_adjust=False)
    if df.empty:
        return None
    return extract_ohlcv(df)


def candles_as_records(close, high, low, volume, n=120):
    out = []
    n = min(n, len(close))
    for i in range(len(close) - n, len(close)):
        out.append({
            'open': float(close[i]),  # we don't have open here; close-as-open is fine for indicator calc
            'close': float(close[i]),
            'high': float(high[i]),
            'low': float(low[i]),
            'volume': float(volume[i]),
        })
    return out


def record_for_symbol(symbol: str, date_iso: str, ts_iso: str):
    region = region_for(symbol)
    path = ledger_path_for(date_iso)
    if already_predicted_today(path, date_iso, symbol):
        return ('skipped-dup', symbol)

    candles_data = fetch_recent_candles(symbol)
    if candles_data is None:
        return ('skipped-no-data', symbol)
    close, high, low, volume = candles_data
    if len(close) < 30:
        return ('skipped-thin', symbol)

    candles = candles_as_records(close, high, low, volume)
    pred = generate_prediction(candles)
    entry_price = float(close[-1])

    row = {
        'symbol': symbol,
        'region': region,
        'date': date_iso,
        'predictedAt': ts_iso,
        'entry': round(entry_price, 4),
        'signal': pred['signal'],
        'confidence': int(pred['confidence']),
        'indicators': pred.get('indicators') or {},
        'horizons': {str(h): None for h in HORIZONS_DAYS},
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a') as f:
        f.write(json.dumps(row) + '\n')
    return ('ok', symbol)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', required=True, help='Region tag (NYSE, CRYPTO, NSE, LSE, HKEX, TYO, XETRA, ASX)')
    args = ap.parse_args()

    symbols = symbols_for_region(args.region)
    if not symbols:
        print(f'No symbols for region {args.region}')
        return

    now = datetime.datetime.utcnow()
    date_iso = now.strftime('%Y-%m-%d')
    ts_iso = now.strftime('%Y-%m-%dT%H:%M:%SZ')

    print(f"Recording {args.region} predictions for {date_iso} ({len(symbols)} symbols)...")
    counts = {'ok': 0, 'skipped-dup': 0, 'skipped-no-data': 0, 'skipped-thin': 0, 'error': 0}
    for sym in symbols:
        try:
            status, _ = record_for_symbol(sym, date_iso, ts_iso)
            counts[status] = counts.get(status, 0) + 1
        except Exception as e:
            counts['error'] += 1
            print(f'  [warn] {sym}: {e}')

    print(f"Done: {counts}")


if __name__ == '__main__':
    main()
