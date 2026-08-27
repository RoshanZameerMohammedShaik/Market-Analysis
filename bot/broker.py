"""Broker rules: IBKR-style commissions, and the real difference between a CASH and a
MARGIN account.

WHY THIS IS SEPARATE FROM trading_costs.py
------------------------------------------
Two different things are both real and they COMPOSE, so they must not be conflated:

  * trading_costs.py models the SPREAD and slippage: the price you actually get filled
    at versus the price you saw. It is an estimate, because we have no depth data.
  * this file models the BROKER's charges: commission, regulatory fees, margin
    interest. These are published formulas, not estimates.

An IBKR customer pays commission AND crosses the spread. Modelling only one understates
the true cost of trading by roughly half.

WHY ACCOUNT TYPE CHANGES BEHAVIOUR, NOT JUST ARITHMETIC
-------------------------------------------------------
Roshan asked for the bot to know how and when to trade in a cash versus a margin
account. That is not a fee toggle, it is a different set of things the bot is ALLOWED
to do, and each rule below can block a trade the strategy wanted to make:

  CASH ACCOUNT
    * No leverage. Buying power is settled cash, full stop.
    * T+1 settlement (US equities moved to T+1 on 2024-05-28). Sale proceeds are not
      spendable until the next business day.
    * We spend SETTLED cash only. Brokers do permit buying with unsettled proceeds if
      you hold to settlement, but selling before then is a free-riding violation and
      three good-faith violations in twelve months freezes the account for 90 days. A
      bot that trades every 15 minutes would collect those almost immediately, so
      refusing to spend unsettled cash is the correct conservative rule rather than a
      limitation.
    * No shorting, ever.

  MARGIN ACCOUNT
    * Reg T initial margin 50%, so buying power is 2x equity.
    * FINRA maintenance margin 25% floor. Below it, a margin call, and the bot must
      de-risk rather than keep buying.
    * Margin interest accrues DAILY on the debit balance. This is the cost people
      forget: leverage is not free, and at a 15-minute cadence an idle debit balance
      quietly compounds against you.
    * Pattern Day Trader rule: under $25,000 equity, at most 3 day trades in any
      rolling 5 business days. A bot checking every 15 minutes will trip this in an
      afternoon if nothing counts it, which is exactly why it is enforced here.
    * Shorting is permitted by the account type. See ALLOW_SHORT below for why it is
      still switched off.

RATES ARE POINT-IN-TIME AND CONFIGURABLE
----------------------------------------
Commission schedules and interest rates change. Every number here is a named constant
with the date it was accurate, so it can be corrected without hunting through logic.
Where a rate is genuinely uncertain it is set PESSIMISTICALLY, because understating
costs is how a losing system passes a backtest.
"""
from __future__ import annotations

import datetime

# ── commission plans (US stocks; accurate as of 2026-08) ─────────────────────
# IBKR Lite: zero commission on US listed stocks and ETFs, order flow is routed for
# payment instead, which shows up as worse fills rather than as a fee. Because our
# spread model already charges for the fill, Lite is genuinely near-zero HERE.
PLAN_LITE = 'ibkr-lite'
# IBKR Pro Tiered: $0.0035 per share, $0.35 minimum per order, capped at 1% of value.
PLAN_PRO_TIERED = 'ibkr-pro-tiered'
# IBKR Pro Fixed: $0.005 per share, $1.00 minimum per order, capped at 1% of value.
PLAN_PRO_FIXED = 'ibkr-pro-fixed'

PLANS = {
    PLAN_LITE:       {'per_share': 0.0,    'min_order': 0.0,  'max_pct': 0.0},
    PLAN_PRO_TIERED: {'per_share': 0.0035, 'min_order': 0.35, 'max_pct': 1.0},
    PLAN_PRO_FIXED:  {'per_share': 0.005,  'min_order': 1.00, 'max_pct': 1.0},
}

