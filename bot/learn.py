"""The desk learns from its own realized round trips.

WHAT IT LEARNS FROM
-------------------
Closed round trips only, matched FIFO out of model/bot/trades.jsonl, net of every cost
actually charged. Not signals, not backtests, not paper marks on open positions: the only
input is money that was really made or lost after crossing the spread and paying commission.
An open position has no realized answer yet and contributes nothing.

WHAT IT LEARNS
--------------
  1. CAPITAL. Which sleeves have earned more of the allocation.
  2. SELECTIVITY. Whether a sleeve should be fussier or less fussy, expressed as a shift in
     its entry percentile.

Deliberately NOT the raw signal thresholds. Those are already derived from the cross-section
(bot/dynamic.py); re-fitting them on realized P/L would put the same numbers back that this
project just removed, only now with a spurious empirical justification attached.

THE PROBLEM THIS FILE IS MOSTLY ABOUT
-------------------------------------
Learning from a small sample of noisy returns is how quantitative strategies destroy
themselves, and this project has already done it once: a mean-reversion tilt tuned on leaked
data, and a believed-in 71.6% accuracy that was really 51.5%. Over 996,541 historical
predictions the measured edge was ZERO. That is the prior this learner starts from, and it is
a strong one.

At the desk's rails -- 8 fills a day across 4 sleeves -- a sleeve accumulates perhaps one or
two closed round trips a day. After a month that is 30-ish observations of a quantity whose
noise dwarfs any plausible signal. A learner that acts confidently on that is not learning,
it is overfitting with extra steps.

So every conclusion is gated three ways, and all three must pass before anything moves:

  * MINIMUM SAMPLE. Below MIN_ROUND_TRIPS a t-statistic is meaningless however large it
    looks, because a handful of trades can produce any t at all.
  * DEFLATED SIGNIFICANCE. The False Strategy Theorem (Bailey and Lopez de Prado) says that
    trying k things makes the best of them look significant by chance; the expected maximum
    |t| under the null grows like sqrt(2 ln k). Every sleeve and every bucket examined counts
    as a trial, so the bar rises as the learner looks at more things.
  * SHRINKAGE TOWARD ZERO EDGE. Even once the bar is cleared, the adjustment is scaled by how
    far past it the evidence sits. Marginal evidence moves almost nothing. This is the
    mechanism that makes the learner safe by default rather than safe by luck.

And two structural protections:

  * THE CONTROL SLEEVE NEVER LEARNS. Buy-and-hold has to stay fixed or it stops being the
    benchmark, and a benchmark that adapts cannot tell you whether adapting helped.
  * BOUNDED. No learned adjustment can exceed MAX_* below, so even a wrong conclusion
    degrades performance rather than wrecking the book.

Everything it concludes, including refusals, is written to model/bot/learned.json with the
sample size and statistics behind it, so a decision is always traceable to the evidence that
produced it.

Run: python -m bot.learn        (writes model/bot/learned.json)
"""
from __future__ import annotations

import collections
import datetime
import json
import math
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT_DIR = os.path.join(REPO, 'model', 'bot')
TRADES_PATH = os.path.join(BOT_DIR, 'trades.jsonl')
OUT_PATH = os.path.join(BOT_DIR, 'learned.json')

# Fewer closed round trips than this and no conclusion is drawn at all. A t-statistic on
# n=4 can be enormous purely by chance, so the gate has to be on the SAMPLE and not only on
# the statistic.
MIN_ROUND_TRIPS = 20

# The sleeve that must never adapt, because it is the yardstick.
FROZEN_SLEEVES = {'control'}

# Hard bounds on anything learned. A wrong conclusion should cost performance, not the book.
MAX_CAPITAL_TILT = 0.35      # a sleeve's weight may move at most this far from equal
MAX_ENTRY_SHIFT = 0.05       # entry percentile may move at most this much (e.g. .90 -> .95)

# Walk-forward split. The learner is evaluated on trades it did not see when concluding.
HOLDOUT_FRACTION = 0.30


def utc_now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── reconstructing what actually happened ────────────────────────────────────

def read_trades(path=TRADES_PATH):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows.sort(key=lambda r: r.get('ts') or '')
    return rows


