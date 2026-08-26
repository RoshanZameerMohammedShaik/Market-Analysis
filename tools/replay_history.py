"""Replay the LIVE engine over years of historical bars and emit a per-prediction panel.

WHY THIS EXISTS
---------------
I told Roshan the top-K result needed "6 more months of ledger" to reach
significance. That was wrong, and he was right to push back. The ledger only holds
3 months because the cron started 3 months ago, but the BARS go back decades and
they are free. Replaying the engine over history gives the same independent
observations today.

backtest.py already replays 1,036,095 predictions across 837 symbols, but it keeps
only aggregates (hit rates, calibration buckets). Cross-sectional work needs the
per-prediction rows: date, symbol, the continuous score, and forward returns at each
horizon. That is what this writes.

Output: model/replay_panel.jsonl, one row per (symbol, date):
    {"d": "2019-03-14", "s": "AAPL", "sc": 61.5, "p": 45.2,
     "r": {"1": 0.42, "3": -1.10, "5": 2.03, "10": 4.4, "20": 6.1}}

NO LOOKAHEAD
------------
generate_prediction() is called with bars[i-49 .. i] only. Forward returns come from
close[i+h] and are never visible to the scorer. This mirrors the existing replay loop
in backtest.py, which is already careful about it.

THREE BIASES THIS CANNOT FIX, STATED UP FRONT
---------------------------------------------
1. SURVIVORSHIP. The universe is today's symbol list, so companies that delisted are
   absent. Delisting skews to failures, so every return here is optimistic. Hou/Xue/
   Zhang showed microcaps are 60.7% of the stock count and 3.2% of market cap, and
   that trading frictions kill 96% of anomalies under proper weighting. Treat any
   sub-$5 result as unreliable for this reason alone.
2. TUNING CONTAMINATION. The engine's mean-reversion tilt (commit 2aa8d01,
   2026-06-06) was fitted against 2026 ledger outcomes that were themselves
   mis-graded. Any window including 2026 is partly in-sample for the engine. Use
   --until 2026-01-01 for a genuinely clean read, which is why that flag exists.
3. NO INTRADAY. Entry is the close of bar i, not the price the cron actually locks
   minutes after the open. Real fills differ.

Usage:
    python tools/replay_history.py --years 12                # build the panel
    python tools/replay_history.py --years 12 --limit 200     # faster smoke run
    python tools/replay_history.py --until 2026-01-01         # pre-tuning window
"""
import argparse
import datetime
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from backtest import generate_prediction          # noqa: E402
from ledger_universe import symbols_for_region     # noqa: E402

CACHE = os.path.join(REPO, 'model', '_bars_cache')
PANEL = os.path.join(REPO, 'model', 'replay_panel.jsonl')
HORIZONS = (1, 3, 5, 10, 20)
UA = {'User-Agent': 'Mozilla/5.0 (compatible; market-analysis-replay/1.0)'}
WARMUP = 50          # bars generate_prediction needs; matches backtest.py's loop


