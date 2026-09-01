"""Thresholds computed from the market in front of us, not typed into a config file.

WHY THIS EXISTS
---------------
Every entry and exit rule used to be a hardcoded number: buy engine score >= 62, buy RSI
<= 32, take profit at +8%, stop at -5%. Roshan asked where those came from, and the honest
answer was that I picked them. They were round numbers, never fitted and never validated.

Static thresholds are wrong in two directions at once:

  * ABSOLUTE levels do not survive a regime change. "RSI <= 32" fires on a third of the
    universe in a selloff and on nothing at all in a grind upward, so the same rule means
    "be fully invested" one month and "do nothing" the next. The number stopped describing
    the market the day after it was chosen.
  * A FIXED percentage ignores the instrument. +8% take-profit on a name whose daily sigma
    is 0.9% is a four-sigma wish; the same +8% on a 6% sigma altcoin is intraday noise. One
    number cannot be right for both, and this universe contains both.

The fix is not to TUNE the numbers. Fitting them on our own ledger is how this project
already talked itself into a fake 71.6% accuracy and a mean-reversion tilt that existed
only in leaked data. With ~8 fills a day, any adaptive loop would be chasing noise for
months, and the False Strategy Theorem says roughly 20 such attempts manufacture a false
p<0.05 on their own.

So thresholds are DERIVED instead, two ways, neither of which has a free parameter to fit:

  1. CROSS-SECTIONAL RANK. "Top decile of today's universe" instead of ">= 62". Rank is
     regime-neutral by construction: the tenth percentile is the tenth percentile in a
     crash and in a melt-up. This is also how equity factor portfolios have always been
     built, so it is a known quantity rather than an invention.

  2. THE CALIBRATED BAND. Exits come from forecastBand, whose sigma per volatility tier is
     already solved from REALIZED ledger outcomes and re-solved nightly. It is the one
     genuinely learned quantity in this codebase, and using it means take-profit and
     stop-loss adapt per symbol and per regime with no constant anywhere.

WHAT DELIBERATELY STAYS FIXED
-----------------------------
Risk rails: max positions, max trades per day, cash floor, daily loss halt. Those are not
opinions about the market, they are limits on how wrong any single opinion is allowed to
be. A rail that moves with conditions is not a rail. They stay in config.
"""
from __future__ import annotations

import math

# Percentile cut-points for entry and exit, expressed as fractions of the cross-section.
#
# These are the ONE remaining choice, and they are a portfolio-construction decision rather
# than a market prediction: "how concentrated do we want to be". A decile long book is the
# conventional factor-portfolio slice. They are not fitted to returns and must never be,
# because that is precisely the leakage this module exists to avoid.
ENTRY_PCTILE = 0.90      # act on the top decile of whatever the sleeve ranks on
EXIT_PCTILE = 0.50       # let go once it falls out of the better half
OVERSOLD_PCTILE = 0.10   # reversion buys the most beaten-down decile
RECOVERED_PCTILE = 0.70  # and releases once it has climbed back through this rank

# A cross-section needs enough names for a percentile to mean anything. Below this the
# universe is too thin to rank and the desk falls back on absolute engine semantics
# (score 50 = neutral by the engine's own definition), which is a definition rather than a
# tuned constant.
MIN_FOR_RANKING = 12
NEUTRAL_SCORE = 50.0


def _clean(values):
    return sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v))


def percentile(values, p):
    """Linear-interpolated percentile. None when there is nothing to rank.

    Written out rather than pulled from numpy so this module has no import cost in the hot
    per-run path and behaves identically to the JS side if it is ever mirrored there.
    """
    xs = _clean(values)
    if not xs:
        return None
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * max(0.0, min(1.0, float(p)))
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return xs[lo]
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


