"""The volatility forecast must be the SAME model in Python (nightly slice, training) and in the
browser (the card): same features from the same bars, same trees, same calibration.

Checked on real bars (model/_ohlc_cache when present, else synthetic):
  1. training features (vol_forecast.feature_frame) == live features (vol_forecast.features)
     at the same row, so the model is served the inputs it was trained on;
  2. js/vol-forecast.js volFeatures/volPredict == the Python ones;
  3. forced branches: an earnings week widens the range, "similar" below the call threshold,
     and too little history is refused rather than guessed.

Run: python tools/vol_sync_check.py
"""
import json
import math
import os
import random
import subprocess
import sys

import pandas as pd

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import vol_forecast as vf  # noqa: E402

CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
passed = failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}  -> {detail}')


def synthetic(seed, n=400):
    rng = random.Random(seed)
    px, out = 50.0, []
    vol = 0.01 + 0.03 * rng.random()
    day = pd.Timestamp('2020-01-01')
    for _ in range(n):
        day += pd.offsets.BDay(1)
        o = px * math.exp(rng.gauss(0, vol / 3))
        c = o * math.exp(rng.gauss(0, vol))
        h = max(o, c) * math.exp(abs(rng.gauss(0, vol / 2)))
        lo = min(o, c) * math.exp(-abs(rng.gauss(0, vol / 2)))
        out.append({'date': day.strftime('%Y-%m-%d'), 'open': o, 'high': h, 'low': lo, 'close': c,
                    'volume': rng.randint(100_000, 5_000_000)})
        px = c
    return out


def series():
    files = sorted(f for f in os.listdir(CACHE) if not f.startswith('_')) if os.path.isdir(CACHE) else []
    if files:
        for fn in random.Random(7).sample(files, 40):
            d = json.load(open(os.path.join(CACHE, fn)))
            yield fn[:-5], [{'date': d['d'][i], 'open': d['o'][i], 'high': d['h'][i], 'low': d['l'][i], 'close': d['c'][i],
                             'volume': d['v'][i]} for i in range(len(d['d']))
                            if d['c'][i] and d['l'][i] and d['o'][i] and d['h'][i] and d['h'][i] >= d['l'][i] > 0]
    else:
        for s in range(40):
            yield f'SYN{s}', synthetic(s)


