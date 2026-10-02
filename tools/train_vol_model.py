"""Train and validate the volatility forecast; write model/vol_model.json.

Data: model/_ohlc_cache (daily OHLCV per symbol, from tools/calibrate_reversion.py), with
_market.json (VIX), _spy.json and _earnings.json (reaction sessions per symbol). Symbols with no
earnings history are left out: their earnings weeks would train as ordinary ones.

Validation is walk-forward by calendar year 2016-2026 with a 14-day embargo: every number this
writes about accuracy was scored on a year the model had not seen. Those out-of-sample forecasts
also supply the probability calibration and the residual quantiles for the 80% range, so neither
is fitted on the data it is judged on. The shipped trees are then refit on everything.

Run: python tools/train_vol_model.py
"""
import datetime
import json
import os
import sys
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import vol_forecast as vf  # noqa: E402

CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
OUT = os.path.join(REPO, 'model', 'vol_model.json')
PARAMS = dict(max_iter=150, learning_rate=0.1, max_leaf_nodes=15, min_samples_leaf=200, random_state=0)
STEP = 3          # every 3rd session per symbol, to thin overlapping 5-day targets
MIN_CALL = 0.60   # below this the call is "similar to recent", not a direction
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)


def load(fn):
    d = json.load(open(os.path.join(CACHE, fn)))
    df = pd.DataFrame({'date': pd.to_datetime(d['d']), 'o': d['o'], 'h': d['h'], 'l': d['l'], 'c': d['c'], 'v': d['v']}).dropna()
    return df[(df.c > 0) & (df.l > 0) & (df.o > 0) & (df.h >= df.l)].reset_index(drop=True)


def dataset():
    vix = json.load(open(os.path.join(CACHE, '_market.json')))
    spy = json.load(open(os.path.join(CACHE, '_spy.json')))
    mkt = vf.market_frame(vix['d'], vix['c'], spy['d'], spy['c'])
    earn = json.load(open(os.path.join(CACHE, '_earnings.json')))
    frames, skipped = [], 0
    for fn in sorted(os.listdir(CACHE)):
        if fn.startswith('_'):
            continue
        sym = fn[:-5]
        if not earn.get(sym):
            skipped += 1
            continue
        df = load(fn)
        if len(df) < 400:
            continue
        f = vf.feature_frame(df, mkt)
        pos = np.searchsorted(df.date.values, pd.to_datetime(earn[sym]).values)
        e = np.zeros(len(df))
        for p in pos:
            if 0 < p < len(df):
                e[max(0, p - vf.H):p] = 1
        f['earn_in'] = e
        f['sym'] = sym
        f = f.iloc[vf.MIN_BARS:-vf.H:STEP]
        frames.append(f.dropna(subset=vf.FEATURES + ['y']))
    D = pd.concat(frames, ignore_index=True)
    D = D[np.isfinite(D.y) & (D.y > np.log(1e-4))]
    D['up'] = (D.y > D.past20).astype(int)
    log(f'{len(D):,} rows from {D.sym.nunique()} symbols ({skipped} without earnings history left out)')
    return D


def export(model, kind):
    trees = []
    for it in model._predictors:
        nodes = it[0].nodes
        out = []
        for nd in nodes:
            if nd['is_leaf']:
                out.append([float(nd['value'])])
            else:
                out.append([int(nd['feature_idx']), float(nd['num_threshold']), int(nd['left']), int(nd['right'])])
        trees.append(out)
    base = float(np.ravel(model._baseline_prediction)[0])
    return {'kind': kind, 'base': round(base, 6), 'trees': trees}


