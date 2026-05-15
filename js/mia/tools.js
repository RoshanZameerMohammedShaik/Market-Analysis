// Mia's tool registry. Phase 3.2: tool-section prompt compressed.
// One-line descriptions, format example only at the top, schema args
// embedded inline.

import { state } from '../ui/state.js';
import { fetchStockMultiTimeframe, fetchCryptoMultiTimeframe } from '../data.js';
import { computeFullConfidence } from '../confidence.js';
import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { getMarketConditionsScore } from '../market.js';
import {
    controlSelectSymbol, controlSwitchMode, controlSwitchTimeframe,
    controlCycleTheme, controlTogglePL, controlRefreshHotPicks, controlRunAnalysis,
    readUiSnapshot, readCalibrationSnapshot, readAccuracyStats,
} from './ui-bridge.js';
import {
    fetchNewsAndSentiment, fetchFredSeries, fetchRedditSentiment,
    fetchSecRecentFilings, fetchOptionsView, fetchCryptoDerivativesView,
} from './external-tools.js';

// Compact tool table. `desc` should be ONE short line. `args` is shown to
// the model so it knows the JSON shape without reading prose.
const TOOLS = {
    get_app_state: {
        desc: 'app snapshot (mode, symbol, theme, latest signal summary)', args: '{}',
        run: () => readUiSnapshot(), kind: 'read',
    },
    get_current_signal: {
        desc: 'full on-screen signal with all sub-modules', args: '{}',
        run: () => {
            const sig = window.__miaLatestSignal;
            if (!sig) return { signal: null, note: 'No symbol selected.' };
            return {
                symbol: state.currentSymbol,
                signal: sig.signal, confidence: sig.confidence, rawConfidence: sig.rawConfidence,
                calibrationApplied: sig.calibrationApplied, trendRegime: sig.trendRegime,
                breakdown: sig.breakdown, priceTargets: sig.priceTargets, multiHorizon: sig.multiHorizon,
                topReasons: sig.reasons?.slice(0, 8),
                conformal: sig.conformal, squeeze: sig.squeeze, vwap: sig.vwap,
                tfAgreement: sig.tfAgreement, volProfile: sig.volProfile, rotation: sig.rotation,
                crossAsset: sig.crossAsset, gap: sig.gap, recentSpike: sig.recentSpike,
                earningsHistory: sig.earningsHistory, derivs: sig.derivs, peers: sig.peers,
                pattern: sig.pattern, options: sig.options,
            };
        },
        kind: 'read',
    },
    get_calibration: { desc: 'calibration tables', args: '{}', run: () => readCalibrationSnapshot(), kind: 'read' },
    get_accuracy_stats: { desc: 'running accuracy hits/total/rate', args: '{}', run: () => readAccuracyStats(), kind: 'read' },
    analyze_symbol: {
        desc: 'run full analysis on a symbol', args: '{"symbol":"AAPL","mode":"stock|crypto"}',
        run: async ({ symbol, mode }) => {
            if (!symbol) return { error: 'symbol required' };
            const m = mode || state.mode;
            const data = m === 'crypto' ? await fetchCryptoMultiTimeframe(symbol) : await fetchStockMultiTimeframe(symbol);
            const result = await computeFullConfidence(data, m, symbol, state.timeframe);
            return {
                symbol: data.daily.symbol, name: data.daily.name, currentPrice: data.daily.currentPrice,
                signal: result.signal, confidence: result.confidence, trendRegime: result.trendRegime,
                breakdown: result.breakdown, priceTargets: result.priceTargets, multiHorizon: result.multiHorizon,
                topReasons: result.reasons?.slice(0, 6),
            };
        },
        kind: 'read',
    },
    compare_symbols: {
        desc: 'compare up to 4 symbols side by side', args: '{"symbols":["AAPL","MSFT"],"mode":"stock|crypto"}',
        run: async ({ symbols, mode = 'stock' }) => {
            if (!Array.isArray(symbols) || symbols.length === 0) return { error: 'symbols array required' };
            const out = [];
            for (const sym of symbols.slice(0, 4)) {
                try {
                    const data = mode === 'crypto' ? await fetchCryptoMultiTimeframe(sym) : await fetchStockMultiTimeframe(sym);
                    const r = await computeFullConfidence(data, mode, sym, state.timeframe);
                    out.push({ symbol: data.daily.symbol, signal: r.signal, confidence: r.confidence, trendRegime: r.trendRegime, currentPrice: data.daily.currentPrice });
                } catch (e) { out.push({ symbol: sym, error: e.message }); }
            }
            return out;
        },
        kind: 'read',
    },
    get_hot_picks: {
        desc: 'top 20 hot picks', args: '{"mode":"stock|crypto","timeframe":"today|tomorrow"}',
        run: async ({ mode = 'stock', timeframe = 'today' }) => {
            const fn = mode === 'crypto' ? scanCryptoHotPicks : scanStockHotPicks;
            const picks = await fn(timeframe, 20);
            return picks.map(p => ({ symbol: p.symbol, name: p.name, signal: p.signal, confidence: p.confidence, price: p.price }));
        },
        kind: 'read',
    },
    get_market_conditions: {
        desc: 'F&G, VIX, S&P trend (or crypto F&G)', args: '{"mode":"stock|crypto"}',
        run: async ({ mode = 'stock' }) => await getMarketConditionsScore(mode),
        kind: 'read',
    },
    get_news_and_sentiment: {
        desc: 'recent headlines + FinBERT sentiment', args: '{"symbol":"AAPL","mode":"stock|crypto"}',
        run: ({ symbol, mode = 'stock', companyName = '' }) => fetchNewsAndSentiment({ symbol, mode, companyName }),
        kind: 'read',
    },
    get_macro_series: {
        desc: 'FRED macro: DFF, DGS10, DGS2, T10Y2Y, UNRATE, CPIAUCSL, PCEPILFE, M2SL, WALCL, DCOILWTICO, GOLDAMGBD228NLBM',
        args: '{"series":"DGS10","lookbackMonths":6}',
        run: ({ series, lookbackMonths = 6 }) => fetchFredSeries({ series, lookbackMonths }),
        kind: 'read',
    },
    get_reddit_sentiment: {
        desc: 'Reddit posts + bull/bear lean', args: '{"symbol":"AAPL"}',
        run: ({ symbol, subreddit, limit }) => fetchRedditSentiment({ symbol, subreddit, limit }),
        kind: 'read',
    },
    get_sec_filings: {
        desc: 'SEC EDGAR recent filings', args: '{"symbol":"AAPL","limit":5}',
        run: ({ symbol, limit }) => fetchSecRecentFilings({ symbol, limit }),
        kind: 'read',
    },
    get_options_view: {
        desc: 'options PCR, IV skew, ATM IV', args: '{"symbol":"AAPL"}',
        run: ({ symbol }) => fetchOptionsView({ symbol }),
        kind: 'read',
    },
    get_crypto_derivatives: {
        desc: 'funding rate + open interest', args: '{"coinId":"bitcoin"}',
        run: ({ coinId }) => fetchCryptoDerivativesView({ coinId }),
        kind: 'read',
    },
    select_symbol: {
        desc: 'load a symbol into the app', args: '{"symbol":"AAPL","mode":"stock|crypto"}',
        run: ({ symbol, mode = 'stock' }) => controlSelectSymbol({ symbol, mode }),
        kind: 'control',
    },
    switch_mode: { desc: 'switch tab', args: '{"mode":"stock|crypto"}', run: ({ mode }) => controlSwitchMode(mode), kind: 'control' },
    switch_timeframe: { desc: 'switch timeframe', args: '{"timeframe":"today|tomorrow"}', run: ({ timeframe }) => controlSwitchTimeframe(timeframe), kind: 'control' },
    cycle_theme: { desc: 'cycle theme', args: '{}', run: () => controlCycleTheme(), kind: 'control' },
    toggle_pl_calculator: { desc: 'show/hide P&L sidebar', args: '{}', run: () => controlTogglePL(), kind: 'control' },
    refresh_hot_picks: { desc: 'rescan hot picks', args: '{}', run: () => controlRefreshHotPicks(), kind: 'control' },
    rerun_analysis: { desc: 'rerun analysis on current symbol', args: '{}', run: () => controlRunAnalysis(), kind: 'control' },
};

