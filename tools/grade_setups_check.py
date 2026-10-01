"""Pin the live grader to the published rule, on bars built so each outcome is known in advance.

Run: python tools/grade_setups_check.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade_setups import grade, summarize, wilson  # noqa: E402

passed = failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}  -> {detail}')


def bars_from(closes, opens=None):
    opens = opens or closes
    return [(f'2026-01-{i + 1:02d}', float(o), float(c)) for i, (o, c) in enumerate(zip(opens, closes))]


E = {'session': '2026-01-08', 'symbol': 'T', 'signalClose': 90, 'tier': 'normal', 'vixBand': 'low',
     'rsi2': 3, 'hitRate': 0.67, 'expNetBps': 25}
base = [100, 100, 100, 100, 100, 100, 95, 90]          # session is index 7 (2026-01-08)

# Recovers on day 2: close 101 > MA5 of [100,95,90,92,101]; exit at the NEXT open (102).
b = bars_from(base + [92, 101, 103], opens=base + [91, 95, 102])
r = grade(E, b)
check('trigger fires on the first close above the 5-day average', r['status'] == 'closed' and r['held'] == 2, r)
check('enters at the open after the signal, not the signal close', r['entry'] == 91, r.get('entry'))
check('exits at the open after the trigger', r['exit'] == 102 and r['exitDate'] == '2026-01-11', r)
check('a profitable exit is a recovery, net of 6 bps', r['won'] and abs(r['netBps'] - (1e4 * __import__('math').log(102 / 91) - 6)) < 0.2, r)

# Trigger fired at the last bar we have: it is exiting, not closed, and not graded yet.
r = grade(E, bars_from(base + [92, 101], opens=base + [91, 95]))
check('a trigger on the latest bar waits for the exit open', r['status'] == 'exiting', r['status'])

# Still inside the window, no trigger: open, with a mark.
r = grade(E, bars_from(base + [88, 87, 86], opens=base + [89, 88, 87]))
check('inside the window without a trigger stays open', r['status'] == 'open' and r['held'] == 3, r)

# Never recovers: sells at the open after the 10th session, and loses.
down = [89 - i for i in range(11)]
r = grade(E, bars_from(base + down, opens=base + [x + 0.5 for x in down]))
check('times out after 10 sessions at the next open', r['status'] == 'closed' and r['held'] == 10 and r['timedOut'], r)
check('and a loss is not a recovery', not r['won'] and r['netBps'] < 0, r.get('netBps'))

# Not tradable yet.
check('no bar after the signal is pending', grade(E, bars_from(base))['status'] == 'pending')

rows = [{'status': 'closed', 'won': True, 'netBps': 50, 'hitRate': 0.67, 'expNetBps': 25}] * 3 + \
       [{'status': 'closed', 'won': False, 'netBps': -80, 'hitRate': 0.67, 'expNetBps': 25},
        {'status': 'open', 'hitRate': 0.67, 'expNetBps': 25}]
s = summarize(rows)
check('summary counts only closed trades', s['n'] == 4 and s['wins'] == 3 and s['open'] == 1, s)
check('and carries what the backtest expected for them', s['expectedHitRate'] == 0.67 and s['expectedNetBps'] == 25, s)
lo, hi = wilson(3, 4)
check('a 3-of-4 record is wide, not 75% flat', lo < 0.35 and hi > 0.9, (lo, hi))

print(f'\nGRADE SETUPS CHECK {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
