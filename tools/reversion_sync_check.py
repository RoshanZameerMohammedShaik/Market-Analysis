"""Assert the trend gate and the pullback setup agree between Python and JS, on real bars.

The cron (trend_gate.py, reversion_setup.py) decides what the LEDGER records and publishes, the
browser (js/trend-gate.js, js/reversion-setup.js) decides what the CARD shows. If they disagree,
a user sees a BUY the scorecard never graded, or a setup the landing list never listed.

Real bars from the OHLC cache when present (so the fixtures include genuine setups), plus
synthetic cases that force every gate branch. Also asserts the claims the modules make about
themselves: the gate withholds exactly the documented cases, and the RSI matches the pandas
definition the calibration was fitted with.

Run: python tools/reversion_sync_check.py
"""
import glob
import json
import math
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import reversion_setup as rv  # noqa: E402
import trend_gate as tg  # noqa: E402

passed = failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}' + (f'  -> {detail}' if detail else ''))


def synth(n, start, drift, vol_shares, seed):
    s = seed
    def nxt():
        nonlocal s
        s = (1103515245 * s + 12345) % (2 ** 31)
        return s / (2 ** 31)
    px, out = start, []
    for _ in range(n):
        px *= math.exp(drift + (nxt() - 0.5) * 0.03)
        hi, lo = px * (1 + 0.01 * nxt()), px * (1 - 0.01 * nxt())
        out.append({'close': round(px, 4), 'high': round(max(hi, px), 4), 'low': round(min(lo, px), 4),
                    'volume': vol_shares})
    return out


def fixtures():
    cases = {}
    # Real bars: a slice ending at every 40th session, so some land on genuine setups.
    files = sorted(glob.glob(os.path.join(REPO, 'model', '_ohlc_cache', '*.json')))
    for p in files[:25]:
        sym = os.path.basename(p).replace('.json', '')
        if sym.startswith('_'):
            continue
        d = json.load(open(p))
        bars = [{'close': c, 'high': h, 'low': l, 'volume': v}
                for c, h, l, v in zip(d['c'], d['h'], d['l'], d['v']) if c and h and l]
        for end in range(260, len(bars), 400):
            cases[f'{sym}@{end}'] = bars[end - 260:end]
    # Synthetic: uptrend liquid, uptrend illiquid, downtrend, short history, penny.
    up = synth(260, 50, 0.0015, 3e6, 1)
    # force a sharp two-day dip at the end, in an uptrend
    dip = [dict(b) for b in up]
    for k, f in ((-2, 0.96), (-1, 0.95)):
        dip[k] = {**dip[k], 'close': round(dip[k - 1]['close'] * f, 4)}
        dip[k]['low'] = min(dip[k]['low'], dip[k]['close'])
    cases['SYN_UP_DIP'] = dip
    cases['SYN_UP_ILLIQUID'] = [{**b, 'volume': 1000} for b in dip]
    cases['SYN_DOWN'] = synth(260, 80, -0.0015, 3e6, 2)
    cases['SYN_SHORT'] = synth(150, 50, 0.001, 3e6, 3)
    cases['SYN_PENNY'] = [{**b, 'close': b['close'] / 20, 'high': b['high'] / 20, 'low': b['low'] / 20, 'volume': 5e8}
                          for b in dip]
    return cases


