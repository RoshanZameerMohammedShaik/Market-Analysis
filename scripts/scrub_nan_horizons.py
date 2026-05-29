"""
One-shot scrubber: resets any horizon row whose actualClose is NaN back to
null so the next record_outcomes.py run re-resolves it correctly.

Background: yfinance occasionally returns daily bars with NaN close
(observed for .NS / NSE symbols where intraday H/L populate before the
post-market settlement completes). The old record_outcomes.py wrote those
through, and a NaN coerced to directionMatch=False silently inverted
calibration for affected regions (NSE 50-60% bucket dropped to 11.2%
actual vs 52.6% predicted).

The fix in record_outcomes.py prevents future poisoning. This script
unpoisons existing rows.

Usage:
    python scripts/scrub_nan_horizons.py
"""
import json
import math
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, '..', 'model', 'ledger')


def is_nan(x) -> bool:
    return isinstance(x, float) and math.isnan(x)


def horizon_is_poisoned(outcome) -> bool:
    if not isinstance(outcome, dict):
        return False
    return is_nan(outcome.get('actualClose')) or is_nan(outcome.get('pctMove'))


def scrub_file(path: str) -> tuple[int, int]:
    """Returns (rows_touched, horizons_reset)."""
    rows_touched = 0
    horizons_reset = 0
    out_lines = []

    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                out_lines.append('')
                continue
            row = json.loads(line)
            row_changed = False
            horizons = row.get('horizons') or {}
            for h, outcome in list(horizons.items()):
                if horizon_is_poisoned(outcome):
                    horizons[h] = None
                    horizons_reset += 1
                    row_changed = True
            if row_changed:
                rows_touched += 1
            out_lines.append(json.dumps(row, allow_nan=False))

    with open(path, 'w') as f:
        f.write('\n'.join(out_lines))
        if out_lines and out_lines[-1] != '':
            f.write('\n')

    return rows_touched, horizons_reset


def main():
    if not os.path.isdir(LEDGER_DIR):
        print(f'Ledger dir not found: {LEDGER_DIR}', file=sys.stderr)
        sys.exit(1)

    total_files = 0
    total_rows = 0
    total_horizons = 0
    for fn in sorted(os.listdir(LEDGER_DIR)):
        if not fn.endswith('.jsonl'):
            continue
        path = os.path.join(LEDGER_DIR, fn)
        rows, horizons = scrub_file(path)
        print(f'  {fn}: {rows} rows touched, {horizons} horizons reset')
        total_files += 1
        total_rows += rows
        total_horizons += horizons

    print(f'\nDone. {total_files} files, {total_rows} rows touched, {total_horizons} horizons reset.')


if __name__ == '__main__':
    main()
