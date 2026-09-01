"""Write a small recent-days slice of the ledger for the browser to read.

The problem this solves
-----------------------
model/ledger/2026.jsonl reached 85.6 MB at ~67,000 rows, and
js/ledger-reader.js loadLedger() downloaded the WHOLE file with a plain fetch(),
uncompressed, to answer a question as small as "what did the cron lock for AAPL
this morning?".

Consequences measured on the live site:
  * 85.6 MB, Content-Encoding: none, Cache-Control: max-age=3600
  * ~5s on a fast desktop link, ~143s (2.4 minutes) on a 5 Mbps phone
  * loadLedger()'s catch block sets _ledgerCache = [] on ANY failure, so a slow
    or aborted download silently yields an EMPTY ledger
  * an empty ledger makes readTodayLock() return null, and daily-lock.js then
    falls back to the page-VISIT-time lock

So the app was designed to anchor the day's call on the cron's market-open row,
and it silently degraded to "whenever the user happened to open the page" purely
because the ledger outgrew a single fetch. The design was right; the transport
broke it.

This writes model/ledger/recent.json holding only the last N days, which is all
the daily-lock path needs. Roughly 700 rows instead of 67,000.

Why N days rather than strictly today: market opens span UTC days (ASX opens
23:00 UTC), the cron stamps rows in UTC, and a user in a US timezone can be
looking at the app when UTC has already rolled over. A 3-day window makes the
lookup immune to all of that without meaningfully growing the file.

Run: python tools/write_recent_slice.py [--days 3]
"""
import argparse
import datetime
import json
import os
import sys

LEDGER_DIR = os.path.join('model', 'ledger')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ledger_store  # noqa: E402
OUT_NAME = 'recent.json'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=3,
                    help='how many trailing calendar days to include')
    args = ap.parse_args()

    # Sharded by month: a single year file hit GitHub's hard 100 MB blob limit and every
    # ledger push started failing outright. iter_rows prunes whole shards below the cutoff
    # before opening them, so building a 3-day slice no longer reads 100 MB.
    if not ledger_store.shard_files():
        print('ERROR: no ledger shards found in model/ledger/', file=sys.stderr)
        sys.exit(1)

    cutoff = (datetime.datetime.now(datetime.UTC).date()
              - datetime.timedelta(days=args.days)).isoformat()

    rows, scanned, bad = [], 0, 0
    for r in ledger_store.iter_rows(since=cutoff):
        scanned += 1
        rows.append(r)
    out = os.path.join(LEDGER_DIR, OUT_NAME)
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'cutoffDate': cutoff,
        'days': args.days,
        'sourceRows': scanned,
        'rows': rows,
    }
    with open(out, 'w', encoding='utf-8') as f:
        # allow_nan=False: a bare NaN token is invalid JSON and one such token
        # took down the browser's entire calibration load once before. 650 rows
        # in this ledger carry a NaN entry price, so this WILL fire if one lands
        # inside the window, and failing loudly here beats a silent browser throw.
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)

    shard_mb = sum(s['mb'] for s in ledger_store.sizes())
    out_mb = os.path.getsize(out) / 1048576
    print(f'{out}: {len(rows):,} rows (dates >= {cutoff}), {bad} unparseable')
    print(f'  ledger {shard_mb:.1f} MB across {len(ledger_store.shard_files())} shard(s) '
          f'-> {out_mb:.2f} MB slice')
    # A shard nearing 100 MB is the failure that took the ledger down for days. Say so while
    # there is still time to act, rather than discovering it in a rejected push.
    for s in ledger_store.sizes():
        if s['mb'] >= 80:
            print(f"  WARNING: {s['file']} is {s['mb']} MB, approaching GitHub's 100 MB "
                  f'blob limit', file=sys.stderr)
    return 0

if __name__ == '__main__':
    main()
