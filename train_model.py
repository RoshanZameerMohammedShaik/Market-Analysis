"""
Train a small LSTM model for stock/crypto price direction prediction.
Exports weights as JSON for browser-side inference.
"""
import torch
import torch.nn as nn
import numpy as np
import yfinance as yf
import json
import os


# ─── CONFIG ──────────────────────────────────────────────────────────────────

SYMBOLS = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'AMD',
    'NFLX', 'JPM', 'V', 'BA', 'DIS', 'XOM', 'GS', 'WMT', 'NKE',
    'COIN', 'SQ', 'PLTR', 'SOFI', 'RIVN', 'MARA',
]
PERIOD = '5y'
SEQUENCE_LENGTH = 20  # Look back 20 days
FEATURES = 8  # Number of input features per day
HIDDEN_SIZE = 32
NUM_LAYERS = 2
EPOCHS = 50
BATCH_SIZE = 64
LEARNING_RATE = 0.001


# ─── DATA PREPARATION ────────────────────────────────────────────────────────


def compute_features(df):
    """Compute normalized technical features from OHLCV data."""
    # Flatten multi-index columns if present
    if hasattr(df.columns, 'levels'):
        df.columns = df.columns.get_level_values(0)
    close = df['Close'].values.flatten().astype(float)
    high = df['High'].values.flatten().astype(float)
    low = df['Low'].values.flatten().astype(float)
    volume = df['Volume'].values.flatten().astype(float)

    features = []
    labels = []

    for i in range(SEQUENCE_LENGTH, len(close) - 1):
        window = []
        for j in range(i - SEQUENCE_LENGTH, i):
            # 8 features per day, all normalized
            price_change = (close[j] - close[j-1]) / close[j-1] if j > 0 else 0
            high_low_range = (high[j] - low[j]) / close[j]

            # RSI approximation (14-period)
            if j >= 14:
                gains = sum(max(0, close[k] - close[k-1]) for k in range(j-13, j+1))
                losses = sum(max(0, close[k-1] - close[k]) for k in range(j-13, j+1))
                rsi = gains / (gains + losses + 1e-8)
            else:
                rsi = 0.5

            # Volume ratio vs 20-day average
            vol_start = max(0, j - 20)
            avg_vol = np.mean(volume[vol_start:j+1]) if vol_start < j else volume[j]
            vol_ratio = volume[j] / (avg_vol + 1e-8)
            vol_ratio = min(vol_ratio, 5.0) / 5.0  # Cap at 5x, normalize to 0-1

            # Moving average ratios
            if j >= 9:
                sma9 = np.mean(close[j-8:j+1])
                ma_ratio_9 = (close[j] - sma9) / (sma9 + 1e-8)
            else:
                ma_ratio_9 = 0

            if j >= 21:
                sma21 = np.mean(close[j-20:j+1])
                ma_ratio_21 = (close[j] - sma21) / (sma21 + 1e-8)
            else:
                ma_ratio_21 = 0

            # Bollinger Band position
            if j >= 20:
                bb_window = close[j-19:j+1]
                bb_mean = np.mean(bb_window)
                bb_std = np.std(bb_window) + 1e-8
                bb_position = (close[j] - bb_mean) / (2 * bb_std)
                bb_position = max(-1, min(1, bb_position))
            else:
                bb_position = 0

            # Momentum (5-day rate of change)
            if j >= 5:
                momentum = (close[j] - close[j-5]) / (close[j-5] + 1e-8)
            else:
                momentum = 0

            window.append([
                price_change * 10,  # Scale up small values
                high_low_range * 10,
                rsi,
                vol_ratio,
                ma_ratio_9 * 10,
                ma_ratio_21 * 10,
                bb_position,
                momentum * 5,
            ])

        features.append(window)

        # Label: 1 if price goes up tomorrow, 0 if down
        next_change = (close[i + 1] - close[i]) / close[i]
        labels.append(1 if next_change > 0 else 0)

    return features, labels


