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

Prints `task=<name>` and `done=true|false` lines for $GITHUB_OUTPUT. Predict tasks are done once
their regions have rows for the day. The nightly resolve is done, for the late SCHEDULED fallback
only, once tonight's volatility slice and setups list both cover the latest NYSE session: on
2026-10-14 the fallback arrived at 01:21 UTC, three hours after the on-time run, inside a window
when Yahoo had dropped that session's bars, and rewrote both files a session older. A manual or
ledger-clock dispatch always runs. Everything else (recalibrate, publish) always runs.
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


RESOLVE_OUTPUTS = ('model/vol_forecasts.json', 'model/setups.json')


def nyse_expected_session(now_utc):
    """The NYSE session a resolve run at `now_utc` is for: today in New York once the close has
    settled (16:10), else the weekday before. Holidays are not known here, so on one the answer is
    'work to do' and the run goes ahead, as it always did."""
    from zoneinfo import ZoneInfo
    ny = now_utc.astimezone(ZoneInfo('America/New_York'))
    d = ny.date()
    if (ny.hour, ny.minute) < (16, 10):
        d -= datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d -= datetime.timedelta(days=1)
    return d.isoformat()


def resolve_done(now_utc, repo=REPO):
    """True when every nightly output already covers the expected session."""
    want = nyse_expected_session(now_utc)
    for rel in RESOLVE_OUTPUTS:
        try:
            with open(os.path.join(repo, rel), encoding='utf-8') as f:
                if json.load(f).get('sessionDate') != want:
                    return False
        except (OSError, ValueError, AttributeError):
            return False
    return True


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
    if task == 'resolve-and-recalibrate' and a.schedule and not a.date:
        done = resolve_done(datetime.datetime.now(datetime.timezone.utc))
    print(f'task={task}')
    print(f'done={"true" if done else "false"}')
    print(f'# {task or "(no task)"} on {day}: {"already recorded" if done else "work to do"}', file=sys.stderr)


if __name__ == '__main__':
    main()