def fetch_bars(symbol, years, retries=3):
    """Daily bars from Yahoo, cached on disk so re-runs cost nothing.

    auto-adjusted closes: splits and dividends are already applied, which is what
    keeps a 4-for-1 split from looking like a -75% day. The resolver has a separate
    corporate-action guard for the live path; here adjustment is the cleaner fix.
    """
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{symbol.replace("/", "_")}_{years}y.json')
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass

    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
           f'?range={years}y&interval=1d&events=div%2Csplit')
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.load(r)
            res = (j.get('chart') or {}).get('result')
            if not res:
                return None
            res = res[0]
            q = (res.get('indicators') or {}).get('quote')
            adj = (res.get('indicators') or {}).get('adjclose')
            stamps = res.get('timestamp')
            if not q or not stamps:
                return None
            q = q[0]
            # Prefer adjusted close; fall back to raw when Yahoo omits it.
            adjclose = (adj[0].get('adjclose') if adj else None) or q.get('close')
            out = {'d': [], 'c': [], 'h': [], 'l': [], 'v': []}
            for t, o_c, hh, ll, vv, ac in zip(stamps, q.get('close') or [],
                                              q.get('high') or [], q.get('low') or [],
                                              q.get('volume') or [], adjclose or []):
                if None in (o_c, hh, ll, ac):
                    continue
                if any(isinstance(x, float) and math.isnan(x) for x in (o_c, hh, ll, ac)):
                    continue
                if not (ac > 0 and hh >= ll > 0 and o_c > 0):
                    continue
                # Scale high/low by the same factor the close was adjusted by, so the
                # bar stays internally consistent (ATR and Bollinger read all three).
                f = ac / o_c
                out['d'].append(datetime.datetime.fromtimestamp(t, datetime.UTC)
                                .date().isoformat())
                out['c'].append(ac)
                out['h'].append(hh * f)
                out['l'].append(ll * f)
                out['v'].append(vv or 0)
            if len(out['d']) < WARMUP + max(HORIZONS) + 10:
                return None
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(out, f)
            return out
        except urllib.error.HTTPError as e:
            if e.code in (404, 400):
                return None
            time.sleep(1.5 * (attempt + 1))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def replay_symbol(symbol, bars, until=None, step=1):
    """Per-prediction rows for one symbol. No lookahead: the scorer sees bars[i-49..i]."""
    d, c, h, l, v = bars['d'], bars['c'], bars['h'], bars['l'], bars['v']
    n = len(c)
    maxh = max(HORIZONS)
    rows = []
    for i in range(WARMUP, n - maxh, step):
        if until and d[i] >= until:
            break
        lo = i - (WARMUP - 1)
        candles = [{'open': c[k], 'close': c[k], 'high': h[k], 'low': l[k],
                    'volume': v[k]} for k in range(lo, i + 1)]
        try:
            pred = generate_prediction(candles)
        except Exception:
            continue
        if not pred:
            continue
        score = pred.get('weightedScore')
        if not isinstance(score, (int, float)):
            continue
        entry = c[i]
        if not (entry > 0):
            continue
        rets = {}
        for hz in HORIZONS:
            fwd = c[i + hz]
            if fwd > 0:
                rets[str(hz)] = (fwd - entry) / entry * 100.0
        if not rets:
            continue
        rows.append({'d': d[i], 's': symbol, 'sc': round(float(score), 3),
                     'p': round(float(entry), 6),
                     'sig': pred.get('signal'),
                     'cf': pred.get('confidence'),
                     'r': {k: round(x, 4) for k, x in rets.items()}})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--years', type=int, default=12)
    ap.add_argument('--region', default='NYSE')
    ap.add_argument('--limit', type=int, default=0, help='cap symbols (smoke runs)')
    ap.add_argument('--until', help='stop before this ISO date (clean out-of-sample)')
    ap.add_argument('--step', type=int, default=1,
                    help='sample every Nth bar; 1 = every trading day')
    ap.add_argument('--out', default=PANEL)
    args = ap.parse_args()

    symbols = symbols_for_region(args.region)
    if args.limit:
        symbols = symbols[:args.limit]
    print(f'Replaying {len(symbols)} {args.region} symbols over {args.years}y'
          + (f', stopping before {args.until}' if args.until else ''))
    print(f'  warmup {WARMUP} bars, horizons {HORIZONS}, step {args.step}')
    print(f'  bars cached in {os.path.relpath(CACHE, REPO)} so re-runs are free')

    t0 = time.time()
    written = fetched = skipped = 0
    with open(args.out, 'w', encoding='utf-8') as out:
        for idx, sym in enumerate(symbols, 1):
            bars = fetch_bars(sym, args.years)
            if not bars:
                skipped += 1
                continue
            fetched += 1
            rows = replay_symbol(sym, bars, args.until, args.step)
            for r in rows:
                # allow_nan=False: a bare NaN is invalid JSON and would break every
                # consumer silently, which already happened once on 650 ledger rows.
                out.write(json.dumps(r, allow_nan=False) + '\n')
            written += len(rows)
            if idx % 25 == 0 or idx == len(symbols):
                el = time.time() - t0
                print(f'  [{idx}/{len(symbols)}] {written:,} rows  '
                      f'{fetched} fetched  {skipped} skipped  {el:.0f}s')

    print(f'\nWrote {written:,} predictions to {os.path.relpath(args.out, REPO)}')
    print(f'  {fetched} symbols usable, {skipped} unavailable')
    if written:
        size = os.path.getsize(args.out) / 1024 / 1024
        print(f'  {size:.1f} MB')
    print('\n  BIASES: survivorship (today\'s symbol list), engine tuning '
          'contamination in 2026,')
    print('  and close-to-close entries rather than the cron\'s post-open lock. '
          'See the module docstring.')


if __name__ == '__main__':
    main()
