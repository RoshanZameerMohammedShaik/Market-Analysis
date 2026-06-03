// Penny-stock universe — STABLE list of ~500 curated US-listed
// (NYSE/Nasdaq/AMEX) symbols that the engine tracks every day. The
// stable list provides continuous historical coverage so per-symbol
// track records, ledger calibration, and the LSTM all have dense
// data to learn from.
//
// On TOP of this stable list, hotpicks.js + the cron also pull Yahoo
// screeners at scan time (see js/penny-dynamic.js + penny_dynamic.py)
// to catch pennies that aren't on the stable list but are moving
// today. Dynamic pulls are recorded in the ledger as they appear.
//
// Mirrored in penny_universe.py for the cron + LSTM. JS is the
// source of truth.
//
// Buckets keep the list maintainable; the runtime sees one flat
// de-duped pool. Targets: ~500 listed names; OTC omitted because
// Yahoo data quality on illiquid OTC is poor enough that engine
// enrichments (FINRA, options, news) silently degrade.

const _TECH_AI = [
    'BBAI', 'IONQ', 'RGTI', 'QUBT', 'QBTS', 'POET', 'NVTS', 'SOUN',
    'AISP', 'SES', 'PRSO', 'BBIG', 'INPX', 'AKAN', 'CRKN', 'INVZ',
    'BLNK', 'IBRX', 'RIGL', 'INDI', 'ARBE', 'OPRA', 'NUKK', 'SDST',
    'AILE', 'NCNA', 'MITK', 'CYNGN', 'AMPX', 'AVPT', 'BIRD', 'BKKT',
    'BTM', 'CXAI', 'DUOT', 'DXLG', 'EZFL', 'FFIE', 'GFAI', 'INVE',
    'INSE', 'KSCP', 'LASE', 'LICN', 'LILM', 'LZ', 'MDXG', 'MGNX',
    'MNDR', 'MOGO', 'MSGM', 'NCRA', 'NXTP', 'OUST', 'PHIO', 'PRPL',
    'PRTC', 'PYR', 'QSI', 'RAIL', 'RDW', 'RECT', 'REPL', 'RGC',
];
const _BIOTECH_HEALTH = [
    'SAVA', 'IMAB', 'NVAX', 'OCGN', 'INO', 'CYTH', 'OCEA', 'SLNO',
    'CRBP', 'AGEN', 'ANIX', 'CYBN', 'MIRA', 'OPGN', 'CDXC', 'BIOR',
    'HOTH', 'NMTR', 'CRMD', 'ADXN', 'EYPT', 'NRSN', 'PRPH', 'MYMD',
    'CDMO', 'TENX', 'IMUX', 'GNPX', 'XBIO', 'AAVL', 'ACER', 'ADIL',
    'AEMD', 'AKBA', 'ALDX', 'ALLR', 'ALLO', 'ALPN', 'AMIX', 'ANEB',
    'ANGH', 'APLT', 'APRE', 'ARQT', 'ARTL', 'ASLN', 'ATAI', 'ATHX',
    'ATNF', 'ATOS', 'AUPH', 'AUUD', 'AVTE', 'AVXL', 'BCRX', 'BFRI',
    'BIVI', 'BLPH', 'BNGO', 'BNTC', 'BPTH', 'BRTX', 'BSGM', 'BTAI',
    'BTCY', 'BTTX', 'CABA', 'CADL', 'CASI', 'CBAY', 'CCCC', 'CDTX',
    'CELU', 'CFRX', 'CGEM', 'CHRS', 'CKPT', 'CLOV', 'CMRA', 'CNSP',
    'COCP', 'CORT', 'CPHI', 'CRDF', 'CRDL', 'CRGN', 'CRIS', 'CRMD',
    'CTKB', 'CTMX', 'CTSO', 'CTXR', 'CVKD', 'CVM', 'CYAD', 'CYCC',
    'DARE', 'DRMA', 'DRRX', 'DSGN', 'EBET', 'EDAP', 'EDIT', 'EGRX',
    'ELYM', 'EQX', 'ETON', 'EVAX', 'EVOK', 'FENC', 'FGEN', 'FHTX',
    'FRLN', 'GERN', 'GMAB', 'GNFT', 'GOSS', 'GTBP', 'HEPA', 'HIMX',
    'HOOK', 'HRMY', 'HUMA', 'IBIO', 'ICCC', 'IDYA', 'IFRX', 'IKT',
];
const _ENERGY_MATERIALS = [
    'INDO', 'IMPP', 'HUSA', 'AMPY', 'NRGV', 'PLAG', 'GTII', 'CETY',
    'ASTR', 'SPRC', 'NXTC', 'GEVO', 'AMPS', 'BTU', 'BORR', 'BTRS',
    'CEI', 'CEIX', 'CKX', 'CLPR', 'CPE', 'CPG', 'CRC', 'CRGY',
    'CTRA', 'DEC', 'DKL', 'DMLP', 'DNN', 'EAF', 'EARN', 'EE',
    'EIX', 'ENB', 'EQT', 'ERII', 'ESRT', 'ESTE', 'EXTN', 'FET',
    'FLNC', 'FLNG', 'FOA', 'FRO', 'FTI', 'FTK', 'GLNG', 'GPRE',
    'GRBK', 'HBNC', 'HCC', 'HFFG', 'HMLP', 'HP', 'HPK', 'HUSA',
    'IO', 'IPI', 'KALU', 'KGC', 'KOS', 'LBRT', 'LITE', 'LXFR',
];
const _MEME_RETAIL = [
    'AMC', 'GME', 'BBBY', 'BB', 'NOK', 'SNDL', 'CLOV', 'WISH',
    'MULN', 'PROG', 'ATER', 'GNUS', 'EXPR', 'IRNT', 'SDC', 'VINC',
    'SPRT', 'BIOL', 'KOSS', 'NAKD', 'TLRY', 'CGC', 'ACB', 'APRN',
    'BARK', 'BBQ', 'BIG', 'BKE', 'BLBD', 'BNED', 'BODY', 'BOOT',
    'BOWL', 'BTCM', 'BVS', 'BYND', 'CATO', 'CCO', 'CHWY', 'CIEN',
    'CINF', 'CONN', 'COOK', 'CRON', 'CTOS', 'CURO', 'CVGI', 'CVGW',
    'DBI', 'DDS', 'DFIN', 'DHC', 'DLA', 'DOMA', 'DOOO', 'DRVN',
    'EBAY', 'EE', 'ELF', 'ENS', 'EVI', 'EVTV', 'EXPI', 'FATE',
];
const _CHINESE_ADRS = [
    'NIU', 'JZXN', 'GBNH', 'CCM', 'EZGO', 'MGIH', 'CSLR', 'BAOS',
    'JZHC', 'JFIN', 'NIPG', 'OST', 'EBON', 'SOS', 'JG', 'CAN',
    'AIH', 'AIMD', 'AMTD', 'ANTE', 'ATXG', 'AUTL', 'BEKE', 'BHAT',
    'BIOX', 'BTAI', 'BVS', 'BZ', 'CIH', 'CLPS', 'CNF', 'CNTB',
    'COE', 'CREG', 'DDC', 'DOYU', 'DQ', 'DUO', 'ECX', 'EH',
    'EHTH', 'EJH', 'FAMI', 'FANH', 'FENG', 'FFHL', 'FHN', 'FINV',
];
const _EV_INDUSTRIAL = [
    'AYRO', 'WKHS', 'GOEV', 'XOS', 'PSNY', 'NKLA', 'ZAPP', 'JOBY',
    'EVTL', 'EH', 'LCID', 'NIO', 'XPEV', 'LI', 'RIVN', 'SOLO',
    'FUV', 'BLNK', 'CHPT', 'PLUG', 'ACHR', 'AEVA', 'AMPS', 'ASPI',
    'ATER', 'AUTO', 'AVAV', 'BLDP', 'CLNN', 'DM', 'DRIO', 'ECOR',
    'ELLO', 'EOSE', 'EVGO', 'FCEL', 'FFIE', 'FREY', 'GOEV', 'HYZN',
    'INDI', 'IRBT', 'KORE', 'LCID', 'LION', 'LYFT', 'MAPS', 'NDRA',
    'NU', 'OCFT', 'OUST', 'PHUN', 'PRPL', 'RIDE', 'RKLB', 'ROK',
    'RUM', 'SHCR', 'SPCE', 'SPI', 'TIGR', 'TUYA', 'UEC', 'UMC',
];
const _CRYPTO_MINING = [
    'MARA', 'RIOT', 'CLSK', 'HUT', 'BTBT', 'BITF', 'CIFR', 'WULF',
    'IREN', 'BTDR', 'CAN', 'EBON', 'GREE', 'BTCM', 'BTCS', 'BFRG',
    'CNAN', 'COIN', 'CORZ', 'GLXY', 'HVBT', 'MIGI', 'MOGO', 'OXBR',
    'SDIG', 'SOS', 'STRC',
];
const _SUB_DOLLAR = [
    'MULN', 'BBBY', 'NOTE', 'ATER', 'GNUS', 'HOTH', 'BIOR', 'NMTR',
    'IDEX', 'OXBR', 'PIK', 'LMFA', 'AAGR', 'ABVC', 'AEHL', 'AIH',
    'ALBT', 'AMPE', 'AREB', 'ATIF', 'AUVI', 'AVTX', 'BCDA', 'BEAT',
    'BFRI', 'BFRG', 'BGFV', 'BHAT', 'BIOL', 'BLEU', 'BLIN', 'BTCY',
    'CADL', 'CETX', 'CGTX', 'CINGY', 'CISO', 'CLNN', 'CMRX', 'CNF',
    'CRKN', 'CTRM', 'CYCC', 'DATS', 'EBET', 'ENG', 'FAMI', 'FFIE',
    'GBR', 'GFAI', 'GTH', 'HOLO', 'IBRX', 'IGC', 'IMRA', 'INDP',
    'INM', 'INTZ', 'INVO', 'JZXN', 'KAVL', 'KOSS', 'KZIA', 'LAES',
    'LCFY', 'LGTO', 'LIPO', 'MGRX', 'MPU', 'NAOV', 'NCNA', 'NEPT',
    'NLSP', 'NRBO', 'NUKK', 'NUWE', 'NVIV', 'NVOS', 'OCEA', 'ONCY',
    'ONDS', 'OST', 'PALI', 'PRSO', 'PSTX', 'RAIL', 'RDHL', 'RGC',
    'RIBT', 'RZLT', 'SBFG', 'SCWO', 'SHIP', 'SHPH', 'SLDP', 'SMFL',
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
