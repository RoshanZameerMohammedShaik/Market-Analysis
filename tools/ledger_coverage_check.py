"""Did every region actually WRITE on every day it should have?

WHY THIS EXISTS
---------------
On 2026-08-27 the NYSE cron ran, analysed its universe, wrote 924 rows to the runner's
disk, and then failed in the commit step. The runner was destroyed and every one of those
rows went with it. The ledger simply has a hole:

    date          NYSE  CRYPTO   NSE  HKEX   TYO   ASX   LSE  XETRA
    2026-08-26     647     170    66    29    30     -    39     29
    2026-08-27       -     170    66    29    30    29    39     29

Nothing noticed. The workflow emailed a failure, which is easy to miss among the ones that
are transient and self-heal, and no check ever asked the only question that matters: is
the day's data actually there?

A market open cannot be replayed. Once a day is missed it is gone permanently, which makes
DETECTION the entire value here: a hole found the next morning can at least be understood
and annotated, while a hole found in six months silently corrupts every accuracy figure
computed over that window.

This is the same class of blind spot as the eleven-week stale deployment: every local check
was green while the thing that mattered was broken, because nothing was checking the
OUTCOME rather than the code.

WHY IT IS NOT A HARD FAILURE
----------------------------
Legitimate gaps exist and must not cry wolf:
  * exchange holidays differ per venue and are not modelled anywhere in this repo
  * a genuinely dead region (a feed change) should surface as a trend, not one red run
  * the current UTC day is normally incomplete by design

So it reports and warns. Run it in the nightly job with continue-on-error, and read it.

Usage:
    python tools/ledger_coverage_check.py
    python tools/ledger_coverage_check.py --days 30
    python tools/ledger_coverage_check.py --strict     # exit 1 on any hole
"""
import argparse
import collections
import datetime
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(REPO, 'model', 'ledger')

# Expected row count per region, from the observed steady state. A region writing far
# FEWER rows than usual is its own failure mode (a partial universe from throttling) and
# would otherwise look identical to a healthy day.
#
# `days` is the set of UTC WEEKDAYS on which that region's cron fires, using Python's
# Monday=0. These come from the cron expressions in .github/workflows/live-ledger.yml and
# they are NOT all Mon-Fri, which matters:
#
#   ASX fires at 23:05 UTC on cron days 0-4, which is SUNDAY through THURSDAY in UTC,
#   because 23:05 UTC is already the next morning in Sydney. So an ASX row dated Sunday is
#   correct and an ASX row dated Friday is impossible.
#
# Getting this wrong is not cosmetic. My first version assumed Mon-Fri for every equity
# venue and reported 2026-08-21 ASX as a missing day when that cron never runs on a Friday.
# A coverage check that cries wolf is one nobody reads, which would defeat the entire point
# of adding it.
MON, TUE, WED, THU, FRI, SAT, SUN = 0, 1, 2, 3, 4, 5, 6
WEEKDAYS = (MON, TUE, WED, THU, FRI)
EXPECTED = {
    'NYSE':   {'rows': 600, 'days': WEEKDAYS},
    'CRYPTO': {'rows': 150, 'days': (MON, TUE, WED, THU, FRI, SAT, SUN)},
    'NSE':    {'rows': 60,  'days': WEEKDAYS},
    'HKEX':   {'rows': 25,  'days': WEEKDAYS},
    'TYO':    {'rows': 25,  'days': WEEKDAYS},
    'ASX':    {'rows': 25,  'days': (SUN, MON, TUE, WED, THU)},
    'LSE':    {'rows': 35,  'days': WEEKDAYS},
    'XETRA':  {'rows': 25,  'days': WEEKDAYS},
}


def load(days):
    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    by = collections.defaultdict(collections.Counter)
    if not os.path.isdir(LEDGER):
        return by
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
                d = r.get('date')
                if d and d >= cutoff:
                    by[d][r.get('region')] += 1
    return by


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--strict', action='store_true',
                    help='exit 1 on any hole (default: report and exit 0)')
    args = ap.parse_args()

    by = load(args.days)
    if not by:
        print('No ledger rows in range.', file=sys.stderr)
        sys.exit(1)

    today = datetime.date.today().isoformat()
    regions = list(EXPECTED)
    print(f'\nLEDGER COVERAGE  last {args.days} days')
    print('=' * 88)
    print(f"  {'date':<12}{'dow':<5}" + ''.join(f'{r:>8}' for r in regions))

    holes, thin = [], []
    for d in sorted(by):
        date = datetime.date.fromisoformat(d)
        dow = date.strftime('%a')
        cells = []
        for r in regions:
            n = by[d][r]
            spec = EXPECTED[r]
            expected_today = date.weekday() in spec['days']
            # '.' distinguishes "not scheduled" from '-' meaning "scheduled and absent",
            # so the table itself shows why a blank is or is not a problem.
            cells.append(f'{n if n else ("-" if expected_today else "."):>8}')
            # The current day is legitimately mid-flight, so never flag it.
            if d == today or not expected_today:
                continue
            if n == 0:
                holes.append((d, r))
            elif n < spec['rows'] * 0.5:
                thin.append((d, r, n, spec['rows']))
        print(f'  {d:<12}{dow:<5}' + ''.join(cells))

    print()
    if holes:
        print(f'  {len(holes)} MISSING day/region combination(s):')
        for d, r in holes:
            print(f'    {d}  {r}  wrote nothing')
        print('    A market open cannot be replayed, so these are permanent. The usual')
        print('    cause is a run whose analysis succeeded and whose COMMIT failed, which')
        print('    destroys the rows with the runner.')
    if thin:
        print(f'  {len(thin)} PARTIAL day/region combination(s) under half the usual count:')
        for d, r, n, exp in thin:
            print(f'    {d}  {r}  {n} rows vs ~{exp} expected')
        print('    Usually Yahoo throttling mid-run rather than a hard failure.')
    if not holes and not thin:
        print('  COVERAGE OK: every region wrote on every expected day in range.')

    # Emit a GitHub Actions annotation so this is visible in the run summary rather than
    # only in the step log, which nobody scrolls.
    if os.environ.get('GITHUB_ACTIONS') and (holes or thin):
        msg = f'{len(holes)} missing and {len(thin)} partial region-days in the last {args.days}'
        print(f'::warning title=Ledger coverage gap::{msg}')

    print()
    if args.strict and (holes or thin):
        sys.exit(1)


if __name__ == '__main__':
    main()
