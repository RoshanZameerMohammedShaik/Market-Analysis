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

5. **Earnings windows get their own z.** 5-6% of windows contain an earnings reaction and move
   1.5-2.5x further, so one z per cell is too wide for ordinary weeks and far too narrow for
   earnings weeks (held-out on this sample: 51.5% coverage in earnings windows vs 81.1% in the
   rest). The pooled `z`/`zPerDay` stay exactly as before and remain what a symbol with no
   calendar data gets; `zEarn`/`zNoEarn` (and per-day twins) are fitted on the split. See
   earnings_calendar.py for how an announcement becomes a band day.

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

# Repo root, for ledger_store, ledger_universe and earnings_calendar.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
    # Monthly shards (model/ledger/YYYY-MM.jsonl). This read the single 2026.jsonl, which was
    # retired when it outgrew GitHub's file limit, so every recalibration since then would have
    # silently fallen back to the 48 hand-picked names this function exists to replace.
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import ledger_store
    by_region = {}
    prices = {}
    for r in ledger_store.iter_rows():
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
    """(bars, times): bars are (close, high, low); times the matching session-open epochs."""
    p1 = int(datetime.datetime(start_year, 1, 1).timestamp())
    p2 = int(time.time())
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}'
           f'?period1={p1}&period2={p2}&interval=1d')
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        d = json.load(r)
    res = d['chart']['result'][0]
    q = res['indicators']['quote'][0]
    keep = [(t, (c, h, l)) for t, c, h, l in zip(res.get('timestamp') or [], q['close'], q['high'], q['low'])
            if c and h and l and c > 0 and h >= l > 0]
    return [b for _, b in keep], [t for t, _ in keep]


