"""Tonight's volatility forecasts for the liquid US universe, and the live grade of past ones.

Writes:
  model/vol_forecasts.json  tonight's market state + one forecast per symbol (read by the browser,
                            so the card and the landing list show the same number for a symbol)
  model/vol_pending.json    forecasts not yet 5 sessions old (append-only, not shipped)
  model/vol_record.json     the live grade: every forecast, scored once its 5 sessions have
                            closed, aggregated by confidence band, plus each symbol's recent ones

A forecast enters the record the night it is made, before the outcome exists, and is graded
with the model's own definitions: realized = sqrt(mean r^2) over the next 5 closes; "in range"
= inside its 80% range; a call is right when realized landed on the called side of the last 20
sessions' volatility. See vol_forecast.py.

Run nightly after the US close: python tools/write_vol_slice.py
"""
import datetime
import json
import math
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import earnings_calendar as ec  # noqa: E402
import vol_forecast as vf  # noqa: E402
from ledger_universe import symbols_for_region  # noqa: E402

M = os.path.join(REPO, 'model')
OUT = os.path.join(M, 'vol_forecasts.json')
PENDING = os.path.join(M, 'vol_pending.json')
RECORD = os.path.join(M, 'vol_record.json')
BATCH = 80
PER_SYMBOL_KEEP = 8
SERIES_KEEP = 120
LIQ_PRICE = 5.0
LIQ_DOLLAR_VOL = 5e7


def completed(df):
    """Drop a live partial bar: before 16:00 New York, today's row is not a close yet."""
    from zoneinfo import ZoneInfo
    ny = datetime.datetime.now(ZoneInfo('America/New_York'))
    if len(df) and df.index[-1].date() == ny.date() and (ny.hour, ny.minute) < (16, 5):
        return df.iloc[:-1]
    return df


def bars_of(sub):
    return [{'open': float(r.Open), 'high': float(r.High), 'low': float(r.Low), 'close': float(r.Close),
             'volume': float(r.Volume)} for r in sub.itertuples()]


def next_day(d):
    return d + datetime.timedelta(days=1)


def r4(x):
    return round(float(x), 4)


def grade(p, sub):
    """p: a pending forecast; sub: that symbol's bars (DataFrame, completed). None until 5
    sessions after p's session have closed."""
    dates = [d.strftime('%Y-%m-%d') for d in sub.index]
    if p['session'] not in dates:
        return None
    i = dates.index(p['session'])
    if i + vf.H >= len(dates):
        return None
    c = sub.Close.values
    rs = [math.log(c[k] / c[k - 1]) for k in range(i + 1, i + 1 + vf.H)]
    realized = math.sqrt(sum(r * r for r in rs) / len(rs))
    out = {**p, 'realized': r4(realized), 'inRange': p['lo'] <= realized <= p['hi']}
    if p['call'] != 'similar':
        out['right'] = (realized > p['past20']) == (p['call'] == 'choppier')
    return out


def aggregate(rec, graded):
    """Fold newly graded forecasts into the running record. Counts only; nothing is re-fit."""
    o = rec.setdefault('overall', {'n': 0, 'inRange': 0, 'absLogErr': 0.0, 'calls': 0, 'right': 0})
    buckets = {b['key']: b for b in rec.setdefault('byConfidence', [])}
    earn = rec.setdefault('earnings', {'n': 0, 'inRange': 0})
    days = {d['session']: d for d in rec.setdefault('series', [])}
    per = rec.setdefault('perSymbol', {})
    for g in graded:
        o['n'] += 1
        o['inRange'] += int(g['inRange'])
        o['absLogErr'] += abs(math.log(max(g['realized'], 1e-5) / g['sigma']))
        d = days.setdefault(g['session'], {'session': g['session'], 'n': 0, 'inRange': 0, 'calls': 0, 'right': 0})
        d['n'] += 1
        d['inRange'] += int(g['inRange'])
        if g.get('earnIn'):
            earn['n'] += 1
            earn['inRange'] += int(g['inRange'])
        if 'right' in g:
            o['calls'] += 1
            o['right'] += int(g['right'])
            d['calls'] += 1
            d['right'] += int(g['right'])
            lo = min(int(g['confidence'] * 10) / 10, 0.9)
            key = f'{lo:.1f}'
            b = buckets.setdefault(key, {'key': key, 'lo': lo, 'hi': round(lo + 0.1, 1), 'n': 0, 'right': 0})
            b['n'] += 1
            b['right'] += int(g['right'])
        lst = per.setdefault(g['symbol'], [])
        lst.append({k: g[k] for k in ('session', 'sigma', 'lo', 'hi', 'past20', 'realized', 'inRange', 'call', 'confidence')
                    if k in g} | ({'right': g['right']} if 'right' in g else {}))
        per[g['symbol']] = sorted(lst, key=lambda x: x['session'])[-PER_SYMBOL_KEEP:]
    o['absLogErr'] = round(o['absLogErr'], 4)
    rec['byConfidence'] = sorted(buckets.values(), key=lambda b: b['lo'])
    rec['series'] = sorted(days.values(), key=lambda d: d['session'])[-SERIES_KEEP:]


