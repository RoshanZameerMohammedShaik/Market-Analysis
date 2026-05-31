// Single source of truth for exchange display info.
//
// Two input shapes feed in:
//   - Yahoo suffix from a ticker string (".NS", ".BO", ".L", ".HK", "")
//   - Yahoo's meta.exchangeName code ("NMS", "NYQ", "NSE", "TYO", ...)
//
// Output shape is uniform: { name, country }, where name is the
// recognizable exchange name and country is a short country label
// users actually use ("USA", "India", "UK", "Hong Kong", "Japan").
// fullLabel() composes them as "NSE — India" for the chart header.
//
// Adding a new exchange? One entry here covers chart header, search
// dropdown, and any future surface that wants the same label.

// Yahoo ticker suffix → exchange info.
// Empty suffix means "no suffix on ticker" → US (NASDAQ / NYSE).
const SUFFIX_INFO = {
    '':    { name: 'NASDAQ / NYSE',  country: 'USA' },
    'NS':  { name: 'NSE',            country: 'India' },
    'BO':  { name: 'BSE',            country: 'India' },
    'L':   { name: 'LSE',            country: 'United Kingdom' },
    'IL':  { name: 'LSE',            country: 'United Kingdom' },
    'DE':  { name: 'Xetra',          country: 'Germany' },
    'F':   { name: 'Frankfurt',      country: 'Germany' },
    'PA':  { name: 'Euronext Paris', country: 'France' },
    'AS':  { name: 'Euronext Amsterdam', country: 'Netherlands' },
    'BR':  { name: 'Euronext Brussels',  country: 'Belgium' },
    'LS':  { name: 'Euronext Lisbon',    country: 'Portugal' },
    'MI':  { name: 'Borsa Italiana', country: 'Italy' },
    'MC':  { name: 'BME',            country: 'Spain' },
    'SW':  { name: 'SIX',            country: 'Switzerland' },
    'VX':  { name: 'SIX',            country: 'Switzerland' },
    'CO':  { name: 'Nasdaq Copenhagen',  country: 'Denmark' },
    'HE':  { name: 'Nasdaq Helsinki',    country: 'Finland' },
    'ST':  { name: 'Nasdaq Stockholm',   country: 'Sweden' },
    'OL':  { name: 'Oslo',           country: 'Norway' },
    'IR':  { name: 'Euronext Dublin',country: 'Ireland' },
    'AT':  { name: 'Athens',         country: 'Greece' },
    'IS':  { name: 'BIST',           country: 'Türkiye' },
    'WA':  { name: 'WSE',            country: 'Poland' },
    'PR':  { name: 'PSE',            country: 'Czech Republic' },
    'BU':  { name: 'BSE',            country: 'Hungary' },
    'JO':  { name: 'JSE',            country: 'South Africa' },
    'TA':  { name: 'TASE',           country: 'Israel' },
    'CA':  { name: 'EGX',            country: 'Egypt' },
    'SA':  { name: 'B3',             country: 'Brazil' },
    'BA':  { name: 'BCBA',           country: 'Argentina' },
    'MX':  { name: 'BMV',            country: 'Mexico' },
    'SN':  { name: 'BCS',            country: 'Chile' },
    'TO':  { name: 'TSX',            country: 'Canada' },
    'V':   { name: 'TSXV',           country: 'Canada' },
    'NE':  { name: 'NEO',            country: 'Canada' },
    'CN':  { name: 'CSE',            country: 'Canada' },
    'T':   { name: 'TSE',            country: 'Japan' },
    'HK':  { name: 'HKEX',           country: 'Hong Kong' },
    'SS':  { name: 'SSE',            country: 'China' },
    'SZ':  { name: 'SZSE',           country: 'China' },
    'KS':  { name: 'KRX',            country: 'South Korea' },
    'KQ':  { name: 'KOSDAQ',         country: 'South Korea' },
    'TW':  { name: 'TWSE',           country: 'Taiwan' },
    'TWO': { name: 'TPEx',           country: 'Taiwan' },
    'SI':  { name: 'SGX',            country: 'Singapore' },
    'BK':  { name: 'SET',            country: 'Thailand' },
    'KL':  { name: 'Bursa Malaysia', country: 'Malaysia' },
    'JK':  { name: 'IDX',            country: 'Indonesia' },
    'PS':  { name: 'PSE',            country: 'Philippines' },
    'AX':  { name: 'ASX',            country: 'Australia' },
    'NZ':  { name: 'NZX',            country: 'New Zealand' },
    'SR':  { name: 'Tadawul',        country: 'Saudi Arabia' },
    'AE':  { name: 'ADX/DFM',        country: 'UAE' },
    'QA':  { name: 'QSE',            country: 'Qatar' },
    'KW':  { name: 'Boursa Kuwait',  country: 'Kuwait' },
};

