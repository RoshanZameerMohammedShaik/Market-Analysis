"""
Train a small LSTM for next-bar direction prediction and export weights
as JSON for browser-side inference (js/ai-model.js).

Feature extraction here is duplicated in js/ai-model.js — they MUST stay
in sync. If you change anything in compute_features(), mirror the change
in computeFeatures() in js/ai-model.js or predictions will silently drift.

Phase 1: SYMBOLS expanded from 23 hand-picked to ~530 across S&P 500,
Nasdaq 100, sector representatives, and top crypto. Symbols that fail
to fetch are skipped silently — the trainer is tolerant of dead tickers.
"""
import torch
import torch.nn as nn
import numpy as np
import yfinance as yf
import json
import os

# Single source of truth for feature math + counts. train_model used to
# hand-roll its own copy; now it delegates so the LSTM, XGBoost,
# backtest, and JS runtime can't drift apart.
from shared_features import compute_sequences, robust_download, FEATURES as SHARED_FEATURES, SEQUENCE_LENGTH as SHARED_SEQLEN


# ─── CONFIG ────────────────────────────────────────────────────────────────────

# Mega-cap tech (also helps the model learn growth-cycle patterns).
_MEGA_TECH = [
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'AVGO',
    'ORCL', 'CRM', 'ADBE', 'AMD', 'INTC', 'QCOM', 'CSCO', 'TXN', 'INTU',
    'NOW', 'ASML', 'AMAT', 'LRCX', 'MU', 'KLAC', 'SNPS', 'CDNS', 'PANW',
    'CRWD', 'PLTR', 'SHOP', 'NET', 'SNOW', 'DDOG', 'WDAY', 'ANET', 'SMCI',
    'TEAM', 'MDB', 'OKTA', 'TWLO',
]
_COMM = [
    'NFLX', 'DIS', 'CMCSA', 'TMUS', 'T', 'VZ', 'CHTR', 'EA', 'TTWO', 'WBD',
    'ROKU', 'PINS', 'SNAP', 'SPOT', 'MTCH', 'PARA',
]
_FIN = [
    'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'AXP', 'V', 'MA',
    'PYPL', 'COIN', 'SOFI', 'HOOD', 'COF', 'USB', 'PNC', 'TFC', 'BK', 'STT',
    'AON', 'AIG', 'PRU', 'MET', 'ALL', 'PGR', 'TRV', 'CME', 'ICE', 'NDAQ',
    'SPGI', 'MCO', 'MSCI', 'FIS', 'FISV',
]
_HEALTH = [
    'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'BMY',
    'AMGN', 'GILD', 'CVS', 'CI', 'HUM', 'ELV', 'ISRG', 'VRTX', 'REGN',
    'BIIB', 'MRNA', 'ZTS', 'IDXX', 'IQV', 'A', 'BSX', 'SYK', 'MDT', 'EW',
    'BDX', 'BAX', 'HCA',
]
_DISCRETIONARY = [
    'HD', 'NKE', 'MCD', 'SBUX', 'BKNG', 'ABNB', 'LULU', 'F', 'GM', 'RIVN',
    'LCID', 'TGT', 'LOW', 'TJX', 'ROST', 'YUM', 'CMG', 'DG', 'DLTR', 'BBY',
    'AZO', 'ORLY', 'EXPE', 'MAR', 'HLT', 'RCL', 'CCL', 'NCLH', 'DRI',
    'ULTA', 'ETSY', 'EBAY',
]
_STAPLES = [
    'WMT', 'COST', 'PG', 'KO', 'PEP', 'MO', 'PM', 'CL', 'KMB', 'GIS',
    'STZ', 'KHC', 'MNST', 'KDP', 'EL', 'CLX', 'CHD', 'SYY', 'KR',
]
_ENERGY = [
    'XOM', 'CVX', 'COP', 'SLB', 'PSX', 'MPC', 'VLO', 'OXY', 'EOG', 'PXD',
    'WMB', 'KMI', 'OKE', 'BKR', 'HAL', 'HES', 'DVN', 'FANG',
]
_INDUSTRIAL = [
    'CAT', 'BA', 'UNP', 'UPS', 'FDX', 'HON', 'GE', 'RTX', 'DE', 'LMT',
    'NOC', 'GD', 'MMM', 'CSX', 'NSC', 'ETN', 'EMR', 'PH', 'ITW', 'TT',
    'ROK', 'AME', 'FAST', 'WM', 'RSG',
]
_UTILITIES = [
    'NEE', 'DUK', 'SO', 'AEP', 'SRE', 'D', 'PCG', 'EXC', 'XEL', 'PEG',
    'WEC', 'ED', 'EIX', 'ETR', 'AEE', 'ATO', 'CMS', 'DTE',
]
_MATERIALS = [
    'LIN', 'SHW', 'APD', 'FCX', 'NEM', 'CTVA', 'DOW', 'DD', 'NUE', 'STLD',
    'ECL', 'ALB', 'PPG', 'IFF', 'VMC', 'MLM', 'CF', 'MOS',
]
_REAL_ESTATE = [
    'PLD', 'AMT', 'CCI', 'EQIX', 'PSA', 'SPG', 'O', 'WELL', 'AVB', 'EQR',
    'ARE', 'VICI', 'EXR', 'DLR', 'CBRE', 'IRM',
]
# Hot retail / momentum names traders care about; valuable for the
# distribution this model learns.
_RETAIL_FAVS = [
    'GME', 'AMC', 'BBBY', 'BB', 'PLUG', 'NIO', 'XPEV', 'LI', 'BABA', 'JD',
    'PDD', 'BIDU', 'NTES', 'BILI', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BTBT',
    'WULF', 'IREN', 'BTDR', 'GLBE', 'AFRM', 'UPST', 'OPEN', 'WBA', 'KSS',
    'M', 'JWN', 'LYFT', 'UBER', 'DASH', 'INST', 'BIRD', 'CVNA',
]
_CRYPTO = [
    'BTC-USD', 'ETH-USD', 'BNB-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD',
    'DOGE-USD', 'AVAX-USD', 'TRX-USD', 'LINK-USD', 'MATIC-USD', 'DOT-USD',
    'LTC-USD', 'BCH-USD', 'NEAR-USD', 'UNI-USD', 'XLM-USD', 'ETC-USD',
    'APT-USD', 'OP-USD', 'ARB-USD', 'FIL-USD', 'ATOM-USD', 'AAVE-USD',
    'MKR-USD', 'INJ-USD', 'LDO-USD', 'IMX-USD', 'GRT-USD', 'EGLD-USD',
    'TIA-USD', 'STX-USD', 'SUI-USD', 'SEI-USD', 'PEPE-USD', 'SHIB-USD',
    'WLD-USD', 'TON-USD',
]

