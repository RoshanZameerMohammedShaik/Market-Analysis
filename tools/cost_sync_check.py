"""The browser's cost model must charge exactly what the desk's does.

bot/broker.py and trading_costs.py are the cost model for the paper desk. js/trading-costs.js is
the same model for the P&L calculator and the signal card. If they drift, the calculator quotes one
cost and the desk charges another, and every comparison between "what I planned" and "what Mia did"
is measured in two different currencies. This project has already had two engines for one
prediction once; this check stops it having two cost models.

Also asserts the calculator against the worked examples from the conversation that motivated it,
so a formula change that is internally consistent but wrong about the real numbers still fails.

Run: python tools/cost_sync_check.py
"""
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from bot.broker import (PLANS, SEC_FEE_PCT, FINRA_TAF_PER_SHARE, FINRA_TAF_MAX,  # noqa: E402
                        commission_usd, regulatory_usd)
import trading_costs as tc  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


# ── the grid both sides evaluate ─────────────────────────────────────────────
units_grid = [1, 7, 50, 100, 1000, 5000, 5400, 100000, 60000000]
price_grid = [0.000004, 0.0041, 0.05, 0.5, 2.21, 10.90, 11.00, 144.18, 339.89, 78291.64]
symbols = ['AAPL', 'SHIB-USD']

grid = []
for plan in PLANS:
    for u in units_grid:
        for p in price_grid:
            grid.append({'plan': plan, 'u': u, 'p': p})

js = r"""
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[1] + '/js/trading-costs.js').href);
// The grid arrives on STDIN, not argv: as an argument it blew through Windows' ~32K command-line
// limit (WinError 206) the first time this ran.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
const out = {
  constants: { SEC_FEE_PCT: m.SEC_FEE_PCT, FINRA_TAF_PER_SHARE: m.FINRA_TAF_PER_SHARE,
               FINRA_TAF_MAX: m.FINRA_TAF_MAX, SLIPPAGE_PCT: m.SLIPPAGE_PCT,
               CRYPTO_SPREAD_MULTIPLIER: m.CRYPTO_SPREAD_MULTIPLIER,
               plans: Object.fromEntries(Object.entries(m.PLANS).map(([k, v]) =>
                   [k, { per_share: v.perShare, min_order: v.minOrder, max_pct: v.maxPct }])) },
  commission: input.grid.map(g => m.commissionUSD(g.u, g.p, g.plan)),
  regulatory: input.grid.map(g => m.regulatoryUSD(g.u, g.p, 'SELL')),
  regBuy: input.grid.map(g => m.regulatoryUSD(g.u, g.p, 'BUY')),
  half: input.prices.flatMap(p => input.symbols.map(s => m.halfSpreadPct(p, s.endsWith('-USD')))),
  side: input.prices.flatMap(p => input.symbols.map(s => m.sideCostPct(p, s.endsWith('-USD')))),
  rt: input.prices.flatMap(p => input.symbols.map(s => m.roundTripCostPct(p, s.endsWith('-USD')))),
  examples: {
    // 5,000 shares, 10.90 -> 11.00, IBKR Pro Tiered, limit orders
    fixed: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, shares: 5000, plan: 'ibkr-pro-tiered', orderType: 'limit' }),
    // shares needed to NET $500 on the same move and plan
    target: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, targetNetUSD: 500, plan: 'ibkr-pro-tiered', orderType: 'limit' }),
    // one share fewer than the answer must NOT reach the target, or the search is not minimal
    oneLess: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, shares: 5399, plan: 'ibkr-pro-tiered', orderType: 'limit' }),
    wholesale: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, shares: 5000, plan: 'public-wholesale', orderType: 'limit' }),
    smart: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, shares: 5000, plan: 'public-smart', orderType: 'limit' }),
    // a 1-cent live spread on market orders: 5,000 shares should pay ~$50 of spread
    market1c: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, shares: 5000, plan: 'public-wholesale',
                            orderType: 'market', liveHalfSpreadPct: m.quotedHalfSpreadPct(10.895, 10.905) }),
    unreachable: m.planTrade({ buyPrice: 11.00, sellPrice: 10.90, targetNetUSD: 500 }),
    tooThin: m.planTrade({ buyPrice: 10.90, sellPrice: 10.901, targetNetUSD: 500, plan: 'ibkr-pro-tiered' }),
    crypto: m.planTrade({ buyPrice: 0.00001234, sellPrice: 0.00001300, investment: 1000, crypto: true, orderType: 'market' }),
    investment: m.planTrade({ buyPrice: 10.90, sellPrice: 11.00, investment: 54500, plan: 'ibkr-pro-tiered' }),
  },
  quoted: {
    normal: m.quotedHalfSpreadPct(339.89, 339.93),
    crossed: m.quotedHalfSpreadPct(10.00, 9.99),
    missing: m.quotedHalfSpreadPct(0, 10),
    absurd: m.quotedHalfSpreadPct(1.00, 5.00),
  },
};
console.log(JSON.stringify(out));
"""

