"""
Offline re-scoring backtest for the 1-day fix.

The inversion hunt showed the engine is a failed momentum-chaser at 1d:
mean-reversion bets hit 61-66%, momentum bets 30-35%. This tool REPLAYS the
existing ledger rows, recomputes the signal under a tunable mean-reversion
vs momentum weighting (from the stored rsi/macd/bb), and grades the would-be
signal against the REAL stored outcomes — at 1d AND 5d — so we can prove a
rebalance lifts 1d without wrecking 5d BEFORE touching the live engine.

This is honest because:
  - We grade against actual recorded directionMatch-equivalent (sign of the
    real pctMove), not a re-simulation.
  - We report Wilson CIs, not point estimates.
  - We sweep the weight so we see the whole curve, not a cherry-picked point.

Caveat surfaced in output: this is one ~3-week regime; a weight that wins
here may not generalize. That's why the live fix will be REGIME-GATED, not
a hard tilt — this backtest only establishes the DIRECTION and rough size.

Pure stdlib. Run: python tools/rescore_backtest.py
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


# ── candidate scorers ──────────────────────────────────────────────────
# Each returns a signed lean in [-1, +1] (+ = bullish) from stored indicators.

def momentum_lean(ind):
    """What the current engine leans on: MACD momentum + RSI-as-trend."""
    macd = ind.get('macd') or {}
    hist = macd.get('histogram')
    rsi = ind.get('rsi')
    s = 0.0
    if hist is not None:
        s += max(-1, min(1, hist / 1.0)) * 0.6   # momentum: ride the MACD
    if rsi is not None:
        s += ((rsi - 50) / 50) * 0.4              # momentum: strong = bullish
    return max(-1, min(1, s))


def meanrev_lean(ind):
    """Mean-reversion: oversold = bullish, overbought = bearish."""
    rsi = ind.get('rsi')
    bb = ind.get('bb') or {}
    pb = bb.get('percent_b')
    s = 0.0
    if rsi is not None:
        s += ((50 - rsi) / 50) * 0.6              # oversold -> bullish
    if pb is not None:
        s += (0.5 - pb) * 2 * 0.4                 # below mid-band -> bullish
    return max(-1, min(1, s))


def blended_signal(ind, w_meanrev):
    """Blend the two leans; w_meanrev in [0,1] is the mean-reversion weight
    (1 - w_meanrev goes to momentum). Returns 'BUY'/'SELL'/None (dead zone)."""
    lean = w_meanrev * meanrev_lean(ind) + (1 - w_meanrev) * momentum_lean(ind)
    if lean > 0.08:
        return 'BUY'
    if lean < -0.08:
        return 'SELL'
    return None


def outcome_dir(hz):
    """Sign of the real move: +1 up, -1 down, 0 flat."""
    m = hz.get('pctMove')
    if m is None:
        return 0
    return 1 if m > 0 else -1 if m < 0 else 0


def grade(rows, w_meanrev, horizon):
    hits = n = 0
    for r in rows:
        ind = r.get('indicators')
        if not ind:
            continue
        hz = (r.get('horizons') or {}).get(str(horizon))
        if not hz or hz.get('directionMatch') is None:
            continue
        sig = blended_signal(ind, w_meanrev)
        if sig is None:
            continue
        d = outcome_dir(hz)
        if d == 0:
            continue
        n += 1
        if (sig == 'BUY' and d > 0) or (sig == 'SELL' and d < 0):
            hits += 1
    return hits, n


def main():
    rows = load()
    print("=== RE-SCORING BACKTEST: mean-reversion weight sweep ===")
    print("w=0.0 -> pure momentum (~ current engine lean); w=1.0 -> pure mean-reversion\n")
    for horizon in (1, 5):
        print(f"--- {horizon}-DAY ---")
        print("  w_meanrev   hit-rate   (n)     95% CI")
        best = None
        for i in range(0, 11):
            w = i / 10
            h, n = grade(rows, w, horizon)
            if n == 0:
                continue
            pct = h / n * 100
            lo, hi = wilson(h, n)
            mark = ''
            if best is None or pct > best[1]:
                best = (w, pct)
            print(f"   {w:0.1f}        {pct:5.1f}%   ({n:>4})   {lo:.0f}-{hi:.0f}")
        if best:
            print(f"  best @ w={best[0]:0.1f}: {best[1]:.1f}%\n")

    # Baseline reference: the engine's ACTUAL recorded 1d/5d hit-rate.
    print("--- BASELINE (engine's ACTUAL recorded calls) ---")
    for horizon in (1, 5):
        h = n = 0
        for r in rows:
            if r.get('signal') not in ('BUY', 'SELL'):
                continue
            hz = (r.get('horizons') or {}).get(str(horizon))
            if hz and hz.get('directionMatch') is not None:
                n += 1
                if hz['directionMatch']:
                    h += 1
        lo, hi = wilson(h, n)
        print(f"  {horizon}-day actual: {h/n*100:.1f}%  (n={n}, CI {lo:.0f}-{hi:.0f})")
    print("\nNOTE: one ~3-week regime. This sets the DIRECTION + size of the fix;")
    print("the live change will be REGIME-GATED, not a hard tilt.")


if __name__ == '__main__':
    main()
