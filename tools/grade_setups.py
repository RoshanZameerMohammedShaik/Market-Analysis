"""Grade every published pullback setup against what actually happened: model/setups_record.json.

The backtest says a setup in a given cell recovers ~67% of the time. That number is a cell
average, so every setup in the cell carries it, and it does not move from one night to the next.
An attempt to give each setup its own probability (tools/_exp2/setup_model.py, 52,346 trades,
walk-forward 2017-2026) failed: logistic AUC 0.507 and boosting 0.522 against 0.522 for the
plain cell lookup, and the boosted model's top decile claimed 88% while realizing 68.8%. A
per-setup number would have been noise presented as precision.

What CAN be real and change every day is the record: each confirmed setup, once published,
is graded with the exact rule the app tells people to follow. The record is append-only, written
before the outcome is known, and never re-fit.

The rule, as published: buy at the open of the session after the signal, sell at the open after
the first close above the 5-day average, if that has not happened within 10 sessions, sell at
the open after the 10th. No stop. A trade "recovers" when it exits above its entry, net bps
subtract a 6 bps round trip, as the calibration does.

Run nightly after tools/write_setups_slice.py: python tools/grade_setups.py
Seed from an older publication: python tools/grade_setups.py --setups path/to/setups.json
"""
import datetime
import json
import math
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETUPS = os.path.join(REPO, 'model', 'setups.json')
OUT = os.path.join(REPO, 'model', 'setups_record.json')
HOLD_CAP = 10
COST_BPS = 6.0
BATCH = 80


def wilson(w, n, z=1.96):
    if n == 0:
        return None, None
    p = w / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(c - h, 4), round(c + h, 4)


def grade(e, bars):
    """bars: list of (date, open, close) for the symbol, ascending, unadjusted for dividends so
    the entry and exit are prices someone could actually have traded at."""
    dates = [b[0] for b in bars]
    if e['session'] not in dates:
        return {**e, 'status': 'open', 'note': 'signal session missing from bars'}
    i = dates.index(e['session'])
    closes = [b[2] for b in bars]
    if i + 1 >= len(bars):
        return {**e, 'status': 'pending'}
    entry = bars[i + 1][1]
    j = None
    last = min(i + HOLD_CAP, len(bars) - 1)
    for k in range(i + 1, last + 1):
        if k >= 4 and closes[k] > sum(closes[k - 4:k + 1]) / 5:
            j = k
            break
    out = {**e, 'entryDate': bars[i + 1][0], 'entry': round(entry, 4)}
    if j is None and i + HOLD_CAP >= len(bars):
        # Still inside the 10-session window and the trigger has not fired.
        held = len(bars) - 1 - i
        mark = closes[-1]
        return {**out, 'status': 'open', 'held': held, 'markDate': bars[-1][0], 'mark': round(mark, 4),
                'markPct': round((mark / entry - 1) * 100, 2)}
    if j is None:
        j = i + HOLD_CAP
    if j + 1 >= len(bars):
        return {**out, 'status': 'exiting', 'held': j - i, 'triggerDate': bars[j][0],
                'markPct': round((closes[j] / entry - 1) * 100, 2)}
    px = bars[j + 1][1]
    r = math.log(px / entry)
    return {**out, 'status': 'closed', 'exitDate': bars[j + 1][0], 'exit': round(px, 4), 'held': j - i,
            'timedOut': j == i + HOLD_CAP and not (closes[j] > sum(closes[j - 4:j + 1]) / 5),
            'won': r > 0, 'netBps': round(r * 1e4 - COST_BPS, 1)}