payload = json.dumps({'grid': grid, 'prices': price_grid, 'symbols': symbols})
proc = subprocess.run(['node', '--input-type=module', '-e', js, REPO],
                      input=payload, capture_output=True, text=True, cwd=REPO)
if proc.returncode != 0:
    print(proc.stderr[:2000])
    print('COST SYNC CHECK FAIL: the JS side did not run')
    sys.exit(1)
j = json.loads(proc.stdout.strip().splitlines()[-1])

print('=== constants ===')
check('SEC fee rate matches', abs(j['constants']['SEC_FEE_PCT'] - SEC_FEE_PCT) < 1e-12,
      f"js {j['constants']['SEC_FEE_PCT']} py {SEC_FEE_PCT}")
check('SEC fee is the FY2026 rate ($20.60/M)', abs(SEC_FEE_PCT - 0.00206) < 1e-12, str(SEC_FEE_PCT))
check('FINRA TAF per share matches', j['constants']['FINRA_TAF_PER_SHARE'] == FINRA_TAF_PER_SHARE)
check('FINRA TAF cap matches', j['constants']['FINRA_TAF_MAX'] == FINRA_TAF_MAX)
check('slippage matches', j['constants']['SLIPPAGE_PCT'] == tc.SLIPPAGE_PCT)
check('crypto multiplier matches', j['constants']['CRYPTO_SPREAD_MULTIPLIER'] == tc.CRYPTO_SPREAD_MULTIPLIER)
check('the same plans exist on both sides', set(j['constants']['plans']) == set(PLANS),
      f"js-only {set(j['constants']['plans']) - set(PLANS)} py-only {set(PLANS) - set(j['constants']['plans'])}")
for k, v in PLANS.items():
    jv = j['constants']['plans'].get(k)
    check(f'plan {k} has identical parameters', jv == {kk: float(vv) for kk, vv in v.items()} or jv == v,
          f'js {jv} py {v}')

print()
print(f'=== {len(grid)} commission + regulatory evaluations ===')
bad_c = [(g, a, commission_usd(g['u'], g['p'], g['plan'])) for g, a in zip(grid, j['commission'])
         if abs(a - commission_usd(g['u'], g['p'], g['plan'])) > 1e-6]
check('commission agrees on every grid point', not bad_c, str(bad_c[:3]))
bad_r = [(g, a, regulatory_usd(g['u'], g['p'], 'SELL')) for g, a in zip(grid, j['regulatory'])
         if abs(a - regulatory_usd(g['u'], g['p'], 'SELL')) > 1e-6]
check('regulatory fees agree on every grid point', not bad_r, str(bad_r[:3]))
check('a BUY pays no regulatory fee', all(v == 0 for v in j['regBuy']))

print()
print('=== spread + impact estimates ===')
i = 0
bad_s = []
for p in price_grid:
    for s in symbols:
        py_h, py_s, py_rt = tc.half_spread_pct(p, s), tc.side_cost_pct(p, s), tc.round_trip_cost_pct(p, s)
        if any(abs((a or 0) - (b or 0)) > 1e-9 for a, b in
               ((j['half'][i], py_h), (j['side'][i], py_s), (j['rt'][i], py_rt))):
            bad_s.append((p, s, j['half'][i], py_h))
        i += 1
