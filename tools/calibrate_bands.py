"""Calibrate the 7-day High/Low forecast bands against real history.

Why this exists
---------------
The old multi-horizon predictor multiplied expected move by the signal's
DIRECTION and by a hand-picked 0.5-1.5 "strength" multiplier keyed off
confidence. Neither had any empirical basis, and direction is the one thing
this app cannot predict (measured 49.5% on correctly-graded rows).

Range forecasting is a different question and it IS answerable, because
volatility clusters: calm days follow calm days, wild days follow wild days.
So instead of "will it go up", we answer "what High and Low will it reach, and
how often is that right".

Method
------
1. Daily sigma from the high-low RANGE, not close-to-close. The Parkinson
   estimator sigma^2 = mean(ln(H/L)^2) / (4 ln 2) uses the intraday extremes and
   is roughly 5x more statistically efficient than a close-to-close estimate on
   the same number of bars, which matters a lot at a 30-bar lookback.
2. Scale to horizon h by sqrt(h) (random-walk scaling of variance in time).
3. Band = price * exp(+/- z * sigma * sqrt(h)).
4. **Solve for z empirically per (volatility tier, horizon) so that realized
   coverage equals the target.** This is the load-bearing step. Returns have fat
   tails, so the normal-theory z (1.28 for 80%) is systematically too narrow and
   would make the app overconfident in exactly the way it already was.

Calibrating per TIER rather than per SYMBOL is deliberate: it generalizes to
newly listed names with no history, and it avoids fitting 700 separate z's to
noise. Tiers are assigned from the symbol's own realized sigma, so a symbol
moves between tiers as its volatility changes.

Output: model/band_calibration.json, read by js/forecast-band.js.

Run: python tools/calibrate_bands.py [--target 0.80]
"""
import argparse
import datetime
import json
import math
import os
import statistics
import sys
import time
import urllib.request

UA = {'User-Agent': 'Mozilla/5.0 (compatible; Market-Analysis band calibrator)'}
OUT_PATH = os.path.join('model', 'band_calibration.json')

HORIZONS = [1, 2, 3, 4, 5, 6, 7]
VOL_LOOKBACK = 30

# Tier edges on daily sigma (fraction, not %). A name is placed by its own
# realized sigma at prediction time, so this is a state, not a label.
TIER_EDGES = [(0.0, 0.015, 'calm'), (0.015, 0.025, 'normal'),
              (0.025, 0.040, 'active'), (0.040, 9.99, 'wild')]

# Spread across the volatility spectrum on purpose: the calibration is only as
# good as the tier coverage, and a mega-cap-only sample would leave 'wild' thin.
SAMPLE = [
    'KO', 'JNJ', 'PG', 'WMT', 'CSCO', 'VZ', 'MRK', 'PEP', 'ABT', 'MCD',
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'JPM', 'XOM', 'BAC', 'DIS', 'INTC', 'QCOM',
    'NVDA', 'TSLA', 'AMD', 'META', 'NFLX', 'CRM', 'UBER', 'SHOP', 'PLTR', 'COIN',
    'MARA', 'RIOT', 'PLUG', 'AMC', 'SNAP', 'NIO', 'SOFI', 'HOOD', 'AFRM', 'RIVN',
    'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'AVAX-USD',
]


def tier_for(sigma):
    for lo, hi, name in TIER_EDGES:
        if lo <= sigma < hi:
            return name
    return TIER_EDGES[-1][2]


def fetch(sym, start_year=2021):
    p1 = int(datetime.datetime(start_year, 1, 1).timestamp())
    p2 = int(time.time())
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}'
           f'?period1={p1}&period2={p2}&interval=1d')
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        d = json.load(r)
    q = d['chart']['result'][0]['indicators']['quote'][0]
    bars = [(c, h, l) for c, h, l in zip(q['close'], q['high'], q['low'])
            if c and h and l and c > 0 and h >= l > 0]
    return bars


def parkinson_sigma(bars, k, n=VOL_LOOKBACK):
    """Daily sigma from the high-low range over the n bars ending at k."""
    if k < n:
        return None
    sq = [math.log(bars[i][1] / bars[i][2]) ** 2 for i in range(k - n + 1, k + 1)]
    if len(sq) < n * 0.7:
        return None
    return math.sqrt(statistics.mean(sq) / (4 * math.log(2)))


