"""What a fill actually costs. THE one cost model, shared by the bot and the research
tools.

Every honest number in this project depends on this file. An earlier research pass
found a real reversal signal with an IC around 0.05 that replicated out of sample,
and then found a measured 1.86% round-trip spread ate all of it. A backtest or a bot
that does not charge costs is not optimistic, it is fiction: the engine's gross edge
per trade measures +0.06% to +0.16% while the cheapest possible round trip is 0.14%.
Cost is the whole game at this signal strength.

WHY PRICE TIERS
---------------
The real driver of spread is DEPTH, and we have no depth data. Price is a crude but
monotonic proxy for it, and it is the one field always available. The tiers below are
deliberately pessimistic:

  * Chen & Velikov (JFQA 2023) document that low-frequency spread estimators,
    Corwin-Schultz included, are biased UPWARD by 25-50bps post-2003 versus TAQ. So
    quoting a CS-style number as the tradeable cost overstates it.
  * But retail market orders also fill worse than the quoted midpoint, and SEC Rule
    605 data (Dyhrberg/Shkilko/Werner, JFE 2025) puts the smallest price tercile at
    ~105bps round trip against 4.4bps for the S&P 500.

Between those two, erring toward HIGHER cost is the only safe direction: understating
cost is precisely how a losing system passes a backtest. When in doubt these numbers
round against us.

Commission is zero, which is correct for US retail since October 2019.
"""

# Effective HALF-spread in percent of notional, by last traded price. One SIDE.
# A sub-penny name quoted 0.0041 x 0.0043 genuinely has a ~4.8% spread, and this
# app's universe contains those, so the top tier is not hypothetical.
HALF_SPREAD_PCT = [
    (0.01,          5.00),
    (0.10,          2.50),
    (1.00,          1.20),
    (5.00,          0.35),
    (20.00,         0.12),
    (100.00,        0.04),
    (float('inf'),  0.02),
]

# Market-impact allowance per side on a retail-size order, on top of the spread.
SLIPPAGE_PCT = 0.05


def half_spread_pct(price):
    """Effective half-spread for one side, in percent. None if price is unusable."""
    try:
        p = float(price)
    except (TypeError, ValueError):
        return None
    if not (p > 0):
        return None
    for ceiling, half in HALF_SPREAD_PCT:
        if p < ceiling:
            return half
    return HALF_SPREAD_PCT[-1][1]


def side_cost_pct(price):
    """Cost of ONE side (entry or exit) in percent of notional."""
    h = half_spread_pct(price)
    return None if h is None else h + SLIPPAGE_PCT


def round_trip_cost_pct(price):
    """Cost to get in AND out, in percent of notional."""
    s = side_cost_pct(price)
    return None if s is None else 2 * s


def fill_price(price, side):
    """The price actually paid or received, after crossing the spread.

    A BUY lifts the offer and a SELL hits the bid, so the bot must never book a fill
    at the midpoint it saw. Charging cost as a separate fee AND filling at mid would
    double-count on one side and under-count on the other; modelling it as a worse
    fill price is both simpler and closer to reality, because it also makes the
    position's cost basis honest for later P/L.
    """
    p = float(price)
    s = side_cost_pct(p)
    if s is None:
        return None
    adj = p * (s / 100.0)
    return p + adj if str(side).upper() == 'BUY' else p - adj


def cost_usd(price, units):
    """Absolute cost in USD of one side, for reporting on the trade timeline."""
    s = side_cost_pct(price)
    if s is None:
        return 0.0
    return abs(float(price) * float(units)) * (s / 100.0)
