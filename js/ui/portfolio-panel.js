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
import { subscribe } from '../portfolio/pricing.js';
import { sell as tradeSell, unrealizedPnL } from '../portfolio/trade.js';
import { registerSidePanel, openSidePanel, closeSidePanel, isSidePanelOpen } from './side-panel-stack.js';

const subs = new Map();   // symbol -> { handle, price }
const PANEL_WIDTH = 420;

// Animated portfolio mark — three rising bars + a trend line. CSS
// animates the bars and the line so the icon "grows" subtly even at
// rest, hinting that the portfolio is alive. Replaces the 💼 emoji
// (which read flat and cartoonish next to the rest of the UI).
const LAUNCHER_ICON_SVG = `
<svg class="portfolio-icon" viewBox="0 0 22 22" width="18" height="18" aria-hidden="true">
    <rect class="portfolio-icon-bar bar-1" x="3"  y="13" width="3" height="6"  rx="1"/>
    <rect class="portfolio-icon-bar bar-2" x="9.5" y="9"  width="3" height="10" rx="1"/>
    <rect class="portfolio-icon-bar bar-3" x="16" y="6"  width="3" height="13" rx="1"/>
    <path class="portfolio-icon-trend" d="M3 11 L10.5 7 L17 4" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle class="portfolio-icon-dot" cx="17" cy="4" r="1.6"/>
</svg>`;

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
    // Warm common FX rates in the background so the dropdown renders
    // converted figures without a flash. Best-effort; ignores failures.
    warmCommonRates().catch(() => {});
    renderPanel();
}

function ensurePanelMounted() {
    const el = document.getElementById('portfolio-panel');
    if (!el) return;
    // Render the head + body shell once. renderPanel() patches the body.
    el.innerHTML = `
        <div class="portfolio-panel-head">
            <span class="portfolio-panel-title">${LAUNCHER_ICON_SVG}<span class="portfolio-panel-title-text">Portfolio Simulation</span></span>
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

export function openPortfolioPanel() {
    openSidePanel('portfolio');
    // Re-render so the user sees the latest state (in case it changed
    // while the panel was closed via Mia tool / chart-header trade).
    renderPanel();
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
            </div>
            <details class="portfolio-pl-section" id="portfolio-pl-section">
                <summary class="portfolio-pl-summary">
                    <span class="portfolio-pl-summary-text">P&amp;L Calculator</span>
                    <span class="portfolio-pl-summary-hint">Plan a trade even before loading a portfolio</span>
                </summary>
                <div class="portfolio-pl-host" id="portfolio-pl-host"></div>
            </details>`;
        document.getElementById('portfolio-instantiate-btn').addEventListener('click', openInstantiateModal);
        document.getElementById('portfolio-import-btn').addEventListener('click', openImportPrompt);
        movePLCalculatorIntoPanel();
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
            <button class="portfolio-action-btn" id="portfolio-add-funds">Add Funds</button>
            <button class="portfolio-action-btn" id="portfolio-export">Export</button>
            <button class="portfolio-action-btn" id="portfolio-import-2">Import</button>
            <button class="portfolio-action-btn danger" id="portfolio-reset">Reset</button>
        </div>
        <div class="portfolio-holdings" id="portfolio-holdings">
            ${renderHoldings(p, cur)}
        </div>
        <details class="portfolio-pl-section" id="portfolio-pl-section">
            <summary class="portfolio-pl-summary">
                <span class="portfolio-pl-summary-text">P&amp;L Calculator</span>
                <span class="portfolio-pl-summary-hint">Plan a trade — entry, target, projected return</span>
            </summary>
            <div class="portfolio-pl-host" id="portfolio-pl-host"></div>
        </details>`;

    document.getElementById('portfolio-add-funds').addEventListener('click', openAddFundsModal);
    document.getElementById('portfolio-export').addEventListener('click', doExport);
    document.getElementById('portfolio-import-2').addEventListener('click', openImportPrompt);
    document.getElementById('portfolio-reset').addEventListener('click', confirmReset);
    document.getElementById('portfolio-holdings').addEventListener('click', onHoldingsClick);
    movePLCalculatorIntoPanel();

    // After full re-render, paint live prices into rows from whatever
    // ticks we already have cached so the UI doesn't sit on '—'.
    for (const [sym, sub] of subs) {
        if (sub.price != null) updateRow(sym, sub.price);
    }
}

// Relocate the P&L calculator aside (originally rendered in the main
// app grid as a sidebar) into the portfolio panel. We physically move
// the same DOM node — DON'T clone — so all the listeners pl.js
// attached at init still work, and so the moved aside doesn't double-
// exist (which would cause duplicate IDs and break getElementById).
//
// Called every render. The first call moves it; subsequent calls
// short-circuit because the node is already in the right host.
function movePLCalculatorIntoPanel() {
    const host = document.getElementById('portfolio-pl-host');
    const calc = document.getElementById('pl-sidebar');
    if (!host || !calc) return;
    if (host.contains(calc)) return; // already moved
    host.appendChild(calc);
    calc.classList.add('pl-sidebar-in-portfolio');
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
        return `
            <div class="portfolio-holding" data-symbol="${sym}">
                <div class="portfolio-holding-main">
                    <span class="portfolio-holding-sym">${sym}</span>
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

function onHoldingsClick(e) {
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

let toastTimer = null;
function toast(msg, kind) {
    let el = document.getElementById('portfolio-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'portfolio-toast';
        el.className = 'portfolio-toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `portfolio-toast visible ${kind || ''}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.classList.remove('visible');
        toastTimer = null;
    }, 4500);
}
