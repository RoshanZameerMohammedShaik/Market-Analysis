"""
Universe of symbols the live ledger tracks. Union of train_model.SYMBOLS
(US + crypto, ~340) and js/markets.GLOBAL_POOL (NSE/LSE/HKEX/Tokyo/DAX/ASX,
~280). Region is derived structurally from the symbol suffix.

Note: we lazy-import train_model.SYMBOLS so this module loads even on
machines without yfinance/torch installed. The fallback list below is
a small representative subset for offline imports/testing only.
"""
try:
    from train_model import SYMBOLS as _US_AND_CRYPTO
except ImportError:
    # Offline fallback (e.g. running on a dev machine without yfinance).
    # The CI runner has yfinance installed and uses the real list.
    _US_AND_CRYPTO = [
        'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
        'BTC-USD', 'ETH-USD', 'SOL-USD',
    ]

# Penny universe — separate file (penny_universe.py) mirrors
# js/penny-universe.js. Pennies are added to ALL_SYMBOLS so the daily
# cron records and resolves predictions on them too. They also feed
# the main LSTM (added to train_model.SYMBOLS in a separate edit).
try:
    from penny_universe import SYMBOLS as _PENNIES
except ImportError:
    _PENNIES = []

# Crypto universe — same hybrid pattern as pennies. crypto_universe.py
# mirrors js/crypto-universe.js (~250 stable curated symbols across
# majors / L1s / L2s / DeFi / meme / AI-DePIN / gaming / RWA-privacy).
# train_model.SYMBOLS already had a 38-coin _CRYPTO list; this adds
# the wider universe so the cron records all of them and the LSTM
# trains on the full set.
try:
    from crypto_universe import SYMBOLS as _CRYPTO_EXTRA
except ImportError:
    _CRYPTO_EXTRA = []

