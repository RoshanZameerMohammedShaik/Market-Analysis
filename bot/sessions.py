"""When is each market actually open? The gate that decides whether Mia may trade.

WHY THIS EXISTS
---------------
Roshan's rule: crypto around the clock, equities only during their own sessions. Without
this gate a 15-minute cadence would "trade" NYSE at 3am against a stale closing price and
book fills that could never have happened. Every one of those would corrupt the record
the whole experiment depends on.

DST IS HANDLED BY zoneinfo, NOT BY HARDCODED OFFSETS
----------------------------------------------------
The existing cron encodes opens as UTC cron expressions with comments like "13:30 UTC
(winter) / 14:30 UTC (summer DST)", which means it is simply wrong for half the year. That
is tolerable for a once-a-day snapshot and not tolerable for a gate that decides whether
the market is open right now. Real timezones, real transitions.

HOLIDAYS ARE HANDLED BY DATA, NOT BY A CALENDAR
-----------------------------------------------
No exchange holiday list is bundled. A hardcoded list rots silently and differs per
market. Instead the runner checks that the data it just fetched is FRESH: if the market
should be open but the latest bar is not from today, the market is closed and the run
idles. That is self-maintaining and it also catches half-days, unscheduled closures and
data outages, none of which a calendar would.

STAGING, STATED HONESTLY
------------------------
Every market's hours are in the table so adding one is a config change. But only NYSE and
CRYPTO are enabled by default, because non-US markets need their own fee schedules before
their P/L means anything, and the differences are not small:

  * UK stamp duty is 0.5% on every PURCHASE. That single tax is larger than any edge
    measured anywhere in this project, so an LSE sleeve without it would be pure fiction.
  * IBKR's commission schedules differ per venue (percentage-of-value with local-currency
    minimums, not the US per-share model).
  * Non-USD markets need FX at trade time; the portfolio is USD-internal.

Approximating those would produce numbers that look precise and are wrong, which is worse
than a smaller universe. They get added when their fees are modelled properly.
"""
from __future__ import annotations

import datetime

try:
    from zoneinfo import ZoneInfo
    _TZ_OK = True
except Exception:                                   # pragma: no cover
    _TZ_OK = False

CRYPTO = 'CRYPTO'

# name -> (tz, open, close, lunch_start, lunch_end, weekdays)
# Times are LOCAL to the exchange; zoneinfo converts, so DST is automatic.
# weekdays uses Python's Monday=0.
MARKETS = {
    'NYSE':  {'tz': 'America/New_York', 'open': (9, 30), 'close': (16, 0),
              'lunch': None, 'days': (0, 1, 2, 3, 4), 'currency': 'USD',
              'label': 'New York'},
    'LSE':   {'tz': 'Europe/London', 'open': (8, 0), 'close': (16, 30),
              'lunch': None, 'days': (0, 1, 2, 3, 4), 'currency': 'GBP',
              'label': 'London'},
    'XETRA': {'tz': 'Europe/Berlin', 'open': (9, 0), 'close': (17, 30),
              'lunch': None, 'days': (0, 1, 2, 3, 4), 'currency': 'EUR',
              'label': 'Frankfurt'},
    'NSE':   {'tz': 'Asia/Kolkata', 'open': (9, 15), 'close': (15, 30),
              'lunch': None, 'days': (0, 1, 2, 3, 4), 'currency': 'INR',
              'label': 'Mumbai'},
    # HKEX and TYO close for lunch. Trading through a lunch break would be another
    # stale-price fill, so the break is modelled rather than ignored.
    'HKEX':  {'tz': 'Asia/Hong_Kong', 'open': (9, 30), 'close': (16, 0),
              'lunch': ((12, 0), (13, 0)), 'days': (0, 1, 2, 3, 4), 'currency': 'HKD',
              'label': 'Hong Kong'},
    'TYO':   {'tz': 'Asia/Tokyo', 'open': (9, 0), 'close': (15, 0),
              'lunch': ((11, 30), (12, 30)), 'days': (0, 1, 2, 3, 4), 'currency': 'JPY',
              'label': 'Tokyo'},
    'ASX':   {'tz': 'Australia/Sydney', 'open': (10, 0), 'close': (16, 0),
              'lunch': None, 'days': (0, 1, 2, 3, 4), 'currency': 'AUD',
              'label': 'Sydney'},
}

# Enabled by default. See the staging note in the module docstring.
DEFAULT_MARKETS = ['NYSE', CRYPTO]


