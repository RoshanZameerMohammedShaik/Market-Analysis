"""Mia 2.0's account: sleeve accounting with FIFO lots.

WHAT A SLEEVE IS AND WHY
------------------------
Roshan wanted competing strategies AND one shared pot with real stakes, which conflict
if every strategy trades the same cash: they fight over it and P/L stops being
attributable, which kills the entire point of a leaderboard.

Sleeves resolve it. Mia's allocation is divided into one book per strategy. Each sleeve
holds its own cash and positions and is measured on its own, while the total still
rolls up into the single balance shown in the Portfolio panel. A sleeve CAN be traded
down to nothing. This is how real multi-strategy desks are organised, for exactly this
reason.

WHY THE STATE LIVES IN THE REPO
-------------------------------
The practice portfolio is browser localStorage (js/portfolio/state.js, key
ma-portfolio-v1). A GitHub Actions bot cannot read or write that, so Mia's account is
authoritative here in model/bot/state.json and the browser MERGES it into the
displayed total. One pot on screen, two sources underneath. The side benefit is that
Mia can never liquidate a position Roshan opened by hand.

ACCOUNTING RULES, MIRRORING js/portfolio/state.js
-------------------------------------------------
  * All internal accounting in USD. Display currency is a UI concern.
  * FIFO lots. A buy appends a lot; a sell consumes lots oldest-first, so cost basis
    and realized P/L are exact rather than averaged.
  * Fills cross the spread via trading_costs.fill_price, so the cost is baked into the
    cost basis instead of being a separate fee. A bot that books fills at the midpoint
    it observed is reporting profits it could not have captured.
  * Fractional units allowed, matching the browser portfolio and letting a fixed-dollar
    order size work on a $300 stock.
  * LONG ONLY. No shorting: the practice portfolio has no borrow model, and pretending
    to short without borrow costs would be the same class of lie as free fills.
"""
from __future__ import annotations

import datetime
import json
import os

from trading_costs import cost_usd, fill_price, side_cost_pct

SCHEMA = 1
BOT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'model', 'bot')
STATE_PATH = os.path.join(BOT_DIR, 'state.json')

# Dust guard. Below this a fill is all cost and no signal, and it clutters the
# timeline Roshan actually wants to read.
MIN_TRADE_USD = 25.0


def utc_now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _round_money(x):
    return round(float(x) + 0.0, 6)


