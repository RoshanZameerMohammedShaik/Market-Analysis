"""Assert the desk's thresholds are DERIVED, not typed in.

Every entry and exit level used to be a constant in config.json. The point of
bot/dynamic.py is that the same absolute reading means different things in different
markets, so the test that matters most here is one a fixed threshold cannot pass: the SAME
engine score has to be a buy in a weak tape and not a buy in a strong one.

Run: python tools/bot_dynamic_check.py
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.dynamic import (  # noqa: E402
    ENTRY_PCTILE, CrossSection, exit_levels, exposure_scale, is_tradeable,
    percentile, risk_parity_size_usd,
)
from trading_costs import round_trip_cost_pct  # noqa: E402

PASS, FAIL = [], []


def ck(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}"
          + (f'  -> {detail}' if detail and not cond else ''))


def universe(base_score, base_rsi, base_ai, n=20):
    return {f'S{i}': {'symbol': f'S{i}', 'score': base_score + i, 'price': 10.0,
                      'indicators': {'rsi': base_rsi + i, 'atrPct': 2.0},
                      'ai': {'probability': base_ai + i / 100.0}}
            for i in range(n)}


print('=== percentile ===')
ck('p50 of 1..9 is 5', percentile(range(1, 10), 0.5) == 5)
ck('non-numeric values are ignored', percentile([1, None, float('nan'), 3], 0.5) == 2)
ck('empty input is None', percentile([], 0.5) is None)

print()
print('=== the same score means different things in different markets ===')
weak = CrossSection(universe(30, 20, 0.30))
strong = CrossSection(universe(60, 50, 0.60))
ck('a weak tape sets a lower entry bar',
   weak.cut('score', ENTRY_PCTILE) < strong.cut('score', ENTRY_PCTILE),
   f"{weak.cut('score', ENTRY_PCTILE)} vs {strong.cut('score', ENTRY_PCTILE)}")
# THE test. A fixed "score >= 62" cannot distinguish these two cases at all, which is
# exactly why it was the wrong shape of rule.
ck('score 62 IS top-decile in the weak tape', 62 >= weak.cut('score', ENTRY_PCTILE))
ck('score 62 is NOT top-decile in the strong tape',
   62 < strong.cut('score', ENTRY_PCTILE), f"cut {strong.cut('score', ENTRY_PCTILE)}")
ck('a thin universe refuses to rank',
   CrossSection(universe(30, 20, 0.3, n=5)).rankable is False)
ck('breadth is the median score', abs(weak.breadth() - 39.5) < 0.6, str(weak.breadth()))
ck('the summary records the cuts actually used',
   set(weak.summary()) >= {'scoreP90', 'rsiP10', 'breadthMedianScore', 'symbols'})

print()
print('=== exits scale with the instrument, not a flat percentage ===')
calm = {'price': 100, 'indicators': {'atrPct': 1.0},
        'band': {'calibrated': True, 'tier': 'calm', 'confidence': 80,
                 'day1': {'low': 98, 'high': 102}}}
wild = {'price': 100, 'indicators': {'atrPct': 6.0},
        'band': {'calibrated': True, 'tier': 'active', 'confidence': 80,
                 'day1': {'low': 88, 'high': 112}}}
tc, sc, _ = exit_levels(calm, 100.0)
tw, sw, _ = exit_levels(wild, 100.0)
ck('a calm name gets a tight target', abs(tc - 102) < 0.01, str(tc))
ck('a volatile name gets a wider target', tw > tc and abs(tw - 112) < 0.01, str(tw))
ck('stops differ by volatility too', sw < sc, f'{sw} vs {sc}')
# A stop anchored on the live price would ratchet upward as the price rose, so the position
# could never show a loss. It has to be fixed relative to what was paid.
ck('levels anchor on COST, not on current price',
   abs(exit_levels(calm, 50.0)[0] - 51.0) < 0.01, str(exit_levels(calm, 50.0)[0]))
ck('no band falls back to ATR',
   exit_levels({'price': 100, 'indicators': {'atrPct': 3.0}}, 100.0)[2]['source'] == 'atr')
ck('no band and no ATR invents no level', exit_levels({'price': 100}, 100.0)[0] is None)
ck('a degenerate band is rejected',
   exit_levels({'price': 100, 'band': {'day1': {'low': 101, 'high': 102}}}, 100.0)[0] is None)

print()
print('=== size by risk, not by notional ===')
lo = risk_parity_size_usd(10000, 8, 1.0, 12.0)
hi = risk_parity_size_usd(10000, 8, 6.0, 12.0)
ck('a low-vol name gets a bigger notional', lo > hi, f'{lo:.0f} vs {hi:.0f}')
ck('6x the volatility is ~1/6 the size', abs(lo / hi - 6) < 0.1, f'ratio {lo / hi:.2f}')
ck('an unmeasurable name does NOT get the largest bite',
   risk_parity_size_usd(10000, 8, None, 12.0) == 1250)
ck('a suspiciously calm name is floored',
   risk_parity_size_usd(10000, 8, 0.0001, 12.0) <= 10000 * 0.12 / 8 / 0.0025 + 1)
ck('zero equity sizes nothing', risk_parity_size_usd(0, 8, 2.0, 12.0) == 0.0)

print()
print('=== breadth throttle: ranking alone is always fully invested ===')
hist = list(range(40, 60))
ck('the worst breadth on record shrinks exposure', exposure_scale(39, hist) < 0.3,
   str(exposure_scale(39, hist)))
ck('the best breadth on record is full size', exposure_scale(61, hist) == 1.0)
ck('no history means full size, not paralysis', exposure_scale(50, []) == 1.0)
ck('too little history means full size', exposure_scale(50, [1, 2, 3]) == 1.0)

print()
print('=== a name must be able to pay for its own round trip ===')
# Sub-penny: roughly a 5% half-spread each side, so it needs a large expected move to earn
# a place in the universe at all.
cheap = {'symbol': 'X-USD', 'entry': 0.004,
         'forecastBand': {'days': [{'day': 1, 'widthPct': 1.0}]}}
ck('a wide-spread name with a small expected move is refused',
   is_tradeable(cheap, round_trip_cost_pct)[0] is False,
   str(is_tradeable(cheap, round_trip_cost_pct)))
rich = {'symbol': 'BTC-USD', 'entry': 78000.0,
        'forecastBand': {'days': [{'day': 1, 'widthPct': 4.0}]}}
# The old maxPriceUSD 2000 excluded BTC outright, which was never a real constraint: the
# desk trades fractional units.
ck('a four-figure price is NOT excluded',
   is_tradeable(rich, round_trip_cost_pct)[0] is True,
   str(is_tradeable(rich, round_trip_cost_pct)))
ck('a name with no band yet is admitted rather than frozen out',
   is_tradeable({'symbol': 'NEW', 'entry': 25.0}, round_trip_cost_pct)[0] is True)
ck('no price means no trade', is_tradeable({'symbol': 'Z'}, round_trip_cost_pct)[0] is False)
# The band's width is a volatility interval, not a directional forecast. Calling the ratio
# an "edge" would repeat the mislabelling that produced a believed-in 71.6% accuracy.
ck('the ratio is not called an edge',
   'moveToCostRatio' in (is_tradeable(rich, round_trip_cost_pct)[2] or {}),
   str(is_tradeable(rich, round_trip_cost_pct)[2]))

print()
print('=== a stop must never be tighter than its own round trip ===')
# GOAT-USD reported atrPct 0.02, so a 1x ATR stop sat 0.02% below cost and fired on the first
# tick. It was stopped out TWICE for a combined -$4.17 on a name that had moved -0.35%. A stop
# inside the execution cost guarantees a loss on noise alone.
from bot.dynamic import MIN_CREDIBLE_ATR_PCT, EXIT_PCTILE  # noqa: E402
hair = {'price': 5.0963, 'indicators': {'atrPct': 0.02}}
tp_h, sl_h, ev_h = exit_levels(hair, 5.0963)
ck('an implausible ATR sets no level at all', tp_h is None and sl_h is None, str(ev_h))
ck('and it says why', 'credible' in str(ev_h.get('reason', '')), str(ev_h))
ck('the floor is at least a realistic round trip', MIN_CREDIBLE_ATR_PCT >= 0.2,
   str(MIN_CREDIBLE_ATR_PCT))
real = {'price': 100, 'indicators': {'atrPct': 5.58}}
tp_r, sl_r, ev_r = exit_levels(real, 100.0)
ck('a credible ATR still produces levels', tp_r is not None and sl_r is not None)
ck('and the stop is wider than any plausible round trip', (100.0 - sl_r) / 100.0 > 0.01,
   f'stop {sl_r:.2f} is {(100.0 - sl_r):.2f}% below cost')

print('')
print('=== the exit line is not the median ===')
# Scores span ~21 points and 9 of 41 names sat within 1 point of the median, so a sub-1-point
# move flipped ~22% of the universe across a p50 exit. AVAX was sold at 53.5 against a median
# of 53.5; CAKE was sold on a one-point AI margin for -$11.19.
ck('exiting is stricter than the median', EXIT_PCTILE < 0.5, str(EXIT_PCTILE))
ck('but not so strict it never releases', EXIT_PCTILE >= 0.2, str(EXIT_PCTILE))
ck('there is a real hold band between entry and exit', ENTRY_PCTILE - EXIT_PCTILE >= 0.4,
   f'entry {ENTRY_PCTILE} exit {EXIT_PCTILE}')

print('=== only trade when the expected value clears the toll ===')
from bot.dynamic import expected_value_pct  # noqa: E402
# At a coin flip, EV is negative by exactly the cost -- there is no free lunch in trading a
# 50/50 signal, which is the whole reason the desk was bleeding commission.
ck('a coin flip nets negative by the cost',
   abs(expected_value_pct(0.5, 3.0, 0.9) + 0.9) < 1e-9, str(expected_value_pct(0.5, 3.0, 0.9)))
# The engine's MEASURED skill (51.5%) still does not clear a 0.9% round trip.
ck('measured skill 0.515 is still net-negative', expected_value_pct(0.515, 3.0, 0.9) < 0,
   str(expected_value_pct(0.515, 3.0, 0.9)))
# It takes a genuinely strong, correctly-sized edge to go positive.
ck('a strong edge on a big enough move clears it', expected_value_pct(0.65, 3.0, 0.9) > 0)
ck('a strong edge on too small a move does NOT', expected_value_pct(0.65, 1.0, 0.9) < 0)
# A high-cost name needs an implausible move -- this is what refuses the alts.
ck('a 6% round trip demands a large move', expected_value_pct(0.60, 3.0, 6.1) < 0,
   str(expected_value_pct(0.60, 3.0, 6.1)))
ck('a cheap major with a real edge passes', expected_value_pct(0.60, 3.0, 0.3) > 0)
# Missing inputs must not be read as an opinion.
ck('a missing probability yields None, not a trade', expected_value_pct(None, 3.0, 0.9) is None)
ck('a missing move yields None', expected_value_pct(0.6, None, 0.9) is None)
ck('EV is symmetric around p=0.5',
   abs(expected_value_pct(0.7, 4.0, 0) + expected_value_pct(0.3, 4.0, 0)) < 1e-9)

print(f"{'BOT DYNAMIC CHECK PASS' if not FAIL else 'BOT DYNAMIC CHECK FAIL'}: "
      f'{len(PASS)} passed, {len(FAIL)} failed')
if FAIL and os.environ.get('GITHUB_ACTIONS'):
    print(f"::error title=bot_dynamic_check::{'; '.join(FAIL[:6])}")
sys.exit(1 if FAIL else 0)
