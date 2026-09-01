"""Prove Mia 2.0's accounting is exact before any strategy runs on top of it.

This is money accounting. It is fake money, but the entire purpose of the bot is to
MEASURE whether the app can trade, so an error here does not lose dollars, it
invalidates the experiment and produces a confident wrong answer. That is worse.

What is asserted, and why each one is here:

  * FIFO, not average cost. Averaging would smear realized P/L across lots bought at
    different prices and make per-trade attribution meaningless.
  * Fills cross the spread. A bot that books fills at the observed midpoint reports
    profits it could never have captured, which is the single easiest way to make a
    losing system look like a winner.
  * Conservation. Cash + holdings at cost must equal what was put in, minus realized
    losses. If money can appear or vanish, every leaderboard number is fiction.
  * A round trip at an UNCHANGED price must LOSE, by exactly the round-trip cost.
    This is the sharpest test in the file: it is what makes the bot's bleed honest.
  * Refusals are refusals, not exceptions. One bad order must never kill a run.
  * Marking with a missing price falls back to cost basis, so a quote outage cannot
    look like a wipeout.

Run: python tools/bot_account_check.py
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.portfolio import BotAccount, Sleeve, MIN_TRADE_USD  # noqa: E402
from trading_costs import fill_price, round_trip_cost_pct, side_cost_pct  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


def approx(a, b, tol=1e-6):
    return abs(float(a) - float(b)) <= tol


print('=== fills cross the spread in the right direction ===')
buy_px = fill_price(100.0, 'BUY')
sell_px = fill_price(100.0, 'SELL')
check('a BUY pays MORE than the observed price', buy_px > 100.0, str(buy_px))
check('a SELL receives LESS than the observed price', sell_px < 100.0, str(sell_px))
check('the two are symmetric around the reference',
      approx((buy_px - 100.0), (100.0 - sell_px)), f'{buy_px} / {sell_px}')
# Tier boundaries are `price < ceiling`, so a price landing exactly ON a boundary
# belongs to the CHEAPER tier above it. Worth pinning: an off-by-one here would
# silently misprice a whole band of the universe, and $100.00 exactly is not a
# contrived input for a stock.
check('$99.99 is in the [20,100) tier -> 0.18% round trip',
      approx(round_trip_cost_pct(99.99), 0.18, 1e-9), str(round_trip_cost_pct(99.99)))
check('$100.00 exactly is in the $100+ tier -> 0.14% round trip',
      approx(round_trip_cost_pct(100.0), 0.14, 1e-9), str(round_trip_cost_pct(100.0)))
check('a sub-penny name costs about 10.1% round trip',
      approx(round_trip_cost_pct(0.005), 10.10, 1e-9), str(round_trip_cost_pct(0.005)))
check('cost is monotonically non-increasing as price rises',
      all(round_trip_cost_pct(a) >= round_trip_cost_pct(b)
          for a, b in zip([0.005, 0.05, 0.5, 3.0, 10.0, 50.0, 500.0],
                          [0.05, 0.5, 3.0, 10.0, 50.0, 500.0, 5000.0])))

print('\n=== a round trip at an UNCHANGED price must lose exactly the cost ===')
s = Sleeve('t', 'test', cash_usd=1000.0)
fill, why = s.buy('AAPL', 1000.0, 100.0)
check('the buy executed', fill is not None, str(why))
units = s.units('AAPL')
s.sell('AAPL', units, 100.0)
loss_pct = -100.0 * s.realized_usd / 1000.0
expected = round_trip_cost_pct(100.0)
check('cash is back and position closed', approx(s.units('AAPL'), 0.0) and 'AAPL' not in s.positions)
check(f'the loss equals the round trip ({expected:.4f}%)',
      approx(loss_pct, expected, 2e-4), f'lost {loss_pct:.4f}%')
check('realized P/L is negative on a flat round trip', s.realized_usd < 0,
      f'{s.realized_usd:.4f}')

print('\n=== FIFO consumes the OLDEST lot first ===')
s = Sleeve('t', 'test', cash_usd=3000.0)
s.buy('X', 1000.0, 10.0)     # ~100 units at ~10.015
s.buy('X', 1000.0, 20.0)     # ~50 units at ~20.03
u_first = s.positions['X']['lots'][0]['units']
c_first = s.positions['X']['lots'][0]['costUSD']
# Sell exactly the first lot; realized P/L must reflect the $10 lot, not a blend.
s.sell('X', u_first, 10.0)
check('one lot remains after selling the first', len(s.positions['X']['lots']) == 1,
      str(len(s.positions['X']['lots'])))
check('the surviving lot is the $20 one',
      approx(s.positions['X']['lots'][0]['costUSD'], 1000.0, 1.0),
      str(s.positions['X']['lots'][0]['costUSD']))
# Selling the cheap lot at its own purchase price loses only the round trip on it.
check('realized loss is bounded by the round trip on the first lot',
      -c_first * 0.01 < s.realized_usd < 0, f'{s.realized_usd:.4f} on cost {c_first:.2f}')

print('\n=== a partial sell splits the lot proportionally ===')
s = Sleeve('t', 'test', cash_usd=1000.0)
s.buy('Y', 1000.0, 50.0)
lot_units = s.positions['Y']['lots'][0]['units']
lot_cost = s.positions['Y']['lots'][0]['costUSD']
s.sell('Y', lot_units / 2, 50.0)
rem = s.positions['Y']['lots'][0]
check('half the units remain', approx(rem['units'], lot_units / 2, 1e-9), str(rem['units']))
check('half the cost basis remains', approx(rem['costUSD'], lot_cost / 2, 1e-6),
      f"{rem['costUSD']} vs {lot_cost / 2}")

print('\n=== money is conserved ===')
s = Sleeve('t', 'test', cash_usd=5000.0)
for px, amt in ((10.0, 800.0), (250.0, 1200.0), (3.5, 600.0)):
    s.buy(f'S{px}', amt, px)
invested = sum(s.cost_basis_usd(k) for k in s.positions)
check('cash + cost basis equals the starting cash',
      approx(s.cash_usd + invested, 5000.0, 1e-6),
      f'{s.cash_usd:.6f} + {invested:.6f}')
# Selling everything at the SAME prices must return less than 5000, by the costs.
for k in list(s.positions):
    px = float(k[1:])
    s.sell(k, s.units(k), px)
check('after a full flat round trip cash is below the start', s.cash_usd < 5000.0,
      f'{s.cash_usd:.4f}')
check('the shortfall equals accumulated realized loss',
      approx(s.cash_usd, 5000.0 + s.realized_usd, 1e-6),
      f'{s.cash_usd:.6f} vs {5000.0 + s.realized_usd:.6f}')

print('\n=== refusals are returned, never raised ===')
s = Sleeve('t', 'test', cash_usd=10.0)
fill, why = s.buy('Z', 10.0, 5.0)
check('an order under the minimum is refused with a reason', fill is None and why,
      f'{fill} / {why}')
fill, why = s.buy('Z', 1000.0, 0.0)
check('a zero price is refused', fill is None and why, str(why))
fill, why = s.sell('NOPE', 5, 10.0)
check('selling something not held is refused', fill is None and why == 'no position',
      str(why))
s2 = Sleeve('t', 'test', cash_usd=100.0)
fill, _ = s2.buy('Q', 10_000.0, 10.0)
check('a buy larger than cash is clamped to available cash',
      fill is not None and approx(fill['notionalUSD'], 100.0, 1e-6),
      str(fill and fill['notionalUSD']))
check('cash cannot go negative', s2.cash_usd >= -1e-9, str(s2.cash_usd))

print('\n=== selling more than held sells only what is held ===')
s = Sleeve('t', 'test', cash_usd=1000.0)
s.buy('W', 500.0, 25.0)
held = s.units('W')
fill, why = s.sell('W', held * 5, 25.0)
check('the fill is capped at the held size', fill and approx(fill['units'], held, 1e-9),
      str(fill and fill['units']))
check('the position is fully closed', 'W' not in s.positions)

print('\n=== marking with a MISSING price falls back to cost basis ===')
s = Sleeve('t', 'test', cash_usd=1000.0)
s.buy('GONE', 500.0, 40.0)
val_no_px = s.holdings_value_usd({})
check('a symbol with no quote is valued at cost, not zero',
      approx(val_no_px, s.cost_basis_usd('GONE'), 1e-6), str(val_no_px))
check('a real quote is used when present',
      approx(s.holdings_value_usd({'GONE': 80.0}), s.units('GONE') * 80.0, 1e-6))

print('\n=== account totals and round-tripping through JSON ===')
acct = BotAccount(seed_usd=4000.0, sleeves={
    'a': Sleeve('a', 'A', cash_usd=1000.0),
    'b': Sleeve('b', 'B', cash_usd=1000.0),
    'c': Sleeve('c', 'C', cash_usd=1000.0),
    'ctl': Sleeve('ctl', 'Control', cash_usd=1000.0),
})
acct.sleeve('a').buy('AAA', 500.0, 20.0)
prices = {'AAA': 22.0}
t = acct.totals(prices)
check('equity = cash + marked holdings',
      approx(t['equityUSD'],
             sum(s.equity_usd(prices) for s in acct.sleeves.values()), 1e-6), str(t))
check('pnl = equity - seed', approx(t['pnlUSD'], t['equityUSD'] - 4000.0, 1e-6), str(t))
check('realized + unrealized reconciles to total pnl',
      approx(t['realizedUSD'] + t['unrealizedUSD'], t['pnlUSD'], 1e-6), str(t))

import json  # noqa: E402
import tempfile  # noqa: E402
fd, tmp = tempfile.mkstemp(suffix='.json'); os.close(fd)
try:
    acct.save(tmp, prices)
    with open(tmp, encoding='utf-8') as f:
        raw = json.load(f)
    again = BotAccount.load(tmp)
    check('state survives a save/load round trip',
          approx(again.totals(prices)['equityUSD'], t['equityUSD'], 1e-6))
    check('sleeves and positions survive',
          again.sleeve('a').units('AAA') == acct.sleeve('a').units('AAA'))
    check('saved file carries denormalised totals for the browser',
          'totals' in raw and 'equityUSD' in raw['totals'])
    # The browser parses this with JSON.parse; a bare NaN would throw there.
    json.dumps(raw, allow_nan=False)
    check('saved JSON is strictly valid (no NaN/Infinity)', True)
finally:
    os.remove(tmp)

print('\n=== the leaderboard ranks by return and exposes the control ===')
lb = acct.leaderboard(prices)
check('every sleeve appears', len(lb) == 4, str(len(lb)))
check('sorted best-first', all(lb[i]['pnlPct'] >= lb[i + 1]['pnlPct']
                               for i in range(len(lb) - 1)), str([r['pnlPct'] for r in lb]))
check('the control sleeve is present so beta is visible',
      any(r['id'] == 'ctl' for r in lb))

print('')
print('=== unsettled sell proceeds leave BUYING POWER but stay in EQUITY ===')
# The bug this pins down: in a cash account, execute() moves sell proceeds out of the
# sleeve's cash into _pending_by_sleeve until T+1, which is correct for what can be SPENT.
# totals() then summed only cash_usd, so the money vanished from net worth for a day and
# reappeared later as a phantom gain. On the live desk it reported -8.73% while the
# positions were only -0.94% against cost: almost the entire loss was money still owned.
#
# 38 assertions passed while this was broken, which is precisely why it needed its own.
acct2 = BotAccount(seed_usd=10000.0, sleeves={
    'a': Sleeve('a', 'A', cash_usd=4000.0),
    'b': Sleeve('b', 'B', cash_usd=5000.0),
})
base = acct2.totals({})
check('with nothing pending, equity is just cash',
      approx(base['equityUSD'], 9000.0), str(base['equityUSD']))
check('unsettled is reported even when zero', base.get('unsettledCashUSD') == 0.0,
      str(base.get('unsettledCashUSD')))
# Park proceeds exactly as execute() does after a sell.
acct2._pending_by_sleeve = {'a': 600.0, 'b': 400.0}
t2 = acct2.totals({})
check('equity INCLUDES unsettled proceeds', approx(t2['equityUSD'], 10000.0),
      f"expected 10000.00, got {t2['equityUSD']}")
check('spendable cash EXCLUDES them', approx(t2['cashUSD'], 9000.0), str(t2['cashUSD']))
check('unsettled is reported on its own', approx(t2['unsettledCashUSD'], 1000.0),
      str(t2['unsettledCashUSD']))
check('P/L is not a phantom loss', approx(t2['pnlUSD'], 0.0),
      f"expected 0.00, got {t2['pnlUSD']}")
check('holdings are not inflated by pending cash',
      approx(t2['holdingsUSD'], 0.0), str(t2['holdingsUSD']))
check('equity reconciles with its parts',
      approx(t2['equityUSD'], t2['cashUSD'] + t2['unsettledCashUSD'] + t2['holdingsUSD']),
      str(t2))

print(f"\n{'BOT ACCOUNT CHECK PASS' if not FAIL else 'BOT ACCOUNT CHECK FAIL'}: "
      f'{len(PASS)} passed, {len(FAIL)} failed')
sys.exit(1 if FAIL else 0)
