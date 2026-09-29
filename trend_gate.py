"""The trend gate: withhold the directional calls this engine has always gotten wrong.

MEASURED ON THIS ENGINE'S OWN CALLS, 12 YEARS (model/replay_panel.jsonl, 417,612 committed BUY/SELL
calls on 440 US stocks, 2014-2026, graded at one day):

    BUY, all                              187,545   50.6%
    BUY while BELOW its 200-day average   111,963   49.5%    <- 60% of all BUYs, and they lose
    BUY above its 200d, $50M+/day          52,822   53.3%    11 of 12 years at 51% or better
    SELL while ABOVE its 200-day average  160,589   48.7%    <- 70% of all SELLs, and they lose
    SELL below its 200d                    56,327   50.5%

The live ledger says the same thing independently (Jun-Sep 2026): BUYs above the 200d 53.2%,
below 50.5%, and BUYs on names with too little history for a 200-day average ~42%.

The engine's short-horizon scoring leans mean-reversion ("buy the dip"), and a dip in a downtrend
is usually the start of the next leg down. Buying dips works in uptrends. So:

    BUY  only when price is ABOVE its 200-day average, trades $50M+/day, and is at least $5
    SELL only when price is BELOW its 200-day average
    otherwise NEUTRAL, with the reason recorded on the row

US listings only (region NYSE), because that is where it was measured. Other markets keep the
ungated call until they have their own evidence.

This does not make direction predictable: 53% is the honest ceiling for a daily call, confirmed by
a 71-feature walk-forward model that reached AUC 0.519. It removes the half of the calls that were
reliably worse than a coin flip.

js/trend-gate.js mirrors this exactly; tools/trend_gate_sync_check.py holds them together.
"""
from __future__ import annotations

MIN_HISTORY = 200
MIN_PRICE = 5.0
MIN_DOLLAR_VOL = 5e7
DOLLAR_VOL_WINDOW = 20
GATED_REGIONS = frozenset({'NYSE'})

REASONS = {
    'no-history': 'fewer than 200 sessions of history, so the long-term trend is unknown',
    'below-200d': 'price is below its 200-day average (a downtrend)',
    'above-200d': 'price is above its 200-day average (an uptrend)',
    'low-price': 'price is under $5',
    'illiquid': 'it trades under $50M a day',
}


def trend_state(closes, volumes):
    """Long-term trend and liquidity from daily closes/volumes, oldest first."""
    c = [float(x) for x in closes if x is not None]
    n = len(c)
    if n < MIN_HISTORY:
        return {'known': False, 'bars': n}
    ma200 = sum(c[-MIN_HISTORY:]) / MIN_HISTORY
    px = c[-1]
    v = [float(x) if x is not None else 0.0 for x in volumes][-DOLLAR_VOL_WINDOW:]
    cc = c[-len(v):] if v else []
    dv = sum(a * b for a, b in zip(cc, v)) / len(v) if v else 0.0
    return {'known': True, 'bars': n, 'price': px, 'ma200': ma200,
            'above200': px > ma200, 'dollarVol20': dv}


def gate(signal, state, region):
    """None when the call stands; otherwise the reason key it is withheld for."""
    if str(region or '').upper() not in GATED_REGIONS or signal not in ('BUY', 'SELL'):
        return None
    if not state or not state.get('known'):
        return 'no-history'
    if signal == 'BUY':
        if not state['above200']:
            return 'below-200d'
        if state['price'] < MIN_PRICE:
            return 'low-price'
        if state['dollarVol20'] < MIN_DOLLAR_VOL:
            return 'illiquid'
        return None
    return 'above-200d' if state['above200'] else None
