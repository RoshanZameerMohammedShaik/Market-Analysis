import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { state, nextHotPicksId } from './state.js';
import { fmtPrice } from './format.js';

export async function loadHotPicks(onPick) {
    const requestId = nextHotPicksId();
    const grid = document.getElementById('hotpicks-grid');
    const title = document.getElementById('hotpicks-title');
    const tfLabel = state.timeframe === 'today' ? 'Today' : 'Tomorrow';
    const modeLabel = state.mode === 'stock' ? 'Stocks' : 'Crypto';
    if (title) title.textContent = `🔥 Hot Picks — Top ${modeLabel} for ${tfLabel}`;

    grid.innerHTML = `<div class="loading" style="grid-column: 1/-1;">
        <div class="loader"></div>
        <span class="loading-text" id="hotpicks-progress">Initializing...</span>
    </div>`;

    const updateProgress = msg => {
        const el = document.getElementById('hotpicks-progress');
        if (el) el.textContent = msg;
    };

    try {
        const currentMode = state.mode;
        const picks = currentMode === 'stock'
            ? await scanStockHotPicks(state.timeframe, 20, updateProgress)
            : await scanCryptoHotPicks(state.timeframe, 20, updateProgress);

        if (requestId !== state.hotPicksRequestId) return; // user switched tabs

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

        grid.innerHTML = picks.map(pick => {
            const isBuy = pick.signal === 'BUY';
            const arrow = isBuy ? '▲' : '◆';
            const signalClass = isBuy ? 'buy' : 'neutral';
            const signalLabel = isBuy ? 'BUY' : 'HOLD';
            return `
            <div class="hot-pick-card ${signalClass} fade-in" data-symbol="${pick.symbol}" data-id="${pick.id || pick.symbol}">
                <div class="hot-pick-symbol">${pick.symbol}</div>
                <div class="hot-pick-name">${pick.name}</div>
                <div class="hot-pick-signal-badge ${signalClass}">${signalLabel}</div>
                <div class="hot-pick-confidence ${signalClass}"><span class="hot-pick-arrow">${arrow}</span> ${pick.confidence}%</div>
                <div class="hot-pick-price">${fmtPrice(pick.price)}</div>
            </div>`;
        }).join('');

        grid.querySelectorAll('.hot-pick-card').forEach(card => {
            card.addEventListener('click', () => onPick({
                mode: state.mode,
                symbol: card.dataset.symbol,
                coinId: card.dataset.id !== card.dataset.symbol ? card.dataset.id : null,
            }));
        });
    } catch (e) {
        grid.innerHTML = `<div class="error-message" style="grid-column: 1/-1;">Failed to load hot picks: ${e.message}</div>`;
    }
}