class CrossSection:
    """The distribution of every field across the symbols analysed THIS run.

    Built once per run and shared by all sleeves, so they are ranking against the same
    market rather than each computing its own view of it.
    """

    def __init__(self, candidates):
        # candidates: {symbol: analysis dict} straight from bot/advise.mjs
        self.n = len(candidates)
        self._f = {
            'score': [], 'rsi': [], 'aiProbability': [], 'percentB': [], 'atrPct': [],
        }
        for c in (candidates or {}).values():
            ind = c.get('indicators') or {}
            bb = ind.get('bb') if isinstance(ind.get('bb'), dict) else {}
            ai = c.get('ai') or {}
            self._f['score'].append(c.get('score'))
            self._f['rsi'].append(ind.get('rsi'))
            self._f['atrPct'].append(ind.get('atrPct'))
            self._f['aiProbability'].append(ai.get('probability'))
            # The engine writes percent_b in Python and percentB in JS. Accept both rather
            # than silently ranking an empty list, which would make every %B test pass.
            self._f['percentB'].append(
                bb.get('percentB') if bb.get('percentB') is not None else bb.get('percent_b'))
        self.rankable = self.n >= MIN_FOR_RANKING

    def count(self, field):
        return len(_clean(self._f.get(field, [])))

    def cut(self, field, p, fallback=None):
        """The value at percentile p, or `fallback` when the cross-section is too thin."""
        if not self.rankable:
            return fallback
        v = percentile(self._f.get(field, []), p)
        return fallback if v is None else v

    def rank_of(self, field, value):
        """Where `value` sits in this run's distribution, 0..1. None if unrankable."""
        xs = _clean(self._f.get(field, []))
        if not xs or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        below = sum(1 for x in xs if x < value)
        equal = sum(1 for x in xs if x == value)
        # Midpoint of the tied block, so a field with many identical values (dispersion 0.0
        # is common in this data) does not report everything at rank 0 or rank 1.
        return (below + equal / 2.0) / len(xs)

    def breadth(self):
        """Median engine score across the universe: one number for "how good is today".

        Used to scale gross exposure. A top-decile name in a universe whose median has
        collapsed is still only the best of a bad set, and a purely relative rule would
        happily stay fully invested through that.
        """
        return percentile(self._f['score'], 0.5)

    def summary(self):
        """Recorded on every run so a decision can be replayed against the distribution it
        was actually made in. Without this, a threshold that moves is unauditable."""
        return {
            'symbols': self.n,
            'rankable': self.rankable,
            'breadthMedianScore': _r(self.breadth()),
            'scoreP90': _r(self.cut('score', ENTRY_PCTILE)),
            'scoreP50': _r(self.cut('score', EXIT_PCTILE)),
            'rsiP10': _r(self.cut('rsi', OVERSOLD_PCTILE)),
            'rsiP70': _r(self.cut('rsi', RECOVERED_PCTILE)),
            'aiP90': _r(self.cut('aiProbability', ENTRY_PCTILE), 4),
            'atrPctMedian': _r(percentile(self._f['atrPct'], 0.5)),
        }


def _r(v, dp=2):
    return round(v, dp) if isinstance(v, (int, float)) and math.isfinite(v) else None


# ── exits derived from the calibrated band ───────────────────────────────────

def band_exit_levels(cand, avg_cost):
    """Take-profit and stop-loss prices for one holding, from its own forecast band.

    Replaces takeProfitPct 8.0 / stopLossPct 5.0. The band's sigma is solved per volatility
    tier from realized ledger outcomes and re-solved nightly, so this is the only exit rule
    in the desk that is genuinely learned from what actually happened rather than asserted.

    Anchored on AVERAGE COST, not on the band's own centre. The band is centred on the
    current price, so using its raw levels would move the stop up every time the price rose
    and the position could never take a loss on paper. A stop has to be fixed relative to
    what was paid.

    Returns (tp_price, sl_price, evidence) or (None, None, reason) when the band is missing,
    in which case the caller falls back on the ATR path below. Never invents a level: an
    exit rule that silently defaults to a constant is the bug this module exists to remove.
    """
    band = cand.get('band') or {}
    day1 = band.get('day1') or {}
    lo, hi = day1.get('low'), day1.get('high')
    px = cand.get('price')
    if not all(isinstance(x, (int, float)) and x > 0 for x in (lo, hi, px, avg_cost)):
        return None, None, {'reason': 'no usable band'}
    if hi <= px or lo >= px:
        return None, None, {'reason': 'degenerate band'}

    # Convert the band to fractional moves, then apply them to cost basis.
    up = (hi - px) / px
    down = (px - lo) / px
    tp = avg_cost * (1.0 + up)
    sl = avg_cost * (1.0 - down)
    return tp, sl, {
        'source': 'calibrated-band' if band.get('calibrated') else 'uncalibrated-band',
        'volTier': band.get('tier'),
        'bandConfidence': band.get('confidence'),
        'tpMovePct': round(up * 100, 3),
        'slMovePct': round(-down * 100, 3),
    }


def atr_exit_levels(cand, avg_cost):
    """Fallback when there is no band: scale the exits by the symbol's own ATR%.

    Still volatility-relative and still free of a fixed percentage. The 2:1 reward-to-risk
    shape is a position-management convention, not a fitted value -- it says "give a winner
    more room than a loser", which is a statement about how to hold a position rather than a
    prediction about returns.
    """
    atr = (cand.get('indicators') or {}).get('atrPct')
    if not isinstance(atr, (int, float)) or not (atr > 0) or not (avg_cost > 0):
        return None, None, {'reason': 'no ATR either'}
    atr = min(float(atr), 25.0) / 100.0   # cap: a broken ATR must not set a 300% target
    return (avg_cost * (1 + 2.0 * atr), avg_cost * (1 - 1.0 * atr),
            {'source': 'atr', 'atrPct': round(atr * 100, 3),
             'tpMovePct': round(200.0 * atr, 3), 'slMovePct': round(-100.0 * atr, 3)})


def exit_levels(cand, avg_cost):
    tp, sl, ev = band_exit_levels(cand, avg_cost)
    if tp is not None:
        return tp, sl, ev
    return atr_exit_levels(cand, avg_cost)


# ── volatility-scaled position sizing ────────────────────────────────────────

