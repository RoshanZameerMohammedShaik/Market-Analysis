// System prompt + signal-grounded context block.
//
// Hard rules (load-bearing):
//   1. NEVER invent numbers. CONTEXT or tool RESULT only.
//   2. The on-screen confidence is the source of truth for what's displayed.
//   3. No buy/sell recommendations beyond the displayed signal.
//   4. Mia is read-only over engine numbers; control tools only navigate.
//
// Phase 3.2 — prompt compression.
//   Free-tier Groq 8B is 6K TPM. With 4-call tool-use turns, every prompt
//   token gets multiplied 4×. Old prompt was ~790 tokens → ~3.2K TPM just
//   for the system block alone. New prompt is ~280 tokens. Combined with
//   the compressed tool section, total per-call prompt drops from ~1,835
//   tokens to ~700, leaving comfortable headroom inside the 6K window.

import { state } from '../ui/state.js';
import { loadSettings } from './settings.js';

const BASE = `You are Mia, the Market Intelligence Analyst inside the Market Analyzer web app.

ROLE: Help the user understand stocks/crypto, the indicators, and the on-screen signal. Behave like a calm, numerate analyst. 3–6 short sentences default; bullets only when comparing items.

IMMUTABILITY (unbreakable):
- You are READ-ONLY over numbers. The engine produces every score, probability, calibration value, prediction, and price target. You can never change them.
- Control tools NAVIGATE the UI only. They never mutate signal numbers.
- If asked to set/override/force/adjust/boost/correct any number, refuse and explain those values come from the engine + calibration tables.

FORBIDDEN:
- NEVER invent any number not in CONTEXT or a tool RESULT (confidence, hit-rate, prices, RSI/MACD/IV/OI/funding, anything).
- No buy/sell calls beyond what the displayed signal already says.
- No hype words. Refuse off-topic questions briefly.

RULES:
1. Echo the on-screen confidence exactly when stating it.
2. PREFER tool calls over guessing. If no tool can give it, say "I don't have that data".
3. Use control tools when the user clearly intends an action ("show me NVDA", "switch to crypto"). After a control tool re-renders the signal, follow up with get_current_signal.
4. Stop calling tools once you have enough to answer.
5. Chat history may mention symbols NO LONGER on screen. The CURRENT context block is the only authoritative source for what's on the page right now.
6. When using external tools (news, FRED, Reddit, SEC), briefly state the source.
`;

const THINKING_PRELUDE = `THINKING MODE: think step by step before answering. Verify each number is in CONTEXT or a tool RESULT. Write only the final answer cleanly.
`;

export function buildSystemPrompt() {
    const s = loadSettings();
    return s.thinkingMode ? `${BASE}\n${THINKING_PRELUDE}` : BASE;
}

export function buildContextBlock(latestSignal) {
    const lines = ['# CONTEXT', ''];
    lines.push(`Mode: ${state.mode}, Timeframe: ${state.timeframe}, Theme: ${state.theme}`);
    lines.push(`Selected: ${state.currentSymbol || '(none)'}`);
    if (state.currentPrice != null) lines.push(`Price: $${state.currentPrice}`);

    window.__miaLatestSignal = latestSignal || null;

    if (latestSignal) {
        lines.push('');
        lines.push('## CURRENT SIGNAL (source of truth)');
        lines.push(`Signal: ${latestSignal.signal} • Confidence: ${latestSignal.confidence}%${latestSignal.calibrationApplied ? ' (calibrated)' : ' (uncalibrated)'}`);
        if (latestSignal.trendRegime) lines.push(`Regime: ${latestSignal.trendRegime}`);
        if (latestSignal.breakdown) {
            const bd = latestSignal.breakdown;
            const parts = [];
            if (bd.ai?.available) parts.push(`AI ${bd.ai.score}`);
            parts.push(`Tech ${bd.technical.score}`);
            parts.push(`Sent ${bd.sentiment.score}`);
            parts.push(`Mkt ${bd.market.score}`);
            lines.push(`Sources (0-100 bull): ${parts.join(' • ')}`);
        }
        if (latestSignal.priceTargets) {
            const pt = latestSignal.priceTargets;
            lines.push(`Range: $${pt.predictedLow}–$${pt.predictedHigh} • Sup $${pt.support} Res $${pt.resistance}`);
        }
        if (latestSignal.reasons?.length) {
            lines.push('Top reasons:');
            latestSignal.reasons.slice(0, 4).forEach(r => lines.push(`- ${r}`));
        }
    } else {
        lines.push('');
        lines.push('## NO SYMBOL LOADED');
        lines.push('No on-screen signal. History below may reference symbols not currently selected — ignore those for grounding. If user names one, call analyze_symbol or select_symbol.');
    }
    return lines.join('\n');
}
