"""Publish each exchange's real trading sessions: model/market_sessions.json.

The band labels its 7 rows with dates, the earnings check asks which of those sessions an
announcement lands on, and the volatility forecast asks whether earnings fall in the next 5. All
of them used to count weekdays, so a holiday shifted every later row by one: Tokyo is closed on
2026-10-12 (Sports Day), NSE on 2026-10-02 (Gandhi Jayanti), HKEX on 2026-10-01 (National Day).

Holidays come from the exchange_calendars library (maintained upstream, regenerated here every
night), not from a list in this repo, bot/sessions.py explains why a bundled list is avoided.
Readers fall back to the weekday rule outside the published window, and say so.

Run: python tools/write_market_sessions.py
"""
import datetime
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'model', 'market_sessions.json')
# App region -> exchange_calendars code. NSE and BSE share their holiday calendar; the library
# carries it as XBOM.
CODES = {'NYSE': 'XNYS', 'LSE': 'XLON', 'XETRA': 'XETR', 'NSE': 'XBOM', 'HKEX': 'XHKG', 'TYO': 'XTKS', 'ASX': 'XASX'}
BACK_DAYS = 40
AHEAD_DAYS = 120


def main():
    import exchange_calendars as xc

    today = datetime.datetime.now(datetime.UTC).date()
    lo, hi = today - datetime.timedelta(days=BACK_DAYS), today + datetime.timedelta(days=AHEAD_DAYS)
    markets = {}
    for region, code in CODES.items():
        # Some exchanges publish holidays a year at a time (the library has XBOM only through
        # the current year), so each market covers only as far as its holidays are KNOWN, and
        # says so in `to`. Past it, readers use the weekday rule and flag the label.
        end = hi
        while True:
            try:
                cal = xc.get_calendar(code, start=(lo - datetime.timedelta(days=10)).isoformat(),
                                      end=(end + datetime.timedelta(days=1)).isoformat())
                break
            except ValueError:
                end = datetime.date(end.year - 1, 12, 30)
                if end < today:
                    raise
        end = min(end, cal.last_session.date())
        sess = cal.sessions_in_range(lo.isoformat(), end.isoformat())
        early = [d for d in cal.early_closes if lo <= d.date() <= end]
        days = [d.date() for d in sess]
        weekdays = [lo + datetime.timedelta(days=k) for k in range((end - lo).days + 1)]
        closed = [d.isoformat() for d in weekdays if d.weekday() < 5 and d not in set(days)]
        markets[region] = {'code': code, 'to': end.isoformat(), 'sessions': [d.isoformat() for d in days],
                           'holidays': closed, 'earlyCloses': [d.strftime('%Y-%m-%d') for d in early]}
    payload = {'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'source': f'exchange_calendars {xc.__version__}', 'from': lo.isoformat(), 'to': hi.isoformat(),
               'markets': markets}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'))
    for r, m in markets.items():
        print(f'  {r:<6} to {m["to"]}: {len(m["sessions"])} sessions, next holidays: {", ".join(h for h in m["holidays"] if h >= today.isoformat())[:60] or "none"}')
    print(f'Wrote {OUT} ({lo} to {hi})')


if __name__ == '__main__':
    sys.exit(main())
