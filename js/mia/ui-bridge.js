// The single chokepoint between Mia and the live app.
//
// Why centralise: Mia is allowed to navigate and trigger re-analysis,
// but MUST NOT mutate any number that influences signals (calibration,
// confidence, prediction logs, source weights). Routing every Mia
// action through this module gives us one place to enforce that rule.
//
// Design contract:
//   - read*() functions: return live state and snapshots, never mutate.
//   - control*() functions: navigate / reflow the UI, allowed to call
//     existing app handlers (search picks, tab clicks, theme toggle,
//     hot-picks refresh). They CANNOT touch state.calibration, the
//     prediction log, the model JSON, or any signal number.
//
// If you find yourself adding a setNumber-style export here, stop.

import { state } from '../ui/state.js';
import { searchStocks, searchCrypto } from '../data.js';
import { getCalibrationStatus, getCalibrationCurve, getCalibrationByTier, getCalibrationByVolTier, getCalibrationRecency } from '../calibration.js';
import { getStats, getSourceAccuracy } from '../outcome-tracker.js';
import { setPennyFilter } from '../ui/hotpicks.js';
import { findSpikers, BUCKETS, bucketById } from '../spike-detector.js';
import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { clearHistory as clearMiaHistory } from './memory.js';
import { announce, pulseElementById, typeIntoInput, pressButton, sleep, showAgentToast } from './agent-pulse.js';
import { loadLedger } from '../ledger-reader.js';

/**
 * Programmatic equivalent of the user typing a symbol and clicking the
 * first match. Reuses the existing search flow so we don't bypass any
 * validation. Stocks only — crypto picks need a coingecko id which we
 * resolve here from the search result.
 */
export async function controlSelectSymbol({ symbol, mode = 'stock' }) {
    if (!symbol) throw new Error('symbol required');
    const sym = String(symbol).trim();
    if (mode === 'stock') {
        // Switch tab if needed.
        const stockTab = document.querySelector('[data-tab="stock"]');
        if (stockTab && !stockTab.classList.contains('active')) stockTab.click();
        const matches = await searchStocks(sym);
        if (!matches.length) throw new Error(`no stock match for ${sym}`);
        const target = matches.find(m => m.symbol.toUpperCase() === sym.toUpperCase()) || matches[0];
        return triggerSearchPick(target.symbol);
    }
    if (mode === 'crypto') {
        const cryptoTab = document.querySelector('[data-tab="crypto"]');
        if (cryptoTab && !cryptoTab.classList.contains('active')) cryptoTab.click();
        const matches = await searchCrypto(sym);
        if (!matches.length) throw new Error(`no crypto match for ${sym}`);
        const target = matches.find(m => m.symbol.toUpperCase() === sym.toUpperCase()) || matches[0];
        return triggerSearchPick(target.symbol);
    }
    throw new Error(`unknown mode: ${mode}`);
}

function triggerSearchPick(symbol) {
    return new Promise((resolve) => {
        const input = document.getElementById('search-input');
        if (!input) return resolve({ ok: false, reason: 'no-search-input' });
        announce({ text: `Loading ${symbol}…`, target: input });
        input.value = symbol;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Click the first matching dropdown item shortly after.
        setTimeout(() => {
            const item = document.querySelector(`.search-result-item[data-symbol="${symbol}"]`)
                || document.querySelector('.search-result-item');
            if (item) item.click();
            setTimeout(() => pulseElementById('signal-section'), 800);
            resolve({ ok: true, picked: symbol });
        }, 600);
    });
}

export async function controlSwitchMode(mode) {
    const btn = document.querySelector(`[data-tab="${mode}"]`);
    if (!btn) throw new Error(`unknown mode tab: ${mode}`);
    showAgentToast(`Switching to ${mode}…`);
    await pressButton(btn);
    return { ok: true, mode };
}

export async function controlSwitchTimeframe(timeframe) {
    const btn = document.querySelector(`[data-timeframe="${timeframe}"]`);
    if (!btn) throw new Error(`unknown timeframe: ${timeframe}`);
    showAgentToast(`Switching to ${timeframe}…`);
    await pressButton(btn);
    return { ok: true, timeframe };
}

export async function controlCycleTheme() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) throw new Error('theme toggle missing');
    showAgentToast('Switching theme…');
    await pressButton(btn);
    return { ok: true, theme: state.theme };
}

export function controlTogglePL() {
    // The standalone P&L sidebar / header button was removed; the
    // calculator now lives inside the portfolio panel. Tool calls
    // requesting the P&L panel route there: open the portfolio panel
    // and expand the inline calc <details> section.
    const launcher = document.getElementById('portfolio-launcher');
    if (!launcher) throw new Error('portfolio launcher missing');
    announce({ text: 'Opening P&L calculator…', target: launcher });
    if (!document.body.classList.contains('side-panel-portfolio-open')) {
        launcher.click();
    }
    const section = document.getElementById('portfolio-pl-section');
    if (section && !section.open) section.open = true;
    return { ok: true, host: 'portfolio-panel' };
}

export async function controlRefreshHotPicks() {
    const btn = document.getElementById('refresh-hotpicks');
    if (!btn) throw new Error('hot-picks refresh missing');
    showAgentToast('Refreshing Hot Picks…');
    await pressButton(btn);
    return { ok: true };
}

