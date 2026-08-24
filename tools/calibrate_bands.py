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

# Fallback only. The real sample is drawn from the live ledger by
# ledger_universe_sample(), because the calibration must describe the population
# the app actually predicts on. Calibrating on hand-picked mega-caps and then
# serving penny stocks is how the active/wild tiers ended up ~5 points short of
# their claimed coverage on real ledger rows.
FALLBACK_SAMPLE = [
    'KO', 'JNJ', 'PG', 'WMT', 'CSCO', 'VZ', 'MRK', 'PEP', 'ABT', 'MCD',
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'JPM', 'XOM', 'BAC', 'DIS', 'INTC', 'QCOM',
    'NVDA', 'TSLA', 'AMD', 'META', 'NFLX', 'CRM', 'UBER', 'SHOP', 'PLTR', 'COIN',
    'MARA', 'RIOT', 'PLUG', 'AMC', 'SNAP', 'NIO', 'SOFI', 'HOOD', 'AFRM', 'RIVN',
    'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'AVAX-USD',
]


def ledger_universe_sample(limit=140, per_region=24):
    """Symbols the app actually predicts on, taken from the live ledger.

    Stratified by region so one dominant region cannot crowd out the others, and
    ranked by row count within each region so the picks have enough history to
    calibrate against.
    """
    path = os.path.join('model', 'ledger', '2026.jsonl')
    if not os.path.exists(path):
        return None
    by_region = {}
    prices = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            sym, reg, e = r.get('symbol'), r.get('region'), r.get('entry')
            if not sym or not isinstance(e, (int, float)) or e != e or e < MIN_PRICE:
                continue
            by_region.setdefault(reg, {}).setdefault(sym, 0)
            by_region[reg][sym] += 1
            prices[sym] = e
    if not by_region:
        return None
    # Round-robin across regions rather than concatenate-then-truncate. With 8
    # regions at 24 each the concatenated list is 192, so a straight out[:140]
    # silently dropped whichever regions sorted last (TYO and XETRA), leaving
    # those markets uncalibrated.
    ranked = {reg: [s for s, _ in sorted(by_region[reg].items(), key=lambda kv: -kv[1])]
              [:per_region] for reg in sorted(by_region)}
    out = []
    for i in range(per_region):
        for reg in ranked:
            if i < len(ranked[reg]) and len(out) < limit:
                out.append(ranked[reg][i])
    return out or None


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


# Data-quality gates. These exist because the live ledger surfaced symbols that
# print high == low on 60 of 60 days: the range estimator collapses to 0.00%,
# the tier lookup says "calm", and the band comes out near zero width. AUVI was
# labelled calm at 0.00% sigma while its true close-to-close volatility was
# 14.3% per day. Measured effect of these gates on real ledger rows: overall
# day-1 coverage 70.0% -> 75.9%, and the calm tier 56.7% -> 80.5%.
MIN_PRICE = 0.01        # sub-penny quotes are noise, not prices
MAX_SIGMA = 0.50        # >50%/day is a data error (one crypto printed 139%)
MIN_LIVE_BARS = 20      # need this many non-zero-range bars to trust Parkinson


def parkinson_sigma(bars, k, n=VOL_LOOKBACK):
    """Daily sigma over the n bars ending at k, robust to untraded days.

    Parkinson (high-low) is ~5x more efficient than close-to-close WHEN the asset
    trades continuously. On a thin name that prints high == low it collapses
    toward zero, which understates risk exactly where risk is highest. Close-to-
    close cannot be hidden that way. Taking the max of the two never understates,
    and keeps Parkinson's efficiency on liquid names where it is the better
    estimator.
    """
    if k < n:
        return None
    win = bars[k - n + 1:k + 1]
    if len(win) < n * 0.7:
        return None

    live = sum(1 for _, h, l in win if h > l * 1.0000001)
    pk = 0.0
    if live >= MIN_LIVE_BARS:
        pk = math.sqrt(statistics.mean([math.log(h / l) ** 2 for _, h, l in win])
                       / (4 * math.log(2)))

    rets = [math.log(win[i][0] / win[i - 1][0]) for i in range(1, len(win))
            if win[i - 1][0] > 0 and win[i][0] > 0]
    cc = statistics.stdev(rets) if len(rets) > 5 else 0.0

    sigma = max(pk, cc)
    if not (0 < sigma <= MAX_SIGMA):
        return None
    return sigma


