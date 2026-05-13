"""
Walk-forward (rolling-origin) cross-validation for the LSTM.

Why this matters: a single 80/20 split tells you accuracy on ONE held-out
period. With financial time series that period might be unusually easy or
unusually hard, so the number is unreliable. Walk-forward retrains across
several expanding windows and reports mean +/- std, plus per-symbol
accuracy on the most recent fold so the UI can say "AAPL: 54%" honestly.

Usage:
    pip install -r requirements.txt
    python train_walkforward.py

Writes:
    model/lstm_weights.json   (most recent fold's model, for browser)
    model/metrics.json        (fold-by-fold accuracy + per-symbol accuracy)
"""
import json
import os
import numpy as np
import torch
import torch.nn as nn
import yfinance as yf

from shared_features import (
    SEQUENCE_LENGTH, FEATURES, compute_sequences, compute_features_at, extract_ohlcv,
)
from train_model import PriceLSTM, EPOCHS, BATCH_SIZE, LEARNING_RATE, SYMBOLS, PERIOD

N_FOLDS = 5
MIN_TRAIN_FRACTION = 0.5  # first fold trains on at least 50% of data

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
WEIGHTS_PATH = os.path.join(MODEL_DIR, 'lstm_weights.json')
METRICS_PATH = os.path.join(MODEL_DIR, 'metrics.json')


def fetch_per_symbol():
    """Fetch each symbol independently so we can score per-symbol accuracy later."""
    out = {}
    print(f"Fetching {len(SYMBOLS)} symbols...")
    for symbol in SYMBOLS:
        try:
            df = yf.download(symbol, period=PERIOD, interval='1d', progress=False)
            if len(df) < SEQUENCE_LENGTH + 50:
                print(f"  {symbol}: insufficient data, skipping")
                continue
            features, labels = compute_sequences(df)
            out[symbol] = {
                'X': np.array(features, dtype=np.float32),
                'y': np.array(labels, dtype=np.float32),
                'df': df,
            }
            print(f"  {symbol}: {len(features)} samples")
        except Exception as e:
            print(f"  {symbol}: failed ({e})")
    return out


def train_one_fold(X_train, y_train, X_test, y_test, epochs=EPOCHS):
    model = PriceLSTM()
    criterion = nn.BCELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)

    X_train_t = torch.FloatTensor(X_train)
    y_train_t = torch.FloatTensor(y_train).unsqueeze(1)
    X_test_t = torch.FloatTensor(X_test)
    y_test_t = torch.FloatTensor(y_test).unsqueeze(1)

    dataset = torch.utils.data.TensorDataset(X_train_t, y_train_t)
    loader = torch.utils.data.DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True)

    for _ in range(epochs):
        model.train()
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()

    model.eval()
    with torch.no_grad():
        preds = (model(X_test_t) > 0.5).float()
        acc = (preds == y_test_t).float().mean().item()
    return model, acc


def walk_forward(per_symbol, n_folds=N_FOLDS):
    # Concat all symbols into one chronologically-ordered training pool.
    # Each symbol's samples are already in chronological order; we keep that.
    all_X = np.concatenate([d['X'] for d in per_symbol.values()], axis=0)
    all_y = np.concatenate([d['y'] for d in per_symbol.values()], axis=0)

    n = len(all_X)
    fold_size = int(n * (1 - MIN_TRAIN_FRACTION) / n_folds)
    start_train = int(n * MIN_TRAIN_FRACTION)

    fold_accs = []
    last_model = None
    for f in range(n_folds):
        train_end = start_train + f * fold_size
        test_end = train_end + fold_size
        if test_end > n:
            break

        X_train = all_X[:train_end]
        y_train = all_y[:train_end]
        X_test = all_X[train_end:test_end]
        y_test = all_y[train_end:test_end]

        print(f"\nFold {f + 1}/{n_folds}: train [0:{train_end}] test [{train_end}:{test_end}]")
        model, acc = train_one_fold(X_train, y_train, X_test, y_test)
        print(f"  Fold {f + 1} accuracy: {acc * 100:.2f}%")
        fold_accs.append(acc)
        last_model = model

    mean_acc = float(np.mean(fold_accs))
    std_acc = float(np.std(fold_accs))
    print(f"\nWalk-forward result: {mean_acc * 100:.2f}% ± {std_acc * 100:.2f}% (n={len(fold_accs)} folds)")

    return last_model, fold_accs, mean_acc, std_acc


def per_symbol_accuracy(model, per_symbol):
    """Score the final model on each symbol's tail (last 20% of its samples)."""
    model.eval()
    out = {}
    for symbol, data in per_symbol.items():
        X = data['X']
        y = data['y']
        if len(X) < 20:
            continue
        tail_start = int(len(X) * 0.8)
        X_tail = torch.FloatTensor(X[tail_start:])
        y_tail = torch.FloatTensor(y[tail_start:]).unsqueeze(1)
        with torch.no_grad():
            preds = (model(X_tail) > 0.5).float()
            acc = (preds == y_tail).float().mean().item()
        out[symbol] = {
            'accuracy': round(acc * 100, 2),
            'samples': len(X) - tail_start,
        }
    return out


def export_model(model, path, extra_meta=None):
    state_dict = model.state_dict()
    weights = {key: tensor.cpu().numpy().tolist() for key, tensor in state_dict.items()}
    export = {
        'config': {
            'input_size': FEATURES,
            'hidden_size': model.lstm.hidden_size,
            'num_layers': model.lstm.num_layers,
            'sequence_length': SEQUENCE_LENGTH,
        },
        'weights': weights,
    }
    if extra_meta:
        export['meta'] = extra_meta
    with open(path, 'w') as f:
        json.dump(export, f)
    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"✓ Exported model to {path} ({size_mb:.2f} MB)")


if __name__ == '__main__':
    os.makedirs(MODEL_DIR, exist_ok=True)
    per_symbol = fetch_per_symbol()
    if not per_symbol:
        print("No symbols fetched. Aborting.")
        raise SystemExit(1)

    model, fold_accs, mean_acc, std_acc = walk_forward(per_symbol)
    sym_acc = per_symbol_accuracy(model, per_symbol)

    metrics = {
        'method': 'walk-forward LSTM',
        'folds': N_FOLDS,
        'fold_accuracies': [round(a * 100, 2) for a in fold_accs],
        'mean_accuracy': round(mean_acc * 100, 2),
        'std_accuracy': round(std_acc * 100, 2),
        'baseline_random': 50.0,
        'per_symbol': sym_acc,
    }
    with open(METRICS_PATH, 'w') as f:
        json.dump(metrics, f, indent=2)
    print(f"✓ Metrics written to {METRICS_PATH}")

    export_model(model, WEIGHTS_PATH, extra_meta={
        'walk_forward_accuracy': metrics['mean_accuracy'],
        'walk_forward_std': metrics['std_accuracy'],
        'per_symbol': sym_acc,
    })
