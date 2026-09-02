"""Mia 2.0's settings, and the risk limits that keep her alive.

Every default here is either derived from a measurement in this repo or is set to the
pessimistic side. Where a number was chosen rather than measured, the comment says so,
because a risk limit that looks authoritative but was guessed is worse than an obvious
placeholder.

WHY THE LIMITS EXIST (each one prevents a specific measured failure)
-------------------------------------------------------------------
  min_price_usd
      A sub-penny round trip costs 10.1% of notional (trading_costs.py tiers). ONE
      trade would erase a tenth of a sleeve regardless of whether the signal was
      right. Measured, not guessed: see the table in tools/bot_account_check.py.

  max_position_pct / max_positions
      Concentration is what turns a coin-flip edge into a blow-up. With no measured
      directional edge, position sizing is the only real control we have.

  max_trades_per_run / max_trades_per_day
      An LLM asked "what should I do?" every 15 minutes will happily churn. At a 0.2%
      round trip, 50 trades a day is a 10% loss from friction alone with no opinion
      about direction required.

  min_hold_minutes
      Stops a strategy buying and selling the same name inside one session purely
      because a score wobbled either side of a threshold. Also keeps day-trade counts
      down, which matters under PDT.

  daily_loss_halt_pct
      A kill switch. If a sleeve drops this much in a day it stops trading until the
      next day. Without one, a bug in a strategy has all day to compound.

CONFIG IS A REPO FILE, DELIBERATELY
-----------------------------------
The browser cannot write to the repo, and the bot cannot read localStorage, so settings
that BOTH need have to live in git. model/bot/config.json is the single source of truth;
the UI will read it and display it, and changing it is a commit. That is a feature for
an audit trail: every settings change is dated and attributable, so a performance shift
can always be tied to what was altered.
"""
from __future__ import annotations

import json
import os

from bot.broker import CASH, MARGIN, PLAN_LITE, PLAN_PRO_FIXED, PLAN_PRO_TIERED

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT_DIR = os.path.join(REPO, 'model', 'bot')
CONFIG_PATH = os.path.join(BOT_DIR, 'config.json')

# The sleeves. Order matters only for display.
#
# 'control' is not decoration and must never be removed. It buys an equal-weight basket
# once and never trades again, which makes it the benchmark that separates skill from a
# rising market. Yesterday I nearly reported a 20-day strategy as working when holding
# EVERYTHING returned +1.125% at t=2.93 over the same window: that was beta, and only a
# control sleeve makes it obvious on the leaderboard.
SLEEVES = [
    {
        'id': 'engine',
        'name': 'The Engine',
        'blurb': 'Our technical engine plus the LSTM, exactly as the app shows it. '
                 'The sleeve that answers "is Market Analyzer any good?"',
    },
    {
        'id': 'reversion',
        'name': 'Mean Reversion',
        'blurb': 'Buys oversold, sells strength. The one component measured with real '
                 'positive IC (+0.05, t 3.3) before costs.',
    },
    {
        'id': 'mia-ai',
        'name': "Mia's Own Call",
        'blurb': 'Mia reads the features and decides herself, with her reasoning on '
                 'every trade. Uses Gemini when a key is present, the LSTM alone when not.',
    },
    {
        'id': 'control',
        'name': 'Buy & Hold (control)',
        'blurb': 'Buys an equal-weight basket once and never trades again. The bar '
                 'every other sleeve has to clear to have earned anything.',
    },
]

