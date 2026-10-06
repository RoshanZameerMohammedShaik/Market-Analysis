"""Next-week volatility forecast: how much a stock is likely to move, and whether it is getting
calmer or choppier, each with a confidence measured on data the model never saw.

WHY THIS AND NOT DIRECTION. Direction tomorrow is a coin flip on public data (AUC 0.52 over 12
years, the app's own ledger 50.4%). Volatility is not: it clusters, it mean-reverts, and it jumps
on known dates. Walk-forward 2016-2026 over 475,579 forecasts (tools/train_vol_model.py):

  * the size of next week's moves: R^2 0.64 on log volatility, against 0.53 for "next week looks
    like the last 30 days", which is what the band used before;
  * earnings weeks: the 30-day estimate scored R^2 -0.04 there (worse than guessing the average)
    and ran 46% too low, this model knows the date is coming;
  * "choppier or calmer than the last 20 sessions?": right 68% overall, ~80% on the half of calls
    where it is at least 70% sure, ~92% where it is at least 90% sure. Calibrated, so the stated
    confidence is the measured hit rate for calls like it.

Two models, both gradient-boosted trees exported to model/vol_model.json:
  * `level`  predicts log of next-5-session daily volatility (close to close, sqrt(mean r^2));
  * `up`     predicts P(next-5-session volatility > the last 20 sessions'), then calibrated.

IMPLIED VOLATILITY (2026-10-02). The stock's own option-implied vol (DoltHub, since 2019) and the
market's implied-vol term structure (CBOE VIX9D, VIX3M, VVIX), all as of the PREVIOUS session,
because the nightly run happens before that day's IV is published. On 2021-2026 test years: move
size R^2 0.428 -> 0.441, earnings weeks 0.295 -> 0.322, AUC 0.737 -> 0.749, and the share of
stocks with an 80%+ call 25.6% -> 30.1% at the same 85.8% hit rate (tools/_exp4/iv_ablation.py, same-day IV scored the same, so there is no timing leak to lean on). Stocks without listed
options, and every row before 2019, carry IV as missing, the trees route missing values natively.

MIRRORED BY js/vol-forecast.js, tools/vol_sync_check.py holds them together. Features are built
from COMPLETED daily bars only, a live partial bar would read as a finished day.
"""
import json
import math
import os

import numpy as np

H = 5                     # forecast horizon, sessions
MIN_BARS = 90             # 66-day window + headroom
EPS = 1e-10
LN2X4 = 4 * math.log(2)

FEATURES = ['pk1', 'pk5', 'pk22', 'pk66', 'cc5', 'cc22', 'cc66', 'gap22', 'ar1', 'ret5', 'ret22', 'l_dv',
            'vol_ratio', 'l_vix', 'vix_rel', 'spy_rv5', 'spy_rv22', 'dow', 'earn_in', 'past20',
            'ts9', 'ts3m', 'l_vvix', 'l_iv', 'iv_rel', 'iv_rv5']
MARKET_FEATURES = ['l_vix', 'vix_rel', 'spy_rv5', 'spy_rv22', 'ts9', 'ts3m', 'l_vvix']
NAN = float('nan')
SQRT252 = math.sqrt(252)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model', 'vol_model.json')


def _half_log_mean(xs):
    return 0.5 * math.log(sum(xs) / len(xs) + EPS)


def _ratio_ln(a, b):
    return math.log(a / b) if a and b and a > 0 and b > 0 else NAN


def market_state(vix_closes, spy_closes, prev=None):
    """Market features at the last completed session. vix_closes needs >= 60, spy >= 23.
    prev: the PREVIOUS session's {vix, v9, v3m, vvix} closes for the term structure. A value
    CBOE could not supply is None and its feature is missing, never guessed."""
    lv = [math.log(v) for v in vix_closes[-60:]]
    sr = [math.log(spy_closes[i] / spy_closes[i - 1]) for i in range(len(spy_closes) - 22, len(spy_closes))]
    p = prev or {}
    return {'l_vix': lv[-1], 'vix_rel': lv[-1] - sum(lv) / len(lv),
            'spy_rv5': _half_log_mean([r * r for r in sr[-5:]]), 'spy_rv22': _half_log_mean([r * r for r in sr]),
            'ts9': _ratio_ln(p.get('v9'), p.get('vix')), 'ts3m': _ratio_ln(p.get('v3m'), p.get('vix')),
            'l_vvix': _ratio_ln(p.get('vvix'), 1.0)}