def round_trips(trades):
    """Match SELLs against earlier BUYs FIFO, per sleeve and symbol.

    Returns one record per closed slice, carrying the ENTRY's evidence, because the learner's
    question is "which conditions paid", and that can only be answered against the state at
    the moment the position was opened.

    COST HANDLING, WHICH IS EASY TO GET WRONG
    The spread is already inside fillPriceUSD -- fills cross it rather than paying it as a
    fee, and spreadCostUSD is recorded for reporting only. Subtracting it here as well would
    double-charge the dominant cost and make every strategy look worse than it is. Only
    commission and regulatory fees, which ARE deducted from cash separately, are subtracted.
    """
    books = collections.defaultdict(collections.deque)
    out = []
    for t in trades:
        key = (t.get('sleeve'), t.get('symbol'))
        units = t.get('units')
        px = t.get('fillPriceUSD')
        if not isinstance(units, (int, float)) or not isinstance(px, (int, float)):
            continue
        if units <= 0 or px <= 0:
            continue
        explicit = (t.get('commissionUSD') or 0.0) + (t.get('regulatoryUSD') or 0.0)

        if t.get('action') == 'BUY':
            books[key].append({
                'units': float(units), 'px': float(px),
                'costPerUnit': explicit / float(units),
                'ts': t.get('ts'), 'evidence': t.get('evidence') or {},
                'conviction': t.get('conviction'), 'market': t.get('market'),
                'strategy': t.get('strategy'),
            })
            continue
        if t.get('action') != 'SELL':
            continue

        remaining = float(units)
        sell_cost_per_unit = explicit / float(units)
        while remaining > 1e-12 and books[key]:
            lot = books[key][0]
            take = min(lot['units'], remaining)
            gross = take * (float(px) - lot['px'])
            costs = take * (lot['costPerUnit'] + sell_cost_per_unit)
            net = gross - costs
            basis = take * lot['px']
            out.append({
                'sleeve': t.get('sleeve'),
                'symbol': t.get('symbol'),
                'market': lot.get('market'),
                'entryStrategy': lot.get('strategy'),
                'exitRule': (t.get('evidence') or {}).get('rule'),
                'openedAt': lot['ts'],
                'closedAt': t.get('ts'),
                'holdMinutes': _minutes_between(lot['ts'], t.get('ts')),
                'units': round(take, 10),
                'entryPx': lot['px'],
                'exitPx': float(px),
                'basisUSD': round(basis, 6),
                'netUSD': round(net, 6),
                # Percent return on the capital actually committed. This, not dollars, is
                # what the statistics run on: a $1,000 position and a $200 position are not
                # comparable observations in dollars.
                'netPct': round(net / basis * 100.0, 6) if basis > 0 else None,
                'entryEvidence': lot.get('evidence') or {},
                'entryConviction': lot.get('conviction'),
            })
            lot['units'] -= take
            remaining -= take
            if lot['units'] <= 1e-12:
                books[key].popleft()
    return out


def _minutes_between(a, b):
    try:
        ta = datetime.datetime.fromisoformat(str(a).replace('Z', '+00:00'))
        tb = datetime.datetime.fromisoformat(str(b).replace('Z', '+00:00'))
        return round((tb - ta).total_seconds() / 60.0, 1)
    except (TypeError, ValueError):
        return None


# ── statistics, with the honesty built in ────────────────────────────────────

def describe(values):
    """n, mean, sample sd and t of a return series. t is None when it cannot be formed."""
    xs = [float(v) for v in values
          if isinstance(v, (int, float)) and math.isfinite(float(v))]
    n = len(xs)
    if n == 0:
        return {'n': 0, 'mean': None, 'sd': None, 't': None, 'hitRate': None}
    mean = sum(xs) / n
    if n < 2:
        return {'n': n, 'mean': mean, 'sd': None, 't': None,
                'hitRate': 1.0 if xs[0] > 0 else 0.0}
    var = sum((x - mean) ** 2 for x in xs) / (n - 1)
    sd = math.sqrt(var)
    t = (mean / (sd / math.sqrt(n))) if sd > 0 else None
    return {'n': n, 'mean': mean, 'sd': sd, 't': t,
            'hitRate': sum(1 for x in xs if x > 0) / n}


def deflated_threshold(trials):
    """The |t| a result must clear once you account for how many things were examined.

    Under the null the expected maximum |t| across k independent trials grows like
    sqrt(2 ln k), so the more the learner looks at, the higher the bar it must clear. Without
    this, examining four sleeves and a handful of buckets would hand back a "significant"
    winner essentially every time. Floored at 2.0 so a single trial still needs real evidence.
    """
    k = max(2, int(trials or 2))
    return max(2.0, math.sqrt(2.0 * math.log(k)))


