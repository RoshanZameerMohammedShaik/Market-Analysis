"""Publish today's pullback setups across the liquid US universe: model/setups.json.

Runs after the US close (nightly job), so every setup listed is CONFIRMED on a final closing
price and the trade it describes enters at the next open (the measured +31 bps variant, entering
at the close itself is +37 bps but needs the setup known before the bell, which is what the live
card's "forming" state is for). See reversion_setup.py and tools/calibrate_reversion.py.

Only setups whose calibration cell is statistically positive are listed, a qualifying dip in an
unreliable cell is counted in `unflagged` rather than shown as a signal.

Run: python tools/write_setups_slice.py
"""
import datetime
import json
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import yfinance as yf  # noqa: E402

import reversion_setup as rv  # noqa: E402
from ledger_universe import symbols_for_region  # noqa: E402

OUT = os.path.join(REPO, 'model', 'setups.json')
BATCH = 80


def main():
    cal = rv.load_calibration()
    if not cal:
        print('ERROR: model/reversion_calibration.json missing; run tools/calibrate_reversion.py', file=sys.stderr)
        sys.exit(1)
    syms = sorted({s for s in symbols_for_region('NYSE') if '.' not in s and '-' not in s})
    vix = None
    try:
        v = yf.download('^VIX', period='5d', progress=False, auto_adjust=True)
        v.columns = [c[0] if isinstance(c, tuple) else c for c in v.columns]
        vix = float(v['Close'].dropna().iloc[-1])
    except Exception as e:
        print(f'  [warn] VIX unavailable ({type(e).__name__}); cells cannot be chosen', file=sys.stderr)

    setups, unflagged, scanned, session = [], 0, 0, None
    for i in range(0, len(syms), BATCH):
        chunk = syms[i:i + BATCH]
        try:
            df = yf.download(chunk, period='1y', interval='1d', progress=False, auto_adjust=True,
                             group_by='ticker', threads=True)
        except Exception as e:
            print(f'  [warn] batch {i}: {type(e).__name__}', file=sys.stderr)
            continue
        for s in chunk:
            try:
                sub = df[s].dropna()
            except Exception:
                continue
            if len(sub) < 200:
                continue
            candles = [{'close': float(r.Close), 'high': float(r.High), 'low': float(r.Low),
                        'volume': float(r.Volume)} for r in sub.itertuples()]
            scanned += 1
            session = max(session or '', sub.index[-1].strftime('%Y-%m-%d'))
            res = rv.evaluate(candles, 'NYSE', vix, cal)
            if not res or not res.get('active'):
                continue
            if not res.get('reliable'):
                unflagged += 1
                continue
            c = res['cell']
            # What the list shows instead of RSI(2): the run of down closes and how far it went.
            # RSI(2) under 10 fires on a STREAK of down days whatever their size (KO qualified on
            # 2026-10-02 down 0.5% over two days), so "a sharp dip" was the wrong description.
            closes = [c['close'] for c in candles]
            streak = 0
            while streak + 1 < len(closes) and closes[-1 - streak] < closes[-2 - streak]:
                streak += 1
            run_pct = round((closes[-1] / closes[-1 - streak] - 1) * 100, 2) if streak else 0.0
            setups.append({'symbol': s, 'close': round(res['price'], 4), 'rsi2': res['rsi2'],
                           'downDays': streak, 'downPct': run_pct,
                           'trigger': round(res['trigger'], 4), 'ma200': round(res['ma200'], 4),
                           'tier': res['tier'], 'vixBand': res['vixBand'],
                           'hitRate': c['hitRate'], 'netBps': c['netBps'], 'n': c['n'],
                           'heldOutHitRate': (res.get('heldOut') or {}).get('hitRate'),
                           'heldOutNetBps': (res.get('heldOut') or {}).get('netBps')})
        time.sleep(1.0)

    # Deepest dips first: the calibration measured deeper dips paying more (+61 vs +34 bps).
    setups.sort(key=lambda x: x['rsi2'])
    # CONFIRMED only when the scan ran after that session's 16:00 New York close; before it, the
    # last bar is a live partial bar and a "setup" is only forming. The nightly job runs at 22:00
    # UTC, so its output is always confirmed; a mid-session manual run says so honestly.
    from zoneinfo import ZoneInfo
    ny = datetime.datetime.now(ZoneInfo('America/New_York'))
    confirmed = bool(session) and (ny.date().isoformat() > session or (ny.date().isoformat() == session and ny.hour >= 16))
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sessionDate': session,
        'confirmed': confirmed,
        'vix': round(vix, 2) if vix is not None else None,
        'rule': 'Enter at the next open; sell at the open after the first close above the 5-day '
                'average (trigger); at most 10 sessions; no stop.',
        'scanned': scanned,
        'unflagged': unflagged,
        'setups': setups,
    }
    if scanned < 0.5 * len(syms):
        print(f'ERROR: only {scanned}/{len(syms)} symbols scanned; not publishing.', file=sys.stderr)
        sys.exit(1)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)
    print(f'Wrote {OUT}: {len(setups)} setups ({unflagged} more in unreliable cells) '
          f'from {scanned} liquid US names, session {session}, VIX {vix}')


if __name__ == '__main__':
    main()
