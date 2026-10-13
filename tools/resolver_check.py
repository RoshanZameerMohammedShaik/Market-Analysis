"""Prove the outcome resolver grades each row against its OWN bar.

This guards the single worst defect this project has had. record_outcomes.py
cached one price window per SYMBOL and then indexed it POSITIONALLY
(`closes[h_days]`), so every row of a symbol was graded against a window
anchored to some other row's date. Measured consequences on the live ledger:

  * 84.6% of resolved rows shared a graded close with another row
  * sharing groups spanned up to 86 calendar days
  * the ledger reported 76% BUY and 73% SELL accuracy SIMULTANEOUSLY, which is
    arithmetically impossible
  * the 2026-06-06 mean-reversion tilt was tuned against that leaked metric

Synthetic bars only, so this is deterministic and needs no network.

Run: python tools/resolver_check.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# record_outcomes imports yfinance at module load. Stub it so the test runs
# anywhere, including a CI box with no network and no yfinance installed.
try:
    import yfinance  # noqa: F401
except ImportError:
    import types
    sys.modules['yfinance'] = types.SimpleNamespace(download=lambda *a, **k: None)

import record_outcomes as ro  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


def bars(seq):
    """seq: list of (date, close, high, low)."""
    d = [x[0] for x in seq]
    return {'dates': d, 'close': [x[1] for x in seq], 'high': [x[2] for x in seq],
            'low': [x[3] for x in seq], 'index': {v: i for i, v in enumerate(d)}}


# A rising series, one bar per weekday, so every close is distinct.
SERIES = bars([
    ('2026-03-02', 100.0, 101.0, 99.0),
    ('2026-03-03', 101.0, 102.0, 100.0),
    ('2026-03-04', 102.0, 103.0, 101.0),
    ('2026-03-05', 103.0, 104.0, 102.0),
    ('2026-03-06', 104.0, 105.0, 103.0),
    ('2026-03-09', 105.0, 106.0, 104.0),
    ('2026-03-10', 106.0, 107.0, 105.0),
])

print('=== each row is graded against its OWN anchor ===')
# Two rows, same symbol, different dates. Under the old positional code both
# would have read the same close. They must now differ by exactly one bar.
r1 = {'symbol': 'T', 'date': '2026-03-03', 'entry': 101.0, 'signal': 'BUY', 'horizons': {}}
r2 = {'symbol': 'T', 'date': '2026-03-05', 'entry': 103.0, 'signal': 'BUY', 'horizons': {}}
o1 = ro.resolve_horizon(r1, 1, SERIES)
o2 = ro.resolve_horizon(r2, 1, SERIES)
check('row 1 anchored on its own date', o1 and o1['anchorDate'] == '2026-03-03', str(o1))
check('row 2 anchored on its own date', o2 and o2['anchorDate'] == '2026-03-05', str(o2))
check('the two rows get DIFFERENT graded closes (the original bug)',
      o1['actualClose'] != o2['actualClose'], f"{o1['actualClose']} vs {o2['actualClose']}")
check('row 1 h=1 target is the next bar', o1['targetDate'] == '2026-03-04', o1['targetDate'])
check('row 2 h=1 target is the next bar', o2['targetDate'] == '2026-03-06', o2['targetDate'])
check('h=3 walks three bars forward, not three from the file start',
      ro.resolve_horizon(r1, 3, SERIES)['targetDate'] == '2026-03-06')

print('\n=== entry price wins over the row date when they disagree ===')
# The cron records close[-1] at market open, usually the PREVIOUS session, so a
# row dated 03-05 can legitimately carry 03-04's close. Grading by date would
# treat that as a 1-day forecast when it is really 2.
skew = {'symbol': 'T', 'date': '2026-03-05', 'entry': 102.0, 'signal': 'BUY', 'horizons': {}}
o = ro.resolve_horizon(skew, 1, SERIES)
check('anchored by the price match, not the row date', o['anchorHow'] == 'match-latest', o['anchorHow'])
check('anchor is the bar whose close IS the entry', o['anchorDate'] == '2026-03-04', o['anchorDate'])
check('date fallback is used when no close matches',
      ro.resolve_horizon({'symbol': 'T', 'date': '2026-03-05', 'entry': 999.0,
                          'signal': 'BUY', 'horizons': {}}, 1, SERIES) is None
      or ro.resolve_horizon({'symbol': 'T', 'date': '2026-03-05', 'entry': 102.5,
                             'signal': 'BUY', 'horizons': {}}, 1, SERIES)['anchorHow'] == 'session-date')

print('\n=== the price match is searched NEWEST first (2026-10-13) ===')
# A thin stock printing one close for days. The cron's close[-1] was the most recent of them, so
# the newest matching bar is the anchor. The old oldest-first search took the first match, up to
# four sessions back, and graded 24% of recent stock rows on a window that ended before the
# prediction was made.
THIN = bars([
    ('2026-03-02', 5.00, 5.00, 5.00), ('2026-03-03', 5.00, 5.00, 5.00),
    ('2026-03-04', 5.00, 5.00, 5.00), ('2026-03-05', 5.00, 5.05, 4.95),
    ('2026-03-06', 5.20, 5.25, 5.00), ('2026-03-09', 5.10, 5.20, 5.05),
])
o = ro.resolve_horizon({'symbol': 'TH', 'date': '2026-03-06', 'entry': 5.00, 'signal': 'BUY',
                        'region': 'NYSE', 'predictedAt': '2026-03-06T14:35:00Z', 'horizons': {}}, 1, THIN)
check('several bars share the entry close: the NEWEST before the lock wins',
      o and o['anchorDate'] == '2026-03-05', str(o and o['anchorDate']))
check('so h=1 is the lock session itself, never a session before it',
      o and o['targetDate'] == '2026-03-06', str(o and o['targetDate']))
o = ro.resolve_horizon({'symbol': 'TH', 'date': '2026-03-06', 'entry': 5.20, 'signal': 'BUY',
                        'region': 'NYSE', 'predictedAt': '2026-03-06T14:35:00Z', 'horizons': {}}, 1, THIN)
check("a pre-close lock cannot match its own session's FINAL close",
      o and o['anchorHow'] == 'session-date' and o['anchorDate'] == '2026-03-06', str(o))
o = ro.resolve_horizon({'symbol': 'TH', 'date': '2026-03-06', 'entry': 5.20, 'signal': 'BUY',
                        'region': 'NYSE', 'predictedAt': '2026-03-06T21:30:00Z', 'horizons': {}}, 1, THIN)
check('an after-close lock CAN match its own session close',
      o and o['anchorHow'] == 'match-latest' and o['anchorDate'] == '2026-03-06', str(o))

print('\n=== rows written since 2026-10-13 are anchored on entrySession exactly ===')
o = ro.resolve_horizon({'symbol': 'T', 'date': '2026-03-05', 'entry': 101.0, 'entrySession': '2026-03-03',
                        'signal': 'BUY', 'horizons': {}}, 1, SERIES)
check('entrySession is the anchor, no price search', o and o['anchorHow'] == 'entry-session'
      and o['anchorDate'] == '2026-03-03', str(o))

print('\n=== ASX: the row date is the UTC date, the session is the next Sydney day ===')
# 23:05 UTC on 03-04 is 10:05 in Sydney on 03-05. A live entry there belongs to the 03-05
# session; the UTC row date would have shifted the whole grade back one session.
o = ro.resolve_horizon({'symbol': 'X.AX', 'date': '2026-03-04', 'entry': 103.4, 'signal': 'BUY',
                        'region': 'ASX', 'predictedAt': '2026-03-04T23:05:00Z', 'horizons': {}}, 1, SERIES)
check('anchored on the Sydney session, not the UTC date', o and o['anchorDate'] == '2026-03-05', str(o))

print('\n=== outcomes from the old search are flagged for the nightly regrade ===')
check('entry-match is stale', ro.stale_anchor({'anchorHow': 'entry-match'}))
check('date is stale', ro.stale_anchor({'anchorHow': 'date'}))
check('match-latest is current', not ro.stale_anchor({'anchorHow': 'match-latest'}))
check('an empty horizon is not "stale" (it is unresolved)', not ro.stale_anchor(None))

print('\n=== a FLAT close validates neither direction ===')
FLAT = bars([('2026-03-02', 50.0, 50.0, 50.0), ('2026-03-03', 50.0, 50.0, 50.0),
             ('2026-03-04', 50.0, 50.0, 50.0)])
for sig in ('BUY', 'SELL'):
    o = ro.resolve_horizon({'symbol': 'F', 'date': '2026-03-02', 'entry': 50.0,
                            'signal': sig, 'horizons': {}}, 1, FLAT)
    check(f'{sig} on an unchanged close -> directionMatch is None, not False',
          o['directionMatch'] is None, repr(o['directionMatch']))
    check(f'{sig} flat outcome is marked flat', o['flat'] is True)
o = ro.resolve_horizon({'symbol': 'F', 'date': '2026-03-02', 'entry': 50.0,
                        'signal': 'BUY', 'horizons': {}, 'expectedMove': 1.0}, 1, FLAT)
check('a flat day is NOT scored wrong_dir', o['rangeHit'] != 'wrong_dir', str(o.get('rangeHit')))

print('\n=== direction is still graded correctly when price DOES move ===')
o = ro.resolve_horizon({'symbol': 'T', 'date': '2026-03-02', 'entry': 100.0,
                        'signal': 'BUY', 'horizons': {}}, 1, SERIES)
check('BUY into a rise is a hit', o['directionMatch'] is True)
o = ro.resolve_horizon({'symbol': 'T', 'date': '2026-03-02', 'entry': 100.0,
                        'signal': 'SELL', 'horizons': {}}, 1, SERIES)
check('SELL into a rise is a miss', o['directionMatch'] is False)

print('\n=== corporate actions are quarantined, real penny moves are not ===')
SPLIT = bars([('2026-03-02', 10.0, 10.5, 9.5), ('2026-03-03', 200.0, 210.0, 190.0)])
o = ro.resolve_horizon({'symbol': 'S', 'date': '2026-03-02', 'entry': 10.0,
                        'signal': 'BUY', 'horizons': {}}, 1, SPLIT)
check('a 20x one-day jump is flagged unresolvable',
      o.get('unresolvable') == 'suspected-corporate-action', str(o))
check('and it does NOT contribute a directionMatch', o['directionMatch'] is None)
REAL = bars([('2026-03-02', 1.00, 1.05, 0.95), ('2026-03-03', 1.60, 1.70, 1.55)])
o = ro.resolve_horizon({'symbol': 'P', 'date': '2026-03-02', 'entry': 1.00,
                        'signal': 'BUY', 'horizons': {}}, 1, REAL)
check('a genuine +60% penny move is still graded', o.get('unresolvable') is None
      and o['directionMatch'] is True, str(o))

print('\n=== rows that cannot be graded return None rather than a wrong answer ===')
check('NaN entry -> None', ro.resolve_horizon(
    {'symbol': 'T', 'date': '2026-03-02', 'entry': float('nan'), 'signal': 'BUY',
     'horizons': {}}, 1, SERIES) is None)
check('missing entry -> None', ro.resolve_horizon(
    {'symbol': 'T', 'date': '2026-03-02', 'entry': None, 'signal': 'BUY',
     'horizons': {}}, 1, SERIES) is None)
check('immature window -> None', ro.resolve_horizon(
    {'symbol': 'T', 'date': '2026-03-10', 'entry': 106.0, 'signal': 'BUY',
     'horizons': {}}, 1, SERIES) is None)
check('date absent from the series -> None', ro.resolve_horizon(
    {'symbol': 'T', 'date': '2026-01-01', 'entry': 77.77, 'signal': 'BUY',
     'horizons': {}}, 1, SERIES) is None)

print(f"\n{'RESOLVER CHECK PASS' if not FAIL else 'RESOLVER CHECK FAIL'}: "
      f"{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
