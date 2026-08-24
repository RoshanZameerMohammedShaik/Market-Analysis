"""Block employer identity from ever reaching this public repo.

Why this exists
---------------
This repo is PUBLIC. The owner's Windows username is also his employer alias, so
the absolute path C:\\Users\\<alias>\\... is embedded automatically into build
artifacts by tools that record source paths. Python is the clearest case: every
.pyc carries its source path, verified in this repo as

    C:\\Users\\<alias>\\Market-Analysis\\penny_universe.py

Those files are gitignored today, so nothing has leaked. But `git add -f`, a new
toolchain that writes artifacts inside the repo, a build log, or a traceback
pasted into a public issue would expose it, and exposure is permanent once
scrapers index it.

This script is the hard gate. It runs two ways:

  --staged   pre-commit, over staged content only (see .githooks/pre-commit)
  (default)  over all TRACKED files, for CI

Design notes
------------
Patterns are deliberately narrow to avoid false positives. The bare word "amazon"
is NOT flagged, because this is a stock-analysis app that legitimately discusses
AMZN, and one existing commit message reads "Amazon is $185 when AMZN is ~$270".
What is flagged is identity: the alias as a standalone word, an @employer email,
the Cloud Desktop home path, and Windows user paths.

The alias is not hardcoded here. It is read from CORP_ALIASES, which defaults to
the current OS username, so this file itself never publishes the thing it guards.
"""
import argparse
import getpass
import os
import re
import subprocess
import sys

# The alias to guard. Defaults to the current OS username, which on the owner's
# machine IS the employer alias, so nothing sensitive is written into this file.
# Override with CORP_ALIASES="a,b" for CI, where the runner user is "runner".
_env = os.environ.get('CORP_ALIASES', '')
ALIASES = [a.strip() for a in _env.split(',') if a.strip()]
if not ALIASES:
    try:
        u = getpass.getuser()
        if u and u.lower() not in ('runner', 'root', 'runneradmin'):
            ALIASES = [u]
    except Exception:
        ALIASES = []

PATTERNS = [
    (re.compile(r'/local/home/', re.I), 'Cloud Desktop home path'),
    (re.compile(r'@amazon\.com', re.I), 'employer email address'),
    (re.compile(r'[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+', re.I), 'Windows user path'),
    (re.compile(r'\bcorp\.amazon\.com\b|\ba2z\.com\b|\baws\.dev\b', re.I), 'internal hostname'),
]
for a in ALIASES:
    PATTERNS.append((re.compile(r'\b' + re.escape(a) + r'\b'), 'employer alias'))

# Binary-ish or vendored paths where a match is noise rather than signal.
SKIP_SUFFIX = ('.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf',
               '.zip', '.gz', '.pdf', '.mp3', '.wav')
SKIP_DIRS = ('node_modules/', 'js/vendor/', '.git/', 'android/')
# This file necessarily contains the pattern strings themselves.
SELF = 'tools/check_no_corp_identity.py'


def tracked_files():
    out = subprocess.run(['git', 'ls-files', '-z'], capture_output=True, text=True)
    return [p for p in out.stdout.split('\0') if p]


def staged_files():
    out = subprocess.run(['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
                         capture_output=True, text=True)
    return [p for p in out.stdout.split('\0') if p]


def content_of(path, staged):
    if staged:
        r = subprocess.run(['git', 'show', f':{path}'], capture_output=True)
        return r.stdout if r.returncode == 0 else b''
    try:
        with open(path, 'rb') as f:
            return f.read()
    except Exception:
        return b''


def scan(paths, staged):
    findings = []
    for p in paths:
        norm = p.replace('\\', '/')
        if norm == SELF or norm.endswith(SKIP_SUFFIX) or any(d in norm for d in SKIP_DIRS):
            continue
        # The FILENAME itself can leak, e.g. a committed __pycache__ path.
        for rx, why in PATTERNS:
            if rx.search(norm):
                findings.append((p, 0, why, f'in the file PATH: {norm}'))
        blob = content_of(p, staged)
        if not blob:
            continue
        if b'\0' in blob[:4096]:
            # Binary. Still scan, because .pyc is binary and is the main vector,
            # but report without a line number.
            text = blob.decode('latin-1', 'replace')
            for rx, why in PATTERNS:
                m = rx.search(text)
                if m:
                    findings.append((p, 0, why, f'binary file contains {m.group(0)!r}'))
            continue
        for i, line in enumerate(blob.decode('utf-8', 'replace').splitlines(), 1):
            for rx, why in PATTERNS:
                m = rx.search(line)
                if m:
                    findings.append((p, i, why, m.group(0)))
    return findings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--staged', action='store_true',
                    help='scan staged content only (pre-commit mode)')
    args = ap.parse_args()

    if not ALIASES:
        print('[corp-check] no alias configured; path/email/hostname rules still active',
              file=sys.stderr)

    paths = staged_files() if args.staged else tracked_files()
    findings = scan(paths, args.staged)

    scope = 'staged' if args.staged else 'tracked'
    if not findings:
        print(f'[corp-check] OK: {len(paths)} {scope} file(s), no employer identity found')
        return 0

    print(f'\n[corp-check] BLOCKED: employer identity found in {len(findings)} place(s)\n',
          file=sys.stderr)
    for p, line, why, detail in findings[:40]:
        where = f'{p}:{line}' if line else p
        print(f'  {where}\n      {why}: {detail}', file=sys.stderr)
    if len(findings) > 40:
        print(f'  ... and {len(findings) - 40} more', file=sys.stderr)
    print('\nThis repo is PUBLIC. Exposure is permanent once indexed.', file=sys.stderr)
    print('Remove the content, or add the path to .gitignore, then commit again.',
          file=sys.stderr)
    print('To bypass deliberately (you almost never should): git commit --no-verify',
          file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
