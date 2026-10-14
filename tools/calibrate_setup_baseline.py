"""How much of the pullback setup's hit rate is the setup, and how much is its exit rule.

WHY THIS EXISTS
---------------
The setups list and the cards say "67% of trades like these sold above their entry". That number
is true, and on its own it misleads: the exit rule (sell at the open after the first close above
the 5-day average, at most 10 sessions) sells above the entry about as often for ANY uptrending
stock bought below its 5-day average, dip or no dip. The 2026-10-13 research (tools/_exp7,
q1_mirror.py) found the setup's real edge is size, not odds. This file measures both, the same
way, on the same cache, so the UI can show the comparison with numbers that stay true when the
data changes instead of a sentence typed once.

DEFINITIONS (identical to tools/calibrate_reversion.py and the research)
-----------------------------------------------------------------------
liquid    close >= $5 and 20-day average dollar volume >= $50M
uptrend   close above its 200-day average
setup     RSI(2) < 10 in an uptrend
base      any uptrend day that closed below its 5-day average (the trigger removed)
trade     enter at the close, sell at the open after the first close above the 5-day average,
          at most 10 sessions; "sold above entry" is that exit open over the entry close
base rate the base's rate per year, weighted by the setup's own trades per year
size      per setup trade, its return minus the average base trade entered the same day

Output: model/setup_baseline.json, read by js/ui/setups-list.js and js/ui/forecast-cards.js.
Run: python tools/calibrate_setup_baseline.py
"""
import datetime
import json
import os
import sys

import numpy as np
import pandas as pd

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
OUT = os.path.join(REPO, 'model', 'setup_baseline.json')
MIN_DV, MIN_PX = 5e7, 5.0
HOLD_CAP = 10
FIRST_YEAR = 2014


def rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def trades(df):
    """One row per liquid stock-day: whether it is a setup or a base day, and the trade's return."""
    n = len(df)
    o, c = df.o.values.astype(float), df.c.values.astype(float)
    C = df.c
    ma5, ma200 = C.rolling(5).mean().values, C.rolling(200).mean().values
    liquid = ((C >= MIN_PX) & ((C * df.v).rolling(20).mean() >= MIN_DV)).values
    up = c > ma200
    below5 = c < ma5
    r2 = rsi(C, 2).values
    idx = np.arange(n)[:, None] + np.arange(1, HOLD_CAP + 1)[None, :]
    valid = idx < n
    ic = np.minimum(idx, n - 1)
    hit = (c[ic] > ma5[ic]) & valid
    has = hit.any(1)
    k = np.where(has, hit.argmax(1) + 1, HOLD_CAP)
    i = np.arange(n)
    ok = (i + HOLD_CAP + 2 < n) & liquid & np.isfinite(ma200) & np.isfinite(ma5)
    ex = np.minimum(i + k + 1, n - 1)
    pay = np.expm1(np.log(o[ex] / c))
    setup = ok & up & (r2 < 10)
    base = ok & up & below5
    keep = setup | base
    return pd.DataFrame({'date': df.date.values[keep], 'setup': setup[keep], 'base': base[keep], 'pay': pay[keep]})


def main():
    parts = []
    for fn in sorted(os.listdir(CACHE)):
        if fn.startswith('_') or not fn.endswith('.json'):
            continue
        d = json.load(open(os.path.join(CACHE, fn)))
        df = pd.DataFrame({'date': pd.to_datetime(d['d']), 'o': d['o'], 'h': d['h'], 'l': d['l'], 'c': d['c'], 'v': d['v']}).dropna()
        df = df[(df.c > 0) & (df.l > 0) & (df.o > 0) & (df.h >= df.l)].reset_index(drop=True)
        if len(df) < 300:
            continue
        parts.append(trades(df))
    T = pd.concat(parts, ignore_index=True)
    T = T[(T.date.dt.year >= FIRST_YEAR) & np.isfinite(T.pay)]
    T['won'] = T.pay > 0
    S, B = T[T.setup], T[T.base]
    yr = S.date.dt.year
    w = yr.value_counts()
    by = B.groupby(B.date.dt.year).won.mean()
    common = [y for y in w.index if y in by.index]
    base_rate = float((by[common] * w[common] / w[common].sum()).sum())
    day_pay = B.groupby('date').pay.mean()
    excess = (S.pay - S.date.map(day_pay)).dropna()
    hy = S.groupby(yr).won.mean()
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'from': int(T.date.dt.year.min()), 'to': int(T.date.dt.year.max()),
        'setupN': int(len(S)), 'setupSoldAbove': round(float(S.won.mean()), 4),
        'baseN': int(len(B)), 'baseSoldAbove': round(base_rate, 4),
        'excessPayBps': round(float(excess.mean()) * 1e4, 1),
        'yearsAboveBase': int(sum(1 for y in hy.index if y in by.index and hy[y] > by[y])), 'years': int(len(hy)),
        'rule': 'Liquid uptrend stocks. Setup: RSI(2) under 10. Base: any close below the 5-day average. '
                'Same exit for both: the open after the first close above the 5-day average, at most 10 sessions.',
        'source': 'tools/calibrate_setup_baseline.py (the research: tools/_exp7/q1_mirror.py)',
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=1, allow_nan=False)
    print(json.dumps(payload))


if __name__ == '__main__':
    sys.exit(main())
