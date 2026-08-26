"""SKILL, not accuracy. The measurement that decides whether anything is working.

Accuracy alone has misled this project twice, in opposite directions:

  1. The LSTM's 53.35% was reported against `baseline_random: 50.0`, an ASSUMED
     baseline. Its triple-barrier label's real base rate is 53.58%, so the model
     was indistinguishable from always predicting "up". A wrong baseline turned
     zero skill into an apparent +3.35pp edge.
  2. The ledger reported 71.6% at one day because outcomes were graded against the
     wrong bar. z was +69.95, which is impossible for market direction, and nothing
     in the report said so.

This tool refuses both failure modes:

  * BASELINES ARE MEASURED, never assumed. Every hit rate is shown against the
    majority-class rate ON THE SAME ROWS, plus always-BUY, because equities drift
    up and beating 50% is not the same as beating "buy everything".
  * INFORMATION COEFFICIENT is the headline, not hit rate. IC is the rank
    correlation between the score and the realized move, computed PER DATE and then
    averaged. Per-date matters: on any single day every symbol shares one market
    move, so pooling all rows treats one common factor as thousands of independent
    observations and inflates significance enormously. IC is also far more
    statistically efficient than a binary hit rate at the same sample size.
  * TRIAL COUNT is printed. Per Bailey and Lopez de Prado's False Strategy Theorem,
    no t-statistic is meaningful without knowing how many variants were tried;
    roughly 20 attempts manufacture a false p<0.05 discovery. This report cannot
    know the count, so it says so rather than implying a clean p-value.

Usage:
    python tools/skill_report.py
    python tools/skill_report.py --source ai        # does the AI score earn weight?
    python tools/skill_report.py --since 2026-08-01
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


# ── statistics ───────────────────────────────────────────────────────────────
def spearman(xs, ys):
    """Rank correlation, average ranks for ties. Returns None below 4 points."""
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


def t_stat(values):
    """One-sample t against zero. Used on the per-date IC series."""
    n = len(values)
    if n < 3:
        return None
    m = sum(values) / n
    var = sum((v - m) ** 2 for v in values) / (n - 1)
    sd = math.sqrt(var)
    return (m / (sd / math.sqrt(n))) if sd > 0 else None


def binom_z(k, n, p0):
    if n < 2 or not (0 < p0 < 1):
        return None
    return (k / n - p0) / math.sqrt(p0 * (1 - p0) / n)


# ── data ─────────────────────────────────────────────────────────────────────
def load(since=None):
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
                rows.append(r)
    return rows


def score_of(row, source):
    """The 0-100 score whose skill we are measuring."""
    if source == 'engine':
        return row.get('weightedScore')
    if source == 'confidence':
        return row.get('confidence')
    b = (row.get('breakdown') or {}).get(source) or {}
    if source == 'ai' and b.get('available') is False:
        return None
    return b.get('score')


def usable(row, h, require_fixed=True):
    """The outcome for horizon h, or None. Gated on everything that has produced a
    false number before: legacy positional grading, corporate actions, flat closes."""
    o = (row.get('horizons') or {}).get(h)
    if not o or o.get('unresolvable'):
        return None
    if require_fixed and 'anchorHow' not in o:
        return None      # graded by the broken positional resolver
    pm = o.get('pctMove')
    if not isinstance(pm, (int, float)) or pm != pm:
        return None
    dm = o.get('directionMatch')
    return {'pctMove': pm, 'directionMatch': dm}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since')
    ap.add_argument('--source', default='engine',
                    choices=['engine', 'confidence', 'technical', 'ai'],
                    help='which score to test for skill')
    ap.add_argument('--include-legacy', action='store_true',
                    help='also count rows graded by the OLD positional resolver')
    args = ap.parse_args()

    rows = load(args.since)
    if not rows:
        print('No ledger rows matched.', file=sys.stderr)
        sys.exit(1)
    fixed_only = not args.include_legacy

    dates = sorted({r.get('date') for r in rows if r.get('date')})
    print(f'\nSKILL REPORT  source={args.source}  '
          f'({len(rows):,} rows, {dates[0]} .. {dates[-1]})')
    print('=' * 82)

    scored_any = False
    for h in HORIZONS:
        # Directional hit rate, with the baselines measured on THESE rows.
        n = k = 0
        up_moves = 0
        by_date = collections.defaultdict(list)
        for r in rows:
            o = usable(r, h, fixed_only)
            if not o:
                continue
            sc = score_of(r, args.source)
            if isinstance(sc, (int, float)) and o['pctMove'] != 0:
                by_date[r.get('date')].append((sc, o['pctMove']))

            # The directional call being graded must come FROM the source under
            # test. Using row['signal'] for every source was a real defect: it
            # printed the ENGINE's skill under `--source ai`, so the AI looked like
            # it had been measured when it had not been touched. For the engine we
            # grade the signal that was actually locked; for any other source we
            # derive a call from its own score, which answers the question that
            # matters: if we traded this source alone, would it beat the majority
            # class?
            if args.source == 'engine':
                if r.get('signal') not in ('BUY', 'SELL') or o['directionMatch'] is None:
                    continue
                correct = bool(o['directionMatch'])
            else:
                if not isinstance(sc, (int, float)) or sc == 50 or o['pctMove'] == 0:
                    continue    # 50 is "no opinion"; a flat move validates neither
                correct = (sc > 50) == (o['pctMove'] > 0)
            n += 1
            k += 1 if correct else 0
            if o['pctMove'] > 0:
                up_moves += 1

        if not n and not by_date:
            continue
        scored_any = True
        print(f'\n  HORIZON {h}d')

        if n:
            basis = ('locked signal' if args.source == 'engine'
                     else f'{args.source} score > 50 = up')
            print(f'    graded on                 {basis}')
            acc = 100 * k / n
            always_buy = 100 * up_moves / n
            # The majority class is whichever of up/down is more common here. A
            # model that cannot beat this has learned the class balance, nothing more.
            majority = max(always_buy, 100 - always_buy)
            print(f'    directional hit rate      {acc:>6.2f}%   (n={n:,})')
            print(f'    always-BUY on same rows   {always_buy:>6.2f}%')
            print(f'    majority-class baseline   {majority:>6.2f}%   <- the bar to beat')
            skill = acc - majority
            z = binom_z(k, n, majority / 100)
            verdict = ('no skill: at or below the majority class' if skill <= 0 else
                       'above the majority class' if (z or 0) > 1.96 else
                       'above it, but inside noise')
            print(f'    SKILL                     {skill:>+6.2f} pp  '
                  f'{"z=%+.2f  " % z if z is not None else ""}{verdict}')

        # Information coefficient: per-date, then averaged.
        ics = []
        for d in sorted(by_date):
            pairs = by_date[d]
            if len(pairs) < 8:
                continue      # a rank correlation on a handful of names is noise
            ic = spearman([p[0] for p in pairs], [p[1] for p in pairs])
            if ic is not None:
                ics.append(ic)
        if len(ics) >= 3:
            mean_ic = sum(ics) / len(ics)
            t = t_stat(ics)
            hit = 100 * sum(1 for v in ics if v > 0) / len(ics)
            print(f'    mean IC (per date)        {mean_ic:>+6.4f}  over {len(ics)} dates, '
                  f'{hit:.0f}% positive')
            if t is not None:
                print(f'    IC t-stat                 {t:>+6.2f}   '
                      f'{"detectable" if abs(t) > 2 else "indistinguishable from zero"}')
            # A truthful "70% of calls hit" needs rank correlation near +0.588,
            # since P(sign match) = 1/2 + arcsin(rho)/pi.
            print(f'    for a real 70% hit rate you would need IC about +0.588 '
                  f'({100 * abs(mean_ic) / 0.588:.1f}% of the way)')
        elif by_date:
            print(f'    mean IC: not enough dates with 8+ scored symbols '
                  f'({len(by_date)} dates seen)')

    if not scored_any:
        print(f'\n  Nothing scoreable for source={args.source}.')
        if args.source == 'ai':
            print('  The cron only started recording an `ai` block on 2026-08-26, and')
            print('  its horizons need to mature before skill can be measured. Re-run')
            print('  once record_outcomes has resolved rows written after that date.')

    print('\n  HOW TO READ THIS')
    print('    SKILL is accuracy minus the majority-class baseline. It is the only')
    print('    number that says whether the model learned anything beyond the class')
    print('    balance of its own label. The LSTM scores 53.35% on a label whose base')
    print('    rate is 53.58%, i.e. skill of -0.23pp: no edge, despite looking like')
    print('    +3.35 against an assumed 50%.')
    print('    IC is measured PER DATE because every symbol on one day shares a single')
    print('    market move; pooling dates treats one common factor as thousands of')
    print('    independent observations.')
    print('    TRIAL COUNT: this report cannot know how many variants were tried to')
    print('    reach these numbers. Around 20 attempts produce a false p<0.05 result,')
    print('    so treat any single significant t-stat as a hypothesis, not a finding.')
    print()


if __name__ == '__main__':
    main()
