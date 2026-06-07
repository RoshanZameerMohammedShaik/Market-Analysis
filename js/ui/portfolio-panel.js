// Portfolio Simulation panel — practice trading platform.
//
// UX flow:
//   Empty state  → "Instantiate" button → modal asks (currency, amount)
//   Loaded state → cash + holdings table with live P&L per row +
//                  per-row Sell button + Add funds + Reset + Export/Import
//
// Live ticking: each held symbol gets a price subscription via pricing.js.
// On every tick we recompute that row's market value and the portfolio
// total. The cash row never moves; only holdings do.
//
// All internal numbers are USD. Display happens through the FX module
// using whatever currency the user picked at instantiate time.

import {
    initPortfolio, getPortfolio, isInstantiated, instantiatePortfolio,
    addFunds, resetPortfolio, exportPortfolio, importPortfolio,
    heldSymbols, totalDepositedUSD,
} from '../portfolio/state.js';
import { COMMON_CURRENCIES, getRateToUSD, fromUSDCached, warmCommonRates } from '../portfolio/fx.js';
import { subscribe, refreshStockPrices, isCryptoSymbol } from '../portfolio/pricing.js';
import { sell as tradeSell, unrealizedPnL } from '../portfolio/trade.js';
import { registerSidePanel, openSidePanel, closeSidePanel, isSidePanelOpen } from './side-panel-stack.js';
import { controlSelectSymbol } from '../mia/ui-bridge.js';
import { flashShimmer } from './flash-shimmer.js';
import { notify } from './notify.js';

const subs = new Map();   // symbol -> { handle, price }
const PANEL_WIDTH = 420;

// Two-candle mark used in BOTH the launcher button AND the panel
// header so the two icons animate identically. Earlier the panel
// header had a separate 3-bar+trend SVG that ran on its own keyframe
// — visibly out of step with the launcher's 2-candle animation.
// One SVG, one keyframe, perfect sync.
const LAUNCHER_ICON_SVG = `
<span class="portfolio-icon-candles" aria-hidden="true">
    <span class="cl-bar up"><span class="cl-body"></span></span>
    <span class="cl-bar down"><span class="cl-body"></span></span>
</span>`;
const PANEL_TITLE_ICON_SVG = LAUNCHER_ICON_SVG;

// The P&L Calculator used to live inside this panel as a <details>. It's
// now its own side panel (js/ui/pl-panel.js). These pointer links open it.
function openPLPanelFromPortfolio() {
    import('./pl-panel.js').then(m => m.openPLPanel({ shimmerTitle: true, focusFirst: true }));
}

export function initPortfolioPanel() {
    initPortfolio();
    ensurePanelMounted();
    registerSidePanel('portfolio', {
        width: () => Math.min(PANEL_WIDTH, window.innerWidth * 0.96),
        getElement: () => document.getElementById('portfolio-panel'),
        onLayout: () => {
            const el = document.getElementById('portfolio-panel');
            if (!el) return;
            el.classList.toggle('open', isSidePanelOpen('portfolio'));
            el.setAttribute('aria-hidden', isSidePanelOpen('portfolio') ? 'false' : 'true');
        },
    });
    bindLauncher();
    rebindLiveSubs();
    document.addEventListener('ma:portfolio-changed', () => {
        rebindLiveSubs();
        renderPanel();
    });
    // FX rate pre-warming used to run unconditionally here, fetching 20
    // currencies the user might never look at. Now we defer the warm
    // until the user actually opens the Instantiate modal — that's when
    // the dropdown is the hot UI path. No portfolio = no FX calls, no
    // stock snapshots, no portfolio math. The bare empty-state panel
    // renders fine without any of that.
    renderPanel();
}

function ensurePanelMounted() {
    const el = document.getElementById('portfolio-panel');
    if (!el) return;
    // Render the head + body shell once. renderPanel() patches the body.
    el.innerHTML = `
        <div class="portfolio-panel-head">
            <span class="portfolio-panel-title"><span class="portfolio-panel-title-text">Portfolio Simulation</span>${PANEL_TITLE_ICON_SVG}</span>
            <button class="portfolio-panel-close" id="portfolio-panel-close" type="button" title="Close" aria-label="Close portfolio panel">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" pointer-events="none"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
            </button>
        </div>
        <div class="portfolio-panel-scroll">
            <div class="portfolio-body" id="portfolio-body"></div>
        </div>`;
    // Delegated click handler on the panel itself so even if the close
    // button is re-rendered or the SVG inside swallows pointer-events,
    // we still catch it. (Kept the direct listener too for redundancy.)
    el.addEventListener('click', (e) => {
        if (e.target.closest('#portfolio-panel-close')) {
            e.preventDefault();
            e.stopPropagation();
            closePortfolioPanel();
        }
    });
}

