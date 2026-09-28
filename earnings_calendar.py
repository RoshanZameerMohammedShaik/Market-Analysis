"""Upcoming earnings, and which day of the 7-session band an announcement lands on.

WHY THE BAND NEEDS THIS
-----------------------
The band's z values are fitted per (volatility tier, horizon) over every window, and 5-6% of
those windows contain an earnings release. Those windows move 1.5-2.5x further than the rest,
so a single z is too wide for ordinary weeks and far too narrow for earnings weeks. Measured
held-out (train 2021-23, test 2024-26, the app's own 92-stock calibration sample): the 80% band
covered 51.5% of windows that contain earnings and 81.1% of the others. Calibrating the two
separately moved earnings windows to 73.5% and trimmed ordinary-week bands ~3%, with overall
coverage unchanged (79.4%).

THREE STATES, NOT TWO
---------------------
  None  unknown: no calendar entry for this symbol. The band uses the pooled z it always used,
        so a symbol we know nothing about is exactly as well served as before.
  0     known: no announcement reacts inside the band's sessions. Ordinary-week z.
  r     1-7: the first band day the announcement moves. Earnings z from day r on.

A REACTION DAY, NOT AN ANNOUNCEMENT DATE
----------------------------------------
Announced before the close (pre-market or intraday) moves that session; announced after the
close moves the next one. Times are converted in the exchange's own timezone with zoneinfo
(bot/sessions.py is the one table of hours), so DST is handled rather than approximated.

js/earnings-calendar.js mirrors this; tools/band_sync_check.py holds the two together.
"""
from __future__ import annotations

import datetime
import json
import os

try:
    from zoneinfo import ZoneInfo
except Exception:                                   # pragma: no cover
    ZoneInfo = None

from bot.sessions import MARKETS

_HERE = os.path.dirname(os.path.abspath(__file__))
SLICE_PATH = os.path.join(_HERE, 'model', 'earnings.json')
BAND_SESSIONS = 7

_slice = None
_slice_tried = False


def load_slice(path=None):
    """model/earnings.json, memoised. None when it has not been published."""
    global _slice, _slice_tried
    if path is None and _slice_tried:
        return _slice
    try:
        with open(path or SLICE_PATH, encoding='utf-8') as f:
            s = json.load(f)
        if not isinstance(s.get('symbols'), dict):
            s = None
    except Exception:
        s = None
    if path is None:
        _slice, _slice_tried = s, True
    return s


def _is_session_day(d, spec):
    return d.weekday() in spec['days']


def reaction_date(announce_epoch, region):
    """Exchange-local DATE of the session an announcement first moves, or None."""
    spec = MARKETS.get(str(region).upper())
    if not spec or ZoneInfo is None:
        return None
    local = datetime.datetime.fromtimestamp(int(announce_epoch), datetime.timezone.utc).astimezone(ZoneInfo(spec['tz']))
    close_h, close_m = spec['close']
    d = local.date()
    # Before the close on a session day moves that session; at or after the close, the next one.
    if not (_is_session_day(d, spec) and (local.hour, local.minute) < (close_h, close_m)):
        d += datetime.timedelta(days=1)
    while not _is_session_day(d, spec):
        d += datetime.timedelta(days=1)
    return d


def session_date_for(region, epoch=None):
    """Exchange-LOCAL date of the session in progress (or most recent) at `epoch`.

    Not the UTC date. ASX opens at 23:00 UTC, so a Sydney session's UTC date is the day before
    its own; using the UTC date there would shift the whole band by one session and read the
    earnings day off the wrong row. Returns None without zoneinfo rather than guessing.
    """
    spec = MARKETS.get(str(region).upper())
    if not spec or ZoneInfo is None:
        return None
    t = datetime.datetime.fromtimestamp(int(epoch if epoch is not None else datetime.datetime.now(datetime.timezone.utc).timestamp()),
                                        datetime.timezone.utc).astimezone(ZoneInfo(spec['tz']))
    d = t.date()
    while not _is_session_day(d, spec):
        d -= datetime.timedelta(days=1)
    return d


def band_dates(session_date, region, n=BAND_SESSIONS):
    """The n session dates the band's rows describe, day 1 = session_date."""
    spec = MARKETS.get(str(region).upper())
    if not spec:
        return []
    out, d = [], session_date
    while not _is_session_day(d, spec):
        d += datetime.timedelta(days=1)
    while len(out) < n:
        if _is_session_day(d, spec):
            out.append(d)
        d += datetime.timedelta(days=1)
    return out


def earnings_day(symbol, region, session_date, slice_=None, n=BAND_SESSIONS):
    """None (unknown) | 0 (none inside the band) | 1..n (first band day an announcement moves).

    session_date: exchange-local date of band day 1 (the session the band opens on).
    """
    reg = str(region or '').upper()
    if reg == 'CRYPTO':
        return 0                                   # no earnings, ever: ordinary z
    s = slice_ if slice_ is not None else load_slice()
    if not s or reg not in MARKETS:
        return None
    entry = s['symbols'].get(str(symbol).upper())
    if entry is None:
        return None                                # never asked: unknown, pooled z
    dates = band_dates(session_date, reg, n)
    if not dates:
        return None
    first = 0
    for t in entry:
        rd = reaction_date(t, reg)
        if rd is None:
            continue
        # An announcement that already moved an EARLIER session is priced in by now.
        if rd < dates[0] or rd > dates[-1]:
            continue
        r = dates.index(rd) + 1 if rd in dates else 0
        if r and (first == 0 or r < first):
            first = r
    return first