// Yahoo meta.exchangeName code → exchange info. These show up on
// search results that come from Yahoo's autocomplete (where we get a
// code, not a suffix).
const CODE_INFO = {
    NMS: { name: 'NASDAQ', country: 'USA' },
    NGM: { name: 'NASDAQ', country: 'USA' },
    NCM: { name: 'NASDAQ', country: 'USA' },
    NAS: { name: 'NASDAQ', country: 'USA' },
    NYQ: { name: 'NYSE',   country: 'USA' },
    NYS: { name: 'NYSE',   country: 'USA' },
    PCX: { name: 'NYSE Arca', country: 'USA' },
    ASE: { name: 'NYSE American', country: 'USA' },
    BTS: { name: 'Cboe BZX', country: 'USA' },
    BATS: { name: 'Cboe BZX', country: 'USA' },
    OTC: { name: 'OTC', country: 'USA' },
    PNK: { name: 'OTC Pink', country: 'USA' },
    OQB: { name: 'OTCQB', country: 'USA' },
    OQX: { name: 'OTCQX', country: 'USA' },
    LSE: { name: 'LSE', country: 'United Kingdom' },
    LSIN: { name: 'LSE', country: 'United Kingdom' },
    GER: { name: 'Xetra', country: 'Germany' },
    FRA: { name: 'Frankfurt', country: 'Germany' },
    STU: { name: 'Stuttgart', country: 'Germany' },
    PAR: { name: 'Euronext Paris', country: 'France' },
    AMS: { name: 'Euronext Amsterdam', country: 'Netherlands' },
    BRU: { name: 'Euronext Brussels', country: 'Belgium' },
    LIS: { name: 'Euronext Lisbon', country: 'Portugal' },
    SWX: { name: 'SIX', country: 'Switzerland' },
    VTX: { name: 'SIX', country: 'Switzerland' },
    MIL: { name: 'Borsa Italiana', country: 'Italy' },
    MCE: { name: 'BME', country: 'Spain' },
    CPH: { name: 'Nasdaq Copenhagen', country: 'Denmark' },
    HEL: { name: 'Nasdaq Helsinki', country: 'Finland' },
    STO: { name: 'Nasdaq Stockholm', country: 'Sweden' },
    OSL: { name: 'Oslo', country: 'Norway' },
    ISE: { name: 'Euronext Dublin', country: 'Ireland' },
    HKG: { name: 'HKEX', country: 'Hong Kong' },
    HKEX: { name: 'HKEX', country: 'Hong Kong' },
    TYO: { name: 'TSE', country: 'Japan' },
    JPX: { name: 'TSE', country: 'Japan' },
    SHH: { name: 'SSE', country: 'China' },
    SHZ: { name: 'SZSE', country: 'China' },
    NSE: { name: 'NSE', country: 'India' },
    BSE: { name: 'BSE', country: 'India' },
    KSC: { name: 'KRX', country: 'South Korea' },
    KOE: { name: 'KOSDAQ', country: 'South Korea' },
    TPE: { name: 'TWSE', country: 'Taiwan' },
    SES: { name: 'SGX', country: 'Singapore' },
    ASX: { name: 'ASX', country: 'Australia' },
    TOR: { name: 'TSX', country: 'Canada' },
    TSX: { name: 'TSX', country: 'Canada' },
    CNQ: { name: 'CSE', country: 'Canada' },
    BUE: { name: 'BCBA', country: 'Argentina' },
    BVMF: { name: 'B3', country: 'Brazil' },
    SAO: { name: 'B3', country: 'Brazil' },
    MEX: { name: 'BMV', country: 'Mexico' },
    CCC: { name: 'Crypto', country: '' },
    CCY: { name: 'Currency', country: '' },
};

function suffixFromYahooSymbol(symbol) {
    const m = String(symbol || '').toUpperCase().match(/\.([A-Z]{1,3})$/);
    return m ? m[1] : '';
}

/** Lookup exchange info from a Yahoo ticker (e.g. "CORDSCABLE.NS"). */
export function exchangeForSymbol(symbol) {
    return SUFFIX_INFO[suffixFromYahooSymbol(symbol)] || null;
}

/** Lookup exchange info from a Yahoo meta.exchangeName code (e.g. "NMS"). */
export function exchangeForCode(code) {
    if (!code) return null;
    return CODE_INFO[String(code).toUpperCase()] || null;
}

/**
 * Compose the user-facing label.
 * Examples:
 *   fullLabel({ name: 'NSE', country: 'India' })  → "NSE — India"
 *   fullLabel(null)                                → ""
 *   fullLabel({ name: 'Crypto', country: '' })    → "Crypto"
 */
export function fullLabel(info) {
    if (!info?.name) return '';
    return info.country ? `${info.name} — ${info.country}` : info.name;
}

/**
 * Convenience: take a Yahoo ticker and return the full label directly.
 * Used by the chart header where we have the symbol but no exchange code.
 */
export function fullLabelForSymbol(symbol) {
    return fullLabel(exchangeForSymbol(symbol));
}

/**
 * Convenience: take a Yahoo meta.exchangeName code and return the
 * full label. Used by search results where Yahoo gives the code.
 */
export function fullLabelForCode(code) {
    return fullLabel(exchangeForCode(code));
}
