// Buy / Sell controls in the chart header. Mirrors how the star
// (watchlist) button is attached: chart.js calls attachTradeButtons(sym)
// every time a new symbol loads, and we (re)wire the buttons against
// that symbol.
//
// Buy is always enabled when a portfolio is loaded; Sell is enabled
// only when the user actually holds the symbol.

import { isInstantiated, getPortfolio } from '../portfolio/state.js';
import { buy, sell } from '../portfolio/trade.js';
import { getCurrentPrice } from '../portfolio/pricing.js';
import { fromUSDCached } from '../portfolio/fx.js';
import { notify } from './notify.js';

export function attachTradeButtons(symbol) {
    const headerEl = document.getElementById('chart-header');
    if (!headerEl) return;
    let wrap = document.getElementById('trade-buttons');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'trade-buttons';
        wrap.className = 'trade-buttons';
        wrap.innerHTML = `
            <button class="trade-btn buy-btn" id="trade-buy-btn" type="button">Buy</button>
            <button class="trade-btn sell-btn" id="trade-sell-btn" type="button">Sell</button>`;
        headerEl.appendChild(wrap);
        document.getElementById('trade-buy-btn').addEventListener('click', onBuyClick);
        document.getElementById('trade-sell-btn').addEventListener('click', onSellClick);
    }
    wrap.dataset.symbol = String(symbol || '').toUpperCase();
    refreshButtonState();
    document.removeEventListener('ma:portfolio-changed', refreshButtonState);
    document.addEventListener('ma:portfolio-changed', refreshButtonState);
}

function refreshButtonState() {
    const wrap = document.getElementById('trade-buttons');
    if (!wrap) return;
    const sym = wrap.dataset.symbol;
    const buyBtn = document.getElementById('trade-buy-btn');
    const sellBtn = document.getElementById('trade-sell-btn');
    if (!buyBtn || !sellBtn) return;
    const loaded = isInstantiated();
    buyBtn.disabled = !loaded;
    buyBtn.title = loaded ? 'Buy this symbol with simulated funds' : 'Load a portfolio first';
    const pos = loaded ? getPortfolio().positions[sym] : null;
    const holds = !!(pos && pos.units > 1e-9);
    sellBtn.disabled = !holds;
    sellBtn.title = holds ? `You hold ${pos.units} units — click to sell` : 'You do not hold this symbol';
}

function onBuyClick() {
    const wrap = document.getElementById('trade-buttons');
    const sym = wrap?.dataset.symbol;
    if (!sym) return;
    if (!isInstantiated()) {
        alert('Load a portfolio first (use the Portfolio Simulation panel).');
        return;
    }
    openTradeModal(sym, 'BUY');
}

function onSellClick() {
    const wrap = document.getElementById('trade-buttons');
    const sym = wrap?.dataset.symbol;
    if (!sym) return;
    openTradeModal(sym, 'SELL');
}

export function openTradeModal(sym, side) {
    const p = getPortfolio();
    const cur = p.currency;
    const pos = p.positions[sym];
    const cashHint = `Available cash: ${cur} ${(fromUSDCached(p.cashUSD, cur) ?? p.cashUSD).toFixed(2)}`;
    const posHint = pos ? `You hold ${pos.units} ${sym}` : 'No position';

    const html = `
        <div class="portfolio-modal-backdrop" id="trade-modal-backdrop">
            <div class="portfolio-modal" role="dialog" aria-label="Trade ${sym}">
                <h3 class="portfolio-modal-title">${side} ${sym}</h3>
                <p class="portfolio-modal-desc">${cashHint}<br>${posHint}<br><span id="trade-price-hint" class="trade-price-hint">Fetching live price…</span></p>
                <div class="portfolio-modal-row">
                    <label>
                        <span>Mode</span>
                        <select id="trade-mode">
                            <option value="amountUSD">Amount (${cur})</option>
                            <option value="units">Units</option>
                            ${side === 'SELL' ? '<option value="all">Sell All</option>' : ''}
                        </select>
                    </label>
                    <label>
                        <span>Value</span>
                        <input type="number" id="trade-value" inputmode="decimal" step="any" min="0" placeholder="100" />
                    </label>
                </div>
                <div class="portfolio-modal-actions">
                    <button class="portfolio-modal-btn" id="trade-cancel">Cancel</button>
                    <button class="portfolio-modal-btn primary" id="trade-confirm">${side === 'BUY' ? 'Buy' : 'Sell'} now</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('trade-modal-backdrop');
    const close = () => backdrop.remove();
    document.getElementById('trade-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    // Show the live price as a hint so the user can plan their trade.
    getCurrentPrice(sym)
        .then(price => {
            const hint = document.getElementById('trade-price-hint');
            if (hint) hint.textContent = `Live price: $${formatPrice(price)} (USD)`;
        })
        .catch(err => {
            const hint = document.getElementById('trade-price-hint');
            if (hint) hint.textContent = `Price unavailable: ${err.message}`;
        });

    const modeSel = document.getElementById('trade-mode');
    const valueIn = document.getElementById('trade-value');
    modeSel.addEventListener('change', () => {
        if (modeSel.value === 'all') {
            valueIn.value = '';
            valueIn.disabled = true;
        } else {
            valueIn.disabled = false;
        }
    });

    document.getElementById('trade-confirm').addEventListener('click', async () => {
        const mode = modeSel.value;
        const raw = mode === 'all' ? null : Number(valueIn.value);
        if (mode !== 'all' && (!Number.isFinite(raw) || raw <= 0)) {
            toast('Enter a positive value.', 'neg');
            return;
        }
        // amountUSD comes in as the user's display currency — convert to USD
        // before handing to trade.js, which thinks in USD only.
        let quote;
        if (mode === 'amountUSD') {
            const usd = await convertLocalToUSD(raw, cur);
            quote = { mode: 'amountUSD', value: usd };
        } else if (mode === 'units') {
            quote = { mode: 'units', value: raw };
        } else {
            quote = { mode: 'all' };
        }
        try {
            const fn = side === 'BUY' ? buy : sell;
            const res = await fn(sym, quote);
            close();
            const verb = side === 'BUY' ? 'Bought' : 'Sold';
            const detail = side === 'BUY'
                ? `for ${cur} ${(fromUSDCached(res.costUSD, cur) ?? res.costUSD).toFixed(2)} @ $${formatPrice(res.fillPriceUSD)}`
                : `for ${cur} ${(fromUSDCached(res.proceedsUSD, cur) ?? res.proceedsUSD).toFixed(2)} @ $${formatPrice(res.fillPriceUSD)} — realized ${res.realizedUSD >= 0 ? '+' : ''}$${res.realizedUSD.toFixed(2)}`;
            toast(`${verb} ${formatUnits(res.units)} ${sym} ${detail}`, 'pos');
        } catch (err) {
            toast(`${side === 'BUY' ? 'Buy' : 'Sell'} failed: ${err.message}`, 'neg');
        }
    });
}

async function convertLocalToUSD(localAmount, currency) {
    if (currency === 'USD') return localAmount;
    const { getRateToUSD } = await import('../portfolio/fx.js');
    const rate = await getRateToUSD(currency);
    return localAmount * rate;
}

function formatPrice(p) {
    if (!Number.isFinite(p)) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(3);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(8);
}

function formatUnits(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 100) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(8);
}

// Trade messaging now routes through the unified top-left notification
// stack (see js/ui/notify.js). Same green-drain pattern as the rest
// of the app.
function toast(msg, kind) {
    const map = { error: 'error', warn: 'warn', success: 'success', info: 'info' };
    notify(msg, { kind: map[kind] || 'info' });
}
