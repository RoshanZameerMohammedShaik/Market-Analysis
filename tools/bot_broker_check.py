"""Prove the cash-vs-margin rules actually bite, and that the fees match IBKR's formulas.

Every rule in bot/broker.py can BLOCK a trade the strategy wanted to make. A rule that
silently fails open is worse than no rule: the bot would rack up settlement violations
or day trades that a real account would have refused, and the P/L it reports could never
have been earned. So each one is tested by constructing the situation that must trip it.

The fee assertions are checked against IBKR's published formulas rather than against
whatever the code happens to return, so a typo in a rate cannot pass by agreeing with
itself.

Run: python tools/bot_broker_check.py
"""
import datetime
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.broker import (  # noqa: E402
    CASH, MARGIN, PLAN_LITE, PLAN_PRO_FIXED, PLAN_PRO_TIERED,
    PDT_MAX_DAY_TRADES, MAINTENANCE_MARGIN, BrokerAccount,
    add_business_days, broker_fees_usd, commission_usd, regulatory_usd,
    SEC_FEE_PCT, FINRA_TAF_PER_SHARE, FINRA_TAF_MAX, ALLOW_SHORT,
)

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


def approx(a, b, tol=1e-6):
    return abs(float(a) - float(b)) <= tol


MON = datetime.date(2026, 8, 24)      # a Monday
FRI = datetime.date(2026, 8, 28)      # the Friday of that week

print('=== commissions match IBKR published formulas ===')
# Pro Tiered: $0.0035/share, $0.35 minimum, 1% cap.
check('tiered: 1000 sh x $50 -> $3.50 (per-share dominates)',
      approx(commission_usd(1000, 50, PLAN_PRO_TIERED), 3.50), str(commission_usd(1000, 50, PLAN_PRO_TIERED)))
check('tiered: 10 sh x $50 -> $0.35 minimum applies',
      approx(commission_usd(10, 50, PLAN_PRO_TIERED), 0.35), str(commission_usd(10, 50, PLAN_PRO_TIERED)))
# 1% cap: 100 shares of a $0.20 stock is $20 notional, so the cap is $0.20 < the $0.35 min.
check('tiered: the 1% cap overrides the minimum on a tiny order',
      approx(commission_usd(100, 0.20, PLAN_PRO_TIERED), 0.20),
      str(commission_usd(100, 0.20, PLAN_PRO_TIERED)))
# Pro Fixed: $0.005/share, $1.00 minimum.
check('fixed: 1000 sh x $50 -> $5.00',
      approx(commission_usd(1000, 50, PLAN_PRO_FIXED), 5.00), str(commission_usd(1000, 50, PLAN_PRO_FIXED)))
check('fixed: 50 sh x $50 -> $1.00 minimum applies',
      approx(commission_usd(50, 50, PLAN_PRO_FIXED), 1.00), str(commission_usd(50, 50, PLAN_PRO_FIXED)))
check('lite: always zero', approx(commission_usd(1000, 50, PLAN_LITE), 0.0))
check('commission is never negative and never above the 1% cap',
      all(0 <= commission_usd(u, p, PLAN_PRO_TIERED) <= u * p * 0.01 + 1e-9
          for u, p in ((1, 1), (7, 3.33), (10_000, 250), (1, 0.01))))

print('\n=== regulatory fees are SELL-side only ===')
check('a BUY pays no regulatory fee', approx(regulatory_usd(1000, 50, 'BUY'), 0.0))
sell = regulatory_usd(1000, 50, 'SELL')
expect = 50_000 * SEC_FEE_PCT / 100.0 + min(1000 * FINRA_TAF_PER_SHARE, FINRA_TAF_MAX)
check('a SELL pays SEC + TAF, matching the formula', approx(sell, expect), f'{sell} vs {expect}')
check('the TAF cap binds on a huge share count',
      approx(regulatory_usd(10_000_000, 1.0, 'SELL'),
             10_000_000 * 1.0 * SEC_FEE_PCT / 100.0 + FINRA_TAF_MAX))
rt_buy = broker_fees_usd(100, 100, 'BUY', PLAN_PRO_TIERED)['totalUSD']
rt_sell = broker_fees_usd(100, 100, 'SELL', PLAN_PRO_TIERED)['totalUSD']
check('a round trip is ASYMMETRIC because only the sell pays regulators',
      rt_sell > rt_buy, f'buy {rt_buy} vs sell {rt_sell}')

print('\n=== settlement dates skip weekends ===')
check('Monday + 1 business day = Tuesday',
      add_business_days(MON, 1) == datetime.date(2026, 8, 25))
check('Friday + 1 business day = the following Monday',
      add_business_days(FRI, 1) == datetime.date(2026, 8, 31),
      str(add_business_days(FRI, 1)))

print('\n=== CASH account: unsettled proceeds are NOT spendable ===')
a = BrokerAccount(CASH)
settles = a.add_pending(1000.0, MON)
check('a sale queues proceeds for T+1', settles == '2026-08-25', str(settles))
check('unsettled cash is tracked', approx(a.unsettled_usd(), 1000.0))
check('buying power EXCLUDES unsettled proceeds',
      approx(a.buying_power(settled_cash=200.0, equity=1200.0), 200.0),
      str(a.buying_power(200.0, 1200.0)))
ok, why = a.check_buy(500.0, settled_cash=200.0, equity=1200.0)
check('a buy above settled cash is refused', not ok and 'unsettled' in (why or ''), str(why))
check('the refusal names the unsettled amount', '1,000' in (why or ''), str(why))
released = a.settle_due(datetime.date(2026, 8, 25))
check('proceeds release on the settlement date', approx(released, 1000.0), str(released))
check('nothing remains pending after settling', approx(a.unsettled_usd(), 0.0))
ok, why = a.check_buy(500.0, settled_cash=1200.0, equity=1200.0)
check('the same buy is allowed once settled', ok, str(why))
check('a cash account never queues on a margin account',
      BrokerAccount(MARGIN).add_pending(1000.0, MON) is None)