def _local_now(tz_name, now_utc=None):
    now_utc = now_utc or datetime.datetime.now(datetime.timezone.utc)
    if not _TZ_OK:
        return None
    return now_utc.astimezone(ZoneInfo(tz_name))


def is_open(market, now_utc=None):
    """(open?, reason). Crypto is always open; equities follow their own clock.

    The reason string is written into the run log so an idle run explains itself instead
    of looking like a failure.
    """
    m = str(market).upper()
    if m == CRYPTO:
        return True, 'crypto trades continuously'

    spec = MARKETS.get(m)
    if not spec:
        return False, f'unknown market {m}'
    if not _TZ_OK:
        # Refusing to trade beats guessing a UTC offset and trading a closed market.
        return False, 'zoneinfo unavailable; refusing to guess session hours'

    local = _local_now(spec['tz'], now_utc)
    if local.weekday() not in spec['days']:
        return False, f"{spec['label']} closed: {local:%A}"

    t = local.time()
    o = datetime.time(*spec['open'])
    c = datetime.time(*spec['close'])
    if not (o <= t < c):
        return False, (f"{spec['label']} closed: local {local:%H:%M} is outside "
                       f"{o:%H:%M}-{c:%H:%M}")
    if spec['lunch']:
        ls, le = datetime.time(*spec['lunch'][0]), datetime.time(*spec['lunch'][1])
        if ls <= t < le:
            return False, (f"{spec['label']} lunch break "
                           f"{ls:%H:%M}-{le:%H:%M}, local {local:%H:%M}")
    return True, f"{spec['label']} open, local {local:%H:%M}"


def open_markets(enabled=None, now_utc=None):
    """Which of the enabled markets are tradeable right now, with reasons for both."""
    enabled = enabled or DEFAULT_MARKETS
    live, closed = [], {}
    for m in enabled:
        ok, why = is_open(m, now_utc)
        (live.append(m) if ok else closed.setdefault(m, why))
    return live, closed


def minutes_to_close(market, now_utc=None):
    """Minutes until the session ends, or None for crypto / closed markets.

    Used to stop opening a NEW position minutes before the bell: an entry that cannot be
    managed until the next session is a different bet from the one the strategy intended.
    """
    m = str(market).upper()
    if m == CRYPTO or m not in MARKETS or not _TZ_OK:
        return None
    ok, _ = is_open(m, now_utc)
    if not ok:
        return None
    spec = MARKETS[m]
    local = _local_now(spec['tz'], now_utc)
    close_at = local.replace(hour=spec['close'][0], minute=spec['close'][1],
                             second=0, microsecond=0)
    return max(0, int((close_at - local).total_seconds() // 60))


def market_of(symbol):
    """Infer the market from the symbol, matching ledger_universe.region_for.

    Structural, not a lookup table: a suffix is how these feeds identify a venue, so a
    new listing needs no registration.
    """
    s = str(symbol).upper()
    if s.endswith('-USD'):
        return CRYPTO
    if s.endswith('.NS'):
        return 'NSE'
    if s.endswith('.L'):
        return 'LSE'
    if s.endswith('.DE'):
        return 'XETRA'
    if s.endswith('.HK'):
        return 'HKEX'
    if s.endswith('.T'):
        return 'TYO'
    if s.endswith('.AX'):
        return 'ASX'
    return 'NYSE'


def describe_week(enabled=None):
    """Coverage summary, for the run log and the UI. Answers 'is she really always on?'
    with a number instead of a claim."""
    enabled = enabled or DEFAULT_MARKETS
    total = 0.0
    parts = []
    for m in enabled:
        if m == CRYPTO:
            parts.append('CRYPTO 24/7 (168h)')
            total = 168.0
            continue
        spec = MARKETS.get(m)
        if not spec:
            continue
        oh = spec['open'][0] + spec['open'][1] / 60
        ch = spec['close'][0] + spec['close'][1] / 60
        hrs = (ch - oh) * len(spec['days'])
        if spec['lunch']:
            lh = ((spec['lunch'][1][0] + spec['lunch'][1][1] / 60)
                  - (spec['lunch'][0][0] + spec['lunch'][0][1] / 60))
            hrs -= lh * len(spec['days'])
        parts.append(f'{m} {hrs:.1f}h/wk')
        total = max(total, hrs)
    return f"{', '.join(parts)} -> ~{total:.0f}h of 168 covered"
