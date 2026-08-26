"""
Train an INTRADAY (1-hour candle) LSTM for next-bar direction.

Why a separate model: the main LSTM trains on DAILY bars, so its
next-bar label is "tomorrow's daily move". But the app's "Today"
timeframe is a within-the-session call — a horizon the daily model was
never trained for. A model trained on 1h candles predicts the next 1h
move, which is the right granularity for the Today tab. This is the
single biggest accuracy mismatch we can close on the short horizon.

Reuses everything from train_model.py (PriceLSTM, the symbol universe,
the shared 11-feature extractor) — ONLY the data interval changes from
'1d' to '1h'. Feature math is identical and timeframe-agnostic, so the
same shared_features pipeline and the same browser inference path work
unchanged; the browser just loads a different weights file and feeds it
1h candles.

Writes:
    model/lstm_weights_intraday.json   (browser-side inference)
    model/metrics_intraday.json        (held-out accuracy)

VERSION SAFETY: like the penny model, the browser only USES this file
for the Today horizon when it exists AND declares a matching feature
count. If the file is absent (first run before the cron populates it),
the engine transparently falls back to the daily LSTM for Today — no
regression, just unrealized upside until the file lands.
"""
import json
import os

import numpy as np
import torch
import torch.nn as nn
import yfinance as yf

from shared_features import SEQUENCE_LENGTH, FEATURES, LOOKBACK, compute_sequences, robust_download
from train_model import PriceLSTM, SYMBOLS, EPOCHS, BATCH_SIZE, LEARNING_RATE

# Yahoo caps 1h history at ~730 calendar days. Stay just under it.
INTRADAY_PERIOD = '720d'
INTRADAY_INTERVAL = '1h'
# 1h bars are far more numerous per symbol than daily, so a smaller
# universe still yields a large sample. We keep the full SYMBOLS list
# but tolerate the heavier per-symbol fetch; dead/illiquid tickers are
# skipped silently as in the daily trainer.
MIN_BARS = SEQUENCE_LENGTH + LOOKBACK + 50

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
WEIGHTS_PATH = os.path.join(MODEL_DIR, 'lstm_weights_intraday.json')
METRICS_PATH = os.path.join(MODEL_DIR, 'metrics_intraday.json')


def fetch_and_prepare():
    all_features, all_labels = [], []
    print(f"Fetching 1h data for {len(SYMBOLS)} symbols (period={INTRADAY_PERIOD})...")
    skipped = 0
    for symbol in SYMBOLS:
        try:
            df = robust_download(symbol, period=INTRADAY_PERIOD, interval=INTRADAY_INTERVAL)
            if df is None or len(df) < MIN_BARS:
                skipped += 1
                continue
            features, labels = compute_sequences(df, SEQUENCE_LENGTH)
            all_features.extend(features)
            all_labels.extend(labels)
        except Exception:
            skipped += 1
            continue
    print(f"  Loaded {len(SYMBOLS) - skipped} symbols, skipped {skipped}.")
    print(f"  Total 1h samples: {len(all_features)}")
    return np.array(all_features, dtype=np.float32), np.array(all_labels, dtype=np.float32)


def train():
    X, y = fetch_and_prepare()
    if len(X) < 500:
        print("Not enough intraday samples to train a reliable model. Aborting.")
        raise SystemExit(1)

    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    X_train_t = torch.FloatTensor(X_train)
    y_train_t = torch.FloatTensor(y_train).unsqueeze(1)
    X_test_t = torch.FloatTensor(X_test)
    y_test_t = torch.FloatTensor(y_test).unsqueeze(1)

    model = PriceLSTM()  # same architecture + 11-feature input as the daily model
    criterion = nn.BCELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)

    dataset = torch.utils.data.TensorDataset(X_train_t, y_train_t)
    loader = torch.utils.data.DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True)

    print(f"\nTraining intraday LSTM for {EPOCHS} epochs...")
    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0.0
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            out = model(batch_X)
            loss = criterion(out, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        if (epoch + 1) % 10 == 0:
            model.eval()
            with torch.no_grad():
                preds = (model(X_test_t) > 0.5).float()
                acc = (preds == y_test_t).float().mean().item()
            print(f"  Epoch {epoch+1}/{EPOCHS} — loss {total_loss/len(loader):.4f} — test acc {acc*100:.1f}%")

    model.eval()
    with torch.no_grad():
        preds = (model(X_test_t) > 0.5).float()
        acc = (preds == y_test_t).float().mean().item()
    print(f"\nFinal intraday test accuracy: {acc*100:.1f}% (random baseline 50%)")
    return model, acc


def export_model(model, path, accuracy):
    state_dict = model.state_dict()
    weights = {k: t.cpu().numpy().tolist() for k, t in state_dict.items()}
    export = {
        'config': {
            'input_size': FEATURES,
            'features': FEATURES,
            'hidden_size': model.lstm.hidden_size,
            'num_layers': model.lstm.num_layers,
            'sequence_length': SEQUENCE_LENGTH,
            'interval': INTRADAY_INTERVAL,   # marks this as the intraday model
            'horizon': 'today',
        },
        'weights': weights,
        'meta': {'test_accuracy': round(accuracy * 100, 2)},
    }
    with open(path, 'w') as f:
        json.dump(export, f)
    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"✓ Exported intraday model to {path} ({size_mb:.2f} MB)")


if __name__ == '__main__':
    os.makedirs(MODEL_DIR, exist_ok=True)
    model, acc = train()
    export_model(model, WEIGHTS_PATH, acc)
    with open(METRICS_PATH, 'w') as f:
        json.dump({'method': '1h-candle LSTM', 'test_accuracy': round(acc * 100, 2),
                   # baseline_random removed: see train_walkforward.py. An unbalanced label
                   # makes 50% the wrong bar, and the majority class is the right one.
                   'baseline_note': 'compare against the majority-class rate, not 50%; see tools/skill_report.py',
                   'interval': INTRADAY_INTERVAL}, f, indent=2)
    print(f"✓ Metrics written to {METRICS_PATH}")