export function controlSetPennyFilter({ tier }) {
    const map = { all: null, none: null, '': null, p10: 'p10', p5: 'p5', p1: 'p1', '<10': 'p10', '<5': 'p5', '<1': 'p1', '10': 'p10', '5': 'p5', '1': 'p1' };
    const norm = map[String(tier ?? '').toLowerCase().trim()];
    if (norm === undefined) throw new Error(`unknown penny tier: ${tier} (use one of: all, p10, p5, p1)`);
    setPennyFilter(norm);
    document.querySelectorAll('[data-penny-filter]').forEach(btn => {
        const f = btn.dataset.pennyFilter || null;
        btn.classList.toggle('active', (f === null && norm === null) || f === norm);
    });
    const labelMap = { p10: 'under $10', p5: 'under $5', p1: 'under $1' };
    const label = labelMap[norm] || 'all prices';
    const target = document.querySelector(`[data-penny-filter="${norm || ''}"]`) || pulseElementById('hotpicks-grid');
    announce({ text: `Filtering Hot Picks (${label})…`, target });
    return { ok: true, pennyTier: norm || 'all' };
}

export async function controlOpenSpikers() {
    const btn = document.getElementById('spikers-btn');
    if (!btn) throw new Error('spikers button missing');
    showAgentToast('Opening Spikers…');
    await pressButton(btn);
    return { ok: true };
}

export async function controlOpenAbout() {
    const btn = document.getElementById('about-btn');
    if (!btn) throw new Error('about button missing');
    showAgentToast('Opening About…');
    await pressButton(btn);
    return { ok: true };
}

export async function controlToggleCurrency() {
    const btn = document.getElementById('currency-toggle');
    if (!btn) throw new Error('currency toggle missing');
    showAgentToast('Switching currency…');
    await pressButton(btn);
    return { ok: true };
}

function ensurePLOpen() {
    // If the P&L calculator has been moved into the portfolio side panel
    // (the new home as of the portfolio-panel feature), open the
    // portfolio panel and expand the calc <details>. Otherwise fall back
    // to the legacy pl-toggle classic-sidebar path.
    const movedHost = document.getElementById('portfolio-pl-host');
    const calc = document.getElementById('pl-sidebar');
    if (movedHost && calc && movedHost.contains(calc)) {
        const launcher = document.getElementById('portfolio-launcher');
        if (launcher && !document.body.classList.contains('side-panel-portfolio-open')) {
            launcher.click();
        }
        const section = document.getElementById('portfolio-pl-section');
        if (section && !section.open) section.open = true;
        return;
    }
    if (!document.body.classList.contains('pl-open')) {
        const btn = document.getElementById('pl-toggle');
        if (btn) btn.click();
    }
}

