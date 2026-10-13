"""The band's live record, and the correction that keeps it honest: model/band_live.json.

WHY
---
The band's z values are fitted once on history. When the market or the list of stocks changes,
a fixed z drifts off its claim, and it did: the "80%" band held 69.6% on rows whose start point
was wrong and 86-88% on rows whose start point was right, a spread nothing was watching. This
file watches it. Every night it reads the band days the resolver graded (record_outcomes.py
grade_band, forecastBand.x), and for each kind of band computes:

  coverage  how often both edges held, over the trailing window
  m         the multiplier on z that would have made the trailing window hold 80%

forecast_band.py and js/forecast-band.js apply m to the band they draw. A cell with few graded
days is shrunk toward 1 (no change), so a handful of days cannot swing the band, and m is capped
so one bad week cannot either. Only bands built by the 2026-10-13 definition carry the anchor the
grade needs, so the record starts there and grows from nothing; until a cell has data its m is 1.

CELLS
-----
region x volatility tier x days ahead (1, 2-3, 4-6, 7-10) x earnings or not, with a coarser
all-regions cell behind each one for when the specific cell is thin.

Run nightly after record_outcomes.py: python tools/write_band_live.py
"""
import datetime
import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import ledger_store  # noqa: E402

OUT = os.path.join(REPO, 'model', 'band_live.json')
TARGET = 0.80
WINDOW_DAYS = 60          # calendar days of anchors, about 40 sessions
SHRINK_N = 300            # graded days at which the live quantile gets half the weight
M_MIN, M_MAX = 0.80, 1.40
MIN_SPECIFIC = 120        # graded days before a region-specific cell is used


def day_bucket(k):
    """Days ahead grouped so each bucket fills: 1, 2-3, 4-6, 7-10."""
    return '1' if k == 1 else '2-3' if k <= 3 else '4-6' if k <= 6 else '7-10'


def cell_keys(region, tier, k, earn, source='trail'):
    fam = 'earn' if earn else 'ord'
    b = day_bucket(k)
    suffix = ':blend' if source == 'blend' else ''
    return f'{region}:{tier}:{b}:{fam}{suffix}', f'ALL:{tier}:{b}:{fam}{suffix}'


def quantile(xs, q):
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(math.ceil(q * len(s))) - 1))
    return s[i]


def main():
    today = datetime.date.today()
    since = (today - datetime.timedelta(days=WINDOW_DAYS)).isoformat()
    cells = {}
    rows = 0
    for r in ledger_store.iter_rows():
        fb = r.get('forecastBand') or {}
        anc = fb.get('anchor') or {}
        xs = fb.get('x')
        if not xs or (anc.get('session') or '') < since or not fb.get('calibrated'):
            continue
        rows += 1
        tier = fb.get('volTier') or '?'
        eday = fb.get('earningsDay')
        for k, x in enumerate(xs, start=1):
            if not isinstance(x, (int, float)):
                continue
            earn = bool(eday) and k >= eday
            for key in cell_keys(r.get('region') or '?', tier, k, earn, fb.get('sigmaSource') or 'trail'):
                cells.setdefault(key, []).append(float(x))
    out = {}
    for key, xs in sorted(cells.items()):
        n = len(xs)
        cov = sum(1 for x in xs if x <= 1.0) / n
        q = quantile(xs, TARGET)
        w = n / (n + SHRINK_N)
        m = max(M_MIN, min(M_MAX, 1.0 + w * (q - 1.0)))
        out[key] = {'n': n, 'coverage': round(cov, 4), 'q80': round(q, 4), 'm': round(m, 4)}
    payload = {
        'generatedAt': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'target': TARGET, 'windowDays': WINDOW_DAYS, 'since': since, 'rows': rows,
        'shrinkN': SHRINK_N, 'minSpecific': MIN_SPECIFIC, 'mRange': [M_MIN, M_MAX],
        'cells': out,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)
    total = sum(v['n'] for k, v in out.items() if k.startswith('ALL:'))
    held = sum(v['n'] * v['coverage'] for k, v in out.items() if k.startswith('ALL:'))
    print(f'Wrote {OUT}: {len(out)} cells from {rows} rows; '
          f'{total} graded band days, {held / total * 100:.1f}% held' if total else
          f'Wrote {OUT}: no graded band days yet (the record starts with bands built since 2026-10-13)')


if __name__ == '__main__':
    main()