# Penny tier — same list as penny_universe.SYMBOLS (which mirrors
# js/penny-universe.js). Optional import: if penny_universe.py isn't
# present locally (older checkout), the main LSTM still trains, just
# without the penny dynamics. The penny-tier LSTM (train_penny_lstm.py)
# remains a separate model regardless.
try:
    from penny_universe import SYMBOLS as _PENNIES
except ImportError:
    _PENNIES = []

# Wider crypto universe — js/crypto-universe.js mirror. The local
# _CRYPTO list above (38 majors) stays for back-compat; the wider
# pool unions on top so the LSTM trains on meme / L2 / AI / DeFi
# coins too.
try:
    from crypto_universe import SYMBOLS as _CRYPTO_EXTRA
except ImportError:
    _CRYPTO_EXTRA = []

SYMBOLS = (
    _MEGA_TECH + _COMM + _FIN + _HEALTH + _DISCRETIONARY + _STAPLES +
    _ENERGY + _INDUSTRIAL + _UTILITIES + _MATERIALS + _REAL_ESTATE +
    _RETAIL_FAVS + _CRYPTO + list(_PENNIES) + list(_CRYPTO_EXTRA)
)
# Dedupe preserving order.
seen = set()
SYMBOLS = [s for s in SYMBOLS if not (s in seen or seen.add(s))]

