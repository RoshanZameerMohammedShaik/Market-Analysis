"""Assert price_round.py and js/price-round.js agree, and never collapse a price.

These two are a cross-language pair with no test until now, and they sit on the
single hottest path in the project: every stored entry price, every price target,
every band edge, every displayed number.

The bug being locked out cost real accuracy data. record_predictions.py wrote
round(entry_price, 4), so SHIB-USD near $0.0000053 was stored as literally 0.0.
resolve_horizon rejects entry <= 0, so those rows were permanently ungradable and
absent from every reported accuracy figure while the app kept issuing BUY calls on
them. 51 of 1,053 live symbols are sub-penny, 39 of 170 crypto among them.

Properties asserted, not just fixture equality: a fixture test would have passed
happily on round(x, 4) for every symbol above a dollar.

Run: python tools/price_round_check.py
"""
import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from price_round import decimals_for, round_price  # noqa: E402

PASS, FAIL = [], []

# Real prices from the live universe, spanning nine orders of magnitude, plus the
# boundaries of each branch and the values that broke in production.
CASES = [
    309.9, 79062.8984, 254.31, 1.0, 1.005, 0.9999, 0.42, 0.261, 0.01, 0.009999,
    0.00031, 0.0001045, 0.0000128, 5.32e-06, 3.01e-06, 1.28e-09, 0.0,
    -4.5, -0.00031, 12345.6789, 0.1, 0.099999, 99.995,
]


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


def js_round(values):
    """Run the browser implementation over the same values."""
    src = """
import { roundPrice, decimalsFor } from '../js/price-round.js';
const vals = JSON.parse(process.argv[2]);   // [node, script, json]
process.stdout.write(JSON.stringify(
    vals.map(v => ({ r: roundPrice(v), d: decimalsFor(v) }))));
"""
    fd, tmp = tempfile.mkstemp(suffix='.mjs', dir=os.path.join(REPO, 'tools'))
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(src)
        p = subprocess.run(['node', tmp, json.dumps(values)],
                           capture_output=True, text=True, cwd=os.path.join(REPO, 'tools'))
        if p.returncode != 0 or not p.stdout.strip():
            print('ERROR: node harness failed.', file=sys.stderr)
            print(p.stderr[:1200], file=sys.stderr)
            sys.exit(1)
        return json.loads(p.stdout)
    finally:
        os.remove(tmp)


print('=== Python and JS produce identical output ===')
js = js_round(CASES)
worst = None
for v, j in zip(CASES, js):
    p = round_price(v)
    same = (p is None and j['r'] is None) or (
        p is not None and j['r'] is not None and abs(p - j['r']) <= abs(p) * 1e-12)
    if not same:
        worst = f'{v!r}: py {p!r} vs js {j["r"]!r}'
    check(f'roundPrice({v!r}) matches', same, worst or '')
    check(f'decimalsFor({v!r}) matches', decimals_for(v) == j['d'],
          f'py {decimals_for(v)} vs js {j["d"]}')

print('\n=== a non-zero price NEVER rounds to zero ===')
# This is the property that failed in production. Fixed decimal places break it
# for any price below the last retained digit; significant figures cannot.
for v in CASES:
    if v == 0:
        continue
    r = round_price(v)
    check(f'{v!r} stays non-zero', r is not None and r != 0, f'became {r!r}')

print('\n=== relative error stays small at every magnitude ===')
for v in CASES:
    if v == 0:
        continue
    r = round_price(v)
    rel = abs(r - v) / abs(v)
    # 2dp on a $1.00 asset is a 0.5% quantisation at worst; below a cent the
    # sig-fig branch is far tighter. 1% is a generous ceiling that still fails
    # loudly on a collapse.
    check(f'{v!r} within 1% of true ({rel*100:.4f}%)', rel < 0.01, f'{rel*100:.2f}%')

print('\n=== a band cannot collapse to zero width ===')
# The consequence of a collapse: predictedLow == predictedHigh makes "price
# stayed inside the range" arithmetically impossible, so the row can ONLY ever
# score as a hit, which silently inflates every range statistic in the ledger.
for price in (309.9, 0.42, 0.00031, 5.32e-06, 1.28e-09):
    for pct in (0.005, 0.02, 0.10):
        lo, hi = round_price(price * (1 - pct)), round_price(price * (1 + pct))
        check(f'band +/-{pct*100:g}% on {price!r} has width', hi > lo,
              f'lo {lo!r} hi {hi!r}')

print('\n=== monotone: rounding preserves ordering ===')
ordered = sorted(v for v in CASES if v > 0)
rounded = [round_price(v) for v in ordered]
check('ordering preserved across all magnitudes',
      all(a <= b for a, b in zip(rounded, rounded[1:])), str(rounded))

print('\n=== junk input returns None rather than crashing a cron ===')
for bad in (None, 'abc', float('nan'), float('inf'), float('-inf'), [], {}):
    check(f'round_price({bad!r}) is None', round_price(bad) is None, repr(round_price(bad)))

print(f"\n{'PRICE ROUND CHECK PASS' if not FAIL else 'PRICE ROUND CHECK FAIL'}: "
      f"{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