DEFAULTS = {
    'schema': 1,

    # ── the account ──────────────────────────────────────────────────────────
    # 'cash' is the default because it is the stricter, more honest simulation: no
    # leverage means the P/L cannot be flattered by borrowed money, and settlement
    # limits churn. Switch to 'margin' to see leverage, interest and PDT in action.
    'accountType': CASH,
    'commissionPlan': PLAN_PRO_TIERED,   # the pricier realistic option, on purpose
    'benchmarkRatePct': 4.33,            # margin interest benchmark; MOVES, update it

    # $25,000 clears the $25k Pattern Day Trader threshold, so on a margin account Mia is
    # never day-trade restricted. It also matters for measurement: IBKR's $0.35 per-order
    # minimum is 0.11% each way on a $310 position, so at a $10k seed a real slice of the
    # reported P/L would be commission-minimum friction rather than strategy. At $25k the
    # positions are ~$780 and total drag falls to about 0.22% per round trip.
    'seedUSD': 25_000.0,                 # split equally across the sleeves

    # ── universe ─────────────────────────────────────────────────────────────
    # Mia trades a liquid subset, not the full 924-name ledger universe. Costs are the
    # reason: below $5 the round trip is 0.80% and climbing, which no measured edge in
    # this project comes close to covering.               # avoids single-share-per-order absurdities
    # Crypto trades continuously; equities only inside their own sessions. bot/sessions.py
    # is the gate. Other venues are deliberately absent until their fees are modelled:
    # UK stamp duty alone is 0.5% on every purchase, larger than any edge measured
    # anywhere in this project, so an LSE sleeve without it would be fiction.
    'markets': ['NYSE', 'CRYPTO'],
    'maxCandidates': 60,                 # top N by engine score per run

    # ── risk ─────────────────────────────────────────────────────────────────
    'risk': {
        # Only open a position whose expected value is positive AFTER the round-trip cost.
        # minEdgePct is the net-return bar in percent; 0.0 means "must at least pay for its
        # own toll". minEdgeMultiple is the weaker fallback for strategies with no calibrated
        # probability (reversion): the expected MOVE must beat cost by this multiple. Raising
        # minEdgePct makes the desk trade less and more selectively; at the engine's measured
        # ~0.5 skill it will refuse most candidates, which is the correct response to a
        # near-zero edge, not a malfunction.
        'minEdgePct': 0.0,
        'minEdgeMultiple': 1.5,

        'maxPositionPct': 12.0,          # of sleeve equity, per name
        'maxPositions': 8,
        'minTradeUSD': 100.0,            # above bot/portfolio MIN_TRADE_USD dust floor
        'maxTradesPerRun': 3,
        'maxTradesPerDay': 8,
        # DAYS. A 12-year non-overlapping SPY replay: a 1-day hold nets -0.083% per trade
        # after costs (t -4.15, -18.9% annualised) while a 20-day hold nets +0.976%
        # (t 3.08, +13.0%) and a 60-day hold +3.166% (t 3.96, +14.0%). Win rate climbs
        # monotonically from 45.6% to 81.8% purely by holding longer. The old 90-MINUTE
        # hold was the most expensive setting in this file.
        'minHoldDays': 20,
        # Only the cheapest execution tier is net-positive at any horizon. Measured across
        # 70k ledger rows: <0.20% cost turns positive by 5 days and reaches +1.72% at 20,
        # while every dearer tier gets WORSE with time. Admits megacaps, BTC and ETH.
        'maxRoundTripCostPct': 0.25,
        'dailyLossHaltPct': 6.0,
        'cashFloorPct': 5.0,             # never deploy the last of the cash
    },

    # ── decision thresholds ──────────────────────────────────────────────────
    # Deliberately demanding. The engine's measured 1-day skill is zero against the
    # majority-class baseline, so a low bar produces churn, not returns.
    # NO 'signals' BLOCK. Entry and exit thresholds are computed per run from the
    # cross-section in bot/dynamic.py, not configured. They used to live here as seven
    # hardcoded numbers (score >= 62, RSI <= 32, TP +8%, SL -5%, ...) that I picked and never
    # validated; an absolute level stops describing the market the day after it is chosen,
    # and a fixed percentage cannot be right for a 0.9%-sigma large cap and a 6%-sigma
    # altcoin at the same time. Keeping them here would invite editing a number nothing
    # reads.

    # ── cadence ──────────────────────────────────────────────────────────────
    # GitHub Actions crons fire every 5 minutes at BEST and are routinely delayed
    # 10-30 minutes under load, so "every second" is not available at any price on this
    # infrastructure. This is the honest cadence, and the bot records the real gap
    # between runs so the timeline never implies a precision it does not have.
    'cadence': {
        'runsPerDay': 12,                # crypto keeps running when equities are shut
        'note': 'GitHub Actions scheduling is best-effort: 5 min minimum, routinely '
                'delayed 10-30 min, occasionally skipped. The real gap between runs is '
                'recorded on every entry so the timeline never implies precision it '
                'does not have.',
    },

    # A wiped sleeve STAYS wiped. Roshan's reason, and it is the right one: the point is
    # for Mia to treat simulated money as real, and reseeding a failed strategy both
    # destroys the most informative result available and quietly subsidises the worst
    # performer. A dead sleeve remains on the leaderboard at zero as a permanent record.
    'reseedDeadSleeves': False,

    # ── AI ───────────────────────────────────────────────────────────────────
    'ai': {
        'model': 'gemini-2.5-flash',
        # Absent GEMINI_API_KEY the sleeve still trades, driven by the LSTM alone, and
        # says so on every trade. Nothing is blocked on a secret being added.
        'maxSymbolsPerCall': 12,
        'temperature': 0.2,              # low: we want consistency, not creativity
    },

    'enabled': True,
    'notes': 'Paper money. No broker connection exists and none is planned.',
}