def main():
    import yfinance as yf

    model = vf.load_model()
    if not model:
        sys.exit('ERROR: model/vol_model.json missing; run tools/train_vol_model.py')
    mk = {}
    for t in ('^VIX', 'SPY'):
        d = yf.download(t, period='6mo', progress=False, auto_adjust=False)
        d.columns = [c[0] if isinstance(c, tuple) else c for c in d.columns]
        mk[t] = completed(d.dropna(subset=['Close']))
    common = mk['SPY'].index.intersection(mk['^VIX'].index)
    market = vf.market_state(mk['^VIX'].Close.reindex(common).values.tolist(), mk['SPY'].Close.reindex(common).values.tolist())
    msession = common[-1].strftime('%Y-%m-%d')

    pending = json.load(open(PENDING, encoding='utf-8')) if os.path.exists(PENDING) else []
    syms = sorted({s for s in symbols_for_region('NYSE') if '.' not in s and '-' not in s} | {p['symbol'] for p in pending})
    eslice = ec.load_slice()
    forecasts, bars_by, session = {}, {}, None
    for i in range(0, len(syms), BATCH):
        chunk = syms[i:i + BATCH]
        try:
            df = yf.download(chunk, period='1y', interval='1d', progress=False, auto_adjust=False,
                             group_by='ticker', threads=True)
        except Exception as e:
            print(f'  [warn] batch {i}: {type(e).__name__}', file=sys.stderr)
            continue
        for s in chunk:
            try:
                sub = completed(df[s].dropna(subset=['Open', 'High', 'Low', 'Close']))
            except Exception:
                continue
            if len(sub) < vf.MIN_BARS + 1:
                continue
            bars_by[s] = sub
            last = sub.index[-1].date()
            if last.isoformat() != msession:
                continue                      # stale or halted: its market features would not match
            session = msession
            eday = ec.earnings_day(s, 'NYSE', next_day(last), eslice, n=vf.H)
            f = vf.features(bars_of(sub), market, bool(eday), last.weekday())
            p = vf.predict(model, f)
            if not p:
                continue
            forecasts[s] = {'s': r4(p['sigma']), 'lo': r4(p['lo']), 'hi': r4(p['hi']), 'p20': r4(p['past20']),
                            'pUp': r4(p['pUp']), 'c': r4(p['confidence']), 'call': p['call'],
                            'e': 1 if p['earnIn'] else (0 if eday == 0 else None),
                            # Liquid by the trend gate's bar. The landing outlook lists only these:
                            # "calmer after a 60% day" on a penny stock is true and useless.
                            'liq': 1 if (f['l_dv'] >= math.log(LIQ_DOLLAR_VOL) and sub.Close.values[-1] >= LIQ_PRICE) else 0}
        time.sleep(1.0)

    universe = len({s for s in symbols_for_region('NYSE') if '.' not in s and '-' not in s})
    if len(forecasts) < 0.5 * universe:
        sys.exit(f'ERROR: only {len(forecasts)}/{universe} forecasts; not publishing.')

    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'sessionDate': session, 'horizon': vf.H, 'market': {k: r4(v) for k, v in market.items()},
                   'forecasts': forecasts}, fh, separators=(',', ':'), allow_nan=False)

    # Grade what has matured, then queue tonight's.
    still, graded = [], []
    for p in pending:
        sub = bars_by.get(p['symbol'])
        g = grade(p, sub) if sub is not None else None
        if g:
            graded.append(g)
        elif p['session'] >= (datetime.date.fromisoformat(session) - datetime.timedelta(days=30)).isoformat():
            still.append(p)                   # not mature yet (or a data gap): keep, up to 30 days
    have = {(p['session'], p['symbol']) for p in still}
    for s, x in forecasts.items():
        if (session, s) not in have:
            still.append({'session': session, 'symbol': s, 'sigma': x['s'], 'lo': x['lo'], 'hi': x['hi'],
                          'past20': x['p20'], 'call': x['call'], 'confidence': x['c'], 'earnIn': x['e'] == 1})
    rec = json.load(open(RECORD, encoding='utf-8')) if os.path.exists(RECORD) else {}
    rec.setdefault('since', session)
    aggregate(rec, graded)
    rec['generatedAt'] = datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    rec['pending'] = len(still)
    rec['backtest'] = {'accuracyByConfidence': model['accuracyByConfidence'], 'walkForward': model['walkForward']}
    with open(PENDING, 'w', encoding='utf-8') as fh:
        json.dump(still, fh, separators=(',', ':'))
    with open(RECORD, 'w', encoding='utf-8') as fh:
        json.dump(rec, fh, separators=(',', ':'), allow_nan=False)
    o = rec['overall']
    print(f'Wrote {OUT}: {len(forecasts)} forecasts for session {session}; graded {len(graded)} tonight, '
          f'{o["n"]} all-time ({o["inRange"]} in range, {o["right"]}/{o["calls"]} calls right); {len(still)} pending')


if __name__ == '__main__':
    main()
