"""
Cross-check that js/ai-model.js and shared_features.py compute identical
11-feature vectors on synthetic OHLCV. Fails CI if they drift.

The approach: shell out to node, run a tiny harness that imports the REAL
computeFeatures from js/ai-model.js (passing a config that declares 11
features) and prints JSON. Compare to the Python output cell-by-cell.

Calling the real computeFeatures — instead of the old inlined duplicate —
means this test actually exercises the shipping code path, including the
new ADX/MFI/ATR helpers. If the JS and Python implementations of those
drift, this fails.
"""
import json
import math
import os
import random
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared_features import compute_features_at, SEQUENCE_LENGTH, LOOKBACK, FEATURES

NODE_HARNESS = r"""
import { computeFeatures } from '../js/ai-model.js';

const raw = process.argv[2];
const candles = JSON.parse(raw);

// Pass a config that declares 11 features + the standard sequence length,
// so computeFeatures emits the full ADX/MFI/ATR-extended vector through
// the REAL shipping code path (no inlined duplicate).
const cfg = { sequence_length: 20, features: 11 };
const features = computeFeatures(candles, cfg);
console.log(JSON.stringify(features));
"""


def synthesize_candles(n=80, seed=42):
    random.seed(seed)
    candles = []
    price = 100.0
    for _ in range(n):
        change = random.uniform(-0.02, 0.02)
        open_ = price
        close = price * (1 + change)
        high = max(open_, close) * (1 + random.uniform(0, 0.01))
        low = min(open_, close) * (1 - random.uniform(0, 0.01))
        volume = random.randint(1_000_000, 10_000_000)
        candles.append({'open': open_, 'high': high, 'low': low, 'close': close, 'volume': volume})
        price = close
    return candles


def python_features(candles):
    close = np.array([c['close'] for c in candles], dtype=float)
    high = np.array([c['high'] for c in candles], dtype=float)
    low = np.array([c['low'] for c in candles], dtype=float)
    volume = np.array([c['volume'] for c in candles], dtype=float)

    seq_len = SEQUENCE_LENGTH
    lookback = LOOKBACK
    if len(close) < seq_len + lookback:
        return None

    out = []
    start = len(close) - seq_len
    for idx in range(seq_len):
        j = start + idx
        out.append(compute_features_at(close, high, low, volume, j))
    return out


def js_features(candles):
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    harness_path = os.path.join(here, '_sync_harness.mjs')
    with open(harness_path, 'w') as f:
        f.write(NODE_HARNESS)
    try:
        result = subprocess.run(
            ['node', '--experimental-vm-modules', harness_path, json.dumps(candles)],
            cwd=repo, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print('node failed:', result.stderr, file=sys.stderr)
            return None
        return json.loads(result.stdout.strip())
    finally:
        try: os.remove(harness_path)
        except OSError: pass


def main():
    candles = synthesize_candles()
    py = python_features(candles)
    js = js_features(candles)

    if py is None or js is None:
        print('FAIL: one side returned None')
        sys.exit(1)
    if len(py) != len(js):
        print(f'FAIL: length mismatch py={len(py)} js={len(js)}')
        sys.exit(1)

    max_diff = 0.0
    worst = None
    for i, (p_row, j_row) in enumerate(zip(py, js)):
        if len(p_row) != len(j_row):
            print(f'FAIL: row {i} width mismatch py={len(p_row)} js={len(j_row)}')
            sys.exit(1)
        for k in range(len(p_row)):
            diff = abs(p_row[k] - j_row[k])
            if diff > max_diff:
                max_diff = diff
                worst = (i, k, p_row[k], j_row[k])

    if max_diff > 1e-6:
        print(f'FAIL: feature drift detected, max diff = {max_diff}')
        if worst:
            print(f'  worst: timestep {worst[0]} feature {worst[1]}: py={worst[2]} js={worst[3]}')
        sys.exit(1)

    print(f'OK: js and python feature extractors agree (max diff = {max_diff:.2e})')


if __name__ == '__main__':
    main()