function bindLauncher() {
    const btn = document.getElementById('portfolio-launcher');
    if (!btn) return;
    // Inject the animated SVG icon once; replaces the 💼 emoji
    // placeholder so the launcher reads as a polished UI control.
    const iconHost = document.getElementById('portfolio-launcher-icon');
    if (iconHost && !iconHost.querySelector('svg')) {
        iconHost.innerHTML = LAUNCHER_ICON_SVG;
    }
    btn.addEventListener('click', () => {
        if (isSidePanelOpen('portfolio')) closePortfolioPanel();
        else openPortfolioPanel();
    });
}

export function openPortfolioPanel(opts = {}) {
    const { shimmerTitle = true } = opts;
    openSidePanel('portfolio');
    // Re-render so the user sees the latest state (in case it changed
    // while the panel was closed via Mia tool / chart-header trade).
    renderPanel();
    // One-shot shimmer on the panel header so the user's eye is
    // pulled to the destination right after the slide-in. The gear-
    // menu's "P&L Calculator" path passes shimmerTitle: false because
    // it shimmers a different label (the P&L Calculator header inside
    // the panel) — running both at once was the "shimmering twice"
    // glitch Roshan reported.
    if (shimmerTitle) {
        requestAnimationFrame(() => {
            flashShimmer(document.querySelector('.portfolio-panel-title-text'));
        });
    }
    // Auto-refresh stock prices on open ONLY if the user actually has
    // a portfolio with positions. No portfolio = nothing to refresh =
    // no fetch. Stocks don't tick continuously (no free realtime
    // data); crypto positions keep ticking via their Binance WS subs.
    if (isInstantiated() && heldSymbols().length > 0) {
        refreshStockSnapshot();
    }
}

export function closePortfolioPanel() {
    closeSidePanel('portfolio');
}

function renderPanel() {
    const body = document.getElementById('portfolio-body');
    if (!body) return;
    const p = getPortfolio();

    if (!isInstantiated()) {
        body.innerHTML = `
            <div class="portfolio-empty">
                <p class="portfolio-empty-line">No portfolio loaded yet. Practice buying and selling stocks or crypto with simulated funds in any currency you choose.</p>
                <button class="portfolio-cta" id="portfolio-instantiate-btn">Instantiate Portfolio</button>
                <div class="portfolio-import-row">
                    <button class="portfolio-link-btn" id="portfolio-import-btn">Import a previous snapshot</button>
                </div>
                <p class="portfolio-pl-pointer">Want to plan a trade's profit/loss? The <button class="portfolio-link-btn" id="portfolio-open-pl-1" type="button">P&amp;L Calculator</button> is now its own panel.</p>
            </div>`;
        document.getElementById('portfolio-instantiate-btn').addEventListener('click', openInstantiateModal);
        document.getElementById('portfolio-import-btn').addEventListener('click', openImportPrompt);
        document.getElementById('portfolio-open-pl-1')?.addEventListener('click', openPLPanelFromPortfolio);
        return;
    }

    const cur = p.currency;
    const totalDepUSD = totalDepositedUSD();
    const heldUSD = computeHoldingsUSD();
    const totalUSD = p.cashUSD + heldUSD;
    const pnlUSD = totalUSD - totalDepUSD;
    const pnlPct = totalDepUSD > 0 ? (pnlUSD / totalDepUSD) * 100 : 0;
    const pnlClass = pnlUSD >= 0 ? 'pos' : 'neg';

    body.innerHTML = `
        <div class="portfolio-summary-row">
            <div class="portfolio-stat">
                <span class="portfolio-stat-label">Total value</span>
                <span class="portfolio-stat-value">${fmtMoney(totalUSD, cur)}</span>
            </div>
            <div class="portfolio-stat">
                <span class="portfolio-stat-label">Cash</span>
                <span class="portfolio-stat-value">${fmtMoney(p.cashUSD, cur)}</span>
            </div>
            <div class="portfolio-stat">
                <span class="portfolio-stat-label">Holdings</span>
                <span class="portfolio-stat-value">${fmtMoney(heldUSD, cur)}</span>
            </div>
            <div class="portfolio-stat">
                <span class="portfolio-stat-label">Total P&amp;L</span>
                <span class="portfolio-stat-value ${pnlClass}">${pnlUSD >= 0 ? '+' : ''}${fmtMoney(pnlUSD, cur)} (${pnlPct.toFixed(2)}%)</span>
            </div>
        </div>
        <div class="portfolio-actions">
            <button class="portfolio-action-btn" id="portfolio-refresh" title="Refresh stock prices (crypto ticks live automatically)">↻ Refresh</button>
            <button class="portfolio-action-btn" id="portfolio-add-funds">Add Funds</button>
            <button class="portfolio-action-btn" id="portfolio-export">Export</button>
            <button class="portfolio-action-btn" id="portfolio-import-2">Import</button>
            <button class="portfolio-action-btn danger" id="portfolio-reset">Reset</button>
        </div>
        <div class="portfolio-holdings" id="portfolio-holdings">
            ${renderHoldings(p, cur)}
        </div>
        <p class="portfolio-pl-pointer">Plan a trade's profit/loss in the <button class="portfolio-link-btn" id="portfolio-open-pl-2" type="button">P&amp;L Calculator</button> (now its own panel).</p>`;

    document.getElementById('portfolio-refresh').addEventListener('click', onRefreshClick);
    document.getElementById('portfolio-add-funds').addEventListener('click', openAddFundsModal);
    document.getElementById('portfolio-export').addEventListener('click', doExport);
    document.getElementById('portfolio-import-2').addEventListener('click', openImportPrompt);
    document.getElementById('portfolio-reset').addEventListener('click', confirmReset);
    document.getElementById('portfolio-holdings').addEventListener('click', onHoldingsClick);
    document.getElementById('portfolio-open-pl-2')?.addEventListener('click', openPLPanelFromPortfolio);

    // After full re-render, paint live prices into rows from whatever
    // ticks we already have cached so the UI doesn't sit on '—'.
    for (const [sym, sub] of subs) {
        if (sub.price != null) updateRow(sym, sub.price);
    }
}

