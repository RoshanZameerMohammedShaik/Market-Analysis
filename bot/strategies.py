"""The four sleeves' decision logic.

CONTRACT
--------
A strategy NEVER touches the account. It receives a read-only snapshot and returns a
list of Intent objects. The runner alone applies broker rules, risk limits and sizing,
then executes. That split exists so a strategy cannot accidentally bypass a rule, and
so the timeline can record the difference between what a strategy WANTED and what the
account ALLOWED. Roshan asked to see why a trade happened; seeing why one did NOT happen
is just as informative.

Every Intent carries `why` (one sentence a human reads) and `evidence` (the numbers
behind it). Neither is decoration: they are the audit trail that makes the whole
exercise worth running, and they are what distinguishes this from a black box that
prints a P/L.

HONESTY NOTE ON THE ENGINE SLEEVE
---------------------------------
The engine has NO measured directional skill: 51.5% at one day against a 51.79%
majority-class baseline, and zero of 40 cost-adjusted cells net-positive over 996,541
historical predictions. Its sleeve is here precisely to demonstrate that in public,
forward, with real spreads. If it bleeds, that is the correct result and the bot is
working as intended.
"""
from __future__ import annotations

import datetime

from bot.dynamic import (
    ENTRY_PCTILE, EXIT_PCTILE, OVERSOLD_PCTILE, RECOVERED_PCTILE, NEUTRAL_SCORE,
    exit_levels,
)


class Intent:
    """A strategy's wish. Advisory only until the runner approves it."""

    def __init__(self, action, symbol, why, evidence=None, conviction=0.5,
                 size_hint_pct=None):
        self.action = action.upper()        # BUY | SELL
        self.symbol = symbol
        self.why = why
        self.evidence = evidence or {}
        # 0..1. Used for ordering and, on BUYs, for scaling position size, so a
        # marginal call takes a smaller bite than a strong one.
        self.conviction = max(0.0, min(1.0, float(conviction)))
        self.size_hint_pct = size_hint_pct

    def to_dict(self):
        return {'action': self.action, 'symbol': self.symbol, 'why': self.why,
                'evidence': self.evidence, 'conviction': round(self.conviction, 4)}

    def __repr__(self):
        return f'<Intent {self.action} {self.symbol} conv={self.conviction:.2f}>'


def _pc(rank):
    """Rank as a percentile for the evidence block, so a moving threshold stays auditable."""
    return round(rank * 100, 1) if isinstance(rank, (int, float)) else None


def _rank_conviction(rank, entry_pctile):
    """Rescale a cross-sectional rank into 0.5..1.0 conviction.

    Sizing has to reflect how good a name is RELATIVE to the alternatives available, which
    is what rank measures. Absolute distance above a fixed threshold does not compare across
    regimes: +10 over the bar is common on a strong day and exceptional on a weak one.
    """
    if not isinstance(rank, (int, float)):
        return 0.6
    span = max(1e-6, 1.0 - entry_pctile)
    return 0.5 + 0.5 * max(0.0, min(1.0, (rank - entry_pctile) / span))


