"""
Penny-stock universe — Python mirror of js/penny-universe.js.

Used by:
  - ledger_universe.py: ALL_SYMBOLS includes pennies so the daily ledger
    cron records and resolves predictions on these too.
  - train_model.SYMBOLS: pennies feed the main LSTM.
  - train_penny_lstm.py: still keeps its own list for the penny-tier
    sub-model, but defaults to this file when the local list is stale.

If you edit this list, also update js/penny-universe.js — JS is the
source of truth for the runtime, this file is the cron/LSTM mirror.
"""

_TECH_AI = [
    'BBAI', 'IONQ', 'RGTI', 'QUBT', 'QBTS', 'POET', 'NVTS', 'SOUN',
    'AISP', 'SES', 'PRSO', 'BBIG', 'INPX', 'AKAN', 'CRKN', 'INVZ',
    'BLNK', 'IBRX', 'RIGL', 'INDI', 'ARBE', 'OPRA', 'NUKK',
]
_BIOTECH_HEALTH = [
    'SAVA', 'IMAB', 'NVAX', 'OCGN', 'INO', 'CYTH', 'OCEA', 'SLNO',
    'CRBP', 'AGEN', 'ANIX', 'CYBN', 'MIRA', 'OPGN', 'CDXC', 'BIOR',
    'HOTH', 'NMTR', 'CRMD', 'ADXN', 'EYPT', 'NRSN', 'PRPH', 'MYMD',
    'CDMO', 'TENX', 'IMUX', 'GNPX', 'XBIO',
]
_ENERGY_MATERIALS = [
    'INDO', 'IMPP', 'HUSA', 'AMPY', 'NRGV', 'PLAG', 'GTII', 'CETY',
    'ASTR', 'SPRC', 'NXTC', 'GEVO', 'AMPS', 'BTU',
]
_MEME_RETAIL = [
    'AMC', 'GME', 'BBBY', 'BB', 'NOK', 'SNDL', 'CLOV', 'WISH',
    'MULN', 'PROG', 'ATER', 'GNUS', 'EXPR', 'IRNT', 'SDC', 'VINC',
    'SPRT', 'BIOL', 'KOSS', 'NAKD', 'TLRY', 'CGC', 'ACB',
]
_CHINESE_ADRS = [
    'NIU', 'JZXN', 'GBNH', 'CCM', 'EZGO', 'MGIH', 'CSLR', 'BAOS',
    'JZHC', 'JFIN', 'NIPG', 'OST', 'EBON', 'SOS', 'JG', 'CAN',
]
_EV_INDUSTRIAL = [
    'AYRO', 'WKHS', 'GOEV', 'XOS', 'PSNY', 'NKLA', 'ZAPP', 'JOBY',
    'EVTL', 'EH', 'LCID', 'NIO', 'XPEV', 'LI', 'RIVN', 'SOLO',
    'FUV', 'BLNK', 'CHPT', 'PLUG',
]
_CRYPTO_MINING = [
    'MARA', 'RIOT', 'CLSK', 'HUT', 'BTBT', 'BITF', 'CIFR', 'WULF',
    'IREN', 'BTDR', 'CAN', 'EBON', 'GREE',
]
_SUB_DOLLAR = [
    'MULN', 'BBBY', 'NOTE', 'ATER', 'GNUS', 'HOTH', 'BIOR', 'NMTR',
    'IDEX', 'OXBR', 'PIK', 'LMFA',
]

_seen = set()
SYMBOLS = []
for _s in (_TECH_AI + _BIOTECH_HEALTH + _ENERGY_MATERIALS + _MEME_RETAIL
           + _CHINESE_ADRS + _EV_INDUSTRIAL + _CRYPTO_MINING + _SUB_DOLLAR):
    if _s in _seen:
        continue
    _seen.add(_s)
    SYMBOLS.append(_s)


if __name__ == '__main__':
    print(f"Penny universe: {len(SYMBOLS)} symbols")