def fetch_and_prepare_data():
    """Fetch data for all symbols and prepare training set."""
    all_features = []
    all_labels = []

    print(f"Fetching data for {len(SYMBOLS)} symbols...")

    for symbol in SYMBOLS:
        try:
            df = yf.download(symbol, period=PERIOD, interval='1d', progress=False)
            if len(df) < SEQUENCE_LENGTH + 50:
                print(f"  {symbol}: insufficient data, skipping")
                continue

            features, labels = compute_features(df)
            all_features.extend(features)
            all_labels.extend(labels)
            print(f"  {symbol}: {len(features)} samples")
        except Exception as e:
            print(f"  {symbol}: failed ({e})")

    print(f"\nTotal samples: {len(all_features)}")
    return np.array(all_features, dtype=np.float32), np.array(all_labels, dtype=np.float32)


# ─── MODEL ───────────────────────────────────────────────────────────────────

class PriceLSTM(nn.Module):
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
        last_hidden = lstm_out[:, -1, :]  # Take last timestep
        x = self.fc1(last_hidden)
        x = self.relu(x)
        x = self.dropout(x)
        x = self.fc2(x)
        return self.sigmoid(x)


# ─── TRAINING ────────────────────────────────────────────────────────────────

def train_model():
    # Fetch and prepare data
    X, y = fetch_and_prepare_data()

    # Train/test split (80/20)
    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    # Convert to tensors
    X_train_t = torch.FloatTensor(X_train)
    y_train_t = torch.FloatTensor(y_train).unsqueeze(1)
    X_test_t = torch.FloatTensor(X_test)
    y_test_t = torch.FloatTensor(y_test).unsqueeze(1)

    # Create model
    model = PriceLSTM()
    criterion = nn.BCELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)

    # Training loop
    print(f"\nTraining for {EPOCHS} epochs...")
    dataset = torch.utils.data.TensorDataset(X_train_t, y_train_t)
    loader = torch.utils.data.DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True)

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        if (epoch + 1) % 10 == 0:
            model.eval()
            with torch.no_grad():
                test_outputs = model(X_test_t)
                test_preds = (test_outputs > 0.5).float()
                accuracy = (test_preds == y_test_t).float().mean().item()
                avg_loss = total_loss / len(loader)
                print(f"  Epoch {epoch+1}/{EPOCHS} — Loss: {avg_loss:.4f} — Test Acc: {accuracy*100:.1f}%")

    # Final evaluation
    model.eval()
    with torch.no_grad():
        test_outputs = model(X_test_t)
        test_preds = (test_outputs > 0.5).float()
        accuracy = (test_preds == y_test_t).float().mean().item()

    print(f"\nFinal Test Accuracy: {accuracy*100:.1f}%")
    print("  (Random baseline: 50%)")

    return model, accuracy


# ─── EXPORT TO JSON ──────────────────────────────────────────────────────────

def export_model_to_json(model, filepath):
    """Export model weights as JSON for browser-side inference."""
    state_dict = model.state_dict()

    # Convert all tensors to lists
    weights = {}
    for key, tensor in state_dict.items():
        weights[key] = tensor.cpu().numpy().tolist()

    # Also export model config
    export = {
        'config': {
            'input_size': FEATURES,
            'hidden_size': HIDDEN_SIZE,
            'num_layers': NUM_LAYERS,
            'sequence_length': SEQUENCE_LENGTH,
        },
        'weights': weights,
    }

    with open(filepath, 'w') as f:
        json.dump(export, f)

    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    print(f"✓ Model exported to {filepath} ({size_mb:.2f} MB)")


# ─── MAIN ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    model, accuracy = train_model()

    os.makedirs('./model', exist_ok=True)
    export_model_to_json(model, './model/lstm_weights.json')

    print("\nDone! Model ready for browser deployment.")
    print(f"Accuracy: {accuracy*100:.1f}% (vs 50% random)")