check('half-spread, side and round-trip cost agree for stocks and crypto', not bad_s, str(bad_s[:3]))

print()
print('=== the worked examples ===')
ex = j['examples']
f = ex['fixed']
# 5,000 x $0.10 = $500 gross. Commission 5,000 x 0.0035 x 2 = $35. SEC 55,000 x 0.0000206 = 1.133,
# TAF 5,000 x 0.000166 = 0.83. Net = 500 - 35 - 1.963 = 463.037.
check('5,000 sh 10.90->11.00 gross is $500', abs(f['grossUSD'] - 500) < 1e-6, str(f['grossUSD']))
check('IBKR Pro Tiered commission is $35 round trip',
      abs(f['commissionBuyUSD'] + f['commissionSellUSD'] - 35) < 1e-6,
      str(f['commissionBuyUSD'] + f['commissionSellUSD']))
check('regulatory fees are $1.963', abs(f['regulatoryUSD'] - 1.963) < 1e-3, str(f['regulatoryUSD']))
check('net is $463.04', abs(f['netUSD'] - 463.037) < 1e-2, str(f['netUSD']))
check('limit orders pay no spread', f['spreadUSD'] == 0 and f['impactUSD'] == 0)
t = ex['target']
check('shares needed to NET $500 is 5,400', t['shares'] == 5400, str(t['shares']))
check('and 5,400 shares actually nets at least $500', t['netUSD'] >= 500, str(t['netUSD']))
check('while 5,399 would not (the answer is minimal)', ex['oneLess']['netUSD'] < 500,
      str(ex['oneLess']['netUSD']))
check('capital needed is $58,860', abs(t['capitalUSD'] - 58860) < 1e-6, str(t['capitalUSD']))
check('Public Wholesale nets $498.04 on the same trade', abs(ex['wholesale']['netUSD'] - 498.037) < 1e-2,
      str(ex['wholesale']['netUSD']))
check('Public Smart route nets $468.04', abs(ex['smart']['netUSD'] - 468.037) < 1e-2,
      str(ex['smart']['netUSD']))
m1 = ex['market1c']
check('a 1-cent live spread costs ~$50 on 5,000 shares',
      abs(m1['spreadUSD'] - 50) < 0.5, str(m1['spreadUSD']))
check('market orders also pay the impact allowance', m1['impactUSD'] > 0, str(m1['impactUSD']))
check('and the spread is labelled as coming from the live quote', m1['spreadSource'] == 'live quote',
      m1['spreadSource'])
check('a sell below the buy is refused, not sized', ex['unreachable']['ok'] is False,
      json.dumps(ex['unreachable']))
check('a move smaller than the per-share costs is refused', ex['tooThin']['ok'] is False,
      json.dumps(ex['tooThin']))
cr = ex['crypto']
check('crypto is fractional and pays no stock commission or SEC fee',
      cr['ok'] and cr['shares'] != int(cr['shares']) and cr['commissionBuyUSD'] == 0 and cr['regulatoryUSD'] == 0,
      json.dumps(cr)[:160])
inv = ex['investment']
check('an investment amount buys WHOLE shares of a stock', inv['shares'] == 5000, str(inv['shares']))
be = f['breakEvenSell']
check('break-even exit is just above the buy (~$10.9074)', 10.905 < be < 10.910, str(be))

print()
print('=== live quote parsing refuses a fake market ===')
q = j['quoted']
check('a normal quote gives a small half-spread', q['normal'] is not None and 0 < q['normal'] < 0.01,
      str(q['normal']))
check('a crossed book is refused', q['crossed'] is None)
check('a missing side is refused', q['missing'] is None)
check('an absurd spread is refused', q['absurd'] is None)

print()
ok = not FAIL
print(f"{'COST SYNC CHECK PASS' if ok else 'COST SYNC CHECK FAIL'}: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL and os.environ.get('GITHUB_ACTIONS'):
    print(f"::error title=cost_sync::{'; '.join(FAIL[:6])}")
sys.exit(0 if ok else 1)