class Strategy:
    """Base class. `decide` gets a snapshot and returns Intents."""

    id = 'base'
    name = 'Base'

    def __init__(self, cfg):
        self.cfg = cfg

    def decide(self, snapshot, sleeve):
        raise NotImplementedError

    # ── thresholds, computed from THIS run's cross-section ───────────────────
    def cut(self, snapshot, field, pctile, fallback=None):
        """The value at `pctile` of `field` across every symbol analysed this run.

        This is what replaced the config constants. A rank is regime-neutral: the top decile
        is the top decile in a crash and in a melt-up, whereas ">= 62" silently became
        "buy everything" or "buy nothing" as conditions moved.

        `fallback` is used only when the universe is too thin to rank (< MIN_FOR_RANKING),
        and is a DEFINITION rather than a tuned value -- 50 is neutral by the engine's own
        construction.
        """
        xs = snapshot.get('cross')
        return xs.cut(field, pctile, fallback) if xs else fallback

    def rank(self, snapshot, field, value):
        xs = snapshot.get('cross')
        return xs.rank_of(field, value) if xs else None

    # ── shared exit logic ────────────────────────────────────────────────────
    def exit_intents(self, snapshot, sleeve):
        """Take-profit and stop-loss, derived per symbol from its own calibrated band.

        Shared rather than reimplemented per strategy: a stop is a risk control, not an
        opinion, and three copies would eventually disagree.

        There is no takeProfitPct or stopLossPct any more. Both levels come from
        dynamic.exit_levels, which converts the forecast band's day-1 interval into moves
        against average cost, and falls back to an ATR multiple when a symbol has no band.
        A flat +8%/-5% was wrong for this universe in both directions at once: unreachable on
        a 0.9%-sigma large cap and intraday noise on a 6%-sigma altcoin.
        """
        out = []
        for sym in list(sleeve.positions.keys()):
            px = snapshot['prices'].get(sym)
            if not isinstance(px, (int, float)) or px <= 0:
                continue
            units = sleeve.units(sym)
            if units <= 0:
                continue
            basis = sleeve.cost_basis_usd(sym)
            if basis <= 0:
                continue
            avg = basis / units
            cand = (snapshot['candidates'] or {}).get(sym) or {}
            tp, sl, ev = exit_levels(cand, avg)
            if tp is None:
                # No band AND no ATR. Refuse to invent a level; the strategy's own signal
                # exit still applies, so the position is not unmanaged.
                continue
            move = (px - avg) / avg * 100.0
            if px >= tp:
                out.append(Intent(
                    'SELL', sym,
                    f'Take profit: up {move:.2f}% from ${avg:,.4f}, through the '
                    f'{ev.get("source", "model")} target of ${tp:,.4f} '
                    f'(+{ev.get("tpMovePct", 0):.2f}% expected for its volatility).',
                    dict(ev, avgCostUSD=round(avg, 6), priceUSD=px,
                         targetUSD=round(tp, 6), movePct=round(move, 3),
                         rule='take-profit'),
                    conviction=0.9))
            elif px <= sl:
                out.append(Intent(
                    'SELL', sym,
                    f'Stop loss: down {move:.2f}% from ${avg:,.4f}, through the '
                    f'{ev.get("source", "model")} floor of ${sl:,.4f} '
                    f'({ev.get("slMovePct", 0):.2f}% for its volatility). Cutting it.',
                    dict(ev, avgCostUSD=round(avg, 6), priceUSD=px,
                         stopUSD=round(sl, 6), movePct=round(move, 3),
                         rule='stop-loss'),
                    conviction=0.95))
        return out


