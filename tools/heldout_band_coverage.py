"""How often the published ranges actually held, on years they were never fitted on.

WHY THIS EXISTS
---------------
Every day on the week cards said "80% chance the day's high and low both land inside", because
every range is BUILT to hold 80% of the time (tools/calibrate_bands.py solves z per volatility tier
and horizon so its own sample holds exactly 80%). That is a target, not a measurement, and the
coverage stored with it is in-sample, 0.80 by construction. Roshan, 2026-10-14: "why do I see 80%
confidence across all cards".

This measures it. The production z tables were fitted on 2021 onward, so 2014-2020 in the price
cache (liquid US names) is data they have never seen. Each day's range is rebuilt exactly as the
app builds it (sigma = max of 30-day Parkinson and close-to-close, z per tier and horizon, the
earnings table when a reaction falls in the window) and checked against what that day did.

It also answers the second question, "why so wide": for each cell it measures how much narrower
a range is that holds two days in three, or half the time, and how often those held.

Output: model/band_heldout.json, read by js/ui/forecast-cards.js.
Run: python tools/heldout_band_coverage.py
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
CAL = os.path.join(REPO, 'model', 'band_calibration.json')
OUT = os.path.join(REPO, 'model', 'band_heldout.json')
TEST = (2014, 2020)          # before the production fit (2021 on)
FIT_LIKELY = (2021, 2026)    # where the tighter tables are fitted, to test them on TEST too
H = 10
LOOK = 30
TIERS = [(0.0, 0.015, 'calm'), (0.015, 0.025, 'normal'), (0.025, 0.04, 'active'), (0.04, 9.99, 'wild')]
LIKELY = (0.5, 2 / 3)


def tier_of(s):
    for lo, hi, name in TIERS:
        if lo <= s < hi:
            return name
    return None


def symbol_rows(df, earn_dates):
    """Per (day k, horizon h): tier, sigma, the excursion in sigma*sqrt(h) units, and earnings flag."""
    o, hgh, low, c = (df[x].values.astype(float) for x in ('o', 'h', 'l', 'c'))
    n = len(c)
    lr = np.log(hgh / low)
    pk = np.sqrt(pd.Series(lr ** 2).rolling(LOOK).mean().values / (4 * math.log(2)))
    cc = pd.Series(np.log(c)).diff().rolling(LOOK - 1).std().values
    sig = np.fmax(pk, cc)
    years = df.date.dt.year.values
    eidx = set()
    if earn_dates:
        pos = {d: i for i, d in enumerate(df.date.dt.strftime('%Y-%m-%d'))}
        eidx = {pos[d] for d in earn_dates if d in pos}
    out = []
    for k in range(LOOK, n - H):
        s = sig[k]
        if not (s > 0 and s < 0.5):
            continue
        t = tier_of(s)
        for h in range(1, H + 1):
            j = k + h
            d = s * math.sqrt(h)
            up = math.log(hgh[j] / c[k]) / d
            dn = math.log(c[k] / low[j]) / d
            earn = any((k < e <= j) for e in eidx) if eidx else None
            out.append((years[k], t, h, max(up, dn), earn))
    return out


def main():
    cal = json.load(open(CAL, encoding='utf-8'))
    z_pool, z_no, z_earn = cal['zPerDay'], cal.get('zPerDayNoEarn') or {}, cal.get('zPerDayEarn') or {}
    earn = json.load(open(os.path.join(CACHE, '_earnings.json'), encoding='utf-8'))
    rows = []
    for fn in sorted(os.listdir(CACHE)):
        if fn.startswith('_') or not fn.endswith('.json'):
            continue
        sym = fn[:-5]
        d = json.load(open(os.path.join(CACHE, fn), encoding='utf-8'))
        df = pd.DataFrame({'date': pd.to_datetime(d['d']), 'o': d['o'], 'h': d['h'], 'l': d['l'], 'c': d['c']}).dropna()
        df = df[(df.c > 0) & (df.l > 0) & (df.h >= df.l)].reset_index(drop=True)
        if len(df) < LOOK + H + 50:
            continue
        rows.extend(symbol_rows(df, earn.get(sym)))
    R = pd.DataFrame(rows, columns=['year', 'tier', 'h', 'x', 'earn'])

    def z_for(tier, h, fam):
        table = (z_earn if fam is True else z_no if fam is False else z_pool) or z_pool
        cell = (table.get(tier) or z_pool.get(tier) or {})
        return cell.get(str(h)) or (z_pool.get(tier) or {}).get(str(h))

    test = R[(R.year >= TEST[0]) & (R.year <= TEST[1])].copy()
    test['z'] = [z_for(t, h, e) for t, h, e in zip(test.tier, test.h, test.earn)]
    test = test[test.z.notna()]
    test['held'] = test.x <= test.z
    cells = {}
    for (t, h), g in test.groupby(['tier', 'h']):
        cells[f'{t}:{h}'] = {'n': int(len(g)), 'held': round(float(g.held.mean()), 4)}
    fam = {}
    for e, g in test.groupby(test.earn.map(lambda v: 'earn' if v is True else 'noEarn' if v is False else 'unknown')):
        fam[e] = {'n': int(len(g)), 'held': round(float(g.held.mean()), 4)}

    # The tighter ranges: z for 2/3 and for 1/2, fitted on the production years, held out on TEST.
    fit = R[(R.year >= FIT_LIKELY[0]) & (R.year <= FIT_LIKELY[1])]
    likely = {}
    for q in LIKELY:
        key = f'{q:.2f}'
        out = {}
        for (t, h), g in fit.groupby(['tier', 'h']):
            zq = float(np.quantile(g.x.values, q))
            z80 = z_for(t, h, None)
            tg = test[(test.tier == t) & (test.h == h)]
            out[f'{t}:{h}'] = {'z': round(zq, 4), 'widthVs80': round(zq / z80, 3) if z80 else None,
                               'heldOut': round(float((tg.x <= zq).mean()), 4) if len(tg) else None, 'n': int(len(tg))}
        likely[key] = out

    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'tested': f'{TEST[0]}-{TEST[1]}', 'fittedOn': 'model/band_calibration.json (2021 on)',
        'universe': 'liquid US stocks in the price cache',
        'overall': {'n': int(len(test)), 'held': round(float(test.held.mean()), 4)},
        'byFamily': fam, 'cells': cells, 'likely': likely,
        'source': 'tools/heldout_band_coverage.py',
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'), allow_nan=False)
    print(json.dumps({k: v for k, v in payload.items() if k not in ('cells', 'likely')}))
    for t in ('calm', 'normal', 'active', 'wild'):
        print(t, ' '.join(f"h{h}:{cells.get(f'{t}:{h}', {}).get('held')}" for h in range(1, H + 1)))
    for q, out in likely.items():
        print('likely', q, ' '.join(f"{k}:{v['widthVs80']}/{v['heldOut']}" for k, v in list(out.items())[:12]))


if __name__ == '__main__':
    sys.exit(main())