export async function controlPLCalculate({ investment, buyPrice, currentPrice }) {
    const inv = Number(investment);
    const buy = Number(buyPrice);
    if (!Number.isFinite(inv) || inv <= 0) throw new Error('investment must be a positive number');
    if (!Number.isFinite(buy) || buy <= 0) throw new Error('buyPrice must be a positive number');

    let cur = Number(currentPrice);
    let usedCurrent = false;
    if (!Number.isFinite(cur) || cur <= 0) {
        if (Number.isFinite(state.currentPrice) && state.currentPrice > 0) {
            cur = Number(state.currentPrice);
            usedCurrent = true;
        } else {
            throw new Error('currentPrice required (or load a symbol first to use the live price)');
        }
    }

    // Open the agentic stage and pull #pl-sidebar into the centered
    // glass card. Roshan's spec: aurora-blurred backdrop + rising
    // white particles + Mia stays minimized as the orb. Subsequent
    // pl_calculate calls (multi-scenario flow) re-use the same stage
    // since openAgenticStage() is idempotent — it closes any prior
    // stage before opening the new one.
    const { openAgenticStage } = await import('../ui/agentic-stage.js');
    const sym = usedCurrent && state.currentSymbol ? state.currentSymbol : null;
    const subtitle = sym
        ? `Calculating profit/loss on ${sym} at the live price.`
        : 'Calculating profit/loss for your scenario.';
    await openAgenticStage({
        host: 'pl-sidebar',
        title: 'P&L Calculator',
        subtitle,
        variant: 'pl',
    });

    const invEl = document.getElementById('pl-investment');
    const buyEl = document.getElementById('pl-buyPrice');
    const curEl = document.getElementById('pl-currentPrice');
    const calcBtn = document.getElementById('pl-calcBtn');
    if (!invEl || !buyEl || !curEl || !calcBtn) throw new Error('P&L calculator inputs not found');

    // Clear any stale values from a previous run so the typing reads as
    // Mia filling a fresh form.
    invEl.value = ''; buyEl.value = ''; curEl.value = '';

    // Type each field in slowly, in order, at a visible speed — so the
    // user literally watches Mia fill the calculator rather than seeing
    // the numbers blink into place. A short toast precedes each field.
    announce({ text: 'Entering your investment…', target: invEl });
    await typeIntoInput(invEl, inv.toFixed(2), { perChar: 80 });
    await sleep(220);
    announce({ text: 'Entering the purchase price…', target: buyEl });
    await typeIntoInput(buyEl, buy.toFixed(2), { perChar: 80 });
    await sleep(220);
    announce({ text: usedCurrent ? 'Filling in the live price…' : 'Entering the target price…', target: curEl });
    await typeIntoInput(curEl, cur.toFixed(2), { perChar: 80 });
    await sleep(320);

    // Visibly press Calculate, then reveal the result — scroll it into
    // view inside the (mid-screen, scrollable) stage card so the user
    // sees the profit/loss land instead of it sitting below the fold.
    announce({ text: 'Calculating…' });
    await pressButton(calcBtn, { preDelay: 400 });
    setTimeout(() => {
        const resEl = document.getElementById('pl-result');
        if (resEl) {
            try { resEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
            pulseElementById('pl-result');
        }
        // Soft "done" chime as the P&L total lands (self-gated by sound.js).
        import('./sound.js').then(m => m.complete()).catch(() => {});
    }, 250);

    const shares = inv / buy;
    const value = shares * cur;
    const pl = value - inv;
    const pct = ((cur - buy) / buy) * 100;
    return {
        ok: true,
        investment: inv,
        buyPrice: buy,
        currentPrice: cur,
        usedLivePrice: usedCurrent,
        symbol: usedCurrent ? state.currentSymbol : null,
        shares: +shares.toFixed(4),
        currentValue: +value.toFixed(2),
        plDollar: +pl.toFixed(2),
        plPct: +pct.toFixed(2),
    };
}

export function controlScrollTo({ section }) {
    const map = {
        chart: 'tradingview-widget',
        signal: 'signal-section',
        accuracy: 'accuracy-strip',
        hotpicks: 'hotpicks-grid',
        'hot-picks': 'hotpicks-grid',
        search: 'search-input',
    };
    const id = map[String(section || '').toLowerCase().trim()];
    if (!id) throw new Error(`unknown section: ${section} (use: chart, signal, accuracy, hotpicks, search)`);
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} not on page`);
    announce({ text: `Jumping to ${section}…`, target: el });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (id === 'search-input') try { el.focus(); } catch (_) {}
    return { ok: true, section };
}

export async function controlRunAnalysis() {
    const btn = document.getElementById('refresh-analysis');
    if (btn) { showAgentToast('Rerunning analysis…'); await pressButton(btn); return { ok: true, via: 'refresh' }; }
    // Fallback: re-trigger search pick if a symbol is loaded.
    if (state.currentSymbol) {
        return triggerSearchPick(state.currentSymbol).then(r => ({ ...r, via: 'search-rerun' }));
    }
    throw new Error('no symbol selected to analyze');
}

/**
 * Read-only snapshot of every load-bearing piece of UI state Mia might
 * want to reason about. Never mutates anything.
 */
export function readUiSnapshot() {
    return {
        mode: state.mode,
        timeframe: state.timeframe,
        theme: state.theme,
        currentSymbol: state.currentSymbol,
        currentCoinId: state.currentCoinId,
        currentPrice: state.currentPrice,
        plOpen: document.body.classList.contains('pl-open'),
        latestSignalSummary: summariseLatestSignal(),
    };
}

function summariseLatestSignal() {
    const sig = window.__miaLatestSignal;
    if (!sig) return null;
    return {
        signal: sig.signal,
        confidence: sig.confidence,
        rawConfidence: sig.rawConfidence,
        trendRegime: sig.trendRegime,
        priceTargets: sig.priceTargets,
        topReasons: sig.reasons?.slice(0, 5),
    };
}

export function readCalibrationSnapshot() {
    return {
        status: getCalibrationStatus(),
        global: getCalibrationCurve(),
        byLiquidityTier: getCalibrationByTier(),
        byVolTier: getCalibrationByVolTier(),
        recencyWeighted: getCalibrationRecency(),
    };
}

export function readAccuracyStats() {
    return getStats();
}

export async function findSpikersDirect({ bucket = 'gte10', limit = 10 } = {}) {
    const b = bucketById(bucket);
    if (!b) throw new Error(`unknown bucket: ${bucket}. Use one of: ${BUCKETS.map(x => x.id).join(', ')}`);
    const scan = state.mode === 'crypto' ? scanCryptoHotPicks : scanStockHotPicks;
    const picks = await scan(state.timeframe, 50, () => {});
    const candidates = picks.map(p => ({ symbol: p.symbol, id: p.id, name: p.name, price: p.price, candles: null }));
    const results = await findSpikers(candidates, b, () => {}, { mode: state.mode });
    const lim = Math.max(1, Math.min(20, Number(limit) || 10));
    return {
        bucket: b.id,
        bucketLabel: b.label,
        mode: state.mode,
        count: results.length,
        candidates: results.slice(0, lim).map(r => ({
            symbol: r.symbol, name: r.name, currentPrice: r.price,
            targetPrice: r.targetPrice, projectedPct: r.projectedPct,
            confidence: r.confidence, calibrated: r.calibrated, reason: r.reason,
        })),
    };
}

export function readPredictionLog({ limit = 10 } = {}) {
    let log = [];
    try {
        const raw = localStorage.getItem('ma-prediction-log');
        log = raw ? JSON.parse(raw) : [];
    } catch (_) { log = []; }
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const recent = log.slice(-lim).map(p => ({
        symbol: p.symbol, mode: p.mode, signal: p.signal, confidence: p.confidence,
        priceAtPrediction: p.price, timeframe: p.timeframe,
        timestamp: p.timestamp, resolved: !!p.resolved,
        priceAtResolve: p.priceAtResolve ?? null, correct: p.correct ?? null,
    }));
    return { totalLogged: log.length, returned: recent.length, recent };
}

// Ledger reading moved to standalone js/ledger-reader.js so the
// confidence engine can read the ledger without depending on the
// whole Mia tool surface. Re-export readLedgerHistory so existing
// Mia tool callers keep working unchanged. loadLedger stays as a
// direct import (used by readTopLosers below).
export { readLedgerHistory } from '../ledger-reader.js';

// Top losers / movers from today's ledger. Looks at rows whose 1d horizon
// has resolved and ranks by largest negative pctMove (or absolute pctMove
// if the user wants "biggest movers either way"). Powered by the same
// ledger the engine writes — no scraping news sites for "top losers"
// articles, just the actual outcomes our cron recorded.
//
// IMPORTANT: this is scoped to OUR tracked universe (~530 symbols across
// the regions we cover). The "worst performing stock today" answer is
// "worst performer in our universe" — NOT "worst performer in all of
// global markets." A microcap ADR like ZCMD that's not in our coverage
// won't appear, even if it dropped 60%. The coverage object in the
// return value makes that explicit so Mia can honestly qualify her
// answer instead of presenting a tracked-universe winner as a global
// truth.
export async function readTopLosers({ region, limit = 10, side = 'down' } = {}) {
    const rows = await loadLedger();
    if (!rows.length) {
        return { available: false, note: 'Ledger not seeded yet — needs at least one cron run.' };
    }
    // Pick the most recent date that has any resolved 1d horizons. Today's
    // crons may not have resolved yet (resolve cron runs at 22:00 UTC), so
    // we walk back from latest to find the freshest resolved set.
    const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
    let chosenDate = null;
    let scoped = [];
    for (const d of dates) {
        const dayRows = rows.filter(r => r.date === d && r.horizons?.['1'] && Number.isFinite(r.horizons['1'].pctMove));
        if (dayRows.length >= 5) { chosenDate = d; scoped = dayRows; break; }
    }
    if (!chosenDate) {
        return { available: false, note: 'No resolved 1d horizons in the ledger yet — wait for the next outcome-resolution cron.' };
    }
    // Build coverage metadata BEFORE region-filtering, so Mia knows the
    // full universe size + the regions we actually track.
    const allRegions = [...new Set(scoped.map(r => String(r.region || '').toUpperCase()).filter(Boolean))].sort();
    const coverage = {
        universeSize: scoped.length,
        regions: allRegions,
        scope: 'tracked-only',
        note: `Limited to the ~530 symbols our engine tracks (S&P 500, Nasdaq 100, sector reps, top crypto, plus liquid names from NSE / HKEX / TYO / LSE / DAX / ASX). Stocks outside this universe — small-cap ADRs, OTC, foreign micro-caps — are not visible here. For absolute-worst-in-all-markets answers, use a web search.`,
    };
    if (region) {
        const reg = String(region).toUpperCase();
        scoped = scoped.filter(r => String(r.region || '').toUpperCase() === reg);
        if (!scoped.length) {
            return { available: false, note: `No resolved rows for region ${reg} on ${chosenDate}.`, asOfDate: chosenDate, coverage };
        }
    }
    const sideLower = String(side || 'down').toLowerCase();
    let ranked;
    if (sideLower === 'up') {
        ranked = scoped.slice().sort((a, b) => b.horizons['1'].pctMove - a.horizons['1'].pctMove);
    } else if (sideLower === 'movers') {
        ranked = scoped.slice().sort((a, b) => Math.abs(b.horizons['1'].pctMove) - Math.abs(a.horizons['1'].pctMove));
    } else {
        // 'down' = worst performers, most-negative pctMove first
        ranked = scoped.slice().sort((a, b) => a.horizons['1'].pctMove - b.horizons['1'].pctMove);
    }
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const top = ranked.slice(0, lim).map(r => ({
        symbol: r.symbol,
        region: r.region,
        signal: r.signal,
        confidence: r.confidence,
        entryPrice: r.entry,
        actualClose: r.horizons['1'].actualClose,
        pctMove1d: r.horizons['1'].pctMove,
        directionMatch: r.horizons['1'].directionMatch,
    }));
    return {
        available: true,
        asOfDate: chosenDate,
        side: sideLower,
        region: region || 'all',
        candidatesConsidered: scoped.length,
        coverage,
        results: top,
    };
}

/**
 * Find ledger rows whose feature vector is closest to a target setup,
 * then summarize how those past setups played out at each horizon.
 *
 * Why this is useful: instead of saying "the model is 52% accurate
 * overall", Mia can answer "the last 14 times we saw this exact pattern
 * (RSI ~28, MACD positive, BB lower band), 9 closed up at +1d, 7 at +5d".
 * Concrete + grounded in real outcomes. Resists hallucination because
 * the answer comes straight from the ledger structured data, not the
 * LLM's prior.
 *
 * Distance metric: normalized euclidean on the 3 stored indicator
 * features (RSI scaled 0-100, MACD histogram standardised, BB %B
 * scaled 0-1). Three features sounds tiny but it's what record_*.py
 * actually persists, and it's already enough to discriminate
 * "oversold-bounce" setups from "overbought-mean-revert" setups.
 *
 * Returns null if the ledger doesn't have enough resolved horizons
 * (need at least 5 neighbors with a resolved 1d outcome to be honest).
 */
export async function findSimilarSetups({ rsi, macd, bb, signal, region, k = 20 } = {}) {
    const rows = await loadLedger();
    if (!rows.length) return { available: false, note: 'Ledger not seeded yet — needs at least one cron run.' };

    // Pull out the live/target features. Caller can pass them explicitly,
    // but most of the time we just read the current on-screen signal.
    const sig = window.__miaLatestSignal;
    const indicators = sig?.indicators || sig?.breakdown?.daily?.indicators || null;
    const target = {
        rsi: Number.isFinite(rsi) ? rsi : indicators?.rsi,
        macdHist: Number.isFinite(macd) ? macd : indicators?.macd?.histogram,
        bbPct: Number.isFinite(bb) ? bb : indicators?.bb?.percentB,
    };
    if (!Number.isFinite(target.rsi)) return { available: false, note: 'No current RSI to match against.' };

    // Normalize feature scales so each contributes ~equally to the distance.
    const normRsi = v => (v - 50) / 50;        // -1..1
    const normMacd = v => Math.max(-2, Math.min(2, (v ?? 0))) / 2;  // squashed
    const normBb = v => ((v ?? 0.5) - 0.5) * 2; // -1..1

    const tNorm = [normRsi(target.rsi), normMacd(target.macdHist), normBb(target.bbPct)];
    const wantSignal = signal ? String(signal).toUpperCase() : null;

    const scored = [];
    for (const r of rows) {
        if (!r.indicators) continue;
        if (region && r.region !== region) continue;
        if (wantSignal && r.signal !== wantSignal) continue;
        const rs = r.indicators.rsi;
        const mh = r.indicators.macd?.histogram ?? r.indicators.macdHist;
        const bp = r.indicators.bb?.percentB ?? r.indicators.bbPct;
        if (!Number.isFinite(rs)) continue;
        const v = [normRsi(rs), normMacd(mh), normBb(bp)];
        let d2 = 0;
        for (let i = 0; i < 3; i++) { const x = v[i] - tNorm[i]; d2 += x * x; }
        scored.push({ row: r, distance: Math.sqrt(d2) });
    }
    if (!scored.length) return { available: false, note: 'No comparable rows in the ledger yet.' };

    scored.sort((a, b) => a.distance - b.distance);
    const lim = Math.max(3, Math.min(50, Number(k) || 20));
    const neighbors = scored.slice(0, lim);

    // Aggregate hit-rate across each horizon for the picked neighbors.
    const HORIZONS = ['1', '3', '5', '10', '20'];
    const horizonStats = {};
    for (const h of HORIZONS) {
        let resolved = 0, hits = 0;
        for (const n of neighbors) {
            const slot = n.row.horizons?.[h];
            if (slot && slot.directionMatch !== null && slot.directionMatch !== undefined) {
                resolved++;
                if (slot.directionMatch) hits++;
            }
        }
        if (resolved > 0) horizonStats[`${h}d`] = { resolved, hits, hitRatePct: Math.round((hits / resolved) * 100) };
    }

    // Quick narrative the LLM can latch onto without re-deriving.
    const sample = neighbors.slice(0, 5).map(n => ({
        symbol: n.row.symbol,
        date: n.row.date,
        signal: n.row.signal,
        confidence: n.row.confidence,
        rsi: n.row.indicators.rsi,
        bb1d: n.row.horizons?.['1']?.directionMatch ?? null,
        distance: +n.distance.toFixed(3),
    }));

    return {
        available: true,
        target,
        neighborsScanned: scored.length,
        neighborsReturned: neighbors.length,
        horizonHitRates: horizonStats,
        closestSamples: sample,
        note: 'Each horizon shows the % of similar past setups that resolved in the predicted direction. Honest small-N: under 30 resolved per horizon, treat the rate as suggestive not authoritative.',
    };
}

export async function readLiveCalibration() {
    try {
        const res = await fetch('./model/live_calibration.json');
        if (!res.ok) return { available: false, note: 'Live calibration not generated yet.' };
        const data = await res.json();
        return {
            available: true,
            generatedAt: data.generatedAt,
            totalRowsConsidered: data.totalRowsConsidered,
            totalResolvedHorizons: data.totalResolvedHorizons,
            byHorizon: data.byHorizon,
            byRegion: data.byRegion,
        };
    } catch (e) {
        return { available: false, note: String(e.message || e) };
    }
}

export function readSourceAccuracy() {
    const data = getSourceAccuracy();
    if (!data) return { available: false, note: 'Not enough resolved samples yet (need 15+ in the last 30).' };
    return {
        available: true,
        bySource: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { n: v.n, hitRatePct: Math.round(v.hitRate * 100) }])),
    };
}

const THEMES = ['dark', 'light', 'aurora'];

export function controlSetTheme({ theme }) {
    const t = String(theme || '').toLowerCase().trim();
    if (!THEMES.includes(t)) throw new Error(`unknown theme: ${theme}. Use one of: ${THEMES.join(', ')}`);
    const btn = document.getElementById('theme-toggle');
    if (!btn) throw new Error('theme toggle missing');
    announce({ text: `Switching to ${t} theme…`, target: btn });
    let cycles = 0;
    while (state.theme !== t && cycles < THEMES.length) {
        btn.click();
        cycles++;
    }
    return { ok: true, theme: state.theme };
}

export function controlFocusSearch({ query = '' } = {}) {
    const input = document.getElementById('search-input');
    if (!input) throw new Error('search input missing');
    announce({ text: query ? `Searching ${query}…` : 'Jumping to search…', target: input });
    if (query) {
        input.value = String(query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { input.focus(); } catch (_) {}
    return { ok: true, query: input.value };
}

export function controlClearMiaChat() {
    announce({ text: 'Clearing chat…' });
    clearMiaHistory();
    const thread = document.getElementById('mia-thread');
    if (thread) thread.innerHTML = '';
    return { ok: true };
}

export async function controlCopyToClipboard({ text }) {
    const s = String(text ?? '');
    if (!s) throw new Error('text required');
    announce({ text: 'Copied to clipboard ✓' });
    try {
        await navigator.clipboard.writeText(s);
        return { ok: true, length: s.length };
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const fallbackOk = document.execCommand('copy');
        ta.remove();
        if (!fallbackOk) throw new Error('clipboard write blocked');
        return { ok: true, length: s.length, fallback: true };
    }
}

// ── New tools (P0 from MIA_TOOL_AUDIT.md) ─────────────────────────────

// Open the Resources slide-in panel (left rail). The toggle button has
// id #resources-toggle; clicking it flips the body.resources-open state.
export function controlOpenResources() {
    const toggle = document.getElementById('resources-toggle');
    if (!toggle) throw new Error('resources toggle missing');
    if (!document.body.classList.contains('resources-open')) {
        announce({ text: 'Opening Resources…', target: toggle });
        toggle.click();
    }
    return { ok: true };
}

// Open the Full Ledger panel (the <details> at #scanner-section).
// Optionally pass a symbol — we'll set the filter to surface the row
// and (if expand=true) auto-toggle that row's inline analysis drawer.
export function controlOpenFullLedger({ symbol = null, expand = false, signal = null, accuracyWindow = null } = {}) {
    const section = document.querySelector('#scanner-section .scanner-details');
    if (!section) throw new Error('Full Ledger section missing');
    if (!section.open) section.open = true;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    announce({ text: 'Opening Full Ledger…', target: section });
    if (signal) {
        const sigSel = document.getElementById('scanner-signal-filter');
        if (sigSel) {
            const norm = String(signal).toUpperCase();
            sigSel.value = ['BUY', 'SELL', 'NEUTRAL', 'NO_TRADE'].includes(norm) ? norm : '';
            sigSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    if (symbol) {
        const filter = document.getElementById('scanner-filter');
        if (filter) {
            filter.value = String(symbol).toUpperCase();
            filter.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    if (accuracyWindow) {
        controlSetAccuracyWindow(accuracyWindow);
    }
    if (symbol && expand) {
        // Wait one frame for the filter to apply, then click the row to
        // expand its inline drawer.
        requestAnimationFrame(() => {
            const row = document.querySelector(`.scanner-row[data-symbol="${String(symbol).toUpperCase()}"]`);
            if (row) row.click();
        });
    }
    return { ok: true, symbol, expanded: !!(symbol && expand) };
}

// Set the Full Ledger's accuracy time-window filter. Accepts either an
// object { n, unit } or a shorthand string like "30 days" / "3 months"
// / "1 year" / "all". Mia uses this to scope hit-rate to a specific
// recency window when the user asks "how accurate has the engine been
// in the last 30 days?"
export function controlSetAccuracyWindow(input) {
    const nEl = document.getElementById('scanner-window-n');
    const uEl = document.getElementById('scanner-window-unit');
    if (!nEl || !uEl) throw new Error('Accuracy window inputs missing');
    let n = null, unit = 'all';
    if (typeof input === 'string') {
        const s = input.toLowerCase().trim();
        if (s === 'all' || s === 'all time' || s === 'forever') {
            unit = 'all';
        } else {
            const m = s.match(/^(\d+)\s*(d|day|days|m|mo|month|months|y|yr|year|years)$/);
            if (!m) throw new Error(`unrecognized window: "${input}". Try "30 days", "3 months", "1 year", or "all".`);
            n = Number(m[1]);
            const u = m[2];
            unit = (u.startsWith('d') ? 'days' : u.startsWith('m') ? 'months' : 'years');
        }
    } else if (input && typeof input === 'object') {
        n = Number(input.n) || null;
        const u = String(input.unit || '').toLowerCase();
        unit = ['days', 'months', 'years', 'all'].includes(u) ? u : (n ? 'days' : 'all');
    }
    uEl.value = unit;
    uEl.dispatchEvent(new Event('change', { bubbles: true }));
    if (unit !== 'all' && n) {
        nEl.value = String(n);
        nEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true, unit, n };
}

// Watchlist add — toggles the star ON for a symbol. Idempotent: calling
// when already starred is a no-op (returns watched: true with reason).
export async function controlAddToWatchlist({ symbol }) {
    const { isWatched, toggleWatch } = await import('../ui/watchlist.js');
    const sym = String(symbol || '').toUpperCase().trim();
    if (!sym) throw new Error('symbol required');
    if (isWatched(sym)) return { ok: true, watched: true, alreadyWatched: true };
    toggleWatch(sym);
    announce({ text: `${sym} added to watchlist ⭐`, target: document.getElementById('watchlist-section') });
    return { ok: true, watched: true };
}

// Watchlist remove — opposite of add.
export async function controlRemoveFromWatchlist({ symbol }) {
    const { isWatched, toggleWatch } = await import('../ui/watchlist.js');
    const sym = String(symbol || '').toUpperCase().trim();
    if (!sym) throw new Error('symbol required');
    if (!isWatched(sym)) return { ok: true, watched: false, alreadyRemoved: true };
    toggleWatch(sym);
    announce({ text: `${sym} removed from watchlist`, target: document.getElementById('watchlist-section') });
    return { ok: true, watched: false };
}

// Set a price alert above/below threshold. The watchlist UI supports
// this via inputs but Mia couldn't drive it. Accepts either or both
// (one above only, one below only, or both bracketing). Pass null to
// clear that side.
export async function controlSetPriceAlert({ symbol, above = null, below = null }) {
    const { setAlert, clearAlert, isCryptoSymbol } = await import('../ui/price-alerts.js');
    const { isWatched, toggleWatch } = await import('../ui/watchlist.js');
    const sym = String(symbol || '').toUpperCase().trim();
    if (!sym) throw new Error('symbol required');
    if (above == null && below == null) {
        clearAlert(sym);
        announce({ text: `Alerts cleared on ${sym}` });
        return { ok: true, cleared: true };
    }
    // HONESTY GATE: realtime price alerts only fire for crypto (Binance WS).
    // Free stock feeds are 5–15 min delayed and there's no socket wired, so
    // a stock alert would persist but NEVER fire. Refuse it with a clear
    // reason instead of returning ok:true — Mia must not confirm a dead
    // alert ("Alert set on AAPL" when it can never trigger).
    if (!isCryptoSymbol(sym)) {
        return {
            ok: false,
            unsupported: true,
            reason: `Realtime price alerts are crypto-only (e.g. BTC-USD). Free stock data is 5–15 min delayed with no live feed, so a stock alert on ${sym} would never fire — I didn't set one.`,
        };
    }
    // Auto-watchlist symbols that get an alert — keeping alerts on
    // un-watched names creates UI orphans.
    if (!isWatched(sym)) toggleWatch(sym);
    const a = above != null ? Number(above) : null;
    const b = below != null ? Number(below) : null;
    setAlert(sym, { above: a, below: b });
    const parts = [];
    if (a != null) parts.push(`above $${a}`);
    if (b != null) parts.push(`below $${b}`);
    announce({ text: `Alert set on ${sym}: ${parts.join(' or ')}`, target: document.getElementById('watchlist-section') });
    return { ok: true, symbol: sym, above: a, below: b };
}