def main():
    model = vf.load_model()
    check('model/vol_model.json loads', model is not None)
    if not model:
        return
    # Two market states: term structure present, and CBOE unreadable (missing, routed natively).
    markets = [{'l_vix': math.log(17.2), 'vix_rel': 0.04, 'spy_rv5': -5.1, 'spy_rv22': -4.9,
                'ts9': -0.12, 'ts3m': 0.09, 'l_vvix': math.log(92.0)},
               {'l_vix': math.log(24.0), 'vix_rel': 0.2, 'spy_rv5': -4.6, 'spy_rv22': -4.8,
                'ts9': None, 'ts3m': None, 'l_vvix': None}]
    market = markets[0]
    cases, frame_diffs = [], []
    for sym, bars in series():
        if len(bars) < 200:
            continue
        df = pd.DataFrame({'date': pd.to_datetime([b['date'] for b in bars]), 'o': [b['open'] for b in bars],
                           'h': [b['high'] for b in bars], 'l': [b['low'] for b in bars], 'c': [b['close'] for b in bars],
                           'v': [b['volume'] for b in bars]})
        mkt = pd.DataFrame({k: market[k] for k in vf.MARKET_FEATURES}, index=df.date)
        ivs = [0.15 + 0.6 * random.Random(sym + str(i)).random() for i in range(len(bars))]
        fr = vf.feature_frame(df, mkt, ivs)
        for t in random.Random(sym).sample(range(vf.MIN_BARS + 5, len(bars)), 5):
            cut = bars[:t + 1]
            dow = int(pd.Timestamp(cut[-1]['date']).dayofweek)
            earn = (t % 3 == 0)
            f = vf.features(cut, market, earn, dow, ivs[t])
            row = fr.iloc[t]
            frame_diffs.append(max(abs(f[k] - row[k]) for k in vf.FEATURES if k != 'earn_in'))
            # Then the cases the browser will meet: with and without the stock's IV, with and
            # without the term structure.
            for mi, iv in ((0, ivs[t]), (0, None), (1, ivs[t]), (1, None)):
                fx = vf.features(cut, markets[mi], earn, dow, iv)
                cases.append({'bars': cut[-(vf.MIN_BARS + 1):], 'earn': earn, 'dow': dow, 'iv': iv, 'm': mi,
                              'py': fx, 'pred': vf.predict(model, fx)})
    check(f'training features == live features ({len(frame_diffs)} rows)', max(frame_diffs) < 1e-9, max(frame_diffs))

    tmp = os.path.join(REPO, 'tools', '_vol_sync_cases.json')
    with open(tmp, 'w') as fh:
        json.dump({'markets': markets, 'cases': [{k: c[k] for k in ('bars', 'earn', 'dow', 'iv', 'm')} for c in cases]}, fh)
    try:
        out = subprocess.run(['node', os.path.join(REPO, 'tools', 'vol_sync_check.mjs'), tmp],
                             capture_output=True, text=True, cwd=REPO, timeout=120)
    finally:
        os.remove(tmp)
    if out.returncode != 0:
        check('node evaluation ran', False, out.stderr[-500:])
        return
    js = json.loads(out.stdout)
    def same(a, b):
        # JSON carries NaN as null.
        if b is None or a != a:
            return (a != a) and b is None
        return abs(a - b) < 1e-9
    bad = [(k, c['py'][k], j['f'][k]) for c, j in zip(cases, js) for k in vf.FEATURES if not same(c['py'][k], j['f'][k])]
    check(f'JS features == Python features ({len(cases)} cases, IV and term structure present and missing)', not bad, bad[:3])
    check('missing IV really is missing on both sides',
          all((c['iv'] is None) == (c['py']['l_iv'] != c['py']['l_iv']) for c in cases))
    pdiff = max(max(abs(c['pred'][k] - j['p'][k]) for k in ('sigma', 'lo', 'hi', 'pUp', 'confidence')) for c, j in zip(cases, js))
    check('JS forecast == Python forecast', pdiff < 1e-9, pdiff)
    check('JS call == Python call', all(c['pred']['call'] == j['p']['call'] for c, j in zip(cases, js)))

    f = cases[0]['py']
    check('the forecast exists without IV and without the term structure',
          all(c['pred'] is not None for c in cases if c['iv'] is None and c['m'] == 1))
    a = vf.predict(model, {**f, 'earn_in': 0.0})
    b = vf.predict(model, {**f, 'earn_in': 1.0})
    check('an earnings week forecasts more volatility and a wider range',
          b['sigma'] > a['sigma'] and (b['hi'] / b['lo']) > (a['hi'] / a['lo']), (a['sigma'], b['sigma']))
    check('the 80% range contains the forecast', all(c['pred']['lo'] < c['pred']['sigma'] < c['pred']['hi'] for c in cases))
    thr = model['minCallConfidence']
    check('"similar" exactly when under the threshold or the two models disagree',
          all((c['pred']['call'] == 'similar') == (c['pred']['confidence'] < thr or
              (c['pred']['sigma'] > c['pred']['past20']) != (c['pred']['pUp'] >= 0.5)) for c in cases))
    check('a call never contradicts its own size forecast',
          all(c['pred']['call'] == 'similar' or (c['pred']['sigma'] > c['pred']['past20']) == (c['pred']['call'] == 'choppier')
              for c in cases))
    check('too little history is refused', vf.features(cases[0]['bars'][-50:], market, False, 1) is None)
    # Market state: training's vectorized frame must equal the nightly market_state() on the same
    # history, including the previous-session term structure.
    rng = random.Random(11)
    days = pd.bdate_range('2024-01-01', periods=160)
    vix_c = [15 + 5 * rng.random() for _ in days]
    spy_c = [400.0]
    for _ in days[1:]:
        spy_c.append(spy_c[-1] * math.exp(rng.gauss(0, 0.01)))
    iso = [d.strftime('%Y-%m-%d') for d in days]
    cboe = {'VIX9D': [(d, v * (0.9 + 0.2 * rng.random())) for d, v in zip(iso, vix_c)],
            'VIX3M': [(d, v * (1.0 + 0.2 * rng.random())) for d, v in zip(iso, vix_c)],
            'VVIX': [(d, 80 + 20 * rng.random()) for d in iso]}
    mf = vf.market_frame(iso, vix_c, iso, spy_c, cboe)
    k = len(iso) - 1
    prev = {'vix': vix_c[k - 1], 'v9': cboe['VIX9D'][k - 1][1], 'v3m': cboe['VIX3M'][k - 1][1], 'vvix': cboe['VVIX'][k - 1][1]}
    ms = vf.market_state(vix_c, spy_c, prev)
    row = mf.iloc[k]
    md = max(abs(ms[x] - row[x]) for x in vf.MARKET_FEATURES)
    check('training market frame == nightly market state (term structure lagged one session)', md < 1e-9, md)
    gone = vf.market_state(vix_c, spy_c, {'vix': vix_c[k - 1]})
    check('CBOE unreadable: term structure missing, not guessed', all(gone[x] != gone[x] for x in ('ts9', 'ts3m', 'l_vvix')))

    acc = model['accuracyByConfidence']
    check('published accuracy rises with confidence', all(acc[i]['hitRate'] < acc[i + 1]['hitRate'] for i in range(len(acc) - 1)),
          [x['hitRate'] for x in acc])


if __name__ == '__main__':
    main()
    print(f'\nVOL SYNC {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)
