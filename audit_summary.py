"""
One-shot summary: how many predictions has the engine made, how many
succeeded, how many symbols have ever had a successful directional
prediction recorded in the ledger.

Output is plain text answering Roshan's specific question:
  "are there any symbols noted as success predictions, and how many
   predictions out of thousands went right and accurate"
"""
import json
import os
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')


def load_all_rows():
    rows = []
    for fname in sorted(os.listdir(LEDGER_DIR)):
        if not fname.endswith('.jsonl'):
            continue
        path = os.path.join(LEDGER_DIR, fname)
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


def main():
    rows = load_all_rows()
    total_rows = len(rows)
    unique_symbols = set(r.get('symbol') for r in rows if r.get('symbol'))

    # A row is "directional" if signal is BUY or SELL (NEUTRAL/NO_TRADE
    # are abstentions). A row "succeeded" on a horizon if directionMatch
    # is True. We count unique successes per symbol and globally.
    by_sym_resolved = defaultdict(lambda: {'1': 0, '3': 0, '5': 0})
    by_sym_hits = defaultdict(lambda: {'1': 0, '3': 0, '5': 0})

    total_resolved_1d = 0
    total_hits_1d = 0
    total_resolved_3d = 0
    total_hits_3d = 0
    total_resolved_5d = 0
    total_hits_5d = 0

    for r in rows:
        sig = r.get('signal')
        if sig not in ('BUY', 'SELL'):
            continue
        sym = r['symbol']
        for h in ('1', '3', '5'):
            slot = (r.get('horizons') or {}).get(h)
            if not slot or 'directionMatch' not in slot:
                continue
            by_sym_resolved[sym][h] += 1
            if slot['directionMatch']:
                by_sym_hits[sym][h] += 1
            if h == '1':
                total_resolved_1d += 1
                if slot['directionMatch']:
                    total_hits_1d += 1
            elif h == '3':
                total_resolved_3d += 1
                if slot['directionMatch']:
                    total_hits_3d += 1
            elif h == '5':
                total_resolved_5d += 1
                if slot['directionMatch']:
                    total_hits_5d += 1

    # Symbols that have AT LEAST ONE recorded directional success
    # (any horizon)
    syms_with_success = set()
    for sym in by_sym_hits:
        if by_sym_hits[sym]['1'] > 0 or by_sym_hits[sym]['3'] > 0 or by_sym_hits[sym]['5'] > 0:
            syms_with_success.add(sym)

    # Perfect track records (5+ resolved AT 1d, 100% hit rate)
    perfect_5plus = []
    strong_5plus = []  # 80%+ hit rate
    weak_5plus = []    # <40% hit rate
    for sym, resolved in by_sym_resolved.items():
        n = resolved['1']
        if n < 5:
            continue
        hits = by_sym_hits[sym]['1']
        rate = hits / n * 100
        rec = (sym, n, hits, rate)
        if rate == 100:
            perfect_5plus.append(rec)
        elif rate >= 80:
            strong_5plus.append(rec)
        elif rate < 40:
            weak_5plus.append(rec)

    perfect_5plus.sort(key=lambda x: -x[1])
    strong_5plus.sort(key=lambda x: -x[3])
    weak_5plus.sort(key=lambda x: x[3])

    print('=' * 65)
    print('ENGINE PREDICTION TRACK RECORD — full ledger to date')
    print('=' * 65)
    print(f'\nTotal ledger rows (all signal types):     {total_rows:>6}')
    print(f'Unique symbols seen by engine:             {len(unique_symbols):>6}')
    print(f'Symbols with at least one DIRECTIONAL hit: {len(syms_with_success):>6}')
    print(f'   (out of {len(unique_symbols)} symbols, {len(syms_with_success) / len(unique_symbols) * 100:.1f}% have at least one success)')

    print('\n--- HITS / RESOLVED BY HORIZON (BUY + SELL only) ---')
    print(f'1-day:  {total_hits_1d:>5} / {total_resolved_1d:>5}  ({total_hits_1d/total_resolved_1d*100:.1f}% if resolved)')
    print(f'3-day:  {total_hits_3d:>5} / {total_resolved_3d:>5}  ({total_hits_3d/total_resolved_3d*100:.1f}% if resolved)')
    if total_resolved_5d:
        print(f'5-day:  {total_hits_5d:>5} / {total_resolved_5d:>5}  ({total_hits_5d/total_resolved_5d*100:.1f}% if resolved)')

    print(f'\n--- SYMBOLS WITH PERFECT 1d TRACK RECORD (>=5 resolved, 100%) ---')
    if perfect_5plus:
        for sym, n, hits, rate in perfect_5plus:
            print(f'  {sym:<14}  {hits}/{n}  {rate:.0f}%')
    else:
        print('  (none)')

    print(f'\n--- SYMBOLS WITH STRONG 1d TRACK RECORD (>=5 resolved, 80-99%) ---')
    if strong_5plus:
        for sym, n, hits, rate in strong_5plus:
            print(f'  {sym:<14}  {hits}/{n}  {rate:.0f}%')
    else:
        print('  (none)')

    print(f'\n--- SYMBOLS THE ENGINE READS POORLY (>=5 resolved, <40%) ---')
    if weak_5plus:
        for sym, n, hits, rate in weak_5plus:
            print(f'  {sym:<14}  {hits}/{n}  {rate:.0f}%')
    else:
        print('  (none)')

    # ── Predictions-per-symbol coverage report ───────────────────────
    # How often does each symbol get analyzed? Distribution tells us
    # whether the engine is rotating broadly across the universe or
    # repeatedly hammering the same handful of names.
    by_sym_total = defaultdict(int)
    by_sym_buy_sell = defaultdict(int)
    by_sym_neutral = defaultdict(int)
    by_sym_no_trade = defaultdict(int)
    for r in rows:
        sym = r.get('symbol')
        if not sym:
            continue
        by_sym_total[sym] += 1
        sig = r.get('signal')
        if sig in ('BUY', 'SELL'):
            by_sym_buy_sell[sym] += 1
        elif sig == 'NEUTRAL':
            by_sym_neutral[sym] += 1
        elif sig == 'NO_TRADE':
            by_sym_no_trade[sym] += 1

    counts_sorted = sorted(by_sym_total.items(), key=lambda x: -x[1])
    if counts_sorted:
        most = counts_sorted[0][1]
        least = counts_sorted[-1][1]
        median = counts_sorted[len(counts_sorted) // 2][1]
        avg = sum(by_sym_total.values()) / len(by_sym_total)
        print(f'\n--- PREDICTIONS PER SYMBOL (coverage distribution) ---')
        print(f'Symbols analyzed:    {len(by_sym_total)}')
        print(f'Most predictions:    {most}  ({counts_sorted[0][0]})')
        print(f'Median predictions:  {median}')
        print(f'Mean predictions:    {avg:.1f}')
        print(f'Least predictions:   {least}  ({counts_sorted[-1][0]})')

        # Histogram buckets
        buckets = {'1': 0, '2-4': 0, '5-9': 0, '10-19': 0, '20-49': 0, '50+': 0}
        for sym, n in by_sym_total.items():
            if n == 1:
                buckets['1'] += 1
            elif n <= 4:
                buckets['2-4'] += 1
            elif n <= 9:
                buckets['5-9'] += 1
            elif n <= 19:
                buckets['10-19'] += 1
            elif n <= 49:
                buckets['20-49'] += 1
            else:
                buckets['50+'] += 1
        print('\nDistribution:')
        for label, count in buckets.items():
            pct = count / len(by_sym_total) * 100
            print(f'  {label:<8}predictions: {count:>4} symbols  ({pct:.1f}%)')

        print(f'\n--- TOP 15 MOST-ANALYZED SYMBOLS ---')
        print(f'{"Symbol":<14}{"Total":>8}{"BUY/SELL":>11}{"NEUTRAL":>10}{"NO_TRADE":>11}')
        for sym, n in counts_sorted[:15]:
            print(f'  {sym:<12}{n:>8}{by_sym_buy_sell[sym]:>11}{by_sym_neutral[sym]:>10}{by_sym_no_trade[sym]:>11}')


if __name__ == '__main__':
    main()
