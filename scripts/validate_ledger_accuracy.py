"""
One-shot validation script: replicate the JS scanner's per-row
hits/misses/total/days aggregation against the live ledger and
report integrity stats.

Run from repo root: python scripts/validate_ledger_accuracy.py
"""
import json
import os
import sys
import datetime
from collections import defaultdict

LEDGER = os.path.join(os.path.dirname(__file__), '..', 'model', 'ledger', '2026.jsonl')
LEDGER = os.path.abspath(LEDGER)


def main():
    if not os.path.exists(LEDGER):
        print(f'NO LEDGER FILE at {LEDGER}')
        sys.exit(1)

    today = datetime.date.today()
    stats = defaultdict(lambda: {
        'hits': 0,           # rows with at least one resolved hitting horizon
        'misses': 0,         # rows fully resolved with no hits
        'total': 0,          # all committed BUY/SELL rows for this symbol
        'pending': 0,        # rows with no resolved horizons yet
        'first_date': None,
        'neutral_skipped': 0,
    })
    schema_violations = []
    weird_dm = []

    with open(LEDGER, encoding='utf-8') as f:
        for ln_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception as e:
                schema_violations.append(f'L{ln_no}: bad JSON ({e})')
                continue
            sym = r.get('symbol')
            if not sym:
                schema_violations.append(f'L{ln_no}: missing symbol')
                continue
            sig = r.get('signal')
            horizons = r.get('horizons') or {}
            s = stats[sym]
            if sig not in ('BUY', 'SELL'):
                s['neutral_skipped'] += 1
                continue
            s['total'] += 1
            d = r.get('date')
            if d and (s['first_date'] is None or d < s['first_date']):
                s['first_date'] = d
            any_resolved = False
            any_hit = False
            for k, h in horizons.items():
                if h is None:
                    continue
                if not isinstance(h, dict):
                    schema_violations.append(f'L{ln_no} {sym} h{k}: not-dict')
                    continue
                dm = h.get('directionMatch')
                if dm is None:
                    continue
                if not isinstance(dm, bool):
                    weird_dm.append(f'{sym} h{k}: directionMatch={dm!r}')
                    continue
                any_resolved = True
                if dm:
                    any_hit = True
            if not any_resolved:
                s['pending'] += 1
            elif any_hit:
                s['hits'] += 1
            else:
                s['misses'] += 1

    total_rows = sum(v['total'] + v['neutral_skipped'] for v in stats.values())
    total_committed = sum(v['total'] for v in stats.values())
    total_hits = sum(v['hits'] for v in stats.values())
    total_misses = sum(v['misses'] for v in stats.values())
    total_pending = sum(v['pending'] for v in stats.values())
    neutral_skipped = sum(v['neutral_skipped'] for v in stats.values())

    print('=' * 70)
    print('LEDGER INTEGRITY')
    print('=' * 70)
    print(f'Total rows                       : {total_rows}')
    print(f'Unique symbols                   : {len(stats)}')
    print(f'Schema violations                : {len(schema_violations)}')
    print(f'directionMatch not-bool          : {len(weird_dm)}')
    if schema_violations[:3]:
        print(f'  Sample violations: {schema_violations[:3]}')
    if weird_dm[:3]:
        print(f'  Sample non-bool: {weird_dm[:3]}')

    print()
    print('=' * 70)
    print('PER-ROW ACCURACY (the format the Full Ledger column shows)')
    print('=' * 70)
    print(f'NEUTRAL/NO_TRADE rows (excluded) : {neutral_skipped}')
    print(f'Committed BUY/SELL rows (total)  : {total_committed}')
    print(f'  Hits  (any horizon hit)        : {total_hits}')
    print(f'  Misses (all resolved, none hit): {total_misses}')
    print(f'  Pending (no horizon resolved)  : {total_pending}')
    graded = total_hits + total_misses
    if graded:
        print(f'Engine-wide hit rate (graded)    : {100*total_hits/graded:.1f}%')

    print()
    print('=' * 70)
    print('TOP 15 SYMBOLS BY TOTAL PREDICTIONS')
    print('=' * 70)
    print(f'{"Symbol":<14} {"Cell":<22} {"Pending":<8} {"Days":<6} {"Rate":<8}')
    print('-' * 70)
    ranked = sorted(stats.items(), key=lambda kv: -kv[1]['total'])[:15]
    for sym, v in ranked:
        graded = v['hits'] + v['misses']
        rate = 100 * v['hits'] / graded if graded else 0
        days = (today - datetime.date.fromisoformat(v['first_date'])).days if v['first_date'] else 0
        days = max(1, days)
        cell = f"{v['hits']}/{v['misses']}/{v['total']}/{days}d"
        print(f'  {sym:<12} {cell:<22} {v["pending"]:<8} {days:<6} {rate:>5.1f}%')

    print()
    print('=' * 70)
    print('SANITY CHECKS')
    print('=' * 70)
    nonsense = sum(1 for v in stats.values() if v['hits'] + v['misses'] > v['total'])
    print(f'Symbols where hits+misses > total: {nonsense}  (must be 0)')
    bad_pending = sum(1 for v in stats.values()
                      if v['pending'] != v['total'] - v['hits'] - v['misses'])
    print(f'Pending != total-hits-misses     : {bad_pending}  (must be 0)')


if __name__ == '__main__':
    main()
