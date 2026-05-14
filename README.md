# Market Analyzer

**Real-time stock & crypto prediction engine + Mia, your in-app market intelligence analyst.**

Multi-timeframe technicals, FinBERT news sentiment, market context (Fear & Greed / VIX / S&P breadth), a browser-side LSTM, macro regime overlay, sector-relative scoring, and earnings-aware confidence — all blended into a single calibrated BUY / SELL / NEUTRAL signal.

Runs entirely in the browser. No backend, no API keys for the core analyzer. Mia uses either a local LLM in your browser (WebLLM) or your own free Groq / Cloudflare key.

> ⚠️ **Not financial advice.** Predictions are statistical signals, not guarantees. Past performance does not predict future results. Trade at your own risk.

---

## What's different about this one

Most retail prediction tools assert confidence numbers without ever measuring whether they're correct. This repo is built around the opposite premise: **every confidence number shown to a user has been calibrated against backtested historical hit rate**, and the user can see their own running accuracy in the UI.

If the backtest says the 70%-bucket actually hit 62%, the UI shows 62%. The badge next to the confidence (visible in dev mode) tells you whether you're seeing a calibrated number or a raw heuristic. Mia is contractually grounded to that displayed number — she cannot contradict the page.

---

## Feature map

### Signal engine

- **Multi-timeframe technicals** — RSI, MACD, Bollinger Bands, MA crossovers, ADX, MFI, ATR, volume confirmation. Confluence scoring across daily / weekly / 4H.
- **AI model** — LSTM (PyTorch → JSON → pure-JS forward pass) trained on 23 symbols, walk-forward CV reported.
- **News sentiment** — FinBERT (HuggingFace Inference API, no key) with keyword fallback, recency-decayed.
- **Market conditions** — Fear & Greed Index, VIX, S&P 500 trend.
- **Backtester** — Python harness that replays the full pipeline on Yahoo history, computes calibration buckets, Sharpe, drawdown, per-symbol accuracy.
- **Live outcome tracker** — every signal you see is logged in localStorage and resolved against future prices; your personal hit rate displays in the UI (dev mode).

### Accuracy refinements (newly added)

- **Macro regime overlay** — risk-on / risk-off / neutral / transition tag from VIX trajectory + S&P trend + dollar (DXY). Adjusts confidence weighting.
- **Sector-relative scoring** — stock vs. sector ETF (XLK/XLF/XLE/etc.) over the trailing 5 days. Bullish setup in a falling sector → confidence reduced. Bullish setup in a rising sector → confidence boosted.
- **Earnings proximity penalty** — if a stock has earnings within 5 trading days, technicals lose predictiveness; we cap confidence accordingly.
- **Confidence range** — in addition to the point estimate, the engine returns a [low, high] interval based on source dispersion + macro uncertainty + earnings proximity. Surfaced on the signal card when the spread is meaningful.
- **Disagreement penalty** — when AI / Technical / Sentiment / Market sources span more than 25 / 35 / 50 points, confidence is capped by 3 / 7 / 12. High dispersion = real signal of low conviction.

### Mia, the chatbot (v2)

Mia is your in-app market intelligence analyst. She reads the same signal data you see on the page, can call tools to run real analyses, and is contractually grounded to never invent numbers.

**Backends** (you pick at first open; switchable in settings):

- **WebLLM** — runs entirely in your browser using Qwen 2.5 7B (default, ~4.3 GB cached) or Qwen 2.5 14B (Thinking mode, ~8 GB). Private, no signup, no key. Desktop-only (needs WebGPU + 8 GB RAM).
- **API key** — you bring a free Groq or Cloudflare Workers AI key (each ~2-min email signup, no card). Llama 3.3 70B class. Mobile + desktop. Signups happen in a new tab; key is stored locally only.

**Tools she can call** (the agentic part):