# Mirror of js/markets.GLOBAL_POOL — kept in sync manually since the JS
# file is the authoritative list for the browser.
_GLOBAL_POOL = [
    # India (NSE)
    'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','HINDUNILVR.NS','ICICIBANK.NS','SBIN.NS','BHARTIARTL.NS','ITC.NS','KOTAKBANK.NS',
    'LT.NS','HCLTECH.NS','AXISBANK.NS','ASIANPAINT.NS','MARUTI.NS','BAJFINANCE.NS','M&M.NS','SUNPHARMA.NS','TITAN.NS','ULTRACEMCO.NS',
    'WIPRO.NS','ADANIENT.NS','ADANIPORTS.NS','NESTLEIND.NS','POWERGRID.NS','NTPC.NS','ONGC.NS','TATAMOTORS.NS','TATASTEEL.NS','JSWSTEEL.NS',
    'BAJAJFINSV.NS','HDFCLIFE.NS','SBILIFE.NS','BAJAJ-AUTO.NS','HEROMOTOCO.NS','EICHERMOT.NS','DIVISLAB.NS','DRREDDY.NS','CIPLA.NS','APOLLOHOSP.NS',
    'BRITANNIA.NS','TATACONSUM.NS','GRASIM.NS','HINDALCO.NS','COALINDIA.NS','BPCL.NS','IOC.NS','TECHM.NS','LTIM.NS','SHRIRAMFIN.NS',
    'DMART.NS','ZOMATO.NS','PAYTM.NS','NYKAA.NS','POLICYBZR.NS','IRCTC.NS','VEDL.NS','PIDILITIND.NS','GODREJCP.NS','SIEMENS.NS',
    'BOSCHLTD.NS','TRENT.NS','LICI.NS','HAVELLS.NS','DABUR.NS','MARICO.NS','BERGEPAINT.NS','PEL.NS','INDUSINDBK.NS','BANDHANBNK.NS',
    # UK (LSE)
    'AZN.L','SHEL.L','HSBA.L','ULVR.L','BP.L','GSK.L','BATS.L','RIO.L','VOD.L','LLOY.L',
    'BARC.L','REL.L','NG.L','GLEN.L','PRU.L','LSEG.L','DGE.L','TSCO.L','BT-A.L','RKT.L',
    'CRH.L','AAL.L','STAN.L','LGEN.L','III.L','CCH.L','EXPN.L','IMB.L','ANTO.L','SGE.L',
    'BNZL.L','ABF.L','CPG.L','HLN.L','SMIN.L','FRES.L','HLMA.L','SVT.L','UU.L','PSON.L',
    # Hong Kong
    '0700.HK','0941.HK','0005.HK','0939.HK','0388.HK','0883.HK','1299.HK','3690.HK','9988.HK','9618.HK',
    '0001.HK','0002.HK','0003.HK','0011.HK','0066.HK','0027.HK','0017.HK','0823.HK','1109.HK','2318.HK',
    '2628.HK','1810.HK','9999.HK','3968.HK','2382.HK','0762.HK','0992.HK','1024.HK','1801.HK','9888.HK',
    # Japan
    '7203.T','6758.T','9984.T','8306.T','6861.T','6098.T','6594.T','7974.T','9433.T','9432.T',
    '8316.T','7267.T','7751.T','6501.T','9434.T','8035.T','6273.T','4063.T','7741.T','6981.T',
    '4502.T','4519.T','4523.T','7011.T','6902.T','6367.T','9501.T','9503.T','9020.T','9101.T',
    # Germany
    'SAP.DE','SIE.DE','ALV.DE','AIR.DE','BAS.DE','BAYN.DE','BMW.DE','DAI.DE','DBK.DE','DTE.DE',
    'IFX.DE','MBG.DE','MRK.DE','MUV2.DE','RWE.DE','VOW3.DE','ADS.DE','HEN3.DE','LIN.DE','PUM.DE',
    'EOAN.DE','BEI.DE','CON.DE','FRE.DE','HEI.DE','HFG.DE','MTX.DE','PAH3.DE','SY1.DE','VNA.DE',
    # Australia
    'CBA.AX','BHP.AX','CSL.AX','NAB.AX','WBC.AX','ANZ.AX','MQG.AX','TLS.AX','WOW.AX','RIO.AX',
    'WES.AX','WDS.AX','FMG.AX','TCL.AX','ALL.AX','REA.AX','WTC.AX','GMG.AX','XRO.AX','PME.AX',
    'COL.AX','QAN.AX','ORG.AX','S32.AX','NCM.AX','SCG.AX','APA.AX','AMC.AX','CPU.AX','RMD.AX',
]

# Dedupe across all three sources.
_seen = set()
ALL_SYMBOLS = []
for s in list(_US_AND_CRYPTO) + _GLOBAL_POOL + list(_PENNIES) + list(_CRYPTO_EXTRA):
    if s in _seen:
        continue
    _seen.add(s)
    ALL_SYMBOLS.append(s)


def region_for(symbol: str) -> str:
    """Derive region from symbol structurally (suffix-based)."""
    s = symbol.upper()
    if s.endswith('-USD'):
        return 'CRYPTO'
    if s.endswith('.NS'):
        return 'NSE'
    if s.endswith('.L') or s.endswith('.LON'):
        return 'LSE'
    if s.endswith('.HK'):
        return 'HKEX'
    if s.endswith('.T'):
        return 'TYO'
    if s.endswith('.DE'):
        return 'XETRA'
    if s.endswith('.AX'):
        return 'ASX'
    return 'NYSE'  # default for unsuffixed


def symbols_for_region(region: str):
    return [s for s in ALL_SYMBOLS if region_for(s) == region]


REGIONS = ['NYSE', 'CRYPTO', 'NSE', 'LSE', 'HKEX', 'TYO', 'XETRA', 'ASX']

# Forward windows (in trading days) at which we resolve outcomes.
HORIZONS_DAYS = [1, 3, 5, 10, 20]


if __name__ == '__main__':
    counts = {r: len(symbols_for_region(r)) for r in REGIONS}
    print(f"Total symbols: {len(ALL_SYMBOLS)}")
    for r, n in counts.items():
        print(f"  {r:<7} {n}")
