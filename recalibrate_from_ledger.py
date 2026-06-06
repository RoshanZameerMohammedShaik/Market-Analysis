"""
Aggregate resolved ledger rows into a per-bucket calibration table.

Output: model/live_calibration.json

Schema:
    {
      "generatedAt": "2026-05-21T03:00:00Z",
      "byHorizon": {
        "1": {
          "BUY":  { "50-60": {"n": 234, "predicted": 54.2, "actual": 51.7}, ... },
          "SELL": { ... }
        },
        "5": { ... }
      },
      "byRegion": { "NYSE": {...}, "NSE": {...} },
      "totalRowsConsidered": 12450,
      "totalResolvedHorizons": 38000
    }

The browser's calibration.js will prefer this live calibration over
the backtest calibration when sample size in a bucket is >= 30.
"""
import datetime
import json
import os
from collections import defaultdict

from ledger_universe import HORIZONS_DAYS, REGIONS
from shared_features import ENGINE_VERSION

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')
OUTPUT_PATH = os.path.join(SCRIPT_DIR, 'model', 'live_calibration.json')


def load_all_rows():
    rows = []
    if not os.path.exists(LEDGER_DIR):
        return rows
    for fn in sorted(os.listdir(LEDGER_DIR)):
        if not fn.endswith('.jsonl'):
            continue
        path = os.path.join(LEDGER_DIR, fn)
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows


def bucket_for(confidence: int) -> str:
    """5-point buckets: 40-45, 45-50, ... 90-95, 95-100.

    Finer resolution than the old 10pp bands. The engine produces most
    of its output in the 45-60 range, and on the live ledger those 5pp
    buckets each have 600-1000 resolved samples — plenty above the n>=30
    confidence floor. Sparse high-confidence 5pp buckets (e.g. 65-70 with
    n<30) are handled by the JS reader's roll-up: it tries the 5pp bucket
    first, then falls back to the 10pp parent, then to backtest. Keep
    this lookup in sync with js/calibration.js bucket math (5-step). """
    lo = max(40, min(95, (confidence // 5) * 5))
    return f'{lo}-{lo + 5}'


def aggregate(rows):
    by_horizon = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: {'n': 0, 'pred_sum': 0.0, 'hits': 0})))
    by_region = defaultdict(lambda: defaultdict(lambda: {'n': 0, 'pred_sum': 0.0, 'hits': 0}))

    total_resolved = 0
    # Provenance accounting: how many resolved horizons we KEEP (current
    # engine) vs SKIP (older engine logic). Surfaced so a logic change that
    # discards the historical record is loud, never silent.
    skipped_old_engine = 0
    skipped_resolved = 0
    for r in rows:
        signal = r.get('signal')
        confidence = r.get('confidence', 0)
        region = r.get('region', 'NYSE')
        if signal not in ('BUY', 'SELL', 'NEUTRAL'):
            continue
        # Version gate: only rows produced by the engine that's running now
        # count toward the calibration the user sees. Rows from a prior
        # engine (or unversioned rows pre-dating this scheme) are EXCLUDED so
        # a scoring change — like the 1-day mean-reversion rebalance — rebuilds
        # its track record from scratch instead of inheriting the old, now-
        # wrong hit-rate. New 1-day buckets refill within days (1d resolves
        # daily); longer horizons take proportionally longer, which is honest:
        # we don't claim an edge we haven't re-observed under the new logic.
        row_version = r.get('engineVersion', 'unversioned')
        if row_version != ENGINE_VERSION:
            skipped_old_engine += 1
            for _h, _o in (r.get('horizons') or {}).items():
                if _o is not None:
                    skipped_resolved += 1
            continue
        bkt = bucket_for(confidence)

        for h_str, outcome in (r.get('horizons') or {}).items():
            if outcome is None:
                continue
            total_resolved += 1
            slot = by_horizon[h_str][signal][bkt]
            slot['n'] += 1
            slot['pred_sum'] += confidence
            if outcome.get('directionMatch'):
                slot['hits'] += 1

            # by_region is NOT keyed by signal, and the JS reader
            # (calibration.js liveRegionLookup) uses it to calibrate
            # BUY/SELL confidence. NEUTRAL's directionMatch means "stayed
            # flat" — a different success criterion — so blending it in
            # contaminated the directional region calibration. Restrict
            # by_region to directional calls only.
            if signal in ('BUY', 'SELL'):
                rslot = by_region[region][bkt]
                rslot['n'] += 1
                rslot['pred_sum'] += confidence
                if outcome.get('directionMatch'):
                    rslot['hits'] += 1

    return by_horizon, by_region, total_resolved, skipped_old_engine, skipped_resolved


def to_rate(slot):
    n = slot['n']
    if n == 0:
        return None
    return {
        'n': n,
        'predicted': round(slot['pred_sum'] / n, 1),
        'actual': round((slot['hits'] / n) * 100, 1),
    }


def main():
    rows = load_all_rows()
    by_horizon, by_region, total_resolved, skipped_old_engine, skipped_resolved = aggregate(rows)

    out = {
        'generatedAt': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        # The engine logic these numbers describe. The trust panel reads this
        # to honestly label the track record as belonging to the current
        # engine (and to show "rebuilding under updated engine" when the
        # current-engine sample is still thin after a logic change).
        'engineVersion': ENGINE_VERSION,
        # How much history was set aside because it came from an older engine.
        # When this is large and totalResolvedHorizons is small, the track
        # record is mid-rebuild — the UI says so rather than implying the new
        # engine has a long proven history.
        'skippedOldEngineRows': skipped_old_engine,
        'skippedOldEngineResolved': skipped_resolved,
        'byHorizon': {},
        'byRegion': {},
        'totalRowsConsidered': len(rows),
        'totalResolvedHorizons': total_resolved,
    }
    for h_str, by_signal in by_horizon.items():
        out['byHorizon'][h_str] = {}
        for signal, buckets in by_signal.items():
            out['byHorizon'][h_str][signal] = {bkt: to_rate(slot) for bkt, slot in buckets.items()}

    for region, buckets in by_region.items():
        out['byRegion'][region] = {bkt: to_rate(slot) for bkt, slot in buckets.items()}

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {OUTPUT_PATH}")
    print(f"  Engine version: {ENGINE_VERSION}")
    print(f"  Considered: {len(rows)} rows, resolved (current engine): {total_resolved} horizons")
    if skipped_old_engine:
        print(f"  Skipped {skipped_old_engine} rows ({skipped_resolved} resolved horizons) from older/unversioned engines.")
        if total_resolved < skipped_resolved:
            print(f"  NOTE: track record is mid-rebuild under the new engine "
                  f"({total_resolved} vs {skipped_resolved} retired). 1d buckets refill fastest.")


if __name__ == '__main__':
    main()
