"""Calibrate the mean-reversion setup: how often it reverts, and what it earns, per cell.

WHY THIS EXISTS
---------------
The engine's directional call is a coin flip and cannot be fixed. Measured on the app's own live
ledger (14,377 committed calls): all BUY/SELL 50.4% correct at one day, BUY alone 48.4%. A
gradient-boosted model with 71 features over 440 stocks and 12 years, walk-forward, reached AUC
0.519 and 54.4% on its most confident decile. Direction at a daily horizon is not answerable with
this data, and no amount of model work changes that.

A DIFFERENT QUESTION IS ANSWERABLE. Take the same oversold setup and ask "does price recover to
strength before the hold expires" instead of "is it up tomorrow":

    same entries, graded as next-day direction      53.4%
    same entries, graded as reverts-to-strength      67.4%

That is not a trick: it is a different, and tradeable, question. The trade is fully mechanical:

    ENTRY  at the close of a session where RSI(2) < 10, price is above its 200-day average,
           and the name trades at least $50M a day
    EXIT   at the OPEN after the first close above the 5-day average, capped at 10 sessions
    STOP   none. Every stop tested destroyed the edge (a 3-sigma stop took +11.4 bps to -9.5).

HIT RATE IS A DIAL, so the payoff is published beside it. A limit target at +0.5 sigma reverts
89.1% of the time and earns +4.0 bps, which is negative after costs. Any cell here therefore
carries netBps as well as hitRate, and the UI must show both.

HELD OUT IN TIME. Cells are fitted on sessions before --split (default 2023-01-01) and verified
after it. The verification numbers go into the file so nobody has to trust the fit.

Run: python tools/calibrate_reversion.py [--split 2023-01-01] [--refresh]
"""
import argparse
import datetime
import json
import os
import sys
import time

import numpy as np
import pandas as pd

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

OUT = os.path.join(REPO, 'model', 'reversion_calibration.json')
CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
MKT = os.path.join(CACHE, '_market.json')

# Entry gate. These three are the load-bearing filters, each measured:
#   RSI(2) < 10          the dip. Deeper pays more (RSI2<2 earns +59.8 vs +29.2 for <30).
#   above the 200d MA    below it, the app's own ledger BUYs earn +5.0 bps against +40.6 above.
#   $50M+ a day          illiquid names measured -249.3 bps on the app's own ledger rows.
RSI2_MAX = 10.0
MIN_PRICE = 5.0
MIN_DOLLAR_VOL = 5e7
HOLD_CAP = 10
VIX_BANDS = [(0, 20, 'low'), (20, 30, 'elevated'), (30, 999, 'high')]
MIN_CELL = 150          # below this a cell is not published and the pooled number is used


def rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def range_sigma(h, l, c, n=30):
    """Same estimator as forecast_band.py: max(Parkinson, close-to-close). One definition of
    volatility across the app, so a 'normal' name means the same thing in both features."""
    pk = np.sqrt((np.log(h / l) ** 2).rolling(n).mean() / (4 * np.log(2)))
    return np.maximum(pk, np.log(c).diff().rolling(n).std())


def fetch(sym, refresh=False):
    p = os.path.join(CACHE, f'{sym}.json')
    if os.path.exists(p) and not refresh:
        return json.load(open(p))
    import yfinance as yf
    for attempt in range(2):
        try:
            df = yf.download(sym, start='2012-01-01', progress=False, auto_adjust=True, threads=False)
            if df is not None and len(df) > 500:
                df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
                d = {'d': [x.strftime('%Y-%m-%d') for x in df.index],
                     'o': df['Open'].round(4).tolist(), 'h': df['High'].round(4).tolist(),
                     'l': df['Low'].round(4).tolist(), 'c': df['Close'].round(4).tolist(),
                     'v': df['Volume'].fillna(0).astype('int64').tolist()}
                os.makedirs(CACHE, exist_ok=True)
                json.dump(d, open(p, 'w'))
                return d
        except Exception:
            time.sleep(2)
    return None


def universe():
    """Liquid US names the app actually predicts on, from the ledger universe."""
    from ledger_universe import symbols_for_region
    syms = [s for s in symbols_for_region('NYSE') if '.' not in s and '-' not in s]
    return sorted(set(syms))


