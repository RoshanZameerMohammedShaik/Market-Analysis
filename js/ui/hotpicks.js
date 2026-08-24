import { scanStockHotPicks, scanCryptoHotPicks, getHotPicksFloor } from '../hotpicks.js';
import { state, nextHotPicksId } from './state.js';
import { fmtPriceTag } from './format.js';
import { sparkline } from './sparkline.js';
import { displayTicker } from './exchanges.js';
import { bindLiveSparks, stopLiveSparks } from './live-spark.js';
import { revealStagger, drawLine, countTo, canAnimate, flipCapture, flipAnimate } from './motion.js';
import { success, cardArrival, click as clickSound, error as errorSound } from './ui-sound.js';

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
    // Capture positions BEFORE the DOM mutates so Flip can animate surviving
    // cards to their new slots. Cards match old→new across the innerHTML
    // rebuild by data-flip-id (=symbol). No-ops to null under reduced-motion.
    const flipState = filtered.length > 0 ? flipCapture(grid.querySelectorAll('.hot-pick-card')) : null;
    if (filtered.length === 0) {
        // Flip can't animate to zero surviving nodes through an innerHTML
        // replace (review Issue 7) — just swap instantly + a soft "no matches".
        grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
            <div class="empty-state-icon">📈</div>
            <p>No hot picks under ${labelFor(pennyFilter)} right now. Try a different filter.</p>
        </div>`;
        errorSound();
    } else {
        renderCards(grid, filtered, false);
        bindCardClicks(grid, currentOnPick);
        // Cards already exist (past streaming) so we don't run the full
        // entrance — just the Flip re-order. flipAnimate no-ops on null state.
        flipAnimate(flipState, { duration: 0.5, stagger: 0.03 });
        clickSound();
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
    // Scan-scoped reset of the GSAP entrance opt-out (review fix, Issue 1):
    // clear it at the top of EVERY scan so the streaming-phase cards always
    // fall back to the CSS [data-streaming] suppression, and animateSettledGrid
    // re-arms GSAP ownership only on the settled render. Never a session latch.
    if (grid) grid.removeAttribute('data-gsap');
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
            // Hot Picks is BUY-only now. Empty means the engine read every
            // symbol it scanned as DON'T BUY / AVOID / SELL — no buy at all.
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-state-icon">📊</div>
                <p>No buy setups ${pennyFilter ? `under ${labelFor(pennyFilter)} ` : ''}right now — nothing the engine scanned came back as a BUY. Sit it out, or check back later.</p>
            </div>`;
            return;
        }

        // Final render: clear the streaming flag so the entrance animation
        // plays exactly once on the settled grid.
        delete grid.dataset.streaming;
        renderCards(grid, filtered, false);
        bindCardClicks(grid, onPick);
        // GSAP entrance — fires ONCE here, on the settled grid only (never in
        // onPartial), so streaming batches can't flicker it. requestId is
        // threaded so deferred sound chirps bail if a newer scan supersedes.
        animateSettledGrid(grid, requestId);
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
                // highPercent now comes from the calibrated 80% band's upper edge, not a
                // direction-scaled ATR guess, so 'Spike Expected' would overclaim: it is
                // the top of a range, and the engine does not call which edge price
                // approaches. Label it as range headroom instead.
                const word = 'Range Top ⚡';
                return `<div class="hot-pick-spike">${p >= 0 ? '+' : ''}${p.toFixed(2)}% ${word}</div>`;
            })()
            : '';
        const highHTML = (pick.expectedHigh != null && Number.isFinite(pick.expectedHigh))
            ? `<div class="hot-pick-target hot-pick-target-high"><span class="hot-pick-target-label">Range High (80%)</span> <span class="hot-pick-target-value">${fmtPriceTag(pick.expectedHigh, co)}</span></div>`
            : '';
        const lowHTML = (pick.expectedLow != null && Number.isFinite(pick.expectedLow))
            ? `<div class="hot-pick-target hot-pick-target-low"><span class="hot-pick-target-label">Range Low (80%)</span> <span class="hot-pick-target-value">${fmtPriceTag(pick.expectedLow, co)}</span></div>`
            : '';
        // HONESTY GUARD (display-only): a directional BUY/SELL whose CALIBRATED
        // confidence is below 50% is, on the engine's own grounded data, worse
        // than a coin flip on its OWN direction — a contradiction we must not
        // present as a clean "BUY · 25%". Flag it as a rebuilding/low-trust
        // read so the number isn't mistaken for real conviction. Does NOT
        // change the signal or the number — just adds a caveat the eye catches.
        const lowTrust = (isBuy || isSell) && Number.isFinite(pick.confidence) && pick.confidence < 50;
        const lowTrustHTML = lowTrust
            ? `<div class="hot-pick-lowtrust" title="Calibrated confidence is below 50% — the engine's track record for setups like this (under the current engine) doesn't yet support high conviction. Treat as exploratory, not a strong call.">⚠ low track record — exploratory</div>`
            : '';
        return `
        <div class="hot-pick-card ${signalClass}${lowTrust ? ' lowtrust' : ''}" data-symbol="${pick.symbol}" data-id="${pick.id || pick.symbol}" data-flip-id="${pick.symbol}"${sparkSeed}>
            <div class="hot-pick-symbol">${displayTicker(pick.symbol)}</div>
            <div class="hot-pick-name">${pick.name}</div>
            <div class="hot-pick-spark">${sparkSvg}</div>
            <div class="hot-pick-signal-badge ${signalClass}">${signalLabel}</div>
            <div class="hot-pick-confidence ${signalClass}" title="Engine confidence (calibrated)"><span class="hot-pick-arrow">${arrow}</span> <span class="hot-pick-conf-num" data-conf-target="${pick.confidence}">${pick.confidence}</span>% Confidence</div>
            ${lowTrustHTML}
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

// GSAP entrance for the SETTLED hot-picks grid. Called once per scan from the
// final-render path (never onPartial). Cascade is capped so a 100-card grid
// isn't slow-mo; sparklines draw (stock only — crypto sparklines are live-fed
// and would collide with the draw, review Issue 2); confidence counts up.
// No-ops cleanly under reduced-motion / no-GSAP (CSS card-rise stays the
// fallback because we never set [data-gsap] in that path).
const ENTRANCE_CAP = 12;
function animateSettledGrid(grid, requestId) {
    if (!grid || !canAnimate()) return;          // CSS fallback owns it
    grid.setAttribute('data-gsap', '1');         // suppress the CSS card-rise
    const cards = [...grid.querySelectorAll('.hot-pick-card')];
    if (!cards.length) { grid.removeAttribute('data-gsap'); return; }
    const lead = cards.slice(0, ENTRANCE_CAP);
    // Staggered rise (clearProps:'transform' default hands the card back to the
    // 3D cursor-tilt at rest). Synchronous with the attribute set — no await —
    // so there's no flash-of-final-state.
    revealStagger(lead, { y: 14, duration: 0.5, stagger: 0.045, from: 'start' });
    // Cards beyond the cap fade in as one block (no per-card stagger) so the
    // boundary doesn't hard-pop on mid-size grids (review Issue, low-sev (b)).
    if (cards.length > ENTRANCE_CAP) revealStagger(cards.slice(ENTRANCE_CAP), { y: 8, duration: 0.3, stagger: 0 });
    const isCrypto = state.mode === 'crypto';
    lead.forEach((card, i) => {
        // Sparkline draw-in — STOCK only (crypto polylines get replaced by the
        // live feed mid-draw → glitchy pop; they animate via live ticks anyway).
        if (!isCrypto) {
            const poly = card.querySelector('.hot-pick-spark polyline');
            if (poly) drawLine(poly, { duration: 0.9, delay: i * 0.045 });
        }
        // Confidence count-up on the dedicated number span (arrow + "% Confidence"
        // literal stay untouched). No suffix.
        const num = card.querySelector('.hot-pick-conf-num');
        if (num) {
            const target = parseInt(num.getAttribute('data-conf-target'), 10);
            if (Number.isFinite(target)) countTo(num, 0, target, { duration: 0.7 });
        }
    });
    // Sound: one "grid ready" anchor, then up to 5 ascending arrival chirps
    // trailing the visual cascade. Each deferred chirp re-checks canEmit() AND
    // that this scan is still current (review Issue: stale deferred chirps).
    success();
    for (let i = 0; i < 5 && i < lead.length; i++) {
        setTimeout(() => { if (requestId === state.hotPicksRequestId) cardArrival(i); }, i * 45);
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
