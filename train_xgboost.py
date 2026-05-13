"""
Alternative model: XGBoost on the same 8 engineered features, with
isotonic calibration so predicted probabilities reflect empirical hit rates.

Why this exists alongside the LSTM:
  - With 23 symbols and ~5y of daily bars, the dataset is small. Trees
    typically beat tiny LSTMs in this regime and are much faster to retrain.
  - Calibration is the headline. A raw model's predict_proba is just a
    score, not a probability. After isotonic regression, predict_proba(X)
    actually equals the empirical hit rate at that score level — so the
    UI can say "68% confidence" and it actually means 68% hit rate.

Usage:
    pip install -r requirements.txt
    python train_xgboost.py

Writes:
    model/xgb_model.json        (XGBoost booster + isotonic calibration map)
    model/xgb_metrics.json      (cv accuracy, brier score, calibration curve)
"""
import json
import os
import numpy as np
import yfinance as yf
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import brier_score_loss
from sklearn.model_selection import TimeSeriesSplit

try:
    import xgboost as xgb
except ImportError as e:
    raise SystemExit(
        "xgboost not installed. Run: pip install -r requirements.txt"
    ) from e

from shared_features import compute_flat_features
from train_model import SYMBOLS, PERIOD

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
MODEL_PATH = os.path.join(MODEL_DIR, 'xgb_model.json')
METRICS_PATH = os.path.join(MODEL_DIR, 'xgb_metrics.json')

N_SPLITS = 5


def fetch_dataset():
    all_X, all_y = [], []
    print(f"Fetching {len(SYMBOLS)} symbols...")
    for symbol in SYMBOLS:
        try:
            df = yf.download(symbol, period=PERIOD, interval='1d', progress=False)
            if len(df) < 50:
                print(f"  {symbol}: insufficient data, skipping")
                continue
            X, y = compute_flat_features(df)
            all_X.extend(X)
            all_y.extend(y)
            print(f"  {symbol}: {len(X)} samples")
        except Exception as e:
            print(f"  {symbol}: failed ({e})")
    return np.array(all_X, dtype=np.float32), np.array(all_y, dtype=np.int32)


def calibration_curve(y_true, y_prob, n_bins=10):
    """Return per-bucket (mean predicted prob, mean actual hit rate, count)."""
    bins = np.linspace(0, 1, n_bins + 1)
    out = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        mask = (y_prob >= lo) & (y_prob < hi if i < n_bins - 1 else y_prob <= hi)
        if mask.sum() == 0:
            continue
        out.append({
            'bucket': f"{int(lo * 100)}-{int(hi * 100)}%",
            'mean_predicted': round(float(y_prob[mask].mean()) * 100, 2),
            'mean_actual': round(float(y_true[mask].mean()) * 100, 2),
            'count': int(mask.sum()),
        })
    return out


if __name__ == '__main__':
    os.makedirs(MODEL_DIR, exist_ok=True)

    X, y = fetch_dataset()
    print(f"\nTotal samples: {len(X)}, label balance: {y.mean():.3f}")

    base = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.1,
        reg_lambda=1.0,
        eval_metric='logloss',
        n_jobs=-1,
    )

    # Time-series CV: each fold trains on past, tests on future.
    tscv = TimeSeriesSplit(n_splits=N_SPLITS)
    fold_accs, fold_briers = [], []
    last_model = None
    last_test_X, last_test_y, last_test_prob = None, None, None

    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]

        # CalibratedClassifierCV wraps the base model and applies isotonic
        # regression on top. cv=3 means inside each fold we further split
        # train into 3 sub-folds for calibration fitting.
        clf = CalibratedClassifierCV(base, method='isotonic', cv=3)
        clf.fit(X_train, y_train)

        prob = clf.predict_proba(X_test)[:, 1]
        preds = (prob > 0.5).astype(int)
        acc = float((preds == y_test).mean())
        brier = float(brier_score_loss(y_test, prob))

        print(f"Fold {fold + 1}/{N_SPLITS}: acc={acc * 100:.2f}%, brier={brier:.4f}")
        fold_accs.append(acc)
        fold_briers.append(brier)
        last_model = clf
        last_test_X, last_test_y, last_test_prob = X_test, y_test, prob

    mean_acc = float(np.mean(fold_accs))
    std_acc = float(np.std(fold_accs))
    mean_brier = float(np.mean(fold_briers))
    print(f"\nMean accuracy: {mean_acc * 100:.2f}% ± {std_acc * 100:.2f}%")
    print(f"Mean Brier score: {mean_brier:.4f} (lower is better, 0.25 = random)")

    cal_curve = calibration_curve(last_test_y, last_test_prob)

    # XGBoost trees are not directly portable to JS the way LSTM weights are.
    # We export the model in xgboost's native JSON format and the calibration
    # mapping; the browser fetches both. A pure-JS XGBoost runtime is small.
    booster_json = last_model.calibrated_classifiers_[0].estimator.get_booster().save_raw('json').decode()
    cal_map = []
    for cc in last_model.calibrated_classifiers_:
        # Each calibrator is an _IsotonicCalibrator wrapping IsotonicRegression
        cal = cc.calibrators[0]
        cal_map.append({
            'X_thresholds': cal.X_thresholds_.tolist(),
            'y_thresholds': cal.y_thresholds_.tolist(),
        })

    with open(MODEL_PATH, 'w') as f:
        json.dump({
            'booster': booster_json,
            'calibration': cal_map,
        }, f)

    metrics = {
        'method': 'XGBoost + isotonic calibration',
        'splits': N_SPLITS,
        'fold_accuracies': [round(a * 100, 2) for a in fold_accs],
        'mean_accuracy': round(mean_acc * 100, 2),
        'std_accuracy': round(std_acc * 100, 2),
        'mean_brier': round(mean_brier, 4),
        'brier_random_baseline': 0.25,
        'calibration_curve': cal_curve,
    }
    with open(METRICS_PATH, 'w') as f:
        json.dump(metrics, f, indent=2)

    print(f"\n✓ Exported XGBoost model to {MODEL_PATH}")
    print(f"✓ Metrics written to {METRICS_PATH}")

    print("\nCalibration curve (predicted% → actual%):")
    for row in cal_curve:
        diff = row['mean_actual'] - row['mean_predicted']
        flag = '  ' if abs(diff) < 5 else ' ⚠'
        print(f"  {row['bucket']:>10}: predicted {row['mean_predicted']:>5.1f}% → actual {row['mean_actual']:>5.1f}% (n={row['count']}){flag}")
