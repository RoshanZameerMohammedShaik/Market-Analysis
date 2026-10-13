"""Calibrate the LIVE "today" range: how far price can still go before today's close.

WHY
---
The band for a day is fixed before that session opens. Once the session is trading, two things
are known that the morning band could not know: where the price is now, and how high and low it
has already been. The rest of the day only has the time left to move in, so the honest range for
"today" narrows as the session runs, and it can never be narrower than the range already traded.

    live low  = min(low so far,  price * exp(-z * sigma * sqrt(f)))
    live high = max(high so far, price * exp(+z * sigma * sqrt(f)))

f is the share of the session still to trade (lunch breaks excluded) and sigma the same daily
volatility the band uses. z is NOT assumed: for every hourly mark of two years of sessions, this
measures how far the rest of the day actually went beyond the range already traded, in
sigma*sqrt(f) units, and takes the 80% quantile per (volatility tier, f bucket). Both sides count:
a day is inside only when neither the remaining high nor the remaining low escapes.

Data: Yahoo 60-minute bars (the 730-day limit) for the same live-universe sample the band is
calibrated on, plus daily bars for sigma from sessions strictly before the day.

Output: model/band_intraday.json, read by js/ui/forecast-cards.js.
Run: python tools/calibrate_intraday.py
"""
import datetime
import json
import math
import os
import statistics
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, 'tools'))

import forecast_band as fb  # noqa: E402

OUT = os.path.join(REPO, 'model', 'band_intraday.json')
TARGET = 0.80
F_EDGES = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0001]
TIER_EDGES = [(0.0, 0.015, 'calm'), (0.015, 0.025, 'normal'), (0.025, 0.040, 'active'), (0.040, 9.99, 'wild')]


def tier_for(s):
    for lo, hi, name in TIER_EDGES:
        if lo <= s < hi:
            return name
    return TIER_EDGES[-1][2]


def f_bucket(f):
    for i in range(len(F_EDGES) - 1):
        if F_EDGES[i] <= f < F_EDGES[i + 1]:
            return i
    return len(F_EDGES) - 2


def symbol_obs(sym, yf):
    """[(tier, f, z_required)] for one symbol."""
    import pandas as pd
    h = yf.download(sym, period='730d', interval='60m', progress=False, auto_adjust=False)
    d = yf.download(sym, period='3y', interval='1d', progress=False, auto_adjust=False)
    if h is None or d is None or h.empty or d.empty:
        return []
    for x in (h, d):
        if hasattr(x.columns, 'levels'):
            x.columns = x.columns.get_level_values(0)
    h = h.dropna(subset=['High', 'Low', 'Close'])
    d = d.dropna(subset=['High', 'Low', 'Close'])
    daily = [{'high': float(r.High), 'low': float(r.Low), 'close': float(r.Close)} for r in d.itertuples()]
    ddates = [i.date() for i in d.index]
    # Hourly bars carry the exchange's own timezone; their local date is the session.
    idx = h.index
    local_dates = [t.date() for t in idx]
    out = []
    sessions = {}
    for i, ld in enumerate(local_dates):
        sessions.setdefault(ld, []).append(i)
    for day, ids in sessions.items():
        if len(ids) < 3:
            continue
        # sigma from daily bars strictly before this session
        k = None
        for j in range(len(ddates) - 1, -1, -1):
            if ddates[j] < day:
                k = j
                break
        if k is None or k < 30:
            continue
        s = fb.range_sigma(daily[:k + 1], 30)
        if not s:
            continue
        tier = tier_for(s)
        hi = [float(h.High.iloc[i]) for i in ids]
        lo = [float(h.Low.iloc[i]) for i in ids]
        cl = [float(h.Close.iloc[i]) for i in ids]
        # Bar durations: the gap to the next bar, the last bar ends like the median bar.
        t = [idx[i].timestamp() for i in ids]
        dur = [min(t[j + 1] - t[j], 3600) for j in range(len(t) - 1)]
        dur.append(min(3600, statistics.median(dur) if dur else 3600))
        total = sum(dur)
        if total <= 0:
            continue
        for j in range(len(ids) - 1):
            rem = sum(dur[j + 1:])
            f = rem / total
            if f <= 0.01:
                continue
            p = cl[j]
            hs, ls = max(hi[:j + 1]), min(lo[:j + 1])
            hr, lr = max(hi[j + 1:]), min(lo[j + 1:])
            unit = s * math.sqrt(f)
            need_up = math.log(hr / p) / unit if hr > hs else 0.0
            need_dn = math.log(p / lr) / unit if lr < ls else 0.0
            out.append((tier, f, max(need_up, need_dn, 0.0)))
    return out


def main():
    import yfinance as yf
    import calibrate_bands as cb
    sample = cb.ledger_universe_sample() or cb.FALLBACK_SAMPLE
    print(f'Intraday calibration over {len(sample)} symbols (60-minute bars, 730 days)...', flush=True)
    obs = {}
    used = 0
    for n, sym in enumerate(sample):
        try:
            rows = symbol_obs(sym, yf)
        except Exception as e:
            print(f'  [skip] {sym}: {type(e).__name__}', file=sys.stderr)
            continue
        if rows:
            used += 1
        for tier, f, z in rows:
            obs.setdefault((tier, f_bucket(f)), []).append(z)
        time.sleep(0.4 if n % 20 else 1.0)
    z = {}
    counts = {}
    for (tier, b), zs in sorted(obs.items()):
        counts[f'{tier}:{b}'] = len(zs)
        if len(zs) < 300:
            continue
        zs.sort()
        q = zs[min(len(zs) - 1, int(math.ceil(TARGET * len(zs))) - 1)]
        z.setdefault(tier, {})[str(b)] = round(q, 4)
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'method': 'rest-of-day excursion beyond the range so far, in sigma*sqrt(f) units, 80% quantile per (tier, f bucket)',
        'targetConfidence': TARGET, 'fEdges': F_EDGES[:-1] + [1.0],
        'tierEdges': [[lo, hi, name] for lo, hi, name in TIER_EDGES],
        'z': z, 'sampleCounts': counts, 'symbolsUsed': used,
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=1, allow_nan=False)
    print(f'Wrote {OUT} from {used} symbols')
    for tier in ('calm', 'normal', 'active', 'wild'):
        print(f'  {tier:<7}', '  '.join(f'f{F_EDGES[b]:.1f}-{min(F_EDGES[b + 1], 1):.1f}: {z.get(tier, {}).get(str(b), "-")} (n={counts.get(f"{tier}:{b}", 0):,})'
                                       for b in range(len(F_EDGES) - 1)))


if __name__ == '__main__':
    main()
