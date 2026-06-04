# Mia tool audit — 2026-06-03

Honest review of every tool wired to Mia's agent loop, what works, what doesn't, and what's missing.

## Currently wired (45 tools)

### Read tools — engine state
- `get_app_state` ✅ working
- `get_live_price` ✅ working
- `get_current_signal` ✅ working
- `get_calibration` ✅ working
- `get_accuracy_stats` ✅ working
- `find_similar_setups` ✅ working
- `explain_prediction` ✅ working
- `get_prediction_log` ✅ working
- `get_source_accuracy` ✅ working
- `get_ledger_history` ✅ working
- `get_live_calibration` ✅ working
- `get_top_losers` ✅ working
- `get_market_conditions` ✅ working
- `get_hot_picks` ✅ working

### Read tools — external sources
- `get_news_and_sentiment` ✅ FinBERT-rated headlines
- `get_macro_series` ✅ FRED 11 indicators
- `get_reddit_sentiment` ✅ working
- `get_sec_filings` ✅ working
- `get_options_view` ✅ PCR + IV skew
- `get_crypto_derivatives` ✅ funding + OI
- `research_symbol` ✅ parallel multi-source bundle
- `web_search` ✅ keyless DuckDuckGo

### Compute / domain tools
- `analyze_symbol` ✅ runs full engine
- `compare_symbols` ✅ side-by-side up to 4
- `compute` ✅ math expression evaluator with named vars
- `find_spikers` ✅ direct (no UI)

### Control tools (UI mutation)
- `select_symbol` ✅ works
- `switch_mode` ✅ stock/crypto tab
- `switch_timeframe` ✅ today/tomorrow
- `cycle_theme` / `set_theme` ✅
- `toggle_pl_calculator` ✅ opens portfolio panel + expands P&L section
- `pl_calculate` ✅ opens panel + fills inputs + calculates ⚠️ MISSING: no follow-up loop (see below)
- `refresh_hot_picks` ✅
- `rerun_analysis` ✅
- `set_penny_filter` ✅ (all/p10/p5/p1)
- `open_spikers` ✅
- `open_about` ✅
- `toggle_currency` ✅
- `scroll_to` ✅ (chart/signal/accuracy/hotpicks/search)
- `focus_search` ✅
- `clear_chat` ✅
- `copy_to_clipboard` ✅

### Portfolio tools
- `get_portfolio` ✅ cash + positions + unrealized P&L
- `place_trade` ✅ market BUY/SELL with confirmation flow

## Missing wirings (audit findings)

### Critical gaps
1. **`open_resources`** — Mia can't open the Resources panel. Useful for "explain RSI" → opens the rail showing the RSI definition.
2. **`open_full_ledger`** — Mia can't expand the Full Ledger panel programmatically.
3. **`expand_ledger_row`** — Mia can't open a specific symbol's analysis drawer in the Full Ledger.
4. **`set_accuracy_window`** — Mia can't set the time-window filter. Would let her answer "how accurate has the engine been on AAPL in the last 30 days?" by setting window to 30d, reading the per-symbol cell, replying.
5. **`add_to_watchlist`** / **`remove_from_watchlist`** — no watchlist control. Users must manually star.
6. **`set_price_alert`** — watchlist supports above/below threshold alerts but Mia can't set them.

### UX gaps in existing tools
1. **`pl_calculate`** runs the calculation but doesn't follow up. Roshan's spec: "respond with profit or loss → ask if user wants to do more → if no, close the calc and return to Mia panel; if yes, run more."
2. **`select_symbol`** loads symbol but doesn't return Mia to focus afterward — user has to manually switch back if Mia chat got pushed.
3. **`refresh_hot_picks`** doesn't say what's new compared to previous scan.

## New tool ideas Roshan asked me to brainstorm

### Conversational flows that span multiple tools
- **"Recommend a portfolio allocation"** — Mia reads top-10 hot picks + user's risk profile (asks if not known) + computes sample allocation. Tool: `suggest_allocation`.
- **"What's the worst 5 symbols today?"** — already covered by `get_top_losers`.
- **"Set me an alert if BTC drops below $60k"** — Mia parses, calls `set_price_alert` with above/below. Already supported by the data layer; just needs the tool.
- **"Compare my portfolio's last 30d performance to the engine"** — read portfolio P&L vs ledger hit rate. New tool: `portfolio_vs_engine_performance`.

### Browser-action / app-control
- **`take_screenshot`** of the current chart card for sharing (clipboard image). Useful when user says "screenshot this and copy".
- **`open_external_link`** in a new tab for news/sec filings/research-bundle URLs. Currently Mia replies with the URL but the user has to click; sometimes friction.
- **`scroll_to_symbol_in_ledger`** — given a ticker, scroll the Full Ledger panel to the row for that symbol.
- **`set_filter_in_ledger`** — apply text + signal filters to the Full Ledger.

### Smart suggestion
- **`smart_default_currency`** — detect user's locale (timezone, currency from Yahoo) and offer to switch. "It looks like you're in India — want to switch display currency to INR?"

## Recommendations priority

**P0 (ship next):**
- Wire `pl_calculate` follow-up conversation loop (Roshan's explicit ask)
- Wire `add_to_watchlist` / `remove_from_watchlist` / `set_price_alert`
- Wire `open_resources`, `open_full_ledger`, `expand_ledger_row`, `set_accuracy_window`

**P1 (after P0 ships):**
- Wire `set_filter_in_ledger`, `scroll_to_symbol_in_ledger`
- Wire `take_screenshot`, `open_external_link`

**P2 (later):**
- `suggest_allocation`
- `portfolio_vs_engine_performance`
- `smart_default_currency`
