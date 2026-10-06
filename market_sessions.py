"""Exchange trading sessions, holidays included, from model/market_sessions.json.

Published nightly by tools/write_market_sessions.py from the exchange_calendars library. Outside
the published window (or with no file at all) the weekday rule applies, which is what every
caller did before this existed, so a missing file degrades to the old behaviour rather than
breaking. MIRRORED BY js/market-sessions.js, tools/earnings_sync_check.py holds them together.
"""
import datetime
import json
import os

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model', 'market_sessions.json')
_data = None
_tried = False


def load(path=None):
    """The published calendar, memoised. None when unavailable."""
    global _data, _tried
    if path is None and _tried:
        return _data
    try:
        with open(path or PATH, encoding='utf-8') as f:
            d = json.load(f)
        for m in d.get('markets', {}).values():
            m['_set'] = set(m['sessions'])
    except (OSError, ValueError, KeyError):
        d = None
    if path is None:
        _data, _tried = d, True
    return d


def use(d):
    """Install a calendar (tests): same indexing as load()."""
    global _data, _tried
    d = json.loads(json.dumps(d)) if d is not None else None   # index a copy; the caller's stays plain JSON
    for m in (d or {}).get('markets', {}).values():
        m['_set'] = set(m['sessions'])
    _data, _tried = d, True
    return d


def _market(region, data=None):
    d = data if data is not None else load()
    return (d or {}).get('markets', {}).get(str(region or '').upper())


def is_session(region, day, weekdays=(0, 1, 2, 3, 4), data=None):
    """True when `day` (a date) is a trading session for `region`."""
    m = _market(region, data)
    iso = day.isoformat()
    if m and m['sessions'][0] <= iso <= m['to']:
        return iso in m['_set']
    return day.weekday() in weekdays


def covered(region, day, data=None):
    """True when `day` falls inside the published holiday window for `region`."""
    m = _market(region, data)
    return bool(m) and m['sessions'][0] <= day.isoformat() <= m['to']