function renderHoldings(p, cur) {
    const symbols = Object.keys(p.positions).sort();
    if (!symbols.length) {
        return `
            <div class="portfolio-no-holdings">
                <p>No positions yet. Load a stock or crypto from the search bar, then use the Buy button on the chart to open a position.</p>
            </div>`;
    }
    const rows = symbols.map(sym => {
        const pos = p.positions[sym];
        // Symbol cell is a button so a click loads the holding into
        // the chart + runs full analysis. data-action='load' tells
        // the delegated click handler to route through controlSelectSymbol
        // rather than the sell-all path.
        return `
            <div class="portfolio-holding" data-symbol="${sym}">
                <div class="portfolio-holding-main">
                    <button class="portfolio-holding-sym" data-symbol="${sym}" data-action="load" title="Load ${sym} on the chart and run analysis">${sym}</button>
                    <span class="portfolio-holding-units">${fmtUnits(pos.units)} units</span>
                    <span class="portfolio-holding-price" data-role="price">—</span>
                    <span class="portfolio-holding-value" data-role="value">—</span>
                    <span class="portfolio-holding-pnl" data-role="pnl">—</span>
                    <button class="portfolio-sell-btn" data-symbol="${sym}" data-mode="all" title="Sell entire position">Sell all</button>
                </div>
            </div>`;
    }).join('');
    return rows;
}

// Recompute the unified holdings dollar value using whatever live prices
// we currently have subscribed. If a sub hasn't fired yet, we fall back
// to avg cost (the user's actual money in) rather than 0, so the totals
// don't dramatically swing on first load.
function computeHoldingsUSD() {
    const p = getPortfolio();
    let total = 0;
    for (const [sym, pos] of Object.entries(p.positions)) {
        const sub = subs.get(sym);
        const price = sub?.price;
        if (Number.isFinite(price) && price > 0) {
            total += pos.units * price;
        } else {
            // Use cost basis until first tick lands. Prevents the "your
            // portfolio just dropped to zero" flash on page load.
            const cost = pos.lots.reduce((s, l) => s + l.units * l.costBasisUSD, 0);
            total += cost;
        }
    }
    return total;
}