// ── New coverage surfaces (sector heatmap / earnings / options) ──────

// Open the sector heatmap and return the current trends so Mia can
// narrate "Energy is leading, +3.1% on 5d; Real Estate lagging".
export async function controlOpenSectorHeatmap() {
    const { openSectorHeatmap, getSectorTrendsForMia } = await import('../ui/sector-heatmap.js');
    const ok = openSectorHeatmap();
    announce({ text: 'Opening Sector Heatmap…', target: document.getElementById('sector-heatmap-section') });
    const trends = await getSectorTrendsForMia();
    return { ok, trends };
}

// Open the earnings calendar. Returns the upcoming-earnings rows
// (symbol, daysUntil, signal, confidence) so Mia can answer
// "who reports this week?" in the same turn.
export async function controlOpenEarningsCalendar({ windowDays = 14 } = {}) {
    const { openEarningsCalendar, getUpcomingEarningsForMia } = await import('../ui/earnings-calendar.js');
    const ok = openEarningsCalendar();
    announce({ text: 'Opening Earnings Calendar…', target: document.getElementById('earnings-cal-section') });
    const rows = await getUpcomingEarningsForMia(windowDays);
    return { ok, upcoming: rows };
}

// Open the unusual-options scanner. Returns the flagged rows so Mia can
// summarize "TSLA shows crowded calls (PCR 0.4); heavy puts on XOM".
export async function controlOpenOptionsScanner() {
    const { openOptionsScanner, getUnusualOptionsForMia } = await import('../ui/options-scanner.js');
    const ok = openOptionsScanner();
    announce({ text: 'Opening Unusual Options Activity…', target: document.getElementById('options-scan-section') });
    const rows = await getUnusualOptionsForMia();
    return { ok, unusual: rows };
}