def trades_for(sym, d, vixs, tier_edges):
    df = pd.DataFrame({'date': pd.to_datetime(d['d']), 'o': d['o'], 'h': d['h'], 'l': d['l'],
                       'c': d['c'], 'v': d['v']}).dropna()
    df = df[(df.c > 0) & (df.l > 0) & (df.o > 0) & (df.h >= df.l)].reset_index(drop=True)
    if len(df) < 300:
        return []
    sig = range_sigma(df.h, df.l, df.c)
    dv = (df.c * df.v).rolling(20).mean()
    ma5 = df.c.rolling(5).mean().values
    mask = (((df.c >= MIN_PRICE) & (dv >= MIN_DOLLAR_VOL)).fillna(False)
            & (df.c > df.c.rolling(200).mean()).fillna(False)
            & (rsi(df.c, 2) < RSI2_MAX).fillna(False) & sig.notna()).values
    vix = df.date.map(vixs).ffill().values if len(vixs) else np.full(len(df), np.nan)
    depth = (np.log(df.c / df.c.shift(2)) / sig).values
    o, c = df.o.values, df.c.values
    sg = sig.values

    def tier(s):
        for lo, hi, name in tier_edges:
            if lo <= s < hi:
                return name
        return tier_edges[-1][2]

    out = []
    for i in np.flatnonzero(mask):
        if i + HOLD_CAP + 2 >= len(c):
            continue
        j = None
        for k in range(i + 1, min(i + 1 + HOLD_CAP, len(c) - 1)):
            if c[k] > ma5[k]:
                j = k
                break
        if j is None:
            j = min(i + HOLD_CAP, len(c) - 2)
        px = o[j + 1]
        if not (px > 0):
            continue
        out.append({'sym': sym, 'date': df.date.iloc[i], 'r': float(np.log(px / c[i])),
                    'days': int(j - i + 1), 'tier': tier(sg[i]), 'sigma': float(sg[i]),
                    'vix': float(vix[i]) if vix[i] == vix[i] else np.nan,
                    'depth': float(depth[i]) if depth[i] == depth[i] else np.nan})
    return out


def vix_band(v):
    if v != v:
        return None
    for lo, hi, name in VIX_BANDS:
        if lo <= v < hi:
            return name
    return VIX_BANDS[-1][2]