def summarize(rows, key=None):
    closed = [r for r in rows if r['status'] == 'closed']
    w = sum(1 for r in closed if r['won'])
    n = len(closed)
    lo, hi = wilson(w, n)
    return {'n': n, 'wins': w, 'hitRate': round(w / n, 4) if n else None, 'hitLo95': lo, 'hitHi95': hi,
            'netBps': round(sum(r['netBps'] for r in closed) / n, 1) if n else None,
            # What the backtest said these same trades would do, so the two can be compared.
            'expectedHitRate': round(sum(r['hitRate'] for r in closed) / n, 4) if n else None,
            'expectedNetBps': round(sum(r['expNetBps'] for r in closed) / n, 1) if n else None,
            'open': sum(1 for r in rows if r['status'] != 'closed')}


def main():
    import yfinance as yf  # here, so the offline check imports grade() without it

    rec = {'entries': []}
    if os.path.exists(OUT):
        rec = json.load(open(OUT, encoding='utf-8'))
    entries = rec['entries']
    have = {(e['session'], e['symbol']) for e in entries}
    src = sys.argv[sys.argv.index('--setups') + 1] if '--setups' in sys.argv else SETUPS
    pub = json.load(open(src, encoding='utf-8')) if os.path.exists(src) else None
    added = 0
    # Unconfirmed lists (a mid-session manual run) are a forming state, not a publication.
    if pub and pub.get('confirmed') and pub.get('sessionDate'):
        for s in pub['setups']:
            k = (pub['sessionDate'], s['symbol'])
            if k in have:
                continue
            entries.append({'session': pub['sessionDate'], 'symbol': s['symbol'], 'signalClose': s['close'],
                            'tier': s['tier'], 'vixBand': s['vixBand'], 'rsi2': s['rsi2'],
                            'hitRate': s['hitRate'], 'expNetBps': s['netBps'], 'status': 'pending'})
            added += 1

    todo = sorted({e['symbol'] for e in entries if e['status'] != 'closed'})
    bars = {}
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        try:
            df = yf.download(chunk, period='3mo', interval='1d', progress=False, auto_adjust=False,
                             group_by='ticker', threads=True)
        except Exception as e:
            print(f'  [warn] batch {i}: {type(e).__name__}', file=sys.stderr)
            continue
        for s in chunk:
            try:
                sub = (df[s] if len(chunk) > 1 or s in df.columns.get_level_values(0) else df).dropna(subset=['Open', 'Close'])
            except Exception:
                continue
            bars[s] = [(d.strftime('%Y-%m-%d'), float(r.Open), float(r.Close)) for d, r in zip(sub.index, sub.itertuples())]
        time.sleep(1.0)

    # Grade on completed sessions only. A run during market hours would otherwise read a live
    # partial bar as a close and fire (or miss) the trigger on a price that will still change.
    from zoneinfo import ZoneInfo
    ny = datetime.datetime.now(ZoneInfo('America/New_York'))
    today = ny.date().isoformat()
    for s, b in bars.items():
        if b and b[-1][0] == today and ny.hour < 16:
            bars[s] = b[:-1]

    graded = []
    for e in entries:
        if e['status'] == 'closed' or e['symbol'] not in bars:
            graded.append(e)
            continue
        graded.append(grade({k: v for k, v in e.items() if k in (
            'session', 'symbol', 'signalClose', 'tier', 'vixBand', 'rsi2', 'hitRate', 'expNetBps')}, bars[e['symbol']]))
    graded.sort(key=lambda r: (r['session'], r['symbol']))

    cells = {}
    for r in graded:
        cells.setdefault(f"{r['tier']}:{r['vixBand']}", []).append(r)
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'since': graded[0]['session'] if graded else None,
        'rule': 'Buy at the next open. Sell at the open after the first close above the 5-day average, '
                'or after 10 sessions. No stop. Net of 6 bps.',
        'overall': summarize(graded),
        'byCell': {k: summarize(v) for k, v in sorted(cells.items())},
        'entries': graded,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)
    o = payload['overall']
    print(f'Wrote {OUT}: {len(graded)} published setups since {payload["since"]} (+{added} tonight); '
          f'{o["n"]} closed, {o["wins"]} recovered, {o["open"]} still open')


if __name__ == '__main__':
    main()
