"""Put back a completed session that Yahoo's daily feed left out, from that symbol's hourly bars.

WHY: the daily feed sometimes omits the previous session's bar for the first hours of the next one.
At 08:08 UTC on 2026-10-14 SAP.DE and AZN.L came back with 10-12 and the live 10-14 bar but no
10-13, and at 00:03 UTC every crypto pair was missing 10-13. The band then started from a close two
sessions old, so its day 1 was a session that had already finished (161 crypto, 39 LSE, 29 XETRA
and 11 NSE rows that day). Rebuilt bars matched the real ones when the feed caught up: high and low
exact, close within 0.01-0.08% (the closing auction).

Light on purpose (numpy and the calendar only, yfinance imported when it is actually needed), so
tools/resolver_check.py can test it on a runner that only installs numpy.
"""
import datetime

import numpy as np

from forecast_band import band_anchor, last_completed_session, next_session


def sessions_from_intraday(stamps, opens, highs, lows, closes, vols, region, wanted):
    """Daily bars for the `wanted` session dates, built from 60-minute bars. {iso: (c, h, l, v)}.

    stamps are tz-aware timestamps. A session is only rebuilt when its hourly bars reach its final
    hour (and, for crypto, cover most of the UTC day): a half-built bar would be a fresh lie, so a
    session the hourly feed does not fully cover stays missing.
    """
    from zoneinfo import ZoneInfo
    reg = str(region or '').upper()
    if reg == 'CRYPTO':
        tz, last_start, min_bars = datetime.timezone.utc, 22 * 60, 20
    else:
        from bot.sessions import MARKETS
        spec = MARKETS[reg]
        tz = ZoneInfo(spec['tz'])
        last_start, min_bars = spec['close'][0] * 60 + spec['close'][1] - 90, 3
    by_day = {}
    for ts, o, h, l, c, v in zip(stamps, opens, highs, lows, closes, vols):
        if not (h > 0 and l > 0 and c > 0):
            continue
        loc = ts.astimezone(tz)
        iso = loc.date().isoformat()
        if iso in wanted:
            by_day.setdefault(iso, []).append((loc.hour * 60 + loc.minute, h, l, c, v if v == v else 0.0))
    out = {}
    for iso, bars in by_day.items():
        bars.sort()
        if len(bars) < min_bars or bars[-1][0] < last_start:
            continue
        out[iso] = (bars[-1][3], max(b[1] for b in bars), min(b[2] for b in bars), sum(b[4] for b in bars))
    return out


def fill_session_gap(symbol, region, close, high, low, volume, bar_dates, now_utc, fetch=None):
    """Put back completed sessions the daily feed left out (see forecast_band.last_completed_session).

    Returns (close, high, low, volume, bar_dates, rebuilt ISO dates). Each missing session is
    rebuilt from that symbol's own 60-minute bars, so the band starts from the right close and the
    indicators see yesterday. When the hourly feed cannot rebuild it either, nothing is invented:
    the series is returned as it came and the band starts from the older close, which is still a
    true forecast for the sessions after it.
    """
    k = band_anchor(bar_dates, region, now_utc)
    want = last_completed_session(region, now_utc)
    if k is None or want is None or bar_dates[k] >= want:
        return close, high, low, volume, bar_dates, []
    missing, d = [], bar_dates[k].isoformat()
    for _ in range(10):
        d = next_session(region, d)
        if d > want.isoformat():
            break
        missing.append(d)
    if not missing:
        return close, high, low, volume, bar_dates, []
    try:
        if fetch is not None:
            stamps, o, h, l, c, v = fetch(symbol)
        else:
            import yfinance as yf
            df = yf.download(symbol, period='5d', interval='60m', progress=False, auto_adjust=False)
            if df is None or df.empty:
                return close, high, low, volume, bar_dates, []
            if hasattr(df.columns, 'levels'):
                df.columns = df.columns.get_level_values(0)
            idx = df.index if df.index.tz is not None else df.index.tz_localize('UTC')
            stamps = [t.to_pydatetime() for t in idx]
            o, h, l, c, v = (df[col].values.astype(float) for col in ('Open', 'High', 'Low', 'Close', 'Volume'))
    except Exception:
        return close, high, low, volume, bar_dates, []
    built = sessions_from_intraday(stamps, o, h, l, c, v, region, set(missing))
    # Only a contiguous run straight after the last complete bar can be inserted, so the series
    # never skips a session it claims to have.
    run = []
    for iso in missing:
        if iso not in built:
            break
        run.append(iso)
    if not run:
        return close, high, low, volume, bar_dates, []
    cut = k + 1
    ins = [built[iso] for iso in run]
    close = np.concatenate([close[:cut], [b[0] for b in ins], close[cut:]])
    high = np.concatenate([high[:cut], [b[1] for b in ins], high[cut:]])
    low = np.concatenate([low[:cut], [b[2] for b in ins], low[cut:]])
    volume = np.concatenate([volume[:cut], [b[3] for b in ins], volume[cut:]])
    bar_dates = list(bar_dates[:cut]) + [datetime.date.fromisoformat(iso) for iso in run] + list(bar_dates[cut:])
    return close, high, low, volume, bar_dates, run