# Regulatory pass-throughs. BOTH are charged on SELLS ONLY, which is why a round trip
# is not symmetric and why a bot that ignores them slightly overstates every exit.
# SEC Section 31 fee: rate is reset annually. $27.80 per $1,000,000 of sale proceeds.
SEC_FEE_PCT = 0.00278
# FINRA Trading Activity Fee: per share sold, capped per order.
FINRA_TAF_PER_SHARE = 0.000166
FINRA_TAF_MAX = 8.30

# ── account types ────────────────────────────────────────────────────────────
CASH = 'cash'
MARGIN = 'margin'

REG_T_INITIAL_MARGIN = 0.50      # 50% -> 2x buying power
MAINTENANCE_MARGIN = 0.25        # FINRA floor; real brokers are stricter
PDT_EQUITY_THRESHOLD = 25_000.0  # under this, day trades are limited
PDT_MAX_DAY_TRADES = 3           # per rolling 5 business days
SETTLEMENT_DAYS = 1              # T+1 for US equities since 2024-05-28

# IBKR margin interest = benchmark + spread, tiered by debit size. Tier 1 (up to
# ~$100k) is benchmark + 1.5%. The benchmark tracks the effective fed funds rate and
# MOVES, so it is configurable; this default is deliberately on the high side.
DEFAULT_BENCHMARK_RATE_PCT = 4.33
MARGIN_SPREAD_PCT = 1.50

# Shorting is legal in a margin account and is NOT implemented. bot/portfolio.py keeps
# FIFO lots with positive units only, so a short would need negative-unit lots plus a
# borrow-fee accrual. Half-implementing it would let the bot book short profits without
# paying to borrow, which is the same class of lie as free fills. Off until done properly.
ALLOW_SHORT = False


def commission_usd(units, price, plan=PLAN_PRO_TIERED):
    """Broker commission for one order. Never negative, never above the 1% cap."""
    cfg = PLANS.get(plan) or PLANS[PLAN_PRO_TIERED]
    shares = abs(float(units))
    value = shares * abs(float(price))
    if shares <= 0 or value <= 0:
        return 0.0
    if cfg['per_share'] <= 0 and cfg['min_order'] <= 0:
        return 0.0
    fee = max(shares * cfg['per_share'], cfg['min_order'])
    if cfg['max_pct'] > 0:
        fee = min(fee, value * cfg['max_pct'] / 100.0)
    return round(fee, 6)


def regulatory_usd(units, price, side):
    """SEC Section 31 + FINRA TAF. Sells only; a buy pays neither."""
    if str(side).upper() != 'SELL':
        return 0.0
    shares = abs(float(units))
    proceeds = shares * abs(float(price))
    sec = proceeds * SEC_FEE_PCT / 100.0
    taf = min(shares * FINRA_TAF_PER_SHARE, FINRA_TAF_MAX)
    return round(sec + taf, 6)


def broker_fees_usd(units, price, side, plan=PLAN_PRO_TIERED):
    """Total broker-side charge for one fill, itemised for the timeline."""
    comm = commission_usd(units, price, plan)
    reg = regulatory_usd(units, price, side)
    return {'commissionUSD': comm, 'regulatoryUSD': reg,
            'totalUSD': round(comm + reg, 6)}


def _is_business_day(d):
    return d.weekday() < 5


def add_business_days(d, n):
    """Settlement dates skip weekends. Market holidays are NOT modelled, so a
    settlement can land one session early around a holiday. Stated rather than hidden;
    the effect is at most one day of buying power."""
    cur = d
    added = 0
    while added < n:
        cur += datetime.timedelta(days=1)
        if _is_business_day(cur):
            added += 1
    return cur


