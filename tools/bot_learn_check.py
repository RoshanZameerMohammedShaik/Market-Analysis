"""Assert the desk's learner learns real signal and refuses noise.

The dangerous failure here is not "it fails to learn". It is "it learns something that was
never there", which is how this project previously believed in 71.6% accuracy and a
mean-reversion tilt that lived only in leaked data. At the desk's rails a sleeve closes maybe
one or two round trips a day, so almost every real sample will be small and noisy.

So the load-bearing tests are the negative ones: fed pure random returns, the learner must
barely move the book, and fed a handful of observations it must not move it at all.

Run: python tools/bot_learn_check.py
"""
import os
import random
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.learn import (  # noqa: E402
    MAX_CAPITAL_TILT, MAX_ENTRY_SHIFT, MIN_ROUND_TRIPS, belief, capital_weights,
    deflated_threshold, describe, entry_shift, round_trips,
)
from bot.strategies import ControlStrategy, EngineStrategy, ReversionStrategy, build  # noqa: E402
from bot.dynamic import ENTRY_PCTILE, OVERSOLD_PCTILE  # noqa: E402
from bot.config import load_config  # noqa: E402

PASS, FAIL = [], []


def ck(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}"
          + (f'  -> {detail}' if detail and not cond else ''))


def fill(action, sleeve, symbol, units, px, ts, commission=0.35, regulatory=0.0):
    return {'action': action, 'sleeve': sleeve, 'symbol': symbol, 'units': units,
            'fillPriceUSD': px, 'ts': ts, 'commissionUSD': commission,
            'regulatoryUSD': regulatory, 'spreadCostUSD': 9.99,
            'evidence': {'rule': f'{sleeve}-entry'}, 'conviction': 0.7,
            'market': 'CRYPTO', 'strategy': f'{sleeve}-entry'}


print('=== reconstructing round trips ===')
rt = round_trips([
    fill('BUY', 'engine', 'AAA', 10, 100.0, '2026-01-01T00:00:00Z'),
    fill('SELL', 'engine', 'AAA', 10, 110.0, '2026-01-01T02:00:00Z'),
])
ck('one buy and one sell make one round trip', len(rt) == 1, str(len(rt)))
# 10 units x $10 gain = $100 gross, minus $0.35 buy + $0.35 sell commission.
ck('net is gross minus explicit commissions only',
   abs(rt[0]['netUSD'] - (100.0 - 0.70)) < 1e-6, str(rt[0]['netUSD']))
# The dominant cost is ALREADY inside fillPriceUSD, because fills cross the spread.
# spreadCostUSD is reporting-only, and subtracting it again would double-charge it.
ck('the spread is NOT double-counted', rt[0]['netUSD'] > 99.0, str(rt[0]['netUSD']))
ck('return is measured against capital committed',
   abs(rt[0]['netPct'] - (99.30 / 1000.0 * 100)) < 1e-4, str(rt[0]['netPct']))
ck('hold time is recorded', rt[0]['holdMinutes'] == 120.0, str(rt[0]['holdMinutes']))
ck('entry evidence survives to the round trip',
   rt[0]['entryEvidence'].get('rule') == 'engine-entry', str(rt[0]['entryEvidence']))

# FIFO across two lots at different prices, sold in one go.
rt2 = round_trips([
    fill('BUY', 'engine', 'BBB', 5, 100.0, '2026-01-01T00:00:00Z'),
    fill('BUY', 'engine', 'BBB', 5, 200.0, '2026-01-01T01:00:00Z'),
    fill('SELL', 'engine', 'BBB', 10, 150.0, '2026-01-01T03:00:00Z'),
])
ck('a sell spanning two lots produces two round trips', len(rt2) == 2, str(len(rt2)))
ck('FIFO consumes the oldest lot first',
   rt2[0]['entryPx'] == 100.0 and rt2[1]['entryPx'] == 200.0,
   f"{rt2[0]['entryPx']}, {rt2[1]['entryPx']}")
ck('the two legs net out to roughly zero',
   abs(sum(r['netUSD'] for r in rt2)) < 1.5, str(sum(r['netUSD'] for r in rt2)))
ck('a sell with no matching buy is ignored rather than invented',
   round_trips([fill('SELL', 'engine', 'ZZZ', 1, 10.0, '2026-01-01T00:00:00Z')]) == [])
ck('an open position produces no round trip',
   round_trips([fill('BUY', 'engine', 'CCC', 1, 10.0, '2026-01-01T00:00:00Z')]) == [])

print()
print('=== the deflated bar rises with the number of things examined ===')
ck('more trials means a higher bar', deflated_threshold(20) > deflated_threshold(3),
   f'{deflated_threshold(20):.2f} vs {deflated_threshold(3):.2f}')
ck('a single trial still requires real evidence', deflated_threshold(1) >= 2.0)

print()
print('=== a small sample must move NOTHING, however good it looks ===')
# Five trades, every one a winner, huge t. A naive learner would go all-in on this.
tiny = describe([5.0, 4.0, 6.0, 5.5, 4.5])
w, why = belief(tiny, 3)
ck('five straight winners is still not enough to act', w == 0.0, f'{w} ({why})')
ck('the refusal says it was the sample size', 'round trips' in why, why)
ck('MIN_ROUND_TRIPS is the gate', tiny['n'] < MIN_ROUND_TRIPS)
zero_var = describe([1.0] * 30)
ck('a zero-variance sample cannot form a t and does not act',
   belief(zero_var, 3)[0] == 0.0, str(belief(zero_var, 3)))

