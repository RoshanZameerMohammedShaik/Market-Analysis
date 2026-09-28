"""Assert earnings_calendar.py and js/earnings-calendar-slice.js answer identically.

Same rationale as tools/band_sync_check.py: this decision selects which z family draws the band,
so a disagreement means the band a user sees is not the band the cron locked and graded, silently.

The fixtures deliberately cover the cases that are easy to get wrong:
  * an announcement AT the close (moves the next session, not that one)
  * one just before the close (moves that session)
  * one on a Friday evening (moves Monday)
  * ASX, whose session's UTC date is the day before its own local date
  * TYO's 15:30 close (extended in Nov 2024; a 15:00 table puts a 15:15 release a day late)
  * a symbol absent from the slice (unknown, NOT "no earnings")
  * crypto (known-none, never unknown)

Run: python tools/earnings_sync_check.py
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import earnings_calendar as ec  # noqa: E402

passed = failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}' + (f'  -> {detail}' if detail else ''))


def epoch(y, mo, d, h, mi):
    return int(datetime.datetime(y, mo, d, h, mi, tzinfo=datetime.timezone.utc).timestamp())


# A synthetic slice, so the check does not depend on whatever the calendar happens to hold today.
SLICE = {
    'generatedAt': 'fixture',
    'symbols': {
        'ATCLOSE':   [epoch(2026, 10, 29, 20, 0)],    # 16:00 New York, exactly the close
        'PRECLOSE':  [epoch(2026, 10, 29, 19, 0)],    # 15:00 New York, before the close
        'FRIDAYPM':  [epoch(2026, 10, 30, 21, 0)],    # Friday 17:00 New York -> Monday
        'EMPTY':     [],
        'ASXNAME.AX': [epoch(2026, 10, 29, 3, 0)],    # 14:00 Sydney, mid-session
        'TYONAME.T':  [epoch(2026, 10, 29, 6, 15)],   # 15:15 Tokyo, before the 15:30 close
    },
}

# (symbol, region, band day-1 session date)
CASES = [
    ('ATCLOSE', 'NYSE', '2026-10-26'),
    ('ATCLOSE', 'NYSE', '2026-10-29'),
    ('ATCLOSE', 'NYSE', '2026-10-30'),
    ('PRECLOSE', 'NYSE', '2026-10-26'),
    ('PRECLOSE', 'NYSE', '2026-10-29'),
    ('FRIDAYPM', 'NYSE', '2026-10-28'),
    ('FRIDAYPM', 'NYSE', '2026-11-02'),
    ('EMPTY', 'NYSE', '2026-10-26'),
    ('MISSING', 'NYSE', '2026-10-26'),
    ('BTC-USD', 'CRYPTO', '2026-10-26'),
    ('ASXNAME.AX', 'ASX', '2026-10-26'),
    ('ASXNAME.AX', 'ASX', '2026-10-29'),
    ('TYONAME.T', 'TYO', '2026-10-26'),
    ('TYONAME.T', 'TYO', '2026-10-29'),
    ('TYONAME.T', 'TYO', '2026-10-30'),
]
# Session-date fixtures: (region, utc epoch)
SESSION_CASES = [
    ('NYSE', epoch(2026, 9, 28, 23, 30)),
    ('ASX', epoch(2026, 9, 28, 23, 30)),
    ('LSE', epoch(2026, 9, 28, 23, 30)),
    ('TYO', epoch(2026, 9, 26, 6, 0)),      # a Saturday in Tokyo -> back to Friday
    ('NYSE', epoch(2026, 9, 27, 14, 0)),    # a Sunday in New York -> back to Friday
]


def main():
    fd, tmp = tempfile.mkstemp(suffix='.json', dir=os.path.join(REPO, 'tools'))
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'slice': SLICE, 'cases': CASES, 'sessionCases': SESSION_CASES}, f)
        proc = subprocess.run(['node', os.path.join('tools', 'earnings_sync_check.mjs'), tmp, REPO],
                              capture_output=True, text=True, cwd=REPO)
    finally:
        os.remove(tmp)
    if proc.returncode != 0 or not proc.stdout.strip():
        print('ERROR: node harness failed.', file=sys.stderr)
        print(proc.stderr[:1500], file=sys.stderr)
        sys.exit(1)
    js = json.loads(proc.stdout)

    print('\n=== which band day does an announcement move? ===')
    for i, (sym, region, sess) in enumerate(CASES):
        py = ec.earnings_day(sym, region, datetime.date.fromisoformat(sess), slice_=SLICE)
        j = js['cases'][i]
        check(f'{sym} {region} from {sess}: {py}', py == j, f'python {py} vs js {j}')

    print('\n=== exchange-local session date ===')
    for i, (region, t) in enumerate(SESSION_CASES):
        py = ec.session_date_for(region, t)
        j = js['sessionCases'][i]
        check(f'{region} at {datetime.datetime.fromtimestamp(t, datetime.timezone.utc):%Y-%m-%d %H:%MZ}: {py}',
              py is not None and py.isoformat() == j, f'python {py} vs js {j}')

    print('\n=== the states mean what they say ===')
    # These are the assertions that stop a refactor from collapsing three states into two.
    check('an absent symbol is unknown (None), not "no earnings"',
          ec.earnings_day('MISSING', 'NYSE', datetime.date(2026, 10, 26), slice_=SLICE) is None)
    check('an empty list is a real "none inside the band" (0)',
          ec.earnings_day('EMPTY', 'NYSE', datetime.date(2026, 10, 26), slice_=SLICE) == 0)
    check('crypto is known-none even with no slice at all',
          ec.earnings_day('BTC-USD', 'CRYPTO', datetime.date(2026, 10, 26), slice_=None) == 0)
    check('an announcement AT the close moves the NEXT session',
          ec.reaction_date(epoch(2026, 10, 29, 20, 0), 'NYSE') == datetime.date(2026, 10, 30))
    check('one before the close moves THAT session',
          ec.reaction_date(epoch(2026, 10, 29, 19, 0), 'NYSE') == datetime.date(2026, 10, 29))
    check('a Friday evening release moves Monday',
          ec.reaction_date(epoch(2026, 10, 30, 21, 0), 'NYSE') == datetime.date(2026, 11, 2))
    check('Tokyo closes at 15:30, so 15:15 moves that session',
          ec.reaction_date(epoch(2026, 10, 29, 6, 15), 'TYO') == datetime.date(2026, 10, 29))
    check('an already-reacted announcement is not counted again',
          ec.earnings_day('PRECLOSE', 'NYSE', datetime.date(2026, 10, 30), slice_=SLICE) == 0)

    print(f'\nEARNINGS SYNC {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
