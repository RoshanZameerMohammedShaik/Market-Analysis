"""Has this Live ledger task already done its work today? Standard library only.

GitHub delivered this workflow's crons hours late in October 2026 (08:05 at 17:00, 13:35 at
21:12, one never), so the slots are now fired on time by workers/ledger-clock and the
schedule stays as a fallback. A fallback that arrives after the work is done should cost
seconds, not a 2-8 minute `pip install` spent inside the concurrency group, where GitHub
keeps one pending run and cancels the earlier one. This answers the question before any of
that runs.

The task is resolved exactly as the workflow's own "Decide task" step resolves it, by reading
that step's case table out of the YAML, so there is no second copy of the schedule to drift.

  python tools/ledger_task_done.py --schedule "35 13 * * 1-5"      -> prints task, done
  python tools/ledger_task_done.py --task predict-NYSE

Prints `task=<name>` and `done=true|false` lines for $GITHUB_OUTPUT. Only predict-* tasks can
be "done"; everything else (resolve, recalibrate, publish) is idempotent and always runs.
"""
import argparse
import datetime
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(REPO, '.github', 'workflows', 'live-ledger.yml')
LEDGER = os.path.join(REPO, 'model', 'ledger')
REGIONS = {'predict-NYSE': ['NYSE'], 'predict-CRYPTO': ['CRYPTO'], 'predict-NSE': ['NSE'],
           'predict-LSE': ['LSE'], 'predict-XETRA': ['XETRA'], 'predict-LSE-XETRA': ['LSE', 'XETRA'],
           'predict-HKEX': ['HKEX'], 'predict-TYO': ['TYO'], 'predict-ASX': ['ASX']}


def schedule_table(path=WORKFLOW):
    """{cron string: task} from the Decide task step's `case` block."""
    text = open(path, encoding='utf-8').read()
    return dict(re.findall(r'"([0-9*/ ,-]+)"\)\s+task="([A-Za-z-]+)"', text))


def regions_written(day_iso, ledger_dir=LEDGER):
    """Regions with at least one row dated `day_iso` (UTC, as record_predictions.py dates them)."""
    path = os.path.join(ledger_dir, f'{day_iso[:7]}.jsonl')
    seen = set()
    if not os.path.exists(path):
        return seen
    needle = f'"date": "{day_iso}"'
    with open(path, encoding='utf-8') as f:
        for line in f:
            if needle not in line and f'"date":"{day_iso}"' not in line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('date') == day_iso and r.get('region'):
                seen.add(r['region'])
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--schedule', default='')
    ap.add_argument('--task', default='')
    ap.add_argument('--date', default='', help='UTC date to check (default today)')
    a = ap.parse_args()
    task = a.task or schedule_table().get(a.schedule, '')
    day = a.date or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    need = REGIONS.get(task)
    done = bool(need) and set(need) <= regions_written(day)
    print(f'task={task}')
    print(f'done={"true" if done else "false"}')
    print(f'# {task or "(no task)"} on {day}: {"already recorded" if done else "work to do"}', file=sys.stderr)


if __name__ == '__main__':
    main()
