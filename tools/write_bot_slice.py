"""Compact Mia 2.0's desk into one file the browser can read in a single fetch.

WHY A SLICE
-----------
The desk's authoritative records are append-only logs: model/bot/trades.jsonl grows by
one row per fill forever, and model/bot/runs.jsonl by one row per run (hourly). Neither
is a sane thing to hand a phone browser, and both will be megabytes within months. This
mirrors tools/write_recent_slice.py, which exists for exactly the same reason on the
ledger: without it the browser fetched an 85 MB year file to read three days.

The slice is DERIVED and disposable. Delete it and the next run rebuilds it; nothing here
is a source of truth, so it is safe to change its shape whenever the UI needs something
different.

WHAT THE UI ASKED FOR
---------------------
Roshan's requirement was specific: a timeline of when and why each trade fired, on what
basis and strategy, with the P/L at each point. So each trade row carries its running
realized total, computed HERE rather than in JS. Two reasons:

  * The browser would otherwise have to re-derive it from a truncated list, and a running
    total computed over the last 200 of 5,000 trades is simply wrong. Computing it over
    the full log and then truncating is the only correct order.
  * It is the same class of bug as the ledger's positional outcome resolver, which graded
    every prediction against the wrong bar for months because the derivation happened at
    the wrong layer.

Run: python tools/write_bot_slice.py [--trades 200] [--runs 72]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT_DIR = os.path.join(REPO, 'model', 'bot')
TRADES_PATH = os.path.join(BOT_DIR, 'trades.jsonl')
RUNS_PATH = os.path.join(BOT_DIR, 'runs.jsonl')
STATE_PATH = os.path.join(BOT_DIR, 'state.json')
CONFIG_PATH = os.path.join(BOT_DIR, 'config.json')
OUT_PATH = os.path.join(BOT_DIR, 'timeline.json')


def read_jsonl(path):
    """Skip unparseable lines rather than dying.

    A single truncated final line -- the runner being cancelled mid-append is the
    realistic way that happens -- must not take down the whole panel. Bad lines are
    counted and reported in the payload so a systematic problem is still visible instead
    of being silently swallowed.
    """
    rows, bad = [], 0
    if not os.path.exists(path):
        return rows, bad
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return rows, bad


def read_json(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _content_changed(payload):
    """Does the new payload differ from what is on disk, ignoring generatedAt?

    Returns True when there is no existing file or it is unreadable, so a corrupt or missing
    slice is always rebuilt rather than left broken.
    """
    if not os.path.exists(OUT_PATH):
        return True
    try:
        with open(OUT_PATH, encoding='utf-8') as f:
            old = json.load(f)
    except (json.JSONDecodeError, OSError):
        return True
    strip = lambda d: {k: v for k, v in d.items() if k != 'generatedAt'}
    return strip(old) != strip(payload)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trades', type=int, default=200,
                    help='how many of the most recent fills to include')
    ap.add_argument('--runs', type=int, default=72,
                    help='how many of the most recent runs to include (72 = ~3 days hourly)')
    args = ap.parse_args()

    trades, bad_trades = read_jsonl(TRADES_PATH)
    runs, bad_runs = read_jsonl(RUNS_PATH)
    state = read_json(STATE_PATH) or {}
    cfg = read_json(CONFIG_PATH) or {}

    # Running realized P/L over the FULL log, before truncating. See the module docstring.
    cum = 0.0
    for t in trades:
        r = t.get('realizedUSD')
        if isinstance(r, (int, float)):
            cum += float(r)
        t['cumRealizedUSD'] = round(cum, 4)

    # Equity curve from the run log. runs.jsonl is the only place the account's value is
    # sampled over time -- state.json holds the CURRENT value only, so without this there
    # is no history to draw and no way to see a drawdown.
    curve = []
    for r in runs:
        tot = r.get('totals')
        if not tot:
            continue
        curve.append({
            'ts': r.get('ts'),
            'equityUSD': tot.get('equityUSD'),
            'pnlUSD': tot.get('pnlUSD'),
            'pnlPct': tot.get('pnlPct'),
        })

    # A run row carries the whole leaderboard and refusal list, which is a lot of bytes to
    # send just to prove the cron is alive. The heartbeat keeps only what the UI shows.
    heartbeat = [{
        'ts': r.get('ts'),
        'gapMinutes': r.get('gapMinutes'),
        'openMarkets': r.get('openMarkets'),
        'analysed': r.get('analysed'),
        'fills': r.get('fills'),
        'refusals': r.get('refusals'),
        'miaBrain': r.get('miaBrain'),
        'note': r.get('note'),
    } for r in runs[-args.runs:]]

    latest = next((r for r in reversed(runs) if r.get('leaderboard')), None)

    payload = {
        'schema': 1,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc)
                               .strftime('%Y-%m-%dT%H:%M:%SZ'),
        # Deliberately reports the FULL counts alongside the truncated arrays, so the UI can
        # say "showing 200 of 4,812" instead of implying the desk has only ever done 200
        # things.
        'counts': {
            'trades': len(trades),
            'runs': len(runs),
            'unparseableTrades': bad_trades,
            'unparseableRuns': bad_runs,
        },
        'seedUSD': state.get('seedUSD'),
        'createdAt': state.get('createdAt'),
        'updatedAt': state.get('updatedAt'),
        'totals': state.get('totals'),
        'sleeves': state.get('sleeves'),
        'leaderboard': (latest or {}).get('leaderboard'),
        'config': {
            'accountType': cfg.get('accountType'),
            'commissionPlan': cfg.get('commissionPlan'),
            'markets': cfg.get('markets'),
            'enabled': cfg.get('enabled', True),
            'reseedDeadSleeves': cfg.get('reseedDeadSleeves'),
            # The UI switches between the Start button and the live desk on `armed`. It is
            # a fact about configuration, not an event, so it belongs here and not in the
            # run log -- the disarmed desk deliberately records no runs at all, because an
            # hourly "still not armed" row would be 24 commits a day of nothing happening.
            'armed': bool(cfg.get('armed')),
            'armedAt': cfg.get('armedAt'),
            'allocationUSD': cfg.get('allocationUSD'),
            # What the Start dialog pre-fills. NOT a seed: nothing is opened until the user
            # picks an amount.
            'suggestedUSD': cfg.get('seedUSD'),
            'minAllocationUSD': 400.0,
        },
        'equityCurve': curve[-args.runs:],
        'trades': trades[-args.trades:][::-1],   # newest first: the UI reads top-down
        'runs': heartbeat[::-1],
    }

    os.makedirs(BOT_DIR, exist_ok=True)

    # Rewrite ONLY when something other than the clock changed.
    #
    # generatedAt moves on every single run, so an unconditional write made the file differ
    # every hour even when the desk was disarmed and had done literally nothing. The cron
    # dutifully committed that one-line timestamp diff: 24 commits a day of no information,
    # each one a candidate Cloudflare Pages build against a 500/month budget. Being idle cost
    # more than trading.
    #
    # The comparison excludes generatedAt on both sides, so a genuine change (a fill, a new
    # run row, arming) still publishes immediately, while a no-op leaves the file untouched
    # and `git diff --cached --quiet` in the workflow correctly finds nothing to commit.
    if not _content_changed(payload):
        print(f'{os.path.relpath(OUT_PATH, REPO)} unchanged apart from the timestamp; '
              f'left alone so the cron has nothing to commit')
        return 0

    tmp = OUT_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        # allow_nan=False: bare NaN is invalid JSON and silently breaks every browser
        # consumer. That already happened once on 650 ledger rows.
        json.dump(payload, f, allow_nan=False, separators=(',', ':'))
    os.replace(tmp, OUT_PATH)

    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f'wrote {os.path.relpath(OUT_PATH, REPO)}  {size_kb:.1f} KB  '
          f'{len(payload["trades"])}/{len(trades)} trades, '
          f'{len(heartbeat)}/{len(runs)} runs, {len(curve)} curve points')
    if bad_trades or bad_runs:
        print(f'WARNING: skipped {bad_trades} unparseable trade rows and '
              f'{bad_runs} unparseable run rows', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
