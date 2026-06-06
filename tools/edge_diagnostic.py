"""
One-off diagnostic: WHERE does the engine actually have directional edge,
and IF we only kept high-conviction calls, what hit-rate + coverage results?

Reads the live ledger and answers, with real numbers (not estimates):
  1. Overall 1d hit-rate + binomial test vs 50% (is sub-50 real or noise?)
  2. Directional bias: BUY vs SELL hit-rate
  3. Crypto vs stock 1d hit-rate (does real-time data matter?)
  4. Hit-rate by confidence band, by |move| magnitude, by RSI/MACD/BB setup
  5. The conviction-slice curve: for each confidence floor, the hit-rate and
     coverage of the calls AT OR ABOVE it — i.e. does concentrating raise it,
     and is there a slice where a ~70% tier exists?
  6. Same per horizon (1/3/5/10/20) so we see which horizon is most tractable.

Pure stdlib. Run: python tools/edge_diagnostic.py
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
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def is_crypto(sym):
    return sym.upper().endswith('-USD')


def wilson(hits, n, z=1.96):
    """Wilson 95% CI for a proportion — honest small-sample interval."""
    if n == 0:
        return (0.0, 0.0)
    p = hits / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (max(0, center - half) * 100, min(1, center + half) * 100)


def binom_p_two_sided(hits, n, p0=0.5):
    """Two-sided binomial p-value vs p0 via normal approx (n is large here)."""
    if n == 0:
        return 1.0
    se = math.sqrt(p0 * (1 - p0) / n)
    z = (hits / n - p0) / se
    # two-sided normal tail
    return 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))


def resolved(rows, h):
    out = []
    for r in rows:
        if r.get('signal') not in ('BUY', 'SELL'):
            continue
        hz = (r.get('horizons') or {}).get(str(h))
        if hz and hz.get('directionMatch') is not None:
            out.append((r, hz))
    return out


def rate(pairs):
    n = len(pairs)
    hits = sum(1 for _, hz in pairs if hz['directionMatch'])
    return hits, n, (hits / n * 100 if n else 0)


def line(label, hits, n):
    if n == 0:
        print(f"  {label:<34} n=0")
        return
    pct = hits / n * 100
    lo, hi = wilson(hits, n)
    print(f"  {label:<34} {pct:5.1f}%  (n={n:>5}, 95% CI {lo:.1f}-{hi:.1f})")


def main():
    rows = load()
    print(f"=== EDGE DIAGNOSTIC — {len(rows)} ledger rows ===\n")

    # ---- 1. Overall 1d + significance ----
    p = resolved(rows, 1)
    hits, n, pct = rate(p)
    pval = binom_p_two_sided(hits, n)
    lo, hi = wilson(hits, n)
    print("1. OVERALL 1-DAY")
    print(f"   hit-rate {pct:.2f}%  (n={n}, 95% CI {lo:.1f}-{hi:.1f})")
    print(f"   vs 50%: two-sided p = {pval:.4f}  -> {'SIGNIFICANT' if pval < 0.05 else 'NOT significant (indistinguishable from coin flip)'}")
    print()

    # ---- 2. Directional bias ----
    print("2. DIRECTIONAL BIAS (1d)")
    buys = [(r, hz) for r, hz in p if r['signal'] == 'BUY']
    sells = [(r, hz) for r, hz in p if r['signal'] == 'SELL']
    line('BUY calls', *rate(buys)[:2])
    line('SELL calls', *rate(sells)[:2])
    print()

    # ---- 3. Crypto vs stock ----
    print("3. CRYPTO vs STOCK (1d)")
    cry = [(r, hz) for r, hz in p if is_crypto(r['symbol'])]
    stk = [(r, hz) for r, hz in p if not is_crypto(r['symbol'])]
    line('crypto', *rate(cry)[:2])
    line('stock', *rate(stk)[:2])
    print()

    # ---- 4a. By confidence band ----
    print("4a. BY CONFIDENCE BAND (1d)")
    bands = defaultdict(list)
    for r, hz in p:
        c = r.get('confidence', 0)
        lo_b = (c // 5) * 5
        bands[lo_b].append((r, hz))
    for lo_b in sorted(bands):
        h, nn, _ = rate(bands[lo_b])
        line(f'conf {lo_b}-{lo_b+5}', h, nn)
    print()

    # ---- 4b. By RSI zone ----
    print("4b. BY RSI ZONE AT ENTRY (1d)")
    rsi_b = {'oversold <30': [], 'neutral 30-70': [], 'overbought >70': []}
    for r, hz in p:
        rsi = (r.get('indicators') or {}).get('rsi')
        if rsi is None:
            continue
        k = 'oversold <30' if rsi < 30 else 'overbought >70' if rsi > 70 else 'neutral 30-70'
        rsi_b[k].append((r, hz))
    for k, v in rsi_b.items():
        line(k, *rate(v)[:2])
    print()

    # ---- 5. Conviction-slice curve: hit-rate of calls AT/ABOVE each conf floor ----
    print("5. CONVICTION SLICE (1d): keep only calls with confidence >= floor")
    print("   floor   hit-rate   coverage(calls kept)")
    total = len(p)
    for floor in range(50, 90, 5):
        kept = [(r, hz) for r, hz in p if r.get('confidence', 0) >= floor]
        h, nn, pc = rate(kept)
        cov = nn / total * 100 if total else 0
        lo_c, hi_c = wilson(h, nn)
        flag = ''
        if nn >= 30 and lo_c >= 60:
            flag = '  <-- 60%+ lower-bound'
        if nn >= 30 and lo_c >= 70:
            flag = '  <-- 70%+ lower-bound!'
        print(f"   >={floor}   {pc:5.1f}%     {cov:5.1f}% ({nn})   CI {lo_c:.0f}-{hi_c:.0f}{flag}")
    print()

    # ---- 5b. Conviction by |predicted/actual move| magnitude (proxy for setup strength) ----
    print("5b. BY ACTUAL |move| AT 1d (does the engine read BIG-move setups better?)")
    mag_b = {'<1%': [], '1-3%': [], '3-6%': [], '>6%': []}
    for r, hz in p:
        m = abs(hz.get('pctMove') or 0)
        k = '<1%' if m < 1 else '1-3%' if m < 3 else '3-6%' if m < 6 else '>6%'
        mag_b[k].append((r, hz))
    for k, v in mag_b.items():
        line(f'|move| {k}', *rate(v)[:2])
    print("   (note: this is conditioned on the OUTCOME move, so it's descriptive,")
    print("    not a tradeable filter — it tells us where direction is readable.)")
    print()

    # ---- 6. Per horizon ----
    print("6. BY HORIZON (all directional calls)")
    for h in (1, 3, 5, 10, 20):
        ph = resolved(rows, h)
        hh, nn, _ = rate(ph)
        line(f'{h}-day', hh, nn)
    print()

    # ---- 6b. Best horizon WITH a conviction floor ----
    print("6b. PER HORIZON, conf >= 65 only (concentration x horizon)")
    for h in (1, 3, 5, 10, 20):
        ph = [(r, hz) for r, hz in resolved(rows, h) if r.get('confidence', 0) >= 65]
        hh, nn, _ = rate(ph)
        line(f'{h}-day conf>=65', hh, nn)


if __name__ == '__main__':
    main()
