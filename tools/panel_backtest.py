"""Cross-sectional top-K test on the HISTORICAL replay panel. The statistically
powered version of tools/topk_backtest.py.

WHY A SECOND TOOL
-----------------
topk_backtest.py reads the live ledger, which holds 3 months and therefore about 1.9
independent 20-day observations. That is why its best cell could not clear t*=2, and
why I wrongly said the answer needed 6 more months of waiting. The bars going back a
decade were free the whole time.

tools/replay_history.py replays the SAME engine over 12 years and writes a
per-prediction panel. Twelve symbols alone yield 147 independent 20-day periods. This
tool runs the identical statistics against that panel, so the question is finally
being asked with enough data to answer it.

EVERY GUARD FROM THE LEDGER VERSION IS KEPT, BECAUSE EACH ONE CAUGHT A REAL LIE
------------------------------------------------------------------------------
  * MARKET-NEUTRAL excess returns. Holding everything for 20 days "worked" at t=2.93
    on the ledger purely because the window rose. Beta is not skill.
  * OVERLAP CORRECTION, t and Sharpe divided by sqrt(horizon). Consecutive h-day
    forward returns share h-1 days; uncorrected, a 20-day horizon inflates t about
    4.5x and turned a t*=0.94 into a headline t=6.00.
  * CONSERVATIVE, price-tiered COSTS that round against us.
  * 1% WINSORISATION per tail, because two unflagged splits once moved a 1,096-row
    mean from -0.07% to +2.59%.
  * PER-DATE statistics, never pooled trades.
  * A REAL out-of-sample split by TIME, plus a pre-2026 window flag, since the
    engine's mean-reversion tilt was fitted on 2026 outcomes.
  * TRIAL COUNT printed.

Usage:
    python tools/panel_backtest.py
    python tools/panel_backtest.py --until 2026-01-01     # excludes the tuning era
    python tools/panel_backtest.py --min-price 5 --neutral
"""
import argparse
import collections
import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    'ic_decompose', os.path.join(REPO, 'tools', 'ic_decompose.py'))
_ic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ic)
round_trip_cost_pct, winsorize, spearman = (_ic.round_trip_cost_pct, _ic.winsorize,
                                            _ic.spearman)

PANEL = os.path.join(REPO, 'model', 'replay_panel.jsonl')
HORIZONS = ('1', '3', '5', '10', '20')
KS = (5, 10, 20, 50)


def tstat(vals):
    n = len(vals)
    if n < 3:
        return None
    m = sum(vals) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in vals) / (n - 1))
    return (m / (sd / math.sqrt(n))) if sd > 0 else None


def load(path, since=None, until=None, min_price=0.0):
    """Panel grouped by date. Each entry: score, forward returns, cost."""
    by_date = collections.defaultdict(list)
    n = 0
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            d = r.get('d')
            if not d or (since and d < since) or (until and d >= until):
                continue
            p = r.get('p')
            if not isinstance(p, (int, float)) or p < min_price:
                continue
            c = round_trip_cost_pct(p)
            if c is None:
                continue
            by_date[d].append({'s': r.get('s'), 'sc': r.get('sc'),
                               'r': r.get('r') or {}, 'cost': c,
                               'sig': r.get('sig'), 'cf': r.get('cf')})
            n += 1
    return by_date, n


def portfolio(by_date, h, k, min_names, mode, neutral, invert=False):
    out = []
    for d in sorted(by_date):
        names = [x for x in by_date[d]
                 if isinstance(x['r'].get(h), (int, float))
                 and isinstance(x['sc'], (int, float))]
        if len(names) < min_names:
            continue
        rets = {x['s']: x['r'][h] for x in names}
        if neutral:
            mkt = sum(rets.values()) / len(rets)
            rets = {s: v - mkt for s, v in rets.items()}
        # --invert buys the LOWEST-scored names. This is not a fishing expedition
        # suggested by the same data: prior independent research on this project
        # (2026-08-19) established that reversal components carry POSITIVE IC while
        # momentum components carry NEGATIVE IC in this universe, and that Hot
        # Picks, which ranks on |daily move|, is a measured anti-signal at -4.60%
        # over 20 days (t -4.14), replicating Barber/Huang/Odean/Schwarz JF 2022.
        # The engine blends both families, so a negative score-return relationship
        # at longer horizons is the predicted outcome, and inverting is the
        # pre-registered response to it.
        ranked = sorted(names, key=lambda x: (x['sc'] if invert else -x['sc']))
        longs = ranked[:k]
        if mode == 'long':
            legs = [(rets[n['s']], n['cost']) for n in longs]
        else:
            shorts = ranked[-k:]
            legs = ([(rets[n['s']], n['cost']) for n in longs]
                    + [(-rets[n['s']], n['cost']) for n in shorts])
        if not legs:
            continue
        g = sum(x[0] for x in legs) / len(legs)
        c = sum(x[1] for x in legs) / len(legs)
        out.append({'date': d, 'gross': g, 'cost': c, 'net': g - c})
    return out


def summarize(label, port, h):
    if len(port) < 12:
        return None
    overlap = int(h)
    gross = winsorize([p['gross'] for p in port])
    net = winsorize([p['net'] for p in port])
    mg = sum(gross) / len(gross)
    mn = sum(net) / len(net)
    mc = sum(p['cost'] for p in port) / len(port)
    t_raw = tstat(net)
    t = t_raw / math.sqrt(overlap) if t_raw is not None else None
    sd = math.sqrt(sum((v - mn) ** 2 for v in net) / (len(net) - 1)) if len(net) > 2 else 0
    ppy = 252 / overlap
    sh = ((mn / sd) * math.sqrt(ppy) / math.sqrt(overlap)) if sd > 0 else None
    win = 100 * sum(1 for v in net if v > 0) / len(net)
    return {'label': label, 'dates': len(port), 'indep': len(port) / overlap,
            'gross': mg, 'cost': mc, 'net': mn, 't': t, 'sharpe': sh, 'win': win}