class EngineStrategy(Strategy):
    """Trades the app's own signal, exactly as a user sees it."""

    id = 'engine'
    name = 'The Engine'

    def decide(self, snapshot, sleeve):
        out = self.exit_intents(snapshot, sleeve)
        exiting = {i.symbol for i in out}
        # Top decile of TODAY's scores to open, below the median to close. Was a fixed
        # 62/42 pair, which meant the rule's real aggressiveness drifted with the market
        # instead of staying constant.
        buy_at = self.cut(snapshot, 'score', ENTRY_PCTILE, NEUTRAL_SCORE)
        sell_at = self.cut(snapshot, 'score', EXIT_PCTILE, NEUTRAL_SCORE)

        # Close anything the engine has turned against, even without a stop trigger.
        for sym in list(sleeve.positions.keys()):
            if sym in exiting:
                continue
            c = snapshot['candidates'].get(sym)
            if not c:
                continue
            score = c.get('score')
            if isinstance(score, (int, float)) and score <= sell_at:
                out.append(Intent(
                    'SELL', sym,
                    f'Engine score fell to {score:.1f}, at or below the median '
                    f'{sell_at:.1f} across the {snapshot["cross"].n} names scanned. It is '
                    f'no longer in the better half, so the position goes.',
                    {'score': score, 'exitBelow': round(sell_at, 2),
                     'exitPctile': EXIT_PCTILE, 'universeSize': snapshot['cross'].n,
                     'scoreRank': _pc(self.rank(snapshot, 'score', score)),
                     'signal': c.get('signal'), 'rule': 'engine-exit'},
                    conviction=0.7))
                exiting.add(sym)

        # Open the strongest names above the entry bar.
        ranked = sorted(
            (c for c in snapshot['candidates'].values()
             if isinstance(c.get('score'), (int, float)) and c['score'] >= buy_at
             and c['symbol'] not in sleeve.positions),
            key=lambda c: -c['score'])
        for c in ranked:
            ind = c.get('indicators') or {}
            rsi = ind.get('rsi')
            out.append(Intent(
                'BUY', c['symbol'],
                f"Engine scores {c['score']:.1f}, in the top decile of the "
                f"{snapshot['cross'].n} names scanned this run (cut {buy_at:.1f}), with a "
                f"{c.get('signal', 'n/a')} call at {c.get('confidence', 0)}% confidence"
                + (f', RSI {rsi:.1f}' if isinstance(rsi, (int, float)) else '') + '.',
                {'score': c['score'], 'signal': c.get('signal'),
                 'confidence': c.get('confidence'), 'rsi': rsi,
                 'aiScore': (c.get('ai') or {}).get('score'),
                 'entryAbove': round(buy_at, 2), 'entryPctile': ENTRY_PCTILE,
                 'scoreRank': _pc(self.rank(snapshot, 'score', c['score'])),
                 'universeSize': snapshot['cross'].n, 'rule': 'engine-entry'},
                # Conviction is the symbol's RANK inside the cross-section, rescaled so
                # the entry cut maps to 0.5 and the very best name maps to 1.0. Distance
                # above a fixed 62 measured nothing comparable between a calm day and a
                # volatile one; rank does.
                conviction=_rank_conviction(self.rank(snapshot, 'score', c['score']),
                                            ENTRY_PCTILE)))
        return out


