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
    controlCycleTheme, controlTogglePL, controlClosePLPanel, controlRefreshHotPicks, controlRunAnalysis,
    controlToggleEngineSignals, controlOpenTradeModal,
    controlSetPennyFilter, controlOpenSpikers, controlOpenAbout,
    controlToggleCurrency, controlScrollTo, controlPLCalculate,
    controlSetTheme, controlFocusSearch, controlClearMiaChat, controlCopyToClipboard,
    controlOpenResources, controlCloseResources, controlOpenFullLedger, controlCloseFullLedger,
    controlSetAccuracyWindow,
    controlAddToWatchlist, controlRemoveFromWatchlist, controlSetPriceAlert,
    controlOpenSectorHeatmap, controlCloseSectorHeatmap,
    controlOpenEarningsCalendar, controlCloseEarningsCalendar,
    controlOpenPortfolioPanel, controlClosePortfolioPanel, controlInstantiatePortfolio,
    controlAddFunds, controlResetPortfolio, controlSetTimeTravel, controlClearTimeTravel,
    readMacroRegime,
    readUiSnapshot, readCalibrationSnapshot, readAccuracyStats,
    findSpikersDirect, readPredictionLog, readSourceAccuracy,
    readLedgerHistory, readLiveCalibration, findSimilarSetups, readTopLosers,
    readWatchlist,
} from './ui-bridge.js';
import { compute } from './math-tool.js';
import {
    fetchNewsAndSentiment, fetchFredSeries, fetchRedditSentiment,
    fetchSecRecentFilings, fetchOptionsView, fetchCryptoDerivativesView,
} from './external-tools.js';
import { researchSymbol } from './research-bundle.js';
import { webSearch } from './web-search.js';
import { getPortfolio, isInstantiated, totalDepositedUSD } from '../portfolio/state.js';
import { buy as portfolioBuy, sell as portfolioSell, unrealizedPnL } from '../portfolio/trade.js';
import { getCurrentPrice } from '../portfolio/pricing.js';