// Read the watchlist + any alerts currently set on each symbol.
// Useful when Mia is asked "what alerts do I have?" or for grounding
// before setting/clearing one.
export async function readWatchlist() {
    const { getWatchlistSymbols } = await import('../ui/watchlist.js');
    const { listAlerts, getLastPrice } = await import('../ui/price-alerts.js');
    const symbols = getWatchlistSymbols();
    const alerts = listAlerts();
    return symbols.map(sym => {
        const a = alerts[sym] || {};
        return {
            symbol: sym,
            lastPrice: getLastPrice(sym) ?? null,
            alertAbove: a.above ?? null,
            alertBelow: a.below ?? null,
        };
    });
}

// ── Portfolio panel (open/close/instantiate/fund/reset) ──────────────

export async function controlOpenPortfolioPanel() {
    const { openPortfolioPanel } = await import('../ui/portfolio-panel.js');
    announce({ text: 'Opening your practice portfolio…', target: document.getElementById('portfolio-launcher') });
    openPortfolioPanel({ shimmerTitle: true });
    return { ok: true };
}

export async function controlClosePortfolioPanel() {
    const { closePortfolioPanel } = await import('../ui/portfolio-panel.js');
    closePortfolioPanel();
    return { ok: true };
}

// Create a fresh practice portfolio with a starting cash balance. The
// amount is in `currency` (default USD); we resolve the FX rate to USD
// so the ledger stays USD-denominated like the rest of the app.
export async function controlInstantiatePortfolio({ amount, currency = 'USD' } = {}) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
    const cur = String(currency || 'USD').toUpperCase();
    const { isInstantiated, instantiatePortfolio } = await import('../portfolio/state.js');
    if (isInstantiated()) {
        return { ok: false, alreadyExists: true, note: 'A practice portfolio already exists. Use add_funds to top it up, or reset_portfolio to start over.' };
    }
    const { getRateToUSD } = await import('../portfolio/fx.js');
    const fxRateToUSD = await getRateToUSD(cur);
    instantiatePortfolio({ currency: cur, amount: amt, fxRateToUSD });
    // Surface it so the user sees the account that was just created.
    try { const { openPortfolioPanel } = await import('../ui/portfolio-panel.js'); openPortfolioPanel({ shimmerTitle: true }); } catch (_) {}
    announce({ text: `Created a practice portfolio with ${cur} ${amt.toLocaleString()}`, target: document.getElementById('portfolio-launcher') });
    return { ok: true, currency: cur, amount: amt };
}