// Re-bind subscriptions to whatever symbols are currently held.
// New positions get fresh subs; sold-off positions get torn down.
function rebindLiveSubs() {
    const wanted = new Set(heldSymbols());
    // Tear down subs for symbols no longer held
    for (const [sym, sub] of [...subs.entries()]) {
        if (!wanted.has(sym)) {
            try { sub.handle?.close(); } catch (_) {}
            subs.delete(sym);
        }
    }
    // Open subs for newly held symbols
    for (const sym of wanted) {
        if (subs.has(sym)) continue;
        const slot = { handle: null, price: null };
        subs.set(sym, slot);
        const handle = subscribe(sym, (price) => {
            slot.price = price;
            updateRow(sym, price);
            updateTotals();
        });
        slot.handle = handle;
    }
}

// Patch a single row's price/value/pnl in place. Avoids re-rendering the
// whole panel on every tick.
function updateRow(sym, price) {
    const row = document.querySelector(`.portfolio-holding[data-symbol="${sym}"]`);
    if (!row) return;
    const cur = getPortfolio().currency;
    const pnl = unrealizedPnL(sym, price);
    if (!pnl) return;
    row.querySelector('[data-role="price"]').textContent = fmtMoney(pnl.currentPriceUSD, cur);
    row.querySelector('[data-role="value"]').textContent = fmtMoney(pnl.marketValueUSD, cur);
    const pnlEl = row.querySelector('[data-role="pnl"]');
    pnlEl.textContent = `${pnl.unrealizedUSD >= 0 ? '+' : ''}${fmtMoney(pnl.unrealizedUSD, cur)} (${pnl.unrealizedPct.toFixed(2)}%)`;
    pnlEl.classList.toggle('pos', pnl.unrealizedUSD >= 0);
    pnlEl.classList.toggle('neg', pnl.unrealizedUSD < 0);
}

// Patch the summary stats without re-rendering the holdings list. Called
// on every price tick so the headline totals stay live.
function updateTotals() {
    const body = document.getElementById('portfolio-body');
    if (!body) return;
    const p = getPortfolio();
    const cur = p.currency;
    const heldUSD = computeHoldingsUSD();
    const totalUSD = p.cashUSD + heldUSD;
    const totalDepUSD = totalDepositedUSD();
    const pnlUSD = totalUSD - totalDepUSD;
    const pnlPct = totalDepUSD > 0 ? (pnlUSD / totalDepUSD) * 100 : 0;
    const stats = body.querySelectorAll('.portfolio-stat .portfolio-stat-value');
    if (stats.length >= 4) {
        stats[0].textContent = fmtMoney(totalUSD, cur);
        // stats[1] is cash — doesn't change on tick, leave it.
        stats[2].textContent = fmtMoney(heldUSD, cur);
        stats[3].textContent = `${pnlUSD >= 0 ? '+' : ''}${fmtMoney(pnlUSD, cur)} (${pnlPct.toFixed(2)}%)`;
        stats[3].classList.toggle('pos', pnlUSD >= 0);
        stats[3].classList.toggle('neg', pnlUSD < 0);
    }
}

// ── click handlers ────────────────────────────────────────────────────

// Manual refresh — fires when user clicks the ↻ Refresh button. Spins the
// button while fetching so the user has feedback that something's
// happening. Crypto positions don't need this (Binance WS streams them
// live); refreshStockPrices internally only touches stock subs.
function onRefreshClick() {
    const btn = document.getElementById('portfolio-refresh');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '↻ Refreshing…';
    refreshStockSnapshot()
        .then((summary) => {
            if (!summary) return;
            const { refreshed, failed } = summary;
            if (refreshed === 0 && failed === 0) {
                toast('No stock positions to refresh.', '');
            } else if (failed === 0) {
                toast(`Refreshed ${refreshed} stock${refreshed === 1 ? '' : 's'}.`, 'pos');
            } else {
                toast(`Refreshed ${refreshed}; ${failed} failed.`, 'neg');
            }
        })
        .finally(() => {
            btn.disabled = false;
            btn.textContent = orig;
        });
}

// Internal: trigger the stock-price refresh and surface the result. Used
// both by openPortfolioPanel (auto-refresh on panel open) and by the
// manual ↻ button. Returns the summary so callers can react.
async function refreshStockSnapshot() {
    try {
        const summary = await refreshStockPrices();
        return summary;
    } catch (e) {
        console.warn('[portfolio] stock refresh failed:', e);
        return null;
    }
}

