"""Daily prediction scorecard, with the full timeline for every row.

Answers, for a given trading day:
  * did the analysis run, and on how many stocks
  * how many price predictions were made
  * WHEN the price was locked, and WHAT price was locked
  * the predicted High and Low
  * the actual Open / High / Low / Close
  * HIT or NOT HIT, and whether the HIGH, the LOW, or BOTH was hit
  * WHEN during the session the hit happened (from 5-minute bars)
  * the signal and confidence behind it

On timing: this architecture locks and predicts in ONE step. The cron reads the
price, scores it, and writes the row in a single pass, so "price locked",
"analysis done" and "prediction made" are the same instant, recorded as
predictedAt. Presenting them as three columns would imply a pipeline that does
not exist.

"Hit" means price REACHED the predicted level during the session:
    hit high = actual day high >= predicted high
    hit low  = actual day low  <= predicted low

REACH and CONTAINMENT are both reported because they are near complements. A
range built to contain price 80% of the time shows NOT HIT on about 80% of rows,
which is it working. Showing only one column misleads either way.

ANCHOR flag: the locked price is an intraday snapshot taken minutes after the
open, so it usually matches no daily OHLC bar. That is fine. What is NOT fine is
a locked price that falls outside the session's own range, which means the anchor
was stale and the forecast was built around a price the stock had already left.
Those rows are flagged STALE.

Usage:
    python tools/daily_report.py --date 2026-08-24
    python tools/daily_report.py --date 2026-08-24 --symbols CAN,CRBP,NVAX,V,AVB
    python tools/daily_report.py --date 2026-08-24 --limit 25 --hit-times
    python tools/daily_report.py --date 2026-08-24 --csv out.csv
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


def _get(url, timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.load(r)


def load_day(date_iso):
    path = os.path.join(LEDGER, f'{date_iso[:4]}.jsonl')
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
    path = os.path.join(LEDGER, f'{datetime.datetime.now(datetime.UTC).year}.jsonl')
    seen = set()
    if not os.path.exists(path):
        return []
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


def daily_bars(symbol, around_iso):
    d = datetime.date.fromisoformat(around_iso)
    p1 = int(datetime.datetime.combine(d - datetime.timedelta(days=25), datetime.time()).timestamp())
    j = _get(f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
             f'?period1={p1}&period2={int(time.time())}&interval=1d')
    res = j['chart']['result'][0]
    q = res['indicators']['quote'][0]
    out = []
    for t, o, c, h, l in zip(res['timestamp'], q['open'], q['close'], q['high'], q['low']):
        if None in (o, c, h, l) or any(math.isnan(x) for x in (o, c, h, l)):
            continue
        if h < l or l <= 0:
            continue
        out.append({'date': datetime.datetime.fromtimestamp(t, datetime.UTC).date().isoformat(),
                    'open': o, 'high': h, 'low': l, 'close': c})
    return out


def intraday_bars(symbol, date_iso):
    """Intraday bars for one session, finest granularity available.

    1-minute first (Yahoo retains ~30 days), falling back to 5-minute (~60 days).
    Returns (bars, interval) where bars is [(datetime, high, low), ...].
    """
    d = datetime.date.fromisoformat(date_iso)
    p1 = int(datetime.datetime.combine(d, datetime.time()).timestamp()) - 86400
    p2 = p1 + 86400 * 3
    for iv in ('1m', '5m'):
        try:
            j = _get(f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
                     f'?period1={p1}&period2={p2}&interval={iv}')
            res = j['chart']['result'][0]
            q = res['indicators']['quote'][0]
        except Exception:
            continue
        # Yahoo OMITS 'timestamp' entirely (rather than returning an empty list)
        # when it has no intraday data for the window. Treat as unavailable, never
        # as an error that kills the row.
        stamps = res.get('timestamp')
        if not stamps or not isinstance(q, dict) or not q.get('high') or not q.get('low'):
            continue
        out = []
        for t, h, l in zip(stamps, q['high'], q['low']):
            if h is None or l is None or math.isnan(h) or math.isnan(l):
                continue
            ts = datetime.datetime.fromtimestamp(t, datetime.UTC)
            if ts.date().isoformat() != date_iso:
                continue
            out.append((ts, h, l))
        if out:
            return out, iv
    return None, None


def touch_detail(bars, pred_high, pred_low, lock_dt):
    """When each predicted level was first touched, and whether that was valid.

    A touch BEFORE the lock timestamp cannot count: the prediction did not exist
    yet. The US cron locks ~52 minutes after the 13:30 open, and on 2026-08-24
    11.1% of NYSE rows were being credited for a move that had already happened.
    Both are returned so the distinction is visible rather than silently applied.
    """
    res = {'hiAt': None, 'loAt': None, 'hiPre': False, 'loPre': False,
           'hiAtPost': None, 'loAtPost': None}
    for ts, h, l in bars:
        if res['hiAt'] is None and h >= pred_high:
            res['hiAt'] = ts
            res['hiPre'] = lock_dt is not None and ts < lock_dt
        if res['loAt'] is None and l <= pred_low:
            res['loAt'] = ts
            res['loPre'] = lock_dt is not None and ts < lock_dt
        if lock_dt is not None and ts >= lock_dt:
            if res['hiAtPost'] is None and h >= pred_high:
                res['hiAtPost'] = ts
            if res['loAtPost'] is None and l <= pred_low:
                res['loAtPost'] = ts
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date')
    ap.add_argument('--limit', type=int, default=25, help='rows to print (0 = all)')
    ap.add_argument('--symbols', help='comma-separated symbols to show')
    ap.add_argument('--hit-times', action='store_true',
                    help='look up the 5-minute bar where each level was touched')
    ap.add_argument('--csv')
    args = ap.parse_args()

    dates = available_dates()
    if not dates:
        print('No ledger data found.', file=sys.stderr)
        sys.exit(1)
    date_iso = args.date or (dates[-2] if len(dates) > 1 else dates[-1])

    rows = load_day(date_iso)
    if not rows:
        print(f'No rows for {date_iso}. Available: {dates[-6:]}', file=sys.stderr)
        sys.exit(1)

    only = {s.strip().upper() for s in args.symbols.split(',')} if args.symbols else None
    cand = [r for r in rows
            if r.get('priceTargets')
            and isinstance(r['priceTargets'].get('predictedHigh'), (int, float))
            and isinstance(r['priceTargets'].get('predictedLow'), (int, float))
            and isinstance(r.get('entry'), (int, float))
            and (only is None or str(r.get('symbol')).upper() in only)]

    print(f'\nDAILY PREDICTION SCORECARD — {date_iso}')
    print('=' * 100)
    print(f'  Analysis ran            : YES, {len(rows):,} rows written')
    print(f'  Stocks/cryptos analysed : {len({r["symbol"] for r in rows}):,} '
          f'across {len({r.get("region") for r in rows})} regions')
    sig = collections.Counter(r.get('signal') for r in rows)
    print(f'  Calls issued            : BUY {sig.get("BUY",0)}, SELL {sig.get("SELL",0)}, '
          f'NEUTRAL {sig.get("NEUTRAL",0)}, NO_TRADE {sig.get("NO_TRADE",0)} (abstained)')
    print(f'  Price predictions made  : {len(cand):,}')
    print('  Note: price locked, analysis run and prediction written are ONE step in')
    print('        this architecture, recorded as predictedAt. All times are UTC.')

    out, st = [], collections.Counter()
    want_times = args.hit_times or bool(only)
    for i, r in enumerate(cand):
        sym = r['symbol']
        pt = r['priceTargets']
        ph, pl = float(pt['predictedHigh']), float(pt['predictedLow'])
        if not (ph > 0 and pl > 0):
            st['bad target'] += 1
            continue
        try:
            b = daily_bars(sym, date_iso)
        except Exception:
            st['price data unavailable'] += 1
            continue
        day = next((x for x in b if x['date'] == date_iso), None)
        if not day:
            st['no bar for that date'] += 1
            continue
        e = float(r['entry'])
        hh, hl = day['high'] >= ph, day['low'] <= pl
        which = 'BOTH' if hh and hl else 'HIGH' if hh else 'LOW' if hl else '-'
        stale = not (day['low'] <= e <= day['high'])
        lock_dt = None
        if r.get('predictedAt'):
            try:
                lock_dt = datetime.datetime.fromisoformat(
                    r['predictedAt'].replace('Z', '+00:00'))
            except Exception:
                lock_dt = None
        th = tl = ''
        iv = ''
        vh = vl = None
        if want_times and (hh or hl) and (args.limit == 0 or len(out) < args.limit):
            bars, iv = intraday_bars(sym, date_iso)
            if bars:
                td = touch_detail(bars, ph, pl, lock_dt)
                # '*' marks a touch that happened BEFORE the prediction existed.
                if td['hiAt']:
                    th = td['hiAt'].strftime('%H:%M') + ('*' if td['hiPre'] else '')
                if td['loAt']:
                    tl = td['loAt'].strftime('%H:%M') + ('*' if td['loPre'] else '')
                vh = td['hiAtPost'] is not None
                vl = td['loAtPost'] is not None
            time.sleep(0.25)
        # VALID = at least one level touched at or after the lock timestamp.
        valid = None
        if vh is not None or vl is not None:
            valid = bool(vh) or bool(vl)
            st['valid post-lock hit' if valid else 'hit was PRE-LOCK only'] += 1
        out.append({
            'symbol': sym, 'region': r.get('region'), 'signal': r.get('signal'),
            'confidence': r.get('confidence'),
            'lockedAtUTC': (r.get('predictedAt') or '')[11:19],
            'lockedPrice': e,
            'predictedLow': pl, 'predictedHigh': ph,
            'dayOpen': day['open'], 'dayHigh': day['high'],
            'dayLow': day['low'], 'dayClose': day['close'],
            'hit': 'HIT' if (hh or hl) else 'NOT HIT', 'which': which,
            'hitHighAt': th, 'hitLowAt': tl,
            'barInterval': iv,
            'validPostLock': '' if valid is None else ('YES' if valid else 'NO (pre-lock)'),
            'range': 'INSIDE' if not (hh or hl) else 'BROKE OUT',
            'anchor': 'STALE' if stale else 'ok',
        })
        st['scored'] += 1
        st['HIT' if (hh or hl) else 'NOT HIT'] += 1
        if which != '-':
            st['which:' + which] += 1
        if stale:
            st['stale anchor'] += 1
        time.sleep(0.4 if i % 20 == 0 else 0.16)

    n = st['scored']
    if not n:
        print('\n  Nothing scored: ' + str(dict(st)))
        sys.exit(0)
    print(f'\n  Scored                  : {n:,} of {len(cand):,}')
    for k in ('price data unavailable', 'no bar for that date', 'bad target'):
        if st[k]:
            print(f'    excluded, {k}: {st[k]}')
    print(f'\n  HIT      {st["HIT"]:>5} ({100*st["HIT"]/n:>5.1f}%)   '
          f'HIGH {st["which:HIGH"]}, LOW {st["which:LOW"]}, BOTH {st["which:BOTH"]}')
    print(f'  NOT HIT  {st["NOT HIT"]:>5} ({100*st["NOT HIT"]/n:>5.1f}%)   '
          f'= price stayed inside the predicted range')
    if st['stale anchor']:
        print(f'  STALE ANCHOR {st["stale anchor"]:>4} ({100*st["stale anchor"]/n:>4.1f}%)  '
              f'locked price fell OUTSIDE the session range, so the forecast was')
        print(f'{"":>16}built around a price the stock had already left')

    order = {'BOTH': 0, 'HIGH': 1, 'LOW': 2, '-': 3}
    out.sort(key=lambda x: (order[x['which']], x['symbol']))
    show = out if args.limit == 0 else out[:args.limit]

    cols = [('SYMBOL', 'symbol', 9, 's'), ('CALL', 'signal', 5, 's'),
            ('CONF', 'confidence', 5, 'n0'), ('LOCKED@', 'lockedAtUTC', 9, 's'),
            ('LOCKED', 'lockedPrice', 10, 'p'), ('PRED LOW', 'predictedLow', 10, 'p'),
            ('PRED HIGH', 'predictedHigh', 10, 'p'), ('DAY OPEN', 'dayOpen', 10, 'p'),
            ('DAY HIGH', 'dayHigh', 10, 'p'), ('DAY LOW', 'dayLow', 10, 'p'),
            ('DAY CLOSE', 'dayClose', 10, 'p'), ('HIT?', 'hit', 9, 's'),
            ('WHICH', 'which', 7, 's'), ('HIGH HIT@', 'hitHighAt', 11, 's'),
            ('LOW HIT@', 'hitLowAt', 10, 's'),
            ('COUNTS?', 'validPostLock', 15, 's'),
            ('ANCHOR', 'anchor', 8, 's')]
    print(f'\n  PER-STOCK DETAIL ({len(show)} of {len(out)})')
    print('  ' + ''.join(f'{h:>{w}}' for h, _, w, _ in cols))
    print('  ' + '-' * sum(w for _, _, w, _ in cols))
    for x in show:
        cells = []
        dp = 4 if (x['predictedHigh'] or 1) < 1 else 2
        for _, key, w, kind in cols:
            v = x.get(key)
            if kind == 'p' and isinstance(v, (int, float)):
                cells.append(f'{v:>{w}.{dp}f}')
            elif kind == 'n0' and isinstance(v, (int, float)):
                cells.append(f'{v:>{w}.0f}')
            else:
                cells.append(f'{str(v)[:w]:>{w}}')
        print('  ' + ''.join(cells))
    if not want_times:
        print('\n  (HI@ / LO@ are blank: pass --hit-times for 5-minute touch times)')

    if args.csv:
        with open(args.csv, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
            w.writeheader()
            w.writerows(out)
        print(f'\n  Full table written to {args.csv} ({len(out)} rows)')


if __name__ == '__main__':
    main()