class ReversionStrategy(Strategy):
    """Buys oversold, sells strength.

    This is the one component measured with genuinely positive information coefficient
    in this universe: RSI negated at +0.0514 (t 3.33) and Bollinger %B negated at
    +0.0518 (t 3.27) on 5-day horizons, and it replicated on a clean time split. It is
    also the component that costs eat, which is exactly why it is worth watching it try
    with real spreads charged.
    """

    id = 'reversion'
    name = 'Mean Reversion'

    def decide(self, snapshot, sleeve):
        out = self.exit_intents(snapshot, sleeve)
        exiting = {i.symbol for i in out}
        # The most beaten-down decile of TODAY's universe, released once it has climbed
        # back through the 70th percentile. Was a fixed 32/62 pair, which fired on a third
        # of the universe in a selloff and on nothing at all in a grind upward -- the same
        # rule meaning "be fully invested" one month and "do nothing" the next.
        buy_rsi = self.cut(snapshot, 'rsi', OVERSOLD_PCTILE, 30.0)
        sell_rsi = self.cut(snapshot, 'rsi', RECOVERED_PCTILE, 70.0)

        for sym in list(sleeve.positions.keys()):
            if sym in exiting:
                continue
            ind = (snapshot['candidates'].get(sym) or {}).get('indicators') or {}
            rsi = ind.get('rsi')
            if isinstance(rsi, (int, float)) and rsi >= sell_rsi:
                out.append(Intent(
                    'SELL', sym,
                    f'RSI recovered to {rsi:.1f}, through the {sell_rsi:.1f} mark that '
                    f'is the 70th percentile of the {snapshot["cross"].n} names scanned. '
                    f'The oversold condition that justified holding has resolved.',
                    {'rsi': rsi, 'exitAbove': round(sell_rsi, 2),
                     'exitPctile': RECOVERED_PCTILE,
                     'rsiRank': _pc(self.rank(snapshot, 'rsi', rsi)),
                     'universeSize': snapshot['cross'].n, 'rule': 'reversion-exit'},
                    conviction=0.75))
                exiting.add(sym)

        cands = []
        for c in snapshot['candidates'].values():
            if c['symbol'] in sleeve.positions:
                continue
            ind = c.get('indicators') or {}
            rsi = ind.get('rsi')
            bb = ind.get('bb') or {}
            # The engine writes percent_b in Python and percentB in JS. Reading only one
            # spelling silently dropped the %B confirmation for half the pipeline.
            pct_b = None
            if isinstance(bb, dict):
                pct_b = bb.get('percentB') if bb.get('percentB') is not None                     else bb.get('percent_b')
            if not isinstance(rsi, (int, float)) or rsi > buy_rsi:
                continue
            cands.append((rsi, pct_b, c))
        # Most oversold first: that is where the measured IC lives.
        for rsi, pct_b, c in sorted(cands, key=lambda t: t[0]):
            bits = f'RSI {rsi:.1f}, inside the most oversold decile of the '                    f'{snapshot["cross"].n} names scanned (cut {buy_rsi:.1f})'
            if isinstance(pct_b, (int, float)):
                bits += f', %B {pct_b:.2f}'
            rsi_rank = self.rank(snapshot, 'rsi', rsi)
            out.append(Intent(
                'BUY', c['symbol'],
                f'Oversold: {bits}. Short-horizon reversal is the one effect measured '
                f'with real positive IC here (+0.05, t 3.3).',
                {'rsi': rsi, 'percentB': pct_b, 'entryBelow': round(buy_rsi, 2),
                 'entryPctile': OVERSOLD_PCTILE, 'rsiRank': _pc(rsi_rank),
                 'universeSize': snapshot['cross'].n, 'rule': 'reversion-entry'},
                # Conviction rises the DEEPER inside the oversold tail it sits. Rank is
                # inverted here because low RSI is the signal, so rank 0 is the strongest.
                conviction=_rank_conviction(
                    1.0 - rsi_rank if isinstance(rsi_rank, (int, float)) else None,
                    1.0 - OVERSOLD_PCTILE)))
        return out


class ControlStrategy(Strategy):
    """Buys an equal-weight basket ONCE, then never trades again.

    The most important sleeve on the leaderboard. Without it a rising market makes every
    strategy look skilful: holding EVERYTHING in this ledger returned +1.125% net at
    t=2.93 over 20 days, which is beta, not alpha. This sleeve makes that impossible to
    misread, and it must never be "improved" into something that trades.
    """

    id = 'control'
    name = 'Buy & Hold (control)'

    def decide(self, snapshot, sleeve):
        if sleeve.positions:
            return []      # already deployed; by definition it does nothing further
        n = min(self.cfg['risk']['maxPositions'], 6)
        # Highest-priced liquid names, NOT the engine's picks: the control must be
        # independent of the thing being measured or it stops being a control.
        pool = sorted((c for c in snapshot['candidates'].values()
                       if isinstance(c.get('price'), (int, float))),
                      key=lambda c: -c['price'])[:n]
        out = []
        for c in pool:
            out.append(Intent(
                'BUY', c['symbol'],
                f'Control basket: equal-weight buy-and-hold, one purchase then never '
                f'traded again. This is the bar the other sleeves must clear.',
                {'basketSize': len(pool), 'priceUSD': c['price'], 'rule': 'control-open'},
                conviction=1.0, size_hint_pct=100.0 / max(1, len(pool))))
        return out


