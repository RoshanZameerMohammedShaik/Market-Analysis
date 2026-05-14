// World market registry. Each market provides:
//   - id, label, flag, locale (for news)
//   - exchangeSuffix that gets appended to symbols when missing
//   - candidatePool: a curated list of liquid large/mid-cap symbols used
//     as the Hot Picks scanner pool when Yahoo's free region screeners
//     are unreliable (which they are for non-US regions over CORS).
//
// We keep the pool focused on liquid names so technicals are meaningful
// and a free 15-min-delayed feed doesn't produce garbage signals on
// thinly-traded micro-caps.

const KEY = 'ma-market';

export const MARKETS = {
    US: {
        id: 'US', label: 'United States', flag: '🇺🇸',
        locale: { gl: 'US', hl: 'en-US' },
        exchangeSuffix: '',
        currency: 'USD',
        candidatePool: null, // null = use Yahoo's existing US screeners
    },
    IN: {
        id: 'IN', label: 'India (NSE)', flag: '🇮🇳',
        locale: { gl: 'IN', hl: 'en-IN' },
        exchangeSuffix: '.NS',
        currency: 'INR',
        candidatePool: [
            // NIFTY 50 + select midcaps; all .NS suffixed. Curated for liquidity.
            'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','HINDUNILVR.NS','ICICIBANK.NS','SBIN.NS','BHARTIARTL.NS','ITC.NS','KOTAKBANK.NS',
            'LT.NS','HCLTECH.NS','AXISBANK.NS','ASIANPAINT.NS','MARUTI.NS','BAJFINANCE.NS','M&M.NS','SUNPHARMA.NS','TITAN.NS','ULTRACEMCO.NS',
            'WIPRO.NS','ADANIENT.NS','ADANIPORTS.NS','NESTLEIND.NS','POWERGRID.NS','NTPC.NS','ONGC.NS','TATAMOTORS.NS','TATASTEEL.NS','JSWSTEEL.NS',
            'BAJAJFINSV.NS','HDFCLIFE.NS','SBILIFE.NS','BAJAJ-AUTO.NS','HEROMOTOCO.NS','EICHERMOT.NS','DIVISLAB.NS','DRREDDY.NS','CIPLA.NS','APOLLOHOSP.NS',
            'BRITANNIA.NS','TATACONSUM.NS','GRASIM.NS','HINDALCO.NS','COALINDIA.NS','BPCL.NS','IOC.NS','TECHM.NS','LTIM.NS','SHRIRAMFIN.NS',
            'DMART.NS','ZOMATO.NS','PAYTM.NS','NYKAA.NS','POLICYBZR.NS','IRCTC.NS','VEDL.NS','PIDILITIND.NS','GODREJCP.NS','SIEMENS.NS',
            'BOSCHLTD.NS','TRENT.NS','LICI.NS','HAVELLS.NS','DABUR.NS','MARICO.NS','BERGEPAINT.NS','PEL.NS','INDUSINDBK.NS','BANDHANBNK.NS',
        ],
    },
    GB: {
        id: 'GB', label: 'UK (LSE)', flag: '🇬🇧',
        locale: { gl: 'GB', hl: 'en-GB' },
        exchangeSuffix: '.L',
        currency: 'GBP',
        candidatePool: [
            // FTSE 100 / 250 large caps
            'AZN.L','SHEL.L','HSBA.L','ULVR.L','BP.L','GSK.L','BATS.L','RIO.L','VOD.L','LLOY.L',
            'BARC.L','REL.L','NG.L','GLEN.L','PRU.L','LSEG.L','DGE.L','TSCO.L','BT-A.L','RKT.L',
            'CRH.L','AAL.L','STAN.L','LGEN.L','III.L','CCH.L','EXPN.L','IMB.L','ANTO.L','SGE.L',
            'BNZL.L','ABF.L','CPG.L','HLN.L','SMIN.L','FRES.L','HLMA.L','SVT.L','UU.L','PSON.L',
        ],
    },
    HK: {
        id: 'HK', label: 'Hong Kong', flag: '🇭🇰',
        locale: { gl: 'HK', hl: 'en' },
        exchangeSuffix: '.HK',
        currency: 'HKD',
        candidatePool: [
            // Hang Seng heavyweights
            '0700.HK','0941.HK','0005.HK','0939.HK','0388.HK','0883.HK','1299.HK','3690.HK','9988.HK','9618.HK',
            '0001.HK','0002.HK','0003.HK','0011.HK','0066.HK','0027.HK','0017.HK','0823.HK','1109.HK','2318.HK',
            '2628.HK','1810.HK','9999.HK','3968.HK','2382.HK','0762.HK','0992.HK','1024.HK','1801.HK','9888.HK',
        ],
    },
    JP: {
        id: 'JP', label: 'Japan (TSE)', flag: '🇯🇵',
        locale: { gl: 'JP', hl: 'en' },
        exchangeSuffix: '.T',
        currency: 'JPY',
        candidatePool: [
            // Nikkei 225 large caps
            '7203.T','6758.T','9984.T','8306.T','6861.T','6098.T','6594.T','7974.T','9433.T','9432.T',
            '8316.T','7267.T','7751.T','6501.T','9434.T','8035.T','6273.T','4063.T','7741.T','6981.T',
            '4502.T','4519.T','4523.T','7011.T','6902.T','6367.T','9501.T','9503.T','9020.T','9101.T',
        ],
    },
    DE: {
        id: 'DE', label: 'Germany (Xetra)', flag: '🇩🇪',
        locale: { gl: 'DE', hl: 'en' },
        exchangeSuffix: '.DE',
        currency: 'EUR',
        candidatePool: [
            // DAX 40
            'SAP.DE','SIE.DE','ALV.DE','AIR.DE','BAS.DE','BAYN.DE','BMW.DE','DAI.DE','DBK.DE','DTE.DE',
            'IFX.DE','MBG.DE','MRK.DE','MUV2.DE','RWE.DE','VOW3.DE','ADS.DE','HEN3.DE','LIN.DE','PUM.DE',
            'EOAN.DE','BEI.DE','CON.DE','FRE.DE','HEI.DE','HFG.DE','MTX.DE','PAH3.DE','SY1.DE','VNA.DE',
        ],
    },
    AU: {
        id: 'AU', label: 'Australia (ASX)', flag: '🇦🇺',
        locale: { gl: 'AU', hl: 'en-AU' },
        exchangeSuffix: '.AX',
        currency: 'AUD',
        candidatePool: [
            // ASX 200 large caps
            'CBA.AX','BHP.AX','CSL.AX','NAB.AX','WBC.AX','ANZ.AX','MQG.AX','TLS.AX','WOW.AX','RIO.AX',
            'WES.AX','WDS.AX','FMG.AX','TCL.AX','ALL.AX','REA.AX','WTC.AX','GMG.AX','XRO.AX','PME.AX',
            'COL.AX','QAN.AX','ORG.AX','S32.AX','NCM.AX','SCG.AX','APA.AX','AMC.AX','CPU.AX','RMD.AX',
        ],
    },
};

export function getMarketId() {
    try { return localStorage.getItem(KEY) || 'US'; } catch (_) { return 'US'; }
}

export function setMarketId(id) {
    if (!MARKETS[id]) return;
    try { localStorage.setItem(KEY, id); } catch (_) {}
    document.dispatchEvent(new CustomEvent('market-change', { detail: { id } }));
}

export function getMarket() {
    return MARKETS[getMarketId()] || MARKETS.US;
}

/** Append the active market's exchange suffix to a symbol if it doesn't already have one. */
export function qualifySymbol(symbol) {
    if (!symbol) return symbol;
    const m = getMarket();
    if (!m.exchangeSuffix) return symbol;
    if (symbol.includes('.')) return symbol; // already qualified (e.g. RELIANCE.NS)
    return symbol + m.exchangeSuffix;
}
