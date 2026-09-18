"""Publish a compact ledger history the browser can actually load.

THE BUG THIS FIXES
------------------
Three separate places fetched `model/ledger/<year>.jsonl`:

    js/ledger-reader.js   loadLedger()
    js/ui/scanner.js      loadLedgerHistory()
    js/ui/watchlist.js    loadLedger()

That file stopped existing when the ledger was split into monthly shards to get under GitHub's
100 MB blob limit. All three caught the 404 and cached an empty array, so SEVEN features rendered
nothing and none of them complained:

    readSymbolConfidenceTrend   the per-symbol confidence trend
    readSymbolSignalMarkers     chart signal markers
    readEngineEquityCurve       the engine equity curve
    readAccuracyBySetup         accuracy by RSI zone / MACD / Bollinger position
    readLedgerHistory           the per-symbol ledger history panel
    scanner                     its accuracy aggregation
    watchlist                   its per-symbol signal column

Three copies of one dead fetch is also WHY it stayed broken: fixing loadLedger left the other two
untouched. This publishes one slice, and all three read it through ledger-reader.

WHY NOT JUST SERVE THE SHARDS
-----------------------------
They are 29-40 MB each. recent.json exists because a fetch that size takes ~143s on a 5 Mbps phone,
and they exceed Cloudflare's 25 MiB per-file limit so they are deliberately absent from the deploy
bundle. Serving one would trade a silent failure for a two-minute stall.

WHAT MAKES IT SMALL
-------------------
Only the fields those seven consumers actually read, with short keys. Measured against the real
ledger: a full row averages 1,524 bytes, this shape averages 165 -- eleven times smaller, because
it drops breakdown, forecastBand, priceTargets, and every indicator except the three that
readAccuracyBySetup buckets on (rsi, macd.histogram, bb.percent_b).

    21 days   16,721 rows   2.71 MB raw   0.37 MB gzipped
    30 days   24,305 rows   4.12 MB raw   0.58 MB gzipped   <- default
    60 days   45,023 rows   8.24 MB raw   1.18 MB gzipped

30 days is the window where a per-symbol confidence trend has ~30 points and the setup buckets have
24k rows to divide, at a wire cost of 580 KB that is only paid when one of those panels opens.

Run: python tools/write_history_slice.py [--days 30]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import ledger_store  # noqa: E402

OUT_PATH = os.path.join(ledger_store.LEDGER_DIR, 'history.json')

# Horizons the readers grade against. Anything else on the row is dropped.
HORIZONS = ('1', '3', '5', '10', '20')


def compact(row):
    """One ledger row reduced to what the browser reads.

    Short keys on purpose: at 24,000 rows the difference between 'directionMatch' and 'dm' is a
    megabyte. ledger-reader.js expands them back to the long names, so no consumer sees this shape.
    """
    out = {
        's': row.get('symbol'),
        'd': row.get('date'),
        'g': row.get('region'),
        'sg': row.get('signal'),
        'c': row.get('confidence'),
        'e': row.get('entry'),
        'v': row.get('engineVersion'),
    }

    ind = row.get('indicators') or {}
    keep = {}
    rsi = ind.get('rsi')
    if isinstance(rsi, (int, float)):
        keep['r'] = round(float(rsi), 1)
    macd = ind.get('macd') or {}
    hist = macd.get('histogram') if isinstance(macd, dict) else None
    if isinstance(hist, (int, float)):
        keep['m'] = round(float(hist), 3)
    bb = ind.get('bb') or {}
    pb = bb.get('percent_b') if isinstance(bb, dict) else None
    if isinstance(pb, (int, float)):
        keep['b'] = round(float(pb), 3)
    if keep:
        out['i'] = keep

    hz = {}
    for k in HORIZONS:
        h = (row.get('horizons') or {}).get(k)
        if not isinstance(h, dict):
            continue
        dm = h.get('directionMatch')
        # Unresolved horizons carry no information for any consumer, so they are omitted entirely
        # rather than stored as nulls that every reader then has to filter.
        if dm is None:
            continue
        e = {'dm': 1 if dm else 0}
        if isinstance(h.get('pctMove'), (int, float)):
            e['p'] = round(float(h['pctMove']), 3)
        if isinstance(h.get('capturedPct'), (int, float)):
            e['cp'] = round(float(h['capturedPct']), 1)
        hz[k] = e
    if hz:
        out['h'] = hz

    return {k: v for k, v in out.items() if v is not None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=30,
                    help='calendar days of history to publish (default 30)')
    args = ap.parse_args()

    since = (datetime.date.today() - datetime.timedelta(days=args.days)).isoformat()
    rows = []
    for r in ledger_store.iter_rows(since=since):
        c = compact(r)
        # A row with no symbol or no date cannot be joined to anything downstream.
        if c.get('s') and c.get('d'):
            rows.append(c)
    rows.sort(key=lambda r: (r['d'], r['s']))

    payload = {
        'schema': 1,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc)
                               .strftime('%Y-%m-%dT%H:%M:%SZ'),
        'since': since,
        'days': args.days,
        'count': len(rows),
        # Spelled out so a reader of the file knows the key mapping without finding the JS.
        'keys': {
            's': 'symbol', 'd': 'date', 'g': 'region', 'sg': 'signal', 'c': 'confidence',
            'e': 'entry', 'v': 'engineVersion',
            'i': 'indicators {r: rsi, m: macd.histogram, b: bb.percent_b}',
            'h': 'horizons {dm: directionMatch 0|1, p: pctMove, cp: capturedPct}',
        },
        'rows': rows,
    }

    if not rows:
        # Overwriting a good slice with an empty one would take seven features down until the next
        # cron. Leaving yesterday's in place is strictly better: they degrade to slightly stale
        # rather than blank.
        print('no rows in window; refusing to overwrite the existing slice', file=sys.stderr)
        return 1

    tmp = OUT_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        # allow_nan=False: bare NaN is invalid JSON and silently breaks every browser consumer.
        # That has already happened once here, on 650 ledger rows.
        json.dump(payload, f, allow_nan=False, separators=(',', ':'))
    os.replace(tmp, OUT_PATH)

    size = os.path.getsize(OUT_PATH)
    resolved = sum(1 for r in rows if r.get('h'))
    print(f'wrote {os.path.relpath(OUT_PATH, REPO)}  {size / 1048576:.2f} MB  '
          f'{len(rows):,} rows since {since}  ({resolved:,} with a graded horizon)')

    # Cloudflare Pages rejects any file over 25 MiB, and this one is published in the deploy bundle.
    # Catch it here, where the fix is --days, rather than at the edge.
    if size > 20 * 1024 * 1024:
        print(f'::error title=history slice too large::{size / 1048576:.1f} MB approaches '
              f"Cloudflare's 25 MiB per-file limit; lower --days", file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