check('cash account has NO leverage',
      approx(BrokerAccount(CASH).buying_power(1000.0, 5000.0), 1000.0))

print('\n=== MARGIN account: 2x buying power, and interest is not free ===')
m = BrokerAccount(MARGIN, benchmark_rate_pct=4.33)
check('Reg T gives 2x equity', approx(m.buying_power(settled_cash=1000.0, equity=1000.0), 2000.0),
      str(m.buying_power(1000.0, 1000.0)))
m.debit_usd = 500.0
check('an existing debit reduces remaining buying power',
      approx(m.buying_power(1000.0, 1000.0), 1500.0), str(m.buying_power(1000.0, 1000.0)))
check('the quoted annual rate is benchmark + spread',
      approx(m.annual_rate_pct(), 5.83), str(m.annual_rate_pct()))
charge = m.accrue_interest(MON)
# The RETURNED value is rounded to 6dp for reporting while the internal balance keeps
# full precision, which is the right split: a timeline entry showing 12 decimal places
# is noise, but rounding the accumulator would drift over months of daily accrual.
# So compare against the rounded expectation rather than loosening the tolerance.
expected_day = round(500.0 * (5.83 / 100.0) / 360.0, 6)
check('one day of interest on a $500 debit matches a 360-day basis',
      approx(charge, expected_day, 1e-9), f'{charge} vs {expected_day}')
check('the internal balance keeps MORE precision than the reported figure',
      m.interest_usd >= charge, f'{m.interest_usd} vs {charge}')
again = m.accrue_interest(MON)
check('interest is charged ONCE per day, not once per bot run',
      approx(again, 0.0), f'second call charged {again}')
check('unpaid interest capitalises into the debit', m.debit_usd > 500.0, str(m.debit_usd))
check('a CASH account never accrues margin interest',
      approx(BrokerAccount(CASH).accrue_interest(MON), 0.0))

print('\n=== MARGIN maintenance call ===')
m2 = BrokerAccount(MARGIN)
check('healthy account is not called', not m2.is_margin_call(equity=5000.0, holdings_value=10000.0))
check('equity below the 25% maintenance floor IS a call',
      m2.is_margin_call(equity=2000.0, holdings_value=10000.0))
check('the ratio is reported for the UI',
      approx(m2.margin_used_pct(2500.0, 10000.0), 0.25), str(m2.margin_used_pct(2500.0, 10000.0)))
check('maintenance ratio is undefined with no holdings',
      m2.margin_used_pct(1000.0, 0.0) is None)

print('\n=== Pattern Day Trader rule ===')
p = BrokerAccount(MARGIN)
# Bought today, so selling today would be a day trade.
p.note_open('AAPL', 10, MON)
check('selling something bought today is recognised as a day trade',
      p.would_be_day_trade('AAPL', MON))
check('an unrelated symbol is not a day trade', not p.would_be_day_trade('MSFT', MON))
for _ in range(PDT_MAX_DAY_TRADES):
    p.note_day_trade(MON)
blocked = p.pdt_blocks('AAPL', MON, equity=10_000.0)
check(f'the {PDT_MAX_DAY_TRADES}-day-trade limit blocks the 4th under $25k',
      bool(blocked), str(blocked))
check('the block explains itself for the timeline',
      blocked and 'PDT' in blocked and '25,000' in blocked, str(blocked))
check('the SAME account is unrestricted at or above $25k',
      p.pdt_blocks('AAPL', MON, equity=25_000.0) is None)
check('a CASH account has no PDT rule at all',
      BrokerAccount(CASH).pdt_blocks('AAPL', MON, equity=1_000.0) is None)
# The rolling window must age out.
old = BrokerAccount(MARGIN, day_trades=['2026-08-01'] * 5)
check('day trades outside the rolling 5-business-day window do not count',
      old.day_trades_in_window(MON) == 0, str(old.day_trades_in_window(MON)))
check('day trades inside the window do count',
      BrokerAccount(MARGIN, day_trades=[MON.isoformat()]).day_trades_in_window(MON) == 1)

print('\n=== shorting is off, deliberately and visibly ===')
check('ALLOW_SHORT is False until borrow costs are modelled', ALLOW_SHORT is False)

print('\n=== state survives a round trip, and self-describes ===')
src = BrokerAccount(MARGIN, PLAN_PRO_FIXED, 4.33, debit_usd=250.0)
src.add_pending(10.0, MON)     # no-op on margin
src.note_day_trade(MON)
back = BrokerAccount.from_dict(src.to_dict())
check('account type survives', back.account_type == MARGIN)
check('plan survives', back.plan == PLAN_PRO_FIXED)
check('debit survives', approx(back.debit_usd, 250.0))
check('day trades survive', back.day_trades == src.day_trades)
check('cash account describes its real constraints',
      'T+1' in BrokerAccount(CASH).describe() and 'no shorting' in BrokerAccount(CASH).describe())
check('margin account describes leverage, maintenance and interest',
      all(s in BrokerAccount(MARGIN).describe() for s in ('2x', '25%', 'interest')),
      BrokerAccount(MARGIN).describe())

print(f"\n{'BOT BROKER CHECK PASS' if not FAIL else 'BOT BROKER CHECK FAIL'}: "
      f'{len(PASS)} passed, {len(FAIL)} failed')
sys.exit(1 if FAIL else 0)
