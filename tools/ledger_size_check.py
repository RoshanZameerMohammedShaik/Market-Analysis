"""Fail BEFORE a ledger shard grows past what GitHub will accept.

WHY
---
model/ledger/2026.jsonl reached 101.30 MB and GitHub rejected every push:

    remote: error: File model/ledger/2026.jsonl is 101.30 MB; this exceeds
    remote: error: GitHub's file size limit of 100.00 MB

That limit is hard. It cannot be raised, and the rejection happens at push time, which is
AFTER the cron has already computed and written the rows. So the failure mode was the worst
available: correct data written to a runner's disk, thrown away when the runner exited, and a
push error visible only in a job log that returns 403 without repo admin. Several market opens
were lost before anyone could see why, and a market open cannot be replayed.

Sharding by month fixed it. This check makes sure it stays fixed, and fails while there is
still room to act rather than at the moment the door closes.

WARN vs FAIL
------------
The warn threshold is what matters. A shard crossing it is not yet broken, so the build stays
green while there is time to split the shard, prune, or change cadence. Failing only at 100 MB
would reproduce exactly the situation this file exists to prevent.

Run: python tools/ledger_size_check.py [--warn-mb 70] [--fail-mb 95]
"""
import argparse
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import ledger_store  # noqa: E402

# GitHub's hard limit on any single blob. Not a setting.
GITHUB_LIMIT_MB = 100.0


def main():
    ap = argparse.ArgumentParser()
    # 95 leaves a margin: a shard is checked before a cron appends to it, and the append itself
    # adds ~1.5 MB a day. Failing at exactly 100 would let a run pass the check and then still
    # be rejected by the push.
    ap.add_argument('--fail-mb', type=float, default=95.0)
    ap.add_argument('--warn-mb', type=float, default=70.0)
    # Exists so the check itself is testable. A guard that has never been seen to FAIL is not
    # known to work, and this one only earns its place if a too-large shard really trips it.
    ap.add_argument('--dir', default=None, help='ledger directory (for testing the guard)')
    a = ap.parse_args()

    ledger_dir = a.dir or ledger_store.LEDGER_DIR
    shards = ledger_store.sizes(ledger_dir=ledger_dir)
    if not shards:
        print('No ledger shards found. Nothing to check.')
        return 0

    worst = 0.0
    problems, warnings = [], []
    print(f"{'shard':<24}{'MB':>9}   status")
    for s in shards:
        mb = s['mb']
        worst = max(worst, mb)
        if mb >= a.fail_mb:
            status = f'OVER {a.fail_mb} MB'
            problems.append(s)
        elif mb >= a.warn_mb:
            status = f'approaching {GITHUB_LIMIT_MB} MB limit'
            warnings.append(s)
        else:
            status = 'ok'
        print(f"  {s['file']:<22}{mb:>9.2f}   {status}")

    # A legacy whole-year file is the shape that broke: it has no bound at all, so it will grow
    # past the limit again eventually no matter what its size is today.
    legacy = [s for s in shards if len(s['file'].split('-')) == 1]
    if legacy:
        problems.extend(legacy)
        for s in legacy:
            print(f"  {s['file']}: unsharded whole-year file. It has no upper bound and will "
                  f'cross the limit again. Run: python ledger_store.py --migrate')

    total = sum(s['mb'] for s in shards)
    print(f'\n{len(shards)} shard(s), {total:.1f} MB total, largest {worst:.2f} MB '
          f'(GitHub blob limit {GITHUB_LIMIT_MB} MB)')

    if problems:
        names = ', '.join(sorted({s['file'] for s in problems}))
        print(f'LEDGER SIZE FAIL: {names}')
        if os.environ.get('GITHUB_ACTIONS'):
            print(f'::error title=Ledger shard too large::{names} would be rejected by '
                  f"GitHub's {GITHUB_LIMIT_MB} MB blob limit, which fails the push AFTER the "
                  f'rows are already computed. Split or prune it.')
        return 1

    if warnings:
        names = ', '.join(s['file'] for s in warnings)
        print(f'LEDGER SIZE WARN: {names} past {a.warn_mb} MB')
        if os.environ.get('GITHUB_ACTIONS'):
            print(f'::warning title=Ledger shard growing::{names} is past {a.warn_mb} MB of '
                  f'the {GITHUB_LIMIT_MB} MB blob limit. Still safe, but plan the split now.')
        return 0

    print('LEDGER SIZE PASS: every shard has headroom')
    return 0


if __name__ == '__main__':
    sys.exit(main())
