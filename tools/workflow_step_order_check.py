"""Fail when a workflow step reads `steps.<id>.outputs` from a step that has not run yet.

GitHub evaluates `steps.<id>` to empty when <id> is later in the job (or does not exist), so an
`if:` that tests it is silently false and the step is skipped forever. That is how the Mia desk
ran for weeks without its Node 24 setup: both `if: steps.mode.outputs.mode == 'trade'` steps sat
ABOVE the step with `id: mode`, and the only symptom was an unrelated-looking cache error on the
days the pip cache restore timed out (2026-10-04).

Run: python tools/workflow_step_order_check.py
"""
import glob
import os
import re
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = re.compile(r'steps\.([A-Za-z_][\w-]*)\.(?:outputs|outcome|conclusion)')


def scan(path):
    problems = []
    with open(path, encoding='utf-8') as f:
        wf = yaml.safe_load(f)
    for job_name, job in (wf.get('jobs') or {}).items():
        seen = set()
        ids = {s.get('id') for s in job.get('steps') or [] if s.get('id')}
        for i, step in enumerate(job.get('steps') or []):
            text = yaml.safe_dump({k: v for k, v in step.items() if k != 'id'})
            for ref in sorted(set(REF.findall(text))):
                if ref not in seen:
                    where = 'is defined LATER in the job' if ref in ids else 'does not exist'
                    problems.append(f"{os.path.relpath(path, REPO)} job '{job_name}' step {i + 1} "
                                    f"({step.get('name') or step.get('uses') or 'unnamed'}): reads steps.{ref}, which {where}")
            if step.get('id'):
                seen.add(step['id'])
    return problems


def main():
    files = sorted(glob.glob(os.path.join(REPO, '.github', 'workflows', '*.yml')))
    problems = [p for f in files for p in scan(f)]
    for p in problems:
        print(f'  FAIL  {p}')
    print(f'\nWORKFLOW STEP ORDER {"FAIL" if problems else "PASS"}: {len(files)} workflows, {len(problems)} problem(s)')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
