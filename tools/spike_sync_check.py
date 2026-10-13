"""Assert the nightly spike features equal the ones the spike model was trained on.

tools/train_spike_model.py builds its extra features vectorized over a whole history; spike_odds.py
builds them for one symbol's last bar every night. If the two drift, the nightly odds are produced
by a model reading inputs it never saw, which is silent and wrong. Synthetic bars, deterministic,
no network.

Run: python tools/spike_sync_check.py
"""
import datetime
import math
import os
import sys

import numpy as np
import pandas as pd

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, 'tools'))
import spike_odds as so  # noqa: E402
import train_spike_model as tsm  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


def synth(n=400, seed=7):
    s = seed
    def nxt():
        nonlocal s
        s = (1103515245 * s + 12345) % (2 ** 31)
        return s / (2 ** 31)
    d = pd.bdate_range('2024-01-02', periods=n)
    px, rows = 50.0, []
    for i in range(n):
        shock = (nxt() - 0.5) * 0.04 + (0.09 if nxt() > 0.985 else 0) * (1 if nxt() > 0.5 else -1)
        px *= math.exp(shock)
        rows.append({'date': d[i], 'o': px * 0.999, 'h': px * 1.01, 'l': px * 0.99, 'c': px, 'v': 1e6})
    return pd.DataFrame(rows)


print('=== spike features: nightly (spike_odds.extras) vs training (train_spike_model) ===')
df = synth()
react = np.zeros(len(df), dtype=bool)
for i in (70, 133, 196, 259, 322, 385):
    react[i] = True
frame = tsm.extra_features(df, react)
worst = 0.0
for i in (300, 321, 340, 384, 398):
    bars = [{'open': r.o, 'high': r.h, 'low': r.l, 'close': r.c, 'volume': r.v, 'date': r.date.strftime('%Y-%m-%d')}
            for r in df.iloc[:i + 1].itertuples()]
    nxt_iso = df.date.iloc[i + 1].strftime('%Y-%m-%d')
    later = [j for j in np.flatnonzero(react) if j > i]
    to = min(later[0] - i, 20) if later else 20
    ex = so.extras(bars, nxt_iso, bool(react[i + 1]), to)
    for k in ('sig30', 'earn_next', 'to_earn', 'spk60', 'spk250', 'l_px', 'month_end', 'opex'):
        a, b = ex[k], float(frame[k].iloc[i])
        worst = max(worst, abs(a - b))
        if abs(a - b) > 1e-9:
            check(f'row {i} {k}', False, f'nightly {a} vs training {b}')
check('every spike feature matches the training frame on 5 rows', worst <= 1e-9, f'worst |diff| {worst}')
check('a reaction tomorrow is seen', so.extras(
    [{'open': r.o, 'high': r.h, 'low': r.l, 'close': r.c, 'volume': r.v, 'date': r.date.strftime('%Y-%m-%d')}
     for r in df.iloc[:385].itertuples()], df.date.iloc[385].strftime('%Y-%m-%d'), True, 1)['earn_next'] == 1.0)
check('too little history returns None', so.extras([{'close': 1.0, 'date': '2024-01-02'}] * 100, '2024-06-03', False, 20) is None)

print(f"\n{'SPIKE SYNC PASS' if not FAIL else 'SPIKE SYNC FAIL'}: {len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
