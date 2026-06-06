import { scanStockHotPicks, scanCryptoHotPicks, getHotPicksFloor } from '../hotpicks.js';
import { state, nextHotPicksId } from './state.js';
import { fmtPriceTag } from './format.js';
import { sparkline } from './sparkline.js';
import { displayTicker } from './exchanges.js';
import { bindLiveSparks, stopLiveSparks } from './live-spark.js';

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
    // Drop any live sparkline streams from the previous scan/mode before
    // we rebuild the grid. renderCards() re-binds for the new card set;
    // empty-state / error paths simply stay torn down.
    stopLiveSparks();
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
        // Mark the grid as mid-stream so the premium card-rise entrance
        // (css/premium.css) does NOT re-fire on every partial re-render —
        // otherwise the whole grid would flicker/re-animate on each batch
        // during a scan. The entrance plays once, on the final render below.
        grid.dataset.streaming = '1';
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
            // Empty only fires when zero BUY/SELL exist in the entire
            // scan — every directional pick now surfaces, ranked by
            // confidence. Each card carries a quality-tier badge so the
            // user can tell historically-reliable picks from speculative
            // ones at a glance (badge driven by hotpicks.js qualityTier).
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-state-icon">📊</div>
                <p>No directional setups ${pennyFilter ? `under ${labelFor(pennyFilter)} ` : ''}right now — every symbol the engine scanned came back as DON'T BUY or AVOID. Sit it out, or check back later.</p>
            </div>`;
            return;
        }

        // Final render: clear the streaming flag so the entrance animation
        // plays exactly once on the settled grid.
        delete grid.dataset.streaming;
        renderCards(grid, filtered, false);
        bindCardClicks(grid, onPick);
    } catch (e) {
        grid.innerHTML = `<div class="error-message" style="grid-column: 1/-1;">Failed to load hot picks: ${e.message}</div>`;
    }
}

function renderCards(grid, picks, withFooter) {
    const cardsHtml = picks.map(pick => {
        // HOLD is reserved for owned-position framing (see prompt rules).
        // Hot Picks shows BUY for engine BUYs, "DON'T BUY" for NEUTRAL,
        // SELL for SELL, AVOID for NO_TRADE — same vocabulary as the
        // main signal card and watchlist.
        const isBuy = pick.signal === 'BUY';
        const isSell = pick.signal === 'SELL';
        const isAvoid = pick.signal === 'NO_TRADE';
        const arrow = isBuy ? '▲' : isSell ? '▼' : '◆';
        const signalClass = isBuy ? 'buy' : isSell ? 'sell' : 'neutral';
        const signalLabel = isBuy ? 'BUY'
            : isSell ? 'SELL'
            : isAvoid ? 'AVOID'
            : "DON'T BUY";
        const sparkData = pick._sparkline && pick._sparkline.length > 1 ? pick._sparkline : null;
        const sparkSvg = sparkData ? sparkline(sparkData) : '<div class="spark-placeholder"></div>';
        // Seed attribute for live-ticking sparklines (crypto only). The
        // live-spark module reads this to start its rolling buffer from
        // real data rather than a flat point. Only emitted when we have
        // a usable series; stocks never get one (no live feed).
        const sparkSeed = (sparkData && state.mode === 'crypto')
            ? ` data-spark="${encodeURIComponent(JSON.stringify(sparkData.slice(-40)))}"`
            : '';
        // Verbose labels per Roshan's spec:
        //   "56% Confidence"
        //   "5% Spike Expected ⚡"
        //   "Expected Highest Reach $X"
        //   "Expected Lowest Fall $Y"
        // All four lines surface so the user can read the FULL forecast
        // at a glance without clicking into the card. Source-currency
        // is threaded so non-USD listings render in their native quote
        // currency (no FX-multiplied INR-as-USD bug).
        const co = { srcCurrency: pick.currency || 'USD' };
        // Direction-aware label: a SELL's expectedPct is now negative (the
        // predicted drop), so calling it "Spike Expected" would contradict
        // the move. Positive → "Spike Expected ⚡", negative → "Drop Expected".
        const spikeHTML = (pick.expectedPct != null && Number.isFinite(pick.expectedPct))
            ? (() => {
                const p = Number(pick.expectedPct);
                const word = p >= 0 ? 'Spike Expected ⚡' : 'Drop Expected ⚡';
                return `<div class="hot-pick-spike">${p >= 0 ? '+' : ''}${p.toFixed(2)}% ${word}</div>`;
            })()
            : '';
        const highHTML = (pick.expectedHigh != null && Number.isFinite(pick.expectedHigh))
            ? `<div class="hot-pick-target hot-pick-target-high"><span class="hot-pick-target-label">Expected Highest Reach</span> <span class="hot-pick-target-value">${fmtPriceTag(pick.expectedHigh, co)}</span></div>`
            : '';
        const lowHTML = (pick.expectedLow != null && Number.isFinite(pick.expectedLow))
            ? `<div class="hot-pick-target hot-pick-target-low"><span class="hot-pick-target-label">Expected Lowest Fall</span> <span class="hot-pick-target-value">${fmtPriceTag(pick.expectedLow, co)}</span></div>`
            : '';
        return `
        <div class="hot-pick-card ${signalClass}" data-symbol="${pick.symbol}" data-id="${pick.id || pick.symbol}"${sparkSeed}>
            <div class="hot-pick-symbol">${displayTicker(pick.symbol)}</div>
            <div class="hot-pick-name">${pick.name}</div>
            <div class="hot-pick-spark">${sparkSvg}</div>
            <div class="hot-pick-signal-badge ${signalClass}">${signalLabel}</div>
            <div class="hot-pick-confidence ${signalClass}" title="Engine confidence (calibrated)"><span class="hot-pick-arrow">${arrow}</span> ${pick.confidence}% Confidence</div>
            ${spikeHTML}
            ${highHTML}
            ${lowHTML}
            <div class="hot-pick-price hot-pick-current-price"><span class="hot-pick-target-label">Current Price</span> <span class="hot-pick-target-value">${fmtPriceTag(pick.price, co)}</span></div>
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
    // (Re)bind live-ticking sparklines to the freshly-rendered crypto
    // cards. No-op for stock cards (no live feed). Diffs against the
    // currently-streaming set so re-renders don't leak Binance sockets.
    bindLiveSparks(grid);
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