- `get_current_signal()` — read the live signal card.
- `analyze_symbol(symbol)` — trigger the full analysis pipeline for any stock.
- `get_hot_picks(mode, timeframe)` — fetch current top 20 picks.
- `get_market_conditions(mode)` — Fear & Greed, VIX, S&P trend.
- `get_calibration_status()` — backtest curve + per-bucket hit rates.
- `compare_symbols(symbols[])` — multi-stock comparison.

**Anti-hallucination**: System prompt forbids inventing numbers; an output post-check flags any unsourced number with a small ⚠ marker.

**Thinking mode**: toggle to invoke a longer chain-of-thought system prompt and (for WebLLM) a 14B model.

**UX**: streaming replies, **Send button morphs into Stop while streaming** (one-click abort), **Clear chat button next to send**, **usage meter pill** showing percentage of free-tier requests/tokens remaining, dismissable did-you-know tips, smart progress messages, markdown rendering.

### Cinematic UI

- App boot animation (header brand rises, gradient mesh fades in)
- Hot picks shimmer skeletons → 3D card flip-in (staggered 80ms apart)
- Chart placeholder with animated radial glow + floating icon + `kbd:/` hint
- Glossary rail cascade-fade
- Floating "Did you know?" chip every 30s with a random tip from a 40-tip pool
- Theme crossfade (200ms across all themed properties)
- Confidence bar overshoot ease, breakdown bars stagger-fill
- Number tween on confidence + prices
- Material-style ripple feedback on every primary button
- Mobile bottom-sheet rubber-band feel for P&L sidebar on collapse
- All animations honour `prefers-reduced-motion`

### Three themes

- Dark (default), Light, Colourful (purple gradient)

### Keyboard shortcuts

- `/` focus search
- `1` / `2` stock / crypto tabs
- `t` / `m` today / tomorrow timeframe
- `r` refresh hot picks
- `?` toggle help dialog

---

## Quick start (browser)

No build step. Open `index.html` in a browser, or serve the directory:

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

The browser inference and analysis run with zero installs. The trainer / backtester are separate.

## Train and backtest (Python)

```bash
pip install -r requirements.txt

# Walk-forward LSTM training with per-symbol accuracy
python train_walkforward.py

# Calibrated XGBoost with TimeSeriesSplit CV
python train_xgboost.py

# Backtest the full signal pipeline (THIS is what unlocks calibrated confidence)
python backtest.py
python backtest.py --symbol AAPL --since 2023-01-01
```

Outputs land in `model/`:

| File | Produced by | Used by browser for |
|---|---|---|
| `lstm_weights.json` | `train_walkforward.py` | LSTM forward pass |
| `metrics.json` | `train_walkforward.py` | per-symbol accuracy display |
| `xgb_model.json` | `train_xgboost.py` | (future) XGBoost JS runtime |
| `xgb_metrics.json` | `train_xgboost.py` | calibration curve display |
| `backtest_results.json` | `backtest.py` | **calibration of live confidence** |

## Architecture

