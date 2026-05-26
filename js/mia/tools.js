// Mia's tool registry. Phase 4: adds research_symbol (parallel multi-source
// bundle) and web_search (keyless DuckDuckGo). All control tools route
// through ui-bridge.js. Mia cannot mutate any number.

import { state } from '../ui/state.js';
import { fetchStockMultiTimeframe, fetchCryptoMultiTimeframe } from '../data.js';
import { computeFullConfidence } from '../confidence.js';
import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { getMarketConditionsScore } from '../market.js';
import {
    controlSelectSymbol, controlSwitchMode, controlSwitchTimeframe,
    controlCycleTheme, controlTogglePL, controlRefreshHotPicks, controlRunAnalysis,
    controlSetPennyFilter, controlOpenSpikers, controlOpenAbout,
    controlToggleCurrency, controlScrollTo, controlPLCalculate,
    controlSetTheme, controlFocusSearch, controlClearMiaChat, controlCopyToClipboard,
    readUiSnapshot, readCalibrationSnapshot, readAccuracyStats,
    findSpikersDirect, readPredictionLog, readSourceAccuracy,
    readLedgerHistory, readLiveCalibration, findSimilarSetups,
} from './ui-bridge.js';
import { compute } from './math-tool.js';
import {
    fetchNewsAndSentiment, fetchFredSeries, fetchRedditSentiment,
    fetchSecRecentFilings, fetchOptionsView, fetchCryptoDerivativesView,
} from './external-tools.js';
import { researchSymbol } from './research-bundle.js';
import { webSearch } from './web-search.js';

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
    find_similar_setups: {
        desc: 'find past ledger predictions with similar RSI/MACD/BB to the current setup, report hit rate at each horizon',
        args: '{"signal": "BUY|SELL", "k": 20, "region": "NYSE|NSE|..."}',
        run: (a = {}) => findSimilarSetups(a),
        kind: 'read',
    },
    explain_prediction: {
        desc: 'top features that drove the current signal (which indicators pushed the score most, with values)',
        args: '{"topN": 3}',
        run: ({ topN = 3 } = {}) => {
            const sig = window.__miaLatestSignal;
            if (!sig) return { available: false, note: 'No symbol selected.' };
            if (!sig.attribution) return { available: false, note: 'Attribution data not present on this signal (older render before feature shipped — re-run analysis).' };
            const lim = Math.max(1, Math.min(8, Number(topN) || 3));
            return {
                available: true,
                symbol: state.currentSymbol,
                signal: sig.signal,
                confidence: sig.confidence,
                topFeatures: sig.attribution.slice(0, lim),
                note: 'Each entry shows the indicator, its blended contribution across daily/weekly/4H (signed: +bullish, -bearish), and which timeframes contributed.',
            };
        },
        kind: 'read',
    },
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
    research_symbol: {
        desc: 'parallel multi-source bundle for one symbol (news+reddit+macro+positioning) — use BEFORE writing your independent read',
        args: '{"symbol":"AAPL","mode":"stock|crypto","macroSeries":"DGS10"}',
        run: ({ symbol, mode, macroSeries, companyName }) => researchSymbol({ symbol, mode, macroSeries, companyName }),
        kind: 'read',
    },
    web_search: {
        desc: 'keyless DuckDuckGo search; returns up to 5 {title,url,domain,snippet}. ALWAYS cite source domains in your answer',
        args: '{"query":"TSLA premarket news today","maxResults":5}',
        run: ({ query, maxResults }) => webSearch({ query, maxResults }),
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
    set_penny_filter: {
        desc: 'filter Hot Picks by penny tier: all, p10 (<$10), p5 (<$5), p1 (<$1)',
        args: '{"tier":"p10"}',
        run: ({ tier }) => controlSetPennyFilter({ tier }), kind: 'control',
    },
    open_spikers: { desc: 'open the Spikers panel (intraday spike candidates)', args: '{}', run: () => controlOpenSpikers(), kind: 'control' },
    open_about: { desc: 'open the About / how-it-works panel', args: '{}', run: () => controlOpenAbout(), kind: 'control' },
    toggle_currency: { desc: 'toggle USD ↔ INR display', args: '{}', run: () => controlToggleCurrency(), kind: 'control' },
    scroll_to: {
        desc: 'scroll the page to a section: chart, signal, accuracy, hotpicks, search',
        args: '{"section":"hotpicks"}',
        run: ({ section }) => controlScrollTo({ section }), kind: 'control',
    },
    pl_calculate: {
        desc: 'open P&L calculator and run a calculation. currentPrice is optional — omit to use the loaded symbol\'s live price. returns shares, currentValue, plDollar, plPct.',
        args: '{"investment":1000,"buyPrice":150,"currentPrice":175}',
        run: ({ investment, buyPrice, currentPrice }) => controlPLCalculate({ investment, buyPrice, currentPrice }),
        kind: 'control',
    },
    find_spikers: {
        desc: 'scan the live pool for spike candidates today. buckets: gte10 (≥10%), 10to20, 20to30, 30to40, 40to50, gt50.',
        args: '{"bucket":"gte10","limit":10}',
        run: ({ bucket, limit }) => findSpikersDirect({ bucket, limit }),
        kind: 'read',
    },
    get_prediction_log: {
        desc: 'recent local prediction history with resolution status (correct/incorrect/pending)',
        args: '{"limit":10}',
        run: ({ limit }) => readPredictionLog({ limit }),
        kind: 'read',
    },
    get_source_accuracy: {
        desc: 'rolling per-source hit rate (ai/technical/sentiment/market) over last 30 resolved predictions',
        args: '{}',
        run: () => readSourceAccuracy(),
        kind: 'read',
    },
    set_theme: {
        desc: 'set theme directly: dark, light, aurora',
        args: '{"theme":"dark"}',
        run: ({ theme }) => controlSetTheme({ theme }),
        kind: 'control',
    },
    focus_search: {
        desc: 'scroll to the search box and prefill an optional query (does NOT auto-pick — use select_symbol when the user names a specific symbol)',
        args: '{"query":"AAPL"}',
        run: ({ query }) => controlFocusSearch({ query }),
        kind: 'control',
    },
    clear_chat: {
        desc: 'clear the Mia chat history. Use only when the user explicitly asks.',
        args: '{}',
        run: () => controlClearMiaChat(),
        kind: 'control',
    },
    copy_to_clipboard: {
        desc: 'copy a short snippet to the user\'s clipboard (e.g. signal summary, ticker list)',
        args: '{"text":"NVDA · 72% BUY · $1,180"}',
        run: ({ text }) => controlCopyToClipboard({ text }),
        kind: 'control',
    },
    get_ledger_history: {
        desc: 'recent live-ledger predictions (and resolved outcomes) from the open-of-day cron. Optional symbol filter; returns 1d hit-rate summary plus the last N rows.',
        args: '{"symbol":"NVDA","limit":10}',
        run: ({ symbol, limit }) => readLedgerHistory({ symbol, limit }),
        kind: 'read',
    },
    get_live_calibration: {
        desc: 'current empirical hit rates from the live ledger, broken down by horizon (1/3/5/10/20 days), signal (BUY/SELL/NEUTRAL), and region',
        args: '{}',
        run: () => readLiveCalibration(),
        kind: 'read',
    },
    compute: {
        desc: 'evaluate any arithmetic expression. Use this for EVERY computation, however small. Supports + - * / ^ and parentheses. Pass an optional "as" name to store the result as a named variable that subsequent compute calls can reference — that\'s how multi-step problems are built up cleanly. Example chain: compute({expression:"974/8.80", as:"shares"}) → 110.68; compute({expression:"shares*7.96", as:"currentValue"}) → 880.93; compute({expression:"974-currentValue"}) → 93.07.',
        args: '{"expression":"974 / 8.80","as":"shares"}',
        run: ({ expression, as }) => compute({ expression, as }),
        kind: 'read',
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
    const lines = ['# TOOLS'];
    lines.push('Format: one line, no markdown wrapping, no bullets, no bold:');
    lines.push('TOOL: tool_name {"arg": "value"}');
    lines.push('Then STOP. The system will run the tool and reply with a RESULT: line.');
    lines.push('You MUST NEVER write a RESULT: line yourself. Only the system emits those.');
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

// Compact form used on agent-loop iterations 2+. The model already saw
// the full registry on iteration 1's request; subsequent iterations
// just need a name list as a refresher. Cuts ~1500 chars / ~375 tokens
// off every follow-up iteration. Adds up fast on a 6-call deep-dive.
export function toolPromptSectionCompact() {
    const reads = Object.entries(TOOLS).filter(([_, t]) => (t.kind || 'read') === 'read').map(([n]) => n);
    const ctrls = Object.entries(TOOLS).filter(([_, t]) => t.kind === 'control').map(([n]) => n);
    return `# TOOLS (compact — use the name and args you already saw)
Format: TOOL: tool_name {"arg": "value"} on its own line, then STOP.
READ: ${reads.join(', ')}
CONTROL: ${ctrls.join(', ')}`;
}
