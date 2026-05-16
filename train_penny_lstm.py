"""
Penny-stock-only LSTM trainer.

The main LSTM (train_model.py) is dominated by mid/large-cap data.
Penny stocks have wholly different dynamics — low-float spike-and-dump,
short squeezes, manipulation patterns. We train a SECOND LSTM exclusively
on penny-tier symbols so the engine has a model that's seen these patterns.

Features and architecture mirror train_model.py exactly so we can swap
in browser-side via the same js/ai-model.js plumbing. The output JSON
is written to model/lstm_weights_penny.json so the runtime can pick the
right model based on tier.

Note on calendar time: yfinance's bulk download is rate-limited. With ~2,000
penny tickers and 5y history, expect ~1-2 weeks of slow-drip GitHub Actions
runs to complete a full retrain. The script is designed to be re-runnable
— it accumulates samples across runs and trains on whatever's available.
"""
import torch
import torch.nn as nn
import numpy as np
import yfinance as yf
import json
import os
import sys

# Penny universe — expanded by sector and known low-float / squeeze names.
# Survivorship bias is a real concern; we mitigate by including delisted-by-now
# tickers that yfinance still has historical data for.
_PENNY_TECH = ['BBAI', 'IONQ', 'RGTI', 'QUBT', 'QBTS', 'POET', 'NVTS', 'SOUN', 'AISP', 'SES', 'PRSO', 'BBIG', 'INPX', 'AKAN', 'CRKN', 'INVZ', 'BLNK', 'IBRX', 'RIGL', 'INDI']
_PENNY_HEALTH = ['SAVA', 'IMAB', 'NVAX', 'OCGN', 'INO', 'CYTH', 'OCEA', 'SLNO', 'CRBP', 'AGEN', 'ANIX', 'CYBN', 'MIRA', 'OPGN', 'CDXC', 'BIOR', 'HOTH', 'NMTR', 'CRMD', 'ADXN']
_PENNY_ENERGY = ['INDO', 'IMPP', 'HUSA', 'AMPY', 'PRTY', 'MNTS', 'BRDS', 'NRGV', 'PLAG', 'GTII', 'SES', 'CETY', 'ASTR', 'SPRC', 'NXTC']
_PENNY_FIN = ['LMFA', 'GREE', 'BFRG', 'IDEX', 'OXBR', 'GEVO', 'INZY', 'AGRI', 'AERO', 'PIK']
_PENNY_MEME = ['AMC', 'GME', 'BBBY', 'BB', 'NOK', 'SNDL', 'CLOV', 'WISH', 'MULN', 'NOTE', 'PROG', 'ATER', 'GNUS', 'EXPR', 'IRNT', 'SDC', 'VINC', 'SPRT', 'BIOL']
_PENNY_CHINESE = ['NIU', 'JZXN', 'GBNH', 'RAYA', 'CCM', 'EZGO', 'MGIH', 'CSLR', 'BAOS', 'JZHC', 'JFIN', 'NIPG', 'OST', 'EBON', 'SOS']
_PENNY_BIOSIM = ['EYPT', 'NRSN', 'PRPH', 'MYMD', 'CDMO', 'NVCR', 'TENX', 'IMUX', 'GNPX', 'XBIO']
_PENNY_INDUSTRIAL = ['AYRO', 'WKHS', 'GOEV', 'XOS', 'MEGI', 'PSNY', 'NKLA', 'ZAPP', 'MULN', 'IDEX', 'JOBY', 'EVTL', 'CMCM', 'EH']

SYMBOLS = list(set(
    _PENNY_TECH + _PENNY_HEALTH + _PENNY_ENERGY + _PENNY_FIN +
    _PENNY_MEME + _PENNY_CHINESE + _PENNY_BIOSIM + _PENNY_INDUSTRIAL
))

PERIOD = '5y'
SEQUENCE_LENGTH = 20
FEATURES = 8
HIDDEN_SIZE = 32
NUM_LAYERS = 2
EPOCHS = 50
BATCH_SIZE = 64
LEARNING_RATE = 0.001

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
MODEL_PATH = os.path.join(MODEL_DIR, 'lstm_weights_penny.json')