export async function controlAddFunds({ amount, currency = 'USD' } = {}) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
    const cur = String(currency || 'USD').toUpperCase();
    const { isInstantiated, addFunds } = await import('../portfolio/state.js');
    if (!isInstantiated()) {
        return { ok: false, note: 'No practice portfolio yet — call instantiate_portfolio first.' };
    }
    const { getRateToUSD } = await import('../portfolio/fx.js');
    const fxRateToUSD = await getRateToUSD(cur);
    addFunds({ currency: cur, amount: amt, fxRateToUSD });
    announce({ text: `Added ${cur} ${amt.toLocaleString()} to your practice portfolio`, target: document.getElementById('portfolio-launcher') });
    return { ok: true, currency: cur, amount: amt };
}

// Reset wipes the practice portfolio. Destructive — Mia's tool desc
// instructs her to confirm with the user before calling.
export async function controlResetPortfolio() {
    const { isInstantiated, resetPortfolio } = await import('../portfolio/state.js');
    if (!isInstantiated()) return { ok: true, note: 'No portfolio to reset.' };
    resetPortfolio();
    announce({ text: 'Practice portfolio reset.', target: document.getElementById('portfolio-launcher') });
    return { ok: true, reset: true };
}

// ── Time-travel (replay the engine on a past date) ───────────────────
// The single most distinctive feature: sets state.timeTravelDate and
// re-runs the engine on the currently-loaded symbol using only bars
// available on that date. Requires a symbol to be loaded first.
export async function controlSetTimeTravel({ date } = {}) {
    if (!state.currentSymbol) throw new Error('Load a symbol first, then I can replay the engine on a past date for it.');
    const iso = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('date must be YYYY-MM-DD');
    const today = new Date().toISOString().slice(0, 10);
    if (iso > today) throw new Error('date cannot be in the future');
    state.timeTravelDate = iso;
    // Reflect it in the time-travel button label if the UI is built.
    const label = document.querySelector('#time-travel-btn .time-travel-label');
    const btn = document.getElementById('time-travel-btn');
    if (label) label.textContent = iso;
    if (btn) btn.classList.add('active');
    const refresh = document.getElementById('refresh-analysis');
    announce({ text: `Replaying the engine on ${state.currentSymbol} as of ${iso}…`, target: refresh || 'signal-section' });
    if (refresh) refresh.click();
    setTimeout(() => pulseElementById('signal-section'), 800);
    return { ok: true, symbol: state.currentSymbol, date: iso };
}

