"""
XGBoost ensemble companion to the LSTM. Same 8 features, isotonic
calibration, but exports a portable JSON tree format that pure-JS can
traverse — see js/xgb-model.js.

Why bother:
  - Trees often beat tiny LSTMs on small/tabular feature sets.
  - Ensembling LSTM + GBT typically beats either alone.
  - Calibration is the headline. After isotonic regression, predicted
    probabilities reflect empirical hit rates.

Writes:
    model/xgb_trees.json    (portable trees + isotonic calibrators — what JS reads)
    model/xgb_metrics.json  (cv accuracy, brier score, calibration curve)

Does NOT write the legacy xgb_model.json (xgboost-binary booster) anymore;
the browser had no way to read it. xgb_trees.json replaces it.
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
TREES_PATH = os.path.join(MODEL_DIR, 'xgb_trees.json')
METRICS_PATH = os.path.join(MODEL_DIR, 'xgb_metrics.json')

N_SPLITS = 5


def fetch_dataset():
    all_X, all_y = [], []
    print(f"Fetching {len(SYMBOLS)} symbols...")
    skipped = 0
    for symbol in SYMBOLS:
        try:
            df = yf.download(symbol, period=PERIOD, interval='1d', progress=False)
            if len(df) < 50:
                skipped += 1
                continue
            X, y = compute_flat_features(df)
            all_X.extend(X)
            all_y.extend(y)
        except Exception:
            skipped += 1
            continue
    print(f"  Loaded {len(SYMBOLS) - skipped} symbols, skipped {skipped}.")
    return np.array(all_X, dtype=np.float32), np.array(all_y, dtype=np.int32)


def calibration_curve(y_true, y_prob, n_bins=10):
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


def serialize_booster_to_portable_trees(booster):
    """Convert an XGBoost booster to a portable nested-array format.

    Each tree is a flat list of nodes. Internal node:
      {'f': feature_index, 't': threshold, 'l': left_child_idx, 'r': right_child_idx}
    Leaf node:
      {'v': leaf_value}  (raw margin contribution)

    Produced from booster.get_dump(dump_format='json') and then re-indexed
    so JS can do: idx=0; while(node has 'f') idx = X[f] < t ? l : r; return v.
    """
    raw_dump = booster.get_dump(dump_format='json')
    trees = []
    for raw in raw_dump:
        tree = json.loads(raw)
        flat = []
        # BFS so we can map nodeid -> flat index.
        # XGBoost JSON dump uses 'nodeid', 'split' (feat name like 'f3'),
        # 'split_condition', 'yes', 'no', and 'children' (recursive).
        # We'll walk recursively and record positions as we go.
        node_map = {}

        def visit(node):
            if 'leaf' in node:
                idx = len(flat)
                flat.append({'v': float(node['leaf'])})
                node_map[node['nodeid']] = idx
                return idx
            # Internal node — reserve our slot now, fill children later.
            idx = len(flat)
            flat.append(None)  # placeholder
            node_map[node['nodeid']] = idx
            children = node.get('children', [])
            yes_id = node.get('yes')
            no_id = node.get('no')
            yes_node = next((c for c in children if c.get('nodeid') == yes_id), children[0] if children else None)
            no_node = next((c for c in children if c.get('nodeid') == no_id), children[1] if len(children) > 1 else None)
            l_idx = visit(yes_node) if yes_node else -1
            r_idx = visit(no_node) if no_node else -1
            feat = node.get('split', 'f0')
            f_index = int(feat[1:]) if feat.startswith('f') else 0
            flat[idx] = {
                'f': f_index,
                't': float(node.get('split_condition', 0)),
                'l': l_idx,
                'r': r_idx,
            }
            return idx

        visit(tree)
        trees.append(flat)
    return trees


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

    tscv = TimeSeriesSplit(n_splits=N_SPLITS)
    fold_accs, fold_briers = [], []
    last_model = None
    last_test_X, last_test_y, last_test_prob = None, None, None

    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
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

    # Serialize the underlying booster from the last fold's classifier into
    # the portable JSON tree format.
    booster = last_model.calibrated_classifiers_[0].estimator.get_booster()
    portable_trees = serialize_booster_to_portable_trees(booster)

    # Pull base_score (the constant prior added before sum of leaf values).
    booster_cfg = json.loads(booster.save_config())
    base_score_str = booster_cfg.get('learner', {}).get('learner_model_param', {}).get('base_score', '0.5')
    base_score = float(base_score_str)

    # Average isotonic calibrators across folds: each calibrator is a step
    # function defined by X_thresholds_ + y_thresholds_. We export them all
    # and let JS average their outputs at inference time.
    cal_steps = []
    for cc in last_model.calibrated_classifiers_:
        cal = cc.calibrators[0]
        cal_steps.append({
            'X_thresholds': cal.X_thresholds_.tolist(),
            'y_thresholds': cal.y_thresholds_.tolist(),
        })

    out = {
        'method': 'XGBoost portable trees + isotonic calibration',
        'n_features': 8,
        'base_score': base_score,
        'n_trees': len(portable_trees),
        'trees': portable_trees,
        'calibrators': cal_steps,
    }
    with open(TREES_PATH, 'w') as f:
        json.dump(out, f)

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

    print(f"\n✓ Exported {len(portable_trees)} portable trees to {TREES_PATH}")
    size_mb = os.path.getsize(TREES_PATH) / (1024 * 1024)
    print(f"  Tree file size: {size_mb:.2f} MB")
    print(f"✓ Metrics written to {METRICS_PATH}")

    print("\nCalibration curve (predicted% → actual%):")
    for row in cal_curve:
        diff = row['mean_actual'] - row['mean_predicted']
        flag = '  ' if abs(diff) < 5 else ' ⚠'
        print(f"  {row['bucket']:>10}: predicted {row['mean_predicted']:>5.1f}% → actual {row['mean_actual']:>5.1f}% (n={row['count']}){flag}")