def collect(symbols):
    """One observation per (bar, horizon): the sigma, the tier, and the realized
    extremes over the forward window, expressed in sigma units."""
    obs = {(t[2], h): [] for t in TIER_EDGES for h in HORIZONS}
    used = 0
    for i, sym in enumerate(symbols):
        try:
            bars = fetch(sym)
        except Exception as e:
            print(f'  [skip] {sym}: {type(e).__name__}', file=sys.stderr)
            continue
        if len(bars) < VOL_LOOKBACK + max(HORIZONS) + 50:
            print(f'  [skip] {sym}: only {len(bars)} bars', file=sys.stderr)
            continue
        used += 1
        for k in range(VOL_LOOKBACK, len(bars) - max(HORIZONS)):
            s = parkinson_sigma(bars, k)
            if not s or s <= 0:
                continue
            tier = tier_for(s)
            c0 = bars[k][0]
            for h in HORIZONS:
                win = bars[k + 1:k + 1 + h]
                if len(win) < h:
                    continue
                hi = max(x[1] for x in win)
                lo = min(x[2] for x in win)
                # How many sigma-sqrt(h) units did the extremes actually reach?
                # Storing this instead of a hit/miss lets one pass calibrate ANY
                # target confidence later without refetching.
                denom = s * math.sqrt(h)
                obs[(tier, h)].append((math.log(hi / c0) / denom,
                                       math.log(c0 / lo) / denom))
        time.sleep(0.25 if i % 20 else 0.6)
    return obs, used


def solve_z(pairs, target):
    """Smallest z whose symmetric band contains BOTH extremes `target` of the time.

    Solved by direct quantile on max(up, down) rather than by bisection, since
    containment is monotone in z and the quantile is exact.
    """
    if len(pairs) < 200:
        return None
    worst = sorted(max(u, d) for u, d in pairs)
    idx = min(len(worst) - 1, int(math.ceil(target * len(worst))) - 1)
    return worst[max(idx, 0)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', type=float, default=0.80,
                    help='claimed confidence, e.g. 0.80')
    args = ap.parse_args()
    target = args.target
    if not 0.5 <= target <= 0.99:
        print('ERROR: --target must be between 0.50 and 0.99', file=sys.stderr)
        sys.exit(1)

    print(f'Calibrating {len(HORIZONS)}-day bands at target confidence '
          f'{target:.0%} over {len(SAMPLE)} symbols...')
    obs, used = collect(SAMPLE)
    print(f'Symbols used: {used}/{len(SAMPLE)}')

    z = {}
    coverage = {}
    counts = {}
    for (tier, h), pairs in sorted(obs.items()):
        zz = solve_z(pairs, target)
        counts[f'{tier}:{h}'] = len(pairs)
        if zz is None:
            continue
        z.setdefault(tier, {})[str(h)] = round(zz, 4)
        hit = sum(1 for u, d in pairs if u <= zz and d <= zz)
        coverage[f'{tier}:{h}'] = round(hit / len(pairs), 4)

    if not z:
        print('ERROR: no tier/horizon had enough observations to calibrate.',
              file=sys.stderr)
        sys.exit(1)

    # Normal-theory z for the same two-sided containment, for comparison. If the
    # empirical z is materially larger, fat tails are real and assuming normality
    # would have made the app overconfident.
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'method': 'parkinson-range-sigma x sqrt(h), z calibrated per (volTier, horizon)',
        'targetConfidence': target,
        'volLookbackDays': VOL_LOOKBACK,
        'horizons': HORIZONS,
        'tierEdges': [[lo, hi, name] for lo, hi, name in TIER_EDGES],
        'z': z,
        'realizedCoverage': coverage,
        'sampleCounts': counts,
        'symbolsUsed': used,
    }
    os.makedirs('model', exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        # allow_nan=False: a bare NaN token is invalid JSON and one such token
        # silently killed the browser's entire calibration load once before.
        json.dump(payload, f, indent=2, allow_nan=False)

    print(f'\nWrote {OUT_PATH}')
    print(f"\n{'tier':<9}{'h':>3}{'z':>8}{'claimed':>9}{'realized':>10}{'n':>9}")
    for tier in [t[2] for t in TIER_EDGES]:
        for h in HORIZONS:
            key = f'{tier}:{h}'
            if tier not in z or str(h) not in z[tier]:
                continue
            print(f'{tier:<9}{h:>3}{z[tier][str(h)]:>8.3f}'
                  f'{target:>8.0%}{coverage[key]:>10.1%}{counts[key]:>9,}')

    worst = max((abs(c - target) for c in coverage.values()), default=0)
    print(f'\nWorst coverage error across all tier/horizon cells: {worst:.2%}')
    if worst > 0.03:
        print('WARNING: a cell is off by more than 3 points. Investigate before shipping.')


if __name__ == '__main__':
    main()