export async function controlClearTimeTravel() {
    state.timeTravelDate = null;
    const label = document.querySelector('#time-travel-btn .time-travel-label');
    const btn = document.getElementById('time-travel-btn');
    if (label) label.textContent = 'Live';
    if (btn) btn.classList.remove('active');
    const refresh = document.getElementById('refresh-analysis');
    announce({ text: 'Back to live — re-running on current data…', target: refresh || 'signal-section' });
    if (refresh) refresh.click();
    return { ok: true, date: null };
}

// Open the equity curve ("did following the engine pay off?") and
// return the dollar summary so Mia can state it in the same turn.
// Optional symbol scopes it to one ticker; horizonDays picks the horizon.
export async function controlOpenEquityCurve({ symbol = null, horizonDays = 1 } = {}) {
    const { openEquityCurve } = await import('../ui/equity-curve.js');
    announce({ text: 'Replaying every engine signal through a hypothetical $10k…', target: document.getElementById('equity-curve-section') });
    const res = await openEquityCurve({ symbol, horizonDays });
    return res;
}

// Open the accuracy-by-setup report and return the structured
// breakdown so Mia can answer "which setups does the engine read well".
export async function controlOpenAccuracyReport({ horizonDays = 1 } = {}) {
    const { openAccuracyReport } = await import('../ui/accuracy-report.js');
    announce({ text: 'Breaking the engine\'s accuracy down by setup…', target: document.getElementById('accuracy-report-section') });
    return await openAccuracyReport({ horizonDays });
}

// ── Macro regime read ────────────────────────────────────────────────
// Standalone read of the macro regime (risk-on / risk-off / transition /
// neutral) + its components (VIX level/trend, S&P 5d/10d, dollar). The
// engine uses this internally but never surfaced it as its own tool.
export async function readMacroRegime() {
    const { getMacroRegime } = await import('../regime.js');
    const r = await getMacroRegime();
    return {
        regime: r.regime,
        vix: r.components?.vix ?? null,
        sp500: r.components?.sp500 ?? null,
        dollar: r.components?.dxy ?? null,
    };
}