def earnings_bar_indices(sym, times):
    """Indices of the bars an earnings announcement first moved, or None when unknown.

    Crypto has none (an empty set, i.e. KNOWN ordinary). A stock whose calendar lookup fails is
    None, so its windows count only toward the pooled z and never pose as ordinary weeks.
    """
    from ledger_universe import region_for
    import earnings_calendar as ec
    region = region_for(sym)
    if region == 'CRYPTO':
        return set()
    try:
        import yfinance as yf
        df = yf.Ticker(sym).get_earnings_dates(limit=100)
    except Exception:
        return None
    if df is None or not len(df):
        return None
    spec = ec.MARKETS.get(region)
    if not spec or ec.ZoneInfo is None:
        return None
    tz = ec.ZoneInfo(spec['tz'])
    local_dates = [datetime.datetime.fromtimestamp(t, datetime.timezone.utc).astimezone(tz).date() for t in times]
    idx = set()
    for ts in df.index:
        try:
            rd = ec.reaction_date(int(ts.timestamp()), region)
        except Exception:
            continue
        if rd is None:
            continue
        # First bar on or after the reaction date (a holiday pushes it to the next session).
        for j, d in enumerate(local_dates):
            if d >= rd:
                if (d - rd).days <= 4:
                    idx.add(j)
                break
    return idx


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
    # The same observations again, split by whether an earnings reaction falls inside the
    # window. Only from symbols whose calendar is KNOWN; see earnings_bar_indices.
    split = {'earn': ({k: [] for k in obs}, {k: [] for k in obs}),
             'noEarn': ({k: [] for k in obs}, {k: [] for k in obs})}
    used = 0
    for i, sym in enumerate(symbols):
        try:
            bars, times = fetch(sym)
        except Exception as e:
            print(f'  [skip] {sym}: {type(e).__name__}', file=sys.stderr)
            continue
        earn_idx = earnings_bar_indices(sym, times)
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
                cum_pair = (math.log(hi / c0) / denom, math.log(c0 / lo) / denom)
                obs[(tier, h)].append(cum_pair)
                # Day h's OWN session extremes, still anchored on today's close,
                # since today's close is all a forecast can be anchored to.
                d_hi, d_lo = bars[k + h][1], bars[k + h][2]
                day_pair = (math.log(d_hi / c0) / denom, math.log(c0 / d_lo) / denom)
                per_day[(tier, h)].append(day_pair)
                if earn_idx is not None:
                    fam = 'earn' if any(k < j <= k + h for j in earn_idx) else 'noEarn'
                    split[fam][0][(tier, h)].append(cum_pair)
                    split[fam][1][(tier, h)].append(day_pair)
        time.sleep(0.25 if i % 20 else 0.6)
    return obs, per_day, used, split


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
    obs, per_day, used, split = collect(sample)
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

    # Earnings / ordinary-week families. A cell too thin to fit is simply absent, and the band
    # falls back to the pooled z for it (forecast_band.py), so a missing cell costs nothing.
    fam_z = {}
    fam_cov = {}
    fam_n = {}
    for fam, (cum_cells, day_cells) in split.items():
        for kind, cells in (('cum', cum_cells), ('day', day_cells)):
            key = {'cum': 'z', 'day': 'zPerDay'}[kind] + {'earn': 'Earn', 'noEarn': 'NoEarn'}[fam]
            for (tier, h), pairs in sorted(cells.items()):
                fam_n[f'{key}:{tier}:{h}'] = len(pairs)
                zz = solve_z(pairs, target)
                if zz is None:
                    continue
                fam_z.setdefault(key, {}).setdefault(tier, {})[str(h)] = round(zz, 4)
                hit = sum(1 for u, d in pairs if u <= zz and d <= zz)
                fam_cov[f'{key}:{tier}:{h}'] = round(hit / len(pairs), 4)
    # Earnings cells too thin to fit (the wild tier has only a few dozen day-1 earnings windows)
    # would otherwise fall back to the POOLED z, which is the too-narrow number this split
    # replaces. Derive them instead, keeping two measured facts: the tier's OWN earnings ratio
    # (earnings z / ordinary z) at its nearest fitted horizon, and the common SHAPE of how that
    # ratio decays with horizon in the tiers that fitted everywhere. The level matters: wild
    # names already move so much that an earnings week adds relatively little (ratio ~1.05 at
    # day 4, against ~1.6 for calm names), so borrowing the other tiers' level would make their
    # band far too wide. Listed in earningsDerivedCells so nobody mistakes them for fits.
    derived = []
    tiers = [t[2] for t in TIER_EDGES]
    for cum_key, ord_key in (('zEarn', 'zNoEarn'), ('zPerDayEarn', 'zPerDayNoEarn')):
        earn_t, ord_t = fam_z.setdefault(cum_key, {}), fam_z.get(ord_key, {})

        def ratio(t, h):
            e, o = earn_t.get(t, {}).get(str(h)), ord_t.get(t, {}).get(str(h))
            return e / o if e and o else None

        for tier in tiers:
            fitted = [h for h in HORIZONS if ratio(tier, h) is not None]
            for h in HORIZONS:
                if str(h) in earn_t.get(tier, {}) or str(h) not in ord_t.get(tier, {}):
                    continue
                if fitted:
                    h0 = min(fitted, key=lambda x: abs(x - h))
                    shape = [ratio(t, h) / ratio(t, h0) for t in tiers
                             if t != tier and ratio(t, h) and ratio(t, h0)]
                    if not shape:
                        continue
                    r = ratio(tier, h0) * statistics.median(shape)
                else:
                    across = [ratio(t, h) for t in tiers if ratio(t, h)]
                    if not across:
                        continue
                    r = statistics.median(across)
                earn_t.setdefault(tier, {})[str(h)] = round(ord_t[tier][str(h)] * max(1.0, r), 4)
                derived.append(f'{cum_key}:{tier}:{h}')

    # What the pooled z delivered in each family: the gap this split exists to close.
    pooled_cov = {}
    for fam, (_, day_cells) in split.items():
        hit = tot = 0
        for (tier, h), pairs in day_cells.items():
            zz = z_per_day.get(tier, {}).get(str(h))
            if zz is None:
                continue
            tot += len(pairs)
            hit += sum(1 for u, d in pairs if u <= zz and d <= zz)
        if tot:
            pooled_cov[fam] = round(hit / tot, 4)

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
        # Earnings-aware families (see the method note at the top). Absent keys mean "not
        # enough windows to fit", and the band uses the pooled z for that cell.
        'earningsSource': 'yfinance get_earnings_dates, reaction session per earnings_calendar.py',
        'zEarn': fam_z.get('zEarn', {}),
        'zNoEarn': fam_z.get('zNoEarn', {}),
        'zPerDayEarn': fam_z.get('zPerDayEarn', {}),
        'zPerDayNoEarn': fam_z.get('zPerDayNoEarn', {}),
        'realizedCoverageEarnSplit': fam_cov,
        'sampleCountsEarnSplit': fam_n,
        'pooledCoveragePerDayBySplit': pooled_cov,
        'earningsDerivedCells': derived,
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
    for fam in ('Earn', 'NoEarn'):
        zc, zd = fam_z.get('z' + fam, {}), fam_z.get('zPerDay' + fam, {})
        violations += [f'{fam}:{t}:{h}' for t in zc for h in zc[t]
                       if int(h) > 1 and h in zd.get(t, {}) and zd[t][h] >= zc[t][h]]
    print(f"\nPooled per-day z, by family: ordinary weeks {pooled_cov.get('noEarn', float('nan')):.1%}, "
          f"earnings weeks {pooled_cov.get('earn', float('nan')):.1%} (target {target:.0%})")
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