def features(bars, market, earn_in, dow, iv=None):
    """bars: completed daily bars, oldest first, each {open, high, low, close, volume}.
    earn_in: 1 when an earnings reaction session falls in the next H sessions, else 0.
    dow: weekday (Mon=0) of the LAST bar. iv: the stock's annualized implied volatility as of
    the PREVIOUS session, or None. Returns None when the history cannot support it."""
    if not bars or len(bars) < MIN_BARS or not market:
        return None
    b = bars[-(MIN_BARS + 1):]
    o = [x['open'] for x in b]
    h = [x['high'] for x in b]
    lo = [x['low'] for x in b]
    c = [x['close'] for x in b]
    v = [float(x.get('volume') or 0) for x in b]
    if min(c) <= 0 or min(lo) <= 0 or min(o) <= 0 or any(hh < ll for hh, ll in zip(h, lo)):
        return None
    n = len(b)
    pk = [math.log(h[i] / lo[i]) ** 2 / LN2X4 for i in range(n)]
    r2 = [math.log(c[i] / c[i - 1]) ** 2 for i in range(1, n)]          # r2[k] belongs to bar k+1
    g2 = [math.log(o[i] / c[i - 1]) ** 2 for i in range(1, n)]
    r_last = math.log(c[-1] / c[-2])
    dv = [c[i] * v[i] for i in range(n)]
    f = {
        'pk1': 0.5 * math.log(pk[-1] + EPS),
        'pk5': _half_log_mean(pk[-5:]), 'pk22': _half_log_mean(pk[-22:]), 'pk66': _half_log_mean(pk[-66:]),
        'cc5': _half_log_mean(r2[-5:]), 'cc22': _half_log_mean(r2[-22:]), 'cc66': _half_log_mean(r2[-66:]),
        'gap22': _half_log_mean(g2[-22:]),
        'ar1': math.log(abs(r_last) + 1e-4),
        'ret5': math.log(c[-1] / c[-6]), 'ret22': math.log(c[-1] / c[-23]),
        'l_dv': math.log(sum(dv[-20:]) / 20 + 1),
        'vol_ratio': math.log((v[-1] + 1) / (sum(v[-20:]) / 20 + 1)),
        'dow': float(dow), 'earn_in': float(1 if earn_in else 0),
        'past20': _half_log_mean(r2[-20:]),
    }
    for k in MARKET_FEATURES:
        v = market.get(k)
        f[k] = float(v) if v is not None else NAN
    l_iv = math.log(iv / SQRT252) if iv and iv > 0 else NAN
    f['l_iv'] = l_iv
    f['iv_rel'] = l_iv - f['past20']
    f['iv_rv5'] = l_iv - f['cc5']
    return f


def feature_frame(df, mkt, iv=None):
    """Vectorized features for every row of one symbol's history (training). Must equal
    features() at each row, tools/vol_sync_check.py asserts it. df: date,o,h,l,c,v, mkt indexed
    by date with MARKET_FEATURES."""
    import pandas as pd

    def rm(x, w):
        return pd.Series(x).rolling(w).mean().values

    c, h, lo, o, v = (df[k].values.astype(float) for k in ('c', 'h', 'l', 'o', 'v'))
    r = np.r_[np.nan, np.diff(np.log(c))]
    r2 = r ** 2
    pk = np.log(h / lo) ** 2 / LN2X4
    g2 = np.r_[np.nan, np.log(o[1:] / c[:-1])] ** 2
    f = pd.DataFrame({'date': df.date.values})
    f['pk1'] = 0.5 * np.log(pk + EPS)
    for w in (5, 22, 66):
        f[f'pk{w}'] = 0.5 * np.log(rm(pk, w) + EPS)
        f[f'cc{w}'] = 0.5 * np.log(rm(r2, w) + EPS)
    f['gap22'] = 0.5 * np.log(rm(g2, 22) + EPS)
    f['ar1'] = np.log(np.abs(r) + 1e-4)
    lc = pd.Series(np.log(c))
    f['ret5'] = lc.diff(5).values
    f['ret22'] = lc.diff(22).values
    f['l_dv'] = np.log(rm(c * v, 20) + 1)
    f['vol_ratio'] = np.log((v + 1) / (rm(v, 20) + 1))
    f['dow'] = df.date.dt.dayofweek.values.astype(float)
    f['past20'] = 0.5 * np.log(rm(r2, 20) + EPS)
    m = mkt.reindex(df.date.values)
    for k in MARKET_FEATURES:
        f[k] = m[k].values
    # iv: annualized implied vol aligned to df's rows, ALREADY as of the previous session.
    l_iv = np.log(np.asarray(iv, dtype=float) / SQRT252) if iv is not None else np.full(len(df), np.nan)
    f['l_iv'] = l_iv
    f['iv_rel'] = l_iv - f['past20'].values
    f['iv_rv5'] = l_iv - f['cc5'].values
    # Target: next H sessions, close to close.
    fut = pd.Series(r2[::-1]).rolling(H).mean().values[::-1]
    f['y'] = 0.5 * np.log(np.r_[fut[1:], np.nan] + EPS)
    return f