export function listTools() {
    return Object.entries(TOOLS).map(([name, t]) => ({ name, desc: t.desc, kind: t.kind || 'read' }));
}

export async function runTool(name, args = {}) {
    const t = TOOLS[name];
    if (!t) return { error: `Unknown tool: ${name}` };
    try {
        const result = await t.run(args || {});
        return { ok: true, result, kind: t.kind || 'read' };
    } catch (e) {
        return { error: e.message || String(e) };
    }
}

export function toolPromptSection() {
    const lines = ['# TOOLS'];
    lines.push('Format: one line, no markdown wrapping, no bullets, no bold:');
    lines.push('TOOL: tool_name {"arg": "value"}');
    lines.push('Then STOP and wait for RESULT:.');
    lines.push('Use exact tool name; do not abbreviate. Wait for each RESULT before the next call.');
    lines.push('');
    lines.push('READ tools:');
    for (const [name, t] of Object.entries(TOOLS)) {
        if ((t.kind || 'read') !== 'read') continue;
        lines.push(`- ${name} ${t.args} — ${t.desc}`);
    }
    lines.push('');
    lines.push('CONTROL tools (drive UI; use only when user wants action):');
    for (const [name, t] of Object.entries(TOOLS)) {
        if (t.kind !== 'control') continue;
        lines.push(`- ${name} ${t.args} — ${t.desc}`);
    }
    lines.push('');
    lines.push('Never state numbers not in CONTEXT or a RESULT. Stop calling once enough to answer.');
    return lines.join('\n');
}
