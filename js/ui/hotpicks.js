import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { state, nextHotPicksId } from './state.js';
import { fmtPriceTag } from './format.js';
import { sparkline } from './sparkline.js';

export async function loadHotPicks(onPick) {
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

    // Render a partial set as it arrives. The skeleton tiles get progressively
    // replaced; once final picks land, the loading footer is replaced too.
    const onPartial = (picks) => {
        if (requestId !== state.hotPicksRequestId) return;
        if (!picks || picks.length === 0) return;
        renderCards(grid, picks, /* withFooter */ true);
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

        if (picks.length === 0) {
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-state-icon">📊</div>
                <p>No strong BUY signals found right now. Market may be uncertain.</p>
            </div>`;
            return;
        }

        renderCards(grid, picks, /* withFooter */ false);
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
            <div class="hot-pick-symbol">${pick.symbol}</div>
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