class BrokerAccount:
    """Wraps a sleeve with the rules of a cash or margin account.

    Holds only the ACCOUNT-LEVEL state that the sleeve itself has no business knowing:
    unsettled proceeds, debit balance, accrued interest, and the day-trade log.
    """

    def __init__(self, account_type=CASH, plan=PLAN_PRO_TIERED,
                 benchmark_rate_pct=DEFAULT_BENCHMARK_RATE_PCT,
                 pending=None, debit_usd=0.0, interest_usd=0.0,
                 day_trades=None, opened_today=None, last_accrual=None,
                 violations=None):
        self.account_type = account_type if account_type in (CASH, MARGIN) else CASH
        self.plan = plan if plan in PLANS else PLAN_PRO_TIERED
        self.benchmark_rate_pct = float(benchmark_rate_pct)
        # pending = [{'amountUSD':..., 'settlesOn':'YYYY-MM-DD'}] for a cash account
        self.pending = pending or []
        self.debit_usd = float(debit_usd)
        self.interest_usd = float(interest_usd)
        # day_trades = ['YYYY-MM-DD', ...] one entry per day trade
        self.day_trades = day_trades or []
        # opened_today = {'YYYY-MM-DD': {symbol: units_bought}} to detect a day trade
        self.opened_today = opened_today or {}
        self.last_accrual = last_accrual
        self.violations = violations or []

    # ── serialisation ────────────────────────────────────────────────────────
    def to_dict(self):
        return {'accountType': self.account_type, 'plan': self.plan,
                'benchmarkRatePct': self.benchmark_rate_pct,
                'pending': self.pending, 'debitUSD': round(self.debit_usd, 6),
                'interestUSD': round(self.interest_usd, 6),
                'dayTrades': self.day_trades, 'openedToday': self.opened_today,
                'lastAccrual': self.last_accrual, 'violations': self.violations[-50:]}

    @classmethod
    def from_dict(cls, d):
        d = d or {}
        return cls(d.get('accountType', CASH), d.get('plan', PLAN_PRO_TIERED),
                   d.get('benchmarkRatePct', DEFAULT_BENCHMARK_RATE_PCT),
                   d.get('pending'), d.get('debitUSD', 0.0),
                   d.get('interestUSD', 0.0), d.get('dayTrades'),
                   d.get('openedToday'), d.get('lastAccrual'), d.get('violations'))

    # ── settlement (cash accounts) ───────────────────────────────────────────
    def settle_due(self, today):
        """Move matured proceeds into spendable cash. Returns the amount released."""
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        released = 0.0
        still = []
        for p in self.pending:
            if p['settlesOn'] <= iso:
                released += float(p['amountUSD'])
            else:
                still.append(p)
        self.pending = still
        return round(released, 6)

    def add_pending(self, amount_usd, today):
        """Queue sale proceeds for T+1 settlement. Margin accounts settle instantly
        for buying-power purposes, so nothing is queued there."""
        if self.account_type != CASH or amount_usd <= 0:
            return None
        settles = add_business_days(today, SETTLEMENT_DAYS).isoformat()
        self.pending.append({'amountUSD': round(float(amount_usd), 6),
                             'settlesOn': settles})
        return settles

    def unsettled_usd(self):
        return round(sum(float(p['amountUSD']) for p in self.pending), 6)

    # ── buying power ─────────────────────────────────────────────────────────
    def buying_power(self, settled_cash, equity):
        """What the bot may actually spend right now.

        CASH: settled cash only. Unsettled proceeds are deliberately excluded; see the
        free-riding note in the module docstring.
        MARGIN: Reg T gives 2x equity, but never more than settled cash plus the
        remaining margin loan capacity.
        """
        if self.account_type == CASH:
            return max(0.0, float(settled_cash))
        gross = float(equity) / REG_T_INITIAL_MARGIN          # 2x equity
        return max(0.0, gross - self.debit_usd)

    def margin_used_pct(self, equity, holdings_value):
        """Maintenance ratio. Below MAINTENANCE_MARGIN is a call."""
        if self.account_type != MARGIN or holdings_value <= 0:
            return None
        return float(equity) / float(holdings_value)

    def is_margin_call(self, equity, holdings_value):
        r = self.margin_used_pct(equity, holdings_value)
        return r is not None and r < MAINTENANCE_MARGIN

    # ── margin interest ──────────────────────────────────────────────────────
    def accrue_interest(self, today):
        """Daily interest on the debit balance. Charged once per calendar day even
        though the bot runs many times a day, so a 15-minute cadence cannot multiply
        the interest bill by the number of runs."""
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        if self.account_type != MARGIN or self.debit_usd <= 0:
            self.last_accrual = iso
            return 0.0
        if self.last_accrual == iso:
            return 0.0
        rate = (self.benchmark_rate_pct + MARGIN_SPREAD_PCT) / 100.0
        # 360-day basis, which is what brokers use for margin interest.
        charge = self.debit_usd * rate / 360.0
        self.interest_usd += charge
        self.debit_usd += charge          # unpaid interest capitalises into the loan
        self.last_accrual = iso
        return round(charge, 6)

    def annual_rate_pct(self):
        return round(self.benchmark_rate_pct + MARGIN_SPREAD_PCT, 4)

    # ── pattern day trader ───────────────────────────────────────────────────
    def note_open(self, symbol, units, today):
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        day = self.opened_today.setdefault(iso, {})
        day[symbol] = float(day.get(symbol, 0.0)) + float(units)

    def would_be_day_trade(self, symbol, today):
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        return float((self.opened_today.get(iso) or {}).get(symbol, 0.0)) > 0

    def day_trades_in_window(self, today):
        """Count day trades in the rolling 5 BUSINESS day window ending today."""
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        start = today
        back = 0
        while back < 4:
            start -= datetime.timedelta(days=1)
            if _is_business_day(start):
                back += 1
        s = start.isoformat()
        return sum(1 for d in self.day_trades if s <= d <= iso)

    def pdt_blocks(self, symbol, today, equity):
        """Reason string if the PDT rule blocks closing `symbol` today, else None.

        Only bites in a MARGIN account under $25k. A cash account has no PDT rule; it
        is constrained by settlement instead, which is stricter in practice.
        """
        if self.account_type != MARGIN:
            return None
        if float(equity) >= PDT_EQUITY_THRESHOLD:
            return None
        if not self.would_be_day_trade(symbol, today):
            return None
        used = self.day_trades_in_window(today)
        if used < PDT_MAX_DAY_TRADES:
            return None
        return (f'PDT limit: {used}/{PDT_MAX_DAY_TRADES} day trades used in the rolling '
                f'5-business-day window and equity ${float(equity):,.0f} is under '
                f'${PDT_EQUITY_THRESHOLD:,.0f}')

    def note_day_trade(self, today):
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        self.day_trades.append(iso)
        # Keep the log small; anything older than a month cannot affect the window.
        cutoff = (today - datetime.timedelta(days=40)).isoformat()
        self.day_trades = [d for d in self.day_trades if d >= cutoff]

    def prune(self, today):
        """Drop opened-today records for past days so the file does not grow forever."""
        iso = today.isoformat() if hasattr(today, 'isoformat') else str(today)
        self.opened_today = {k: v for k, v in self.opened_today.items() if k >= iso}

    # ── the gate every order passes through ──────────────────────────────────
    def check_buy(self, notional_usd, settled_cash, equity):
        """(allowed, reason). Reason is written into the timeline when refused, so the
        UI can show WHY a strategy's intent did not become a trade."""
        bp = self.buying_power(settled_cash, equity)
        if notional_usd > bp + 1e-9:
            if self.account_type == CASH and self.unsettled_usd() > 0:
                return False, (f'cash account: buying power ${bp:,.2f} '
                               f'(${self.unsettled_usd():,.2f} still unsettled)')
            return False, f'insufficient buying power (${bp:,.2f})'
        return True, None

    def check_sell(self, symbol, today, equity):
        blocked = self.pdt_blocks(symbol, today, equity)
        if blocked:
            return False, blocked
        return True, None

    def describe(self):
        if self.account_type == CASH:
            return ('Cash account: no leverage, settled cash only, T+1 settlement, '
                    'no shorting. Constrained by settlement rather than PDT.')
        return (f'Margin account: {1/REG_T_INITIAL_MARGIN:.0f}x Reg T buying power, '
                f'{MAINTENANCE_MARGIN:.0%} maintenance, '
                f'{self.annual_rate_pct():.2f}% annual interest on debit, '
                f'PDT-limited under ${PDT_EQUITY_THRESHOLD:,.0f}.')