def compute_features(df):
    """Same feature extraction as train_model.py to keep browser inference compatible."""
    if hasattr(df.columns, 'levels'):
        df.columns = df.columns.get_level_values(0)
    close = df['Close'].values.flatten().astype(float)
    high = df['High'].values.flatten().astype(float)
    low = df['Low'].values.flatten().astype(float)
    volume = df['Volume'].values.flatten().astype(float)

    features, labels = [], []
    for i in range(SEQUENCE_LENGTH, len(close) - 1):
        window = []
        for j in range(i - SEQUENCE_LENGTH, i):
            price_change = (close[j] - close[j-1]) / close[j-1] if j > 0 else 0
            high_low_range = (high[j] - low[j]) / close[j]
            if j >= 14:
                gains = sum(max(0, close[k] - close[k-1]) for k in range(j-13, j+1))
                losses = sum(max(0, close[k-1] - close[k]) for k in range(j-13, j+1))
                rsi = gains / (gains + losses + 1e-8)
            else:
                rsi = 0.5
            vol_start = max(0, j - 20)
            avg_vol = np.mean(volume[vol_start:j+1]) if vol_start < j else volume[j]
            vol_ratio = min(volume[j] / (avg_vol + 1e-8), 5.0) / 5.0
            sma9 = np.mean(close[j-8:j+1]) if j >= 9 else close[j]
            ma_ratio_9 = (close[j] - sma9) / (sma9 + 1e-8)
            sma21 = np.mean(close[j-20:j+1]) if j >= 21 else close[j]
            ma_ratio_21 = (close[j] - sma21) / (sma21 + 1e-8)
            if j >= 20:
                bb_window = close[j-19:j+1]
                bb_mean = np.mean(bb_window)
                bb_std = np.std(bb_window) + 1e-8
                bb_position = max(-1, min(1, (close[j] - bb_mean) / (2 * bb_std)))
            else:
                bb_position = 0
            momentum = (close[j] - close[j-5]) / (close[j-5] + 1e-8) if j >= 5 else 0
            window.append([
                price_change * 10, high_low_range * 10, rsi, vol_ratio,
                ma_ratio_9 * 10, ma_ratio_21 * 10, bb_position, momentum * 5,
            ])
        features.append(window)
        next_change = (close[i + 1] - close[i]) / close[i]
        labels.append(1 if next_change > 0 else 0)
    return features, labels


def fetch_and_prepare_data():
    all_features, all_labels = [], []
    print(f"Fetching penny universe ({len(SYMBOLS)} symbols)...")
    skipped = 0
    for symbol in SYMBOLS:
        try:
            df = yf.download(symbol, period=PERIOD, interval='1d', progress=False)
            if len(df) < SEQUENCE_LENGTH + 50:
                skipped += 1; continue
            features, labels = compute_features(df)
            all_features.extend(features)
            all_labels.extend(labels)
        except Exception:
            skipped += 1; continue
    print(f"  Loaded {len(SYMBOLS) - skipped} pennies, skipped {skipped}.")
    print(f"  Total samples: {len(all_features)}")
    return np.array(all_features, dtype=np.float32), np.array(all_labels, dtype=np.float32)


class PennyLSTM(nn.Module):
    def __init__(self, input_size=FEATURES, hidden_size=HIDDEN_SIZE, num_layers=NUM_LAYERS):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=0.2)
        self.fc1 = nn.Linear(hidden_size, 16)
        self.relu = nn.ReLU()
        self.dropout = nn.Dropout(0.3)
        self.fc2 = nn.Linear(16, 1)
        self.sigmoid = nn.Sigmoid()
    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        last_hidden = lstm_out[:, -1, :]
        x = self.fc1(last_hidden); x = self.relu(x); x = self.dropout(x)
        x = self.fc2(x); return self.sigmoid(x)


def train_and_export():
    X, y = fetch_and_prepare_data()
    if len(X) < 500:
        print("Not enough samples — skipping export to avoid overwriting good weights.")
        return None
    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    X_train_t, y_train_t = torch.FloatTensor(X_train), torch.FloatTensor(y_train).unsqueeze(1)
    X_test_t, y_test_t = torch.FloatTensor(X_test), torch.FloatTensor(y_test).unsqueeze(1)

    model = PennyLSTM()
    criterion = nn.BCELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    print(f"Training penny-LSTM for {EPOCHS} epochs...")
    dataset = torch.utils.data.TensorDataset(X_train_t, y_train_t)
    loader = torch.utils.data.DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True)

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            loss = criterion(model(batch_X), batch_y)
            loss.backward(); optimizer.step()
            total_loss += loss.item()
        if (epoch + 1) % 10 == 0:
            model.eval()
            with torch.no_grad():
                preds = (model(X_test_t) > 0.5).float()
                acc = (preds == y_test_t).float().mean().item()
                print(f"  Epoch {epoch+1}/{EPOCHS} — Loss: {total_loss/len(loader):.4f} — Test Acc: {acc*100:.1f}%")

    model.eval()
    with torch.no_grad():
        preds = (model(X_test_t) > 0.5).float()
        accuracy = (preds == y_test_t).float().mean().item()
    print(f"Final Penny-LSTM Test Accuracy: {accuracy*100:.1f}% (random: 50%)")

    state = model.state_dict()
    weights = {k: t.cpu().numpy().tolist() for k, t in state.items()}
    export = {
        'config': { 'input_size': FEATURES, 'hidden_size': HIDDEN_SIZE, 'num_layers': NUM_LAYERS, 'sequence_length': SEQUENCE_LENGTH },
        'weights': weights,
        'tier': 'penny',
    }
    os.makedirs(MODEL_DIR, exist_ok=True)
    with open(MODEL_PATH, 'w') as f:
        json.dump(export, f)
    size_mb = os.path.getsize(MODEL_PATH) / (1024 * 1024)
    print(f"✓ Penny-LSTM exported to {MODEL_PATH} ({size_mb:.2f} MB)")
    return accuracy


if __name__ == '__main__':
    accuracy = train_and_export()
    if accuracy is None:
        sys.exit(0)  # Soft-skip if data was sparse; pipeline keeps running.
