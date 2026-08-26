"""WHERE does the signal live, and does any slice of it survive trading costs?

The headline is a mean IC of about +0.022 at 1 and 5 days. That is weak but
statistically detectable, and a single average can hide two very different worlds:
a tiny edge smeared evenly over everything (useless), or a real edge concentrated in
a subset and diluted by noise elsewhere (usable). This tool tells them apart.

It slices the ledger by region, price tier, confidence, RSI regime and signal, and
for each slice reports:

  * mean IC per date, its t-stat, and how often it is positive
  * mean forward return of the calls that slice would have TAKEN
  * the same return NET of an estimated round-trip cost
  * the BREAKEVEN move a slice needs just to pay its own costs

The cost model is the whole point. An earlier pass on this project found a real
reversal IC of about 0.05 in penny names that replicated out of sample, and then
found a measured 1.86% round-trip spread ate all of it. Any IC number quoted without
costs beside it is not a finding, it is a hypothesis.

COST MODEL
----------
Round-trip cost = 2 x effective half-spread + 2 x slippage, expressed in percent of
notional. Half-spreads are assigned by price tier, which is a crude but honest
proxy: the true driver is depth, and the ledger stores no depth. The tiers below are
deliberately CONSERVATIVE (toward higher cost) because Corwin-Schultz style
estimators are documented as biased upward 25-50bps post-2003 and retail fills are
worse than quoted mid. Commission is taken as zero, which is right for US retail.

Getting this wrong in the optimistic direction is how a backtest turns a losing
system into a winning one, so when unsure the numbers here round against us.

Usage:
    python tools/ic_decompose.py
    python tools/ic_decompose.py --horizon 5
    python tools/ic_decompose.py --min-dates 20
"""
import argparse
import collections
import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
LEDGER = os.path.join(REPO, 'model', 'ledger')

# Effective HALF-spread in percent, by last price. Round trip doubles it, and
# slippage is added on top. Sub-$1 names really do cost this much: a stock quoted
# 0.0041 x 0.0043 has a 4.8% spread, and the app's own universe contains those.
HALF_SPREAD_PCT = [
    (0.01,    5.00),
    (0.10,    2.50),
    (1.00,    1.20),
    (5.00,    0.35),
    (20.00,   0.12),
    (100.00,  0.04),
    (float('inf'), 0.02),
]
SLIPPAGE_PCT = 0.05    # per side, market-order impact on a retail-size fill


def round_trip_cost_pct(price):
    """Percent of notional to get in AND out. Conservative by design."""
    try:
        p = float(price)
    except (TypeError, ValueError):
        return None
    if not (p > 0):
        return None
    for ceiling, half in HALF_SPREAD_PCT:
        if p < ceiling:
            return 2 * half + 2 * SLIPPAGE_PCT
    return 2 * HALF_SPREAD_PCT[-1][1] + 2 * SLIPPAGE_PCT


# ── stats ────────────────────────────────────────────────────────────────────
def spearman(xs, ys):
    n = len(xs)
    if n < 4:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    dy = math.sqrt(sum((b - my) ** 2 for b in ry))
    return num / (dx * dy) if dx and dy else None


def tstat(vals):
    n = len(vals)
    if n < 3:
        return None
    m = sum(vals) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in vals) / (n - 1))
    return (m / (sd / math.sqrt(n))) if sd > 0 else None


def winsorize(vals, pct=0.01):
    """Clip the extreme tails. Two AEHL rows once read +1192% and +1803% from
    unflagged splits and moved a 1,096-row mean from -0.07% to +2.59%. The resolver
    now quarantines corporate actions, but a returns mean should never be one bad
    row away from reversing sign."""
    if len(vals) < 20:
        return vals
    s = sorted(vals)
    k = max(1, int(len(s) * pct))
    lo, hi = s[k], s[-k - 1]
    return [min(max(v, lo), hi) for v in vals]