PERIOD = '5y'
SEQUENCE_LENGTH = SHARED_SEQLEN   # 20 — from shared_features
FEATURES = SHARED_FEATURES        # 11 — from shared_features (was hard-coded 8)
HIDDEN_SIZE = 32
NUM_LAYERS = 2
EPOCHS = 50
BATCH_SIZE = 64
LEARNING_RATE = 0.001

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'model')
MODEL_PATH = os.path.join(MODEL_DIR, 'lstm_weights.json')


# ─── DATA PREPARATION ─────────────────────────────────────────────────────


def compute_features(df):
    """Compute (sequence, label) pairs. Delegates to shared_features so
    there's ONE source of truth for the feature math — this used to be
    a hand-copied duplicate that drifted from shared_features.py and
    js/ai-model.js. Now all three reference the same 11-feature
    definition (8 original + ADX + MFI + ATR%)."""
    return compute_sequences(df, SEQUENCE_LENGTH)


def fetch_and_prepare_data():
    """Fetch data for all symbols and prepare training set."""
    all_features = []
    all_labels = []

    print(f"Fetching data for {len(SYMBOLS)} symbols...")

    skipped = 0
    for symbol in SYMBOLS:
        try:
            df = robust_download(symbol, period=PERIOD, interval='1d')
            if df is None or len(df) < SEQUENCE_LENGTH + 50:
                skipped += 1
                continue

            features, labels = compute_features(df)
            all_features.extend(features)
            all_labels.extend(labels)
        except Exception as e:
            skipped += 1
            continue

    print(f"  Loaded {len(SYMBOLS) - skipped} symbols, skipped {skipped}.")
    print(f"\nTotal samples: {len(all_features)}")
    return np.array(all_features, dtype=np.float32), np.array(all_labels, dtype=np.float32)


# ─── MODEL ───────────────────────────────────────────────────────────────────────

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
        last_hidden = lstm_out[:, -1, :]
        x = self.fc1(last_hidden)
        x = self.relu(x)
        x = self.dropout(x)
        x = self.fc2(x)
        return self.sigmoid(x)


# ─── TRAINING ──────────────────────────────────────────────────────────────────

def train_model():
    X, y = fetch_and_prepare_data()

    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    X_train_t = torch.FloatTensor(X_train)
    y_train_t = torch.FloatTensor(y_train).unsqueeze(1)
    X_test_t = torch.FloatTensor(X_test)
    y_test_t = torch.FloatTensor(y_test).unsqueeze(1)

    model = PriceLSTM()
    criterion = nn.BCELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)

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

    model.eval()
    with torch.no_grad():
        test_outputs = model(X_test_t)
        test_preds = (test_outputs > 0.5).float()
        accuracy = (test_preds == y_test_t).float().mean().item()

    print(f"\nFinal Test Accuracy: {accuracy*100:.1f}%")
    print("  (Random baseline: 50%)")

    return model, accuracy


# ─── EXPORT TO JSON ────────────────────────────────────────────────────────────────────

def export_model_to_json(model, filepath):
    """Export model weights as JSON for browser-side inference."""
    state_dict = model.state_dict()

    weights = {}
    for key, tensor in state_dict.items():
        weights[key] = tensor.cpu().numpy().tolist()

    export = {
        'config': {
            'input_size': FEATURES,
            'features': FEATURES,   # explicit — JS reads cfg.features to size its input
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


# ─── MAIN ─────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    model, accuracy = train_model()

    os.makedirs(MODEL_DIR, exist_ok=True)
    export_model_to_json(model, MODEL_PATH)

    print("\nDone! Model ready for browser deployment.")
    print(f"Accuracy: {accuracy*100:.1f}% (vs 50% random)")
