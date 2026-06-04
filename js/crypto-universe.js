// Crypto universe — curated stable list of ~300 tokens organized into
// thematic buckets. Hybrid pattern matches js/penny-universe.js: this
// list runs every cron / scan for dense per-symbol track records, and
// hotpicks.js + scanner ALSO pull CoinGecko's /search/trending at
// runtime to catch hot coins not on the curated list.
//
// Format: BASE-USD. Yahoo Finance + Stooq + CoinGecko + Binance all
// accept this format; the engine detects mode='crypto' from the
// caller's flag (not the symbol shape) so this list also feeds the
// scanner's per-symbol full-pipeline run.
//
// Mirrored in crypto_universe.py for the cron + LSTM training. JS is
// the source of truth.
//
// Why curated vs. "just pull all of CoinGecko":
//   - CoinGecko has ~13,000 tokens, most with no liquidity, no
//     historical data, and meme-pump-and-dump dynamics that pollute
//     the LSTM training set.
//   - The curated 300 covers ~95% of what users actually search for
//     (top 100 by mcap + meme leaders + L1/L2/L3 + AI/DePIN/RWA).
//   - Dynamic trending fetch in hotpicks.js fills in the gaps for
//     today's hot coins that aren't curated.

const _MAJORS_TOP30 = [
    'BTC-USD', 'ETH-USD', 'BNB-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD',
    'DOGE-USD', 'AVAX-USD', 'TRX-USD', 'LINK-USD', 'MATIC-USD', 'DOT-USD',
    'LTC-USD', 'BCH-USD', 'NEAR-USD', 'UNI-USD', 'XLM-USD', 'ETC-USD',
    'APT-USD', 'OP-USD', 'ARB-USD', 'FIL-USD', 'ATOM-USD', 'AAVE-USD',
    'MKR-USD', 'INJ-USD', 'LDO-USD', 'IMX-USD', 'GRT-USD', 'EGLD-USD',
];

const _LAYER1S = [
    'TON-USD', 'TIA-USD', 'STX-USD', 'SUI-USD', 'SEI-USD', 'KAS-USD',
    'ALGO-USD', 'HBAR-USD', 'FLOW-USD', 'EOS-USD', 'XTZ-USD', 'NEO-USD',
    'WAVES-USD', 'IOTA-USD', 'ZIL-USD', 'ONE-USD', 'KLAY-USD', 'ICX-USD',
    'QTUM-USD', 'XEM-USD', 'NANO-USD', 'DCR-USD', 'KAVA-USD', 'ROSE-USD',
    'ICP-USD', 'CFX-USD', 'CELO-USD', 'CKB-USD', 'MINA-USD', 'COTI-USD',
];

const _LAYER2S_SCALING = [
    'STRK-USD', 'METIS-USD', 'BOBA-USD', 'MNT-USD', 'BLAST-USD', 'MANTA-USD',
    'ZK-USD', 'POLYX-USD', 'CTSI-USD', 'SKL-USD', 'LRC-USD', 'CELR-USD',
    'OMG-USD', 'IMX-USD', 'GLMR-USD', 'MOVR-USD', 'ASTR-USD', 'ROOT-USD',
];

const _DEFI = [
    'CRV-USD', 'SNX-USD', 'COMP-USD', 'SUSHI-USD', 'YFI-USD', '1INCH-USD',
    'BAL-USD', 'CAKE-USD', 'JOE-USD', 'GMX-USD', 'DYDX-USD', 'RUNE-USD',
    'OSMO-USD', 'PENDLE-USD', 'ENA-USD', 'ETHFI-USD', 'EIGEN-USD', 'JTO-USD',
    'JUP-USD', 'PYTH-USD', 'W-USD', 'ZRO-USD', 'MORPHO-USD', 'RPL-USD',
    'FXS-USD', 'KNC-USD', 'CVX-USD', 'BADGER-USD', 'BNT-USD', 'PERP-USD',
];

const _MEME = [
    'PEPE-USD', 'SHIB-USD', 'BONK-USD', 'WIF-USD', 'FLOKI-USD', 'BRETT-USD',
    'POPCAT-USD', 'MEW-USD', 'BOOK-USD', 'TURBO-USD', 'MOG-USD', 'NEIRO-USD',
    'PNUT-USD', 'GOAT-USD', 'ACT-USD', 'CHILLGUY-USD', 'MOODENG-USD',
    'DOGS-USD', 'NOT-USD', 'HMSTR-USD', 'CATI-USD', 'X-USD', 'PONKE-USD',
    'BABYDOGE-USD', 'LADYS-USD', 'MEME-USD', 'TRUMP-USD', 'MELANIA-USD',
    'FARTCOIN-USD', 'AI16Z-USD', 'GRIFFAIN-USD', 'PIPPIN-USD', 'AIXBT-USD',
];

const _AI_DEPIN = [
    'FET-USD', 'TAO-USD', 'RNDR-USD', 'OCEAN-USD', 'AGIX-USD', 'WLD-USD',
    'IO-USD', 'AKT-USD', 'NMR-USD', 'PHB-USD', 'CTXC-USD', 'AGI-USD',
    'PAAL-USD', 'TURBO-USD', 'AIOZ-USD', 'NOS-USD', 'GENS-USD', 'CGPT-USD',
    'ALI-USD', 'WAI-USD', 'ARKM-USD', 'BICO-USD', 'CUDOS-USD', 'DBR-USD',
    'GRASS-USD', 'GLM-USD', 'HONEY-USD', 'OLAS-USD', 'PRIME-USD',
];

const _GAMING_NFT = [
    'AXS-USD', 'SAND-USD', 'MANA-USD', 'ENJ-USD', 'GALA-USD', 'APE-USD',
    'CHZ-USD', 'FLOW-USD', 'WAX-USD', 'ILV-USD', 'PRIME-USD', 'BEAM-USD',
    'PIXEL-USD', 'PORTAL-USD', 'RON-USD', 'GHST-USD', 'YGG-USD', 'ALICE-USD',
    'TLM-USD', 'SUPER-USD', 'GFAL-USD', 'NXPC-USD', 'XAI-USD', 'BIGTIME-USD',
];

const _RWA_INFRA_PRIVACY = [
    'ONDO-USD', 'POLYX-USD', 'PROPC-USD', 'TRAC-USD', 'CHEX-USD',
    'XMR-USD', 'ZEC-USD', 'DASH-USD', 'SCRT-USD', 'OXT-USD', 'KEEP-USD',
    'NYM-USD', 'ARWEAVE-USD', 'AR-USD', 'STORJ-USD', 'SC-USD', 'BTT-USD',
    'HOT-USD', 'IOTX-USD', 'ANKR-USD', 'API3-USD', 'BAND-USD', 'TRB-USD',
    'CHEEL-USD', 'JASMY-USD', 'CFG-USD', 'OAS-USD',
];

export const CRYPTO_POOL = (() => {
    const all = [
        ..._MAJORS_TOP30, ..._LAYER1S, ..._LAYER2S_SCALING,
        ..._DEFI, ..._MEME, ..._AI_DEPIN,
        ..._GAMING_NFT, ..._RWA_INFRA_PRIVACY,
    ];
    const seen = new Set();
    return all.filter(s => (seen.has(s) ? false : (seen.add(s), true)));
})();
