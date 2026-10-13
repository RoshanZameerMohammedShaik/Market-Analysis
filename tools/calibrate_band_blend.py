"""The band's z for liquid US stocks sized by the BLEND of two volatility estimates.

WHY
---
The band has always been sized by the last 30 sessions' range (forecast_band.range_sigma). That
estimate lags: when the market turns volatile it is still describing the calm month before, and
the "80%" band held 74.6% of days when the VIX was above 30 (2022-2026, out of sample). The
volatility model (vol_forecast.py) reads the VIX and its term structure, the stock's own options
market and the earnings calendar, so it moves before the realised range does, but on its own it
overshoots the other way (82.7% above VIX 30, 77.9% below VIX 15).

The geometric mean of the two holds in every regime. On liquid US listings, z fitted on 2016-2021
and scored on 2022-2026 (this script's heldOut block, 3.7M band days): the blend held 78.9-79.8%
in every VIX band, where the 30-day band held 80.7% when the VIX was under 15 and fell to 72.6%
above 30. Average width is about the same (+0.9%, while holding 0.8 points more often). A model
fitted directly to the band's question did no better once calibrated
(tools/_exp6/band_quantile_research.py), so the simpler blend ships.

WHERE IT APPLIES
----------------
Liquid US listings only ($50M+ a day, $5+), the population the volatility model is trained on and
this calibration is fitted on. Everything else keeps the 30-day band and its own z.

METHOD
------
For every symbol and session in model/_ohlc_cache: sigma_trail as the band computes it, sigma_vol
from a volatility model trained only on years before the one it predicts (14-day embargo), the
blend sqrt(trail * vol), and day h's own high and low against the close for h = 1..10. z per
(blend tier, h) is the 80% quantile of the larger excursion in blend*sqrt(h) units, pooled and
split by whether an earnings reaction lands on or before day h, as model/band_calibration.json is.

Output: model/band_blend.json, read by forecast_band.py and js/forecast-band.js.
Run: python tools/calibrate_band_blend.py
"""
import datetime
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import vol_forecast as vf  # noqa: E402

CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
OUT = os.path.join(REPO, 'model', 'band_blend.json')
H = 10
TARGET = 0.80
TIERS = [(0.0, 0.015, 'calm'), (0.015, 0.025, 'normal'), (0.025, 0.040, 'active'), (0.040, 9.99, 'wild')]
LIQ_DOLLAR_VOL, LIQ_PRICE = 5e7, 5.0
PARAMS = dict(max_iter=150, learning_rate=0.1, max_leaf_nodes=15, min_samples_leaf=200, random_state=0)
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)


def load(fn):
    d = json.load(open(os.path.join(CACHE, fn)))
    df = pd.DataFrame({'date': pd.to_datetime(d['d']), 'o': d['o'], 'h': d['h'], 'l': d['l'], 'c': d['c'], 'v': d['v']}).dropna()
    return df[(df.c > 0) & (df.l > 0) & (df.o > 0) & (df.h >= df.l)].reset_index(drop=True)


def trail_sigma(df, n=30):
    """forecast_band.range_sigma, vectorized: max(Parkinson, stdev of log close changes)."""
    pk2 = np.log(df.h.values / df.l.values) ** 2 / (4 * np.log(2))
    live = (df.h.values > df.l.values * 1.0000001).astype(float)
    pk = np.sqrt(pd.Series(pk2).rolling(n).mean().values)
    pk = np.where(pd.Series(live).rolling(n).sum().values >= 20, pk, 0.0)
    cc = pd.Series(np.r_[np.nan, np.diff(np.log(df.c.values))]).rolling(n - 1).std().values
    s = np.fmax(pk, np.nan_to_num(cc))
    return np.where((s > 0) & (s <= 0.5), s, np.nan)


