// Sector relative-strength heatmap.
//
// A one-glance grid showing where money is rotating across the 11 SPDR
// sectors — each tile color-graded by its 5-day move (the same metric
// the engine already uses for per-symbol sector alignment in sectors.js,
// so the heatmap and the signal card never disagree).
//
// Mounts as a collapsible section (like the Watchlist / Full Ledger),
// lazy-loads on first open, and refreshes on demand. No new data source:
// it reuses getAllSectorTrends() which hits the same cached ETF trends.

import { getAllSectorTrends } from '../sectors.js';

let loaded = false;
let loading = false;

// Map a 5-day percentage move to a heat class. Symmetric around zero;
// the thresholds match sectors.js's ±1% rising/falling cut so the
// "hot/cold" read is consistent with the engine's alignment logic.
function heatClass(pct) {
    if (pct >= 3) return 'heat-strong-up';
    if (pct >= 1) return 'heat-up';
    if (pct > -1) return 'heat-flat';
    if (pct > -3) return 'heat-down';
    return 'heat-strong-down';
}

function renderTiles(trends) {
    if (!trends || !trends.length) {
        return '<div class="sector-heatmap-empty">Sector data unavailable right now — try refreshing.</div>';
    }
    return trends.map(t => {
        const sign = t.pct5d >= 0 ? '+' : '';
        return `
            <div class="sector-tile ${heatClass(t.pct5d)}" title="${t.name} (${t.etf}) — ${sign}${t.pct5d.toFixed(2)}% over 5 trading days">
                <div class="sector-tile-etf">${t.etf}</div>
                <div class="sector-tile-name">${t.name}</div>
                <div class="sector-tile-pct">${sign}${t.pct5d.toFixed(2)}%</div>
            </div>`;
    }).join('');
}

async function loadInto(grid, { force = false } = {}) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    grid.innerHTML = '<div class="sector-heatmap-loading">Reading sector flows…</div>';
    try {
        const trends = await getAllSectorTrends();
        grid.innerHTML = renderTiles(trends);
        loaded = trends.length > 0;
    } catch (_) {
        grid.innerHTML = '<div class="sector-heatmap-empty">Failed to load sector data.</div>';
    } finally {
        loading = false;
    }
}

export function initSectorHeatmap() {
    // Mount after the Full Ledger (scanner) section — same power-user zone.
    if (document.getElementById('sector-heatmap-section')) return;
    const after = document.getElementById('scanner-section') || document.querySelector('.hotpicks-section');
    if (!after) return;
    const html = `
        <section class="sector-heatmap-section" id="sector-heatmap-section">
            <details class="sector-heatmap-details">
                <summary class="sector-heatmap-summary">
                    <span class="sector-heatmap-title">🗺️ Sector Heatmap</span>
                    <span class="sector-heatmap-hint">Where money is rotating — 5-day relative strength across all 11 sectors</span>
                    <button class="sector-heatmap-refresh" id="sector-heatmap-refresh" title="Refresh sector data">↻</button>
                </summary>
                <div class="sector-heatmap-grid" id="sector-heatmap-grid"></div>
                <div class="sector-heatmap-legend">
                    <span class="legend-swatch heat-strong-down"></span><span class="legend-swatch heat-down"></span>
                    <span class="legend-label">weaker</span>
                    <span class="legend-swatch heat-flat"></span>
                    <span class="legend-label">stronger</span>
                    <span class="legend-swatch heat-up"></span><span class="legend-swatch heat-strong-up"></span>
                </div>
            </details>
        </section>`;
    after.insertAdjacentHTML('afterend', html);

    const details = document.querySelector('#sector-heatmap-section .sector-heatmap-details');
    const grid = document.getElementById('sector-heatmap-grid');
    // Lazy-load on first expand.
    details.addEventListener('toggle', () => {
        if (details.open) loadInto(grid);
    });
    const refreshBtn = document.getElementById('sector-heatmap-refresh');
    refreshBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        loadInto(grid, { force: true });
    });
}

// Programmatic open — used by Mia's open_sector_heatmap tool. Expands the
// section, scrolls it into view, and ensures data is loaded.
export function openSectorHeatmap() {
    initSectorHeatmap();
    const details = document.querySelector('#sector-heatmap-section .sector-heatmap-details');
    if (!details) return false;
    details.open = true;
    const grid = document.getElementById('sector-heatmap-grid');
    if (grid) loadInto(grid);
    document.getElementById('sector-heatmap-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
}

// Returns the current sector trends for Mia to answer "what's the
// strongest sector today?" without opening the panel. Cached via
// getAllSectorTrends's underlying ETF cache.
export async function getSectorTrendsForMia() {
    try { return await getAllSectorTrends(); } catch (_) { return []; }
}
