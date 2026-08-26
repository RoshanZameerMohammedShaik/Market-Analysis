"""Does taking only the TOP of the daily ranking harvest the IC? Net of costs.

THE PROBLEM THIS TESTS
----------------------
The engine has a real but small ranking ability: mean IC per date is about +0.03 to
+0.05 in several slices, with t-stats of 3 to 4. IC measures how well the score ORDERS
tomorrow's returns. But the strategy as deployed takes essentially everything it
scores above 50 — 33,684 of 33,958 NYSE observations — which throws the ordering away
and collects the average, not the top.

If the ranking is real, the top K names by score on each date should out-return the
cross-section, and that spread is what pays for costs. This tool measures exactly
that, per horizon, per K, net of an estimated round trip.

WHY THIS IS THE DECIDING TEST
-----------------------------
Costs are close to fixed per trade while the captured move grows with both selectivity
and holding period. So there are two levers: take fewer, better names, and hold longer
so one round trip is amortised over a bigger move. If neither lever produces a
positive net after honest costs, the honest conclusion is that this engine should not
be traded on direction, and no amount of extra data changes the arithmetic today.

GUARDS AGAINST FOOLING OURSELVES
--------------------------------
  * Costs from tools/ic_decompose (conservative, price-tiered) applied per name.
  * Returns winsorised at 1% per tail so one unflagged split cannot carry a mean.
  * Per-DATE portfolio returns, then a t-stat across dates. Pooling trades would
    treat one market move as hundreds of independent observations.
  * An out-of-sample split: the first 70% of dates choose nothing, they are simply
    reported separately from the last 30%. A result that only exists in one half is
    not a result.
  * Trial count printed. This sweeps many (K, horizon) pairs, so the best cell is
    selected on the same data it is measured on and is biased upward by construction.

Usage:
    python tools/topk_backtest.py
    python tools/topk_backtest.py --region NYSE --min-price 5
"""
import argparse
import collections
import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from tools.ic_decompose import round_trip_cost_pct, winsorize  # noqa: E402

LEDGER = os.path.join(REPO, 'model', 'ledger')
HORIZONS = ('1', '3', '5', '10', '20')
KS = (5, 10, 20, 50)


def tstat(vals):
    n = len(vals)
    if n < 3:
        return None
    m = sum(vals) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in vals) / (n - 1))
    return (m / (sd / math.sqrt(n))) if sd > 0 else None


def sharpe_annual(daily_rets, periods_per_year):
    n = len(daily_rets)
    if n < 3:
        return None
    m = sum(daily_rets) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in daily_rets) / (n - 1))
    if sd <= 0:
        return None
    return (m / sd) * math.sqrt(periods_per_year)


def load(region=None, min_price=0.0):
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
                    r = json.loads(line)
                except Exception:
                    continue
                if region and r.get('region') != region:
                    continue
                e = r.get('entry')
                if not isinstance(e, (int, float)) or e < min_price:
                    continue
                rows.append(r)
    return rows


def observations(rows, h):
    by_date = collections.defaultdict(list)
    for r in rows:
        o = (r.get('horizons') or {}).get(h)
        if not o or o.get('unresolvable') or 'anchorHow' not in o:
            continue
        pm = o.get('pctMove')
        sc = r.get('weightedScore')
        if sc is None:
            sc = ((r.get('breakdown') or {}).get('technical') or {}).get('score')
        if not isinstance(pm, (int, float)) or pm != pm:
            continue
        if not isinstance(sc, (int, float)):
            continue
        c = round_trip_cost_pct(r.get('entry'))
        if c is None:
            continue
        by_date[r.get('date')].append({'sym': r.get('symbol'), 'score': sc,
                                       'pct': pm, 'cost': c})
    return by_date