class Sleeve:
    """One strategy's book: its cash, its positions, its realized P/L."""

    def __init__(self, sleeve_id, name, cash_usd=0.0, positions=None,
                 realized_usd=0.0, fees_usd=0.0, trades=0, blurb=''):
        self.id = sleeve_id
        self.name = name
        self.blurb = blurb
        self.cash_usd = float(cash_usd)
        # positions[symbol] = {'units': float, 'lots': [{'units','costUSD','openedAt'}]}
        self.positions = positions or {}
        self.realized_usd = float(realized_usd)
        self.fees_usd = float(fees_usd)
        self.trades = int(trades)

    # ── serialisation ────────────────────────────────────────────────────────
    def to_dict(self):
        return {
            'id': self.id, 'name': self.name, 'blurb': self.blurb,
            'cashUSD': _round_money(self.cash_usd),
            'positions': self.positions,
            'realizedUSD': _round_money(self.realized_usd),
            'feesUSD': _round_money(self.fees_usd),
            'trades': self.trades,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(d['id'], d.get('name', d['id']), d.get('cashUSD', 0.0),
                   d.get('positions') or {}, d.get('realizedUSD', 0.0),
                   d.get('feesUSD', 0.0), d.get('trades', 0), d.get('blurb', ''))

    # ── queries ──────────────────────────────────────────────────────────────
    def units(self, symbol):
        return float((self.positions.get(symbol) or {}).get('units') or 0.0)

    def cost_basis_usd(self, symbol):
        lots = (self.positions.get(symbol) or {}).get('lots') or []
        return sum(float(l['costUSD']) for l in lots)

    def holdings_value_usd(self, prices):
        """Marked to the prices given. A symbol with no price contributes its cost
        basis rather than zero, so a temporary quote failure cannot make the account
        look like it lost everything."""
        total = 0.0
        for sym, pos in self.positions.items():
            u = float(pos.get('units') or 0.0)
            if u <= 0:
                continue
            px = prices.get(sym)
            total += u * float(px) if isinstance(px, (int, float)) and px > 0 \
                else self.cost_basis_usd(sym)
        return total

    def equity_usd(self, prices):
        return self.cash_usd + self.holdings_value_usd(prices)

    # ── mutations ────────────────────────────────────────────────────────────
    def buy(self, symbol, notional_usd, price):
        """Spend up to notional_usd at `price` (before crossing the spread).

        Returns a fill dict, or None with a reason when it cannot execute. Never
        raises on ordinary refusals: a bot run must not die because one order was
        too small.
        """
        px = fill_price(price, 'BUY', symbol)
        if px is None or px <= 0:
            return None, 'unusable price'
        spend = min(float(notional_usd), self.cash_usd)
        if spend < MIN_TRADE_USD:
            return None, f'below min trade size (${spend:.2f} < ${MIN_TRADE_USD:g})'
        units = spend / px
        if units <= 0:
            return None, 'zero units'
        fee = cost_usd(price, units, symbol)

        pos = self.positions.setdefault(symbol, {'units': 0.0, 'lots': []})
        pos['lots'].append({'units': units, 'costUSD': spend, 'openedAt': utc_now_iso()})
        pos['units'] = float(pos['units']) + units
        self.cash_usd -= spend
        self.fees_usd += fee
        self.trades += 1
        return {'units': units, 'fillPrice': px, 'notionalUSD': spend,
                'feeUSD': fee, 'refPrice': float(price)}, None

    def sell(self, symbol, units_wanted, price):
        """Sell up to units_wanted FIFO. Returns (fill, reason)."""
        held = self.units(symbol)
        units = min(float(units_wanted), held)
        if units <= 0:
            return None, 'no position'
        px = fill_price(price, 'SELL', symbol)
        if px is None or px <= 0:
            return None, 'unusable price'
        proceeds = units * px
        if proceeds < MIN_TRADE_USD and units < held:
            # Allow a full exit of a small position, but refuse dust partials.
            return None, f'partial sell below min size (${proceeds:.2f})'

        pos = self.positions[symbol]
        remaining = units
        cost_consumed = 0.0
        lots = pos['lots']
        while remaining > 1e-12 and lots:
            lot = lots[0]
            lu = float(lot['units'])
            take = min(lu, remaining)
            # Proportional cost basis of the slice taken from this lot.
            cost_consumed += float(lot['costUSD']) * (take / lu) if lu > 0 else 0.0
            if take >= lu - 1e-12:
                lots.pop(0)
            else:
                lot['units'] = lu - take
                lot['costUSD'] = float(lot['costUSD']) * (1 - take / lu)
            remaining -= take

        pos['units'] = max(0.0, float(pos['units']) - units)
        if pos['units'] <= 1e-12 and not lots:
            del self.positions[symbol]

        realized = proceeds - cost_consumed
        fee = cost_usd(price, units, symbol)
        self.cash_usd += proceeds
        self.realized_usd += realized
        self.fees_usd += fee
        self.trades += 1
        return {'units': units, 'fillPrice': px, 'notionalUSD': proceeds,
                'feeUSD': fee, 'refPrice': float(price),
                'costBasisUSD': cost_consumed, 'realizedUSD': realized}, None


class BotAccount:
    """The whole desk: every sleeve plus the seed and audit metadata."""

    def __init__(self, seed_usd=0.0, sleeves=None, created_at=None, runs=0):
        self.seed_usd = float(seed_usd)
        self.sleeves = sleeves or {}
        self.created_at = created_at or utc_now_iso()
        self.runs = int(runs)

    # ── persistence ──────────────────────────────────────────────────────────
    @classmethod
    def load(cls, path=STATE_PATH):
        if not os.path.exists(path):
            return None
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        sleeves = {k: Sleeve.from_dict(v) for k, v in (d.get('sleeves') or {}).items()}
        return cls(d.get('seedUSD', 0.0), sleeves, d.get('createdAt'), d.get('runs', 0))

    def save(self, path=STATE_PATH, prices=None):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        prices = prices or {}
        payload = {
            'schema': SCHEMA,
            'createdAt': self.created_at,
            'updatedAt': utc_now_iso(),
            'runs': self.runs,
            'seedUSD': _round_money(self.seed_usd),
            # Denormalised totals so the browser can render the panel without
            # recomputing FIFO math in JS. Recomputed on every save, never trusted
            # as input.
            'totals': self.totals(prices),
            'sleeves': {k: s.to_dict() for k, s in self.sleeves.items()},
        }
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            # allow_nan=False: a bare NaN is invalid JSON and would silently break
            # every browser consumer. That already happened once on 650 ledger rows.
            json.dump(payload, f, indent=2, allow_nan=False)
        os.replace(tmp, path)

    # ── queries ──────────────────────────────────────────────────────────────
    def sleeve(self, sleeve_id):
        return self.sleeves.get(sleeve_id)

    def totals(self, prices):
        eq = sum(s.equity_usd(prices) for s in self.sleeves.values())
        cash = sum(s.cash_usd for s in self.sleeves.values())
        # UNSETTLED SELL PROCEEDS ARE STILL OURS.
        #
        # In a cash account T+1 settlement means proceeds cannot be SPENT until they
        # settle, so execute() removes them from the sleeve's cash and parks them in
        # _pending_by_sleeve. That is correct for buying power and was silently wrong for
        # net worth: totals() summed only cash_usd, so the money vanished from equity for a
        # day and reappeared later as a phantom gain.
        #
        # Measured on the live desk: three sells parked $893.56, and the panel reported
        # -8.73% when the positions were only -0.94% against cost. Nearly the entire
        # reported loss was money the desk still had. Held out of buying power, counted in
        # equity -- those are different questions and conflating them made the P/L a lie.
        pending = sum(float(v or 0) for v in (getattr(self, '_pending_by_sleeve', None) or {}).values())
        eq += pending
        realized = sum(s.realized_usd for s in self.sleeves.values())
        fees = sum(s.fees_usd for s in self.sleeves.values())
        trades = sum(s.trades for s in self.sleeves.values())
        pnl = eq - self.seed_usd
        return {
            'equityUSD': _round_money(eq),
            # Spendable cash only, which is what a sizing decision must use.
            'cashUSD': _round_money(cash),
            # Reported separately so the difference is visible rather than inferred.
            'unsettledCashUSD': _round_money(pending),
            'holdingsUSD': _round_money(eq - cash - pending),
            'realizedUSD': _round_money(realized),
            'unrealizedUSD': _round_money(pnl - realized),
            'feesUSD': _round_money(fees),
            'pnlUSD': _round_money(pnl),
            'pnlPct': round(100.0 * pnl / self.seed_usd, 4) if self.seed_usd else 0.0,
            'trades': trades,
        }

    def all_symbols(self):
        out = set()
        for s in self.sleeves.values():
            out.update(s.positions.keys())
        return sorted(out)

    def leaderboard(self, prices):
        """Per-sleeve performance, best first. The control sleeve is the bar: a
        strategy beating its own seed while losing to buy-and-hold has produced
        nothing but beta."""
        rows = []
        for s in self.sleeves.values():
            seed = self.seed_usd / max(1, len(self.sleeves))
            eq = s.equity_usd(prices)
            rows.append({
                'id': s.id, 'name': s.name, 'blurb': s.blurb,
                'equityUSD': _round_money(eq),
                'pnlUSD': _round_money(eq - seed),
                'pnlPct': round(100.0 * (eq - seed) / seed, 4) if seed else 0.0,
                'realizedUSD': _round_money(s.realized_usd),
                'feesUSD': _round_money(s.fees_usd),
                'trades': s.trades,
                'positions': len(s.positions),
                'cashUSD': _round_money(s.cash_usd),
            })
        rows.sort(key=lambda r: -r['pnlPct'])
        return rows
