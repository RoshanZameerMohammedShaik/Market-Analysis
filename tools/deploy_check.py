"""Is the LIVE site actually running what main says it should?

WHY THIS EXISTS
---------------
On 2026-08-27 Roshan asked why market-ai.pages.dev had not changed. It had not
changed since **2026-06-07, commit 289f775 — 592 commits earlier**. Everything built
in between was on GitHub and none of it was live: the UI redesign, the calibrated
band, the sub-penny price fix, the AI in the cron. Every local check passed, every
push succeeded, and the site quietly served an 11-week-old build the whole time.

Nothing in the repo would have caught that. A green CI and a successful push say
where the code IS, not what the CDN is SERVING. This closes that gap.

HOW IT DETECTS STALENESS
------------------------
Two independent signals, because either alone can lie:

  1. FILE EXISTENCE. Cloudflare Pages serves an SPA/404 HTML fallback for missing
     paths, and it returns HTTP **200** while doing it. So a naive status check
     passes for files that are not deployed at all. The tell is the content type:
     css/design-system.css came back `200 text/html` with the same byte count as a
     deliberately bogus filename. Any tracked asset served as text/html is missing.
  2. CONTENT HASH. index.html on the live site is hashed and compared against
     origin/main, with CRLF normalised because git stores LF and the edge may not.
     A mismatch is then located in history, so the report says exactly which commit
     is live rather than just "stale".

Exit 1 when the live site is behind, so this can run in CI or a cron and complain.

Usage:
    python tools/deploy_check.py
    python tools/deploy_check.py --url https://market-ai.pages.dev
"""
import argparse
import hashlib
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_URL = 'https://market-ai.pages.dev'
UA = {'User-Agent': 'Mozilla/5.0 (compatible; market-analysis-deploy-check/1.0)'}

# Assets that must exist for the current app to work at all. Each was added at a
# different time, so which ones are missing brackets how far behind the deploy is.
REQUIRED = [
    ('css/style.css', 'text/css'),
    ('css/premium.css', 'text/css'),
    ('css/design-system.css', 'text/css'),
    ('css/components.css', 'text/css'),
    ('js/app.js', 'javascript'),
    ('js/ui/themes.js', 'javascript'),
    ('js/price-round.js', 'javascript'),
    ('js/forecast-band.js', 'javascript'),
    ('model/band_calibration.json', 'json'),
    ('model/ledger/recent.json', 'json'),
]


def safe(text):
    """Console-safe string. A Windows console is cp1252 and commit subjects in this
    repo contain characters it cannot encode (U+2192 arrow, em dash), which crashed
    this tool while it was reporting the very problem it had found."""
    enc = sys.stdout.encoding or 'utf-8'
    return str(text).encode(enc, 'replace').decode(enc, 'replace')


def fetch(url, timeout=30):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get('Content-Type', ''), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', '') if e.headers else '', b''
    except Exception as e:
        return None, f'ERROR {type(e).__name__}', b''


