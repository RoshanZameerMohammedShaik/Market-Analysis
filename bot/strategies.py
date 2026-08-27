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


class Strategy:
    """Base class. `decide` gets a snapshot and returns Intents."""

    id = 'base'
    name = 'Base'

    def __init__(self, cfg):
        self.cfg = cfg
        self.sig = cfg['signals']

    def decide(self, snapshot, sleeve):
        raise NotImplementedError

    # ── shared exit logic ────────────────────────────────────────────────────
    def exit_intents(self, snapshot, sleeve):
        """Take-profit and stop-loss, applied to every sleeve that holds anything.

        Deliberately shared rather than reimplemented per strategy: a stop is a risk
        control, not an opinion, and three copies of it would eventually disagree.
        """
        out = []
        tp = self.sig['takeProfitPct']
        sl = self.sig['stopLossPct']
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
            move = (px - avg) / avg * 100.0
            if move >= tp:
                out.append(Intent(
                    'SELL', sym,
                    f'Take profit: up {move:.2f}% from an average cost of '
                    f'${avg:,.2f}, at or beyond the {tp:.0f}% target.',
                    {'avgCostUSD': round(avg, 6), 'priceUSD': px,
                     'movePct': round(move, 3), 'rule': 'take-profit',
                     'thresholdPct': tp},
                    conviction=0.9))
            elif move <= -sl:
                out.append(Intent(
                    'SELL', sym,
                    f'Stop loss: down {move:.2f}% from an average cost of '
                    f'${avg:,.2f}, past the {sl:.0f}% limit. Cutting it.',
                    {'avgCostUSD': round(avg, 6), 'priceUSD': px,
                     'movePct': round(move, 3), 'rule': 'stop-loss',
                     'thresholdPct': -sl},
                    conviction=0.95))
        return out


class EngineStrategy(Strategy):
    """Trades the app's own signal, exactly as a user sees it."""

    id = 'engine'
    name = 'The Engine'

    def decide(self, snapshot, sleeve):
        out = self.exit_intents(snapshot, sleeve)
        exiting = {i.symbol for i in out}
        buy_at = self.sig['engineBuyScore']
        sell_at = self.sig['engineSellScore']

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
                    f'Engine score fell to {score:.1f}, at or below the {sell_at:.0f} '
                    f'exit line. Signal is gone, so the position goes.',
                    {'score': score, 'exitBelow': sell_at, 'signal': c.get('signal'),
                     'rule': 'engine-exit'},
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
                f"Engine scores {c['score']:.1f} (>= {buy_at:.0f}) with a "
                f"{c.get('signal', 'n/a')} call at {c.get('confidence', 0)}% confidence"
                + (f', RSI {rsi:.1f}' if isinstance(rsi, (int, float)) else '') + '.',
                {'score': c['score'], 'signal': c.get('signal'),
                 'confidence': c.get('confidence'), 'rsi': rsi,
                 'aiScore': (c.get('ai') or {}).get('score'),
                 'entryAbove': buy_at, 'rule': 'engine-entry'},
                # Map 62..100 onto 0.5..1.0 so a bare pass sizes smaller than a strong one.
                conviction=0.5 + 0.5 * min(1.0, (c['score'] - buy_at) / max(1.0, 100 - buy_at))))
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
        buy_rsi = self.sig['reversionRsiBuy']
        sell_rsi = self.sig['reversionRsiSell']

        for sym in list(sleeve.positions.keys()):
            if sym in exiting:
                continue
            ind = (snapshot['candidates'].get(sym) or {}).get('indicators') or {}
            rsi = ind.get('rsi')
            if isinstance(rsi, (int, float)) and rsi >= sell_rsi:
                out.append(Intent(
                    'SELL', sym,
                    f'RSI recovered to {rsi:.1f} (>= {sell_rsi:.0f}). The oversold '
                    f'condition that justified holding has resolved.',
                    {'rsi': rsi, 'exitAbove': sell_rsi, 'rule': 'reversion-exit'},
                    conviction=0.75))
                exiting.add(sym)

        cands = []
        for c in snapshot['candidates'].values():
            if c['symbol'] in sleeve.positions:
                continue
            ind = c.get('indicators') or {}
            rsi = ind.get('rsi')
            bb = ind.get('bb') or {}
            pct_b = bb.get('percentB') if isinstance(bb, dict) else None
            if not isinstance(rsi, (int, float)) or rsi > buy_rsi:
                continue
            cands.append((rsi, pct_b, c))
        # Most oversold first: that is where the measured IC lives.
        for rsi, pct_b, c in sorted(cands, key=lambda t: t[0]):
            bits = f'RSI {rsi:.1f} (<= {buy_rsi:.0f})'
            if isinstance(pct_b, (int, float)):
                bits += f', %B {pct_b:.2f}'
            out.append(Intent(
                'BUY', c['symbol'],
                f'Oversold: {bits}. Short-horizon reversal is the one effect measured '
                f'with real positive IC here (+0.05, t 3.3).',
                {'rsi': rsi, 'percentB': pct_b, 'entryBelow': buy_rsi,
                 'rule': 'reversion-entry'},
                # Deeper oversold = higher conviction, floored so RSI 31 is not ~0.
                conviction=0.5 + 0.5 * min(1.0, (buy_rsi - rsi) / buy_rsi)))
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
        floor = self.sig['aiMinConfidence']
        for sym in list(sleeve.positions.keys()):
            if sym in exiting:
                continue
            ai = (snapshot['candidates'].get(sym) or {}).get('ai') or {}
            p = ai.get('probability')
            if isinstance(p, (int, float)) and p < (1 - floor):
                out.append(Intent(
                    'SELL', sym,
                    f'My model now puts only a {p * 100:.0f}% chance on this rising. '
                    f'That is below my bar, so I am out. (LSTM only: no Gemini key '
                    f'configured.)',
                    {'aiProbability': p, 'brain': 'lstm', 'rule': 'ai-exit'},
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
            out.append(Intent(
                'BUY', c['symbol'],
                f'My model puts a {p * 100:.0f}% chance on this rising, above my '
                f'{floor * 100:.0f}% bar. (LSTM only: no Gemini key configured, so this '
                f'is the model talking, not my judgement.)',
                {'aiProbability': p, 'brain': 'lstm', 'aiScore': ai.get('score'),
                 'threshold': floor, 'rule': 'ai-entry'},
                conviction=float(p)))
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
        floor = self.sig['aiMinConfidence']
        for d in decisions or []:
            sym = d.get('symbol')
            act = str(d.get('action', '')).upper()
            conf = d.get('confidence')
            why = (d.get('reason') or '').strip()
            if not sym or act not in ('BUY', 'SELL') or sym in exiting:
                continue
            if not isinstance(conf, (int, float)) or conf < floor:
                continue
            if act == 'BUY' and sym in sleeve.positions:
                continue
            if act == 'SELL' and sleeve.units(sym) <= 0:
                continue
            c = snapshot['candidates'].get(sym) or {}
            out.append(Intent(
                act, sym,
                why or f'{act} on my own read of the evidence.',
                {'brain': 'gemini', 'model': self.cfg['ai']['model'],
                 'statedConfidence': conf,
                 'score': c.get('score'), 'rsi': (c.get('indicators') or {}).get('rsi'),
                 'aiProbability': (c.get('ai') or {}).get('probability'),
                 'rule': 'mia-judgement'},
                conviction=float(conf)))
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
