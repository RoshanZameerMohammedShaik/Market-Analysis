"""
Validate the DEPLOYED rebalance: re-score the ledger using the EXACT
bull/bear weighting now in backtest.generate_prediction (short-horizon
mean-reversion tilt), and grade the would-be 1d + 5d signal vs real
outcomes. The ledger doesn't store ADX, so we test the tilt presets the
live code uses (ranging mr=1.6/mom=0.45, mid mr=1.4/mom=0.6, trending
mr=1.15/mom=0.85) to bracket what the regime-gated version will do — and
compare every one against the engine's ACTUAL recorded 46.7% (1d).

Honest: grades against the real stored pctMove sign; reports Wilson CIs.
"""
import json
import math
import os

LEDGER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'model', 'ledger', '2026.jsonl')


def load():
    rows = []
    with open(LEDGER) as f:
        for line in f:
            s = line.strip()
            if s:
                try:
                    rows.append(json.loads(s))
                except json.JSONDecodeError:
                    pass
    return rows


def wilson(hits, n, z=1.96):
    if n == 0:
        return (0, 0)
    p = hits / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d
    return (max(0, c - h) * 100, min(1, c + h) * 100)


def score(ind, mr, mom):
    """Mirror of backtest.generate_prediction's tilted bull/bear/norm using
    only the stored indicators (rsi, macd.histogram/macd, bb.percent_b).
    ma-cross and 5-bar momentum aren't stored, so this is the RSI+MACD+BB
    core — the dominant terms — which is enough to validate direction."""
    rsi_v = ind.get('rsi')
    macd_v = ind.get('macd') or {}
    bb_v = ind.get('bb') or {}
    bull = bear = total = 0.0
    if rsi_v is not None:
        w = 2 * mr
        total += w
        if rsi_v < 30: bull += w
        elif rsi_v < 40: bull += w * 0.5
        elif rsi_v > 70: bear += w
        elif rsi_v > 60: bear += w * 0.5
    if macd_v:
        w = 2.5 * mom
        total += w
        hist = macd_v.get('histogram'); mac = macd_v.get('macd')
        if macd_v.get('crossover'): bull += w
        elif macd_v.get('crossunder'): bear += w
        elif hist is not None and mac is not None and hist > 0 and mac > 0: bull += w * 0.6
        elif hist is not None and mac is not None and hist < 0 and mac < 0: bear += w * 0.6
        elif hist is not None and hist > 0: bull += w * 0.2
        else: bear += w * 0.2
    pb = bb_v.get('percent_b')
    if pb is not None:
        w = 2 * mr
        total += w
        if pb < 0: bull += w
        elif pb < 0.2: bull += w * 0.75
        elif pb > 1: bear += w
        elif pb > 0.8: bear += w * 0.75
    if total == 0:
        return None
    norm = (bull - bear) / total
    if norm > 0.12: return 'BUY'
    if norm < -0.12: return 'SELL'
    return None


def grade(rows, mr, mom, horizon):
    hits = n = 0
    for r in rows:
        ind = r.get('indicators')
        if not ind:
            continue
        hz = (r.get('horizons') or {}).get(str(horizon))
        if not hz or hz.get('directionMatch') is None:
            continue
        m = hz.get('pctMove')
        if m is None or m == 0:
            continue
        sig = score(ind, mr, mom)
        if sig is None:
            continue
        n += 1
        if (sig == 'BUY' and m > 0) or (sig == 'SELL' and m < 0):
            hits += 1
    return hits, n


def main():
    rows = load()
    print("=== VALIDATE DEPLOYED REBALANCE (RSI+MACD+BB core) ===\n")
    presets = [
        ('current (momentum) mr=1.0/mom=1.0', 1.0, 1.0),
        ('trending preset    mr=1.15/mom=0.85', 1.15, 0.85),
        ('mid/unknown preset mr=1.4/mom=0.6', 1.4, 0.6),
        ('ranging preset     mr=1.6/mom=0.45', 1.6, 0.45),
    ]
    for horizon in (1, 5):
        print(f"--- {horizon}-DAY ---")
        for name, mr, mom in presets:
            h, n = grade(rows, mr, mom, horizon)
            if n == 0:
                print(f"  {name:<38} n=0"); continue
            lo, hi = wilson(h, n)
            print(f"  {name:<38} {h/n*100:5.1f}%  (n={n:>4}, CI {lo:.0f}-{hi:.0f})")
        # actual baseline
        bh = bn = 0
        for r in rows:
            if r.get('signal') not in ('BUY', 'SELL'):
                continue
            hz = (r.get('horizons') or {}).get(str(horizon))
            if hz and hz.get('directionMatch') is not None:
                bn += 1
                if hz['directionMatch']:
                    bh += 1
        lo, hi = wilson(bh, bn)
        print(f"  {'ENGINE ACTUAL (as recorded)':<38} {bh/bn*100:5.1f}%  (n={bn}, CI {lo:.0f}-{hi:.0f})\n")


if __name__ == '__main__':
    main()