class MiaAIStrategy(Strategy):
    """Mia decides for herself.

    Two brains, and the timeline always says which one spoke:
      * With GEMINI_API_KEY: the LLM receives the structured features and current
        positions and returns decisions plus its own reasoning. This is the sleeve that
        actually tests whether an LLM can trade.
      * Without a key: the LSTM alone drives it. Chosen so nothing about the bot is
        blocked on a secret being pasted, and so there is always a working AI sleeve.

    The LLM never sees raw prices to "predict" from. It gets FEATURES and must justify a
    decision, because language models have no numerical edge on price series and asking
    one to forecast a number invites a confident hallucination. Reasoning over structured
    evidence is the task they are actually good at.
    """

    id = 'mia-ai'
    name = "Mia's Own Call"

    def __init__(self, cfg, llm=None):
        super().__init__(cfg)
        self.llm = llm      # None -> LSTM-only mode

    def decide(self, snapshot, sleeve):
        out = self.exit_intents(snapshot, sleeve)
        exiting = {i.symbol for i in out}
        return out + (self._llm_decide(snapshot, sleeve, exiting) if self.llm
                      else self._lstm_decide(snapshot, sleeve, exiting))

    # ── fallback brain: the LSTM, no key required ───────────────────────────
    def _lstm_decide(self, snapshot, sleeve, exiting):
        out = []
        # Top decile of the model's OWN output across the universe, not a fixed 0.58.
        # The LSTM's absolute level drifts with the market: on a calm bullish day most
        # names print 0.55-0.65, so a 0.58 bar bought nearly everything, and on a fearful
        # day almost nothing cleared it. Rank keeps the book the same size either way.
        floor = self.cut(snapshot, 'aiProbability', ENTRY_PCTILE, 0.55)
        release = self.cut(snapshot, 'aiProbability', EXIT_PCTILE, 0.5)
        for sym in list(sleeve.positions.keys()):
            if sym in exiting:
                continue
            ai = (snapshot['candidates'].get(sym) or {}).get('ai') or {}
            p = ai.get('probability')
            if isinstance(p, (int, float)) and p < release:
                out.append(Intent(
                    'SELL', sym,
                    f'My model now puts a {p * 100:.0f}% chance on this rising, below '
                    f'the {release * 100:.0f}% median across the '
                    f'{snapshot["cross"].n} names I scanned. It is not in the better half '
                    f'any more, so I am out. (LSTM only: no Gemini key configured.)',
                    {'aiProbability': p, 'brain': 'lstm', 'exitBelow': round(release, 4),
                     'exitPctile': EXIT_PCTILE,
                     'aiRank': _pc(self.rank(snapshot, 'aiProbability', p)),
                     'universeSize': snapshot['cross'].n, 'rule': 'ai-exit'},
                    conviction=0.7))
                exiting.add(sym)

        ranked = []
        for c in snapshot['candidates'].values():
            if c['symbol'] in sleeve.positions:
                continue
            ai = c.get('ai') or {}
            p = ai.get('probability')
            if isinstance(p, (int, float)) and p >= floor:
                ranked.append((p, c))
        for p, c in sorted(ranked, key=lambda t: -t[0]):
            # 'aiScore' used to be recorded here as ai.get('score'), reading the `ai` name
            # left bound by the EXIT loop above. Python does not scope loop variables, so
            # every BUY intent was stamped with the last-iterated candidate's score: two
            # fills with probabilities 0.72 and 0.65 both recorded aiScore 34, a number
            # belonging to neither. Caught by reading the rendered timeline, not by any test.
            #
            # Rather than re-derive it from `c`, the field is GONE. advise.mjs defines
            # probability as score/100, so the two were the same number twice, and a value
            # stored twice is a value that can disagree with itself. One number, one source.
            # The engine sleeve still records aiScore, correctly derived inline, because there
            # it cross-references a DIFFERENT model's opinion and is not a duplicate.
            out.append(Intent(
                'BUY', c['symbol'],
                f'My model puts a {p * 100:.0f}% chance on this rising, in the top '
                f'decile of the {snapshot["cross"].n} names I scanned (cut '
                f'{floor * 100:.0f}%). (LSTM only: no Gemini key configured, so this is '
                f'the model talking, not my judgement.)',
                {'aiProbability': p, 'brain': 'lstm',
                 'entryAbove': round(floor, 4), 'entryPctile': ENTRY_PCTILE,
                 'aiRank': _pc(self.rank(snapshot, 'aiProbability', p)),
                 'universeSize': snapshot['cross'].n, 'rule': 'ai-entry'},
                # Rank, not the raw probability. A 0.62 reading means something different on
                # a day when the median is 0.60 than on one where it is 0.45, and only the
                # rank distinguishes those.
                conviction=_rank_conviction(
                    self.rank(snapshot, 'aiProbability', p), ENTRY_PCTILE)))
        return out

    # ── primary brain: the LLM ──────────────────────────────────────────────
    def _llm_decide(self, snapshot, sleeve, exiting):
        try:
            decisions = self.llm.decide(snapshot, sleeve, self.cfg)
        except Exception as e:
            # A dead API must never stop the desk. Fall back and say so, rather than
            # skipping the sleeve silently and leaving a gap in the record.
            print(f'[mia-ai] LLM failed ({type(e).__name__}: {e}); using the LSTM')
            return self._lstm_decide(snapshot, sleeve, exiting)

        out = []
        # Gemini's SELF-REPORTED confidence is not a market measurement and is not
        # comparable between runs, so it no longer acts as a gate -- it only sizes the
        # position. The gate is the same cross-sectional rank every other sleeve uses, which
        # also means a confidently hallucinated pick in the bottom decile cannot be bought
        # just because the model said 90%.
        buy_cut = self.cut(snapshot, 'score', EXIT_PCTILE, NEUTRAL_SCORE)
        for d in decisions or []:
            sym = d.get('symbol')
            act = str(d.get('action', '')).upper()
            # Normalised HERE because stated confidence no longer gates anything, so a
            # decision with the field missing must still be usable. float(None) would have
            # thrown on the first Gemini reply that omitted it.
            raw_conf = d.get('confidence')
            conf = float(raw_conf) if isinstance(raw_conf, (int, float)) else 0.6
            conf = max(0.0, min(1.0, conf))
            why = (d.get('reason') or '').strip()
            if not sym or act not in ('BUY', 'SELL') or sym in exiting:
                continue
            if act == 'BUY' and sym in sleeve.positions:
                continue
            if act == 'SELL' and sleeve.units(sym) <= 0:
                continue
            c = snapshot['candidates'].get(sym) or {}
            score = c.get('score')
            score_rank = self.rank(snapshot, 'score', score)
            # The LLM can only BUY something the cross-section does not rate as below
            # average. Selling is never blocked: refusing to let her exit on her own read
            # would trap a position, and the risk gate in run.py already vets every sale.
            if act == 'BUY':
                if not isinstance(score, (int, float)):
                    continue
                if score < buy_cut:
                    continue
            out.append(Intent(
                act, sym,
                why or f'{act} on my own read of the evidence.',
                {'brain': 'gemini', 'model': self.cfg['ai']['model'],
                 # Recorded, and used for sizing, but NOT a gate. Kept in the evidence so
                 # her stated confidence can later be scored against what actually happened.
                 'statedConfidence': raw_conf,
                 'score': score, 'scoreRank': _pc(score_rank),
                 'buyRequiresAbove': round(buy_cut, 2) if act == 'BUY' else None,
                 'rsi': (c.get('indicators') or {}).get('rsi'),
                 'aiProbability': (c.get('ai') or {}).get('probability'),
                 'universeSize': snapshot['cross'].n,
                 'rule': 'mia-judgement'},
                # Blend what she says with where the name actually ranks, so a confident
                # call on a mediocre name sizes smaller than a confident call on a strong
                # one. Falls back to her stated confidence alone when rank is unavailable.
                conviction=(float(conf) if not isinstance(score_rank, (int, float))
                            else 0.5 * float(conf) + 0.5 * score_rank)))
            exiting.add(sym)
        return out


def build(cfg, llm=None):
    """All four sleeves, in display order. Keyed by sleeve id."""
    return {
        EngineStrategy.id: EngineStrategy(cfg),
        ReversionStrategy.id: ReversionStrategy(cfg),
        MiaAIStrategy.id: MiaAIStrategy(cfg, llm),
        ControlStrategy.id: ControlStrategy(cfg),
    }
