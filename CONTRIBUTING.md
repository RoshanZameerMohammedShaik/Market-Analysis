# Contributing

Thanks for considering a contribution. This file documents the rules that aren't obvious from reading code.

## The one rule that matters most

**Feature extraction must stay in sync between `js/ai-model.js` and `shared_features.py` (and indirectly `train_model.py`).**

If you change anything in `computeFeatures()` on the JS side, mirror the change in `compute_features_at()` on the Python side. If you change one and not the other:

- The browser sees a different feature distribution at inference than the LSTM learned at training
- Predictions degrade silently (no error, just worse accuracy)
- Nobody notices for weeks

This happened once already — the volume_ratio drift fixed in the `cipher/quality-and-accuracy` branch was exactly this kind of bug.

If you touch features:

1. Run `python backtest.py --symbol AAPL` before and after — the per-bucket hit rates should not collapse
2. Add a comment in both files referencing each other
3. If the feature is new, retrain (`python train_walkforward.py`) and ship the updated `lstm_weights.json` together with the code change

## Local development

```bash
# Browser — no install needed
python -m http.server 8000

# Python tooling
pip install -r requirements.txt
python backtest.py             # ~2-5 min on full symbol set
python train_walkforward.py    # ~10-30 min depending on hardware
python train_xgboost.py        # ~1-3 min
```

## Code style

- JS: ES modules, no build step, no TypeScript. Keep modules small and focused; the old monolithic `ui.js` is gone for a reason.
- Python: standard library + the deps in `requirements.txt`. No new heavy deps without a clear reason.
- No tests yet — if you add a tricky module, add a test alongside it.

## What we want vs. don't want

**Want:**
- More indicators (with backtest evidence they help, not just "it's a real indicator")
- More data sources for sentiment / market context
- Better calibration (e.g., per-symbol or per-regime calibration buckets)
- A pure-JS XGBoost runtime so the alternative model can run in the browser
- A walk-forward backtest mode in `backtest.py`

**Don't want:**
- A backend / server (this is intentionally a static site)
- API keys for paid services in core paths (optional upgrades are fine)
- Removing the calibration / risk-disclaimer / live-tracker UI; those are load-bearing for the project's identity

## Reporting issues

If a prediction looks obviously wrong, please include:
- Symbol and timestamp
- Screenshot of the signal card (so the calibration badge is visible)
- What the actual price did afterwards (so we can verify the outcome tracker recorded correctly)