def main():
    D = dataset()
    F = vf.FEATURES
    P = []
    for yr in range(2016, 2027):
        te = D[D.date.dt.year == yr]
        tr = D[D.date < pd.Timestamp(f'{yr}-01-01') - pd.Timedelta(days=14)]
        if len(te) < 1000:
            continue
        r = HistGradientBoostingRegressor(**PARAMS).fit(tr[F], tr.y)
        c = HistGradientBoostingClassifier(**PARAMS).fit(tr[F], tr.up)
        P.append(pd.DataFrame({'year': yr, 'y': te.y.values, 'up': te.up.values, 'earn_in': te.earn_in.values,
                               'pred': r.predict(te[F]), 'p': c.predict_proba(te[F])[:, 1], 'past20': te.past20.values,
                               'liquid': te.l_dv.values >= np.log(5e7)}))
        log(f'{yr}: train {len(tr):,}, test {len(te):,}')
    P = pd.concat(P, ignore_index=True)

    iso = IsotonicRegression(out_of_bounds='clip', y_min=0.01, y_max=0.99).fit(P.p, P.up)
    grid = np.linspace(0, 1, 41)
    cal_y = iso.predict(grid)
    P['pc'] = iso.predict(P.p)
    res = P.y - P.pred
    rq = {'normal': [float(np.quantile(res[P.earn_in == 0], q)) for q in (0.1, 0.9)],
          'earn': [float(np.quantile(res[P.earn_in == 1], q)) for q in (0.1, 0.9)]}

    def r2(y, p):
        return float(1 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum())

    lo_, hi_ = P.pred + np.where(P.earn_in == 1, rq['earn'][0], rq['normal'][0]), P.pred + np.where(P.earn_in == 1, rq['earn'][1], rq['normal'][1])
    inside = (P.y >= lo_) & (P.y <= hi_)
    conf = np.maximum(P.pc, 1 - P.pc)
    right = (P.pc >= 0.5) == (P.up == 1)
    # A call is made only when the size forecast agrees with it (see vol_forecast.predict), so
    # every published hit rate below is measured on exactly the calls the app would have made.
    agree = ((P.pred > P.past20) == (P.pc >= 0.5)).values
    buckets = []
    for lo, hi in ((0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.01)):
        m = (conf >= lo) & (conf < hi) & agree
        buckets.append({'lo': lo, 'hi': hi, 'n': int(m.sum()), 'share': round(float(m.mean()), 4),
                        'hitRate': round(float(right[m].mean()), 4), 'meanConfidence': round(float(conf[m].mean()), 4)})
    # The landing outlook lists liquid names only ($50M+/day), so their calibration is reported
    # on its own: a model calibrated overall can still be off on a subset.
    buckets_liq = []
    L = P.liquid.values
    for lo, hi in ((0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.01)):
        m = (conf >= lo) & (conf < hi) & L & agree
        buckets_liq.append({'lo': lo, 'hi': hi, 'n': int(m.sum()), 'share': round(float(m.sum() / max(L.sum(), 1)), 4),
                            'hitRate': round(float(right[m].mean()), 4) if m.any() else None,
                            'meanConfidence': round(float(conf[m].mean()), 4) if m.any() else None})
    years = []
    for yr, g in P.groupby('year'):
        cg = np.maximum(g.pc, 1 - g.pc)
        rg = (g.pc >= 0.5) == (g.up == 1)
        cg = np.where(((g.pred > g.past20) == (g.pc >= 0.5)).values, cg, 0)
        years.append({'year': int(yr), 'n': len(g), 'r2': round(r2(g.y, g.pred), 3), 'auc': round(float(roc_auc_score(g.up, g.p)), 3),
                      'hitRate': round(float(rg.mean()), 4), 'hitRateSure': round(float(rg[cg >= 0.7].mean()), 4)})
    called = (conf >= MIN_CALL) & agree
    summary = {
        'forecasts': len(P), 'years': [int(P.year.min()), int(P.year.max())],
        'levelR2': round(r2(P.y, P.pred), 3),
        'levelR2EarningsWeeks': round(r2(P.y[P.earn_in == 1], P.pred[P.earn_in == 1]), 3),
        'rangeCoverage80': round(float(inside.mean()), 4),
        'rangeCoverage80Earnings': round(float(inside[P.earn_in == 1].mean()), 4),
        'upAuc': round(float(roc_auc_score(P.up, P.p)), 3),
        'upHitRate': round(float(right.mean()), 4),
        'alwaysCalmerHitRate': round(float(1 - P.up.mean()), 4),
        'calledShare': round(float(called.mean()), 4), 'calledHitRate': round(float(right[called].mean()), 4),
    }
    # The baseline the app used: next week looks like the last 30 days.
    log('walk-forward:', json.dumps(summary))
    for b in buckets:
        log(f"  confidence {b['lo']*100:.0f}-{min(b['hi'],1)*100:.0f}%: {b['share']*100:4.1f}% of calls, right {b['hitRate']*100:.1f}%")
    for b in buckets_liq:
        log(f"  liquid only {b['lo']*100:.0f}-{min(b['hi'],1)*100:.0f}%: n={b['n']:,} ({b['share']*100:4.1f}%), right {(b['hitRate'] or 0)*100:.1f}%")

    level = HistGradientBoostingRegressor(**PARAMS).fit(D[F], D.y)
    up = HistGradientBoostingClassifier(**PARAMS).fit(D[F], D.up)
    # The exported trees must reproduce sklearn exactly, or the browser runs a different model.
    lv, uv = export(level, 'regressor'), export(up, 'classifier')
    S = D.sample(3000, random_state=1)
    xs = S[F].values.tolist()
    d_level = np.abs(np.array([vf._raw(lv, x) for x in xs]) - level.predict(S[F])).max()
    d_up = np.abs(np.array([vf._raw(uv, x) for x in xs]) - up.decision_function(S[F])).max()
    log(f'export check: max |diff| level {d_level:.2e}, up {d_up:.2e}')
    if d_level > 1e-4 or d_up > 1e-4:
        sys.exit('ERROR: exported trees do not reproduce the fitted model')
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'horizon': vf.H, 'features': F,
        'target': 'daily volatility over the next 5 sessions, close to close, sqrt(mean r^2)',
        'trainedOn': {'rows': len(D), 'symbols': int(D.sym.nunique()),
                      'from': D.date.min().strftime('%Y-%m-%d'), 'to': D.date.max().strftime('%Y-%m-%d')},
        'params': PARAMS, 'minCallConfidence': MIN_CALL,
        'residualQ': {k: [round(v[0], 4), round(v[1], 4)] for k, v in rq.items()},
        'upCalibration': {'x': [round(float(x), 4) for x in grid], 'y': [round(float(y), 4) for y in cal_y]},
        'walkForward': summary, 'accuracyByConfidence': buckets, 'accuracyByConfidenceLiquid': buckets_liq, 'byYear': years,
        'level': lv, 'up': uv,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)
    log(f'wrote {OUT} ({os.path.getsize(OUT) / 1e3:.0f} KB)')


if __name__ == '__main__':
    main()