def collect(symbols):
    """Two observation sets per (tier, horizon), both in sigma*sqrt(h) units.

    `obs` is CUMULATIVE: the most extreme high and low reached anywhere in the
    forward window. This is the right semantics for a STOP, because a stop can be
    taken out on any day of the hold, not only the last one.

    `per_day` is PER-DAY: day h's own session high and low, measured against
    today's close. This is the right semantics for a DISPLAYED band, because
    "what will day 5 look like" is a different question from "what is the worst
    case at any point by day 5". Per-day is the narrower of the two for h > 1 and
    identical at h = 1, since a one-day window is one day.
    """
    obs = {(t[2], h): [] for t in TIER_EDGES for h in HORIZONS}
    per_day = {(t[2], h): [] for t in TIER_EDGES for h in HORIZONS}
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
                # Day h's OWN session extremes, still anchored on today's close,
                # since today's close is all a forecast can be anchored to.
                d_hi, d_lo = bars[k + h][1], bars[k + h][2]
                per_day[(tier, h)].append((math.log(d_hi / c0) / denom,
                                           math.log(c0 / d_lo) / denom))
        time.sleep(0.25 if i % 20 else 0.6)
    return obs, per_day, used


def _quantile(sorted_vals, q):
    if not sorted_vals:
        return None
    idx = min(len(sorted_vals) - 1, int(math.ceil(q * len(sorted_vals))) - 1)
    return sorted_vals[max(idx, 0)]


def solve_z(pairs, target):
    """Smallest z whose symmetric band contains BOTH extremes `target` of the time.

    Solved by direct quantile on max(up, down) rather than by bisection, since
    containment is monotone in z and the quantile is exact.
    """
    if len(pairs) < 200:
        return None
    return _quantile(sorted(max(u, d) for u, d in pairs), target)


# Probabilities the one-sided curves are emitted at. The band (two-sided) answers
# "where will price stay inside"; a STOP is one-sided and needs a different
# number. Using the two-sided z as a stop distance would understate how often the
# low alone is breached, because containment of both extremes is a stricter event
# than containment of one.
ONE_SIDED_QUANTILES = [0.50, 0.60, 0.70, 0.80, 0.90, 0.95]


