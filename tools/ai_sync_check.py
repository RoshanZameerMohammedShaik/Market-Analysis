"""Assert ai_infer.py and js/ai-model.js + js/xgb-model.js produce the SAME number.

The cron now runs the LSTM to fill the ledger's `ai` breakdown, and the browser
runs it to show the user a score. Those are two implementations of one number, and
two implementations always drift. When they do, the ledger records one AI opinion
while the user is shown another, and the accuracy attributed to the AI source stops
describing the thing on screen. That is the exact failure the band parity check was
built for, applied to the model.

Deterministic synthetic candles, so no network and no dependence on today's market.
Real weights though: the point is to exercise the DEPLOYED model, including the fact
that it declares input_size 8 while shared_features computes 11.

Run: python tools/ai_sync_check.py
"""
import json
import math
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import ai_infer  # noqa: E402

# Probabilities are compared far tighter than the band check's 1-cent tolerance:
# there is no rounding step between the two languages, so anything above float
# noise is a real divergence.
TOL_PROB = 1e-9
N_BARS = 90

PASS, FAIL = [], []


def _emit_annotation(msg):
    """Surface a failure reason where it can be read WITHOUT repo admin rights.

    GitHub's job-log endpoint returns 403 to non-admins, so the actual error was invisible
    from outside when this check first went red in CI. `::error::` lines become check
    annotations, which the public API does expose.
    """
    if os.environ.get('GITHUB_ACTIONS'):
        one_line = str(msg).replace('\n', ' | ')[:900]
        print(f'::error title=ai_sync_check::{one_line}')


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


def _versions():
    """python / node / numpy, for the failure message.

    This check passed six consecutive times locally and failed on the runner, and Node,
    Python and numpy all differed at once, so there was no way to tell which mattered.
    Printing them makes the next failure self-describing instead of a guess.
    """
    import platform
    try:
        node = subprocess.run(['node', '--version'], capture_output=True,
                              text=True).stdout.strip() or 'unknown'
    except OSError:
        node = 'unavailable'
    try:
        import numpy
        npv = numpy.__version__
    except ImportError:
        npv = 'unavailable'
    return platform.python_version(), node, npv


_PY, _NODE, _NUMPY = _versions()
print('=== environment ===')
print(f'  python {_PY}  node {_NODE}  numpy {_NUMPY}')


def synth(seed, n=N_BARS, base=100.0, drift=0.0, spread=0.02):
    """Deterministic OHLCV. An LCG rather than `random` so the fixture is identical
    on every machine and in CI. Mirrors tools/band_sync_check.py."""
    s = seed
    def nxt():
        nonlocal s
        s = (1103515245 * s + 12345) % (2 ** 31)
        return s / (2 ** 31)
    out, px = [], base
    for _ in range(n):
        px *= math.exp(drift + (nxt() - 0.5) * spread)
        rng = px * spread * (0.4 + nxt())
        hi, lo = px + rng / 2, max(px - rng / 2, px * 0.5)
        out.append({'open': round(px, 6), 'close': round(px, 6),
                    'high': round(hi, 6), 'low': round(lo, 6),
                    'volume': round(1e6 * (0.5 + nxt()), 2)})
    return out


# Spread across regimes and price scales on purpose: a fixture set that only
# exercises one shape would not catch a tier-selection or feature-scaling bug.
CASES = {
    'CALM':      synth(1, spread=0.008),
    'NORMAL':    synth(2, spread=0.020),
    'VOLATILE':  synth(3, spread=0.045),
    'UPTREND':   synth(4, spread=0.018, drift=0.004),
    'DOWNTREND': synth(5, spread=0.018, drift=-0.004),
    'SUBDOLLAR': synth(6, base=0.42, spread=0.05),
}

fd, tmp = tempfile.mkstemp(suffix='.json', dir=os.path.join(REPO, 'tools'))
os.close(fd)
try:
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(CASES, f)
    proc = subprocess.run(['node', os.path.join('tools', 'ai_sync_check.mjs'), tmp],
                          capture_output=True, text=True, cwd=REPO)
finally:
    os.remove(tmp)

