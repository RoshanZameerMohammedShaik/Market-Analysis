"""Calibrated High/Low forecast bands. Python side.

THE ONE Python implementation. tools/band_sync_check.py imports from here rather
than keeping its own copy, and record_predictions.py uses it so the ledger stores
the same band the browser draws. js/forecast-band.js is the mirror, and the parity
job fails the build if the two drift.

Why this exists at all: the cron was writing the OLD ATR-and-confidence-scaled
targets into the ledger while the browser had already switched to the calibrated
band. So the scorecard was grading a forecast nobody sees. Containment measured
52.6% on 2026-08-24 where the calibrated band delivers 80.0%.

Method, identical to the JS:
  1. daily sigma = max(Parkinson high-low, close-to-close), with data guards
  2. scale by sqrt(horizon)
  3. band = price * exp(+/- z * sigma * sqrt(h)), z LOADED from calibration
     per (volatility tier, horizon), never assumed

Guards exist because live symbols print high == low on 60 of 60 days, which
collapses Parkinson to 0.00% and mislabels a violent penny stock as "calm".
"""
import json
import math
import os
import statistics

from price_round import round_price

_HERE = os.path.dirname(os.path.abspath(__file__))
CAL_PATH = os.path.join(_HERE, 'model', 'band_calibration.json')

# MUST match js/forecast-band.js and tools/calibrate_bands.py.
MIN_PRICE = 0.01
MAX_SIGMA = 0.50
MIN_LIVE_BARS = 20
VOL_LOOKBACK = 30
CLOSE_SETTLE_MIN = 10

_cal = None
_cal_tried = False


def load_calibration(path=None):
    """Load and memoise model/band_calibration.json. None if unavailable."""
    global _cal, _cal_tried
    if _cal is not None:
        return _cal
    if _cal_tried and path is None:
        return None
    _cal_tried = True
    try:
        with open(path or CAL_PATH, encoding='utf-8') as f:
            c = json.load(f)
        if not c.get('z') or not isinstance(c.get('targetConfidence'), (int, float)):
            return None
        _cal = c
        return _cal
    except Exception:
        return None


def range_sigma(candles, n=VOL_LOOKBACK):
    """Daily sigma over the last n candles, robust to untraded days.

    candles: iterable of dicts with 'high', 'low', 'close'.

    Parkinson is ~5x more efficient than close-to-close WHEN the asset trades
    continuously, but collapses toward zero on a name that prints high == low.
    Close-to-close cannot be hidden that way, so max() never understates.
    """
    if not candles:
        return None
    tail = list(candles)[-n:]
    good = [c for c in tail
            if c.get('high') and c.get('low')
            and c['high'] > 0 and c['low'] > 0 and c['high'] >= c['low']]
    if len(good) < math.ceil(n * 0.7):
        return None

    live = sum(1 for c in good if c['high'] > c['low'] * 1.0000001)
    pk = 0.0
    if live >= MIN_LIVE_BARS:
        pk = math.sqrt(statistics.mean([math.log(c['high'] / c['low']) ** 2 for c in good])
                       / (4 * math.log(2)))

    rets = []
    for i in range(1, len(tail)):
        a, b = tail[i - 1].get('close'), tail[i].get('close')
        if a and b and a > 0 and b > 0:
            rets.append(math.log(b / a))
    cc = statistics.stdev(rets) if len(rets) > 5 else 0.0

    s = max(pk, cc)
    return s if 0 < s <= MAX_SIGMA else None


def tier_for(sigma, tier_edges):
    for lo, hi, name in tier_edges:
        if lo <= sigma < hi:
            return name
    return tier_edges[-1][2]


# ── WHERE A BAND STARTS ──────────────────────────────────────────────────────────────────────────
#
# A band is anchored on the LAST COMPLETED SESSION'S CLOSE, and day 1 is the session after it.
# That is exactly what tools/calibrate_bands.py measures (c0 = a close, day h = the h-th session
# after it), so it is the only anchor the fitted z values describe.
#
# Until 2026-10-13 the cron anchored on close[-1] at whatever moment it ran. When it ran after the
# open, that was a live price inside today's session, and the grader then scored the band against
# the NEXT session, so a band sized for one session had to hold roughly two. Those rows held the
# "80%" band 69.6% of the time, while rows whose start point matched the calibration held 86-88%.
# Same band, same z: only the start point differed.

def bar_is_complete(region, bar_date, now=None):
    """Has the session this daily bar belongs to closed? bar_date: a date, exchange-local.

    Crypto bars are UTC days. Equities use the exchange's own close in its own timezone
    (bot/sessions.py MARKETS), so DST needs no table. An unknown region is treated as complete,
    which is what every caller assumed before this existed.
    """
    import datetime
    now = now or datetime.datetime.now(datetime.timezone.utc)
    reg = str(region or '').upper()
    if reg == 'CRYPTO':
        return bar_date < now.astimezone(datetime.timezone.utc).date()
    try:
        from zoneinfo import ZoneInfo
        from bot.sessions import MARKETS
        spec = MARKETS[reg]
        local = now.astimezone(ZoneInfo(spec['tz']))
    except Exception:
        return True
    if bar_date < local.date():
        return True
    if bar_date > local.date():
        return False
    # Ten minutes past the bell, so a closing auction has printed into the daily bar.
    return local.hour * 60 + local.minute >= spec['close'][0] * 60 + spec['close'][1] + CLOSE_SETTLE_MIN