print()
print('=== pure noise must not move the book meaningfully ===')
random.seed(7)
# TWO sleeves, both fed pure noise. One sleeve would be meaningless here: capital_weights
# normalises a single sleeve to 1.0 by construction, so the deviation would be 0.0000 no
# matter how badly the learner behaved, and the test would pass for the wrong reason.
tilts, acted = [], 0
for _ in range(400):
    a = describe([random.gauss(0.0, 2.0) for _ in range(60)])
    b = describe([random.gauss(0.0, 2.0) for _ in range(60)])
    wa, _ = belief(a, 3)
    wb, _ = belief(b, 3)
    acted += (wa > 0) + (wb > 0)
    per = {'a': {'stats': {'mean': a['mean']}, 'belief': wa},
           'b': {'stats': {'mean': b['mean']}, 'belief': wb}}
    w = capital_weights(per, ['a', 'b'])
    # Deviation from the 50/50 a no-information learner should hold.
    tilts.append(abs(w['a'] - 0.5))
worst = max(tilts)
mean_tilt = sum(tilts) / len(tilts)
# Some false positives are unavoidable at any finite threshold; what matters is that
# shrinkage keeps their EFFECT small rather than that they never occur.
print(f'    acted on {acted}/800 noise samples; worst 50/50 deviation {worst:.4f}, '
      f'mean {mean_tilt:.5f}')
ck('noise rarely clears the bar at all', acted < 120, f'{acted}/800')
ck('a no-information learner stays near equal weight on average', mean_tilt < 0.01,
   f'{mean_tilt:.5f}')
ck('even the worst noise draw cannot swing the book',
   worst < MAX_CAPITAL_TILT / 2, f'{worst:.4f} vs bound {MAX_CAPITAL_TILT / 2}')

print()
print('=== a genuinely strong signal IS learned ===')
random.seed(11)
strong = describe([random.gauss(3.0, 1.0) for _ in range(80)])
w, why = belief(strong, 3)
ck('a large consistent edge clears the bar', w > 0, f'{w} ({why})')
ck('belief is capped at 1', w <= 1.0, str(w))
loser = describe([random.gauss(-3.0, 1.0) for _ in range(80)])
wl, _ = belief(loser, 3)
per = {'win': {'stats': {'mean': strong['mean']}, 'belief': w},
       'lose': {'stats': {'mean': loser['mean']}, 'belief': wl}}
weights = capital_weights(per, ['win', 'lose'])
ck('the winner is allocated more than the loser', weights['win'] > weights['lose'],
   str(weights))
ck('weights still sum to 1', abs(sum(weights.values()) - 1.0) < 1e-9, str(weights))
ck('no weight exceeds the tilt bound',
   max(weights.values()) <= 0.5 * (1 + MAX_CAPITAL_TILT) / (1 - MAX_CAPITAL_TILT / 2) + 0.01,
   str(weights))

print()
print('=== selectivity moves the right way, and only so far ===')
sh_loser = entry_shift(per, 'lose')
sh_winner = entry_shift(per, 'win')
ck('a losing sleeve is told to be FUSSIER (positive shift)', sh_loser > 0, str(sh_loser))
ck('a winning sleeve may act slightly earlier', sh_winner < 0, str(sh_winner))
ck('the shift is bounded', abs(sh_loser) <= MAX_ENTRY_SHIFT + 1e-9, str(sh_loser))
ck('no belief means no shift', entry_shift({'x': {'stats': {'mean': -5}, 'belief': 0}}, 'x') == 0.0)

print()
print('=== the shift is applied in the correct direction per strategy ===')
cfg = load_config()
eng = EngineStrategy(cfg, 0.05)
ck('fussier raises the engine entry percentile', eng.entry_p() > ENTRY_PCTILE,
   f'{eng.entry_p()} vs {ENTRY_PCTILE}')
rev = ReversionStrategy(cfg, 0.05)
# Reversion buys the LOW tail, so being fussier means a LOWER percentile. Applying the shift
# in the same direction as the engine's would make a losing reversion sleeve less selective.
ck('fussier LOWERS the oversold percentile', rev.oversold_p() < OVERSOLD_PCTILE,
   f'{rev.oversold_p()} vs {OVERSOLD_PCTILE}')
ck('percentiles stay inside sane limits',
   0.5 <= EngineStrategy(cfg, 99.0).entry_p() <= 0.99
   and 0.01 <= ReversionStrategy(cfg, 99.0).oversold_p() <= 0.49)

print()
print('=== the benchmark never adapts ===')
learned = {'perSleeve': {
    'engine': {'entryPctileShift': 0.04},
    'control': {'entryPctileShift': 0.04},   # even if the learner wrongly emitted one
}}
built = build(cfg, llm=None, learned=learned)
ck('the engine receives its shift', abs(built['engine'].pctile_shift - 0.04) < 1e-9)
ck('the control sleeve is hard-wired to zero regardless',
   built['control'].pctile_shift == 0.0, str(built['control'].pctile_shift))
ck('a missing learned file leaves every sleeve unshifted',
   all(st.pctile_shift == 0.0 for st in build(cfg, llm=None, learned=None).values()))

print()
print(f"{'BOT LEARN CHECK PASS' if not FAIL else 'BOT LEARN CHECK FAIL'}: "
      f'{len(PASS)} passed, {len(FAIL)} failed')
if FAIL and os.environ.get('GITHUB_ACTIONS'):
    print(f"::error title=bot_learn_check::{'; '.join(FAIL[:6])}")
sys.exit(1 if FAIL else 0)