function onHoldingsClick(e) {
    // Load-on-click: ticker cell loads the holding on the chart so
    // the user can review the engine's current read before deciding
    // what to do with the position. Crypto positions get the
    // BTC-USD-style symbol passed straight through; stock symbols
    // route via controlSelectSymbol which handles the search +
    // chart-load flow.
    const loadBtn = e.target.closest('.portfolio-holding-sym[data-action="load"]');
    if (loadBtn) {
        const sym = loadBtn.dataset.symbol;
        const mode = isCryptoSymbol(sym) ? 'crypto' : 'stock';
        // Strip the trailing -USD from crypto symbols when handing to
        // controlSelectSymbol, which does its own search resolution.
        const lookupSym = mode === 'crypto' ? sym.replace(/-USD$/i, '') : sym;
        controlSelectSymbol({ symbol: lookupSym, mode })
            .catch(err => toast(`Couldn't load ${sym}: ${err.message}`, 'neg'));
        return;
    }
    const sellBtn = e.target.closest('.portfolio-sell-btn');
    if (!sellBtn) return;
    const sym = sellBtn.dataset.symbol;
    const mode = sellBtn.dataset.mode || 'all';
    sellBtn.disabled = true;
    sellBtn.textContent = 'Selling…';
    tradeSell(sym, { mode })
        .then(r => {
            const realized = r.realizedUSD;
            const cur = getPortfolio().currency;
            const sign = realized >= 0 ? '+' : '';
            toast(`Sold ${fmtUnits(r.units)} ${sym} @ ${fmtMoney(r.fillPriceUSD, cur)} — realized ${sign}${fmtMoney(realized, cur)}`, realized >= 0 ? 'pos' : 'neg');
        })
        .catch(err => {
            toast(`Sell failed: ${err.message}`, 'neg');
            sellBtn.disabled = false;
            sellBtn.textContent = 'Sell all';
        });
}

// ── modals ────────────────────────────────────────────────────────────

function openInstantiateModal() {
    // Warm FX rates in the background while the user is typing in the
    // modal — by the time they pick a non-USD currency, the rate is
    // already cached and the FX hint renders without a flash. Best-
    // effort; failures are silent (the explicit fetch on Load will
    // surface a real error if needed).
    warmCommonRates().catch(() => {});
    const html = `
        <div class="portfolio-modal-backdrop" id="portfolio-modal-backdrop">
            <div class="portfolio-modal" role="dialog" aria-label="Instantiate portfolio">
                <h3 class="portfolio-modal-title">Load Portfolio</h3>
                <p class="portfolio-modal-desc">Pick a currency and the amount you want to practice with. This is simulated money — nothing real changes hands.</p>
                <div class="portfolio-modal-row">
                    <label>
                        <span>Currency</span>
                        <select id="portfolio-modal-currency">
                            ${COMMON_CURRENCIES.map(c => `<option value="${c}">${c}</option>`).join('')}
                        </select>
                    </label>
                    <label>
                        <span>Amount</span>
                        <input type="number" id="portfolio-modal-amount" inputmode="decimal" step="any" min="0" placeholder="1000" />
                    </label>
                </div>
                <div class="portfolio-modal-fxhint" id="portfolio-modal-fxhint"></div>
                <div class="portfolio-modal-actions">
                    <button class="portfolio-modal-btn" id="portfolio-modal-cancel">Cancel</button>
                    <button class="portfolio-modal-btn primary" id="portfolio-modal-load">Load Portfolio</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('portfolio-modal-backdrop');
    const close = () => backdrop.remove();
    document.getElementById('portfolio-modal-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const curSel = document.getElementById('portfolio-modal-currency');
    const amtIn = document.getElementById('portfolio-modal-amount');
    const fxHint = document.getElementById('portfolio-modal-fxhint');
    async function refreshFxHint() {
        const cur = curSel.value;
        const amt = Number(amtIn.value);
        if (cur === 'USD' || !Number.isFinite(amt) || amt <= 0) {
            fxHint.textContent = '';
            return;
        }
        try {
            const rate = await getRateToUSD(cur);
            const usd = amt * rate;
            fxHint.textContent = `≈ $${usd.toFixed(2)} USD at 1 ${cur} = ${rate.toFixed(4)} USD`;
        } catch (_) {
            fxHint.textContent = `(couldn't fetch ${cur}→USD rate; check connection)`;
        }
    }
    curSel.addEventListener('change', refreshFxHint);
    amtIn.addEventListener('input', refreshFxHint);

    document.getElementById('portfolio-modal-load').addEventListener('click', async () => {
        const currency = curSel.value;
        const amount = Number(amtIn.value);
        if (!Number.isFinite(amount) || amount <= 0) {
            toast('Enter an amount greater than 0.', 'neg');
            return;
        }
        try {
            const rate = await getRateToUSD(currency);
            instantiatePortfolio({ currency, amount, fxRateToUSD: rate });
            close();
            toast(`Portfolio loaded — ${currency} ${amount} (≈ $${(amount * rate).toFixed(2)} USD)`, 'pos');
        } catch (err) {
            toast(`Couldn't load portfolio: ${err.message}`, 'neg');
        }
    });
}