def panel():
    vix = json.load(open(os.path.join(CACHE, '_market.json')))
    spy = json.load(open(os.path.join(CACHE, '_spy.json')))
    cboe = {n: json.load(open(os.path.join(CACHE, f'_cboe_{n}.json'))) for n in ('VIX9D', 'VIX3M', 'VVIX')}
    mkt = vf.market_frame(vix['d'], vix['c'], spy['d'], spy['c'], cboe)
    earn = json.load(open(os.path.join(CACHE, '_earnings.json')))
    IV = pd.read_csv(os.path.join(CACHE, '_iv_full.csv'), usecols=['date', 'act_symbol', 'iv_current'])
    IV = IV[IV.iv_current > 0].dropna()
    IV['date'] = pd.to_datetime(IV.date)
    ivs = {k: g.sort_values('date') for k, g in IV.groupby('act_symbol')}
    frames = []
    for fn in sorted(os.listdir(CACHE)):
        if fn.startswith('_') or not earn.get(fn[:-5]):
            continue
        sym = fn[:-5]
        df = load(fn)
        if len(df) < 400:
            continue
        iv = None
        if sym in ivs:
            g = ivs[sym]
            iv = pd.merge_asof(df[['date']], pd.DataFrame({'date': g.date + pd.Timedelta(days=1), 'iv': g.iv_current.values}),
                               on='date', direction='backward', tolerance=pd.Timedelta(days=8)).iv.values
        f = vf.feature_frame(df, mkt, iv)
        react = np.zeros(len(df), dtype=bool)
        for p in np.searchsorted(df.date.values, pd.to_datetime(earn[sym]).values):
            if 0 <= p < len(df):
                react[p] = True
        e5 = np.zeros(len(df))
        for p in np.flatnonzero(react):
            e5[max(0, p - vf.H):p] = 1
        f['earn_in'] = e5
        f['sym'] = sym
        f['sig_trail'] = trail_sigma(df)
        f['liquid'] = (pd.Series(df.c.values * df.v.values).rolling(20).mean().values >= LIQ_DOLLAR_VOL) & (df.c.values >= LIQ_PRICE)
        n = len(df)
        first_e = np.full(n, 99)
        for k in range(1, H + 1):
            up = np.full(n, np.nan)
            dn = np.full(n, np.nan)
            up[:-k] = np.log(df.h.values[k:] / df.c.values[:-k])
            dn[:-k] = np.log(df.c.values[:-k] / df.l.values[k:])
            f[f'u{k}'] = np.fmax(up, dn)
            er = np.zeros(n, dtype=bool)
            er[:-k] = react[k:]
            first_e = np.where((first_e == 99) & er, k, first_e)
        f['first_e'] = first_e
        frames.append(f.iloc[vf.MIN_BARS:-H])
    D = pd.concat(frames, ignore_index=True)
    need = [k for k in vf.FEATURES if k not in ('ts9', 'ts3m', 'l_vvix', 'l_iv', 'iv_rel', 'iv_rv5')]
    D = D.dropna(subset=need + ['sig_trail'])
    log(f'{len(D):,} rows from the cache')
    # Out-of-sample volatility forecast for every row, by calendar year.
    F = vf.FEATURES
    D['sig_vol'] = np.nan
    pool = D[np.isfinite(D.y) & (D.y > np.log(1e-4))]
    for yr in range(2016, 2027):
        te = D.date.dt.year == yr
        if te.sum() < 1000:
            continue
        tr = pool[pool.date < pd.Timestamp(f'{yr}-01-01') - pd.Timedelta(days=14)].iloc[::3]
        D.loc[te, 'sig_vol'] = np.exp(HistGradientBoostingRegressor(**PARAMS).fit(tr[F], tr.y).predict(D.loc[te, F]))
        log(f'  volatility model for {yr}: trained on {len(tr):,}')
    D = D.dropna(subset=['sig_vol'])
    D = D[D.liquid.values]
    D['sig'] = np.sqrt(D.sig_trail * D.sig_vol)
    log(f'{len(D):,} liquid rows with an out-of-sample forecast, {D.date.min().date()} to {D.date.max().date()}')
    return D


def tier_of(s):
    out = np.full(len(s), 'wild', dtype=object)
    for lo, hi, name in TIERS:
        out[(s >= lo) & (s < hi)] = name
    return out


