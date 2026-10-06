"""workers/ledger-clock must fire exactly the Live ledger's slots, with the same tasks.

The Worker carries its own copy of the schedule (it cannot read the YAML at runtime). A slot
added to the workflow but not the Worker would silently fall back to GitHub's late delivery, a task renamed in one place would dispatch something the workflow rejects. Both sides are
read from source here, and a few dueSlot() cases are run through Node against real clocks.

Run: python tools/ledger_clock_check.py
"""
import json
import os
import re
import subprocess
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(REPO, '.github', 'workflows', 'live-ledger.yml')
WORKER = os.path.join(REPO, 'workers', 'ledger-clock', 'src', 'worker.js')
passed = failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}  -> {detail}')


def cron_to_slots(cron):
    """'35 13 * * 1-5' -> (35, 13, sorted weekdays). Only the forms this workflow uses."""
    m, h, _, _, dow = cron.split()
    days = set()
    if dow == '*':
        days = set(range(7))
    else:
        for part in dow.split(','):
            if '-' in part:
                a, b = part.split('-')
                days |= set(range(int(a), int(b) + 1))
            else:
                days.add(int(part))
    return int(m), int(h), sorted(days)


def main():
    doc = yaml.safe_load(open(WF, encoding='utf-8'))
    on = doc.get('on') if 'on' in doc else doc.get(True)
    crons = [c['cron'] for c in on['schedule']]
    text = open(WF, encoding='utf-8').read()
    table = dict(re.findall(r'"([0-9*/ ,-]+)"\)\s+task="([A-Za-z-]+)"', text))
    options = set(on['workflow_dispatch']['inputs']['task']['options'])
    wf = sorted((*cron_to_slots(c), table.get(c)) for c in crons)

    out = subprocess.run(['node', '--input-type=module', '-e',
                          "import { SLOTS } from './workers/ledger-clock/src/worker.js';"
                          "process.stdout.write(JSON.stringify(SLOTS))"],
                         capture_output=True, text=True, cwd=REPO, timeout=60)
    if out.returncode != 0:
        check('worker module loads', False, out.stderr[-400:])
        return
    worker = sorted((m, h, sorted(days), task) for m, h, days, task, _ in json.loads(out.stdout))
    check(f'the Worker fires every workflow slot and no other ({len(wf)} slots)', worker == wf,
          f'workflow {wf} vs worker {worker}')
    check('every task it dispatches is one the workflow accepts', all(t in options for *_, t in worker),
          [t for *_, t in worker if t not in options])
    check('every slot sits on the 5-minute tick', all(m % 5 == 0 for m, *_ in worker))

    probe = subprocess.run(['node', '--input-type=module', '-e', '''
        import { dueSlot, allClosed } from './workers/ledger-clock/src/worker.js';
        const at = (iso) => Date.parse(iso);
        const sessions = { markets: { NYSE: { sessions: ['2026-11-25', '2026-11-27'], to: '2026-12-31' },
                                      TYO: { sessions: ['2026-10-09', '2026-10-13'], to: '2026-12-31' } } };
        process.stdout.write(JSON.stringify({
            nyseTue: dueSlot(at('2026-10-06T13:35:00Z'))?.[3] ?? null,
            nyseSat: dueSlot(at('2026-10-10T13:35:00Z'))?.[3] ?? null,
            offTick: dueSlot(at('2026-10-06T13:40:00Z'))?.[3] ?? null,
            asxSun: dueSlot(at('2026-10-04T23:05:00Z'))?.[3] ?? null,
            thanksgiving: allClosed(['NYSE'], at('2026-11-26T13:35:00Z'), sessions),
            dayAfter: allClosed(['NYSE'], at('2026-11-27T13:35:00Z'), sessions),
            sportsDay: allClosed(['TYO'], at('2026-10-12T00:05:00Z'), sessions),
            noCalendar: allClosed(['NYSE'], at('2026-11-26T13:35:00Z'), null),
        }));'''], capture_output=True, text=True, cwd=REPO, timeout=60)
    p = json.loads(probe.stdout) if probe.returncode == 0 else {}
    check('13:35 UTC on a Tuesday dispatches predict-NYSE', p.get('nyseTue') == 'predict-NYSE', p)
    check('nothing on a Saturday at that time', p.get('nyseSat') is None, p)
    check('nothing between slots', p.get('offTick') is None, p)
    check('ASX fires Sunday 23:05 UTC (Monday in Sydney)', p.get('asxSun') == 'predict-ASX', p)
    check('Thanksgiving is skipped', p.get('thanksgiving') is True, p)
    check('the day after Thanksgiving is not', p.get('dayAfter') is False, p)
    check('Tokyo Sports Day is skipped (Monday 00:05 UTC is Monday 09:05 Tokyo)', p.get('sportsDay') is True, p)
    check('without a calendar it never skips', p.get('noCalendar') is False, p)


if __name__ == '__main__':
    main()
    print(f'\nLEDGER CLOCK CHECK {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)
