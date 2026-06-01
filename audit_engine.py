"""
Engine accuracy audit. Reads the live ledger and reports:

  1. Overall hit rate by horizon (1d, 3d, 5d, 10d, 20d)
  2. Hit rate by SIGNAL (BUY / SELL / NEUTRAL — directionally)
  3. Hit rate by CONFIDENCE BUCKET (the meaningful question:
     do 60%+ predictions actually hit ~60%? do 70%+ hit ~70%?)
  4. Per-symbol track record (only symbols with >=5 resolved 1d
     horizons) — feeds the new track-record-bonus weighting.
  5. Old-vs-new threshold simulation: under the new 60/40 + 55%
     commit floor, how many predictions would have been emitted,
     and what would their hit rate have been?
  6. LSTM "is it learning" check — looks at hit-rate trend across
     the year. Improving = the weekly retrain is working. Flat or
     declining = retrain might be overfitting / regime drift.

Usage:
    python audit_engine.py
    python audit_engine.py --year 2026
    python audit_engine.py --json out.json    # machine-readable

Notes:
    - "directionally hit" = horizons[h].directionMatch == true
    - NEUTRAL signals are not directional, so they're excluded from
      hit-rate stats. They DO show up in the "signal distribution"
      counts so you can see how often the engine abstains.
    - Confidence buckets: 38-49, 50-54, 55-59, 60-64, 65-69, 70+
    - Calibration check is the key metric: a well-calibrated engine
      has ~50% hits at 50% confidence, ~60% at 60%, etc. Deviation
      tells us whether the engine is over- or under-confident.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')

HORIZONS = ['1', '3', '5', '10', '20']
CONF_BUCKETS = [(38, 49), (50, 54), (55, 59), (60, 64), (65, 69), (70, 100)]


def bucket_label(low, high):
    return f'{low}-{high}'


def find_bucket(conf):
    if conf is None:
        return None
    for low, high in CONF_BUCKETS:
        if low <= conf <= high:
            return bucket_label(low, high)
    return None


def load_ledger(year):
    path = os.path.join(LEDGER_DIR, f'{year}.jsonl')
    if not os.path.exists(path):
        sys.exit(f'No ledger for year {year} at {path}')
    rows = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def directional_rows(rows, horizon):
    """Yield (row, horizon_data) only for rows that have a resolved
    directional outcome (horizon present, directionMatch is bool, and
    signal is BUY or SELL — NEUTRAL is non-directional)."""
    for r in rows:
        sig = r.get('signal')
        if sig not in ('BUY', 'SELL'):
            continue
        h = (r.get('horizons') or {}).get(horizon)
        if not h or 'directionMatch' not in h:
            continue
        yield r, h


def hit_rate(rows, horizon):
    n, hits = 0, 0
    for r, h in directional_rows(rows, horizon):
        n += 1
        if h.get('directionMatch'):
            hits += 1
    return n, hits, (hits / n * 100) if n else None


def report_overall(rows):
    print('\n=== 1. OVERALL HIT RATE BY HORIZON ===')
    print(f'{"Horizon":<10}{"Resolved":>12}{"Hits":>8}{"Rate":>10}')
    for h in HORIZONS:
        n, hits, rate = hit_rate(rows, h)
        rate_str = f'{rate:.1f}%' if rate is not None else 'n/a'
        print(f'{h+"d":<10}{n:>12}{hits:>8}{rate_str:>10}')


def report_by_signal(rows):
    print('\n=== 2. HIT RATE BY SIGNAL (1d horizon) ===')
    by = defaultdict(lambda: [0, 0])  # signal → [n, hits]
    counts = defaultdict(int)
    for r in rows:
        counts[r.get('signal') or 'UNKNOWN'] += 1
        if r.get('signal') in ('BUY', 'SELL'):
            h = (r.get('horizons') or {}).get('1')
            if h and 'directionMatch' in h:
                by[r['signal']][0] += 1
                if h['directionMatch']:
                    by[r['signal']][1] += 1

    print('Signal distribution (all rows):')
    for sig in sorted(counts):
        print(f'  {sig:<10}{counts[sig]:>8}')
    print()
    print(f'{"Signal":<10}{"Resolved":>12}{"Hits":>8}{"Rate":>10}')
    for sig in ('BUY', 'SELL'):
        n, hits = by[sig]
        rate = (hits / n * 100) if n else None
        rate_str = f'{rate:.1f}%' if rate is not None else 'n/a'
        print(f'{sig:<10}{n:>12}{hits:>8}{rate_str:>10}')


def report_by_confidence(rows):
    print('\n=== 3. HIT RATE BY CONFIDENCE BUCKET (1d horizon) ===')
    print('A well-calibrated engine has rate ~ bucket midpoint.')
    print(f'{"Bucket":<12}{"Resolved":>12}{"Hits":>8}{"Rate":>10}{"Calibrated?":>16}')
    by_bucket = defaultdict(lambda: [0, 0])
    for r, h in directional_rows(rows, '1'):
        b = find_bucket(r.get('confidence'))
        if not b:
            continue
        by_bucket[b][0] += 1
        if h['directionMatch']:
            by_bucket[b][1] += 1
    for low, high in CONF_BUCKETS:
        b = bucket_label(low, high)
        n, hits = by_bucket[b]
        rate = (hits / n * 100) if n else None
        midpoint = (low + high) / 2
        if rate is None:
            print(f'{b:<12}{n:>12}{0:>8}{"n/a":>10}{"":>16}')
        else:
            delta = rate - midpoint
            verdict = 'overconf' if delta < -3 else 'underconf' if delta > 3 else 'calibrated'
            print(f'{b:<12}{n:>12}{hits:>8}{rate:>9.1f}%{verdict:>16}')


def report_per_symbol(rows, min_resolved=5):
    print(f'\n=== 4. PER-SYMBOL TRACK RECORD (>= {min_resolved} resolved 1d) ===')
    by_sym = defaultdict(lambda: [0, 0])
    for r, h in directional_rows(rows, '1'):
        sym = r.get('symbol')
        by_sym[sym][0] += 1
        if h['directionMatch']:
            by_sym[sym][1] += 1
    qualifying = [(sym, n, hits, hits / n * 100)
                  for sym, (n, hits) in by_sym.items() if n >= min_resolved]
    qualifying.sort(key=lambda x: x[3], reverse=True)
    print(f'Top 15 by hit rate:')
    print(f'{"Symbol":<12}{"Resolved":>10}{"Hits":>8}{"Rate":>10}')
    for sym, n, hits, rate in qualifying[:15]:
        print(f'{sym:<12}{n:>10}{hits:>8}{rate:>9.1f}%')
    if len(qualifying) > 15:
        print(f'\nBottom 10 by hit rate (these get the track-record penalty):')
        for sym, n, hits, rate in qualifying[-10:]:
            print(f'{sym:<12}{n:>10}{hits:>8}{rate:>9.1f}%')


def report_threshold_simulation(rows):
    print('\n=== 5. THRESHOLD SIMULATION: OLD (>=38 conf) vs NEW (>=55 conf) ===')
    old_n, old_hits = 0, 0
    new_n, new_hits = 0, 0
    for r, h in directional_rows(rows, '1'):
        old_n += 1
        if h['directionMatch']:
            old_hits += 1
        # New threshold: only commits at confidence >= 55
        if (r.get('confidence') or 0) >= 55:
            new_n += 1
            if h['directionMatch']:
                new_hits += 1
    old_rate = (old_hits / old_n * 100) if old_n else 0
    new_rate = (new_hits / new_n * 100) if new_n else 0
    delta_count = new_n - old_n
    delta_rate = new_rate - old_rate
    print(f'OLD: {old_n} resolved, {old_hits} hits = {old_rate:.1f}%')
    print(f'NEW: {new_n} resolved, {new_hits} hits = {new_rate:.1f}%')
    print(f'Delta: {delta_count:+d} predictions, {delta_rate:+.1f}pp hit rate')
    if delta_rate >= 1.5:
        print('Verdict: NEW thresholds appear to raise hit rate meaningfully. Keep.')
    elif delta_rate >= -1.5:
        print('Verdict: NEW thresholds preserve hit rate while filtering low-conviction noise. Keep.')
    else:
        print('Verdict: NEW thresholds REDUCED hit rate. Consider walking back.')


def report_learning_trend(rows):
    """Bucket predictions by month and show 1d hit rate over time.
    If the engine is "learning" via weekly retrains, we'd expect the
    hit rate to be stable or improving across months — not random."""
    print('\n=== 6. IS THE LSTM LEARNING? (1d hit rate by month) ===')
    print('Stable or improving = retrain working. Declining = regime drift.')
    by_month = defaultdict(lambda: [0, 0])
    for r, h in directional_rows(rows, '1'):
        date_str = r.get('date') or r.get('predictedAt', '')[:10]
        if not date_str:
            continue
        try:
            month = date_str[:7]  # YYYY-MM
        except (KeyError, IndexError):
            continue
        by_month[month][0] += 1
        if h['directionMatch']:
            by_month[month][1] += 1
    print(f'{"Month":<10}{"Resolved":>10}{"Hits":>8}{"Rate":>10}')
    for month in sorted(by_month):
        n, hits = by_month[month]
        rate = (hits / n * 100) if n else None
        print(f'{month:<10}{n:>10}{hits:>8}{rate:>9.1f}%')


def to_json(rows):
    """Same data, machine-readable for downstream tooling."""
    out = {'horizons': {}, 'by_signal': {}, 'by_confidence': {}, 'per_symbol': {}, 'by_month': {}}
    for h in HORIZONS:
        n, hits, rate = hit_rate(rows, h)
        out['horizons'][h] = {'resolved': n, 'hits': hits, 'rate': rate}
    by_sig = defaultdict(lambda: [0, 0])
    for r in rows:
        if r.get('signal') in ('BUY', 'SELL'):
            h = (r.get('horizons') or {}).get('1')
            if h and 'directionMatch' in h:
                by_sig[r['signal']][0] += 1
                if h['directionMatch']:
                    by_sig[r['signal']][1] += 1
    for sig, (n, hits) in by_sig.items():
        out['by_signal'][sig] = {'resolved': n, 'hits': hits, 'rate': hits / n * 100 if n else None}
    by_bucket = defaultdict(lambda: [0, 0])
    for r, h in directional_rows(rows, '1'):
        b = find_bucket(r.get('confidence'))
        if not b:
            continue
        by_bucket[b][0] += 1
        if h['directionMatch']:
            by_bucket[b][1] += 1
    for b, (n, hits) in by_bucket.items():
        out['by_confidence'][b] = {'resolved': n, 'hits': hits, 'rate': hits / n * 100 if n else None}
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--year', type=int, default=datetime.now(timezone.utc).year)
    parser.add_argument('--json', type=str, help='Write JSON output to this path')
    parser.add_argument('--min-resolved', type=int, default=5,
                        help='Minimum 1d resolved horizons for per-symbol report')
    args = parser.parse_args()

    rows = load_ledger(args.year)
    print(f'\nLoaded {len(rows)} ledger rows for {args.year}.')

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(to_json(rows), f, indent=2)
        print(f'JSON written to {args.json}')
        return

    report_overall(rows)
    report_by_signal(rows)
    report_by_confidence(rows)
    report_per_symbol(rows, args.min_resolved)
    report_threshold_simulation(rows)
    report_learning_trend(rows)


if __name__ == '__main__':
    main()