if proc.returncode != 0 or not proc.stdout.strip():
    print('ERROR: node harness failed.', file=sys.stderr)
    print(proc.stderr[:1800], file=sys.stderr)
    # A GitHub ::error:: line becomes a check ANNOTATION, which is readable through the
    # public API without admin rights. Job LOGS are not: reading them returns 403 "Must
    # have admin rights to Repository", which is why the first attempt to diagnose this
    # failure was blind. Anything worth debugging from outside belongs in an annotation.
    _emit_annotation(f'node harness rc={proc.returncode} on python {_PY} / node {_NODE} / '
                     f'numpy {_NUMPY}: '
                     + (proc.stderr or '').strip().replace('\n', ' ')[-400:])
    sys.exit(1)

try:
    js = json.loads(proc.stdout)
except json.JSONDecodeError as exc:
    # The harness exited 0 but did not hand back JSON. Almost always something else
    # wrote to stdout ahead of the payload -- a Node deprecation notice, an
    # experimental-feature warning -- which is exactly the kind of thing that differs
    # between Node versions and therefore between here and the runner.
    print(f'ERROR: node stdout was not JSON: {exc}', file=sys.stderr)
    print(proc.stdout[:600], file=sys.stderr)
    _emit_annotation(f'node stdout was not JSON on node {_NODE}: {exc}; '
                     f'first 200 chars: {proc.stdout[:200]!r}')
    sys.exit(1)

# Assert the RACE is gone, not just that today's run happened to win it.
#
# loadModel() used to start the GBT fetch without awaiting it, so isGbtLoaded() was
# decided by which of two files arrived first. That failed roughly 1 run in 10 -- and
# only ever as six identical "GBT presence matches" mismatches, which read like the two
# languages disagreeing about the model rather than the JS side never having loaded it.
# Naming the real condition turns a confusing flake into one obvious failure.
print('=== the GBT is resident once loadModel() resolves ===')
check('loadModel() awaits the GBT load (no fetch race)',
      bool((js.get('_meta') or {}).get('gbtLoadedAfterLoadModel')),
      'isGbtLoaded() was false right after loadModel() resolved -- the GBT fetch is '
      'not being awaited, so every case reports gbt:null at random')

print('=== the deployed model reports its own shape ===')
cfg = (ai_infer._load_json(ai_infer.MAIN_WEIGHTS) or {}).get('config') or {}
print(f"  input_size={cfg.get('input_size')} hidden={cfg.get('hidden_size')} "
      f"layers={cfg.get('num_layers')} seq={cfg.get('sequence_length')}")
gbt = ai_infer._load_json(ai_infer.GBT_TREES) or {}
print(f"  gbt n_features={gbt.get('n_features')} n_trees={gbt.get('n_trees')} "
      f"calibrators={len(gbt.get('calibrators') or [])}")
check('LSTM weights load', bool(cfg))
check('GBT trees load', bool(gbt.get('trees')))

print('\n=== Python and JS agree on every case ===')
print(f'  {"case":<12}{"py lstm":>10}{"js lstm":>10}{"py gbt":>10}{"js gbt":>10}{"diff":>12}')
for name in CASES:
    py = ai_infer.ai_prediction(CASES[name])
    j = js.get(name)
    if j is None:
        check(f'{name}: JS returned a result', False, 'missing')
        continue
    check(f'{name}: availability agrees', py['available'] == j['available'],
          f"py {py['available']} vs js {j['available']}")
    if not py['available']:
        continue
    pl, jl = py['lstm']['probability'], j['lstm']['probability']
    pg = py['gbt']['probability'] if py['gbt'] else None
    jg = j['gbt']['probability'] if j.get('gbt') else None
    # Both sides round to 3dp before returning, so compare on that grid.
    dl = abs(pl - jl)
    dg = abs(pg - jg) if (pg is not None and jg is not None) else 0.0
    print(f'  {name:<12}{pl:>10.3f}{jl:>10.3f}'
          f'{(pg if pg is not None else float("nan")):>10.3f}'
          f'{(jg if jg is not None else float("nan")):>10.3f}{max(dl, dg):>12.2e}')
    check(f'{name}: LSTM probability matches', dl <= TOL_PROB, f'{pl} vs {jl}')
    check(f'{name}: GBT presence matches', (pg is None) == (jg is None), f'{pg} vs {jg}')
    check(f'{name}: GBT probability matches', dg <= TOL_PROB, f'{pg} vs {jg}')
    check(f'{name}: blended score matches', py['score'] == j['score'],
          f"{py['score']} vs {j['score']}")
    check(f'{name}: signal label matches', py['signal'] == j['signal'],
          f"{py['signal']} vs {j['signal']}")

