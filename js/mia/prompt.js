// System prompt and signal-grounded context block.
//
// Three load-bearing rules:
//   1. NEVER invent numbers. If not in CONTEXT or a tool RESULT, refuse.
//   2. The on-screen confidence is the source of truth.
//   3. No buy/sell recommendations beyond the displayed signal.

import { state } from '../ui/state.js';
import { loadSettings } from './settings.js';

const BASE = `You are Mia, the Market Intelligence Analyst built into the "Market Analyzer" web app.

YOUR ROLE
- Help the user understand any stock or crypto, the indicators we use, and the signal currently displayed.
- Behave like an experienced market analyst: clear, calm, numerate. Concise: 3-6 short sentences by default.
- You can call tools to fetch real numbers (analyze a stock, read hot picks, get market conditions, etc.). PREFER tool calls over guessing.

# FORBIDDEN
- NEVER invent any number not present in the CONTEXT or a tool RESULT. This includes confidence percentages, hit-rate stats, prices, RSI/MACD/ADX/MFI values, or backtest numbers.
- If you don't have a number and the user asks for one, call a tool. If no tool can give it, say "I don't have that data" — do not fabricate.
- Never give buy/sell recommendations beyond what the displayed signal already says.
- No hype words ("to the moon", "guaranteed", "surefire").

# RULES
1. The on-screen confidence is the source of truth. Echo it exactly when stating it.
2. 3-6 sentences default. Bullets only when comparing items.
3. If the user asks about a symbol with no analysis loaded, call analyze_symbol.
4. After you finish answering, do not continue to make extra calls.
`;

const THINKING_PRELUDE = `# THINKING MODE
Before answering, think step by step. Walk through what you know, what you need, and which tool calls would close the gap. Verify any number you're about to state is in CONTEXT or a tool RESULT. Flag uncertainty explicitly.
When you arrive at the final answer, write it cleanly without showing your scratch work.
`;

export function buildSystemPrompt() {
    const s = loadSettings();
    return s.thinkingMode ? `${BASE}\n${THINKING_PRELUDE}` : BASE;
}

export function buildContextBlock(latestSignal) {
    const lines = ['# CONTEXT (the only ground-truth data without tool calls)', ''];
    lines.push(`Mode: ${state.mode}, Timeframe: ${state.timeframe}`);
    lines.push(`Selected symbol: ${state.currentSymbol || '(none selected)'}`);
    if (state.currentPrice != null) lines.push(`Current price: $${state.currentPrice}`);
    else lines.push('Current price: (no symbol selected)');

    // Cache the latest signal on window so tools can read it.
    window.__miaLatestSignal = latestSignal || null;

    if (latestSignal) {
        lines.push('');
        lines.push('## CURRENT SIGNAL (source of truth, never contradict)');
        lines.push(`- Signal: ${latestSignal.signal}`);
        lines.push(`- Confidence (calibrated): ${latestSignal.confidence}%`);
        if (latestSignal.calibrationApplied) lines.push('- Calibration: backtest-loaded (this percentage equals empirical hit rate)');
        else lines.push('- Calibration: NOT loaded (the percentage is heuristic only)');
        if (latestSignal.trendRegime) lines.push(`- Trend regime: ${latestSignal.trendRegime}`);
        if (latestSignal.breakdown) {
            const bd = latestSignal.breakdown;
            lines.push('- Source scores (0-100 bullish):');
            if (bd.ai?.available) lines.push(`  - AI Model: ${bd.ai.score}`);
            lines.push(`  - Technicals: ${bd.technical.score}`);
            lines.push(`  - Sentiment: ${bd.sentiment.score}`);
            lines.push(`  - Market: ${bd.market.score}`);
        }
        if (latestSignal.priceTargets) {
            const pt = latestSignal.priceTargets;
            lines.push(`- Predicted range: $${pt.predictedLow} — $${pt.predictedHigh} (ATR $${pt.atr})`);
            lines.push(`- Support: $${pt.support}, Resistance: $${pt.resistance}`);
        }
        if (latestSignal.reasons?.length) {
            lines.push('- Top reasons (verbatim from the engine):');
            latestSignal.reasons.slice(0, 6).forEach(r => lines.push(`  - ${r}`));
        }
    } else {
        lines.push('');
        lines.push('## NO ANALYSIS LOADED');
        lines.push('No symbol on screen, so no signal/confidence/indicator/price-target data is available WITHOUT calling tools.');
        lines.push('If the user asks about a specific symbol or wants a number, call analyze_symbol or another relevant tool.');
    }
    return lines.join('\n');
}