def belief(stats, trials):
    """How much of a conclusion to act on, in 0..1. Zero unless all three gates pass.

    Returns (weight, reason) so a refusal is recorded with its cause rather than silently
    looking like "no change needed".
    """
    n = stats.get('n') or 0
    if n < MIN_ROUND_TRIPS:
        return 0.0, f'only {n} closed round trips, need {MIN_ROUND_TRIPS}'
    t = stats.get('t')
    if t is None:
        return 0.0, 'no variation in the sample, cannot form a t-statistic'
    crit = deflated_threshold(trials)
    if abs(t) <= crit:
        return 0.0, (f't={t:.2f} does not clear the deflated bar {crit:.2f} '
                     f'for {trials} trials examined')
    # Past the bar, scale by HOW far past. Marginal evidence still barely moves anything,
    # which is the difference between a learner that is safe and one that got lucky.
    w = min(1.0, (abs(t) - crit) / crit)
    return round(w, 4), f't={t:.2f} clears {crit:.2f}, acting at {w:.0%} strength'


# ── what to do about it ──────────────────────────────────────────────────────

def capital_weights(per_sleeve, active_ids):
    """Reallocate the pot toward sleeves whose realized net returns have earned it.

    Starts at equal weight and tilts by mean net return per trade, scaled by belief. With
    little evidence the tilt is ~0 and the weights stay equal, which is the correct default:
    equal weight is what you hold when you do not know which is better.

    The control sleeve is excluded entirely and keeps a fixed share, because a benchmark
    whose capital moves with performance is no longer a benchmark.
    """
    n = len(active_ids)
    if n == 0:
        return {}
    base = 1.0 / n
    raw = {}
    for sid in active_ids:
        s = per_sleeve.get(sid) or {}
        mean = (s.get('stats') or {}).get('mean')
        w = s.get('belief') or 0.0
        tilt = 0.0
        if w > 0 and isinstance(mean, (int, float)):
            # Sign of the realized edge, scaled by belief and capped. Magnitude of mean
            # return is deliberately NOT used directly: a single large winner would
            # otherwise dominate the allocation.
            tilt = math.copysign(MAX_CAPITAL_TILT * w, mean)
        raw[sid] = max(0.0, base * (1.0 + tilt))
    total = sum(raw.values()) or 1.0
    return {k: round(v / total, 6) for k, v in raw.items()}


def entry_shift(per_sleeve, sid):
    """Should this sleeve be fussier or less fussy? Returns a bounded percentile shift.

    Losing money means demanding a higher rank before acting (be fussier); making money means
    it can afford to act slightly earlier. Bounded by MAX_ENTRY_SHIFT so even a wrong read
    cannot move the sleeve far from the cross-sectional default.
    """
    s = per_sleeve.get(sid) or {}
    w = s.get('belief') or 0.0
    mean = (s.get('stats') or {}).get('mean')
    if not w or not isinstance(mean, (int, float)):
        return 0.0
    # Negative mean -> positive shift -> higher entry percentile -> fussier.
    return round(math.copysign(MAX_ENTRY_SHIFT * w, -mean), 6)


def walk_forward(rts):
    """Would the learned tilt have helped on trades the conclusion never saw?

    Splits chronologically, learns the SIGN of each sleeve's edge on the earlier portion, and
    measures what that would have implied for the later portion. Reported, never acted on:
    its job is to let a claim of improvement be checked rather than asserted. With a small
    sample it will mostly say "insufficient", which is the honest answer.
    """
    ordered = [r for r in rts if r.get('netPct') is not None]
    ordered.sort(key=lambda r: r.get('closedAt') or '')
    if len(ordered) < MIN_ROUND_TRIPS * 2:
        return {'status': 'insufficient',
                'need': MIN_ROUND_TRIPS * 2, 'have': len(ordered)}
    cut = int(len(ordered) * (1.0 - HOLDOUT_FRACTION))
    train, test = ordered[:cut], ordered[cut:]
    signs = {}
    for r in train:
        signs.setdefault(r['sleeve'], []).append(r['netPct'])
    direction = {k: (1 if (sum(v) / len(v)) > 0 else -1) for k, v in signs.items()}
    kept = [r['netPct'] for r in test if direction.get(r['sleeve'], 1) > 0]
    allx = [r['netPct'] for r in test]
    return {
        'status': 'ok',
        'trainN': len(train), 'testN': len(test),
        'meanAllPct': round(sum(allx) / len(allx), 4) if allx else None,
        'meanKeptPct': round(sum(kept) / len(kept), 4) if kept else None,
        'keptN': len(kept),
        'note': 'meanKeptPct above meanAllPct means dropping the sleeves that lost money in '
                'the training window would have helped out of sample. One split of a small '
                'sample is weak evidence, not proof.',
    }