function openAddFundsModal() {
    const cur = getPortfolio().currency;
    const html = `
        <div class="portfolio-modal-backdrop" id="portfolio-modal-backdrop">
            <div class="portfolio-modal" role="dialog" aria-label="Add funds">
                <h3 class="portfolio-modal-title">Add Funds</h3>
                <p class="portfolio-modal-desc">Top up your practice cash. Same currency you started with (${cur}).</p>
                <div class="portfolio-modal-row">
                    <label>
                        <span>Amount (${cur})</span>
                        <input type="number" id="portfolio-add-amount" inputmode="decimal" step="any" min="0" placeholder="500" />
                    </label>
                </div>
                <div class="portfolio-modal-actions">
                    <button class="portfolio-modal-btn" id="portfolio-add-cancel">Cancel</button>
                    <button class="portfolio-modal-btn primary" id="portfolio-add-go">Add</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('portfolio-modal-backdrop');
    const close = () => backdrop.remove();
    document.getElementById('portfolio-add-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.getElementById('portfolio-add-go').addEventListener('click', async () => {
        const amount = Number(document.getElementById('portfolio-add-amount').value);
        if (!Number.isFinite(amount) || amount <= 0) {
            toast('Enter an amount > 0.', 'neg');
            return;
        }
        try {
            const rate = await getRateToUSD(cur);
            addFunds({ currency: cur, amount, fxRateToUSD: rate });
            close();
            toast(`Added ${cur} ${amount.toFixed(2)} to portfolio.`, 'pos');
        } catch (err) {
            toast(`Add failed: ${err.message}`, 'neg');
        }
    });
}

function confirmReset() {
    if (!confirm('Reset portfolio? This wipes all positions, cash, and history. Cannot be undone.')) return;
    resetPortfolio();
    toast('Portfolio reset.', 'pos');
}

function doExport() {
    const json = exportPortfolio();
    // Download as a file rather than dumping into clipboard — feels more
    // like a "save" action and works on mobile.
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `market-analysis-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Portfolio snapshot downloaded.', 'pos');
}

function openImportPrompt() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                importPortfolio(reader.result);
                toast('Portfolio imported.', 'pos');
            } catch (err) {
                toast(`Import failed: ${err.message}`, 'neg');
            }
        };
        reader.readAsText(file);
    });
    input.click();
}

// ── helpers ───────────────────────────────────────────────────────────

function fmtUnits(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 100) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(8);
}

function fmtMoney(usd, currency) {
    if (!Number.isFinite(usd)) return '—';
    const local = currency === 'USD' ? usd : fromUSDCached(usd, currency);
    if (local == null) return `$${usd.toFixed(2)} (USD)`; // fx not cached yet
    const sym = currencySymbol(currency);
    return `${sym}${Math.abs(local).toFixed(2)}${usd < 0 ? ' loss' : ''}`.replace(' loss', '');
}

function currencySymbol(c) {
    const map = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CAD: 'C$', AUD: 'A$', CHF: 'Fr ', CNY: '¥', HKD: 'HK$', SGD: 'S$' };
    return map[c] || `${c} `;
}

// Portfolio messaging routes through the unified top-left notification
// stack (see js/ui/notify.js). Earlier this had its own bottom-anchored
// .portfolio-toast div with a fixed 4.5s timeout — Roshan asked for
// every notification across the app to use the same top-left pattern
// with a green drain bar.
function toast(msg, kind) {
    // Callers pass 'pos'/'neg' (profit/loss) throughout this module; without
    // mapping them they all fell through to neutral 'info' and lost their
    // green/red tint. Map pos→success, neg→error.
    const map = { pos: 'success', neg: 'error', error: 'error', warn: 'warn', success: 'success', info: 'info' };
    notify(msg, { kind: map[kind] || 'info' });
}
