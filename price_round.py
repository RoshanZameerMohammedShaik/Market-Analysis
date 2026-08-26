"""Magnitude-aware price rounding. THE one Python implementation.

Deliberately dependency-free so every layer can import it: the prediction cron,
the outcome resolver, the backtester and the band module. js/price-round.js is
the mirror.

The bug this exists to kill, in its worst observed form: record_predictions.py
stored the locked price as round(entry_price, 4). SHIB-USD trades near
$0.0000128, so the LOCKED PRICE WAS WRITTEN AS 0.0. That is not a display
problem:

  * resolve_horizon rejects `entry <= 0`, so every sub-penny row was permanently
    ungradable and silently absent from every accuracy number
  * the app still issued calls on them. SHIB-USD 2026-08-25 was a BUY whose
    recorded entry and both price targets were all 0.0
  * 51 of 1,053 live symbols are sub-penny, including 39 of 170 crypto: SHIB,
    BONK and FLOKI are among the most widely held names in the universe

The same fixed-precision mistake appeared in five places across both languages,
which is why this is a shared module rather than a fifth local helper.

Rule: 2dp at or above $1, 4dp at or above $0.01, and below that SIGNIFICANT
figures rather than decimal places. A fixed 8dp still collapses at 1e-9; sig-figs
never do, at any magnitude.
"""
import math

SIG_FIGS_BELOW_CENT = 6


def round_price(v, sig=SIG_FIGS_BELOW_CENT):
    """Round v for storage/display without ever collapsing it to zero.

    Returns None for None or non-numeric input, so callers can pass straight
    through from optional fields.
    """
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float('inf'), float('-inf')):
        return None
    av = abs(f)
    if av == 0:
        return 0.0
    if av >= 1:
        return round(f, 2)
    if av >= 0.01:
        return round(f, 4)
    # Keep `sig` significant figures. For 0.0000128 that is 0.0000128, where a
    # flat 4dp gives 0.0 and even a flat 8dp fails once the price reaches 1e-9.
    return round(f, -int(math.floor(math.log10(av))) + (sig - 1))


def decimals_for(price):
    """Display decimals appropriate to `price`, for column formatting.

    Same ladder as round_price so a table never shows fewer digits than the
    stored value actually carries.
    """
    try:
        av = abs(float(price))
    except (TypeError, ValueError):
        return 2
    if av >= 1:
        return 2
    if av >= 0.01:
        return 4
    if av == 0:
        return 2
    return min(12, -int(math.floor(math.log10(av))) + (SIG_FIGS_BELOW_CENT - 1))
