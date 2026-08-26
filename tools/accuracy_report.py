"""Directional accuracy from the ledger. No network, so it runs in seconds.

Answers the standing questions: how many predictions were made, how many were
right, and whether the confidence number means anything.

tools/daily_report.py is the other half: it answers "did price REACH the predicted
High/Low, and exactly when", which needs per-session price data. This one answers
"did the call go the right way", which is already recorded in the ledger.

Every number here is gated on the things that made previous accuracy claims false:

  ANCHOR    Rows whose outcome predates the resolver fix carry no `anchorHow`, so
            they were graded POSITIONALLY: each row scored against a window
            anchored to some other row's date. 84.6% of them shared a graded close
            with another row, up to 86 days apart, which is how the ledger
            reported 76% BUY and 73% SELL accuracy at the same time. Those rows
            are reported SEPARATELY and never mixed into a headline.

  FLAT      A close that did not move validates neither direction. The old code
            scored it wrong for BUY and wrong for SELL simultaneously.

  SPLITS    A 20x overnight ratio is a corporate action, not a return.

  BASELINE  A hit rate means nothing without one. Equities drift up, so "always
            BUY" is a real benchmark, and beating 50% is not the same as beating
            always-BUY.

Usage:
    python tools/accuracy_report.py
    python tools/accuracy_report.py --engine-version current
    python tools/accuracy_report.py --since 2026-08-01
"""
import argparse
import collections
import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(REPO, 'model', 'ledger')
HORIZONS = ('1', '3', '5', '10', '20')


def z_score(k, n, p0=0.5):
    """Two-sided z for k successes in n trials against p0."""
    if n < 2:
        return 0.0
    return (k / n - p0) / math.sqrt(p0 * (1 - p0) / n)


def verdict(k, n, p0=0.5):
    if n < 30:
        return f'n={n} too small to say'
    z = z_score(k, n, p0)
    if abs(z) < 1.96:
        return 'indistinguishable from chance'
    return ('better than chance' if z > 0 else 'WORSE than chance') + f' (z={z:+.2f})'


