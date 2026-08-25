"""Daily prediction scorecard: what was predicted, and did it hit?

Answers, for a given trading day, exactly these questions:

  * did the analysis run, and on how many stocks
  * how many price predictions were made
  * per stock: the predicted High and Low, the actual High and Low
  * HIT or NOT HIT
  * if hit, was it the predicted HIGH, the predicted LOW, or BOTH

"Hit" means price REACHED the predicted level during the day:

    hit high  =  actual day high >= predicted high
    hit low   =  actual day low  <= predicted low

Both framings are reported side by side, because they answer different questions
and only showing one is how a scorecard misleads:

  REACH       did price touch the predicted edge (this is "Hit")
  CONTAINED   did price stay entirely inside the predicted range

They are near-complements. A band designed to contain price 80% of the time will
show "Not Hit" on roughly 80% of rows, and that is the band working correctly,
not failing. Reading only the Hit column would make a well-calibrated forecast
look broken.

Usage:
    python tools/daily_report.py                 # most recent complete day
    python tools/daily_report.py --date 2026-08-24
    python tools/daily_report.py --date 2026-08-24 --limit 40
    python tools/daily_report.py --csv out.csv
"""
import argparse
import collections
import csv
import datetime
import json
import math
import os
import sys
import time
import urllib.request

UA = {'User-Agent': 'Mozilla/5.0 (compatible; Market-Analysis daily report)'}
LEDGER = os.path.join('model', 'ledger')


def load_day(date_iso):
    year = date_iso[:4]
    path = os.path.join(LEDGER, f'{year}.jsonl')
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('date') == date_iso:
                out.append(r)
    return out


def available_dates():
    year = datetime.datetime.now(datetime.UTC).year
    path = os.path.join(LEDGER, f'{year}.jsonl')
    seen = set()
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line).get('date')
                except Exception:
                    continue
                if d:
                    seen.add(d)
    return sorted(seen)


