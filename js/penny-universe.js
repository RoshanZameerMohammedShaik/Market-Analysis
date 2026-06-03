// Penny-stock universe — symbols Hot Picks / scanner / cron / LSTM all
// learn from. The Hot Picks default scan is biased toward Yahoo's
// liquid-mover screeners, which under-represents pennies because
// (a) screeners weight by absolute volume, (b) Phase 1 ranks by
// log10(volume) which compounds the bias. So we keep a dedicated
// curated penny pool here and run it through a SEPARATE Phase 1
// pass that doesn't penalise low-float names.
//
// Also kept in sync with penny_universe.py — the cron + LSTM use the
// Python copy. JS is the source of truth; if you change this list,
// run `python -c "from penny_universe import SYMBOLS; print(len(SYMBOLS))"`
// to sanity-check the Python mirror.
//
// Buckets (sub-themes) keep the list maintainable; the runtime sees
// one flat de-duped pool.

const _TECH_AI = [
    'BBAI', 'IONQ', 'RGTI', 'QUBT', 'QBTS', 'POET', 'NVTS', 'SOUN',
    'AISP', 'SES', 'PRSO', 'BBIG', 'INPX', 'AKAN', 'CRKN', 'INVZ',
    'BLNK', 'IBRX', 'RIGL', 'INDI', 'ARBE', 'OPRA', 'NUKK',
];
const _BIOTECH_HEALTH = [
    'SAVA', 'IMAB', 'NVAX', 'OCGN', 'INO', 'CYTH', 'OCEA', 'SLNO',
    'CRBP', 'AGEN', 'ANIX', 'CYBN', 'MIRA', 'OPGN', 'CDXC', 'BIOR',
    'HOTH', 'NMTR', 'CRMD', 'ADXN', 'EYPT', 'NRSN', 'PRPH', 'MYMD',
    'CDMO', 'TENX', 'IMUX', 'GNPX', 'XBIO',
];
const _ENERGY_MATERIALS = [
    'INDO', 'IMPP', 'HUSA', 'AMPY', 'NRGV', 'PLAG', 'GTII', 'CETY',
    'ASTR', 'SPRC', 'NXTC', 'GEVO', 'AMPS', 'BTU',
];
const _MEME_RETAIL = [
    'AMC', 'GME', 'BBBY', 'BB', 'NOK', 'SNDL', 'CLOV', 'WISH',
    'MULN', 'PROG', 'ATER', 'GNUS', 'EXPR', 'IRNT', 'SDC', 'VINC',
    'SPRT', 'BIOL', 'KOSS', 'NAKD', 'TLRY', 'CGC', 'ACB',
];
const _CHINESE_ADRS = [
    'NIU', 'JZXN', 'GBNH', 'CCM', 'EZGO', 'MGIH', 'CSLR', 'BAOS',
    'JZHC', 'JFIN', 'NIPG', 'OST', 'EBON', 'SOS', 'JG', 'CAN',
];
const _EV_INDUSTRIAL = [
    'AYRO', 'WKHS', 'GOEV', 'XOS', 'PSNY', 'NKLA', 'ZAPP', 'JOBY',
    'EVTL', 'EH', 'LCID', 'NIO', 'XPEV', 'LI', 'RIVN', 'SOLO',
    'FUV', 'BLNK', 'CHPT', 'PLUG',
];
const _CRYPTO_MINING = [
    'MARA', 'RIOT', 'CLSK', 'HUT', 'BTBT', 'BITF', 'CIFR', 'WULF',
    'IREN', 'BTDR', 'CAN', 'EBON', 'GREE',
];
const _SUB_DOLLAR = [
    'MULN', 'BBBY', 'NOTE', 'ATER', 'GNUS', 'HOTH', 'BIOR', 'NMTR',
    'IDEX', 'OXBR', 'PIK', 'LMFA',
];

export const PENNY_POOL = (() => {
    const all = [
        ..._TECH_AI, ..._BIOTECH_HEALTH, ..._ENERGY_MATERIALS,
        ..._MEME_RETAIL, ..._CHINESE_ADRS, ..._EV_INDUSTRIAL,
        ..._CRYPTO_MINING, ..._SUB_DOLLAR,
    ];
    const seen = new Set();
    return all.filter(s => (seen.has(s) ? false : (seen.add(s), true)));
})();
