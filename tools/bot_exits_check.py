"""The desk's exit rails: +5% target, -2% stop armed only on a confirmed decline.

Roshan, 2026-10-06: "trade in a way to bring atleast 5% profit in every trade and not more
than 2% loss if a sharp decline is analyzed". The wording is the whole rule. Measured on
85,464 simulated trades over 14 years with entries held identical across arms
(tools/_exp5/exit_rules.py):

  rule                              momentum avg/trade   dip avg/trade   worst trade
  old: never sell at a loss               +0.91%            +1.65%          -489%
  +5% / BLIND -2% stop                    +0.04%            +0.14%           -24%
  +5% / -2% on CONFIRMED decline          +0.99%            +1.25%          -163%

A blind stop at this distance fired on 69% of trades and took the edge to zero. These checks
exist so nobody re-derives the blind version by "simplifying" the confirmation away.

Run: python tools/bot_exits_check.py
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.config import load_config                       # noqa: E402
from bot.dynamic import exit_levels, target_reachable     # noqa: E402
from bot.strategies import Intent, confirmed_decline      # noqa: E402

passed = failed = 0


def ck(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}  -> {detail}')


cfg = load_config()
ex = cfg.get('exits') or {}

print('\n=== the rails are configured, and in force ===')
ck('profit target is 5% or better', float(ex.get('profitTargetPct') or 0) >= 5.0, ex.get('profitTargetPct'))
ck('max loss is 2% or tighter', 0 < float(ex.get('maxLossPct') or 99) <= 2.0, ex.get('maxLossPct'))
ck('the stop needs a confirmed decline', ex.get('requireConfirmedDecline') is True)
ck('holding every loser is OFF', cfg.get('neverSellAtLoss') is False)

print('\n=== the target is a FLOOR, the stop a CEILING ===')
# A calm name: its own band would take profit at +1.5% and stop at -1.5%. The floor lifts the
# target to 5%; the ceiling holds the stop at exactly 2%, not tighter.
calm = {'price': 100.0, 'sigmaDailyPct': 0.9,
        'band': {'day1': {'low': 98.5, 'high': 101.5}, 'calibrated': True, 'tier': 'calm', 'sigmaDaily': 0.9}}
tp, sl, ev = exit_levels(calm, 100.0, ex)
ck('a 1.5% band target is lifted to the 5% floor', abs(tp - 105.0) < 1e-9, tp)
ck('and the stop sits AT 2%, not at the tighter band level', abs(sl - 98.0) < 1e-9, sl)
# A wild name: its band would risk 8%. The ceiling pulls that back to 2%.
wild = {'price': 100.0, 'sigmaDailyPct': 6.0,
        'band': {'day1': {'low': 92.0, 'high': 112.0}, 'calibrated': True, 'tier': 'wild', 'sigmaDaily': 6.0}}
tp2, sl2, _ = exit_levels(wild, 100.0, ex)
ck('an 8% band stop is pulled in to 2%', abs(sl2 - 98.0) < 1e-9, sl2)
ck('a band target beyond the floor is kept', tp2 > 105.0, tp2)
ck('the target is always above cost and the stop below it', tp > 100.0 > sl and tp2 > 100.0 > sl2)

print('\n=== the promise is kept at ENTRY, not by hanging an unreachable target ===')
ok_calm, ev_calm = target_reachable(calm, ex)
ok_wild, _ = target_reachable(wild, ex)
ck('a 0.9%/day name cannot reach +5% in the window, so it is refused', ok_calm is False, ev_calm)
ck('a 6%/day name can, so it is allowed', ok_wild is True)
ck('the refusal shows the arithmetic', isinstance(ev_calm.get('windowMovePct'), (int, float)))
ck('no volatility estimate does NOT silently filter everything',
   target_reachable({'price': 10.0}, ex)[0] is True)

print('\n=== "a sharp decline is analyzed": what counts as confirmation ===')
ck('below the 200-day average confirms',
   confirmed_decline({'trend': {'above200': False}}, ex)[0] is True)
ck('a sharply rising volatility forecast confirms',
   confirmed_decline({'trend': {'above200': True},
                      'volForecast': {'call': 'choppier', 'confidence': 0.85}}, ex)[0] is True)
ck('a LOW-confidence choppier call does NOT confirm',
   confirmed_decline({'trend': {'above200': True},
                      'volForecast': {'call': 'choppier', 'confidence': 0.61}}, ex)[0] is False)
ck('a calmer forecast in an uptrend does NOT confirm',
   confirmed_decline({'trend': {'above200': True},
                      'volForecast': {'call': 'calmer', 'confidence': 0.95}}, ex)[0] is False)
ck('an ordinary dip with no evidence does NOT confirm',
   confirmed_decline({}, ex)[0] is False)
ck('every verdict carries a reason a person can read',
   all(isinstance(confirmed_decline(c, ex)[1], str) and confirmed_decline(c, ex)[1]
       for c in ({}, {'trend': {'above200': False}})))
ck('turning confirmation off restores the blind stop, as documented',
   confirmed_decline({}, {'requireConfirmedDecline': False})[0] is True)

print('\n=== market or limit is Mia\'s choice, and a limit needs a price ===')
ck('a limit with a price stays a limit',
   Intent('BUY', 'X', 'w', order_type='limit', limit_price=99.5).order_type == 'limit')
ck('a limit without a price is NOT an order, it becomes market',
   Intent('BUY', 'X', 'w', order_type='limit').order_type == 'market')
ck('the default is market', Intent('BUY', 'X', 'w').order_type == 'market')
ck('the timeline records which it was',
   Intent('BUY', 'X', 'w', order_type='limit', limit_price=1.0).to_dict()['orderType'] == 'limit')

print('\n=== cash or margin is the user\'s decision, never the desk\'s ===')
ck('an account type is set', cfg.get('accountType') in ('cash', 'margin'), cfg.get('accountType'))
src = open(os.path.join(REPO, 'bot', 'run.py'), encoding='utf-8').read()
ck('--account-type exists and is restricted to the two valid values',
   "'--account-type'" in src and "choices=('cash', 'margin')" in src)
ck('it is only applied through set_armed, i.e. at arm time',
   src.count("cfg['accountType'] = t") == 1)

print(f'\nBOT EXITS CHECK {"FAIL" if failed else "PASS"}: {passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
