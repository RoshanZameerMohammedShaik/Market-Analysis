// Gemini Live function declarations for Mia's tool registry.
//
// Live API doesn't read free-form text prompts to discover tools the
// way agent.js does over the text path. It needs each tool declared as
// a FunctionDeclaration with a JSON-Schema parameter shape, passed in
// the setup payload's `tools` field. The model then natively decides
// when to invoke a tool from the user's spoken intent and emits a
// `toolCall` message we dispatch to runTool().
//
// Schemas only cover args that actually steer behavior; we omit purely-
// optional knobs the model will rarely set so it doesn't trip on them.
// Reference: ai.google.dev/api/live#FunctionDeclaration

// Gemini's STRING / NUMBER / OBJECT enum values use uppercase per the
// proto. Some SDKs accept lowercase; the WebSocket wire format does not.
const T = {
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    INTEGER: 'INTEGER',
    BOOLEAN: 'BOOLEAN',
    ARRAY: 'ARRAY',
    OBJECT: 'OBJECT',
};

// Each declaration: { name, description, parameters: JSONSchema }.
// Descriptions are critical — they're what Gemini reads to decide
// "should I call this tool?". Be explicit about WHEN to use vs. not use.
export const TOOL_DECLARATIONS = [
    // ── Read tools ──────────────────────────────────────────────────
    {
        name: 'get_app_state',
        description: 'Snapshot of the app: current symbol, mode (stock/crypto), theme, latest signal summary. Use to ground answers about what the user is currently looking at.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'start_walkthrough',
        description: 'Give the user a live guided tour where Mia drives the app, performing real actions while narrating. Use for "show me around / give me a tour / walk me through it / demo the app". Built dynamically from current state (features a real Hot Pick, visits a shuffled subset of surfaces) so it varies each time. After it returns, summarize what you showed.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'get_live_price',
        description: 'Fetch the LIVE current price for a symbol from a fresh data feed (Binance for crypto, Stooq snapshot for stocks). MANDATORY for any "current price" / "live price" / "what is X trading at" question — DO NOT quote a price from get_current_signal or memory; that data is from the last analysis run, not live. Returns { symbol, priceUSD, source, fetchedAt }.',
        parameters: {
            type: T.OBJECT,
            properties: { symbol: { type: T.STRING, description: 'Ticker symbol (e.g. AAPL, BTCUSDT, HUBC)' } },
            required: ['symbol'],
        },
    },
    {
        name: 'get_current_signal',
        description: 'Full on-screen signal for the symbol the user is currently viewing — confidence, trend regime, indicators, price targets, multi-horizon forecasts. Use when the user asks about the current view OR signal/confidence specifically. Do NOT use this for live price questions — call get_live_price instead, since this returns the price from the last analysis snapshot which can be minutes stale.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'get_calibration',
        description: 'Calibration tables that map raw model confidence to empirical hit rates. Use only when the user asks about calibration accuracy or "is 60% confidence really 60%".',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'get_accuracy_stats',
        description: 'Running engine accuracy: hits, total predictions, hit rate. Use when the user asks how accurate the engine is overall.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'find_similar_setups',
        description: 'Find past predictions in the live ledger with RSI/MACD/BB profiles similar to the current setup, and report the empirical hit rate at each horizon. Powerful grounding tool for any "how often does this kind of setup work" question.',
        parameters: {
            type: T.OBJECT,
            properties: {
                signal: { type: T.STRING, description: 'BUY or SELL — match same-direction predictions' },
                k: { type: T.INTEGER, description: 'Number of nearest neighbors (default 20)' },
                region: { type: T.STRING, description: 'Optional region filter: NYSE, NSE, HKEX, TYO, LSE, DAX, ASX' },
            },
        },
    },
    {
        name: 'explain_prediction',
        description: 'Top features that drove the current signal — which indicators contributed most to the score. Use when the user asks why the engine predicted what it did.',
        parameters: {
            type: T.OBJECT,
            properties: {
                topN: { type: T.INTEGER, description: 'Number of top features to return (default 3, max 8)' },
            },
        },
    },
    {
        name: 'analyze_symbol',
        description: 'Run a full analysis on a specific symbol from scratch (NOT the currently-loaded one). Use when the user names a symbol they want analyzed without changing what is on screen.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING, description: 'Ticker symbol (e.g. AAPL, BTCUSDT)' },
                mode: { type: T.STRING, description: 'stock or crypto' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'compare_symbols',
        description: 'Compare up to 4 symbols side by side — signal, confidence, trend, price.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbols: { type: T.ARRAY, items: { type: T.STRING }, description: 'Array of ticker symbols (max 4)' },
                mode: { type: T.STRING, description: 'stock or crypto' },
            },
            required: ['symbols'],
        },
    },
    {
        name: 'get_hot_picks',
        description: 'Top 20 hot-pick symbols the engine is bullish on right now. Use when the user asks what the engine likes today.',
        parameters: {
            type: T.OBJECT,
            properties: {
                mode: { type: T.STRING, description: 'stock or crypto' },
                timeframe: { type: T.STRING, description: 'today or tomorrow' },
            },
        },
    },
    {
        name: 'get_market_conditions',
        description: 'Macro-market read: F&G index, VIX, S&P trend (or crypto F&G if mode is crypto). Use when the user asks about the broader market mood.',
        parameters: {
            type: T.OBJECT,
            properties: {
                mode: { type: T.STRING, description: 'stock or crypto' },
            },
        },
    },
    {
        name: 'get_news_and_sentiment',
        description: 'Recent headlines for a symbol with FinBERT sentiment scores. Use when the user asks for news on a specific symbol.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING },
                mode: { type: T.STRING, description: 'stock or crypto' },
                companyName: { type: T.STRING, description: 'Optional friendly name to broaden the news search' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'get_macro_series',
        description: 'FRED macroeconomic series. Available: DFF, DGS10, DGS2, T10Y2Y, UNRATE, CPIAUCSL, PCEPILFE, M2SL, WALCL, DCOILWTICO, GOLDAMGBD228NLBM.',
        parameters: {
            type: T.OBJECT,
            properties: {
                series: { type: T.STRING, description: 'FRED series id (e.g. DGS10)' },
                lookbackMonths: { type: T.INTEGER, description: 'How many months back (default 6)' },
            },
            required: ['series'],
        },
    },
    {
        name: 'get_reddit_sentiment',
        description: 'Recent Reddit posts for a symbol with bull/bear lean classification.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'get_sec_filings',
        description: 'Recent SEC EDGAR filings for a symbol.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING },
                limit: { type: T.INTEGER, description: 'Max filings to return (default 5)' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'get_options_view',
        description: 'Options data: PCR, IV skew, ATM IV.',
        parameters: {
            type: T.OBJECT,
            properties: { symbol: { type: T.STRING } },
            required: ['symbol'],
        },
    },
    {
        name: 'get_crypto_derivatives',
        description: 'Crypto derivatives: funding rate + open interest.',
        parameters: {
            type: T.OBJECT,
            properties: { coinId: { type: T.STRING, description: 'CoinGecko id (e.g. bitcoin, ethereum)' } },
            required: ['coinId'],
        },
    },
    {
        name: 'research_symbol',
        description: 'Parallel multi-source research bundle — news, reddit, macro, positioning — all in one call. Prefer this when the user asks for a deep read on a symbol; saves multiple sequential tool calls.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING },
                mode: { type: T.STRING, description: 'stock or crypto' },
                macroSeries: { type: T.STRING, description: 'Optional FRED macro series to include' },
                companyName: { type: T.STRING },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'web_search',
        description: 'Keyless DuckDuckGo web search. Use whenever the user asks for current news, market events, or anything beyond Mia\'s built-in data sources. Returns up to 5 {title, url, domain, snippet}. ALWAYS cite source domains.',
        parameters: {
            type: T.OBJECT,
            properties: {
                query: { type: T.STRING, description: 'Search query' },
                maxResults: { type: T.INTEGER, description: 'Max results (default 5)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'find_spikers',
        description: 'Scan the live universe for intraday spike candidates. Buckets: gte10 (>=10%), 10to20, 20to30, 30to40, 40to50, gt50.',
        parameters: {
            type: T.OBJECT,
            properties: {
                bucket: { type: T.STRING, description: 'Spike bucket' },
                limit: { type: T.INTEGER },
            },
        },
    },
    {
        name: 'get_prediction_log',
        description: 'Recent local prediction history with resolution status (correct/incorrect/pending).',
        parameters: {
            type: T.OBJECT,
            properties: { limit: { type: T.INTEGER } },
        },
    },
    {
        name: 'get_source_accuracy',
        description: 'Rolling per-source hit rate (ai/technical/sentiment/market) over last 30 resolved predictions.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'get_ledger_history',
        description: 'Recent live-ledger predictions and resolved outcomes from the daily cron.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING, description: 'Optional symbol filter' },
                limit: { type: T.INTEGER },
            },
        },
    },
    {
        name: 'get_live_calibration',
        description: 'Empirical hit rates from the live ledger by horizon, signal, and region.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'get_top_losers',
        description: 'Biggest 1-day movers from the live ledger\'s most-recent resolved trading day, scoped to the engine\'s ~530-symbol universe. Use for engine-scope questions; for general market facts (worst stock IN THE WORLD) use web_search instead.',
        parameters: {
            type: T.OBJECT,
            properties: {
                side: { type: T.STRING, description: 'down (worst), up (best), movers (biggest absolute)' },
                limit: { type: T.INTEGER },
                region: { type: T.STRING },
            },
        },
    },
    {
        name: 'compute',
        description: 'Evaluate any arithmetic expression. Use for EVERY computation. Supports + - * / ^ and parentheses. Pass an optional "as" name to store the result for chained computations.',
        parameters: {
            type: T.OBJECT,
            properties: {
                expression: { type: T.STRING, description: 'Math expression (e.g. "974/8.80")' },
                as: { type: T.STRING, description: 'Optional name to store the result for later expressions' },
            },
            required: ['expression'],
        },
    },
    {
        name: 'get_portfolio',
        description: 'Simulated practice portfolio: cash + positions + unrealized P&L. Use when the user asks about their holdings or simulator status.',
        parameters: { type: T.OBJECT, properties: {} },
    },

    // ── Control tools (UI mutations) ────────────────────────────────
    {
        name: 'select_symbol',
        description: 'Load a symbol into the app — switches what is on screen. Use when the user wants to look at a specific ticker (e.g. "show me AAPL", "switch to NVDA").',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING },
                mode: { type: T.STRING, description: 'stock or crypto' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'switch_mode',
        description: 'Switch between stock and crypto tab.',
        parameters: {
            type: T.OBJECT,
            properties: { mode: { type: T.STRING, description: 'stock or crypto' } },
            required: ['mode'],
        },
    },
    {
        name: 'switch_timeframe',
        description: 'Switch the analysis timeframe.',
        parameters: {
            type: T.OBJECT,
            properties: { timeframe: { type: T.STRING, description: 'today or tomorrow' } },
            required: ['timeframe'],
        },
    },
    {
        name: 'cycle_theme',
        description: 'Cycle through the available themes.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'set_theme',
        description: 'Set theme directly: dark, light, aurora.',
        parameters: {
            type: T.OBJECT,
            properties: { theme: { type: T.STRING } },
            required: ['theme'],
        },
    },
    {
        name: 'open_pl_panel',
        description: 'Open the P&L Calculator side panel (its own panel). For running a calculation with numbers, prefer pl_calculate.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'close_pl_panel',
        description: 'Close the P&L Calculator side panel.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'toggle_engine_signals',
        description: 'Toggle the chart Engine Signals mode (our candle chart with past BUY/SELL call markers — green hit / red miss). Pass on:true|false to set explicitly, or omit to flip.',
        parameters: { type: T.OBJECT, properties: { on: { type: T.BOOLEAN } } },
    },
    {
        name: 'open_trade_modal',
        description: 'Open the practice-portfolio Buy/Sell trade ticket for a symbol (requires an instantiated portfolio). Use when the user wants to act on a symbol; place_trade then executes. side defaults to BUY.',
        parameters: {
            type: T.OBJECT,
            properties: { symbol: { type: T.STRING }, side: { type: T.STRING, description: 'BUY or SELL' } },
            required: ['symbol'],
        },
    },
    {
        name: 'refresh_hot_picks',
        description: 'Re-scan the hot picks list.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'rerun_analysis',
        description: 'Re-run the analysis on the currently-loaded symbol.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'set_penny_filter',
        description: 'Filter Hot Picks by penny tier.',
        parameters: {
            type: T.OBJECT,
            properties: { tier: { type: T.STRING, description: 'all, p10 (<$10), p5 (<$5), p1 (<$1)' } },
            required: ['tier'],
        },
    },
    {
        name: 'open_spikers',
        description: 'Open the Spikers panel for intraday spike candidates.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'open_about',
        description: 'Open the About / how-it-works panel.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'open_sector_heatmap',
        description: 'Open the Sector Heatmap and get 5-day relative strength for all 11 sectors. Use for "which sector is hot/leading today" or "where is money rotating". Narrate from the returned trends.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'close_sector_heatmap',
        description: 'Close (collapse) the Sector Heatmap panel. Use when the user asks to close/hide the heatmap.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'open_earnings_calendar',
        description: 'Open the Earnings Calendar and get upcoming large-cap earnings with the engine\'s pre-earnings read. Use for "who reports this week / soon".',
        parameters: {
            type: T.OBJECT,
            properties: { windowDays: { type: T.INTEGER, description: 'Lookback window in days (default 14)' } },
        },
    },
    {
        name: 'close_earnings_calendar',
        description: 'Close (collapse) the Earnings Calendar panel. Use when the user asks to close/hide the earnings calendar.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'toggle_currency',
        description: 'Toggle USD ↔ INR display.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'scroll_to',
        description: 'Scroll to a specific section of the page.',
        parameters: {
            type: T.OBJECT,
            properties: { section: { type: T.STRING, description: 'chart, signal, accuracy, hotpicks, search' } },
            required: ['section'],
        },
    },
    {
        name: 'pl_calculate',
        description: 'Open the P&L calculator and run a calculation.',
        parameters: {
            type: T.OBJECT,
            properties: {
                investment: { type: T.NUMBER },
                buyPrice: { type: T.NUMBER },
                currentPrice: { type: T.NUMBER, description: 'Optional — uses live price if omitted' },
            },
            required: ['investment', 'buyPrice'],
        },
    },
    {
        name: 'focus_search',
        description: 'Scroll to the search box and prefill an optional query. Does NOT auto-pick — use select_symbol when the user names a specific symbol.',
        parameters: {
            type: T.OBJECT,
            properties: { query: { type: T.STRING } },
        },
    },
    {
        name: 'clear_chat',
        description: 'Clear the Mia chat history. Use ONLY when the user explicitly asks to clear the chat.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'copy_to_clipboard',
        description: 'Copy a short snippet to the user\'s clipboard.',
        parameters: {
            type: T.OBJECT,
            properties: { text: { type: T.STRING } },
            required: ['text'],
        },
    },
    {
        name: 'place_trade',
        description: 'Execute a market BUY or SELL on the practice portfolio. Long-only. Confirm with the user before calling — never trade silently.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING },
                side: { type: T.STRING, description: 'BUY or SELL' },
                mode: { type: T.STRING, description: 'amountUSD, units, or all (sell entire position; SELL only)' },
                value: { type: T.NUMBER, description: 'USD amount or unit count, depending on mode' },
            },
            required: ['symbol', 'side', 'mode'],
        },
    },

    // ── Previously text-path-only; mirrored here so VOICE Mia can call
    //    them too (watchlist, alerts, full ledger, resources, deep news).
    {
        name: 'evaluate_news_for_symbol',
        description: 'Deep news read for a symbol: pulls full article text for the top headlines and weights sentiment by source credibility tier. Use when the user wants a thorough "what\'s the news really saying" rather than a quick headline scan.',
        parameters: { type: T.OBJECT, properties: { symbol: { type: T.STRING } }, required: ['symbol'] },
    },
    {
        name: 'open_full_ledger',
        description: 'Open the Full Ledger panel, optionally filtered to a symbol/signal and with an accuracy window. Pass expand:true to open a symbol\'s inline analysis.',
        parameters: {
            type: T.OBJECT,
            properties: {
                symbol: { type: T.STRING }, expand: { type: T.BOOLEAN },
                signal: { type: T.STRING, description: 'BUY, SELL, NEUTRAL, NO_TRADE' },
                accuracyWindow: { type: T.STRING, description: 'e.g. "30 days", "3 months", "1 year", "all"' },
            },
        },
    },
    {
        name: 'close_full_ledger',
        description: 'Close (collapse) the Full Ledger panel. Use when the user asks to close/hide the ledger.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'set_accuracy_window',
        description: 'Set the Full Ledger Prediction-Accuracy time window. Accepts "30 days", "3 months", "1 year", or "all".',
        parameters: { type: T.OBJECT, properties: { window: { type: T.STRING } }, required: ['window'] },
    },
    {
        name: 'open_resources',
        description: 'Open the Resources side panel (glossary / indicator definitions). Pair with a spoken definition.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'close_resources',
        description: 'Close the Resources side panel. Use when the user asks to close/hide Resources or the glossary panel.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'add_to_watchlist',
        description: 'Star a symbol to the watchlist (separate from the practice portfolio). Idempotent.',
        parameters: { type: T.OBJECT, properties: { symbol: { type: T.STRING } }, required: ['symbol'] },
    },
    {
        name: 'remove_from_watchlist',
        description: 'Unstar a symbol from the watchlist. Idempotent.',
        parameters: { type: T.OBJECT, properties: { symbol: { type: T.STRING } }, required: ['symbol'] },
    },
    {
        name: 'set_price_alert',
        description: 'Set a price alert above and/or below thresholds for a symbol (crypto realtime; auto-stars it). Pass nulls to clear. Confirm before setting.',
        parameters: {
            type: T.OBJECT,
            properties: { symbol: { type: T.STRING }, above: { type: T.NUMBER }, below: { type: T.NUMBER } },
            required: ['symbol'],
        },
    },
    {
        name: 'get_watchlist',
        description: 'Read the watchlist + any active price alerts. Use before adding/removing/alerting to recap state.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'close_pl_calculator',
        description: 'Close the P&L calculator agentic stage.',
        parameters: { type: T.OBJECT, properties: {} },
    },

    // ── New surfaces wired this pass (portfolio mgmt, time-travel, regime).
    {
        name: 'open_portfolio_panel',
        description: 'Open the practice-trading portfolio panel (holdings, cash, P&L). Separate from the watchlist.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'close_portfolio_panel',
        description: 'Close the portfolio side panel.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'instantiate_portfolio',
        description: 'Create a fresh practice (paper) portfolio with a starting cash balance. Use for "start me a practice account with $10k". No real money.',
        parameters: {
            type: T.OBJECT,
            properties: { amount: { type: T.NUMBER }, currency: { type: T.STRING, description: 'default USD' } },
            required: ['amount'],
        },
    },
    {
        name: 'add_funds',
        description: 'Add cash to the existing practice portfolio.',
        parameters: {
            type: T.OBJECT,
            properties: { amount: { type: T.NUMBER }, currency: { type: T.STRING, description: 'default USD' } },
            required: ['amount'],
        },
    },
    {
        name: 'reset_portfolio',
        description: 'Wipe the practice portfolio. DESTRUCTIVE — confirm with the user first; never call without explicit confirmation.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'set_time_travel',
        description: 'Time-travel: replay the engine on the currently-loaded symbol as of a past date (YYYY-MM-DD), using only bars available then. Requires a symbol loaded first.',
        parameters: { type: T.OBJECT, properties: { date: { type: T.STRING, description: 'YYYY-MM-DD' } }, required: ['date'] },
    },
    {
        name: 'clear_time_travel',
        description: 'Exit time-travel mode and re-run on live data.',
        parameters: { type: T.OBJECT, properties: {} },
    },
    {
        name: 'get_macro_regime',
        description: 'Read the current macro regime (risk-on / risk-off / transition / neutral) plus VIX, S&P 500, and dollar components. Use for "what\'s the market regime / is it risk-on".',
        parameters: { type: T.OBJECT, properties: {} },
    },
];