def fit(D, col='sig'):
    sig = D[col].values
    tier = tier_of(sig)
    pooled, earn_t, ord_t, cov, counts = {}, {}, {}, {}, {}
    for h in range(1, H + 1):
        x = D[f'u{h}'].values / (sig * math.sqrt(h))
        ok = np.isfinite(x)
        fam = D.first_e.values <= h
        for t in ('calm', 'normal', 'active', 'wild'):
            for table, m in ((pooled, ok & (tier == t)), (earn_t, ok & (tier == t) & fam), (ord_t, ok & (tier == t) & ~fam)):
                if m.sum() < 300:
                    continue
                z = float(np.quantile(x[m], TARGET))
                table.setdefault(t, {})[str(h)] = round(z, 4)
                if table is pooled:
                    cov[f'{t}:{h}'] = round(float((x[m] <= z).mean()), 4)
                    counts[f'{t}:{h}'] = int(m.sum())
    return pooled, earn_t, ord_t, cov, counts


def held_out(D, col, split='2022-01-01'):
    """Fit z on the years before `split`, score the years from it: coverage overall and by VIX."""
    tr, te = D[D.date < split], D[D.date >= split]
    pooled, earn_t, ord_t, _, _ = fit(tr, col)
    sig = te[col].values
    tier = tier_of(sig)
    vix = np.exp(te.l_vix.values)
    inside_all, width = [], []
    by = {'<15': [0, 0], '15-20': [0, 0], '20-30': [0, 0], '30+': [0, 0]}
    for h in range(1, H + 1):
        x = te[f'u{h}'].values / (sig * math.sqrt(h))
        fam = te.first_e.values <= h
        for t in ('calm', 'normal', 'active', 'wild'):
            for table, m in ((earn_t, (tier == t) & fam), (ord_t, (tier == t) & ~fam)):
                z = table.get(t, {}).get(str(h)) or pooled.get(t, {}).get(str(h))
                m = m & np.isfinite(x)
                if z is None or not m.any():
                    continue
                ins = x[m] <= z
                inside_all.append(ins)
                width.append(z * sig[m] * math.sqrt(h))
                for lab, lo, hi in (('<15', 0, 15), ('15-20', 15, 20), ('20-30', 20, 30), ('30+', 30, 999)):
                    mm = (vix[m] >= lo) & (vix[m] < hi)
                    by[lab][0] += int(ins[mm].sum())
                    by[lab][1] += int(mm.sum())
    ins = np.concatenate(inside_all)
    return {'coverage': round(float(ins.mean()), 4), 'meanHalfWidth': round(float(np.concatenate(width).mean()), 5),
            'byVix': {k: round(v[0] / v[1], 4) for k, v in by.items() if v[1]}, 'n': int(len(ins))}


def main():
    D = panel()
    ho_blend, ho_trail = held_out(D, 'sig'), held_out(D, 'sig_trail')
    log(f'held out 2022-2026, liquid US: blend {ho_blend}')
    log(f'                               30-day {ho_trail}')
    pooled, earn_t, ord_t, cov, counts = fit(D)
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'method': 'sigma = sqrt(range_sigma(30) * vol_forecast sigma), z per (tier, horizon) at 80%, liquid US only',
        'targetConfidence': TARGET, 'horizons': list(range(1, H + 1)),
        'tierEdges': [[lo, hi, name] for lo, hi, name in TIERS],
        'liquidity': {'minDollarVol20': LIQ_DOLLAR_VOL, 'minPrice': LIQ_PRICE},
        'zPerDay': pooled, 'zPerDayEarn': earn_t, 'zPerDayNoEarn': ord_t,
        'realizedCoveragePerDay': cov, 'sampleCounts': counts,
        'rows': int(len(D)), 'symbols': int(D.sym.nunique()),
        'from': D.date.min().strftime('%Y-%m-%d'), 'to': D.date.max().strftime('%Y-%m-%d'),
        # z fitted on 2016-2021 and scored on 2022-2026, on these same liquid rows, both ways.
        'heldOut': {'blend': ho_blend, 'trail': ho_trail,
                    'narrowerThanTrail': round(1 - ho_blend['meanHalfWidth'] / ho_trail['meanHalfWidth'], 4)},
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=1, allow_nan=False)
    log(f'wrote {OUT}')
    for t in ('calm', 'normal', 'active', 'wild'):
        log(f'  {t:<7} z by day: ' + ' '.join(f'{pooled.get(t, {}).get(str(h), "-")}' for h in range(1, H + 1)))


if __name__ == '__main__':
    main()
