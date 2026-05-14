// Mia's tool registry. Each tool: name, JSON-schema-ish description,
// async run(args) that returns a JSON-serializable result.
//
// The agent loop in agent.js sees tool calls in the LLM stream as a
// line:  TOOL: name {"k": v, ...}
// then dispatches and feeds the result back.

import { state } from '../ui/state.js';
import { fetchStockMultiTimeframe, fetchCryptoMultiTimeframe } from '../data.js';
import { computeFullConfidence } from '../confidence.js';
import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { getMarketConditionsScore } from '../market.js';
import { getCalibrationCurve, getCalibrationStatus } from '../calibration.js';

const TOOLS = {
    get_current_signal: {
        desc: 'Get the signal card currently displayed for the selected symbol. No args. Returns null if no symbol is selected.',
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
                topReasons: sig.reasons?.slice(0, 6),
            };
        },
    },
    analyze_symbol: {
        desc: 'Run the full analysis pipeline on a symbol and return the signal. Args: { "symbol": "AAPL" }. Stocks only for now.',
        run: async ({ symbol }) => {
            if (!symbol) return { error: 'symbol required' };
            const data = await fetchStockMultiTimeframe(symbol);
            const result = await computeFullConfidence(data, 'stock', symbol, state.timeframe);
            return {
                symbol: data.daily.symbol,
                name: data.daily.name,
                currentPrice: data.daily.currentPrice,
                signal: result.signal,
                confidence: result.confidence,
                trendRegime: result.trendRegime,
                breakdown: result.breakdown,
                priceTargets: result.priceTargets,
                topReasons: result.reasons?.slice(0, 5),
            };
        },
    },
    get_hot_picks: {
        desc: 'Get the current top 20 hot picks. Args: { "mode": "stock"|"crypto", "timeframe": "today"|"tomorrow" }.',
        run: async ({ mode = 'stock', timeframe = 'today' }) => {
            const fn = mode === 'crypto' ? scanCryptoHotPicks : scanStockHotPicks;
            const picks = await fn(timeframe, 20);
            return picks.map(p => ({
                symbol: p.symbol, name: p.name, signal: p.signal, confidence: p.confidence, price: p.price,
            }));
        },
    },
    get_market_conditions: {
        desc: 'Get current Fear & Greed, VIX level, S&P 500 trend. Args: { "mode": "stock"|"crypto" }.',
        run: async ({ mode = 'stock' }) => {
            return await getMarketConditionsScore(mode);
        },
    },
    get_calibration_status: {
        desc: 'Return whether backtest calibration is loaded, and the per-bucket hit-rate curve. No args.',
        run: () => {
            return {
                status: getCalibrationStatus(),
                curve: getCalibrationCurve(),
            };
        },
    },
    compare_symbols: {
        desc: 'Side-by-side comparison of multiple stock symbols. Args: { "symbols": ["AAPL", "MSFT"] }. Max 4 symbols.',
        run: async ({ symbols }) => {
            if (!Array.isArray(symbols) || symbols.length === 0) return { error: 'symbols array required' };
            const cap = symbols.slice(0, 4);
            const out = [];
            for (const sym of cap) {
                try {
                    const data = await fetchStockMultiTimeframe(sym);
                    const result = await computeFullConfidence(data, 'stock', sym, state.timeframe);
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
    },
};

export function listTools() {
    return Object.entries(TOOLS).map(([name, t]) => ({ name, desc: t.desc }));
}

export async function runTool(name, args = {}) {
    const t = TOOLS[name];
    if (!t) return { error: `Unknown tool: ${name}` };
    try {
        const result = await t.run(args || {});
        return { ok: true, result };
    } catch (e) {
        return { error: e.message || String(e) };
    }
}

export function toolPromptSection() {
    const lines = ['# TOOLS — call these to get real data, never guess'];
    lines.push('To call a tool, output a line like this (no other text on that line):');
    lines.push('');
    lines.push('TOOL: tool_name {"arg": "value"}');
    lines.push('');
    lines.push('Wait for a RESULT: line, then continue. You can call tools multiple times. Available:');
    for (const t of listTools()) {
        lines.push(`- ${t.name}: ${t.desc}`);
    }
    lines.push('');
    lines.push('When you have what you need, write the final answer to the user. NEVER state a number that did not come from a tool result or the context block.');
    return lines.join('\n');
}
