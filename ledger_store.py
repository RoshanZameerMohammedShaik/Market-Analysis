"""Where ledger rows live, and how to read and append them.

WHY THIS EXISTS
---------------
model/ledger/2026.jsonl reached 101.30 MB and GitHub refused the push:

    remote: error: File model/ledger/2026.jsonl is 101.30 MB; this exceeds
    remote: error: GitHub's file size limit of 100.00 MB

That is a HARD limit on any single blob, not a warning and not a quota that can be raised, so
every Live ledger cron failed at the commit step from the moment the file crossed it. The rows
were computed correctly, written to the runner's disk, and then died with the runner. Several
market opens were lost that way before the cause was visible, because the push error only
appeared in a job log that returns 403 without repo admin.

Git LFS is what GitHub suggests and it is the wrong answer here: the free tier allows 1 GB of
storage and 1 GB of bandwidth a month, and a ~100 MB file rewritten by every cron would
exhaust both within days and then fail exactly the same way, with a billing problem attached.

MONTHLY SHARDS
--------------
    model/ledger/2026-05.jsonl      4.4 MB
    model/ledger/2026-06.jsonl     33.0 MB
    ...

At the current ~1,000 rows a day and ~1,500 bytes a row, a month is roughly 45 MB at its
worst, so each shard has permanent headroom while the total can grow forever. Sharding by
month rather than by quarter or year is deliberate: it is the coarsest unit that stays safely
bounded, and the coarser the shard the fewer files a full pass has to open.

It also makes the daily write cheap. Appending to a 30 MB shard rewrites a 30 MB blob in git
rather than a 100 MB one, which is a direct saving on repo growth for every single cron run.

THE LEGACY FILE
---------------
A bare `YYYY.jsonl` is still read if present, so a partially migrated checkout, an old clone
or a research script that has not been updated all keep working. Nothing writes to it.
"""
from __future__ import annotations

import datetime
import json
import os
import re

REPO = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(REPO, 'model', 'ledger')

# 2026-09.jsonl -> a shard. 2026.jsonl -> the legacy whole-year file.
SHARD_RE = re.compile(r'^(\d{4})-(\d{2})\.jsonl$')
LEGACY_RE = re.compile(r'^(\d{4})\.jsonl$')


def month_key(date_str):
    """'2026-09-01' -> '2026-09'. Returns None for anything unparseable.

    Deliberately string slicing rather than date parsing: rows are written with ISO dates and
    a malformed one must be detectable, not coerced into today's shard where it would corrupt
    a month's coverage figures.
    """
    s = str(date_str or '')
    return s[:7] if re.match(r'^\d{4}-\d{2}', s) else None


def shard_path(date_str, ledger_dir=LEDGER_DIR):
    mk = month_key(date_str)
    if not mk:
        raise ValueError(f'unusable ledger date: {date_str!r}')
    return os.path.join(ledger_dir, f'{mk}.jsonl')


def shard_files(ledger_dir=LEDGER_DIR, include_legacy=True):
    """Every ledger file, oldest first. Shards sort correctly as strings.

    Legacy whole-year files come FIRST so that when both exist, rows land in chronological
    order overall -- a legacy 2026.jsonl predates every 2026-MM shard it was split from.
    """
    if not os.path.isdir(ledger_dir):
        return []
    names = os.listdir(ledger_dir)
    legacy = sorted(n for n in names if LEGACY_RE.match(n)) if include_legacy else []
    shards = sorted(n for n in names if SHARD_RE.match(n))
    return [os.path.join(ledger_dir, n) for n in legacy + shards]


def iter_rows(ledger_dir=LEDGER_DIR, since=None, include_legacy=True):
    """Yield every ledger row as a dict, skipping unparseable lines.

    `since` is an inclusive 'YYYY-MM-DD' floor. It prunes whole SHARDS before opening them,
    which is the point of sharding for readers: asking for the last three days no longer
    touches 100 MB.
    """
    since_month = month_key(since) if since else None
    for path in shard_files(ledger_dir, include_legacy):
        base = os.path.basename(path)
        m = SHARD_RE.match(base)
        # Legacy files hold many months, so they can never be skipped wholesale.
        if since_month and m and f'{m.group(1)}-{m.group(2)}' < since_month:
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if since and (row.get('date') or '') < since:
                    continue
                yield row


def count_rows(ledger_dir=LEDGER_DIR, include_legacy=True):
    return sum(1 for _ in iter_rows(ledger_dir, include_legacy=include_legacy))


