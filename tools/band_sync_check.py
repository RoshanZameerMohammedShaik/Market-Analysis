"""Assert js/forecast-band.js and the Python band math agree exactly.

Same rationale as tools/feature_sync_check.py: two implementations of one number
will drift, and the drift is silent. The browser draws the High/Low bands the
user sees, while the cron scores them for calibration. If those two disagree,
the displayed confidence stops describing the displayed band and the app is
quietly lying again, which is the exact failure this whole feature replaced.

Synthetic candles by default so the check is deterministic and needs no network.
Pass --live to additionally diff against real Yahoo bars.

Run: python tools/band_sync_check.py [--live]
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import forecast_band  # noqa: E402
CAL_PATH = os.path.join(REPO, 'model', 'band_calibration.json')
TOL = 0.011          # bands are rounded to 2dp, so anything under ~1 cent is rounding
N_CANDLES = 40


def synth(seed, n=N_CANDLES, base=100.0, drift=0.0, spread=0.02):
    """Deterministic pseudo-random OHLC. A linear congruential generator is used
    rather than `random` so the fixture is identical on every machine and in CI."""
    s = seed
    def nxt():
        nonlocal s
        s = (1103515245 * s + 12345) % (2 ** 31)
        return s / (2 ** 31)
    bars, px = [], base
    for _ in range(n):
        px *= math.exp(drift + (nxt() - 0.5) * spread)
        rng = px * spread * (0.4 + nxt())
        hi, lo = px + rng / 2, max(px - rng / 2, px * 0.5)
        bars.append({'high': round(hi, 6), 'low': round(lo, 6), 'close': round(px, 6)})
    return bars


def py_forecast(cal, candles, price, mode='perDay', earnings_day=None):
    """Delegate to the REAL module. This file used to carry its own copy of the
    band math, which made it a third implementation and therefore a third thing
    to drift: a parity test that reimplements the code under test can pass while
    both sides are wrong together. forecast_band.py is now the only Python band,
    used by the cron and validated here against the JS."""
    return forecast_band.forecast_bands(candles, price, mode=mode, cal=cal,
                                       earnings_day=earnings_day)


def build_fixtures(live=False):
    # Spread across tiers on purpose: a fixture set that only exercises 'calm'
    # would not catch a tier-lookup bug.
    cases = {
        'SYNTH_CALM':   (synth(1, spread=0.010), None),
        'SYNTH_NORMAL': (synth(2, spread=0.022), None),
        'SYNTH_ACTIVE': (synth(3, spread=0.038), None),
        'SYNTH_WILD':   (synth(4, spread=0.070), None),
        'SYNTH_SUB1':   (synth(5, base=0.42, spread=0.05), None),   # exercises 4dp rounding
        # Sub-penny. Under the old flat 4dp both edges rounded to 0.0003, a
        # zero-width band that can only ever score as a hit. This fixture fails
        # if either side reverts to fixed precision.
        'SYNTH_SUBPENNY': (synth(6, base=0.00031, spread=0.05), None),
    }
    payload = {}
    for name, (bars, _) in cases.items():
        payload[name] = {'candles': bars, 'price': bars[-1]['close'], 'crypto': False}
    # EARNINGS FAMILIES. Same bars, three earnings states, so the fixtures cover the pooled z
    # (unknown), the ordinary-week z (0) and the earnings z from a mid-band day (4). Without
    # these the split could drift between the two languages and every check here would still
    # pass, which is exactly the class of silent divergence this file exists to prevent.
    for state in (0, 1, 4):
        bars = synth(2, spread=0.022)
        payload[f'SYNTH_EARN_D{state}'] = {'candles': bars, 'price': bars[-1]['close'],
                                           'crypto': False, 'earningsDay': state}
    if live:
        import datetime, time, urllib.request
        ua = {'User-Agent': 'Mozilla/5.0'}
        for sym, crypto in (('AAPL', False), ('NVDA', False), ('BTC-USD', True)):
            p1 = int(datetime.datetime(2026, 1, 1).timestamp())
            u = (f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}'
                 f'?period1={p1}&period2={int(time.time())}&interval=1d')
            try:
                with urllib.request.urlopen(urllib.request.Request(u, headers=ua), timeout=25) as r:
                    q = json.load(r)['chart']['result'][0]['indicators']['quote'][0]
            except Exception as e:
                print(f'  [warn] live fetch {sym} failed: {type(e).__name__}', file=sys.stderr)
                continue
            bars = [{'high': h, 'low': l, 'close': c}
                    for c, h, l in zip(q['close'], q['high'], q['low'])
                    if c and h and l and c > 0 and h >= l > 0]
            if len(bars) >= N_CANDLES:
                payload[sym] = {'candles': bars[-N_CANDLES:],
                                'price': bars[-1]['close'], 'crypto': crypto}
            time.sleep(0.3)
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--live', action='store_true', help='also diff against real Yahoo bars')
    args = ap.parse_args()

    if not os.path.exists(CAL_PATH):
        print(f'ERROR: {CAL_PATH} missing. Run tools/calibrate_bands.py first.', file=sys.stderr)
        sys.exit(1)
    with open(CAL_PATH, encoding='utf-8') as f:
        cal = json.load(f)

    payload = build_fixtures(args.live)

    # Temp file must sit inside the repo: under Git Bash on Windows a /tmp path
    # reaches native node as C:\tmp\... and fails with an empty stdout.
    fd, tmp = tempfile.mkstemp(suffix='.json', dir=os.path.join(REPO, 'tools'))
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        proc = subprocess.run(
            ['node', os.path.join('tools', 'band_sync_check.mjs'), tmp, REPO],
            capture_output=True, text=True, cwd=REPO)
    finally:
        os.remove(tmp)

    if proc.returncode != 0 or not proc.stdout.strip():
        print('ERROR: node harness failed.', file=sys.stderr)
        print(proc.stderr[:1500], file=sys.stderr)
        sys.exit(1)
    js = json.loads(proc.stdout)

    print(f'{"case":<15}{"tier":<9}{"sigma%":>8}{"conf":>6}{"max diff":>11}  result')
    failures = 0
    for name, o in payload.items():
        p = py_forecast(cal, o['candles'], o['price'], earnings_day=o.get('earningsDay'))
        j = js.get(name)
        if p is None or j is None:
            print(f'{name:<15}{"-":<9}{"-":>8}{"-":>6}{"-":>11}  '
                  f'{"BOTH NULL (ok)" if p is None and j is None else "ONE-SIDED NULL"}')
            failures += 0 if (p is None and j is None) else 1
            continue
        worst = max(abs(a['low'] - b['low']) + abs(a['high'] - b['high'])
                    for a, b in zip(p['days'], j['days']))
        ok = (p['volTier'] == j['volTier']
              and abs(p['sigmaDaily'] - j['sigmaDaily']) < 0.01
              and worst < TOL
              # calibrated must AGREE between the two, rather than the JS simply
              # being true: a sub-penny fixture is legitimately uncalibrated on
              # both sides, and a disagreement is the bug worth catching.
              and j['calibrated'] == p['calibrated']
              and j.get('uncalibratedReason') == p.get('uncalibratedReason')
              and j['confidence'] == round(cal['targetConfidence'] * 100)
              # Which z family drew the band has to agree too, or one side is silently
              # using the pooled z while the other widens for earnings.
              and j.get('earningsDay') == p.get('earningsDay'))
        failures += 0 if ok else 1
        print(f'{name:<15}{p["volTier"]:<9}{p["sigmaDaily"]:>8.2f}{j["confidence"]:>5}%'
              f'{worst:>11.4f}  {"OK" if ok else "MISMATCH"}')

    # A band whose edges collapse onto each other has zero width, so "price
    # stayed inside" is impossible and the row can ONLY score as a hit. That is
    # how sub-penny rows silently inflated every range statistic in the ledger.
    print('\nnon-zero width invariant:')
    zw = 0
    for name, o in payload.items():
        p = py_forecast(cal, o['candles'], o['price'])
        for d in (p or {}).get('days', []):
            if d['high'] <= d['low']:
                print(f'  {name} h={d["day"]}: high {d["high"]} <= low {d["low"]} '
                      f'(price {o["price"]})')
                zw += 1
    failures += zw
    print('  OK: every day has positive width' if not zw else f'  {zw} collapsed band(s)')

    # THE SPLIT MUST ACTUALLY DO SOMETHING, and in the right direction: an earnings day inside
    # the band widens the rows from that day on and leaves the earlier ones alone, while a band
    # with no earnings is no wider than the pooled one. A no-op split would otherwise pass every
    # comparison above.
    print('\nearnings split:')
    bars = synth(2, spread=0.022)
    px = bars[-1]['close']
    pooled = py_forecast(cal, bars, px)
    none_ = py_forecast(cal, bars, px, earnings_day=0)
    mid = py_forecast(cal, bars, px, earnings_day=4)
    d1 = py_forecast(cal, bars, px, earnings_day=1)
    split_bad = 0
    if not (pooled and none_ and mid and d1):
        print('  could not build the earnings fixtures')
        split_bad += 1
    else:
        w = lambda r, h: r['days'][h - 1]['high'] - r['days'][h - 1]['low']
        if not w(mid, 3) < w(pooled, 3) * 1.0001:
            print(f'  day 3 (before the announcement) is not ordinary-week narrow: '
                  f'{w(mid, 3):.4f} vs pooled {w(pooled, 3):.4f}')
            split_bad += 1
        if not w(mid, 4) > w(pooled, 4) * 1.05:
            print(f'  day 4 (the announcement) is not widened: {w(mid, 4):.4f} vs pooled {w(pooled, 4):.4f}')
            split_bad += 1
        if not w(d1, 1) > w(none_, 1) * 1.2:
            print(f'  an earnings day 1 is not much wider than an ordinary day 1: '
                  f'{w(d1, 1):.4f} vs {w(none_, 1):.4f}')
            split_bad += 1
        if abs(w(none_, 1) - w(pooled, 1)) / w(pooled, 1) > 0.10:
            print(f'  ordinary-week day 1 moved more than 10% from pooled: '
                  f'{w(none_, 1):.4f} vs {w(pooled, 1):.4f}')
            split_bad += 1
    failures += split_bad
    print('  OK: ordinary weeks unchanged, earnings days widened from the announcement on'
          if not split_bad else f'  {split_bad} problem(s)')

    tiers = {p['volTier'] for p in
             (py_forecast(cal, o['candles'], o['price']) for o in payload.values()) if p}
    print(f'\ntiers exercised: {sorted(tiers)}')
    if len(tiers) < 3:
        print('WARNING: fewer than 3 volatility tiers exercised; a tier bug could hide.')

    # A per-day band cannot be wider than the cumulative band that contains it,
    # and must be identical at h=1. If this ever flips, the two calibration
    # collections have been crossed and every displayed band is wrong.
    print('\nper-day vs cumulative invariant:')
    bad = 0
    for name, o in payload.items():
        pd = py_forecast(cal, o['candles'], o['price'], 'perDay')
        cu = py_forecast(cal, o['candles'], o['price'], 'cumulative')
        if not pd or not cu:
            continue
        for a, b in zip(pd['days'], cu['days']):
            if a['day'] == 1:
                if abs(a['high'] - b['high']) > TOL:
                    print(f'  {name} h=1 differs between modes: {a["high"]} vs {b["high"]}')
                    bad += 1
            elif a['high'] >= b['high'] + TOL:
                print(f'  {name} h={a["day"]} per-day WIDER than cumulative: '
                      f'{a["high"]} vs {b["high"]}')
                bad += 1
    if bad:
        print(f'  {bad} violation(s)')
        failures += bad
    else:
        print('  OK: identical at day 1, strictly narrower beyond it')

    if failures:
        print(f'\nBAND SYNC FAIL: {failures} case(s) disagree.', file=sys.stderr)
        sys.exit(1)
    print('\nBAND SYNC PASS: browser and cron compute identical bands.')


if __name__ == '__main__':
    main()
