"""
Resolve outcomes for matured forward windows on every unresolved
ledger row. Multi-horizon: each row is revisited as +1d, +3d, +5d,
+10d, +20d horizons mature, and that horizon's slot in the row's
"horizons" dict is filled in.

Per horizon we record:
  {
    "actualClose":     192.30,    // close on the horizon-end date
    "actualHigh":      193.80,    // best price during the window
    "actualLow":       186.10,    // worst price during the window
    "directionMatch":  true,      // did it go the way the engine said
    "capturedPct":     58,        // % of predicted-direction move captured
                                  //   computed against ATR-derived expected move
    "rangeHit":        "inside"   // inside | beyond_right | below_right | wrong_dir
  }

Idempotent: rewrites the entire JSONL file once with all updates.
Cheap because rows are small and the file rotates yearly.

Usage:
    python record_outcomes.py
"""
import datetime
import json
import os
from collections import defaultdict

import yfinance as yf

from ledger_universe import HORIZONS_DAYS

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')


def ledger_path_for_year(year: int) -> str:
    return os.path.join(LEDGER_DIR, f'{year}.jsonl')


def load_rows(path: str):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def save_rows(path: str, rows):
    with open(path, 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')


def trading_days_passed(prediction_date: str, today: datetime.date) -> int:
    """Approximate trading days between two ISO dates (M-F count)."""
    d0 = datetime.date.fromisoformat(prediction_date)
    if today <= d0:
        return 0
    days = 0
    cur = d0 + datetime.timedelta(days=1)
    while cur <= today:
        if cur.weekday() < 5:  # Mon-Fri
            days += 1
        cur += datetime.timedelta(days=1)
    return days


def fetch_window(symbol: str, start_iso: str, days_needed: int):
    """Pull daily bars from start_iso through today, return (closes, highs, lows)."""
    end = datetime.date.today() + datetime.timedelta(days=1)
    start = datetime.date.fromisoformat(start_iso)
    df = yf.download(symbol, start=start.isoformat(), end=end.isoformat(),
                     interval='1d', progress=False, auto_adjust=False)
    if df.empty:
        return None
    closes = df['Close'].values.tolist() if hasattr(df['Close'], 'values') else []
    highs = df['High'].values.tolist() if hasattr(df['High'], 'values') else []
    lows = df['Low'].values.tolist() if hasattr(df['Low'], 'values') else []
    if isinstance(closes[0] if closes else None, list):
        # MultiIndex case for single ticker — flatten
        closes = [c[0] if isinstance(c, list) else c for c in closes]
        highs = [h[0] if isinstance(h, list) else h for h in highs]
        lows = [l[0] if isinstance(l, list) else l for l in lows]
    return list(closes), list(highs), list(lows)


def resolve_horizon(row: dict, h_days: int, bars):
    """Compute the outcome dict for horizon h_days using fetched bars."""
    if not bars or not bars[0]:
        return None
    closes, highs, lows = bars
    # bars[0] is the prediction-day close (or the next available bar);
    # we want the close at index h_days from the prediction day.
    if len(closes) <= h_days:
        return None  # window not matured

    entry = row['entry']
    actual_close = float(closes[h_days])
    window_high = float(max(highs[1:h_days + 1])) if highs[1:h_days + 1] else None
    window_low = float(min(lows[1:h_days + 1])) if lows[1:h_days + 1] else None

    signal = row['signal']
    move = actual_close - entry
    pct_move = (move / entry) * 100 if entry else 0

    if signal == 'BUY':
        direction_match = move > 0
    elif signal == 'SELL':
        direction_match = move < 0
    else:
        direction_match = abs(pct_move) < 1.0  # NEUTRAL hits when close to flat

    return {
        'actualClose': round(actual_close, 4),
        'actualHigh': round(window_high, 4) if window_high is not None else None,
        'actualLow': round(window_low, 4) if window_low is not None else None,
        'pctMove': round(pct_move, 3),
        'directionMatch': direction_match,
    }


def main():
    import sys
    today = datetime.date.today()
    year = today.year
    path = ledger_path_for_year(year)
    rows = load_rows(path)
    if not rows:
        # Legit no-op on the very first cron of a new year (or fresh repo).
        print(f"No ledger rows for {year} — nothing to resolve.")
        return

    # Cache of fetched bars per symbol so we don't re-download for each horizon.
    bars_cache = {}

    updated = 0
    skipped_immature = 0
    fetched = 0
    errors = 0
    rows_with_unresolved_due = 0

    for row in rows:
        passed = trading_days_passed(row['date'], today)
        unresolved_horizons = [h for h in HORIZONS_DAYS if row['horizons'].get(str(h)) is None and passed >= h]
        if not unresolved_horizons:
            if any(row['horizons'].get(str(h)) is None for h in HORIZONS_DAYS):
                skipped_immature += 1
            continue
        rows_with_unresolved_due += 1

        sym = row['symbol']
        if sym not in bars_cache:
            try:
                bars_cache[sym] = fetch_window(sym, row['date'], max(unresolved_horizons) + 2)
                fetched += 1
            except Exception as e:
                bars_cache[sym] = None
                errors += 1
                print(f'  [warn] fetch {sym}: {e}')

        bars = bars_cache.get(sym)
        if not bars:
            continue

        for h in unresolved_horizons:
            outcome = resolve_horizon(row, h, bars)
            if outcome is None:
                continue
            row['horizons'][str(h)] = outcome
            updated += 1

    save_rows(path, rows)
    print(f"Resolved horizons: {updated}, fetched: {fetched}, immature: {skipped_immature}, errors: {errors}")
    print(f"Rows considered for resolution: {rows_with_unresolved_due} (of {len(rows)} total in {year}.jsonl)")

    # Hard-fail when we had work to do (mature horizons due) but resolved
    # zero AND most fetches failed — that's yfinance being down across the
    # board, not a legit no-op.
    if rows_with_unresolved_due > 0 and updated == 0 and errors > 0:
        ratio = errors / rows_with_unresolved_due
        if ratio > 0.5:
            print(f'\nERROR: {errors} fetch errors out of {rows_with_unresolved_due} rows due for resolution. Likely yfinance unavailable.', file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
