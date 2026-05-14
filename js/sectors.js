// Sector mapping + sector-relative score adjustment.
// Stocks are mapped to one of 11 SPDR sector ETFs. We compare the
// stock's signal to that sector's recent trend; if they align we
// nudge confidence up, if they conflict we nudge it down.

import { fetchWithProxy } from './data.js';

// Coarse mapping by ticker. Covers most large-caps; unknowns get no adjustment.
// Source ETFs: XLK, XLF, XLV, XLY, XLP, XLE, XLI, XLU, XLB, XLRE, XLC.
const SECTOR = {
    // Tech
    AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AMD:'XLK', INTC:'XLK', AVGO:'XLK', ORCL:'XLK', CRM:'XLK', ADBE:'XLK', CSCO:'XLK', QCOM:'XLK', TXN:'XLK', AMAT:'XLK', NOW:'XLK', SNOW:'XLK', PLTR:'XLK', SHOP:'XLK', PANW:'XLK', INTU:'XLK', PYPL:'XLK', SQ:'XLK', ASML:'XLK', SMCI:'XLK', MU:'XLK', LRCX:'XLK', KLAC:'XLK', AAOI:'XLK', BBAI:'XLK', NBIS:'XLK', TSEM:'XLK', ON:'XLK', QS:'XLK', OUST:'XLK',
    // Communication
    META:'XLC', GOOGL:'XLC', GOOG:'XLC', NFLX:'XLC', DIS:'XLC', T:'XLC', VZ:'XLC', TMUS:'XLC', SPOT:'XLC', SNAP:'XLC', PINS:'XLC',
    // Consumer Discretionary
    AMZN:'XLY', TSLA:'XLY', HD:'XLY', NKE:'XLY', MCD:'XLY', SBUX:'XLY', BKNG:'XLY', ABNB:'XLY', LULU:'XLY', RIVN:'XLY', F:'XLY', GM:'XLY', BABA:'XLY', JD:'XLY',
    // Consumer Staples
    WMT:'XLP', COST:'XLP', PG:'XLP', KO:'XLP', PEP:'XLP', MO:'XLP', PM:'XLP', CL:'XLP',
    // Health
    UNH:'XLV', JNJ:'XLV', LLY:'XLV', PFE:'XLV', MRK:'XLV', ABBV:'XLV', TMO:'XLV', ABT:'XLV', DHR:'XLV', BMY:'XLV', AMGN:'XLV', CVS:'XLV',
    // Financials
    JPM:'XLF', BAC:'XLF', WFC:'XLF', GS:'XLF', MS:'XLF', C:'XLF', BLK:'XLF', V:'XLF', MA:'XLF', AXP:'XLF', SCHW:'XLF', SOFI:'XLF', COIN:'XLF', PYPL2:'XLF',
    // Energy
    XOM:'XLE', CVX:'XLE', COP:'XLE', SLB:'XLE', PSX:'XLE', MPC:'XLE', VLO:'XLE', OXY:'XLE', EOG:'XLE', PXD:'XLE', CVE:'XLE', CNQ:'XLE', WTI:'XLE', VG:'XLE', MARA:'XLE',
    // Industrials
    CAT:'XLI', BA:'XLI', UNP:'XLI', UPS:'XLI', HON:'XLI', GE:'XLI', RTX:'XLI', DE:'XLI', LMT:'XLI', NOC:'XLI', MMM:'XLI', KRMN:'XLI',
    // Utilities
    NEE:'XLU', DUK:'XLU', SO:'XLU', AEP:'XLU', SRE:'XLU', D:'XLU', EOSE:'XLU',
    // Materials
    LIN:'XLB', SHW:'XLB', APD:'XLB', FCX:'XLB', NEM:'XLB', FSM:'XLB', EGO:'XLB', HMY:'XLB', CF:'XLB', EMAT:'XLB',
    // Real Estate
    PLD:'XLRE', AMT:'XLRE', CCI:'XLRE', EQIX:'XLRE', PSA:'XLRE', HST:'XLRE',
};

const SECTOR_NAME = {
    XLK: 'Technology',
    XLC: 'Communication Services',
    XLY: 'Consumer Discretionary',
    XLP: 'Consumer Staples',
    XLV: 'Health Care',
    XLF: 'Financials',
    XLE: 'Energy',
    XLI: 'Industrials',
    XLU: 'Utilities',
    XLB: 'Materials',
    XLRE: 'Real Estate',
};

const etfTrendCache = new Map(); // etf -> { pct5d, ts }
const TTL_MS = 10 * 60 * 1000;

async function fetchEtfTrend(etf) {
    const cached = etfTrendCache.get(etf);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached;
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${etf}?range=1mo&interval=1d`;
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
    if (closes.length < 6) return null;
    const pct5d = ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
    const v = { pct5d, ts: Date.now() };
    etfTrendCache.set(etf, v);
    return v;
}

export function symbolSector(symbol) {
    if (!symbol) return null;
    const etf = SECTOR[symbol.toUpperCase()];
    return etf ? { etf, name: SECTOR_NAME[etf] } : null;
}

export async function getSectorAdjustment(symbol, signal) {
    const sec = symbolSector(symbol);
    if (!sec) return { adjust: 0, sector: null };
    try {
        const trend = await fetchEtfTrend(sec.etf);
        if (!trend) return { adjust: 0, sector: sec };
        const sectorRising = trend.pct5d > 1.0;
        const sectorFalling = trend.pct5d < -1.0;
        let adjust = 0;
        if (signal === 'BUY') {
            if (sectorRising) adjust = +3;
            else if (sectorFalling) adjust = -6;
        } else if (signal === 'SELL') {
            if (sectorFalling) adjust = +3;
            else if (sectorRising) adjust = -6;
        }
        return { adjust, sector: { ...sec, pct5d: trend.pct5d, rising: sectorRising, falling: sectorFalling } };
    } catch (_) {
        return { adjust: 0, sector: sec };
    }
}
