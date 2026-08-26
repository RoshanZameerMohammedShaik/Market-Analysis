"""Assert every task the Live ledger workflow can produce is routed correctly.

Why this exists: the workflow dispatches work by matching a task name that
"Decide task" derives from the cron schedule (or from the manual dispatch
input). Those conditions used contains(), and 'predict-LSE-XETRA' contains the
substring 'predict-LSE', so the standalone LSE step fired on the combined run.
LSE was predicted twice, the second leg found everything already written and
hard-failed, the commit step was skipped, and the rows the run had already
produced were discarded. LSE and XETRA wrote nothing from 2026-06-19 to
2026-08-18 and the only signal was a failure email nobody could act on.

Nothing about that was visible in a diff. These are the three invariants that
would have caught it, all derived from the YAML rather than a maintained list:

  1. Every task the workflow can produce routes to at least one work step.
     An unrouted task means a green run that silently does nothing.
  2. No task predicts the same region more than once. A double-run is what
     turns an idempotent replay into a hard failure.
  3. Every cron task name is offered in the manual dispatch dropdown, so any
     failing slot can be replayed by hand.

Run: python tools/workflow_task_coverage.py
"""
import re
import sys

import yaml

WORKFLOW = '.github/workflows/live-ledger.yml'
JOB = 'ledger'
# Steps that intentionally run for every task, so they are not "routing".
UNCONDITIONAL = ('always()',)


def load(path):
    with open(path, encoding='utf-8') as f:
        doc = yaml.safe_load(f)
    # PyYAML parses a bare `on:` key as the boolean True.
    triggers = doc.get('on') if 'on' in doc else doc.get(True)
    return doc, triggers


def accepted_values(condition):
    """Task values an `if:` accepts, per exact-equality comparisons."""
    return set(re.findall(r"steps\.decide\.outputs\.task == '([^']+)'", condition or ''))


def main():
    doc, triggers = load(WORKFLOW)
    steps = doc['jobs'][JOB]['steps']

    options = set(triggers['workflow_dispatch']['inputs']['task']['options'])
    decide = next(s for s in steps if s.get('name') == 'Decide task')['run']
    cron_tasks = {t for t in re.findall(r'task="([a-zA-Z-]+)"', decide) if t}
    tasks = sorted(options | cron_tasks)

    # Work steps are the named, conditional ones. Steps with no `if:` or an
    # always() guard (disk inspect, commit) run regardless and prove nothing
    # about routing.
    work = [
        s for s in steps
        if s.get('name') and s.get('if')
        and not any(u in s['if'] for u in UNCONDITIONAL)
        and s['name'] != 'Decide task'
    ]

    failures = []

    unrouted = [t for t in tasks if not any(t in accepted_values(s['if']) for s in work)]
    for t in unrouted:
        failures.append(f'task {t!r} routes to no step: it would run green and do nothing')

    for t in tasks:
        regions = [
            s['name'].replace('Predict ', '').split(' ')[0]
            for s in work
            if s['name'].startswith('Predict') and t in accepted_values(s['if'])
        ]
        for region in {r for r in regions if regions.count(r) > 1}:
            failures.append(
                f'task {t!r} predicts region {region} {regions.count(region)} times: '
                'the repeat run sees only duplicates and trips the hard-fail guard'
            )

    for t in sorted(cron_tasks - options):
        failures.append(
            f'cron task {t!r} is not in the workflow_dispatch options, so a failing '
            'run of that slot cannot be replayed by hand'
        )

    # A contains() test on the task is what caused this; refuse to let it back in.
    for s in work:
        if 'steps.decide.outputs.task' in s['if'] and 'contains(' in s['if']:
            failures.append(
                f'step {s["name"]!r} matches the task with contains(); task names are '
                'substrings of each other, so use == instead'
            )

    # The push-recovery path re-runs the task from scratch after a hard reset, via
    # its OWN `case "$TASK"` inside the commit step. That case list is a second,
    # independent copy of the routing table, so it drifts silently: it was missing
    # resolve-outcomes, recalibrate and reresolve-outcomes, all of which fell
    # through to "Unknown TASK" and failed the recovery. Invisible in normal
    # operation, because the nightly cron only sends resolve-and-recalibrate, so it
    # broke exactly the manual halves and only under a concurrent push.
    commit_step = next((s for s in steps
                        if 'run_task()' in (s.get('run') or '')), None)
    if not commit_step:
        failures.append('no step defines run_task(); the push-recovery path is gone')
    else:
        body = commit_step['run']
        # Bash case arms: `  task-name)`. The character class MUST allow uppercase:
        # region names are capitalised (predict-NYSE), so a lowercase-only pattern
        # silently matched none of the nine predict-* arms and reported them all as
        # missing when they were present.
        covered = set(re.findall(r'^\s*([A-Za-z][\w-]*)\)', body, re.M))
        for t in sorted(set(tasks) - covered):
            failures.append(
                f'task {t!r} has no arm in the run_task() recovery case, so a rejected '
                'push hits "Unknown TASK" and the retry fails'
            )

    print(f'{WORKFLOW}: {len(tasks)} task values, {len(work)} conditional steps')
    for t in tasks:
        hit = [s['name'] for s in work if t in accepted_values(s['if'])]
        print(f'  {t:<26} -> {", ".join(hit) or "(nothing)"}')

    if failures:
        print(f'\nFAIL ({len(failures)}):', file=sys.stderr)
        for f in failures:
            print(f'  - {f}', file=sys.stderr)
        sys.exit(1)
    print('\nPASS: every task routes to a step, no region runs twice, '
          'every cron slot is manually replayable')


if __name__ == '__main__':
    main()