def run(by_date, k, min_names, mode, neutral=False):
    """Per-date portfolio returns for a top-K (or long/short) selection.

    mode 'long'      : buy the K highest scores
    mode 'longshort' : buy the K highest, sell the K lowest, average the two legs

    neutral=True subtracts the SAME-DATE cross-sectional mean return from every name,
    which removes the market move and leaves only ranking skill.

    This switch matters more than any other here. Over a rising sample window every
    forward return is positive, so "buy everything" shows a profit and every top-K
    inherits that beta and looks skilful. On this ledger, holding ALL names for 20
    days returned +1.125% net at t=2.93 — that is the market, not the engine. Excess
    return asks the only question the score can answer: did the names it ranked
    highest beat the ones it ranked lower, on the same day?
    """
    out = []
    for d in sorted(by_date):
        names = by_date[d]
        if len(names) < min_names:
            continue
        if neutral:
            mkt = sum(n['pct'] for n in names) / len(names)
            names = [{**n, 'pct': n['pct'] - mkt} for n in names]
        ranked = sorted(names, key=lambda x: -x['score'])
        longs = ranked[:k]
        if mode == 'long':
            legs = [(n['pct'], n['cost']) for n in longs]
        else:
            shorts = ranked[-k:]
            legs = ([(n['pct'], n['cost']) for n in longs]
                    + [(-n['pct'], n['cost']) for n in shorts])
        if not legs:
            continue
        gross = sum(x[0] for x in legs) / len(legs)
        cost = sum(x[1] for x in legs) / len(legs)
        out.append({'date': d, 'gross': gross, 'cost': cost, 'net': gross - cost,
                    'n': len(legs)})
    return out