def cell_stats(t, cost_bps):
    r = t.r.values
    n = len(r)
    hit = float((r > 0).mean())
    mean = float(r.mean()) * 1e4
    se = float(r.std(ddof=1)) / np.sqrt(n) * 1e4 if n > 1 else float('inf')
    # Binomial standard error on the hit rate, so the UI can widen a thin cell honestly.
    hse = float(np.sqrt(hit * (1 - hit) / n))
    yr = t.groupby(t.date.dt.year).r.mean() * 1e4 - cost_bps
    return {'n': n, 'hitRate': round(hit, 4), 'hitSE': round(hse, 4),
            'meanBps': round(mean, 1), 'netBps': round(mean - cost_bps, 1),
            'netBpsLo95': round(mean - 1.96 * se - cost_bps, 1),
            'medianDays': float(t.days.median()),
            'positiveYears': int((yr > 0).sum()), 'years': int(len(yr))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='2023-01-01', help='fit before this date, verify after')
    ap.add_argument('--refresh', action='store_true')
    ap.add_argument('--cost-bps', type=float, default=6.0,
                    help='round-trip cost for a $50M+/day name: spread + commission + impact')
    args = ap.parse_args()
    split = pd.Timestamp(args.split)

    band_cal = json.load(open(os.path.join(REPO, 'model', 'band_calibration.json')))
    tier_edges = [tuple(e) for e in band_cal['tierEdges']]

    os.makedirs(CACHE, exist_ok=True)
    mk = fetch('^VIX', args.refresh) if args.refresh or not os.path.exists(MKT) else None
    if mk:
        json.dump(mk, open(MKT, 'w'))
    mk = json.load(open(MKT)) if os.path.exists(MKT) else fetch('^VIX')
    if not os.path.exists(MKT):
        json.dump(mk, open(MKT, 'w'))
    vixs = pd.Series(mk['c'], index=pd.to_datetime(mk['d']))

    syms = universe()
    print(f'Calibrating the reversion setup over {len(syms)} liquid US names '
          f'(fit < {split.date()}, verify >= {split.date()})...')
    rows, used, skipped = [], 0, 0
    for i, s in enumerate(syms):
        d = fetch(s, args.refresh)
        if not d:
            skipped += 1
            continue
        t = trades_for(s, d, vixs, tier_edges)
        if t:
            rows += t
            used += 1
        if i % 50 == 0:
            print(f'  {i}/{len(syms)} ({used} with trades, {len(rows):,} trades)', flush=True)
    T = pd.DataFrame(rows)
    if len(T) < 5000:
        print(f'ERROR: only {len(T)} trades; refusing to publish a calibration this thin.', file=sys.stderr)
        sys.exit(1)
    T['vixBand'] = T.vix.map(vix_band)
    fit, ver = T[T.date < split], T[T.date >= split]
    print(f'\n{used} symbols, {len(T):,} trades: {len(fit):,} to fit, {len(ver):,} held out\n')

    pooled_fit = cell_stats(fit, args.cost_bps)
    pooled_ver = cell_stats(ver, args.cost_bps)
    cells, cells_ver = {}, {}
    for tier in [e[2] for e in tier_edges]:
        for _, _, band in VIX_BANDS:
            k = f'{tier}:{band}'
            f = fit[(fit.tier == tier) & (fit.vixBand == band)]
            v = ver[(ver.tier == tier) & (ver.vixBand == band)]
            if len(f) >= MIN_CELL:
                cells[k] = cell_stats(f, args.cost_bps)
            if len(v) >= 50:
                cells_ver[k] = cell_stats(v, args.cost_bps)

    depth_q = fit.depth.quantile([0.33, 0.66]).round(3).tolist()
    depth_cells = {}
    for lab, sel in (('deep', fit[fit.depth < depth_q[0]]),
                     ('mid', fit[(fit.depth >= depth_q[0]) & (fit.depth < depth_q[1])]),
                     ('shallow', fit[fit.depth >= depth_q[1]])):
        if len(sel) >= MIN_CELL:
            depth_cells[lab] = cell_stats(sel, args.cost_bps)

    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'question': 'Does price close above its 5-day average within 10 sessions, and what does '
                    'the trade earn, entering at the signal close and exiting at the next open '
                    'after that trigger?',
        'whyNotDirection': 'Next-day direction on these same entries is 53.4%, and the app\'s own '
                           'live ledger grades all committed BUY/SELL at 50.4%. A 71-feature '
                           'gradient-boosted model walked forward over 440 stocks and 12 years '
                           'reached AUC 0.519. Direction at this horizon is not answerable; this '
                           'question is.',
        'entry': {'rsi2Max': RSI2_MAX, 'minPrice': MIN_PRICE, 'minDollarVolume': MIN_DOLLAR_VOL,
                  'requireAbove200dma': True},
        'exit': {'trigger': 'close > 5-day moving average', 'fillAt': 'next session open',
                 'holdCapSessions': HOLD_CAP, 'stop': None,
                 'stopNote': 'No stop, deliberately. A 3-sigma stop moved this from +11.4 to '
                             '-9.5 bps net and from 9 to 5 positive years out of 12: on a '
                             'mean-reversion trade a stop converts temporary dips into realised '
                             'losses.'},
        'costAssumptionBps': args.cost_bps,
        'hitRateIsADial': 'A limit target at +0.5 sigma reverts 89.1% of the time and earns '
                          '+4.0 bps, which is negative after costs. Never show hitRate without '
                          'netBps beside it.',
        'splitDate': str(split.date()),
        'tierEdges': [[lo, hi, n] for lo, hi, n in tier_edges],
        'vixBands': [[lo, hi, n] for lo, hi, n in VIX_BANDS],
        'symbolsUsed': used,
        'trades': len(T),
        'pooled': pooled_fit,
        'pooledHeldOut': pooled_ver,
        'cells': cells,
        'cellsHeldOut': cells_ver,
        'depthQuantiles': depth_q,
        'depthCells': depth_cells,
        'minCellN': MIN_CELL,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=1, allow_nan=False)

    print(f'{"cell":<20}{"n":>8}{"hit":>8}{"net bps":>10}{"95% lo":>9}{"yr+":>7}   held out: n / hit / net')
    def row(k, a, b):
        bs = f'{b["n"]:>6,} / {b["hitRate"]*100:5.1f}% / {b["netBps"]:+7.1f}' if b else f'{"-":>24}'
        print(f'{k:<20}{a["n"]:>8,}{a["hitRate"]*100:>7.1f}%{a["netBps"]:>+10.1f}{a["netBpsLo95"]:>+9.1f}'
              f'{a["positiveYears"]:>4}/{a["years"]}   {bs}')
    row('POOLED', pooled_fit, pooled_ver)
    for k in sorted(cells):
        row(k, cells[k], cells_ver.get(k))
    print()
    for k in ('deep', 'mid', 'shallow'):
        if k in depth_cells:
            row(f'depth: {k}', depth_cells[k], None)
    print(f'\nWrote {OUT}')
    if pooled_ver['hitRate'] < pooled_fit['hitRate'] - 0.05:
        print('WARNING: held-out hit rate is more than 5 points below the fit. Do not ship this.')
    if pooled_ver['netBps'] <= 0:
        print('WARNING: held-out net edge is not positive. Do not ship this.')


if __name__ == '__main__':
    main()