# ── data ─────────────────────────────────────────────────────────────────────
def load():
    rows = []
    for fn in sorted(os.listdir(LEDGER)):
        if not fn.endswith('.jsonl'):
            continue
        with open(os.path.join(LEDGER, fn), encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows


def price_tier(p):
    if p is None:
        return None
    if p < 0.01:
        return 'sub-cent'
    if p < 1:
        return 'sub-$1'
    if p < 5:
        return '$1-5'
    if p < 20:
        return '$5-20'
    if p < 100:
        return '$20-100'
    return '$100+'


def rsi_regime(ind):
    r = (ind or {}).get('rsi')
    if not isinstance(r, (int, float)):
        return None
    if r < 30:
        return 'RSI<30 oversold'
    if r < 45:
        return 'RSI 30-45'
    if r <= 55:
        return 'RSI 45-55'
    if r <= 70:
        return 'RSI 55-70'
    return 'RSI>70 overbought'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--horizon', default='1', choices=['1', '3', '5', '10', '20'])
    ap.add_argument('--min-dates', type=int, default=12,
                    help='a slice needs this many dates before its IC is reported')
    ap.add_argument('--min-per-date', type=int, default=8,
                    help='symbols required on a date for that date to yield an IC')
    args = ap.parse_args()
    h = args.horizon

    rows = load()
    if not rows:
        print('No ledger rows.', file=sys.stderr)
        sys.exit(1)

    # Build the usable observation set once.
    obs = []
    for r in rows:
        o = (r.get('horizons') or {}).get(h)
        if not o or o.get('unresolvable') or 'anchorHow' not in o:
            continue
        pm = o.get('pctMove')
        sc = r.get('weightedScore')
        if sc is None:
            sc = ((r.get('breakdown') or {}).get('technical') or {}).get('score')
        e = r.get('entry')
        if not isinstance(pm, (int, float)) or pm != pm or pm == 0:
            continue
        if not isinstance(sc, (int, float)) or not isinstance(e, (int, float)) or e <= 0:
            continue
        obs.append({
            'date': r.get('date'), 'region': r.get('region'), 'entry': e,
            'score': sc, 'pct': pm, 'signal': r.get('signal'),
            'conf': r.get('confidence'), 'ind': r.get('indicators'),
            'tier': price_tier(e), 'rsi': rsi_regime(r.get('indicators')),
            'cost': round_trip_cost_pct(e),
        })
    if not obs:
        print(f'Nothing resolved at horizon {h}d.', file=sys.stderr)
        sys.exit(1)

    print(f'\nIC DECOMPOSITION  horizon={h}d   {len(obs):,} observations, '
          f'{len({o["date"] for o in obs})} dates')
    print('=' * 100)
    print(f'  cost model: round trip = 2 x half-spread(price tier) + 2 x {SLIPPAGE_PCT}% slippage')
    print('              conservative on purpose; see the module docstring')

    def report(title, keyfn):
        groups = collections.defaultdict(list)
        for o in obs:
            k = keyfn(o)
            if k is not None:
                groups[k].append(o)
        if not groups:
            return
        print(f'\n  BY {title}')
        print(f'    {"slice":<20}{"n":>7}{"dates":>7}{"IC":>9}{"t":>7}{"IC+%":>7}'
              f'{"taken":>7}{"gross%":>9}{"cost%":>8}{"NET%":>9}  verdict')
        for k in sorted(groups, key=lambda x: -len(groups[x])):
            g = groups[k]
            by_date = collections.defaultdict(list)
            for o in g:
                by_date[o['date']].append(o)
            ics = []
            for d, items in by_date.items():
                if len(items) < args.min_per_date:
                    continue
                ic = spearman([i['score'] for i in items], [i['pct'] for i in items])
                if ic is not None:
                    ics.append(ic)
            if len(ics) < args.min_dates:
                continue
            mic = sum(ics) / len(ics)
            t = tstat(ics)
            pos = 100 * sum(1 for v in ics if v > 0) / len(ics)

            # The trades this slice would actually TAKE: score>50 long, <50 short.
            # Return is signed by the direction taken.
            taken = [o for o in g if o['score'] != 50]
            rets = winsorize([(o['pct'] if o['score'] > 50 else -o['pct']) for o in taken])
            costs = [o['cost'] for o in taken if o['cost'] is not None]
            gross = sum(rets) / len(rets) if rets else 0.0
            cost = sum(costs) / len(costs) if costs else 0.0
            net = gross - cost
            verdict = ('NET POSITIVE' if net > 0 else
                       'edge exists, costs eat it' if gross > 0 else 'no edge')
            print(f'    {str(k):<20}{len(g):>7,}{len(ics):>7}{mic:>+9.4f}'
                  f'{(t if t is not None else 0):>+7.2f}{pos:>6.0f}%'
                  f'{len(taken):>7,}{gross:>+9.3f}{cost:>8.2f}{net:>+9.3f}  {verdict}')

    report('REGION', lambda o: o['region'])
    report('PRICE TIER', lambda o: o['tier'])
    report('RSI REGIME', lambda o: o['rsi'])
    report('SIGNAL', lambda o: o['signal'])
    report('CONFIDENCE', lambda o: (f"conf {int(o['conf'] // 10 * 10)}s"
                                    if isinstance(o['conf'], (int, float)) else None))

    # What move would a slice need just to pay its own costs? This is the number
    # that decides whether any of this is worth trading.
    print('\n  BREAKEVEN: the average move a slice must capture to cover costs')
    print(f'    {"price tier":<14}{"round-trip cost %":>20}{"needed avg move %":>20}')
    for ceiling, half in HALF_SPREAD_PCT:
        c = 2 * half + 2 * SLIPPAGE_PCT
        label = f'<${ceiling:g}' if ceiling != float('inf') else '$100+'
        print(f'    {label:<14}{c:>20.2f}{c:>20.2f}')

    print('\n  READING THIS')
    print('    IC is rank correlation between score and forward move, per date.')
    print('    NET% is the mean per-trade return after an estimated round trip.')
    print('    A slice is only interesting if NET% > 0 AND its IC t-stat clears ~2')
    print('    AND it has enough dates that one lucky week cannot carry it.')
    print('    Trial count matters: this run tests many slices at once, so a single')
    print('    t>2 among dozens is expected by chance. Treat survivors as candidates')
    print('    to re-test out of sample, never as findings.')
    print()


if __name__ == '__main__':
    main()
