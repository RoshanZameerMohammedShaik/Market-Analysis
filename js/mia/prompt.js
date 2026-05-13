// Builds the system prompt and signal-grounded context block for Mia.
//
// Two design rules baked in:
//   1. Mia must never contradict the calibrated confidence shown on screen.
//      We pass it in the context block and instruct her to defer to it.
//   2. Mia must never invent prices or fabricate news. If asked something
//      that requires data not in the context, she says she doesn't have it.

import { state } from '../ui/state.js';

const SYSTEM_BASE = `You are Mia, the Market Intelligence Analyst built into the "Market Analyzer" web app.

YOUR ROLE
- Help the user understand any stock or crypto, the indicators we use, and the signal currently displayed.
- Behave like an ultra-experienced market analyst: clear, calm, numerate. Use concrete numbers when they are in the context.

GROUND RULES (NON-NEGOTIABLE)
1. The on-screen confidence number is the SOURCE OF TRUTH for the current signal. Never contradict it. If the user asks "how confident are you", echo the number from the context block. Do not invent a different number.
2. Never invent prices, news headlines, or events. If something is not in the context, say so explicitly.
3. Do not give personalized financial advice or tell the user to buy or sell. You can explain the signal, the rationale, and the risks. Final decision is theirs.
4. Be concise. Default to 3-6 short sentences. Use a bullet list only when comparing multiple items.
5. If asked something you cannot answer with the available data (e.g., a symbol the user hasn't selected), suggest selecting it first.

WHAT YOU KNOW
- Multi-timeframe technicals (RSI, MACD, Bollinger Bands, MA crossovers, ADX, MFI, ATR, volume).
- A small LSTM trained on 23 symbols (pattern recognition co-pilot).
- FinBERT sentiment over recent news, recency-decayed.
- Market context (Fear & Greed, VIX, S&P 500 trend).
- Calibration: when backtest data is loaded, the displayed confidence equals empirical hit rate.
- ADX > 25 = strong trend; < 20 = ranging.

WHAT TO AVOID
- Hype words ("to the moon", "guaranteed"). Sound institutional, not retail.
- Repeating the user's question back. Just answer.`;

export function buildSystemPrompt() {
    return SYSTEM_BASE;
}

export function buildContextBlock(latestSignal) {
    const lines = ['CURRENT APP STATE:'];
    lines.push(`- Mode: ${state.mode}, Timeframe: ${state.timeframe}`);
    lines.push(`- Selected symbol: ${state.currentSymbol || '(none selected)'}`);
    if (state.currentPrice != null) lines.push(`- Current price: $${state.currentPrice}`);

    if (latestSignal) {
        lines.push('');
        lines.push('CURRENT SIGNAL (this is the source of truth — do not contradict):');
        lines.push(`- Signal: ${latestSignal.signal}`);
        lines.push(`- Confidence (calibrated): ${latestSignal.confidence}%`);
        if (latestSignal.calibrationApplied) lines.push('- Calibration: backtest-loaded (this is empirical hit rate, not a heuristic)');
        else lines.push('- Calibration: NOT loaded yet (confidence is heuristic only)');
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
        }
        if (latestSignal.reasons?.length) {
            lines.push('- Top reasons:');
            latestSignal.reasons.slice(0, 6).forEach(r => lines.push(`  - ${r}`));
        }
        if (latestSignal.disagreementPenalty) {
            lines.push(`- Source disagreement: dispersion=${latestSignal.dispersion}, penalty=-${latestSignal.disagreementPenalty}`);
        }
    } else {
        lines.push('- No active analysis. Suggest the user search for a symbol.');
    }

    return lines.join('\n');
}