def append_rows(rows, ledger_dir=LEDGER_DIR):
    """Append rows to the shard each one belongs to, by its own `date`.

    Grouped so a batch spanning a month boundary writes both shards correctly, and each file
    is opened once rather than per row. A row whose date is unusable is REFUSED rather than
    filed under today: silently misfiling it would corrupt that month's coverage check, and a
    coverage check that can be corrupted by bad input is worse than none.
    """
    os.makedirs(ledger_dir, exist_ok=True)
    by_shard = {}
    refused = []
    for r in rows:
        mk = month_key(r.get('date'))
        if not mk:
            refused.append(r.get('symbol'))
            continue
        by_shard.setdefault(mk, []).append(r)
    written = 0
    for mk, group in sorted(by_shard.items()):
        with open(os.path.join(ledger_dir, f'{mk}.jsonl'), 'a', encoding='utf-8') as f:
            for r in group:
                # allow_nan=False: a bare NaN is invalid JSON and silently breaks every
                # browser consumer. 650 rows in this ledger once carried one.
                f.write(json.dumps(r, allow_nan=False) + '\n')
                written += 1
    return {'written': written, 'shards': sorted(by_shard), 'refused': refused}


def rewrite_rows(transform, ledger_dir=LEDGER_DIR):
    """Rewrite every row through `transform(row) -> row`, shard by shard, atomically.

    Used by record_outcomes.py, which fills matured horizons in place rather than appending.
    One shard at a time, via a temp file and os.replace, so an interrupted run cannot leave a
    half-written shard: the file is either the old one or the new one.
    """
    stats = {'files': 0, 'rows': 0, 'changed': 0}
    for path in shard_files(ledger_dir):
        tmp = path + '.tmp'
        changed = 0
        total = 0
        with open(path, encoding='utf-8') as src, open(tmp, 'w', encoding='utf-8') as dst:
            for line in src:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    # Preserve it verbatim. Dropping a line we cannot parse would delete data
                    # to tidy up a formatting problem.
                    dst.write(line + '\n')
                    total += 1
                    continue
                new = transform(row)
                total += 1
                if new is not None and new is not row:
                    changed += 1
                    row = new
                dst.write(json.dumps(row, allow_nan=False) + '\n')
        os.replace(tmp, path)
        stats['files'] += 1
        stats['rows'] += total
        stats['changed'] += changed
    return stats


def migrate_legacy(ledger_dir=LEDGER_DIR, dry_run=False):
    """Split any legacy YYYY.jsonl into monthly shards, then remove it.

    Verifies the row count survives before deleting anything. The ledger is the only copy of
    this history -- a market open cannot be replayed -- so the destructive step happens only
    after the counts reconcile.
    """
    out = {'migrated': [], 'skipped': []}
    for path in shard_files(ledger_dir, include_legacy=True):
        base = os.path.basename(path)
        if not LEGACY_RE.match(base):
            continue
        by_month = {}
        bad = 0
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    bad += 1
                    continue
                mk = month_key(row.get('date'))
                if not mk:
                    bad += 1
                    continue
                by_month.setdefault(mk, []).append(line)
        total = sum(len(v) for v in by_month.values())
        if dry_run:
            out['migrated'].append({'file': base, 'rows': total, 'bad': bad,
                                    'months': {k: len(v) for k, v in sorted(by_month.items())}})
            continue

        # Append rather than truncate: a shard may already exist from a partial migration or
        # from crons that ran after the split.
        for mk, lines in sorted(by_month.items()):
            with open(os.path.join(ledger_dir, f'{mk}.jsonl'), 'a', encoding='utf-8') as f:
                for line in lines:
                    f.write(line + '\n')

        after = sum(1 for _ in iter_rows(ledger_dir, include_legacy=False))
        if after < total:
            out['skipped'].append({'file': base, 'reason': 'row count did not reconcile',
                                   'expected_at_least': total, 'found': after})
            continue
        os.remove(path)
        out['migrated'].append({'file': base, 'rows': total, 'bad': bad,
                                'months': {k: len(v) for k, v in sorted(by_month.items())}})
    return out


def sizes(ledger_dir=LEDGER_DIR):
    """Per-file size in MB, so a shard approaching the limit is visible before it bites."""
    return [{'file': os.path.basename(p), 'mb': round(os.path.getsize(p) / 1048576, 2)}
            for p in shard_files(ledger_dir)]


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='Inspect or migrate the ledger store.')
    ap.add_argument('--migrate', action='store_true', help='split legacy YYYY.jsonl into months')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    if a.migrate:
        r = migrate_legacy(dry_run=a.dry_run)
        print(json.dumps(r, indent=2))
    for s in sizes():
        flag = '  <-- OVER GITHUB LIMIT' if s['mb'] >= 100 else (
            '  <-- approaching limit' if s['mb'] >= 80 else '')
        print(f"  {s['file']:<20} {s['mb']:>8.2f} MB{flag}")
    print(f'  total rows: {count_rows():,}')
