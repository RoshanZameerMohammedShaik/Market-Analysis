"""
Daily-conditional retrain gate.

The LSTM trains on RESOLVED predictions (label = did the 1d horizon hit).
A new candle adds ~nothing; a new RESOLUTION is a labeled training sample.
So we only retrain when enough new resolutions have accumulated since the
last retrain — otherwise we'd burn ~90 min of cron to nudge weights by
sub-noise.

Gate (exit 0 = retrain, exit 1 = skip):
  - Retrain if >= MIN_NEW_RESOLUTIONS resolved horizons appeared since the
    last recorded retrain marker, OR
  - Retrain if >= MAX_DAYS_BETWEEN days have passed regardless (so the model
    never goes fully stale on a quiet stretch).

State marker: model/.last_retrain.json  { "at": ISO, "resolved_total": N }.
We compare the current resolved-horizon count to the count at last retrain.

MIN_NEW_RESOLUTIONS = 64 — one LSTM training batch. Below a batch, the
gradient signal is statistically meaningless.

Run from repo root:
    python tools/should_retrain.py && echo "retrain" || echo "skip"
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MIN_NEW_RESOLUTIONS = 64
MAX_DAYS_BETWEEN = 7

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER_DIR = os.path.join(REPO, 'model', 'ledger')
MARKER = os.path.join(REPO, 'model', '.last_retrain.json')


def count_resolved():
    """Total resolved horizons across all ledger year-files."""
    total = 0
    if not os.path.isdir(LEDGER_DIR):
        return 0
    for fn in os.listdir(LEDGER_DIR):
        if not fn.endswith('.jsonl'):
            continue
        with open(os.path.join(LEDGER_DIR, fn), encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                for h in (r.get('horizons') or {}).values():
                    if isinstance(h, dict) and h.get('directionMatch') is not None:
                        total += 1
    return total


def load_marker():
    try:
        with open(MARKER, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def main():
    current = count_resolved()
    marker = load_marker()

    if marker is None:
        print(f'[should_retrain] no marker — first run, retrain. resolved={current}')
        sys.exit(0)

    prev = marker.get('resolved_total', 0)
    new_resolutions = current - prev
    last_at = marker.get('at')
    days_since = None
    if last_at:
        try:
            last_dt = datetime.datetime.fromisoformat(last_at.replace('Z', '+00:00'))
            days_since = (datetime.datetime.now(datetime.timezone.utc) - last_dt).days
        except Exception:
            days_since = None

    print(f'[should_retrain] resolved now={current} prev={prev} new={new_resolutions} '
          f'days_since={days_since}')

    if new_resolutions >= MIN_NEW_RESOLUTIONS:
        print(f'[should_retrain] {new_resolutions} >= {MIN_NEW_RESOLUTIONS} new resolutions — RETRAIN')
        sys.exit(0)
    if days_since is not None and days_since >= MAX_DAYS_BETWEEN:
        print(f'[should_retrain] {days_since} >= {MAX_DAYS_BETWEEN} days since last — RETRAIN (staleness floor)')
        sys.exit(0)

    print(f'[should_retrain] not enough new ground truth — SKIP')
    sys.exit(1)


if __name__ == '__main__':
    main()