def load(since=None, engine=None):
    rows = []
    if not os.path.isdir(LEDGER):
        return rows
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
                if since and (r.get('date') or '') < since:
                    continue
                if engine and r.get('engineVersion') != engine:
                    continue
                rows.append(r)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', help='ISO date lower bound')
    ap.add_argument('--engine-version', help='only rows from this engine version')
    args = ap.parse_args()

    rows = load(args.since, args.engine_version)
    if not rows:
        print('No ledger rows matched.', file=sys.stderr)
        sys.exit(1)

    sig = collections.Counter(r.get('signal') for r in rows)
    dates = sorted({r.get('date') for r in rows if r.get('date')})
    print(f'\nDIRECTIONAL ACCURACY  ({len(rows):,} rows, {dates[0]} to {dates[-1]})')
    print('=' * 78)
    print(f'  Symbols            : {len({r.get("symbol") for r in rows}):,} '
          f'across {len({r.get("region") for r in rows})} regions, {len(dates)} trading dates')
    print(f'  Calls              : BUY {sig.get("BUY",0):,}, SELL {sig.get("SELL",0):,}, '
          f'NEUTRAL {sig.get("NEUTRAL",0):,}, NO_TRADE {sig.get("NO_TRADE",0):,} (abstained)')
    directional = sig.get('BUY', 0) + sig.get('SELL', 0)
    print(f'  Directional calls  : {directional:,} '
          f'({100*directional/len(rows):.1f}% of rows; the rest are not graded for direction)')

    # Split by grading provenance FIRST. Mixing the two is how the 70%+ figure
    # survived as long as it did.
    prov = collections.Counter()
    for r in rows:
        for h in HORIZONS:
            o = (r.get('horizons') or {}).get(h)
            if not o:
                continue
            prov['legacy (no anchorHow: positional grading)' if 'anchorHow' not in o
                 else f'fixed resolver, anchor={o["anchorHow"]}'] += 1
    print('\n  HOW EACH OUTCOME WAS GRADED')
    tot_o = sum(prov.values()) or 1
    for k, v in prov.most_common():
        print(f'    {k:<48}{v:>8,}  {100*v/tot_o:>5.1f}%')
    legacy = sum(v for k, v in prov.items() if k.startswith('legacy'))
    if legacy:
        print(f'    NOTE: {100*legacy/tot_o:.1f}% still carry the broken grading. Run the')
        print('          reresolve-outcomes workflow task to rebuild them.')

    def table(title, keep):
        print(f'\n  {title}')
        print(f'    {"h":>3}{"n":>8}{"correct":>9}{"rate":>8}{"always-BUY":>12}{"":>4}verdict')
        any_row = False
        for h in HORIZONS:
            n = k = 0
            bn = bk = 0
            for r in rows:
                if r.get('signal') not in ('BUY', 'SELL'):
                    continue
                o = (r.get('horizons') or {}).get(h)
                if not o or o.get('unresolvable') or not keep(o):
                    continue
                dm = o.get('directionMatch')
                if dm is None:          # flat: validates neither direction
                    continue
                n += 1
                k += 1 if dm else 0
                # Always-BUY benchmark on the SAME rows: did price rise at all.
                pm = o.get('pctMove')
                if isinstance(pm, (int, float)) and pm != 0:
                    bn += 1
                    bk += 1 if pm > 0 else 0
            if not n:
                continue
            any_row = True
            base = f'{100*bk/bn:>10.1f}%' if bn else f'{"n/a":>11}'
            print(f'    {h:>3}{n:>8,}{k:>9,}{100*k/n:>7.1f}%{base}    {verdict(k, n)}')
        if not any_row:
            print('    (no rows in this group)')

    table('GRADED BY THE FIXED RESOLVER  <- the only trustworthy numbers',
          lambda o: 'anchorHow' in o)
    table('LEGACY POSITIONAL GRADING  <- known broken, shown for contrast only',
          lambda o: 'anchorHow' not in o)

    # Does confidence carry information? Fixed-resolver rows only.
    print('\n  DOES THE CONFIDENCE NUMBER MEAN ANYTHING?  (1-day, fixed resolver)')
    buckets = collections.defaultdict(lambda: [0, 0])
    xs, ys = [], []
    for r in rows:
        if r.get('signal') not in ('BUY', 'SELL'):
            continue
        o = (r.get('horizons') or {}).get('1')
        if not o or 'anchorHow' not in o or o.get('unresolvable'):
            continue
        dm = o.get('directionMatch')
        c = r.get('confidence')
        if dm is None or not isinstance(c, (int, float)):
            continue
        b = int(c // 10 * 10)
        buckets[b][0] += 1
        buckets[b][1] += 1 if dm else 0
        xs.append(c)
        ys.append(1 if dm else 0)
    if not xs:
        print('    no fixed-resolver rows yet')
    else:
        print(f'    {"bucket":>9}{"n":>8}{"correct":>9}{"rate":>8}')
        for b in sorted(buckets):
            n, k = buckets[b]
            if n < 10:
                continue
            print(f'    {str(b)+"-"+str(b+9):>9}{n:>8,}{k:>9,}{100*k/n:>7.1f}%')
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        sx = math.sqrt(sum((a - mx) ** 2 for a in xs) / len(xs))
        sy = math.sqrt(sum((b - my) ** 2 for b in ys) / len(ys))
        rho = (sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / len(xs) / (sx * sy)
               if sx * sy else 0.0)
        crit = 1.96 / math.sqrt(len(xs))
        print(f'\n    corr(confidence, correct) = {rho:+.4f}  on n={len(xs):,}  '
              f'(detectable beyond +/-{crit:.4f})')
        # The SIGN matters as much as the magnitude, and a bare "significant" label
        # on a negative correlation reads as good news when it means the opposite:
        # the confidence number would be mildly ANTI-predictive, i.e. worse than
        # having no confidence number at all.
        if abs(rho) <= crit:
            call = 'NO INFORMATION: the number is decoration'
        elif rho < 0:
            call = ('INVERTED: higher confidence goes with slightly WORSE accuracy. '
                    'Statistically detectable, economically trivial, but it is not '
                    'evidence the score works, it is weak evidence against it.')
        else:
            call = 'positive, but see the magnitude below before trusting it'
        print(f'    {call}')
        # P(sign match) = 1/2 + arcsin(rho)/pi, so an HONEST 70% needs rho ~ 0.588.
        print(f'    A truthful "70% of our BUY calls hit" needs corr about +0.588. '
              f'This is {rho:+.4f}, about {abs(rho)/0.588*100:.1f}% of the way there.')

    print()


if __name__ == '__main__':
    main()