def solve_one_sided(pairs, which):
    """Quantile curve of how far ONE extreme reaches, in sigma*sqrt(h) units.

    which='down' -> distribution of how far the LOW reached below entry.
      Read as: a stop placed at z=curve['0.90'] survives 90% of holds.
    which='up'   -> distribution of how far the HIGH reached above entry.
      Read as: a target at z=curve['0.60'] is touched by 40% of holds
      (since 60% of holds reach LESS far than that).
    """
    if len(pairs) < 200:
        return None
    vals = sorted(d if which == 'down' else u for u, d in pairs)
    return {f'{q:.2f}': round(_quantile(vals, q), 4) for q in ONE_SIDED_QUANTILES}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', type=float, default=0.80,
                    help='claimed confidence, e.g. 0.80')
    args = ap.parse_args()
    target = args.target
    if not 0.5 <= target <= 0.99:
        print('ERROR: --target must be between 0.50 and 0.99', file=sys.stderr)
        sys.exit(1)

    sample = ledger_universe_sample() or FALLBACK_SAMPLE
    src = 'live ledger' if sample is not FALLBACK_SAMPLE else 'fallback list'
    print(f'Calibrating {len(HORIZONS)}-day bands at target confidence '
          f'{target:.0%} over {len(sample)} symbols from the {src}...')
    obs, per_day, used = collect(sample)
    print(f'Symbols used: {used}/{len(sample)}')

    z = {}
    coverage = {}
    counts = {}
    stop_z = {}
    target_z = {}
    z_per_day = {}
    coverage_per_day = {}
    for (tier, h), pairs in sorted(obs.items()):
        zz = solve_z(pairs, target)
        counts[f'{tier}:{h}'] = len(pairs)
        if zz is None:
            continue
        z.setdefault(tier, {})[str(h)] = round(zz, 4)
        hit = sum(1 for u, d in pairs if u <= zz and d <= zz)
        coverage[f'{tier}:{h}'] = round(hit / len(pairs), 4)
        down = solve_one_sided(pairs, 'down')
        up = solve_one_sided(pairs, 'up')
        if down:
            stop_z.setdefault(tier, {})[str(h)] = down
        if up:
            target_z.setdefault(tier, {})[str(h)] = up
        pd_pairs = per_day.get((tier, h)) or []
        zp = solve_z(pd_pairs, target)
        if zp is not None:
            z_per_day.setdefault(tier, {})[str(h)] = round(zp, 4)
            hp = sum(1 for u, d in pd_pairs if u <= zp and d <= zp)
            coverage_per_day[f'{tier}:{h}'] = round(hp / len(pd_pairs), 4)

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
        'sampleSource': src,
        'dataQualityGates': {'minPrice': MIN_PRICE, 'maxSigma': MAX_SIGMA,
                             'minLiveBars': MIN_LIVE_BARS},
        'sigmaEstimator': 'max(parkinson, close-to-close)',
        # One-sided curves, in sigma*sqrt(h) units, consumed by js/risk.js.
        # stopZ[tier][h]['0.90'] = distance a stop must sit at to survive 90% of
        # holds. targetZ[tier][h]['0.60'] = distance the high reaches on 40% of
        # holds. A stop is a one-sided event and must not be sized off the
        # two-sided band z.
        'oneSidedQuantiles': ONE_SIDED_QUANTILES,
        'stopZ': stop_z,
        'targetZ': target_z,
        # PER-DAY band, the default for display: day h's own session High/Low.
        # `z` above stays CUMULATIVE and is what stops are sized from.
        'zPerDay': z_per_day,
        'realizedCoveragePerDay': coverage_per_day,
    }
    os.makedirs('model', exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        # allow_nan=False: a bare NaN token is invalid JSON and one such token
        # silently killed the browser's entire calibration load once before.
        json.dump(payload, f, indent=2, allow_nan=False)

    print(f'\nWrote {OUT_PATH}')
    print(f"\n{'':<12}{'CUMULATIVE (stops)':>22}{'PER-DAY (display)':>24}")
    print(f"{'tier':<9}{'h':>3}{'z':>10}{'cover':>10}{'n':>9}{'z':>10}{'cover':>10}")
    for tier in [t[2] for t in TIER_EDGES]:
        for h in HORIZONS:
            key = f'{tier}:{h}'
            if tier not in z or str(h) not in z[tier]:
                continue
            zp = z_per_day.get(tier, {}).get(str(h))
            cp = coverage_per_day.get(key)
            row = (f'{tier:<9}{h:>3}{z[tier][str(h)]:>10.3f}'
                   f'{coverage[key]:>9.1%}{counts[key]:>9,}')
            row += (f'{zp:>10.3f}{cp:>9.1%}' if zp is not None else f'{"-":>10}{"-":>10}')
            print(row)

    # Per-day must be strictly narrower than cumulative beyond day 1: one
    # session's extremes cannot exceed the running extremes of a window that
    # contains it. A violation means the two collections got crossed.
    violations = [f'{t}:{h}' for t in z for h in z[t]
                  if int(h) > 1 and t in z_per_day and h in z_per_day[t]
                  and z_per_day[t][h] >= z[t][h]]
    if violations:
        print(f'\nERROR: per-day z >= cumulative z at {violations}', file=sys.stderr)
        sys.exit(1)

    all_cov = list(coverage.values()) + list(coverage_per_day.values())
    worst = max((abs(c - target) for c in all_cov), default=0)
    print(f'\nWorst coverage error across all cells, both modes: {worst:.2%}'
          f'  ({len(all_cov)} cells)')
    if worst > 0.03:
        print('WARNING: a cell is off by more than 3 points. Investigate before shipping.')


if __name__ == '__main__':
    main()
