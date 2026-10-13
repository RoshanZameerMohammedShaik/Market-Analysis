"""Spike odds: the chance the next session moves at least twice the stock's normal daily move.

WHY THIS AND NOT DIRECTION
--------------------------
Up or down tomorrow is a coin flip on public data. HOW BIG tomorrow's move is, is not: big moves
cluster, they arrive on known dates (earnings), and the options market prices them in advance.
This model answers "will tomorrow be a 2x day", either way, with a probability that is calibrated
on years the model never saw.

DEFINITIONS
-----------
normal move  sigma30, the stdev of the last 30 daily log returns (close to close)
spike        |log(close[t+1] / close[t])| >= 2 * sigma30, and its up and down halves separately
features     vol_forecast.FEATURES (recent ranges, gaps, volume, VIX and its term structure, the
             stock's implied volatility) plus: an earnings reaction tomorrow, sessions until the
             next reaction (capped at 20, what the earnings calendar knows ahead), how often this
             stock itself has spiked over the last 60 and 250 sessions, its price level, and
             month-end / monthly-expiry calendar flags.

VALIDATION
----------
Walk-forward by calendar year 2016-2026, 14-day embargo. The isotonic calibration is fitted on the
out-of-sample predictions, so the published probabilities are measured, not assumed. Reported:
AUC, Brier score against the base rate, calibration by bucket, and how often the top 10% of
predictions actually spiked against the base rate (lift).

Output: model/spike_model.json. Run: python tools/train_spike_model.py
"""
import datetime
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, 'tools'))
import vol_forecast as vf  # noqa: E402
import train_vol_model as tvm  # noqa: E402

CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
OUT = os.path.join(REPO, 'model', 'spike_model.json')
K = 2.0
PARAMS = dict(max_iter=200, learning_rate=0.08, max_leaf_nodes=15, min_samples_leaf=300, random_state=0)
EXTRA = ['earn_next', 'to_earn', 'spk60', 'spk250', 'l_px', 'month_end', 'opex']
FEATURES = vf.FEATURES + EXTRA
STEP = 2
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)


def extra_features(df, react):
    """The spike-specific features for every row of one symbol (index aligned with df)."""
    c = df.c.values
    r = np.r_[np.nan, np.diff(np.log(c))]
    sig30 = pd.Series(r).rolling(30).std().values
    big = np.abs(r) >= K * np.r_[np.nan, sig30[:-1]]          # a spike, judged by the sigma before it
    f = pd.DataFrame(index=df.index)
    f['sig30'] = sig30
    nxt = np.zeros(len(df))
    nxt[:-1] = react[1:]
    f['earn_next'] = nxt
    # Sessions until the next earnings reaction, capped at 20 (about four weeks): companies announce
    # the date a few weeks ahead, so that much is known on the day, and the nightly job reads the
    # same thing off the earnings calendar. 20 means "none within four weeks".
    # Counted strictly after today, as the nightly job sees it: it reads tomorrow onward.
    nxt_r = len(df) + 10 ** 6
    to = np.zeros(len(df))
    for i in range(len(df) - 1, -1, -1):
        to[i] = min(nxt_r - i, 20)
        if react[i]:
            nxt_r = i
    f['to_earn'] = to
    f['spk60'] = pd.Series(big.astype(float)).rolling(60).mean().values
    f['spk250'] = pd.Series(big.astype(float)).rolling(250).mean().values
    f['l_px'] = np.log(c)
    d = df.date
    nxt_date = d.shift(-1)
    f['month_end'] = ((nxt_date.dt.month != d.dt.month) & nxt_date.notna()).astype(float).values
    # Monthly options expiry: the third Friday. Is TOMORROW that day?
    tom = nxt_date
    f['opex'] = ((tom.dt.weekday == 4) & (tom.dt.day >= 15) & (tom.dt.day <= 21)).astype(float).values
    # Targets: tomorrow's move against today's sigma30.
    r1 = np.r_[r[1:], np.nan]
    f['y'] = (np.abs(r1) >= K * sig30).astype(float)
    f['y_up'] = (r1 >= K * sig30).astype(float)
    f['y_dn'] = (r1 <= -K * sig30).astype(float)
    f.loc[~np.isfinite(r1) | ~np.isfinite(sig30), ['y', 'y_up', 'y_dn']] = np.nan
    return f


def dataset():
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
        df = tvm.load(fn)
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
        x = extra_features(df, react)
        for k in x.columns:
            f[k] = x[k].values
        f['sym'] = sym
        frames.append(f.iloc[260:-1:STEP])
    D = pd.concat(frames, ignore_index=True)
    need = [k for k in vf.FEATURES if k not in ('ts9', 'ts3m', 'l_vvix', 'l_iv', 'iv_rel', 'iv_rv5')]
    D = D.dropna(subset=need + ['y', 'sig30', 'spk60', 'spk250'])
    log(f'{len(D):,} rows from {D.sym.nunique()} symbols, spike base rate {D.y.mean() * 100:.2f}% '
        f'(up {D.y_up.mean() * 100:.2f}%, down {D.y_dn.mean() * 100:.2f}%)')
    return D


