# Market Analyzer

**Real-time stock & crypto prediction engine** — multi-timeframe technicals, FinBERT news sentiment, market context (Fear & Greed / VIX / S&P breadth), and a browser-side LSTM, blended into a single calibrated BUY/SELL/NEUTRAL signal.

Runs entirely in the browser. No backend, no API keys.

> ⚠️ **Not financial advice.** This tool produces statistical signals, not guarantees. Past performance does not predict future results. Trade at your own risk.

## What's different about this one

Most retail prediction tools assert confidence numbers without ever measuring whether they're correct. This repo is built around the opposite premise: **every confidence number shown to a user has been calibrated against backtested historical hit rate**, and the user can see their own running accuracy in the UI.

If the backtest says the 70%-bucket actually hit 62%, the UI shows 62%. The badge next to the confidence tells you whether you're seeing a calibrated number or a raw heuristic.

## Features

- **Multi-timeframe technicals** — RSI, MACD, Bollinger Bands, MA crossovers, ATR, volume confirmation, with confluence scoring across daily / weekly / 4H
- **AI model** — LSTM (PyTorch → JSON → pure-JS forward pass) trained on 23 symbols, walk-forward CV reported
- **Alternative model** — XGBoost with isotonic calibration; predicted probabilities track empirical hit rate
- **News sentiment** — FinBERT (HuggingFace Inference API, no key) with keyword fallback
- **Market conditions** — Fear & Greed Index, VIX, S&P 500 trend
- **Backtest harness** — replays the signal pipeline on historical data, reports per-signal hit rate, calibration buckets, Sharpe, max drawdown
- **Live outcome tracker** — every signal you see is logged in localStorage and resolved against future prices; your personal hit rate displays in the UI
- **P&L sidebar** — calculate position outcome at any target price
- **3 themes** — dark, light, colourful

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
├── index.html                      Entry HTML, imports js/app.js as a module
├── css/style.css                   Visual system, 3 themes, responsive
├── js/
│   ├── app.js                      Boot — calls ui/core.init on DOMContentLoaded
│   ├── data.js                     Yahoo + CoinGecko fetchers, CORS-proxy chain
│   ├── analysis.js                 Indicators + multi-timeframe prediction
│   ├── ai-model.js                 LSTM forward pass + feature extraction
│   ├── sentiment.js                FinBERT + keyword fallback
│   ├── market.js                   Fear & Greed / VIX / S&P breadth
│   ├── news.js                     Google News RSS + Yahoo News
│   ├── hotpicks.js                 Dynamic top-20 scanner
│   ├── confidence.js               4-source blend + empirical calibration
│   ├── calibration.js              Maps raw → backtested confidence
│   ├── outcome-tracker.js          localStorage prediction log + resolution
│   └── ui/                         Render layer (split from old monolithic ui.js)
│       ├── core.js                 Orchestration, init, runAnalysis
│       ├── state.js                Shared mutable state
│       ├── theme.js, search.js, chart.js
│       ├── signal.js, news.js, hotpicks.js
│       ├── reasons.js              Humanizers for technical/news text
│       ├── accuracy.js             Live + backtest accuracy strip
│       ├── pl.js                   P&L sidebar
│       └── format.js               Number / time formatters
├── train_model.py                  Original LSTM trainer (simple split)
├── train_walkforward.py            Walk-forward CV LSTM — use this in practice
├── train_xgboost.py                Calibrated XGBoost
├── backtest.py                     Replays signal pipeline on Yahoo history
├── shared_features.py              Single source of truth for the 8 features
└── model/                          Generated artifacts (gitignored)
```

## How calibration actually works

1. `backtest.py` walks every symbol's history, generates a prediction for each bar using the current pipeline, and records the actual outcome.
2. It writes a `calibration` array to `model/backtest_results.json`: for each 10-point confidence bucket, the average predicted confidence and the average actual hit rate.
3. The browser's `calibration.js` loads that JSON on startup.
4. When `confidence.js` produces a raw confidence (the heuristic 38–88 score), it passes through `calibrate()` which looks up the bucket and returns the empirical hit rate instead.
5. The signal card shows a `calibrated` or `raw` badge so users always know which one they're seeing.

Without `backtest_results.json` the system falls back to the raw heuristic and surfaces the `raw` badge — honest about what it's showing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The single most important rule: feature extraction logic in `js/ai-model.js` and `shared_features.py` must stay in sync. Any drift silently degrades model accuracy.

## License

MIT — see [LICENSE](LICENSE).