def risk_parity_size_usd(equity, slots, sigma_pct, risk_budget_pct):
    """Size so every position risks the SAME dollars, not the same notional.

    A flat 12%-of-equity bite means a 6%-sigma altcoin contributes roughly six times the
    portfolio variance of a 1%-sigma large cap, so the book's risk ends up decided by
    whichever volatile name happened to signal. Scaling notional by 1/sigma equalises the
    contribution, which is the standard construction and needs no fitting.

    risk_budget_pct is a RAIL from config, not a signal: it says how much of the sleeve may
    be at risk per slot, and it does not move with the market.
    """
    if not (equity > 0) or slots <= 0:
        return 0.0
    target_risk = equity * (float(risk_budget_pct) / 100.0) / float(slots)
    if not isinstance(sigma_pct, (int, float)) or not (sigma_pct > 0):
        # No volatility estimate: fall back to an equal slice. Deliberately NOT the biggest
        # allowed bite -- an unmeasurable name should not get the largest position.
        return equity / float(slots)
    # Floor sigma so a suspiciously calm name cannot demand an enormous position.
    return target_risk / max(float(sigma_pct) / 100.0, 0.0025)


def exposure_scale(breadth_median, trailing_medians):
    """Scale gross exposure by how today's breadth compares with its own recent history.

    Pure cross-sectional ranking is always fully invested: the top decile exists on the
    worst day of a bear market too. This is the counterweight, and it is computed rather
    than asserted -- today's median engine score is ranked against the trailing medians the
    ledger already recorded, and exposure follows that rank.

    Returns 1.0 when there is no history to compare against, so a fresh desk behaves
    normally instead of refusing to trade.
    """
    xs = _clean(trailing_medians or [])
    if not isinstance(breadth_median, (int, float)) or len(xs) < 10:
        return 1.0
    below = sum(1 for x in xs if x < breadth_median)
    rank = below / len(xs)
    # Linear from a quarter of normal size at the worst breadth on record to full size at
    # the best. Endpoints, not a curve fit.
    return round(0.25 + 0.75 * rank, 4)


# ── is this name economically worth trading at all? ──────────────────────────

def expected_move_pct(row):
    """Half the forecast band's day-1 width: the move we actually expect, in percent.

    Half, not the full width, because the band is a two-sided interval around the current
    price and a long-only desk only captures one side of it.
    """
    band = row.get('forecastBand') or row.get('band') or {}
    days = band.get('days') or []
    day1 = days[0] if days else band.get('day1')
    if isinstance(day1, dict):
        w = day1.get('widthPct')
        if isinstance(w, (int, float)) and w > 0:
            return w / 2.0
        lo, hi = day1.get('low'), day1.get('high')
        px = row.get('entry') or row.get('price')
        if all(isinstance(x, (int, float)) and x > 0 for x in (lo, hi, px)):
            return (hi - lo) / 2.0 / px * 100.0
    return None


def is_tradeable(row, round_trip_cost_pct_fn):
    """Can this name's expected move even cover the cost of trading it?

    Replaces the minPriceUSD 5 / maxPriceUSD 2000 band, which was doing two jobs badly:

      * maxPriceUSD excluded BTC and every four-figure name for no reason at all. The desk
        trades FRACTIONAL units, so a high unit price is irrelevant to whether a position
        can be sized.
      * minPriceUSD 5 was a proxy for "wide spread", and a bad one. Price is only loosely
        related to spread, and the real question is never the price -- it is whether the
        expected move clears the round trip. Charging the spread properly and then ALSO
        screening on price double-counts the same worry while still admitting expensive
        names and rejecting cheap liquid ones.

    The test here is an identity rather than a tuned threshold: an edge smaller than its own
    execution cost is not an edge. This is the screen that matters at this signal strength,
    where the engine's gross edge per trade measures +0.06% to +0.16% against a cheapest
    possible round trip of 0.14%.

    Returns (ok, reason, detail) so refusals stay auditable.
    """
    px = row.get('entry') or row.get('price')
    if not isinstance(px, (int, float)) or px <= 0:
        return False, 'no price', None
    cost = round_trip_cost_pct_fn(px, row.get('symbol'))
    if cost is None:
        return False, 'no cost model', None
    move = expected_move_pct(row)
    if move is None:
        # No band yet. Do NOT reject: a newly listed name has no calibration history and
        # excluding it forever would quietly freeze the universe to whatever was present when
        # calibration first ran. Cost is still charged on the fill.
        return True, 'no band yet, admitted on cost alone', {'roundTripPct': round(cost, 4)}
    if move <= cost:
        return False, 'expected move below round-trip cost', {
            'expectedMovePct': round(move, 4), 'roundTripPct': round(cost, 4)}
    # NOT called edgeRatio. The band's width is a VOLATILITY interval, not a directional
    # forecast, so "expected move exceeds cost" is a necessary condition for a trade to be
    # able to pay for itself -- it is not evidence that it will. Naming it edge would repeat
    # exactly the overclaim that let this project believe in 71.6% accuracy: a number that
    # measured one thing, labelled as though it measured another.
    return True, 'ok', {'expectedMovePct': round(move, 4), 'roundTripPct': round(cost, 4),
                        'moveToCostRatio': round(move / cost, 3)}