def _merge(base, override):
    """Deep merge so a config file specifying one nested key keeps every other default,
    instead of silently dropping the rest of that section."""
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path=CONFIG_PATH):
    """Config from disk merged over DEFAULTS. Missing file is fine: defaults apply."""
    user = {}
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                user = json.load(f) or {}
        except Exception as e:
            print(f'[config] {path} unreadable ({type(e).__name__}); using defaults')
            user = {}
    cfg = _merge(DEFAULTS, user)
    return validate(cfg)


def validate(cfg):
    """Clamp anything that could hurt, and say so out loud.

    A config file is hand-edited, so a typo like maxPositionPct: 120 must not become a
    120%-of-equity position. Silent clamping would hide the mistake, so each correction
    prints.
    """
    def clamp(path, lo, hi):
        node = cfg
        keys = path.split('.')
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        cur = node.get(keys[-1])
        if not isinstance(cur, (int, float)):
            return
        fixed = max(lo, min(hi, float(cur)))
        if abs(fixed - float(cur)) > 1e-9:
            print(f'[config] {path}={cur} clamped to {fixed}')
            node[keys[-1]] = fixed

    if cfg.get('accountType') not in (CASH, MARGIN):
        print(f"[config] unknown accountType {cfg.get('accountType')!r}; using {CASH}")
        cfg['accountType'] = CASH
    if cfg.get('commissionPlan') not in (PLAN_LITE, PLAN_PRO_TIERED, PLAN_PRO_FIXED):
        print(f"[config] unknown commissionPlan; using {PLAN_PRO_TIERED}")
        cfg['commissionPlan'] = PLAN_PRO_TIERED

    clamp('seedUSD', 100.0, 10_000_000.0)
    clamp('maxCandidates', 5, 500)
    clamp('risk.maxPositionPct', 1.0, 50.0)
    clamp('risk.maxPositions', 1, 50)
    clamp('risk.maxTradesPerRun', 1, 20)
    clamp('risk.maxTradesPerDay', 1, 100)
    clamp('risk.minHoldDays', 0, 365)
    clamp('risk.maxRoundTripCostPct', 0.01, 10.0)
    clamp('risk.dailyLossHaltPct', 0.5, 50.0)
    clamp('risk.cashFloorPct', 0.0, 90.0)
    # No signals.* clamps. Those thresholds are computed per run, not configured, and the
    # clamp helper walks the path with setdefault -- so validating a key that no longer
    # exists silently RECREATED an empty 'signals' dict in the loaded config, making it look
    # like the setting was still live. A validator for a dead setting is worse than none.
    clamp('ai.temperature', 0.0, 2.0)
    clamp('benchmarkRatePct', 0.0, 25.0)

    # A position cap that cannot fill the allowed number of slots is contradictory:
    # 8 positions at 12% each only reaches 96%, which is fine, but 4 at 12% could never
    # deploy more than half the sleeve and would look like the bot was refusing to trade.
    reach = cfg['risk']['maxPositionPct'] * cfg['risk']['maxPositions']
    if reach < 50.0:
        print(f'[config] maxPositionPct x maxPositions = {reach:.0f}% of equity, so the '
              f'sleeve can never be more than half invested. Intentional?')
    return cfg


def write_default_config(path=CONFIG_PATH, force=False):
    """Materialise DEFAULTS to disk so the file is discoverable and editable."""
    if os.path.exists(path) and not force:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(DEFAULTS, f, indent=2, allow_nan=False)
    return True


def sleeve_defs():
    return [dict(s) for s in SLEEVES]
