"""Publish upcoming earnings announcements for every stock the ledger predicts on.

Writes model/earnings.json, read by record_predictions.py (so the band the cron LOCKS is
earnings-aware) and by the browser (so the live band agrees with it). See earnings_calendar.py
for why the band needs it and how an announcement becomes a band day.

Format
------
    {"generatedAt": "...", "source": "...", "horizonDays": 45,
     "symbols": {"AAPL": [1793304000], "KO": [], ...}}

An EMPTY list is a real answer ("asked, nothing scheduled"), which lets the band use its
ordinary-week z. A symbol that is ABSENT was not answered, and the band keeps the pooled z it
always used. Never write an empty list for a failed lookup: that would turn "we do not know"
into "there is nothing", the one mistake this file must not make.

Run: python tools/write_earnings_slice.py [--workers 6]
"""
import argparse
import datetime
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import yfinance as yf  # noqa: E402

from ledger_universe import symbols_for_region  # noqa: E402

OUT = os.path.join(REPO, 'model', 'earnings.json')
STOCK_REGIONS = ['NYSE', 'LSE', 'XETRA', 'NSE', 'HKEX', 'TYO', 'ASX']
HORIZON_DAYS = 45       # the band spans 7 sessions, the slack covers a slice that is a few days old


def upcoming(sym, now):
    """Upcoming announcement epochs, or None when the lookup itself failed."""
    for attempt in range(2):
        try:
            df = yf.Ticker(sym).get_earnings_dates(limit=12)
            if df is None:
                return []
            out = []
            for ts in df.index:
                try:
                    t = int(ts.timestamp())
                except Exception:
                    continue
                if now - 86400 <= t <= now + HORIZON_DAYS * 86400:
                    out.append(t)
            return sorted(set(out))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()

    symbols = []
    for reg in STOCK_REGIONS:
        try:
            symbols.extend(symbols_for_region(reg))
        except Exception as e:
            print(f'  [warn] {reg}: {e}', file=sys.stderr)
    # The NYSE run also predicts the day's dynamic penny movers; include them when reachable.
    try:
        from penny_dynamic import fetch_dynamic_symbols
        symbols.extend(fetch_dynamic_symbols())
    except Exception as e:
        print(f'  [warn] dynamic pennies: {type(e).__name__}', file=sys.stderr)
    symbols = sorted({s for s in symbols if s and not s.endswith('-USD')})

    now = int(time.time())
    result, failed = {}, []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = {ex.submit(upcoming, s, now): s for s in symbols}
        for i, f in enumerate(as_completed(futs), 1):
            s = futs[f]
            v = f.result()
            if v is None:
                failed.append(s)
            else:
                result[s] = v
            if i % 100 == 0:
                print(f'  {i}/{len(symbols)} ({time.time() - t0:.0f}s)', file=sys.stderr)

    # The parallel pass trips Yahoo's rate limit for a share of symbols (161 of 611 US names on
    # 2026-09-30, NVDA and TSLA among them), and a failed lookup is "unknown", which costs the band
    # and the volatility forecast their earnings adjustment. Retry those slowly, one at a time.
    retry = failed
    failed = []
    for s in retry:
        time.sleep(0.8)
        v = upcoming(s, now)
        if v is None:
            failed.append(s)
        else:
            result[s] = v
    # Still failing: last night's dates for the symbol remain true if they are still ahead.
    carried = 0
    try:
        with open(OUT, encoding='utf-8') as f:
            prev = json.load(f).get('symbols') or {}
        for s in failed:
            if s in prev and isinstance(prev[s], list):
                result[s] = [t for t in prev[s] if t >= now - 86400]
                carried += 1
    except (OSError, ValueError):
        pass
    print(f'  retried {len(retry)} slowly: {len(retry) - len(failed)} answered; {carried} carried from the last slice',
          file=sys.stderr)
    with_dates = sum(1 for v in result.values() if v)
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'yfinance get_earnings_dates (Yahoo earnings calendar)',
        'horizonDays': HORIZON_DAYS,
        'symbols': dict(sorted(result.items())),
    }
    # Refuse to publish a slice that is mostly failures: a blank file would read as
    # "nothing scheduled anywhere" to anyone who forgot the absent-vs-empty rule.
    if len(result) < 0.5 * len(symbols):
        print(f'ERROR: only {len(result)}/{len(symbols)} lookups answered, not publishing.', file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)
    print(f'Wrote {OUT}: {len(result)} symbols answered ({with_dates} with an announcement in the '
          f'next {HORIZON_DAYS} days), {len(failed)} unanswered, {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