def line(s, verdict):
    print(f'    {s["label"]:<14}{s["dates"]:>7,}{s["indep"]:>8.0f}'
          f'{s["gross"]:>+9.3f}{s["cost"]:>7.2f}{s["net"]:>+9.3f}'
          f'{(s["t"] or 0):>+7.2f}{(s["sharpe"] or 0):>8.2f}{s["win"]:>6.0f}%  {verdict}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--panel', default=PANEL)
    ap.add_argument('--since')
    ap.add_argument('--until')
    ap.add_argument('--min-price', type=float, default=0.0)
    ap.add_argument('--min-names', type=int, default=30)
    ap.add_argument('--mode', default='long', choices=['long', 'longshort'])
    ap.add_argument('--invert', action='store_true',
                    help='buy the LOWEST-scored names (see portfolio() note)')
    ap.add_argument('--neutral', action='store_true', default=True)
    ap.add_argument('--raw', dest='neutral', action='store_false',
                    help='include the market move (shows how much is beta)')
    args = ap.parse_args()

    if not os.path.exists(args.panel):
        print(f'{args.panel} not found. Run tools/replay_history.py first.',
              file=sys.stderr)
        sys.exit(1)

    by_date, n = load(args.panel, args.since, args.until, args.min_price)
    if not by_date:
        print('Panel empty after filters.', file=sys.stderr)
        sys.exit(1)
    dates = sorted(by_date)
    print(f'\nPANEL BACKTEST  {n:,} predictions, {len(dates):,} dates, '
          f'{dates[0]} .. {dates[-1]}')
    print('=' * 100)
    print(f'  mode={args.mode}{" INVERTED" if args.invert else ""}  '
          f'min_price=${args.min_price:g}  '
          f'returns={"EXCESS vs same-date cross-section" if args.neutral else "RAW (with beta)"}')
    print('  t* and Sharpe* corrected by sqrt(horizon) for overlapping windows')

    trials, results = 0, []
    for h in HORIZONS:
        print(f'\n  HORIZON {h}d')
        print(f'    {"selection":<14}{"dates":>7}{"indep":>8}{"gross%":>9}{"cost%":>7}'
              f'{"NET%":>9}{"t*":>7}{"Sharpe*":>8}{"win%":>7}  verdict')
        ref = portfolio(by_date, h, 10 ** 9, args.min_names, 'long', args.neutral,
                        args.invert)
        s = summarize('all names', ref, h)
        if s:
            if args.neutral:
                print(f'    {"all names":<14}{s["dates"]:>7,}{s["indep"]:>8.0f}'
                      f'{s["gross"]:>+9.3f}{s["cost"]:>7.2f}{s["net"]:>+9.3f}'
                      f'{"n/a":>7}{"n/a":>8}{"":>7}  zero by construction; cost drag')
            else:
                line(s, 'reference: this is the MARKET')
        for k in KS:
            port = portfolio(by_date, h, k, args.min_names, args.mode,
                             args.neutral, args.invert)
            s = summarize(f'top {k}', port, h)
            if not s:
                continue
            trials += 1
            sig = (s['t'] or 0) > 2
            verdict = ('SIGNIFICANT + net positive' if sig and s['net'] > 0 else
                       'significant but net negative' if sig else
                       'net positive, not significant' if s['net'] > 0 else
                       'no edge')
            line(s, verdict)
            results.append((h, k, s, port))

    print(f'\n  {trials} (horizon, K) cells tested.')
    winners = [r for r in results if r[2]['net'] > 0 and (r[2]['t'] or 0) > 2]
    print(f'  {len(winners)} were net-positive AND reached t* > 2.')
    if winners:
        print('\n  CELLS THAT CLEARED BOTH BARS')
        for h, k, s, _ in sorted(winners, key=lambda r: -(r[2]['t'] or 0)):
            print(f'    {h}d top {k}: net {s["net"]:+.3f}%  t* {s["t"]:+.2f}  '
                  f'Sharpe* {s["sharpe"]:.2f}  {s["indep"]:.0f} indep periods')
        h, k, s, port = max(winners, key=lambda r: (r[2]['t'] or 0))
        ds = sorted(p['date'] for p in port)
        cut = ds[int(len(ds) * 0.7)]
        for name, part in (('first 70% of dates', [p for p in port if p['date'] < cut]),
                           ('last 30% of dates', [p for p in port if p['date'] >= cut])):
            ss = summarize(name, part, h)
            if ss:
                print(f'    OOS {ss["label"]:<20}{ss["dates"]:>6,} dates  '
                      f'net {ss["net"]:+.3f}%  t* {(ss["t"] or 0):+.2f}  '
                      f'win {ss["win"]:.0f}%')

    print(f'\n  TRIAL COUNT: {trials} cells here. About 20 independent tries produce a')
    print('  false p<0.05, so require the sign to hold in BOTH out-of-sample halves')
    print('  and across neighbouring K values, not just one cell clearing t*=2.')
    print('  SURVIVORSHIP: the panel uses today\'s symbol list, so delisted names are')
    print('  absent and every return here is optimistic. See replay_history.py.')
    print()


if __name__ == '__main__':
    main()
