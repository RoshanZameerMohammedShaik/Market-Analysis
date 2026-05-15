// Mia's tool registry. Phase 3:
//   - Read tools: full app state, calibration, accuracy, multi-timeframe,
//     options, derivs, hot picks, market conditions.
//   - External tools: news+sentiment, FRED macro, Reddit, SEC filings.
//   - Control tools: select symbol, switch mode/timeframe, theme,
//     P&L, refresh hot picks, run analysis.
//
// All control tools route through ui-bridge.js. Mia cannot mutate any number.
//
// Wire protocol: a TOOL: name {json} line in the LLM stream, agent.js
// dispatches and feeds the RESULT back.
//
// Phase 3.1: prompt section now includes a worked example so small models
// emit the line in the exact shape our regex parses.

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
    get_app_state: {
        desc: 'Read-only snapshot of mode, timeframe, theme, current symbol, and a summary of the latest on-screen signal. No args.',
        run: () => readUiSnapshot(),
        kind: 'read',
    },
    get_current_signal: {
        desc: 'Full signal card currently displayed for the selected symbol. No args.',
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
        desc: 'Calibration tables (global, by liquidity tier, by vol tier, recency-weighted). No args.',
        run: () => readCalibrationSnapshot(),
        kind: 'read',
    },
    get_accuracy_stats: {
        desc: 'User-visible running accuracy stats (hits / total / hit-rate / per-bucket). No args.',
        run: () => readAccuracyStats(),
        kind: 'read',
    },
    analyze_symbol: {
        desc: 'Run the full analysis pipeline on a symbol and return the signal. Args: { "symbol": "AAPL", "mode": "stock"|"crypto" (optional) }.',
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
        desc: 'Fear & Greed, VIX, S&P 500 trend (or crypto F&G for crypto mode). Args: { "mode": "stock"|"crypto" }.',
        run: async ({ mode = 'stock' }) => await getMarketConditionsScore(mode),
        kind: 'read',
    },
    get_news_and_sentiment: {
        desc: 'Recent headlines + FinBERT/keyword sentiment for a symbol. Args: { "symbol": "AAPL", "mode": "stock"|"crypto", "companyName": "..." (optional) }.',
        run: ({ symbol, mode = 'stock', companyName = '' }) => fetchNewsAndSentiment({ symbol, mode, companyName }),
        kind: 'read',
    },
    get_macro_series: {
        desc: 'FRED macro series (no key). Allowed: DFF, DGS10, DGS2, T10Y2Y, UNRATE, CPIAUCSL, PCEPILFE, M2SL, WALCL, DCOILWTICO, GOLDAMGBD228NLBM. Args: { "series": "DGS10", "lookbackMonths": 6 }.',
        run: ({ series, lookbackMonths = 6 }) => fetchFredSeries({ series, lookbackMonths }),
        kind: 'read',
    },
    get_reddit_sentiment: {
        desc: 'Recent Reddit posts mentioning a symbol with quick bull/bear lean. Args: { "symbol": "AAPL" }.',
        run: ({ symbol, subreddit, limit }) => fetchRedditSentiment({ symbol, subreddit, limit }),
        kind: 'read',
    },
    get_sec_filings: {
        desc: 'Recent SEC EDGAR filings for a stock. Args: { "symbol": "AAPL", "limit": 5 }.',
        run: ({ symbol, limit }) => fetchSecRecentFilings({ symbol, limit }),
        kind: 'read',
    },
    get_options_view: {
        desc: 'Options chain summary: ATM IV, IV rank, put/call ratio, skew. Args: { "symbol": "AAPL" }.',
        run: ({ symbol }) => fetchOptionsView({ symbol }),
        kind: 'read',
    },
    get_crypto_derivatives: {
        desc: 'Funding rate + open interest for a crypto. Args: { "coinId": "bitcoin" }.',
        run: ({ coinId }) => fetchCryptoDerivativesView({ coinId }),
        kind: 'read',
    },
    select_symbol: {
        desc: 'Load a symbol into the app. Args: { "symbol": "AAPL", "mode": "stock"|"crypto" }.',
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
        desc: 'Cycle the visual theme (dark → light → aurora). No args.',
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
    lines.push('');
    lines.push('## STRICT FORMAT (must match exactly):');
    lines.push('Output a tool call as ONE LINE, with NO markdown wrapping, no bullets, no bold,');
    lines.push('no quotes around the line. Just:');
    lines.push('');
    lines.push('TOOL: tool_name {"arg": "value"}');
    lines.push('');
    lines.push('Example:');
    lines.push('TOOL: get_market_conditions {"mode": "stock"}');
    lines.push('');
    lines.push('After you write that line, STOP. Wait for a RESULT: line, then continue.');
    lines.push('Use the EXACT tool name from the list. Common mistakes to avoid:');
    lines.push('- Do NOT write **TOOL: ...** with bold markers.');
    lines.push('- Do NOT prefix with -, * or > bullets.');
    lines.push('- Do NOT abbreviate the tool name ("get" is not a tool).');
    lines.push('- Do NOT wrap the JSON in code fences.');
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