def market_frame(vix_dates, vix_closes, spy_dates, spy_closes, cboe=None):
    """MARKET_FEATURES for every SPY session (training); equals market_state() at each row.
    cboe: {'VIX9D': [(iso, close)], 'VIX3M': [...], 'VVIX': [...]}."""
    import pandas as pd
    spy = pd.Series(spy_closes, index=pd.to_datetime(spy_dates))
    vix = pd.Series(vix_closes, index=pd.to_datetime(vix_dates)).reindex(spy.index).ffill()
    lv = np.log(vix)
    sr2 = np.log(spy).diff() ** 2
    out = pd.DataFrame({'l_vix': lv, 'vix_rel': lv - lv.rolling(60).mean(),
                        'spy_rv5': 0.5 * np.log(sr2.rolling(5).mean() + EPS),
                        'spy_rv22': 0.5 * np.log(sr2.rolling(22).mean() + EPS)}, index=spy.index)

    def series(name):
        rows = (cboe or {}).get(name) or []
        s = pd.Series([v for _, v in rows], index=pd.to_datetime([d for d, _ in rows]), dtype=float)
        return s[~s.index.duplicated()].reindex(spy.index)

    # Term structure as of the PREVIOUS session (market_state's `prev`): shift one SPY session.
    out['ts9'] = np.log(series('VIX9D') / vix).shift(1)
    out['ts3m'] = np.log(series('VIX3M') / vix).shift(1)
    out['l_vvix'] = np.log(series('VVIX')).shift(1)
    return out


# --- inference -----------------------------------------------------------------------------------

def _tree(nodes, x):
    i = 0
    while True:
        nd = nodes[i]
        if len(nd) == 1:
            return nd[0]
        # [feature, threshold, left, right, missing_left]. sklearn's HistGradientBoosting goes
        # left on <=, and a missing value goes the way training sent missing values.
        v = x[nd[0]]
        if v != v:
            i = nd[2] if nd[4] else nd[3]
        else:
            i = nd[2] if v <= nd[1] else nd[3]


def _raw(m, x):
    return m['base'] + sum(_tree(t, x) for t in m['trees'])


def _interp(xs, ys, p):
    if p <= xs[0]:
        return ys[0]
    if p >= xs[-1]:
        return ys[-1]
    for k in range(1, len(xs)):
        if p <= xs[k]:
            t = (p - xs[k - 1]) / (xs[k] - xs[k - 1]) if xs[k] > xs[k - 1] else 0
            return ys[k - 1] + t * (ys[k] - ys[k - 1])
    return ys[-1]


def load_model(path=MODEL_PATH):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def predict(model, feats):
    """-> sigma (daily, fraction), its 80% range, the calmer/choppier call and its confidence."""
    if not model or not feats:
        return None
    x = [feats[k] for k in model['features']]
    ls = _raw(model['level'], x)
    earn = feats['earn_in'] >= 0.5
    q = model['residualQ']['earn' if earn else 'normal']
    raw_p = 1 / (1 + math.exp(-_raw(model['up'], x)))
    cal = model['upCalibration']
    p = _interp(cal['x'], cal['y'], raw_p)
    past = math.exp(feats['past20'])
    sure = max(p, 1 - p)
    call = 'choppier' if p >= 0.5 else 'calmer'
    # Both models must point the same way. When the size forecast sits on the other side of the
    # last 20 sessions from the call, the call was right 47-60% of the time in walk-forward
    # testing (a coin flip) against 57-92% when they agree, and the row would contradict itself.
    agrees = (ls > feats['past20']) == (p >= 0.5)
    if sure < model['minCallConfidence'] or not agrees:
        call = 'similar'
    return {'sigma': math.exp(ls), 'lo': math.exp(ls + q[0]), 'hi': math.exp(ls + q[1]),
            'past20': past, 'pUp': p, 'confidence': sure, 'call': call, 'earnIn': earn}


def bucket_for(model, confidence):
    """The measured hit rate of past calls made at this confidence, so the card can say so."""
    for b in model.get('accuracyByConfidence', []):
        if b['lo'] <= confidence < b['hi']:
            return b
    return None
