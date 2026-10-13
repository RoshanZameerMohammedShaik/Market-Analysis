"""The one direction signal that measured better than a coin flip: don't chase a big gap up.

WHY THIS EXISTS
---------------
On 2026-10-13 every documented direction effect with free data was tested on 486 liquid US names,
2014-2026: earnings surprises and drift, analyst upgrades and downgrades, 52-week highs and
momentum, short interest, implied volatility, a downside mirror of the pullback setup, and a
93-feature model on all of it (held-out AUC 0.51, a coin flip). One effect cleared its base rate
by a wide margin, every year but one: a liquid stock that OPENS at least twice its normal daily
move above yesterday's close, with no earnings within a session, closed below that open 58% of
the time against 49% for other sessions (tools/_exp7, q5_other.py). It is about the rest of THAT
session only: the next session is a coin flip again.

So the card uses it for exactly one thing: on such a morning it says DON'T BUY, don't chase the
open. It never turns it into a short, because the payoff is thin (its 95% lower bound goes
negative at 10 bps of costs) and some of those opening prints sit at the day's high.

DEFINITIONS (identical to the test)
-----------------------------------
liquid   20-day average dollar volume >= $50M and close >= $5, as of the day BEFORE the gap
sigma    max(Parkinson, close-to-close) over the 30 sessions ending the day before (the band's)
gap      log(open / previous close); a signal when gap >= 2 * sigma
earnings no reaction session the day before, the day of, or the day after
outcome  close below the open; payoff of fading it, before and after 6 bps of costs

Output: model/gap_fade.json, read by js/ui/forecast-cards.js.
Run: python tools/calibrate_gap_fade.py
"""
import datetime
import json
import math
import os
import sys

import numpy as np
import pandas as pd

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
OUT = os.path.join(REPO, 'model', 'gap_fade.json')
K = 2.0
COST_BPS = 6.0
MIN_DV, MIN_PX = 5e7, 5.0
FIRST_YEAR = 2014


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - m) / d, (c + m) / d


def main():
    earn = json.load(open(os.path.join(CACHE, '_earnings.json')))
    ev, base = [], []
    for fn in sorted(os.listdir(CACHE)):
        if fn.startswith('_'):
            continue
        sym = fn[:-5]
        d = json.load(open(os.path.join(CACHE, fn)))
        df = pd.DataFrame({'date': pd.to_datetime(d['d']), 'o': d['o'], 'h': d['h'], 'l': d['l'], 'c': d['c'], 'v': d['v']}).dropna()
        df = df[(df.c > 0) & (df.l > 0) & (df.o > 0) & (df.h >= df.l)].reset_index(drop=True)
        if len(df) < 300:
            continue
        C = df.c
        pk = np.sqrt((np.log(df.h / df.l) ** 2).rolling(30).mean() / (4 * np.log(2)))
        sig = np.maximum(pk, np.log(C).diff().rolling(30).std())
        liquid = (C >= MIN_PX) & ((C * df.v).rolling(20).mean() >= MIN_DV)
        gap = np.log(df.o / C.shift(1))
        z = gap / sig.shift(1)
        intra = np.log(C / df.o)
        near = np.zeros(len(df), dtype=bool)
        idx = {t: i for i, t in enumerate(df.date)}
        for e in earn.get(sym) or []:
            i = idx.get(pd.Timestamp(e))
            if i is not None:
                near[max(0, i - 1):i + 2] = True
        ok = liquid.shift(1, fill_value=False).values & ~near & z.notna().values & (df.date.dt.year >= FIRST_YEAR).values
        ok &= np.isfinite(intra.values)
        rows = pd.DataFrame({'date': df.date[ok], 'z': z[ok], 'intra': intra[ok]})
        base.append(rows)
        ev.append(rows[rows.z >= K])
    B = pd.concat(base, ignore_index=True)
    E = pd.concat(ev, ignore_index=True)
    down = (E.intra < 0).mean()
    base_down = (B.intra < 0).mean()
    lo, hi = wilson(int((E.intra < 0).sum()), len(E))
    fade = -np.expm1(E.intra)                      # the move from the open to the close, faded
    years = []
    for y, g in E.groupby(E.date.dt.year):
        gb = B[B.date.dt.year == y]
        years.append({'year': int(y), 'n': len(g), 'down': round(float((g.intra < 0).mean()), 4),
                      'base': round(float((gb.intra < 0).mean()), 4)})
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'rule': 'liquid the day before, open >= 2 x 30-day sigma above the previous close, no earnings within a session',
        'k': K, 'from': int(E.date.dt.year.min()), 'to': int(E.date.dt.year.max()),
        'n': int(len(E)), 'dates': int(E.date.nunique()), 'closedBelowOpen': round(float(down), 4),
        'ci95': [round(lo, 4), round(hi, 4)], 'baseClosedBelowOpen': round(float(base_down), 4),
        'meanFadeBps': round(float(fade.mean()) * 1e4, 1), 'netFadeBps': round(float(fade.mean()) * 1e4 - COST_BPS, 1),
        'yearsAboveBase': sum(1 for y in years if y['down'] > y['base']), 'years': len(years), 'byYear': years,
        'source': 'tools/calibrate_gap_fade.py, with the full test in tools/_exp7/q5_other.py',
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=1, allow_nan=False)
    print(json.dumps({k: v for k, v in payload.items() if k != 'byYear'}))


if __name__ == '__main__':
    sys.exit(main())
