import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { state, nextHotPicksId } from './state.js';
import { fmtPriceTag } from './format.js';
import { sparkline } from './sparkline.js';
import { displayTicker } from './exchanges.js';

// Phase 8: Hot Picks penny sub-tabs.
// `pennyMode` is one of: null (no filter), 'p10' (<$10), 'p5' (<$5), 'p1' (<$1).
let pennyFilter = null;
let allPicks = [];
let currentOnPick = null;

const PRICE_THRESHOLDS = {
    p10: 10,
    p5: 5,
    p1: 1,
};

export function setPennyFilter(mode) {
    pennyFilter = mode === null ? null : (PRICE_THRESHOLDS[mode] ? mode : null);
    const grid = document.getElementById('hotpicks-grid');
    if (!grid) return;
    const filtered = applyPennyFilter(allPicks);
    if (filtered.length === 0) {
        grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
            <div class="empty-state-icon">📈</div>
            <p>No hot picks under ${labelFor(pennyFilter)} right now. Try a different filter.</p>
        </div>`;
    } else {
        renderCards(grid, filtered, false);
        bindCardClicks(grid, currentOnPick);
    }
    paintFilterButtons();
}

function labelFor(mode) {
    if (mode === 'p10') return '$10';
    if (mode === 'p5') return '$5';
    if (mode === 'p1') return '$1';
    return 'no limit';
}

function applyPennyFilter(picks) {
    if (!pennyFilter) return picks;
    const max = PRICE_THRESHOLDS[pennyFilter];
    if (!max) return picks;
    return picks.filter(p => Number.isFinite(p.price) && p.price < max);
}

function paintFilterButtons() {
    document.querySelectorAll('[data-penny-filter]').forEach(btn => {
        const f = btn.dataset.pennyFilter;
        btn.classList.toggle('active', (f === '' && !pennyFilter) || f === pennyFilter);
    });
}

export async function loadHotPicks(onPick) {
    currentOnPick = onPick;
    const requestId = nextHotPicksId();
    const grid = document.getElementById('hotpicks-grid');
    const title = document.getElementById('hotpicks-title');
    const tfLabel = state.timeframe === 'today' ? 'Today' : 'Tomorrow';
    const modeLabel = state.mode === 'stock' ? 'Stocks' : 'Crypto';
    if (title) title.textContent = `🔥 Hot Picks — Top ${modeLabel} for ${tfLabel}`;

    grid.innerHTML = `
        <div class="hp-skel-grid" style="grid-column: 1/-1;">
            ${Array.from({length: 12}).map(()=>`<div class="hp-skel"></div>`).join('')}
        </div>
        <div class="loading" style="grid-column: 1/-1;">
            <span class="loading-text" id="hotpicks-progress">Initializing…</span>
            <span class="loading-tip" id="loading-tip"></span>
        </div>`;

    const updateProgress = msg => {
        const el = document.getElementById('hotpicks-progress');
        if (el) el.textContent = msg;
    };

    const onPartial = (picks) => {
        if (requestId !== state.hotPicksRequestId) return;
        if (!picks || picks.length === 0) return;
        allPicks = picks;
        const filtered = applyPennyFilter(picks);
        renderCards(grid, filtered, true);
        bindCardClicks(grid, onPick);
    };

    try {
        const currentMode = state.mode;
        const picks = currentMode === 'stock'
            ? await scanStockHotPicks(state.timeframe, 20, updateProgress, onPartial)
            : await scanCryptoHotPicks(state.timeframe, 20, updateProgress, onPartial);

        if (requestId !== state.hotPicksRequestId) return;

        if (currentMode === 'crypto') {
            picks.forEach(pick => {
                if (pick.id && pick._sparkline) {
                    state.cryptoCache[pick.id] = { name: pick.name, price: pick.price, sparkline: pick._sparkline };
                }
            });
        }

        allPicks = picks;
        const filtered = applyPennyFilter(picks);

        if (filtered.length === 0) {
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-state-icon">📊</div>
                <p>No strong BUY signals found ${pennyFilter ? `under ${labelFor(pennyFilter)} ` : ''}right now. Market may be uncertain.</p>
            </div>`;
            return;
        }

        renderCards(grid, filtered, false);
        bindCardClicks(grid, onPick);
    } catch (e) {
        grid.innerHTML = `<div class="error-message" style="grid-column: 1/-1;">Failed to load hot picks: ${e.message}</div>`;
    }
}

function renderCards(grid, picks, withFooter) {
    const cardsHtml = picks.map(pick => {
        const isBuy = pick.signal === 'BUY';
        const arrow = isBuy ? '▲' : '◆';
        const signalClass = isBuy ? 'buy' : 'neutral';
        const signalLabel = isBuy ? 'BUY' : 'HOLD';
        const sparkData = pick._sparkline && pick._sparkline.length > 1 ? pick._sparkline : null;
        const sparkSvg = sparkData ? sparkline(sparkData) : '<div class="spark-placeholder"></div>';
        return `
        <div class="hot-pick-card ${signalClass}" data-symbol="${pick.symbol}" data-id="${pick.id || pick.symbol}">
            <div class="hot-pick-symbol">${displayTicker(pick.symbol)}</div>
            <div class="hot-pick-name">${pick.name}</div>
            <div class="hot-pick-spark">${sparkSvg}</div>
            <div class="hot-pick-signal-badge ${signalClass}">${signalLabel}</div>
            <div class="hot-pick-confidence ${signalClass}"><span class="hot-pick-arrow">${arrow}</span> ${pick.confidence}%</div>
            <div class="hot-pick-price">${fmtPriceTag(pick.price)}</div>
        </div>`;
    }).join('');

    if (withFooter) {
        grid.innerHTML = cardsHtml + `
            <div class="loading" style="grid-column: 1/-1; padding: 20px;">
                <span class="loading-text" id="hotpicks-progress">Refining…</span>
                <span class="loading-tip" id="loading-tip"></span>
            </div>`;
    } else {
        grid.innerHTML = cardsHtml;
    }
}

function bindCardClicks(grid, onPick) {
    grid.querySelectorAll('.hot-pick-card').forEach(card => {
        if (card.dataset.bound) return;
        card.dataset.bound = '1';
        card.addEventListener('click', () => onPick({
            mode: state.mode,
            symbol: card.dataset.symbol,
            coinId: card.dataset.id !== card.dataset.symbol ? card.dataset.id : null,
        }));
    });
}

export function initPennyFilterButtons() {
    document.querySelectorAll('[data-penny-filter]').forEach(btn => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            const f = btn.dataset.pennyFilter || null;
            setPennyFilter(f === '' ? null : f);
        });
    });
    paintFilterButtons();
}