print('\n=== the GBT is recorded but excluded from the blend ===')
# The deployed GBT has no discrimination. Measured on 600 REAL market states
# (20 symbols x 30 recent sessions): 19 distinct outputs, minimum 0.529, bullish
# 100.0% of the time, 60% of its mass on the single value 0.646. The LSTM over the
# same states gave 594 distinct outputs and was bullish 46.0%.
#
# Averaging the two 50/50 let a model that never has an opinion outvote one that
# does: DY came out LSTM 0.376 (bearish) + GBT 0.646 = 0.511, i.e. neutral.
#
# These assertions stop that silently returning, and stop the two languages
# disagreeing about whether it is blended, which would break the ledger's `ai`
# score against the browser's without failing any numeric comparison above.
with open(os.path.join(REPO, 'js', 'ai-model.js'), encoding='utf-8') as _f:
    _js_src = _f.read()
_js_flag = 'const GBT_IN_BLEND = true' in _js_src
check('GBT_IN_BLEND agrees between Python and JS', ai_infer.GBT_IN_BLEND == _js_flag,
      f'py {ai_infer.GBT_IN_BLEND} vs js {_js_flag}')

for _name in ('NORMAL', 'DOWNTREND'):
    _r = ai_infer.ai_prediction(CASES[_name])
    if not _r['available']:
        continue
    if not ai_infer.GBT_IN_BLEND:
        check(f'{_name}: blend equals the LSTM alone',
              abs(_r['probability'] - round(_r['lstm']['probability'], 3)) < 1e-9,
              f"blend {_r['probability']} vs lstm {_r['lstm']['probability']}")
        check(f'{_name}: reason text does not claim an ensemble',
              'ensemble' not in _r['reason'], _r['reason'])
    # Excluded from the blend is NOT the same as discarded: the number must survive
    # in the ledger so the GBT can be re-evaluated after a retrain.
    check(f'{_name}: the GBT score is still reported',
          _r['gbt'] is not None and 0.0 <= _r['gbt']['probability'] <= 1.0, str(_r['gbt']))

print('\n=== invariants that must hold regardless of parity ===')
p = ai_infer.ai_prediction(CASES['NORMAL'])
check('probability is inside [0,1]', 0.0 <= p['probability'] <= 1.0, str(p['probability']))
check('score is probability x 100', p['score'] == int(round(p['probability'] * 100)))
check('signal thresholds are 0.4 / 0.6',
      (p['signal'] == 'bullish') == (p['probability'] > 0.6)
      and (p['signal'] == 'bearish') == (p['probability'] < 0.4))
# Too few bars must degrade honestly rather than return a fabricated neutral 50
# that the ledger would then record as a real AI opinion.
short = ai_infer.ai_prediction(CASES['NORMAL'][:25])
check('too-few-bars returns available=False', short['available'] is False, str(short))
check('an unavailable result is not presented as a real score',
      short['available'] is False and 'reason' in short)

# The feature vector fed to the model must match what the model declares, or the
# 11-feature extractor would silently misalign against 8 input weights.
from shared_features import compute_features_at  # noqa: E402
full = compute_features_at([c['close'] for c in CASES['NORMAL']],
                           [c['high'] for c in CASES['NORMAL']],
                           [c['low'] for c in CASES['NORMAL']],
                           [c['volume'] for c in CASES['NORMAL']],
                           len(CASES['NORMAL']) - 1)
check('extractor computes 11 features', len(full) == 11, str(len(full)))
check('model consumes only what it declares',
      int(cfg.get('input_size')) <= len(full),
      f"input_size {cfg.get('input_size')} > available {len(full)}")

print(f"\n{'AI SYNC PASS' if not FAIL else 'AI SYNC FAIL'}: "
      f'{len(PASS)} passed, {len(FAIL)} failed')
if FAIL:
    _emit_annotation(f'{len(FAIL)}/{len(PASS) + len(FAIL)} assertions failed on '
                     f'python {_PY} / node {_NODE} / numpy {_NUMPY}: '
                     + '; '.join(FAIL[:6]))
sys.exit(1 if FAIL else 0)