```
Market-Analysis/
├── index.html
├── css/
│   ├── style.css            base + tokens + components
│   ├── extras.css           sparklines, glossary, dev banner, chart placeholder
│   ├── mia.css              Mia panel + bubbles + welcome cards
│   └── cinematic.css        boot, ripples, did-you-know, theme crossfade
├── js/
│   ├── app.js               boot
│   ├── data.js              Yahoo + CoinGecko + CORS-proxy chain
│   ├── analysis.js          indicators + multi-timeframe prediction
│   ├── ai-model.js          LSTM forward pass
│   ├── sentiment.js         FinBERT + keyword fallback (recency-decayed)
│   ├── market.js            Fear&Greed / VIX / S&P breadth
│   ├── news.js              Google News RSS + Yahoo News
│   ├── hotpicks.js          dynamic top-20 scanner
│   ├── confidence.js        4-source blend + calibration + sector + earnings + regime + range
│   ├── calibration.js       maps raw → backtested confidence
│   ├── outcome-tracker.js   localStorage prediction log + resolution
│   ├── regime.js            macro regime tag (VIX + SP500 + DXY)
│   ├── sectors.js           ticker → sector ETF + relative trend
│   ├── earnings.js          Yahoo earnings-date proximity check
│   ├── mia/                 chatbot
│   │   ├── mia.js           panel UI + chat thread
│   │   ├── welcome.js       first-open setup screen
│   │   ├── settings.js      backend choice, API keys, thinking mode
│   │   ├── llm-client.js    dispatcher across backends
│   │   ├── backends/
│   │   │   ├── webllm.js    in-browser Qwen 2.5
│   │   │   ├── api-groq.js  Groq Llama 3.3 70B + rate-limit headers
│   │   │   └── api-cf.js    Cloudflare Workers AI Llama 3.3 70B
│   │   ├── tools.js         tool registry (signal/hotpicks/news/etc.)
│   │   ├── agent.js         tool-use loop
│   │   ├── prompt.js        system prompt + signal context block
│   │   ├── guard.js         anti-hallucination post-check
│   │   ├── markdown.js      tiny safe md renderer
│   │   ├── memory.js        conversation history (localStorage)
│   │   └── usage-meter.js   rate-limit pill
│   └── ui/                  render layer
│       ├── core.js          orchestration, init, runAnalysis
│       ├── state.js, theme.js, search.js, chart.js
│       ├── signal.js, news.js, hotpicks.js
│       ├── reasons.js       humanizers for technical/news
│       ├── accuracy.js      live + backtest accuracy strip
│       ├── pl.js            P&L sidebar
│       ├── format.js        formatters
│       ├── keyboard.js      shortcuts
│       ├── glossary.js      left-rail terminology
│       ├── tips.js          40-tip pool + rotation
│       ├── dyk.js           did-you-know floating chip
│       ├── ripple.js        material-style click ripples
│       ├── sparkline.js     SVG sparklines
│       ├── animate.js       number tween
│       └── about.js         in-app About modal
├── dev/                     /dev path-based dev-mode toggle
├── train_*.py + backtest.py + shared_features.py
├── tools/feature_sync_check.py  CI guard for JS↔Python feature parity
└── .github/workflows/
    ├── refresh-data.yml         daily backtest, monthly LSTM retrain
    └── feature-sync-check.yml   PR check for JS↔Python drift
```

## How calibration actually works

1. `backtest.py` walks every symbol's history, generates a prediction for each bar, and records the actual outcome.
2. It writes a `calibration` array to `model/backtest_results.json`: per 10-point confidence bucket, the average predicted confidence and the average actual hit rate.
3. The browser's `calibration.js` loads that JSON on startup.
4. `confidence.js` produces a raw confidence (heuristic 38–88 score), then passes it through `calibrate()` which looks up the bucket and returns the empirical hit rate instead.
5. The signal card shows a `calibrated` or `raw` badge (dev-only) so users know which one they're seeing.
6. A scheduled GitHub Action runs the backtest daily and commits a fresh JSON, so calibration is always current.

## Dev mode

Visit `/dev` to enable, `/dev/off` to disable. Persists per-browser. Public visitors see a clean signal card; dev mode adds the calibration badge, heuristic→historical delta, accuracy strip, and a top-of-page DEV banner.

## Privacy

- All analysis runs in your browser. Stock data fetched from Yahoo / CoinGecko via free CORS proxies.
- API keys (Groq / Cloudflare) live in your browser's localStorage only. Mia talks to the chosen provider directly — no relay.
- Conversation history persists locally; clearable from Mia's chat header.
- Outcome-tracker logs your shown signals locally so you can compute personal hit-rate.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The single most load-bearing rule: feature extraction in `js/ai-model.js` and `shared_features.py` must stay byte-identical. The CI sync check enforces this.

## License

MIT — see [LICENSE](LICENSE).