def bars(symbol, around_iso):
    """Daily OHLC either side of the target date."""
    d = datetime.date.fromisoformat(around_iso)
    p1 = int(datetime.datetime.combine(d - datetime.timedelta(days=25),
                                       datetime.time()).timestamp())
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
           f'?period1={p1}&period2={int(time.time())}&interval=1d')
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
        j = json.load(r)
    res = j['chart']['result'][0]
    q = res['indicators']['quote'][0]
    out = []
    for t, c, h, l in zip(res['timestamp'], q['close'], q['high'], q['low']):
        if not (c and h and l):
            continue
        if math.isnan(c) or math.isnan(h) or math.isnan(l):
            continue
        if h < l or l <= 0:
            continue
        out.append((datetime.datetime.fromtimestamp(t, datetime.UTC).date().isoformat(), c, h, l))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', help='trading day to score (default: most recent with data)')
    ap.add_argument('--limit', type=int, default=30, help='rows to print (0 = all)')
    ap.add_argument('--csv', help='also write the full table to this CSV path')
    args = ap.parse_args()

    dates = available_dates()
    if not dates:
        print('No ledger data found.', file=sys.stderr)
        sys.exit(1)
    date_iso = args.date or dates[-2] if len(dates) > 1 and not args.date else (args.date or dates[-1])

    rows = load_day(date_iso)
    if not rows:
        print(f'No rows for {date_iso}. Available: {dates[-6:]}', file=sys.stderr)
        sys.exit(1)

    with_targets = [r for r in rows
                    if r.get('priceTargets')
                    and isinstance(r['priceTargets'].get('predictedHigh'), (int, float))
                    and isinstance(r['priceTargets'].get('predictedLow'), (int, float))]

    print(f'\nDAILY PREDICTION SCORECARD — {date_iso}')
    print('=' * 78)
    print(f'  Analysis ran            : YES, {len(rows):,} rows written')
    print(f'  Stocks/cryptos analysed : {len({r["symbol"] for r in rows}):,}')
    print(f'  Regions covered         : {len({r.get("region") for r in rows})} '
          f'({", ".join(sorted({str(r.get("region")) for r in rows}))})')
    sig = collections.Counter(r.get('signal') for r in rows)
    print(f'  Calls issued            : BUY {sig.get("BUY",0)}, SELL {sig.get("SELL",0)}, '
          f'NEUTRAL {sig.get("NEUTRAL",0)}, NO_TRADE {sig.get("NO_TRADE",0)} (abstained)')
    print(f'  PRICE PREDICTIONS MADE  : {len(with_targets):,}  '
          f'(rows carrying a predicted High and Low)')

    results = []
    stats = collections.Counter()
    for i, r in enumerate(with_targets):
        sym = r['symbol']
        pt = r['priceTargets']
        try:
            b = bars(sym, date_iso)
        except Exception:
            stats['price data unavailable'] += 1
            continue
        idx = {d: k for k, (d, _, _, _) in enumerate(b)}
        k = idx.get(date_iso)
        if k is None:
            stats['no bar for that date'] += 1
            continue
        _, aclose, ahigh, alow = b[k]
        ph, pl = float(pt['predictedHigh']), float(pt['predictedLow'])
        if not (ph > 0 and pl > 0):
            stats['bad target'] += 1
            continue
        hit_high = ahigh >= ph
        hit_low = alow <= pl
        contained = (ahigh <= ph) and (alow >= pl)
        which = ('BOTH' if hit_high and hit_low
                 else 'HIGH' if hit_high else 'LOW' if hit_low else '-')
        results.append({
            'symbol': sym, 'region': r.get('region'), 'signal': r.get('signal'),
            'confidence': r.get('confidence'),
            'predictedLow': pl, 'predictedHigh': ph,
            'actualLow': alow, 'actualHigh': ahigh, 'actualClose': aclose,
            'hit': 'HIT' if (hit_high or hit_low) else 'NOT HIT',
            'which': which,
            'contained': 'INSIDE' if contained else 'BROKE OUT',
        })
        stats['scored'] += 1
        stats['HIT' if (hit_high or hit_low) else 'NOT HIT'] += 1
        if which != '-':
            stats['which:' + which] += 1
        stats['contained' if contained else 'broke out'] += 1
        time.sleep(0.45 if i % 20 == 0 else 0.18)

    n = stats['scored']
    if not n:
        print('\n  Nothing could be scored. ' + str(dict(stats)))
        sys.exit(0)

    print(f'  Scored                  : {n:,} of {len(with_targets):,}')
    for k in ('price data unavailable', 'no bar for that date', 'bad target'):
        if stats[k]:
            print(f'    excluded, {k}: {stats[k]}')

    print('\n  REACH — did price touch a predicted edge?')
    print(f'    HIT      {stats["HIT"]:>5}  ({100*stats["HIT"]/n:>5.1f}%)   '
          f'of which HIGH {stats["which:HIGH"]}, LOW {stats["which:LOW"]}, BOTH {stats["which:BOTH"]}')
    print(f'    NOT HIT  {stats["NOT HIT"]:>5}  ({100*stats["NOT HIT"]/n:>5.1f}%)')
    print('\n  CONTAINMENT — did price stay inside the predicted range?')
    print(f'    INSIDE     {stats["contained"]:>5}  ({100*stats["contained"]/n:>5.1f}%)')
    print(f'    BROKE OUT  {stats["broke out"]:>5}  ({100*stats["broke out"]/n:>5.1f}%)')
    print('\n  Note: these are near-complements. A range built to contain price 80% of')
    print('  the time will show NOT HIT on about 80% of rows. That is it working.')

    order = {'BOTH': 0, 'HIGH': 1, 'LOW': 2, '-': 3}
    results.sort(key=lambda x: (order[x['which']], x['symbol']))
    show = results if args.limit == 0 else results[:args.limit]
    print(f'\n  PER-STOCK DETAIL ({len(show)} of {len(results)} rows)')
    hdr = (f"  {'SYMBOL':<11}{'CALL':<6}{'CONF':>5}{'PRED LOW':>12}{'PRED HIGH':>12}"
           f"{'ACT LOW':>12}{'ACT HIGH':>12}{'HIT?':>9}{'WHICH':>7}{'RANGE':>11}")
    print(hdr)
    print('  ' + '-' * (len(hdr) - 2))
    for x in show:
        dp = 4 if x['predictedHigh'] < 1 else 2
        print(f"  {x['symbol']:<11}{str(x['signal'])[:5]:<6}"
              f"{(f'{x['confidence']:.0f}' if isinstance(x['confidence'],(int,float)) else '-'):>5}"
              f"{x['predictedLow']:>12.{dp}f}{x['predictedHigh']:>12.{dp}f}"
              f"{x['actualLow']:>12.{dp}f}{x['actualHigh']:>12.{dp}f}"
              f"{x['hit']:>9}{x['which']:>7}{x['contained']:>11}")

    if args.csv:
        with open(args.csv, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=list(results[0].keys()))
            w.writeheader()
            w.writerows(results)
        print(f'\n  Full table written to {args.csv} ({len(results)} rows)')


if __name__ == '__main__':
    main()
