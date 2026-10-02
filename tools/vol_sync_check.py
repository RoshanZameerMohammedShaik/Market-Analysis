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
    market = {'l_vix': math.log(17.2), 'vix_rel': 0.04, 'spy_rv5': -5.1, 'spy_rv22': -4.9}
    cases, frame_diffs = [], []
    for sym, bars in series():
        if len(bars) < 200:
            continue
        df = pd.DataFrame({'date': pd.to_datetime([b['date'] for b in bars]), 'o': [b['open'] for b in bars],
                           'h': [b['high'] for b in bars], 'l': [b['low'] for b in bars], 'c': [b['close'] for b in bars],
                           'v': [b['volume'] for b in bars]})
        mkt = pd.DataFrame({k: market[k] for k in vf.MARKET_FEATURES}, index=df.date)
        fr = vf.feature_frame(df, mkt)
        for t in random.Random(sym).sample(range(vf.MIN_BARS + 5, len(bars)), 5):
            cut = bars[:t + 1]
            dow = int(pd.Timestamp(cut[-1]['date']).dayofweek)
            earn = (t % 3 == 0)
            f = vf.features(cut, market, earn, dow)
            row = fr.iloc[t]
            frame_diffs.append(max(abs(f[k] - row[k]) for k in vf.FEATURES if k != 'earn_in'))
            cases.append({'bars': cut[-(vf.MIN_BARS + 1):], 'earn': earn, 'dow': dow, 'py': f, 'pred': vf.predict(model, f)})
    check(f'training features == live features ({len(frame_diffs)} rows)', max(frame_diffs) < 1e-9, max(frame_diffs))

    tmp = os.path.join(REPO, 'tools', '_vol_sync_cases.json')
    with open(tmp, 'w') as fh:
        json.dump({'market': market, 'cases': [{k: c[k] for k in ('bars', 'earn', 'dow')} for c in cases]}, fh)
    try:
        out = subprocess.run(['node', os.path.join(REPO, 'tools', 'vol_sync_check.mjs'), tmp],
                             capture_output=True, text=True, cwd=REPO, timeout=120)
    finally:
        os.remove(tmp)
    if out.returncode != 0:
        check('node evaluation ran', False, out.stderr[-500:])
        return
    js = json.loads(out.stdout)
    fd = max(abs(c['py'][k] - j['f'][k]) for c, j in zip(cases, js) for k in vf.FEATURES)
    check('JS features == Python features', fd < 1e-9, fd)
    pdiff = max(max(abs(c['pred'][k] - j['p'][k]) for k in ('sigma', 'lo', 'hi', 'pUp', 'confidence')) for c, j in zip(cases, js))
    check('JS forecast == Python forecast', pdiff < 1e-9, pdiff)
    check('JS call == Python call', all(c['pred']['call'] == j['p']['call'] for c, j in zip(cases, js)))

    f = cases[0]['py']
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
    acc = model['accuracyByConfidence']
    check('published accuracy rises with confidence', all(acc[i]['hitRate'] < acc[i + 1]['hitRate'] for i in range(len(acc) - 1)),
          [x['hitRate'] for x in acc])


if __name__ == '__main__':
    main()
    print(f'\nVOL SYNC {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)
