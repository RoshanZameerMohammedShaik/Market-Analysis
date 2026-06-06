"""
Localize WHY the 1-day signal is inverted (46.7%, p=0.0006).

Tests, in order of cheapness-to-fix:
  A. CONTRARIAN: if we flipped every 1d BUY<->SELL, what's the hit-rate?
     (>53% => the engine has real INVERTED edge we can exploit by flipping.)
  B. Per-region: is one region (e.g. a data-quality region) dragging it?
  C. Over time (by week): inverted throughout, or did it break at a date?
  D. STRATEGY DIAGNOSIS: split by what the engine was betting:
     - mean-reversion bets (BUY when RSI oversold / %b low; SELL when overbought)
       vs momentum bets (BUY when strong/overbought; SELL when weak)
     If mean-reversion bets are the losers, the engine is a contrarian in a
     trending tape — a strategy mismatch, not a code bug.
  E. MACD alignment: does signal agree or fight MACD, and which wins?
Pure stdlib.
"""
import json
import math
import os
from collections import defaultdict

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


def show(label, hits, n):
    if n == 0:
        print(f"  {label:<40} n=0"); return
    lo, hi = wilson(hits, n)
    print(f"  {label:<40} {hits/n*100:5.1f}%  (n={n:>5}, CI {lo:.0f}-{hi:.0f})")


def main():
    rows = load()
    # resolved 1d directional rows
    R = []
    for r in rows:
        if r.get('signal') not in ('BUY', 'SELL'):
            continue
        hz = (r.get('horizons') or {}).get('1')
        if hz and hz.get('directionMatch') is not None:
            R.append((r, hz))
    print(f"=== INVERSION HUNT — {len(R)} resolved 1d directional calls ===\n")

    # A. Contrarian flip
    hits = sum(1 for _, hz in R if hz['directionMatch'])
    flip = len(R) - hits  # flipping turns every miss into a hit and vice versa
    print("A. CONTRARIAN FLIP")
    show("as-is", hits, len(R))
    show("FLIPPED (BUY<->SELL)", flip, len(R))
    print("   -> if FLIPPED clears ~53%+, the engine has exploitable inverted edge.\n")

    # B. Per region
    print("B. PER REGION (1d)")
    byreg = defaultdict(lambda: [0, 0])
    for r, hz in R:
        reg = r.get('region', '?')
        byreg[reg][1] += 1
        if hz['directionMatch']:
            byreg[reg][0] += 1
    for reg in sorted(byreg, key=lambda k: -byreg[k][1]):
        h, n = byreg[reg][0], byreg[reg][1]
        show(reg, h, n)
    print()

    # C. By week
    print("C. BY WEEK (does it drift / when did it break?)")
    byweek = defaultdict(lambda: [0, 0])
    for r, hz in R:
        wk = r.get('date', '')[:7] + '-w' + str((int(r.get('date', '2026-01-01')[8:10]) - 1) // 7 + 1)
        byweek[wk][1] += 1
        if hz['directionMatch']:
            byweek[wk][0] += 1
    for wk in sorted(byweek):
        h, n = byweek[wk]
        show(wk, h, n)
    print()

    # D. Strategy: mean-reversion vs momentum bets
    print("D. STRATEGY DIAGNOSIS (what was the engine betting?)")
    buckets = defaultdict(lambda: [0, 0])
    for r, hz in R:
        ind = r.get('indicators') or {}
        rsi = ind.get('rsi')
        sig = r['signal']
        if rsi is None:
            continue
        # Classify the bet:
        if sig == 'BUY' and rsi < 40:
            kind = 'BUY oversold/weak (mean-reversion)'
        elif sig == 'BUY' and rsi > 60:
            kind = 'BUY strong/overbought (momentum)'
        elif sig == 'SELL' and rsi > 60:
            kind = 'SELL overbought (mean-reversion)'
        elif sig == 'SELL' and rsi < 40:
            kind = 'SELL weak/oversold (momentum-down)'
        else:
            kind = 'BUY/SELL mid-RSI'
        buckets[kind][1] += 1
        if hz['directionMatch']:
            buckets[kind][0] += 1
    for k in sorted(buckets, key=lambda k: -buckets[k][1]):
        h, n = buckets[k]
        show(k, h, n)
    print("   -> if the 'mean-reversion' bets are the big losers, the engine is")
    print("      a contrarian in a trending tape (strategy mismatch, fixable by")
    print("      flipping the mean-reversion logic to momentum).\n")

    # E. MACD histogram alignment
    print("E. MACD-HISTOGRAM ALIGNMENT (1d)")
    al = defaultdict(lambda: [0, 0])
    for r, hz in R:
        macd = (r.get('indicators') or {}).get('macd') or {}
        h_hist = macd.get('histogram')
        if h_hist is None:
            continue
        sig = r['signal']
        # does the call agree with MACD momentum?
        agrees = (sig == 'BUY' and h_hist > 0) or (sig == 'SELL' and h_hist < 0)
        k = 'call AGREES with MACD momentum' if agrees else 'call FIGHTS MACD momentum'
        al[k][1] += 1
        if hz['directionMatch']:
            al[k][0] += 1
    for k in sorted(al):
        h, n = al[k]
        show(k, h, n)
    print("   -> if 'fights MACD' is the loser, the engine over-weights mean-")
    print("      reversion signals against momentum.\n")

    # F. By |move| AND signal: are BIG up-days following SELLs / big down following BUYs?
    print("F. WAS THE MISS DRIVEN BY BIG MOVES THE WRONG WAY?")
    for sig in ('BUY', 'SELL'):
        moves = [hz.get('pctMove', 0) for r, hz in R if r['signal'] == sig]
        if not moves:
            continue
        avg = sum(moves) / len(moves)
        print(f"  {sig}: avg actual pctMove = {avg:+.2f}%  (BUY wants +, SELL wants -)")


if __name__ == '__main__':
    main()