def summarize(label, port, periods_per_year, overlap=1):
    """overlap = the horizon in days.

    Consecutive dates share overlap-1 days of the same forward window, so N per-date
    returns hold only about N/overlap independent observations. Dividing t and Sharpe
    by sqrt(overlap) is the standard first-order correction. Without it a 20-day
    horizon sampled daily inflates t by about 4.5x: the raw t=+6.00 this ledger
    produced for top-10 at 20 days is really about +1.34, which is not significant at
    all. Overlapping windows are one of the most common ways a backtest lies.
    """
    if len(port) < 8:
        return None
    gross = winsorize([p['gross'] for p in port])
    net = winsorize([p['net'] for p in port])
    mg, mn = sum(gross) / len(gross), sum(net) / len(net)
    mc = sum(p['cost'] for p in port) / len(port)
    t_raw = tstat(net)
    t = (t_raw / math.sqrt(overlap)) if t_raw is not None else None
    sh = sharpe_annual(net, periods_per_year)
    if sh is not None:
        sh /= math.sqrt(overlap)
    win = 100 * sum(1 for v in net if v > 0) / len(net)
    return {'label': label, 'dates': len(port), 'indep': len(port) / overlap,
            'gross': mg, 'cost': mc, 'net': mn,
            't': t, 't_raw': t_raw, 'sharpe': sh, 'win': win}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region')
    ap.add_argument('--min-price', type=float, default=0.0)
    ap.add_argument('--mode', default='long', choices=['long', 'longshort'])
    ap.add_argument('--neutral', action='store_true',
                    help='excess return vs the same-date cross-section; removes beta')
    ap.add_argument('--min-names', type=int, default=30,
                    help='a date needs this many scored names to rank meaningfully')
    args = ap.parse_args()

    rows = load(args.region, args.min_price)
    if not rows:
        print('No rows match.', file=sys.stderr)
        sys.exit(1)

    scope = (f"region={args.region or 'ALL'}  min_price=${args.min_price:g}  "
             f"mode={args.mode}")
    print(f'\nTOP-K RANKING BACKTEST   {scope}')
    print('=' * 104)
    print(f'  {len(rows):,} ledger rows in scope')
    print('  cost = conservative price-tiered round trip; returns winsorised 1% per tail')
    print('  returns: ' + ('EXCESS vs same-date cross-section (market-neutral)'
                           if args.neutral else 'RAW (includes the market move)'))
    print('  t* and Sharpe* are divided by sqrt(horizon) to correct overlapping windows')

    trials = 0
    results = []
    for h in HORIZONS:
        by_date = observations(rows, h)
        if not by_date:
            continue
        ppy = 252 / int(h)
        print(f'\n  HORIZON {h}d   ({len(by_date)} dates with data)')
        print(f'    {"selection":<16}{"dates":>7}{"indep":>7}{"gross%":>9}{"cost%":>8}'
              f'{"NET%":>9}{"t*":>7}{"Sharpe*":>9}{"win%":>7}  verdict')
        # Baseline: hold everything scored that day. This is what the app does now.
        # The "hold everything" reference is only meaningful on RAW returns. In
        # market-neutral mode the excess return of the whole cross-section is zero by
        # construction, so its variance collapses and the t-stat blows up to
        # nonsense like -1164. Report it as the pure cost drag it actually is.
        allnames = run(by_date, 10 ** 9, args.min_names, 'long', args.neutral)
        s = summarize('all names', allnames, ppy, overlap=int(h))
        if s and args.neutral:
            print(f'    {"all names":<16}{s["dates"]:>7}{s["indep"]:>7.1f}'
                  f'{s["gross"]:>+9.3f}{s["cost"]:>8.2f}{s["net"]:>+9.3f}'
                  f'{"n/a":>7}{"n/a":>9}{"":>7}  reference: zero by construction, '
                  f'shows the cost drag')
            s = None
        if s:
            print(f'    {s["label"]:<16}{s["dates"]:>7}{s["indep"]:>7.1f}{s["gross"]:>+9.3f}{s["cost"]:>8.2f}'
                  f'{s["net"]:>+9.3f}{(s["t"] or 0):>+7.2f}'
                  f'{(s["sharpe"] if s["sharpe"] is not None else 0):>9.2f}{s["win"]:>6.0f}%'
                  f'  reference')
        for k in KS:
            port = run(by_date, k, args.min_names, args.mode, args.neutral)
            s = summarize(f'top {k}', port, ppy, overlap=int(h))
            if not s:
                continue
            trials += 1
            verdict = ('NET POSITIVE' if s['net'] > 0 and (s['t'] or 0) > 2 else
                       'net positive, weak' if s['net'] > 0 else
                       'costs eat it' if s['gross'] > 0 else 'no edge')
            print(f'    {s["label"]:<16}{s["dates"]:>7}{s["indep"]:>7.1f}{s["gross"]:>+9.3f}{s["cost"]:>8.2f}'
                  f'{s["net"]:>+9.3f}{(s["t"] or 0):>+7.2f}'
                  f'{(s["sharpe"] if s["sharpe"] is not None else 0):>9.2f}{s["win"]:>6.0f}%'
                  f'  {verdict}')
            results.append((h, k, s, port, ppy))

    # Out-of-sample split on the best in-sample cell. The winner is selected on the
    # same data it is scored on, so its in-sample number is biased upward by
    # construction; the only meaningful question is whether it survives on dates it
    # was not chosen from.
    positive = [r for r in results if r[2]['net'] > 0]
    print(f'\n  {trials} (horizon, K) cells tested. '
          f'{len(positive)} had a positive net return.')
    if positive:
        h, k, s, port, ppy = max(positive, key=lambda r: (r[2]['t'] or 0))
        dates = sorted(p['date'] for p in port)
        cut = dates[int(len(dates) * 0.7)]
        first = [p for p in port if p['date'] < cut]
        last = [p for p in port if p['date'] >= cut]
        print(f'\n  OUT-OF-SAMPLE CHECK on the best cell: horizon {h}d, top {k}')
        for name, part in (('first 70% of dates', first), ('last 30% of dates', last)):
            ss = summarize(name, part, ppy, overlap=int(h))
            if ss:
                print(f'    {ss["label"]:<20}{ss["dates"]:>5} dates   '
                      f'net {ss["net"]:+.3f}%   t {(ss["t"] or 0):+.2f}   '
                      f'win {ss["win"]:.0f}%')
        print('    A cell that is positive in the first half and negative in the second')
        print('    is a fitting artifact, not an edge.')

        # How much more data would it take to KNOW? t scales with sqrt(n), so the
        # required number of independent periods is n * (2 / t)^2. This turns "not
        # significant" into a schedule instead of a shrug, and it distinguishes the
        # two reasons a result can fail: economics (cost > edge, hopeless) versus
        # statistics (edge > cost but too few periods, just early).
        t_now = s['t'] or 0.0
        indep_now = s['indep']
        if t_now > 0:
            need = indep_now * (2.0 / t_now) ** 2
            extra_days = max(0.0, (need - indep_now) * int(h))
            print(f'\n  HOW MUCH MORE DATA WOULD SETTLE IT (best cell: {h}d top {k})')
            print(f'    gross {s["gross"]:+.3f}%  vs  cost {s["cost"]:.2f}%   '
                  f'-> economics are {"fine" if s["gross"] > s["cost"] else "the problem"}')
            print(f'    independent periods now : {indep_now:.1f}')
            print(f'    needed for t* = 2       : {need:.0f}')
            print(f'    additional trading days : about {extra_days:.0f} '
                  f'({extra_days / 21:.0f} months of ledger)')
            if s['gross'] > s['cost']:
                print('    The edge exceeds the cost, so this is a SAMPLE-SIZE problem,')
                print('    not an economic one. It cannot be resolved by more features,')
                print('    only by more forward-graded time.')

    print(f'\n  TRIAL COUNT: {trials} cells, plus the slices already swept by')
    print('  ic_decompose. Around 20 independent tries produce a false p<0.05 by')
    print('  chance, so no single t>2 here is evidence on its own.')
    print()


if __name__ == '__main__':
    main()