def git(*args):
    return subprocess.run(['git', *args], capture_output=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=DEFAULT_URL)
    ap.add_argument('--ref', default='origin/main')
    args = ap.parse_args()
    base = args.url.rstrip('/')
    problems = []

    print(f'\nDEPLOY CHECK  {base}  vs  {args.ref}')
    print('=' * 78)

    # A path that cannot exist, to learn what "missing" looks like on this host.
    _, ctl_type, ctl_body = fetch(f'{base}/__deploy_check_missing__.css')
    fallback_len = len(ctl_body)
    print(f'  missing-file control: {ctl_type.split(";")[0]} '
          f'{fallback_len} bytes  (this is the fallback, NOT a real file)')

    print('\n  REQUIRED ASSETS')
    for path, want in REQUIRED:
        status, ctype, body = fetch(f'{base}/{path}')
        short = (ctype or '').split(';')[0]
        # The fallback returns 200 text/html, so the content type is the real test.
        missing = (status != 200) or ('html' in short) or (len(body) == fallback_len
                                                          and fallback_len > 0)
        ok = (not missing) and (want in short or want == 'json' and 'json' in short)
        flag = 'OK  ' if ok else 'MISSING'
        print(f'    {flag} {path:<34}{status} {short:<24}{len(body):>8,} B')
        if not ok:
            problems.append(f'{path} not deployed (served as {short})')

    # index.html content hash against the ref, then locate what IS live.
    print('\n  index.html')
    status, ctype, body = fetch(f'{base}/')
    live = body.replace(b'\r\n', b'\n')
    live_sha = hashlib.sha256(live).hexdigest()
    want = git('show', f'{args.ref}:index.html').replace(b'\r\n', b'\n')
    want_sha = hashlib.sha256(want).hexdigest()
    print(f'    live {live_sha[:16]}  {len(live):,} B')
    print(f'    {args.ref:<10} {want_sha[:16]}  {len(want):,} B')
    if live_sha == want_sha:
        print('    MATCH: the deployed HTML is current')
    else:
        problems.append('index.html on the live site does not match ' + args.ref)
        print('    MISMATCH - locating the deployed commit in history...')
        log = git('log', args.ref, '--format=%H|%ad|%s', '--date=short',
                  '-300', '--', 'index.html').decode('utf-8', 'replace').strip()
        found = None
        for line in log.splitlines():
            h = line.split('|')[0]
            blob = git('show', f'{h}:index.html').replace(b'\r\n', b'\n')
            if hashlib.sha256(blob).hexdigest() == live_sha:
                found = line
                break
        if found:
            # index.html is usually identical across MANY commits, so a hash match
            # names the commit that last CHANGED it, not the commit that is
            # deployed. Reporting one hash as "the deployed commit" overclaims: on
            # 2026-08-27 the match was 289f775 (2026-06-07), but the deployed
            # css/style.css was a version that only appeared at 94bc9b2 two days
            # later, so the real build sat somewhere in an 88-commit window. Report
            # the WINDOW, which is what the evidence actually supports.
            h, date, subj = found.split('|', 2)
            nxt = git('log', args.ref, '--format=%H|%ad', '--date=short',
                      '--reverse', f'{h}..{args.ref}', '--', 'index.html'
                      ).decode('utf-8', 'replace').strip().splitlines()
            upper = nxt[0].split('|') if nxt else None
            behind_lo = git('rev-list', '--count', f'{h}..{args.ref}').decode().strip()
            print(safe(f'    HTML last changed at: {h[:7]}  {date}  {subj}'))
            if upper:
                behind_hi = git('rev-list', '--count',
                                f'{upper[0]}..{args.ref}').decode().strip()
                print(f'    the deployed build is somewhere in '
                      f'{h[:7]} ({date}) .. {upper[0][:7]} ({upper[1]}),')
                print(f'    i.e. between {behind_hi} and {behind_lo} commits behind '
                      f'{args.ref}')
                problems.append(f'live build is {behind_hi}-{behind_lo} commits '
                                f'behind (HTML from {date} or later)')
            else:
                print(f'    the live site is {behind_lo} commits behind {args.ref}')
                problems.append(f'live build is {behind_lo} commits behind ({date})')
        else:
            print('    could not match any of the last 300 index.html versions;')
            print('    the deployment may predate them or be a different build')

    print('\n' + '=' * 78)
    if problems:
        print(f'DEPLOY CHECK FAIL: {len(problems)} problem(s)')
        for p in problems:
            print(f'  - {p}')
        print('\n  This is NOT fixable from the repo. Cloudflare Pages decides what to')
        print('  build, so check the Pages dashboard for the project:')
        print('    1. Settings > Builds & deployments > Production branch == main')
        print('    2. Deployments tab: are recent builds Skipped, Failed, or absent?')
        print('    3. Settings > Builds & deployments: is the GitHub connection live?')
        print('       Re-authorising the Cloudflare Pages GitHub App fixes a silent')
        print('       disconnect, which produces exactly this symptom.')
        print('    4. A "Retry deployment" on the latest commit forces one build and')
        print('       confirms whether the connection or the content is at fault.')
        print('\n  PRIME SUSPECT: the ledger cron commits with "[skip ci]", and')
        print('  Cloudflare Pages honours skip-CI tokens as well as GitHub Actions.')
        print('  Since the cron pushes several times a day, nearly every push to main')
        print('  carries that token. See .github/workflows/live-ledger.yml.')
        sys.exit(1)
    print('DEPLOY CHECK PASS: the live site matches ' + args.ref)


if __name__ == '__main__':
    main()