def main():
    D = dataset()
    P = []
    for yr in range(2016, 2027):
        te = D[D.date.dt.year == yr]
        tr = D[D.date < pd.Timestamp(f'{yr}-01-01') - pd.Timedelta(days=14)]
        if len(te) < 1000:
            continue
        m = HistGradientBoostingClassifier(**PARAMS).fit(tr[FEATURES], tr.y)
        mu = HistGradientBoostingClassifier(**PARAMS).fit(tr[FEATURES], tr.y_up)
        P.append(pd.DataFrame({'year': yr, 'y': te.y.values, 'y_up': te.y_up.values, 'y_dn': te.y_dn.values,
                               'earn_next': te.earn_next.values, 'p': m.predict_proba(te[FEATURES])[:, 1],
                               'pu': mu.predict_proba(te[FEATURES])[:, 1]}))
        log(f'{yr}: train {len(tr):,}, test {len(te):,}')
    P = pd.concat(P, ignore_index=True)
    # THE CALIBRATION, HELD OUT: fitted on 2016-2021 predictions, checked on 2022-2026 ones, so the
    # bucket table below is not the calibration grading itself. The shipped mapping is then refit
    # on every year.
    early = P.year <= 2021
    iso_early = IsotonicRegression(out_of_bounds='clip', y_min=0.001, y_max=0.999).fit(P.p[early], P.y[early])
    late = ~early
    pl = iso_early.predict(P.p[late])
    held = []
    for lo, hi in ((0, 0.02), (0.02, 0.04), (0.04, 0.06), (0.06, 0.1), (0.1, 0.2), (0.2, 0.4), (0.4, 1.01)):
        mm = (pl >= lo) & (pl < hi)
        if mm.sum() >= 200:
            held.append({'lo': lo, 'hi': hi, 'n': int(mm.sum()), 'predicted': round(float(pl[mm].mean()), 4),
                         'actual': round(float(P.y[late].values[mm].mean()), 4)})
    for b in held:
        log(f"  held out 2022+: predicted {b['predicted'] * 100:5.1f}%  actual {b['actual'] * 100:5.1f}%  n={b['n']:,}")
    iso = IsotonicRegression(out_of_bounds='clip', y_min=0.001, y_max=0.999).fit(P.p, P.y)
    P['pc'] = iso.predict(P.p)
    base = float(P.y.mean())
    brier = float(((P.pc - P.y) ** 2).mean())
    brier0 = float(((base - P.y) ** 2).mean())
    auc = float(roc_auc_score(P.y, P.p))
    # Does the up-spike model know direction, beyond knowing size? Compare it with p/2.
    auc_up = float(roc_auc_score(P.y_up, P.pu))
    auc_up_naive = float(roc_auc_score(P.y_up, P.p))
    top = P.pc >= P.pc.quantile(0.9)
    buckets = []
    for lo, hi in ((0, 0.02), (0.02, 0.04), (0.04, 0.06), (0.06, 0.1), (0.1, 0.2), (0.2, 0.4), (0.4, 1.01)):
        mm = (P.pc >= lo) & (P.pc < hi)
        if mm.sum() >= 200:
            buckets.append({'lo': lo, 'hi': hi, 'n': int(mm.sum()), 'predicted': round(float(P.pc[mm].mean()), 4),
                            'actual': round(float(P.y[mm].mean()), 4)})
    years = [{'year': int(y), 'auc': round(float(roc_auc_score(g.y, g.p)), 3), 'base': round(float(g.y.mean()), 4)}
             for y, g in P.groupby('year')]
    earn_rate = float(P.y[P.earn_next == 1].mean()) if (P.earn_next == 1).any() else None
    summary = {'forecasts': len(P), 'baseRate': round(base, 4), 'auc': round(auc, 3), 'brier': round(brier, 5),
               'brierBaseRate': round(brier0, 5), 'brierSkill': round(1 - brier / brier0, 4),
               'top10pctRate': round(float(P.y[top].mean()), 4), 'top10pctLift': round(float(P.y[top].mean()) / base, 2),
               'earningsNextRate': round(earn_rate, 4) if earn_rate is not None else None,
               'upSpikeAuc': round(auc_up, 3), 'upSpikeAucFromSizeOnly': round(auc_up_naive, 3)}
    log('walk-forward:', json.dumps(summary))
    for b in buckets:
        log(f"  predicted {b['predicted'] * 100:5.1f}%  actual {b['actual'] * 100:5.1f}%  n={b['n']:,}")
    for y in years:
        log(f"  {y['year']}: AUC {y['auc']}, base {y['base'] * 100:.1f}%")

    full = HistGradientBoostingClassifier(**PARAMS).fit(D[FEATURES], D.y)
    ex = tvm.export(full, 'classifier')
    S = D.sample(3000, random_state=1)
    d = np.abs(np.array([vf._raw(ex, x) for x in S[FEATURES].values.tolist()]) - full.decision_function(S[FEATURES])).max()
    log(f'export check: max |diff| {d:.2e}')
    if d > 1e-4:
        sys.exit('ERROR: exported trees do not reproduce the fitted model')
    # Finer where nearly every prediction sits: spikes are rare, so most raw scores are under 0.2.
    grid = np.unique(np.r_[np.linspace(0, 0.2, 201), np.linspace(0.2, 1, 81)])
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'question': 'Will the next session move at least 2x this stock normal daily move (stdev of the last 30 daily returns), either way?',
        'k': K, 'features': FEATURES,
        'trainedOn': {'rows': len(D), 'symbols': int(D.sym.nunique()), 'from': D.date.min().strftime('%Y-%m-%d'),
                      'to': D.date.max().strftime('%Y-%m-%d')},
        'params': PARAMS,
        'calibration': {'x': [round(float(x), 4) for x in grid], 'y': [round(float(v), 5) for v in iso.predict(grid)]},
        'walkForward': summary, 'buckets': buckets, 'bucketsHeldOut': held, 'byYear': years,
        'model': ex,
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'), allow_nan=False)
    log(f'wrote {OUT} ({os.path.getsize(OUT) / 1e3:.0f} KB)')


if __name__ == '__main__':
    main()