const TOOLS = {
    get_app_state: {
        desc: 'app snapshot (mode, symbol, theme, latest signal summary)', args: '{}',
        run: () => readUiSnapshot(), kind: 'read',
    },
    start_walkthrough: {
        desc: 'give the user a live guided tour of the app — Mia DRIVES it, performing real actions while narrating. Use when the user asks to "show me around / give me a tour / walk me through the app / how do I use this / demo it". The tour is built DYNAMICALLY from the current state: it features a real symbol from today\'s Hot Picks (loads + analyzes it), and visits a varying subset of surfaces (sector heatmap, full ledger, resources, theme, stock/crypto modes) in a shuffled order, so it\'s never the same twice. It returns { stopsShown, count } — after calling, briefly tell the user what you showed and invite a follow-up. Runs ~20-30s; only start one at a time.',
        args: '{}',
        run: async () => {
            const { runWalkthrough } = await import('./walkthrough.js');
            return runWalkthrough();
        },
        kind: 'control',
    },
    get_live_price: {
        desc: 'fetch the LIVE current price for a symbol from a fresh data feed. Crypto = Binance (realtime). Stocks = Public.com (realtime) when available, else Stooq (5-15min delayed). ALWAYS call this for any "current price" / "live price" / "what is X trading at" question — never quote a price from a cached signal. Returns { symbol, priceUSD, source, delayed, fetchedAt }. READ source FROM THE RESULT — never assume; if delayed:true, say the quote may be a few minutes old.',
        args: '{"symbol":"AAPL"}',
        run: async ({ symbol }) => {
            if (!symbol) return { error: 'symbol required' };
            const sym = String(symbol).toUpperCase().trim();
            try {
                const priceUSD = await getCurrentPrice(sym);
                if (priceUSD == null || !Number.isFinite(priceUSD)) {
                    return { error: `No live price available for ${sym}.` };
                }
                // Crypto symbols on this platform are always suffixed -USD.
                const isCrypto = /-USDT?$/.test(sym);
                // For stocks, read the ACTUAL source the price came from
                // (public = realtime, stooq/yahoo = delayed) — never assume.
                let source, delayed;
                if (isCrypto) {
                    source = 'binance'; delayed = false;
                } else {
                    const { getLastStockSource, isStale } = await import('../portfolio/pricing.js');
                    source = getLastStockSource(sym) || 'stooq';
                    delayed = isStale(source);
                }
                return {
                    symbol: sym,
                    priceUSD,
                    source,
                    delayed,
                    fetchedAt: new Date().toISOString(),
                };
            } catch (e) {
                return { error: e.message || 'Failed to fetch live price.' };
            }
        },
        kind: 'read',
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
                breakdown: sig.breakdown, priceTargets: sig.priceTargets, forecastBand: sig.forecastBand,
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
        desc: 'run full analysis on ANY symbol (without loading it into the chart) and get the complete engine read — signal, confidence, source consensus, AND all the sub-module reads: squeeze, VWAP, timeframe agreement, volume profile, sector rotation, cross-asset, gap, recent spike, earnings, options positioning, derivs, peers, pattern, macro regime. Use to answer "what\'s the squeeze/options/regime read on TSLA" for a symbol the user isn\'t currently viewing.',
        args: '{"symbol":"AAPL","mode":"stock|crypto"}',
        run: async ({ symbol, mode }) => {
            if (!symbol) return { error: 'symbol required' };
            const m = mode || state.mode;
            const data = m === 'crypto' ? await fetchCryptoMultiTimeframe(symbol) : await fetchStockMultiTimeframe(symbol);
            const result = await computeFullConfidence(data, m, symbol, state.timeframe);
            return {
                symbol: data.daily.symbol, name: data.daily.name, currentPrice: data.daily.currentPrice,
                signal: result.signal, confidence: result.confidence, trendRegime: result.trendRegime,
                regime: result.regime,
                breakdown: result.breakdown, consensus: result.consensus,
                priceTargets: result.priceTargets, forecastBand: result.forecastBand,
                // Sub-module reads — already computed by the engine, previously
                // dropped on the floor for non-loaded symbols. Now exposed so
                // Mia can answer targeted questions about any ticker.
                squeeze: result.squeeze, vwap: result.vwap, tfAgreement: result.tfAgreement,
                volProfile: result.volProfile, rotation: result.rotation, crossAsset: result.crossAsset,
                gap: result.gap, recentSpike: result.recentSpike, earnings: result.earnings,
                options: result.options, derivs: result.derivs, peers: result.peers,
                pattern: result.pattern, sector: result.sector, yields: result.yields,
                topReasons: result.reasons?.slice(0, 8),
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
        desc: 'the engine\'s BUY picks (up to 20, ranked strongest-first by calibrated confidence). Hot Picks is BUY-only — every result is signal:"BUY" (SELL/NEUTRAL/AVOID are excluded). NOTE: this engine\'s calibrated BUY confidences currently sit low (often 20s-low-50s, near coin-flip), so a "top" pick may still be modest — quote the real confidence %, never imply it\'s high. Empty only if nothing scanned was a BUY. Use for "what should I buy / what\'s hot / any good buys today".', args: '{"mode":"stock|crypto","timeframe":"today|tomorrow"}',
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
    evaluate_news_for_symbol: {
        desc: 'Deep news + rumor analysis for a symbol. Returns the top headlines WITH FULL-TEXT BODIES extracted from each article + source-tier classification (1 = newswire/regulator, 2 = major outlet like Reuters/Bloomberg/WSJ, 3 = aggregator/secondary, 4 = blog/social). Use ONLY when the user asks about a specific rumor, catalyst, or "what is driving this stock" — not for routine sentiment checks (use get_news_and_sentiment for those). When you call this, READ THE FULL TEXT and quote/paraphrase specific facts. Discount Tier-3/4 sources unless multiple corroborate. NEVER state a claim from this without naming the source domain inline ("per reuters.com").',
        args: '{"symbol":"AAPL","mode":"stock|crypto","topN":3}',
        run: async ({ symbol, mode = 'stock', companyName = '', topN = 3 }) => {
            if (!symbol) return { error: 'symbol required' };
            // Reuse the existing news fetch path so we don't duplicate
            // RSS / breaker / dedupe logic. Then enrich each top-N
            // headline with full-text + source tier in parallel.
            const newsModule = await import('../news.js');
            const newsItems = mode === 'crypto'
                ? await newsModule.fetchCryptoNews(symbol).catch(() => [])
                : await newsModule.fetchStockNews(symbol, companyName).catch(() => []);
            if (!newsItems.length) {
                return { symbol, mode, articles: [], note: 'No recent news found.' };
            }
            const N = Math.min(Math.max(1, Number(topN) || 3), 6);
            const target = newsItems.slice(0, N);
            const { fetchFullArticle, tierForUrl } = await import('../article-extractor.js');
            const enriched = await Promise.all(target.map(async (item) => {
                const [article, tierInfo] = await Promise.all([
                    item.url ? fetchFullArticle(item.url).catch(() => null) : Promise.resolve(null),
                    item.url ? tierForUrl(item.url).catch(() => null) : Promise.resolve(null),
                ]);
                return {
                    title: item.title,
                    url: item.url || null,
                    source: item.source || null,
                    publishedAt: article?.publishedAt || (item.date instanceof Date ? item.date.toISOString() : item.date) || null,
                    byline: article?.byline || null,
                    sourceTier: tierInfo?.tier ?? 4,
                    sourceDomain: tierInfo?.domain ?? null,
                    sourceLabel: tierInfo?.tier === 1 ? 'primary/regulator'
                              : tierInfo?.tier === 2 ? 'major-outlet'
                              : tierInfo?.tier === 3 ? 'aggregator/secondary'
                              : 'blog/social/unknown',
                    fullText: article?.mainText || null,
                    wordCount: article?.wordCount || 0,
                    extractionFailed: !article || !article.mainText,
                };
            }));
            return {
                symbol,
                mode,
                articles: enriched,
                guidance: 'Read the fullText carefully — quote specific facts and name the source domain inline. Discount Tier-3/4 unless corroborated by Tier-1/2.',
            };
        },
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
    open_pl_panel: { desc: 'open the P&L Calculator side panel (its own panel — plan a trade: investment, entry, target → projected profit/loss). Use for "open the P&L calculator / I want to work out a profit". To actually RUN a calculation with numbers, prefer pl_calculate.', args: '{}', run: () => controlTogglePL(), kind: 'control' },
    close_pl_panel: { desc: 'close the P&L Calculator side panel.', args: '{}', run: () => controlClosePLPanel(), kind: 'control' },
    refresh_hot_picks: { desc: 'rescan hot picks', args: '{}', run: () => controlRefreshHotPicks(), kind: 'control' },
    toggle_engine_signals: {
        desc: 'toggle the chart\'s "Engine Signals" mode. When ON, the chart renders our own candlesticks with the engine\'s PAST buy/sell calls drawn as markers (green = hit, red = miss) — the most honest "was it right?" view. When OFF, US tickers use the TradingView embed. Pass {on:true|false} to set explicitly, or omit to flip. Use for "show me the engine\'s past calls on the chart / show the signal markers / hide the markers".',
        args: '{"on":true}',
        run: ({ on } = {}) => controlToggleEngineSignals({ on }),
        kind: 'control',
    },
    open_trade_modal: {
        desc: 'open the practice-portfolio Buy/Sell trade ticket for a symbol so the user can confirm size + execute. Requires an instantiated portfolio (returns {ok:false, reason:"no-portfolio"} if none — then offer instantiate_portfolio). Use when the user says "buy/sell NVDA" and wants to act. After the modal is open, place_trade executes the actual fill. side defaults to BUY.',
        args: '{"symbol":"NVDA","side":"BUY"}',
        run: ({ symbol, side } = {}) => controlOpenTradeModal({ symbol, side }),
        kind: 'action',
    },
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
        desc: 'open the P&L Calculator in the centered agentic stage, auto-fill the inputs, click Calculate. currentPrice is optional — omit to use the loaded symbol\'s live price. Returns shares, currentValue, plDollar, plPct.\n\nCONVERSATION FLOW (Roshan\'s spec): after this returns, your reply MUST: (1) state the P&L outcome in plain English ("$250 profit, +12.3%"), (2) ask if they want to run another scenario. If user says NO on the next turn, call close_pl_calculator to dismiss the stage and return focus to your chat. If user says YES, ask for the new inputs (investment / buy / target) and call this tool again.',
        args: '{"investment":1000,"buyPrice":150,"currentPrice":175}',
        run: ({ investment, buyPrice, currentPrice }) => controlPLCalculate({ investment, buyPrice, currentPrice }),
        kind: 'control',
    },
    close_pl_calculator: {
        desc: 'close the P&L Calculator agentic stage (the centered glass card with aurora backdrop). Returns the calculator fields to the P&L panel and dismisses the stage. Use ONLY after the user has explicitly said "no more" / "that\'s it" / equivalent in response to "want to run another scenario?". Mia\'s minimized orb stays visible the whole time.',
        args: '{}',
        run: async () => {
            const { closeAgenticStage, isAgenticStageOpen } = await import('../ui/agentic-stage.js');
            if (isAgenticStageOpen()) closeAgenticStage();
            return { ok: true };
        },
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
    get_top_losers: {
        desc: 'biggest 1-day movers from the live ledger\'s most-recent resolved trading day, SCOPED to our ~530-symbol universe (S&P 500, Nasdaq 100, sector reps, top crypto, plus liquid NSE / HKEX / TYO / LSE / DAX / ASX names). side="down" worst performers, "up" best, "movers" biggest absolute. Optional region filter. Use this when the user is asking specifically about the engine\'s scope ("worst tracked stock today", "what did the model call?"). For market-fact questions ("worst stock IN THE WORLD today") use web_search instead — DON\'T call this tool just to pad the answer.',
        args: '{"side":"down","limit":10,"region":"NYSE"}',
        run: ({ side, limit, region } = {}) => readTopLosers({ side, limit, region }),
        kind: 'read',
    },
    compute: {
        desc: 'evaluate any arithmetic expression. Use this for EVERY computation, however small. Supports + - * / ^ and parentheses. Pass an optional "as" name to store the result as a named variable that subsequent compute calls can reference — that\'s how multi-step problems are built up cleanly. Example chain: compute({expression:"974/8.80", as:"shares"}) → 110.68; compute({expression:"shares*7.96", as:"currentValue"}) → 880.93; compute({expression:"974-currentValue"}) → 93.07.',
        args: '{"expression":"974 / 8.80","as":"shares"}',
        run: ({ expression, as }) => compute({ expression, as }),
        kind: 'read',
    },
    get_portfolio: {
        desc: 'simulated practice portfolio: cash + positions + unrealized P&L per holding + total return since instantiation. Returns null if user has not loaded a portfolio yet.',
        args: '{}',
        run: async () => {
            if (!isInstantiated()) return { instantiated: false, note: 'User has not loaded a practice portfolio yet.' };
            const p = getPortfolio();
            const positions = [];
            let heldUSD = 0;
            for (const [sym, pos] of Object.entries(p.positions)) {
                let price = null;
                try { price = await getCurrentPrice(sym); } catch (_) {}
                const pnl = price != null ? unrealizedPnL(sym, price) : null;
                if (pnl) heldUSD += pnl.marketValueUSD;
                positions.push({
                    symbol: sym,
                    units: pos.units,
                    avgCostUSD: pnl?.avgCostUSD,
                    currentPriceUSD: price,
                    marketValueUSD: pnl?.marketValueUSD,
                    unrealizedUSD: pnl?.unrealizedUSD,
                    unrealizedPct: pnl?.unrealizedPct,
                });
            }
            const totalDepUSD = totalDepositedUSD();
            const totalUSD = p.cashUSD + heldUSD;
            return {
                instantiated: true,
                currency: p.currency,
                cashUSD: p.cashUSD,
                heldUSD,
                totalUSD,
                totalDepositedUSD: totalDepUSD,
                totalPnLUSD: totalUSD - totalDepUSD,
                totalPnLPct: totalDepUSD > 0 ? ((totalUSD - totalDepUSD) / totalDepUSD) * 100 : 0,
                positions,
            };
        },
        kind: 'read',
    },
    place_trade: {
        desc: 'execute a market BUY or SELL on the practice portfolio. Long-only — sell only what the user holds. quote.mode is "amountUSD" (dollar amount), "units" (fractional shares), or "all" (sell entire position; SELL only). Refuses if portfolio not instantiated or insufficient cash. Confirm with the user before calling — never trade silently.',
        args: '{"symbol":"NVDA","side":"BUY","mode":"amountUSD","value":250}',
        run: async ({ symbol, side, mode, value }) => {
            if (!isInstantiated()) throw new Error('No practice portfolio loaded. User must instantiate one first.');
            const sd = String(side || '').toUpperCase();
            if (sd !== 'BUY' && sd !== 'SELL') throw new Error('side must be BUY or SELL.');
            // Voice path: the Live schema can't mark `value` conditionally
            // required, so the model can call amountUSD/units with no value.
            // Guard here so we never dispatch a zero/undefined-size trade.
            if (mode !== 'all' && !(Number(value) > 0)) {
                throw new Error('A positive value is required for mode "amountUSD" or "units".');
            }
            const quote = mode === 'all' ? { mode: 'all' } : { mode, value };
            const fn = sd === 'BUY' ? portfolioBuy : portfolioSell;
            return await fn(symbol, quote);
        },
        kind: 'action',
    },
    open_resources: {
        desc: 'open the Resources side panel (left rail) showing the glossary, FAQ, and indicator definitions. Use when the user asks "what is RSI" / "explain MACD" / similar — pair with a verbal definition in your reply.',
        args: '{}',
        run: () => controlOpenResources(),
        kind: 'control',
    },
    close_resources: {
        desc: 'close the Resources side panel. Use when the user says "close resources / hide the glossary / close that panel" referring to Resources. Idempotent — safe to call when already closed.',
        args: '{}',
        run: () => controlCloseResources(),
        kind: 'control',
    },
    open_full_ledger: {
        desc: 'open the Full Ledger panel and optionally focus a specific symbol. Pass {symbol} to filter to that ticker, {expand: true} to also open its inline analysis drawer, {signal: "BUY"} to filter by direction, {accuracyWindow: "30 days"} to scope the per-symbol accuracy column to a recency window. Use this for any question that requires showing the ledger ("show me how the engine has done on NVDA the last week").',
        args: '{"symbol":"NVDA","expand":true,"accuracyWindow":"30 days"}',
        run: ({ symbol, expand, signal, accuracyWindow } = {}) => controlOpenFullLedger({ symbol, expand, signal, accuracyWindow }),
        kind: 'control',
    },
    close_full_ledger: {
        desc: 'close (collapse) the Full Ledger panel. Use when the user says "close the ledger / hide the ledger". Idempotent.',
        args: '{}',
        run: () => controlCloseFullLedger(),
        kind: 'control',
    },
    set_accuracy_window: {
        desc: 'set the Full Ledger\'s Prediction Accuracy time-window filter. Accepts "30 days", "3 months", "1 year", or "all". When you call this, the engine\'s hit/miss/total counts in the ledger column re-aggregate across only predictions made within the window.',
        args: '{"window":"30 days"}',
        run: ({ window } = {}) => controlSetAccuracyWindow(window),
        kind: 'control',
    },
    add_to_watchlist: {
        desc: 'star a symbol to the user\'s watchlist (idempotent — safe to call when already starred). After adding, suggest setting a price alert if relevant.',
        args: '{"symbol":"AAPL"}',
        run: async ({ symbol }) => controlAddToWatchlist({ symbol }),
        kind: 'action',
    },
    remove_from_watchlist: {
        desc: 'unstar a symbol from the user\'s watchlist (idempotent).',
        args: '{"symbol":"AAPL"}',
        run: async ({ symbol }) => controlRemoveFromWatchlist({ symbol }),
        kind: 'action',
    },
    set_price_alert: {
        desc: 'set a realtime browser price alert above and/or below thresholds. CRYPTO ONLY (e.g. BTC-USD) — free stock data is 5–15 min delayed with no live feed, so the tool REFUSES stock symbols and returns {ok:false, unsupported:true, reason}. If you get that, relay the reason honestly; do NOT tell the user an alert was set. Auto-stars the (crypto) symbol. Pass {symbol, above:null, below:null} to clear. Confirm before setting — never set silently.',
        args: '{"symbol":"BTC-USD","above":75000,"below":60000}',
        run: async ({ symbol, above, below } = {}) => controlSetPriceAlert({ symbol, above, below }),
        kind: 'action',
    },
    get_watchlist: {
        desc: 'read the user\'s current watchlist with last-known prices and any active alerts. Useful before adding/removing/setting alerts so you can recap state to the user.',
        args: '{}',
        run: async () => readWatchlist(),
        kind: 'read',
    },
    open_sector_heatmap: {
        desc: 'open the Sector Heatmap panel AND return current 5-day relative strength for all 11 sectors. Use for "which sector is hot/leading/lagging today" or "where is money rotating". The returned trends array (sorted strongest→weakest) lets you narrate the answer in the same turn — quote those numbers, not memory.',
        args: '{}',
        run: async () => controlOpenSectorHeatmap(),
        kind: 'control',
    },
    close_sector_heatmap: {
        desc: 'close (collapse) the Sector Heatmap panel. Use when the user says "close the heatmap". Idempotent.',
        args: '{}',
        run: () => controlCloseSectorHeatmap(),
        kind: 'control',
    },
    open_earnings_calendar: {
        desc: 'open the Earnings Calendar AND return upcoming large-cap earnings (symbol, daysUntil, pre-earnings signal, confidence) within a window. Use for "who reports this week / soon" or "any earnings coming up for big names". Pass {windowDays} to widen/narrow (default 14). Quote from the returned upcoming array.',
        args: '{"windowDays":14}',
        run: async ({ windowDays } = {}) => controlOpenEarningsCalendar({ windowDays }),
        kind: 'control',
    },
    close_earnings_calendar: {
        desc: 'close (collapse) the Earnings Calendar panel. Use when the user says "close the earnings calendar". Idempotent.',
        args: '{}',
        run: () => controlCloseEarningsCalendar(),
        kind: 'control',
    },
    open_portfolio_panel: {
        desc: 'open the practice-trading portfolio side panel (holdings, cash, P&L). Use when the user asks to see their portfolio / positions / practice account. This is the practice portfolio — SEPARATE from the watchlist.',
        args: '{}',
        run: async () => controlOpenPortfolioPanel(),
        kind: 'control',
    },
    close_portfolio_panel: {
        desc: 'close the portfolio side panel.',
        args: '{}',
        run: async () => controlClosePortfolioPanel(),
        kind: 'control',
    },
    instantiate_portfolio: {
        desc: 'create a fresh practice (paper-trading) portfolio with a starting cash balance. Use when a user with no portfolio asks to "start a practice account" / "give me $10k to trade". amount is in `currency` (default USD). No real money — clearly a simulation. Returns alreadyExists:true if one is already set up (then suggest add_funds or reset).',
        args: '{"amount":10000,"currency":"USD"}',
        run: async ({ amount, currency } = {}) => controlInstantiatePortfolio({ amount, currency }),
        kind: 'action',
    },
    add_funds: {
        desc: 'add cash to the existing practice portfolio. amount in `currency` (default USD). Returns a note if no portfolio exists yet (then call instantiate_portfolio).',
        args: '{"amount":5000,"currency":"USD"}',
        run: async ({ amount, currency } = {}) => controlAddFunds({ amount, currency }),
        kind: 'action',
    },
    reset_portfolio: {
        desc: 'wipe the practice portfolio back to empty. DESTRUCTIVE — always confirm with the user before calling ("This will erase your practice portfolio and all its positions — are you sure?"). Never call without explicit confirmation in the conversation.',
        args: '{}',
        run: async () => controlResetPortfolio(),
        kind: 'action',
    },
    set_time_travel: {
        desc: 'TIME-TRAVEL: replay the engine on the currently-loaded symbol as of a PAST date, using only the price bars that existed then — "what would the engine have said on 2025-01-15?". Requires a symbol to be loaded first. The chart truncates to that date and the signal re-runs (hypothetical, not logged). Use for "what would you have called NVDA back in March" type questions.',
        args: '{"date":"2025-03-10"}',
        run: async ({ date } = {}) => controlSetTimeTravel({ date }),
        kind: 'control',
    },
    clear_time_travel: {
        desc: 'exit time-travel mode and re-run the engine on current live data.',
        args: '{}',
        run: async () => controlClearTimeTravel(),
        kind: 'control',
    },
    get_macro_regime: {
        desc: 'read the current MACRO REGIME — risk-on / risk-off / transition / neutral — plus its components (VIX level & 5d trend, S&P 500 5d/10d move, US dollar 5d move). Use for "what\'s the market regime / is it risk-on or risk-off / how\'s the macro backdrop". This is the same regime the engine factors into every signal.',
        args: '{}',
        run: async () => readMacroRegime(),
        kind: 'read',
    },
    // Removed per user: show_equity_curve + get_accuracy_by_setup (the equity
    // curve + accuracy-by-setup surfaces were taken out).
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
