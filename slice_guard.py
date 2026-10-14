"""Never publish a nightly slice that is older than the one already published.

WHY: on 2026-10-14 the 22:26 UTC run published the volatility outlook for the 10-13 close, and a
second run at 01:21 UTC, during a window when Yahoo's daily feed had dropped the 10-13 bars again,
overwrote it with a slice for 10-12. The page then said "from the Oct 12 close" a day after the
Oct 13 close, and that day's NYSE rows lost the blended band sizing, which only applies when the
slice is for the session the band starts from.

Writers call feed_session_ok() with the session their data reaches. It retries the caller's fetch
while the feed is behind the exchange calendar, and says whether to publish at all.
"""
import datetime
import json
import sys
import time

from forecast_band import last_completed_session


def published_session(path):
    """The sessionDate already published at `path`, or None."""
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f).get('sessionDate')
    except (OSError, ValueError, AttributeError):
        return None


def feed_session_ok(path, fetch_session, region='NYSE', tries=3, wait_s=120, now=None, sleep=time.sleep):
    """(ok, session). fetch_session() returns the ISO session the caller's data reaches (or None).

    While that is behind the calendar's last completed session it is fetched again, up to `tries`
    times. Then: publish when the result is at least as new as what is already published, else
    keep the published one (ok=False). A feed that is behind but still newer than the published
    file is published, since it is an improvement.
    """
    want = last_completed_session(region, now or datetime.datetime.now(datetime.timezone.utc))
    want = want.isoformat() if want else None
    session = None
    for attempt in range(tries):
        session = fetch_session()
        if not want or (session and session >= want):
            break
        if attempt < tries - 1:
            print(f'  [wait] the feed reaches {session}, the calendar says {want} has closed; '
                  f'fetching again in {wait_s}s', file=sys.stderr)
            sleep(wait_s)
    have = published_session(path)
    if session and have and have > session:
        print(f'  [keep] {path} already has session {have}, and the feed only reaches {session}: '
              f'not overwriting it with an older one', file=sys.stderr)
        return False, session
    return bool(session), session