def main():
    cal = rv.load_calibration()
    if not cal:
        print('ERROR: model/reversion_calibration.json missing', file=sys.stderr)
        sys.exit(1)
    cases = fixtures()
    vixes = {'low': 15.0, 'elevated': 24.0, 'high': 35.0}
    payload = {'cases': cases, 'vixes': vixes, 'cal': cal}
    fd, tmp = tempfile.mkstemp(suffix='.json', dir=os.path.join(REPO, 'tools'))
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        proc = subprocess.run(['node', os.path.join('tools', 'reversion_sync_check.mjs'), tmp, REPO],
                              capture_output=True, text=True, cwd=REPO)
    finally:
        os.remove(tmp)
    if proc.returncode != 0 or not proc.stdout.strip():
        print('ERROR: node harness failed.', file=sys.stderr)
        print(proc.stderr[:1500], file=sys.stderr)
        sys.exit(1)
    js = json.loads(proc.stdout)

    print(f'\n=== trend gate and pullback setup, Python vs JS, {len(cases)} cases x 3 VIX levels ===')
    mismatches, actives = [], 0
    for name, bars in cases.items():
        closes = [b['close'] for b in bars]
        py_state = tg.trend_state(closes, [b['volume'] for b in bars])
        j = js[name]
        for sig in ('BUY', 'SELL'):
            if tg.gate(sig, py_state, 'NYSE') != j['gate'][sig]:
                mismatches.append(f'{name} gate {sig}: py {tg.gate(sig, py_state, "NYSE")} js {j["gate"][sig]}')
        for vk, v in vixes.items():
            p = rv.evaluate(bars, 'NYSE', v, cal)
            q = j['setup'][vk]
            if (p is None) != (q is None):
                mismatches.append(f'{name}/{vk}: one side null')
                continue
            if p is None:
                continue
            if p.get('active'):
                actives += 1
            for key in ('eligible', 'active', 'tier', 'vixBand'):
                if p.get(key) != q.get(key):
                    mismatches.append(f'{name}/{vk} {key}: py {p.get(key)} js {q.get(key)}')
            if bool(p.get('reliable')) != bool(q.get('reliable')):
                mismatches.append(f'{name}/{vk} reliable: py {p.get("reliable")} js {q.get("reliable")}')
            a, b = p.get('rsi2'), q.get('rsi2')
            if (a is None) != (b is None) or (a is not None and abs(a - b) > 0.05):
                mismatches.append(f'{name}/{vk} rsi2: py {a} js {b}')
            if abs((p.get('trigger') or 0) - (q.get('trigger') or 0)) > 1e-6 * max(1, p.get('trigger') or 1):
                mismatches.append(f'{name}/{vk} trigger: py {p.get("trigger")} js {q.get("trigger")}')
    check(f'every gate decision and setup field agrees ({len(cases) * 3} evaluations)', not mismatches,
          '; '.join(mismatches[:5]))
    check(f'the fixtures include real active setups ({actives})', actives >= 3,
          'a parity check that never sees a setup cannot catch a setup bug')

    print('\n=== the gate withholds exactly what it documents ===')
    up = tg.trend_state([b['close'] for b in cases['SYN_UP_DIP']], [b['volume'] for b in cases['SYN_UP_DIP']])
    down = tg.trend_state([b['close'] for b in cases['SYN_DOWN']], [b['volume'] for b in cases['SYN_DOWN']])
    thin = tg.trend_state([b['close'] for b in cases['SYN_UP_ILLIQUID']], [b['volume'] for b in cases['SYN_UP_ILLIQUID']])
    short = tg.trend_state([b['close'] for b in cases['SYN_SHORT']], [b['volume'] for b in cases['SYN_SHORT']])
    check('a liquid uptrend BUY stands', tg.gate('BUY', up, 'NYSE') is None)
    check('a downtrend BUY is withheld', tg.gate('BUY', down, 'NYSE') == 'below-200d')
    check('an illiquid uptrend BUY is withheld', tg.gate('BUY', thin, 'NYSE') == 'illiquid')
    check('an uptrend SELL is withheld', tg.gate('SELL', up, 'NYSE') == 'above-200d')
    check('a downtrend SELL stands', tg.gate('SELL', down, 'NYSE') is None)
    check('too little history withholds both', tg.gate('BUY', short, 'NYSE') == 'no-history'
          and tg.gate('SELL', short, 'NYSE') == 'no-history')
    check('other markets are not gated (no evidence there yet)', tg.gate('BUY', down, 'LSE') is None)
    check('NEUTRAL is never touched', tg.gate('NEUTRAL', down, 'NYSE') is None)

    print('\n=== the RSI is the one the calibration was fitted with ===')
    try:
        import pandas as pd
        import numpy as np
        c = pd.Series([b['close'] for b in cases['SYN_UP_DIP']])
        d = c.diff()
        upm = d.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
        dnm = (-d.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean()
        ref = float((100 - 100 / (1 + upm / dnm.replace(0, np.nan))).iloc[-1])
        mine = rv.rsi_ewm(list(c.values)[-60:], 2)
        check(f'RSI(2) matches pandas ewm to 1e-9 ({mine:.4f})', abs(ref - mine) < 1e-9, f'{ref} vs {mine}')
    except ImportError:
        print('  (pandas unavailable; RSI reference skipped)')
    dip_rs = rv.evaluate(cases['SYN_UP_DIP'], 'NYSE', 15.0, cal)
    check('a sharp dip in a liquid uptrend is an active setup', bool(dip_rs and dip_rs.get('active')),
          json.dumps({k: dip_rs.get(k) for k in ('rsi2', 'eligible', 'reason')} if dip_rs else None))
    down_rs = rv.evaluate(cases['SYN_DOWN'], 'NYSE', 15.0, cal)
    check('a downtrend is never an eligible setup', down_rs is not None and not down_rs['eligible'])

    print(f'\nREVERSION SYNC {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
