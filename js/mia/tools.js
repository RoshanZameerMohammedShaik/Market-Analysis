// Mia's tool registry. Greatly expanded for Phase 3:
//   - Read tools: full app state, calibration, accuracy, multi-timeframe,
//     options, derivs, hot picks, market conditions.
//   - External tools: news+sentiment, FRED macro, Reddit, SEC filings.
//   - Control tools: select symbol, switch mode/timeframe, theme,
//     P&L, refresh hot picks, run analysis.
//
// All control tools are routed through ui-bridge.js, which is the only
// module allowed to touch the live UI. Mia cannot mutate any number.
//
// Wire protocol stays the same: a TOOL: name {json} line in the LLM
// stream, agent.js dispatches and feeds the RESULT back.

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

const TOOLS = {
    // ---- App state reads -------------------------------------------------
    get_app_state: {
        desc: 'Read-only snapshot of mode, timeframe, theme, current symbol, and a summary of the latest on-screen signal. No args.',
        run: () => readUiSnapshot(),
        kind: 'read',
    },
    get_current_signal: {
        desc: 'Full signal card currently displayed for the selected symbol (signal, confidence, breakdown, price targets, top reasons). No args.',
        run: () => {
            const sig = window.__miaLatestSignal;
            if (!sig) return { signal: null, note: 'No symbol selected on the page yet.' };
            return {
                symbol: state.currentSymbol,
                signal: sig.signal,
                confidence: sig.confidence,
                rawConfidence: sig.rawConfidence,
                calibrationApplied: sig.calibrationApplied,
                trendRegime: sig.trendRegime,
                breakdown: sig.breakdown,
                priceTargets: sig.priceTargets,
                multiHorizon: sig.multiHorizon,
                topReasons: sig.reasons?.slice(0, 8),
                conformal: sig.conformal,
                squeeze: sig.squeeze,
                vwap: sig.vwap,
                tfAgreement: sig.tfAgreement,
                volProfile: sig.volProfile,
                rotation: sig.rotation,
                crossAsset: sig.crossAsset,
                gap: sig.gap,
                recentSpike: sig.recentSpike,
                earningsHistory: sig.earningsHistory,
                derivs: sig.derivs,
                peers: sig.peers,
                pattern: sig.pattern,
                options: sig.options,
            };
        },
        kind: 'read',
    },
    get_calibration: {
        desc: 'Calibration tables (global, by liquidity tier, by vol tier, recency-weighted). Use to explain how the displayed confidence percentage maps to historical hit-rate. No args.',
        run: () => readCalibrationSnapshot(),
        kind: 'read',
    },
    get_accuracy_stats: {
        desc: 'User-visible running accuracy stats (hits / total / hit-rate / per-bucket). No args.',
        run: () => readAccuracyStats(),
        kind: 'read',
    },

    // ---- Re-run analysis on demand ----------------------------------------
    analyze_symbol: {
        desc: 'Run the full analysis pipeline on a symbol and return the signal. Args: { "symbol": "AAPL", "mode": "stock"|"crypto" (optional, defaults to current) }.',
        run: async ({ symbol, mode }) => {
            if (!symbol) return { error: 'symbol required' };
            const m = mode || state.mode;
            const data = m === 'crypto' ? await fetchCryptoMultiTimeframe(symbol) : await fetchStockMultiTimeframe(symbol);
            const result = await computeFullConfidence(data, m, symbol, state.timeframe);
            return {
                symbol: data.daily.symbol,
                name: data.daily.name,
                currentPrice: data.daily.currentPrice,
                signal: result.signal,
                confidence: result.confidence,
                trendRegime: result.trendRegime,
                breakdown: result.breakdown,
                priceTargets: result.priceTargets,
                multiHorizon: result.multiHorizon,
                topReasons: result.reasons?.slice(0, 6),
            };
        },
        kind: 'read',
    },
    compare_symbols: {
        desc: 'Side-by-side comparison of up to 4 stock or crypto symbols. Args: { "symbols": ["AAPL","MSFT"], "mode": "stock"|"crypto" }.',
        run: async ({ symbols, mode = 'stock' }) => {
            if (!Array.isArray(symbols) || symbols.length === 0) return { error: 'symbols array required' };
            const cap = symbols.slice(0, 4);
            const out = [];
            for (const sym of cap) {
                try {
                    const data = mode === 'crypto' ? await fetchCryptoMultiTimeframe(sym) : await fetchStockMultiTimeframe(sym);
                    const result = await computeFullConfidence(data, mode, sym, state.timeframe);
                    out.push({
                        symbol: data.daily.symbol,
                        signal: result.signal,
                        confidence: result.confidence,
                        trendRegime: result.trendRegime,
                        currentPrice: data.daily.currentPrice,
                    });
                } catch (e) {
                    out.push({ symbol: sym, error: e.message });
                }
            }
            return out;
        },
        kind: 'read',
    },
    get_hot_picks: {
        desc: 'Top 20 hot picks. Args: { "mode": "stock"|"crypto", "timeframe": "today"|"tomorrow" }.',
        run: async ({ mode = 'stock', timeframe = 'today' }) => {
            const fn = mode === 'crypto' ? scanCryptoHotPicks : scanStockHotPicks;
            const picks = await fn(timeframe, 20);
            return picks.map(p => ({
                symbol: p.symbol, name: p.name, signal: p.signal, confidence: p.confidence, price: p.price,
            }));
        },
        kind: 'read',
    },
    get_market_conditions: {
        desc: 'Current Fear & Greed, VIX, and S&P 500 trend (or crypto F&G for crypto mode). Args: { "mode": "stock"|"crypto" }.',
        run: async ({ mode = 'stock' }) => await getMarketConditionsScore(mode),
        kind: 'read',
    },

    // ---- External / internet reads ----------------------------------------
    get_news_and_sentiment: {
        desc: 'Recent headlines + FinBERT/keyword sentiment for a symbol. Args: { "symbol": "AAPL", "mode": "stock"|"crypto", "companyName": "..." (optional) }.',
        run: ({ symbol, mode = 'stock', companyName = '' }) => fetchNewsAndSentiment({ symbol, mode, companyName }),
        kind: 'read',
    },
    get_macro_series: {
        desc: 'FRED macroeconomic series (no key). Allowed series: DFF (fed funds), DGS10, DGS2, T10Y2Y, UNRATE, CPIAUCSL, PCEPILFE, M2SL, WALCL, DCOILWTICO, GOLDAMGBD228NLBM. Args: { "series": "DGS10", "lookbackMonths": 6 }.',
        run: ({ series, lookbackMonths = 6 }) => fetchFredSeries({ series, lookbackMonths }),
        kind: 'read',
    },
    get_reddit_sentiment: {
        desc: 'Recent Reddit posts mentioning a symbol with quick bull/bear lean. Args: { "symbol": "AAPL", "subreddit": "stocks+wallstreetbets+investing", "limit": 20 }.',
        run: ({ symbol, subreddit, limit }) => fetchRedditSentiment({ symbol, subreddit, limit }),
        kind: 'read',
    },
    get_sec_filings: {
        desc: 'Recent SEC EDGAR filings for a stock (10-K, 10-Q, 8-K, etc.). Args: { "symbol": "AAPL", "limit": 5 }.',
        run: ({ symbol, limit }) => fetchSecRecentFilings({ symbol, limit }),
        kind: 'read',
    },
    get_options_view: {
        desc: 'Options chain summary for a stock: ATM IV, IV rank, put/call ratio, skew. Args: { "symbol": "AAPL" }.',
        run: ({ symbol }) => fetchOptionsView({ symbol }),
        kind: 'read',
    },
    get_crypto_derivatives: {
        desc: 'Funding rate + open interest snapshot for a crypto. Args: { "coinId": "bitcoin" }.',
        run: ({ coinId }) => fetchCryptoDerivativesView({ coinId }),
        kind: 'read',
    },

    // ---- Control tools (navigation only — cannot mutate numbers) ---------
    select_symbol: {
        desc: 'Load a symbol into the app (same effect as the user typing it and clicking the first match). Args: { "symbol": "AAPL", "mode": "stock"|"crypto" }.',
        run: ({ symbol, mode = 'stock' }) => controlSelectSymbol({ symbol, mode }),
        kind: 'control',
    },
    switch_mode: {
        desc: 'Switch between stock and crypto tabs. Args: { "mode": "stock"|"crypto" }.',
        run: ({ mode }) => controlSwitchMode(mode),
        kind: 'control',
    },
    switch_timeframe: {
        desc: 'Switch the analysis timeframe. Args: { "timeframe": "today"|"tomorrow" }.',
        run: ({ timeframe }) => controlSwitchTimeframe(timeframe),
        kind: 'control',
    },
    cycle_theme: {
        desc: 'Cycle the visual theme (dark → light → aurora → dark). No args.',
        run: () => controlCycleTheme(),
        kind: 'control',
    },
    toggle_pl_calculator: {
        desc: 'Show or hide the P&L calculator sidebar. No args.',
        run: () => controlTogglePL(),
        kind: 'control',
    },
    refresh_hot_picks: {
        desc: 'Re-run the hot-picks scan. No args.',
        run: () => controlRefreshHotPicks(),
        kind: 'control',
    },
    rerun_analysis: {
        desc: 'Re-run the analysis pipeline on the currently selected symbol. No args.',
        run: () => controlRunAnalysis(),
        kind: 'control',
    },
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
    const lines = ['# TOOLS — call these to get real data and act on the app, never guess'];
    lines.push('To call a tool, output a line like this (no other text on that line):');
    lines.push('');
    lines.push('TOOL: tool_name {"arg": "value"}');
    lines.push('');
    lines.push('Wait for a RESULT: line, then continue. You can call tools multiple times.');
    lines.push('');
    lines.push('## Read tools (data — always free to call):');
    for (const t of listTools().filter(x => x.kind === 'read')) lines.push(`- ${t.name}: ${t.desc}`);
    lines.push('');
    lines.push('## Control tools (drive the UI — use only when the user asked or it would obviously help):');
    for (const t of listTools().filter(x => x.kind === 'control')) lines.push(`- ${t.name}: ${t.desc}`);
    lines.push('');
    lines.push('Rules:');
    lines.push('- NEVER state a number that did not come from a tool result or the context block.');
    lines.push('- NEVER claim to have changed a confidence, calibration value, or any signal number — you cannot. The control tools only navigate and re-run analysis; the engine produces all numbers.');
    lines.push('- Prefer fewer, well-chosen tool calls. Stop calling once you have enough to answer.');
    return lines.join('\n');
}
