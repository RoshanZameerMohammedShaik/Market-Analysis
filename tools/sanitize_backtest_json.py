"""One-shot: sanitize model/backtest_results.json so it's valid JSON.

The backtester historically wrote bare NaN/Infinity tokens (json.dump's
default allow_nan=True). Those are invalid JSON and the browser's JSON.parse
throws on them — which was silently killing ALL of calibration.js
(loadCalibration bailed before loading live calibration). backtest.py now
sanitizes on write; this fixes the already-committed file in place without a
multi-hour backtest re-run.

Run: python tools/sanitize_backtest_json.py
"""
import json
import math
import os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 'model', 'backtest_results.json')


def safe(o):
    if isinstance(o, dict):
        return {k: safe(v) for k, v in o.items()}
    if isinstance(o, list):
        return [safe(v) for v in o]
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    return o


def _reject(token):
    raise ValueError(f'non-finite token survived: {token}')


def main():
    with open(P, encoding='utf-8') as f:
        data = json.load(f)            # Python json accepts NaN/Infinity by default
    clean = safe(data)
    with open(P, 'w', encoding='utf-8') as f:
        json.dump(clean, f, indent=2, allow_nan=False)   # strict write
    # Verify: strict re-parse that rejects any residual non-finite token.
    with open(P, encoding='utf-8') as f:
        json.load(f, parse_constant=_reject)
    print('OK: sanitized and strict-parse clean ->', P)


if __name__ == '__main__':
    main()
