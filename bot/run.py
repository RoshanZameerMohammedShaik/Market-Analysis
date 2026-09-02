"""Mia 2.0's desk: the one entry point that turns analysis into trades.

    python bot/run.py                 # a real run
    python bot/run.py --dry-run       # decide and report, write nothing
    python bot/run.py --reset         # wipe the account back to seed

THE SPLIT, AND WHY
------------------
bot/advise.mjs THINKS (the app's real engine plus Mia's LLM) and this file ACTS. A
strategy returns intents; only this file touches money. So a bug in a strategy or a
hallucination from the LLM cannot spend anything: every intent passes the broker rules and
the risk limits below before it becomes a fill.

WHAT GETS WRITTEN
-----------------
  model/bot/state.json    authoritative account: sleeves, cash, positions, broker state
  model/bot/trades.jsonl  the timeline. One row per FILL, with the reasoning and evidence
  model/bot/runs.jsonl    one row per RUN, including runs that traded nothing

runs.jsonl matters as much as trades.jsonl. Roshan asked to see when and why she traded;
seeing that she looked and deliberately did nothing is the same question answered, and
without it a quiet week is indistinguishable from a broken cron.

GUARDS, EACH FOR A NAMED FAILURE
--------------------------------
  session gate      Trading NYSE at 3am books fills against a stale close that could never
                    have happened. bot/sessions.py decides; crypto is exempt.
  stale-price       Even inside a session, a quote older than maxPriceAgeMin is refused. A
                    decision made on an hour-old price is not the decision it claims.
  holiday-by-data   No exchange calendar is bundled: they rot and differ per venue. If a
                    market says open but its freshest bar is not from today, it is closed.
                    Self-maintaining, and it also catches half-days and feed outages.
  dead sleeve       A wiped sleeve stays wiped (config reseedDeadSleeves=false) and is
                    skipped, not revived. A wipe is the most informative result available.
  daily loss halt   A sleeve down more than dailyLossHaltPct today stops until tomorrow, so
                    a strategy bug has minutes rather than a whole session.
  min hold          Stops churn when a score wobbles across a threshold, and keeps day-trade
                    counts down under PDT.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.broker import CASH, BrokerAccount, broker_fees_usd            # noqa: E402
from bot.config import BOT_DIR, CONFIG_PATH, load_config, sleeve_defs  # noqa: E402
from bot.portfolio import MIN_TRADE_USD, BotAccount, Sleeve, utc_now_iso  # noqa: E402
from bot.sessions import CRYPTO, market_of, open_markets, describe_week, minutes_to_close  # noqa: E402
import bot.strategies as strategies                                    # noqa: E402
from bot.learn import learn, load_learned                              # noqa: E402
from bot.dynamic import (CrossSection, exposure_scale, expected_move_pct,  # noqa: E402
                         expected_value_pct, is_tradeable, risk_parity_size_usd)
from trading_costs import round_trip_cost_pct                          # noqa: E402
import ledger_store                                                    # noqa: E402

STATE_PATH = os.path.join(BOT_DIR, 'state.json')
TRADES_PATH = os.path.join(BOT_DIR, 'trades.jsonl')
RUNS_PATH = os.path.join(BOT_DIR, 'runs.jsonl')
REQ_PATH = os.path.join(BOT_DIR, '_request.json')
ADV_PATH = os.path.join(BOT_DIR, '_advice.json')
RECENT_SLICE = os.path.join(REPO, 'model', 'ledger', 'recent.json')

# Fraction of the gap to a learned target that moves per run. A rate limit so the book
# converges over several cycles rather than lurching on one noisy reading.
REBALANCE_STEP = 0.25
# Below this, a transfer is not worth the log line it would print.
MIN_REBALANCE_USD = 25.0

# A quote older than this is refused even during a session.
MAX_PRICE_AGE_MIN = 20
# Do not OPEN a position with less than this left in the session: an entry that cannot be
# managed until the next open is a different bet from the one the strategy intended.
NO_NEW_ENTRIES_WITHIN_MIN = 15


def log(msg):
    print(f'[bot] {msg}', flush=True)


# ── universe ─────────────────────────────────────────────────────────────────
def candidate_universe(cfg, held, live_markets):
    """Which symbols to analyse this run.

    Analysing the full 924-name ledger universe at ~500ms each would take six minutes,
    which does not fit a 15-minute cadence with everything else. So the LEDGER's own recent
    rows are used as a cheap prior: they already carry a price and a weightedScore per
    symbol, computed at that market's open by the cron. Names are ranked on that stored
    score, and the top maxCandidates are re-analysed FRESH by the real engine before any
    decision. The prior only chooses who to look at; it never decides anything.

    Held positions are always included regardless of rank, or Mia could not sell what she
    already owns.
    """
    rows = []
    src = None
    if os.path.exists(RECENT_SLICE):
        try:
            with open(RECENT_SLICE, encoding='utf-8') as f:
                blob = json.load(f)
            # recent.json is an ENVELOPE: {generatedAt, cutoffDate, days, sourceRows,
            # rows: [...]}. Assuming a bare list crashed on the first iteration with
            # "'str' object has no attribute 'get'", because iterating the dict yielded
            # its KEYS. Both shapes are accepted so a future slice-format change cannot
            # silently empty the universe and make the desk look idle.
            rows = blob.get('rows', []) if isinstance(blob, dict) else (blob or [])
            src = f'recent.json ({len(rows)} rows)'
        except Exception as e:
            log(f'recent.json unreadable ({type(e).__name__}); falling back')
            rows = []
    if not rows:
        # Fallback only. The ledger is sharded by month (a single year file hit GitHub's hard
        # 100 MB blob limit and broke every push), and iter_rows prunes whole shards below the
        # cutoff before opening them, so this fallback is no longer the 97 MB scan it was.
        cutoff = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
        rows = list(ledger_store.iter_rows(since=cutoff))
        src = f'ledger shards since {cutoff}'

    # ECONOMIC screen, not a price band. minPriceUSD/maxPriceUSD used to decide this, and
    # both were wrong: maxPriceUSD 2000 excluded BTC and every four-figure name even though
    # the desk trades fractional units, and minPriceUSD 5 was a crude proxy for "wide spread"
    # while the spread is already charged properly on the fill. The real question is whether
    # a name's expected move clears its own round trip, which is an identity rather than a
    # tuned threshold. On the current universe this admits 264 names where the price band
    # admitted 169, and every rejection has a reason attached.
    best, skipped = {}, {}
    for r in rows:
        sym = r.get('symbol')
        if not sym or market_of(sym) not in live_markets:
            continue
        ok, why, _detail = is_tradeable(r, round_trip_cost_pct)
        if not ok:
            skipped[why] = skipped.get(why, 0) + 1
            continue
        # HARD EXECUTION-COST CAP. Measured, not chosen: net return after one round trip,
        # by cost tier, across 70k ledger rows --
        #     <0.20% cost:  1d -0.14   5d +0.11   10d +0.52   20d +1.72
        #     0.2-0.5%:     1d -0.44   5d -0.63   10d -0.72   20d -1.20
        #     0.5-1.5%:     1d -0.97   5d -1.53   10d -1.80   20d -2.91
        #     >4%:          1d -9.65   5d -9.84   10d -10.34  20d -13.90
        # The cheapest tier is the ONLY one that turns positive, and every other tier gets
        # WORSE with holding period because no holding period outruns a 10% toll. Cost tier
        # decides the sign; time only amplifies whatever sign you started with.
        cost_pct = round_trip_cost_pct(r.get('entry'), sym)
        cap = float(cfg['risk'].get('maxRoundTripCostPct', 0.25))
        if cost_pct is None or cost_pct > cap:
            k = f'round trip {cost_pct:.2f}% over the {cap:.2f}% cap' if cost_pct else 'no cost'
            skipped[k] = skipped.get(k, 0) + 1
            continue
        px = r.get('entry')
        score = r.get('weightedScore')
        if score is None:
            score = ((r.get('breakdown') or {}).get('technical') or {}).get('score')
        d = r.get('date') or ''
        prev = best.get(sym)
        # Keep the most recent row per symbol.
        if not prev or d > prev[0]:
            best[sym] = (d, score if isinstance(score, (int, float)) else 50.0)

    ranked = sorted(best.items(), key=lambda kv: -kv[1][1])
    picked = [s for s, _ in ranked[:int(cfg['maxCandidates'])]]
    # Held names last-in so they are never crowded out by the cap.
    for s in held:
        if s not in picked and market_of(s) in live_markets:
            picked.append(s)
    log(f'universe: {len(picked)} candidates from {len(best)} tradeable '
        f'({src or "no ledger"}), markets={live_markets}')
    if skipped:
        log(f'  screened out: {skipped}')
    return picked


def breadth_history(limit=60):
    """Median engine score from previous runs, for the exposure throttle.

    Read from runs.jsonl, which already records the cross-section summary, so nothing extra
    has to be stored. Returns [] on a fresh desk, and exposure_scale treats an empty or short
    history as "no opinion" and returns full size -- a new desk must trade normally rather
    than refuse to until it has accumulated statistics.
    """
    if not os.path.exists(RUNS_PATH):
        return []
    out = []
    try:
        with open(RUNS_PATH, encoding='utf-8') as f:
            rows = collections.deque(f, maxlen=limit)
        for line in rows:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            b = ((r.get('crossSection') or {}).get('breadthMedianScore'))
            if isinstance(b, (int, float)):
                out.append(b)
    except OSError:
        return []
    return out


# ── account bootstrap ────────────────────────────────────────────────────────
# Four sleeves split the allocation evenly, and each sleeve still has to clear
# portfolio.MIN_TRADE_USD per fill. Below this the pot cannot buy anything and the desk
# would look broken rather than small.
MIN_ALLOCATION_USD = 400.0


def set_armed(armed, allocation_usd):
    """Persist the arm state into model/bot/config.json.

    Written to the CONFIG rather than to state.json because it is a user decision, not
    accounting. It has to survive a --reset (which wipes the book) without the desk
    silently re-arming itself, and it has to be readable by the browser: the UI reads it
    back out of timeline.json to decide whether to show the Start button or the desk.
    """
    with open(CONFIG_PATH, encoding='utf-8') as f:
        cfg = json.load(f)
    cfg['armed'] = bool(armed)
    cfg['allocationUSD'] = round(float(allocation_usd), 2) if allocation_usd else None
    cfg['armedAt'] = utc_now_iso() if armed else None
    tmp = CONFIG_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2, allow_nan=False)
    os.replace(tmp, CONFIG_PATH)


def load_or_create(cfg):
    acct = BotAccount.load(STATE_PATH)
    if acct:
        return acct, False
    # Seeded from the allocation the USER chose, never from a default in the config file.
    # cfg['seedUSD'] survives only as the amount the UI pre-fills in the Start dialog; if
    # it were still the seed, deploying the workflow would open a book on its own, which
    # is exactly what happened the first time.
    alloc = float(cfg['allocationUSD'])
    defs = sleeve_defs()
    per = alloc / len(defs)
    sleeves = {d['id']: Sleeve(d['id'], d['name'], cash_usd=per, blurb=d['blurb'])
               for d in defs}
    log(f'opening the book Roshan allocated: ${alloc:,.2f} across {len(defs)} sleeves '
        f'(${per:,.2f} each)')
    return BotAccount(seed_usd=alloc, sleeves=sleeves), True


class PrecomputedLLM:
    """Adapter so MiaAIStrategy can consume decisions the Node advisor already fetched.

    The LLM call happens in bot/advise.mjs, on the same runner in the same job, because
    that is where Mia's prompt and the real engine live. Python never calls Gemini, which
    keeps exactly one place able to talk to it.
    """

    def __init__(self, decisions):
        self._decisions = decisions or []

    def decide(self, snapshot, sleeve, cfg):
        return self._decisions


def prices_for_rebalance(acct, cfg):
    """Marks for the rebalance, taken from the last saved state rather than a fresh fetch.

    Rebalancing moves CASH only, so it does not need live prices to be correct -- it needs a
    consistent view of each sleeve's equity. Using cost basis where a price is missing (which
    Sleeve.holdings_value_usd already does) keeps a quote failure from making a sleeve look
    like it lost everything and triggering a large spurious transfer.
    """
    return {}


def rebalance_sleeves(acct, learned, prices, cfg):
    """Move FREE CASH toward the capital weights the learner has earned.

    Three deliberate limits, because reallocating on past performance is the classic way to
    chase noise:

      * CASH ONLY. Positions are never force-closed to hit a target. A rebalance that
        liquidated holdings would pay the spread twice for an accounting preference and could
        realize a loss purely to satisfy a weight.
      * RATE LIMITED. At most REBALANCE_STEP of the gap moves per run, so the book converges
        over several cycles instead of lurching on one noisy reading. This is a rate limit,
        not a tuned parameter: any value below 1.0 has the same qualitative effect.
      * THE CONTROL SLEEVE IS EXCLUDED. Its capital must stay put or it stops being a
        benchmark. bot/learn.py never emits a weight for it; this skips it regardless.

    Does nothing at all when no sleeve has actionable evidence, which is the normal state.
    """
    per = (learned or {}).get('perSleeve') or {}
    weights = {sid: ls.get('capitalWeight') for sid, ls in per.items()
               if not ls.get('frozen') and isinstance(ls.get('capitalWeight'), (int, float))}
    if not weights or not (learned or {}).get('acting'):
        return
    active = {sid: acct.sleeves[sid] for sid in weights if sid in acct.sleeves}
    if len(active) < 2:
        return

    total = sum(sl.equity_usd(prices) for sl in active.values())
    if total <= 0:
        return
    wsum = sum(weights[sid] for sid in active) or 1.0

    # Work out every sleeve's surplus or shortfall, then move the smaller of what the donors
    # can spare and what the receivers need, so cash is never created or destroyed.
    floor_pct = float(cfg['risk']['cashFloorPct']) / 100.0
    give, want = {}, {}
    for sid, sl in active.items():
        target = total * (weights[sid] / wsum)
        gap = sl.equity_usd(prices) - target
        if gap > 0:
            spare = max(0.0, sl.cash_usd - sl.equity_usd(prices) * floor_pct)
            give[sid] = min(gap, spare) * REBALANCE_STEP
        elif gap < 0:
            want[sid] = -gap * REBALANCE_STEP

    pool = sum(give.values())
    need = sum(want.values())
    moved = min(pool, need)
    if moved < MIN_REBALANCE_USD:
        return

    for sid, amt in give.items():
        if pool > 0:
            acct.sleeves[sid].cash_usd -= moved * (amt / pool)
    for sid, amt in want.items():
        if need > 0:
            acct.sleeves[sid].cash_usd += moved * (amt / need)
    log(f'rebalanced ${moved:,.2f} toward the learned weights '
        f'({ {k: round(v, 3) for k, v in weights.items()} })')


# ── risk + broker gate ───────────────────────────────────────────────────────
def approve(intent, sleeve, broker, cfg, prices, state_meta, today, traded_today,
            snapshot=None):
    """(approved, size_usd, reason). Reason is recorded either way, because a refused
    intent is part of the audit trail Roshan asked for: seeing that a strategy WANTED to
    buy and the account said no is as informative as the fill."""
    risk = cfg['risk']
    sym = intent.symbol
    px = prices.get(sym)
    if not isinstance(px, (int, float)) or px <= 0:
        return False, 0.0, 'no usable price'

    if intent.action == 'SELL':
        if sleeve.units(sym) <= 0:
            return False, 0.0, 'no position to sell'
        held_since = state_meta.get('openedAt', {}).get(f'{sleeve.id}:{sym}')
        # STOP-LOSS may always fire: it is a risk control, not an opinion. TAKE-PROFIT no
        # longer bypasses the hold, because taking a small profit early is exactly the churn
        # that made 1-day holds lose 18.9% annualised while 60-day holds made 14.0%. A
        # winner has to be allowed to keep working.
        if held_since and intent.evidence.get('rule') not in ('stop-loss',):
            try:
                age = (datetime.datetime.now(datetime.timezone.utc)
                       - datetime.datetime.fromisoformat(held_since.replace('Z', '+00:00'))
                       ).total_seconds() / 60
                # DAYS, not minutes. The 90-minute hold was the single most expensive
                # setting in the desk: a 12-year non-overlapping replay of SPY nets
                # -0.083% per 1-day trade (t -4.15, -18.9% annualised) and +0.976% per
                # 20-day trade (t 3.08, +13.0% annualised). Same asset, same signal; the
                # entire difference is how often the toll is paid.
                min_minutes = float(risk.get('minHoldDays', 20)) * 24 * 60
                if age < min_minutes:
                    return False, 0.0, (f'min hold: {age / 1440:.1f} of '
                                        f'{risk.get("minHoldDays", 20)} days elapsed')
            except Exception:
                pass
        ok, why = broker.check_sell(sym, today, sleeve.equity_usd(prices))
        if not ok:
            return False, 0.0, why
        return True, sleeve.units(sym), 'approved'

    # ── BUY ──
    if len(sleeve.positions) >= risk['maxPositions'] and sym not in sleeve.positions:
        return False, 0.0, f'at max positions ({risk["maxPositions"]})'
    if traded_today >= risk['maxTradesPerDay']:
        return False, 0.0, f'daily trade cap ({risk["maxTradesPerDay"]}) reached'

    mkt = market_of(sym)
    left = minutes_to_close(mkt)
    if left is not None and left < NO_NEW_ENTRIES_WITHIN_MIN:
        return False, 0.0, (f'{left}m to close: too late to open a position that cannot '
                            f'be managed until the next session')

    # EXECUTION-COST CAP, enforced again HERE and not only when picking the universe.
    # Held positions are deliberately exempt from the universe screen so she can always SELL
    # what she owns, which means expensive legacy names still reach this function. Without
    # this check a BUY could top one of them up at a 6% round trip.
    rt_cost = round_trip_cost_pct(px, sym)
    cost_cap = float(risk.get('maxRoundTripCostPct', 0.25))
    if rt_cost is None or rt_cost > cost_cap:
        return False, 0.0, (f'round trip {rt_cost:.2f}% exceeds the {cost_cap:.2f}% cap; only the cheapest '
                            f'execution tier is net-positive at any holding period')

    # ONLY TRADE WHEN THE SYSTEM EXPECTS A PROFIT AFTER COSTS.
    #
    # Roshan asked for this directly. The honest form is expected value: capture (2*p_up-1)
    # of the expected move and subtract the toll that is known exactly. The direction comes
    # from whatever the sleeve actually used -- the AI probability, or the engine score as a
    # 0-1 bullish reading -- and the move comes from the calibrated band.
    #
    # This is where the desk's losses were coming from: 35 fills, $85 of commission, and a
    # per-trade edge the research put at +0.06% to +0.16% against a ~0.9% crypto round trip.
    # The gate refuses any BUY whose expected net is below minEdgePct, so a trade has to
    # clear its own toll with room to spare before real money moves.
    #
    # The control sleeve is EXEMPT: it buys once and holds as the benchmark, and gating it
    # would stop it being the thing every other sleeve is measured against. A strategy with
    # no probability to offer (reversion is RSI-based) falls back to requiring the expected
    # move to beat the cost by minEdgeMultiple -- necessary, not as strong, and labelled so.
    cand = ((snapshot or {}).get('candidates') or {}).get(sym) or {}
    min_edge_pct = float(risk.get('minEdgePct', 0.0))
    min_mult = float(risk.get('minEdgeMultiple', 1.5))
    if sleeve.id != 'control':
        move = expected_move_pct(cand)
        cost = round_trip_cost_pct(px, sym)
        ev = intent.evidence or {}
        p_up = ev.get('aiProbability')
        if p_up is None and isinstance(ev.get('score'), (int, float)):
            p_up = ev['score'] / 100.0
        exp_val = expected_value_pct(p_up, move, cost)
        if exp_val is not None:
            intent.evidence['expectedValuePct'] = round(exp_val, 4)
            intent.evidence['pUp'] = round(float(p_up), 4)
            if exp_val < min_edge_pct:
                return False, 0.0, (f'expected value {exp_val:+.2f}% after a {cost:.2f}% round trip '
                                    f'(p_up {p_up:.2f}, move {move:.2f}%) is below the '
                                    f'{min_edge_pct:.2f}% bar -- not worth the toll')
        elif move is not None and cost is not None:
            # No calibrated probability: fall back to a volatility-vs-cost margin.
            intent.evidence['moveToCostRatio'] = round(move / cost, 3) if cost else None
            if move < cost * min_mult:
                return False, 0.0, (f'expected move {move:.2f}% is under {min_mult:g}x the '
                                    f'{cost:.2f}% round trip -- no margin for a profit')

    equity = sleeve.equity_usd(prices)

    # SIZE BY RISK, NOT BY NOTIONAL.
    #
    # A flat percentage of equity meant a 6%-sigma altcoin contributed roughly six times the
    # portfolio variance of a 1%-sigma large cap, so the book's actual risk was decided by
    # whichever volatile name happened to signal that run. Scaling notional by 1/sigma
    # equalises the contribution across names.
    #
    # maxPositionPct stays as a hard CAP. It is a rail, not a signal: it bounds how wrong any
    # single position can be, and a rail that moves with conditions is not a rail.
    sigma_pct = (cand.get('indicators') or {}).get('atrPct')
    parity = risk_parity_size_usd(equity, risk['maxPositions'], sigma_pct,
                                  risk['maxPositionPct'])
    # Conviction is a cross-sectional rank now, so this scales the bite by how good the name
    # is relative to the alternatives that were actually available this run.
    want = parity * (0.5 + 0.5 * intent.conviction)

    # Breadth throttle. Pure ranking is always fully invested, because a top decile exists on
    # the worst day of a bear market too. Exposure is scaled by where today's median score
    # sits against the medians the ledger has already recorded, so a universally bad tape
    # produces smaller positions rather than the same ones.
    scale = exposure_scale((snapshot or {}).get('breadth'),
                           (snapshot or {}).get('breadthHistory'))
    want *= scale

    cap = equity * risk['maxPositionPct'] / 100.0
    want = min(want, cap)
    if intent.size_hint_pct:
        want = equity * float(intent.size_hint_pct) / 100.0
    floor_cash = equity * risk['cashFloorPct'] / 100.0
    spendable = max(0.0, sleeve.cash_usd - floor_cash)
    size = min(want, spendable)
    if size < risk['minTradeUSD']:
        return False, 0.0, (f'size ${size:,.2f} below the ${risk["minTradeUSD"]:,.0f} '
                            f'minimum (cash ${sleeve.cash_usd:,.2f}, '
                            f'floor ${floor_cash:,.2f}, atr {sigma_pct}, '
                            f'exposure x{scale})')
    intent.evidence.setdefault('sizing', {
        'atrPct': round(sigma_pct, 3) if isinstance(sigma_pct, (int, float)) else None,
        'riskParityUSD': round(parity, 2),
        'exposureScale': scale,
        'capUSD': round(cap, 2),
        'finalUSD': round(size, 2),
    })
    ok, why = broker.check_buy(size, sleeve.cash_usd, equity)
    if not ok:
        return False, 0.0, why
    return True, size, 'approved'


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='decide and report, write nothing')
    ap.add_argument('--reset', action='store_true', help='wipe the account back to seed')
    ap.add_argument('--skip-advise', action='store_true',
                    help='reuse the last _advice.json (for debugging only)')
    ap.add_argument('--arm', type=float, metavar='USD',
                    help='START the desk with this allocation, in USD. Until this is run '
                         'the desk does nothing at all.')
    ap.add_argument('--disarm', action='store_true',
                    help='stop the desk trading. Keeps positions and history.')
    args = ap.parse_args()

    cfg = load_config()
    os.makedirs(BOT_DIR, exist_ok=True)
    started = datetime.datetime.now(datetime.timezone.utc)
    today = started.date()

    if args.reset:
        for p in (STATE_PATH, TRADES_PATH, RUNS_PATH):
            if os.path.exists(p):
                os.remove(p)
        log('account reset: state, trades and runs removed')
        return

    if args.disarm:
        set_armed(False, None)
        log('DISARMED. The desk will not trade until it is armed again. Positions and '
            'history are left untouched.')
        return

    if args.arm is not None:
        amount = float(args.arm)
        if amount < MIN_ALLOCATION_USD:
            log(f'refusing to arm with ${amount:,.2f}: below the ${MIN_ALLOCATION_USD:,.0f} '
                f'minimum. Four sleeves split the allocation, and each one still has to clear '
                f'the ${MIN_TRADE_USD:.0f} minimum trade size, so a smaller pot cannot trade.')
            sys.exit(1)
        if os.path.exists(STATE_PATH):
            log('refusing to arm: the desk already has an account. Use --reset first if you '
                'really want to start over, which permanently discards the trade history.')
            sys.exit(1)
        set_armed(True, amount)
        log(f'ARMED with ${amount:,.2f}. The desk will begin trading on its next scheduled '
            f'run.')
        return

    if not cfg.get('enabled', True):
        log('disabled in config; nothing to do')
        return

    # ── the desk does NOTHING until Roshan starts it ──
    #
    # It used to self-seed from cfg['seedUSD'] the first time load_or_create found no
    # state.json, which meant merely landing the cron on main was enough to open a
    # $25,000 book and execute 11 fills. Nobody asked it to. Allocating capital is the
    # user's decision, not a side effect of deploying a workflow.
    #
    # Deliberately returns WITHOUT recording a run row. An hourly "still not armed" row
    # would append 24 rows a day, and every one would be a commit and a possible
    # Cloudflare Pages build, so the disarmed state would cost more than the running one.
    # The UI reads `armed` out of the config block in timeline.json instead, which is a
    # fact about configuration and does not belong in a log of things that happened.
    if not cfg.get('armed'):
        log('NOT ARMED. Waiting for a starting allocation. Nothing to do.')
        return
    if not cfg.get('allocationUSD'):
        log('armed but allocationUSD is missing or zero; refusing to trade on an '
            'undefined pot.')
        return

    # ── session gate ──
    live, closed = open_markets(cfg['markets'])
    for m, why in closed.items():
        log(f'closed: {m}: {why}')
    if not live:
        record_run(cfg, None, started, live, closed, [], [],
                   note='all configured markets closed', dry=args.dry_run)
        log(f'no market open. {describe_week(cfg["markets"])}')
        return
    log(f'open markets: {live}')

    acct, created = load_or_create(cfg)
    broker = BrokerAccount.from_dict(getattr(acct, '_broker', None) or {
        'accountType': cfg['accountType'], 'plan': cfg['commissionPlan'],
        'benchmarkRatePct': cfg['benchmarkRatePct']})
    # Settlement and interest advance once per run, before any decision, so buying power
    # reflects today rather than yesterday.
    released = broker.settle_due(today)
    if released:
        log(f'settled ${released:,.2f} of previously unsettled proceeds')
        # Released cash goes back to the sleeves proportionally to what they are owed.
        pending = getattr(acct, '_pending_by_sleeve', {}) or {}
        for sid, amt in pending.items():
            if sid in acct.sleeves:
                acct.sleeves[sid].cash_usd += float(amt)
        acct._pending_by_sleeve = {}
    interest = broker.accrue_interest(today)
    if interest:
        log(f'margin interest accrued: ${interest:,.4f}')
    broker.prune(today)

    # What the desk has learned from its own closed round trips. Inert until there is
    # enough evidence: load_learned returns an empty structure when the file is absent or
    # unreadable, so a missing learner can never block or distort a run.
    learned = load_learned()
    if learned.get('roundTrips'):
        log(f"learned from {learned['roundTrips']} closed round trips; "
            f"{learned.get('acting', 0)} sleeve(s) have actionable evidence "
            f"(deflated |t| bar {learned.get('deflatedTBar')})")
        for sid, ls in sorted((learned.get('perSleeve') or {}).items()):
            st = ls.get('stats') or {}
            log(f"  {sid:<10} n={st.get('n')} mean={st.get('meanNetPct')}% "
                f"t={st.get('t')} belief={ls.get('belief')} "
                f"weight={ls.get('capitalWeight')} shift={ls.get('entryPctileShift')}")
        rebalance_sleeves(acct, learned, prices_for_rebalance(acct, cfg), cfg)

    held = sorted({s for sl in acct.sleeves.values() for s in sl.positions})
    universe = candidate_universe(cfg, held, live)
    if not universe:
        record_run(cfg, acct, started, live, closed, [], [],
                   note='no candidates in the open markets', dry=args.dry_run)
        log('no candidates; nothing to do')
        return

    # ── think (Node: the app's real engine + Mia's LLM) ──
    if not args.skip_advise:
        cash_total = sum(s.cash_usd for s in acct.sleeves.values())
        with open(REQ_PATH, 'w', encoding='utf-8') as f:
            json.dump({'universe': universe,
                       'holdings': {s: acct.sleeves['mia-ai'].units(s)
                                    for s in acct.sleeves['mia-ai'].positions},
                       'cashUSD': round(acct.sleeves['mia-ai'].cash_usd, 2),
                       'config': cfg}, f, allow_nan=False)
        r = subprocess.run(['node', os.path.join('bot', 'advise.mjs'), REQ_PATH, ADV_PATH],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(ADV_PATH):
            log(f'advisor FAILED rc={r.returncode}: {(r.stderr or "")[-400:]}')
            record_run(cfg, acct, started, live, closed, [], [],
                       note=f'advisor failed rc={r.returncode}', dry=args.dry_run)
            sys.exit(1)
        for line in (r.stdout or '').strip().splitlines()[-3:]:
            log(line)

    with open(ADV_PATH, encoding='utf-8') as f:
        advice = json.load(f)
    cands = advice.get('candidates') or {}

    # ── stale-price + holiday-by-data guard ──
    fresh, stale = {}, {}
    for sym, c in cands.items():
        try:
            age = (started - datetime.datetime.fromisoformat(
                c['asOf'].replace('Z', '+00:00'))).total_seconds() / 60
        except Exception:
            age = 1e9
        if age > MAX_PRICE_AGE_MIN:
            stale[sym] = f'quote {age:.0f}m old'
            continue
        fresh[sym] = c
    if stale:
        log(f'{len(stale)} candidate(s) dropped as stale')
    if not fresh:
        record_run(cfg, acct, started, live, closed, [], [],
                   note='every quote was stale; market likely closed or feed down',
                   dry=args.dry_run)
        log('all quotes stale, treating as closed')
        return

    prices = {s: c['price'] for s, c in fresh.items()}
    # Build the run's distribution ONCE and share it with every sleeve, so they rank
    # against the same market instead of each forming its own view of it. Every entry and
    # exit threshold is now read off this rather than out of config.
    cross = CrossSection(fresh)
    snapshot = {'prices': prices, 'candidates': fresh, 'cross': cross,
                'breadth': cross.breadth(),
                'breadthHistory': breadth_history()}
    log(f'cross-section: {cross.n} symbols, rankable={cross.rankable}, '
        f'breadth(median score)={cross.breadth()}')
    if not cross.rankable:
        log(f'WARNING: fewer than the minimum needed to rank; sleeves fall back on '
            f'absolute engine semantics this run')
    mia_block = advice.get('mia') or {}
    strat = strategies.build(cfg, learned=learned, llm=(PrecomputedLLM(mia_block.get('decisions'))
                                       if mia_block.get('brain') == 'gemini' else None))
    log(f"Mia's brain: {mia_block.get('brain')}: {mia_block.get('note', '')[:110]}")

    meta = getattr(acct, '_meta', None) or {'openedAt': {}, 'tradesToday': {}, 'day': today.isoformat()}
    if meta.get('day') != today.isoformat():
        meta = {'openedAt': meta.get('openedAt', {}), 'tradesToday': {},
                'day': today.isoformat()}
    equity_open = getattr(acct, '_equity_open', None) or {}

    fills, refusals = [], []
    for sid, sleeve in acct.sleeves.items():
        st = strat.get(sid)
        if st is None:
            continue
        equity = sleeve.equity_usd(prices)

        # Dead sleeve: stays dead by design.
        if equity < cfg['risk']['minTradeUSD'] and not sleeve.positions:
            refusals.append({'sleeve': sid, 'symbol': None, 'action': 'HALT',
                             'reason': f'sleeve is wiped (${equity:,.2f}); it stays that '
                                       f'way by design and is not reseeded'})
            continue

        # Daily loss halt.
        opened = float(equity_open.get(sid) or equity)
        if opened > 0 and (equity - opened) / opened * 100.0 <= -cfg['risk']['dailyLossHaltPct']:
            refusals.append({'sleeve': sid, 'symbol': None, 'action': 'HALT',
                             'reason': f'down {(equity-opened)/opened*100:.2f}% today, '
                                       f'past the {cfg["risk"]["dailyLossHaltPct"]}% halt'})
            continue
        equity_open.setdefault(sid, equity)

        intents = st.decide(snapshot, sleeve)
        # Exits first, then highest conviction: if the per-run cap binds, closing risk
        # should always outrank opening it.
        intents.sort(key=lambda i: (0 if i.action == 'SELL' else 1, -i.conviction))
        done = 0
        for it in intents:
            if done >= cfg['risk']['maxTradesPerRun']:
                refusals.append({'sleeve': sid, 'symbol': it.symbol, 'action': it.action,
                                 'reason': f'per-run cap ({cfg["risk"]["maxTradesPerRun"]}) '
                                           f'reached', 'why': it.why})
                continue
            traded_today = int(meta['tradesToday'].get(sid, 0))
            ok, size, why = approve(it, sleeve, broker, cfg, prices, meta, today,
                                    traded_today, snapshot)
            if not ok:
                refusals.append({'sleeve': sid, 'symbol': it.symbol, 'action': it.action,
                                 'reason': why, 'why': it.why,
                                 'evidence': it.evidence})
                continue
            f = execute(acct, sleeve, broker, cfg, it, size, prices, meta, today)
            if f:
                fills.append(f)
                done += 1
                meta['tradesToday'][sid] = traded_today + 1

    acct.runs += 1
    acct._meta, acct._equity_open, acct._broker = meta, equity_open, broker.to_dict()
    log(f'{len(fills)} fill(s), {len(refusals)} refusal(s)')
    for f in fills:
        log(f"  {f['sleeve']:<10} {f['action']:<4} {f['symbol']:<10} "
            f"${f['notionalUSD']:>9,.2f} @ {f['fillPriceUSD']:.4f}  {f['why'][:70]}")

    if args.dry_run:
        log('dry run: nothing written')
        return

    write_fills(fills)
    # Re-learn immediately after writing, so the NEXT cycle already reflects what just
    # closed. Cheap: it re-reads one local append-only file. Placed after write_fills so the
    # round trips it sees include this cycle's exits.
    if fills:
        try:
            summary = learn()
            log(f"relearned: {summary['roundTrips']} round trips, "
                f"{summary['acting']} actionable -- {summary['verdict']}")
        except Exception as e:
            # Learning is an enhancement, never a precondition for trading. A broken learner
            # must not stop the desk from recording what it already did.
            log(f'learner failed ({type(e).__name__}); continuing with the previous file')
    record_run(cfg, acct, started, live, closed, fills, refusals, dry=False, advice=advice,
               cross_summary=cross.summary())
    save_state(acct, prices, broker)
    # The workflow gates the site publish on this, so a run that changed nothing does not
    # burn a Cloudflare Pages build.
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
            f.write(f'traded={"true" if fills else "false"}\n')
            f.write(f'fills={len(fills)}\n')


def execute(acct, sleeve, broker, cfg, intent, size, prices, meta, today):
    """Apply the fill and return the timeline row, or None if the sleeve refused it."""
    px = prices[intent.symbol]
    if intent.action == 'BUY':
        fill, why = sleeve.buy(intent.symbol, size, px)
    else:
        fill, why = sleeve.sell(intent.symbol, size, px)
    if not fill:
        return None

    fees = broker_fees_usd(fill['units'], px, intent.action, cfg['commissionPlan'])
    # Broker fees come out of cash on top of the spread already baked into the fill price.
    sleeve.cash_usd -= fees['totalUSD']
    sleeve.fees_usd += fees['totalUSD']

    key = f'{sleeve.id}:{intent.symbol}'
    if intent.action == 'BUY':
        meta['openedAt'][key] = utc_now_iso()
        broker.note_open(intent.symbol, fill['units'], today)
        if broker.account_type == CASH:
            pass    # buys consume settled cash directly
    else:
        # A same-day close of something opened today is a day trade under PDT.
        if broker.would_be_day_trade(intent.symbol, today):
            broker.note_day_trade(today)
        meta['openedAt'].pop(key, None)
        settles = broker.add_pending(fill['notionalUSD'], today)
        if settles:
            # In a cash account the proceeds are NOT spendable yet, so take them back out
            # of the sleeve's cash and remember who is owed them.
            sleeve.cash_usd -= fill['notionalUSD']
            pend = getattr(acct, '_pending_by_sleeve', None) or {}
            pend[sleeve.id] = float(pend.get(sleeve.id, 0.0)) + fill['notionalUSD']
            acct._pending_by_sleeve = pend

    return {
        'ts': utc_now_iso(),
        'sleeve': sleeve.id, 'sleeveName': sleeve.name,
        'action': intent.action, 'symbol': intent.symbol,
        'market': market_of(intent.symbol),
        'units': round(fill['units'], 8),
        'refPriceUSD': round(fill['refPrice'], 6),
        'fillPriceUSD': round(fill['fillPrice'], 6),
        'notionalUSD': round(fill['notionalUSD'], 2),
        'spreadCostUSD': round(fill['feeUSD'], 4),
        'commissionUSD': fees['commissionUSD'],
        'regulatoryUSD': fees['regulatoryUSD'],
        'totalCostUSD': round(fill['feeUSD'] + fees['totalUSD'], 4),
        'realizedUSD': (round(fill['realizedUSD'], 4) if 'realizedUSD' in fill else None),
        'costBasisUSD': (round(fill['costBasisUSD'], 4) if 'costBasisUSD' in fill else None),
        'strategy': intent.evidence.get('rule'),
        'conviction': round(intent.conviction, 4),
        'why': intent.why,
        'evidence': intent.evidence,
        'accountType': broker.account_type,
        'cashAfterUSD': round(sleeve.cash_usd, 2),
        'unitsAfter': round(sleeve.units(intent.symbol), 8),
    }


def write_fills(fills):
    if not fills:
        return
    with open(TRADES_PATH, 'a', encoding='utf-8') as f:
        for x in fills:
            f.write(json.dumps(x, allow_nan=False) + '\n')


def record_run(cfg, acct, started, live, closed, fills, refusals, note=None, dry=False,
               advice=None, cross_summary=None):
    """One row per run, including runs that traded nothing.

    Without this a quiet week is indistinguishable from a dead cron, and the gap between
    runs (which Actions delays unpredictably) would be invisible.
    """
    if dry:
        return
    prev_gap = None
    if os.path.exists(RUNS_PATH):
        try:
            with open(RUNS_PATH, encoding='utf-8') as f:
                last = collections.deque(f, maxlen=1)
            if last:
                prev = json.loads(last[0])
                prev_gap = round((started - datetime.datetime.fromisoformat(
                    prev['ts'].replace('Z', '+00:00'))).total_seconds() / 60, 1)
        except Exception:
            prev_gap = None

    prices = {}
    if advice:
        prices = {s: c['price'] for s, c in (advice.get('candidates') or {}).items()}
    row = {
        'ts': started.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'gapMinutes': prev_gap,
        'openMarkets': live, 'closedMarkets': closed,
        'analysed': (advice or {}).get('analysed', 0),
        # The distribution the run's decisions were made against. Without this a threshold
        # that moves every run is unauditable: there would be no way to replay why a name
        # cleared the bar on Tuesday and not on Wednesday.
        'crossSection': cross_summary,
        'miaBrain': ((advice or {}).get('mia') or {}).get('brain'),
        'fills': len(fills), 'refusals': len(refusals),
        'refusalReasons': refusals[:25],
        'note': note,
        'totals': acct.totals(prices) if acct else None,
        'leaderboard': acct.leaderboard(prices) if acct else None,
    }
    os.makedirs(os.path.dirname(RUNS_PATH), exist_ok=True)
    with open(RUNS_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row, allow_nan=False) + '\n')


def save_state(acct, prices, broker):
    acct.save(STATE_PATH, prices)
    # Append the extra desk state the Sleeve model has no business knowing about.
    with open(STATE_PATH, encoding='utf-8') as f:
        d = json.load(f)
    d['broker'] = broker.to_dict()
    d['brokerSummary'] = broker.describe()
    d['meta'] = getattr(acct, '_meta', {})
    d['equityOpen'] = getattr(acct, '_equity_open', {})
    d['pendingBySleeve'] = getattr(acct, '_pending_by_sleeve', {})
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump(d, f, indent=2, allow_nan=False)


# BotAccount.load must restore the desk-level extras too, or settlement and PDT state
# would silently reset on every run. Patched here rather than in portfolio.py to keep that
# module purely about sleeve accounting.
_orig_load = BotAccount.load.__func__


@classmethod
def _load_with_extras(cls, path=STATE_PATH):
    acct = _orig_load(cls, path)
    if acct and os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                d = json.load(f)
            acct._broker = d.get('broker')
            acct._meta = d.get('meta')
            acct._equity_open = d.get('equityOpen')
            acct._pending_by_sleeve = d.get('pendingBySleeve')
        except Exception:
            pass
    return acct


BotAccount.load = _load_with_extras


if __name__ == '__main__':
    main()