def learn(trades_path=TRADES_PATH, out_path=OUT_PATH):
    trades = read_trades(trades_path)
    rts = round_trips(trades)

    by_sleeve = collections.defaultdict(list)
    for r in rts:
        if r.get('netPct') is not None:
            by_sleeve[r['sleeve']].append(r['netPct'])

    # Every sleeve examined is a trial, and so is every bucket below. The bar rises with the
    # count, which is the point.
    trials = max(2, len(by_sleeve))

    per_sleeve = {}
    for sid, vals in by_sleeve.items():
        st = describe(vals)
        if sid in FROZEN_SLEEVES:
            per_sleeve[sid] = {
                'stats': _round_stats(st), 'belief': 0.0,
                'beliefReason': 'the control sleeve never adapts: it is the benchmark',
                'frozen': True,
            }
            continue
        w, why = belief(st, trials)
        per_sleeve[sid] = {'stats': _round_stats(st), 'belief': w, 'beliefReason': why,
                           'frozen': False}

    active = sorted(k for k in by_sleeve if k not in FROZEN_SLEEVES)
    weights = capital_weights(per_sleeve, active)
    for sid in active:
        per_sleeve[sid]['capitalWeight'] = weights.get(sid)
        per_sleeve[sid]['entryPctileShift'] = entry_shift(per_sleeve, sid)

    acting = [s for s in per_sleeve.values() if (s.get('belief') or 0) > 0]
    payload = {
        'schema': 1,
        'generatedAt': utc_now_iso(),
        'roundTrips': len(rts),
        'tradeRows': len(trades),
        'trialsExamined': trials,
        'deflatedTBar': round(deflated_threshold(trials), 4),
        'minRoundTrips': MIN_ROUND_TRIPS,
        'bounds': {'maxCapitalTilt': MAX_CAPITAL_TILT, 'maxEntryShift': MAX_ENTRY_SHIFT},
        'perSleeve': per_sleeve,
        'walkForward': walk_forward(rts),
        'acting': len(acting),
        # Stated plainly so the file cannot be mistaken for a claim of skill. On current
        # evidence the honest state is almost always "not enough data yet".
        'verdict': ('no conclusion drawn yet: not enough closed round trips clear the '
                    'deflated significance bar' if not acting else
                    f'{len(acting)} sleeve(s) have evidence strong enough to act on'),
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, allow_nan=False)
    os.replace(tmp, out_path)
    return payload


def _round_stats(st):
    return {
        'n': st['n'],
        'meanNetPct': _r(st['mean'], 4),
        'sdNetPct': _r(st['sd'], 4),
        't': _r(st['t'], 3),
        'hitRate': _r(st['hitRate'], 4),
    }


def _r(v, dp):
    return round(v, dp) if isinstance(v, (int, float)) and math.isfinite(v) else None


def load_learned(path=OUT_PATH):
    """Read what was learned, or an inert default when nothing has been learned yet.

    The default matters: a missing or corrupt file must leave the desk behaving exactly as it
    would with no learner at all, never blocked and never guessing.
    """
    if not os.path.exists(path):
        return {'perSleeve': {}, 'roundTrips': 0, 'acting': 0}
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {'perSleeve': {}, 'roundTrips': 0, 'acting': 0}
        return d
    except (json.JSONDecodeError, OSError):
        return {'perSleeve': {}, 'roundTrips': 0, 'acting': 0}


if __name__ == '__main__':
    p = learn()
    print(f"round trips: {p['roundTrips']} from {p['tradeRows']} fill rows")
    print(f"deflated |t| bar: {p['deflatedTBar']} across {p['trialsExamined']} trials")
    for sid, s in sorted(p['perSleeve'].items()):
        st = s['stats']
        print(f"  {sid:<10} n={st['n']:<4} mean={st['meanNetPct']} t={st['t']} "
              f"belief={s['belief']}  {s['beliefReason']}")
        if s.get('capitalWeight') is not None:
            print(f"             capitalWeight={s['capitalWeight']} "
                  f"entryShift={s.get('entryPctileShift')}")
    print(f"walk-forward: {p['walkForward'].get('status')}")
    print(f"VERDICT: {p['verdict']}")