def next_session(region, iso):
    """Exchange-local ISO date of the first session strictly AFTER `iso` (holidays skipped)."""
    import datetime
    d = datetime.date.fromisoformat(iso) + datetime.timedelta(days=1)
    reg = str(region or '').upper()
    if reg == 'CRYPTO':
        return d.isoformat()
    try:
        import market_sessions
        from bot.sessions import MARKETS
        days = MARKETS[reg]['days']
    except Exception:
        market_sessions, days = None, (0, 1, 2, 3, 4)
    for _ in range(15):
        ok = market_sessions.is_session(reg, d, weekdays=days) if market_sessions else d.weekday() in days
        if ok:
            return d.isoformat()
        d += datetime.timedelta(days=1)
    return d.isoformat()


def band_anchor(dates, region, now=None):
    """Index of the bar a band starts from: the last one whose session has closed.

    dates: exchange-local dates of the daily bars, oldest first. Returns None when there is no
    completed bar.
    """
    if not dates:
        return None
    k = len(dates) - 1
    if not bar_is_complete(region, dates[k], now):
        k -= 1
    return k if k >= 0 else None


def _z_tables(c, mode, earnings_day):
    """z table for each horizon, given what is known about earnings (see earnings_calendar.py).

    None  -> the pooled table, fitted over every window: exactly the band before this existed.
    0 / r -> the ordinary-week table before day r, the earnings table from day r on. Only when
             the calibration carries both, an older file keeps the pooled table throughout.
    """
    cumulative = mode == 'cumulative'
    pooled = c['z'] if cumulative else c.get('zPerDay') or c['z']
    earn = c.get('zEarn' if cumulative else 'zPerDayEarn')
    ordinary = c.get('zNoEarn' if cumulative else 'zPerDayNoEarn')
    if earnings_day is None or not earn or not ordinary:
        return lambda h: pooled, False
    return (lambda h: earn if (earnings_day and h >= earnings_day) else ordinary), True


def forecast_bands(candles, current_price, mode='perDay', cal=None, earnings_day=None):
    """7-day High/Low band. Returns None when it cannot be stated honestly.

    mode='perDay'     day h's OWN session extremes. What the UI shows.
    mode='cumulative' the running extremes across h days. Wider, and the correct
                      basis for a STOP, since a stop can be hit on any day.
    earnings_day      None (unknown), 0 (none inside the band) or the first band day an
                      earnings announcement moves. From earnings_calendar.earnings_day().
    """
    c = cal or load_calibration()
    if not c:
        return None
    try:
        price = float(current_price)
    except (TypeError, ValueError):
        return None
    if not (price > 0):
        return None
    # Sub-penny assets are EXCLUDED from the calibration sample (see MIN_PRICE in
    # tools/calibrate_bands.py), so the z values were never validated at this
    # price scale and applying them here is extrapolation. The band is still
    # returned, because hiding it would blank 39 of 170 crypto names including
    # SHIB, BONK and FLOKI, but it is flagged so the UI cannot claim a measured
    # confidence for it. This is exactly the distinction the `calibrated` flag
    # exists to carry: show the number, label what backs it.
    below_cal_floor = price < MIN_PRICE

    sigma = range_sigma(candles, c.get('volLookbackDays', VOL_LOOKBACK))
    if not sigma:
        return None

    edges = [tuple(e) for e in c['tierEdges']]
    tier = tier_for(sigma, edges)
    table = c['z'] if mode == 'cumulative' else c.get('zPerDay') or c['z']
    if tier not in table:
        return None
    table_for, earnings_aware = _z_tables(c, mode, earnings_day)

    days = []
    for h in c['horizons']:
        # A split cell too thin to fit falls back to the pooled one rather than dropping the row.
        z = (table_for(h).get(tier) or {}).get(str(h))
        if z is None:
            z = table[tier].get(str(h))
        if z is None:
            continue
        dist = z * sigma * math.sqrt(h)
        hi = price * math.exp(dist)
        lo = price * math.exp(-dist)
        days.append({'day': h, 'low': round_price(lo), 'high': round_price(hi),
                     'widthPct': round((hi / price - 1) * 100, 2)})
    if not days:
        return None
    return {
        'mode': mode,
        'calibrated': not below_cal_floor,
        'uncalibratedReason': 'sub-penny: outside calibration sample' if below_cal_floor else None,
        'confidence': round(c['targetConfidence'] * 100),
        'sigmaDaily': round(sigma * 100, 2),
        'volTier': tier,
        'calibratedAt': c.get('generatedAt'),
        # Which z family drew the rows: None = pooled (earnings unknown), 0 = ordinary weeks,
        # r = earnings z from band day r. The UI marks those rows.
        'earningsDay': earnings_day if earnings_aware else None,
        'days': days,
    }
