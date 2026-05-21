import { searchStocks, searchCrypto } from '../data.js';
import { state } from './state.js';

let searchTimeout = null;

// Yahoo's exchange codes are cryptic (NMS / NGM / BTS / NYQ / etc).
// Map them to the names a user actually recognizes. Anything we don't
// know, we show as-is rather than fabricate a label.
const EXCHANGE_NAMES = {
    // United States
    NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
    NYQ: 'NYSE', NYS: 'NYSE',
    PCX: 'NYSE Arca', ASE: 'NYSE American',
    BTS: 'Cboe BZX', BATS: 'Cboe BZX',
    OTC: 'OTC', PNK: 'OTC Pink', OBB: 'OTC Bulletin',
    OQB: 'OTCQB', OQX: 'OTCQX',
    // Europe
    LSE: 'LSE', LSIN: 'LSE',
    GER: 'Xetra', FRA: 'Frankfurt', STU: 'Stuttgart',
    PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam',
    BRU: 'Euronext Brussels', LIS: 'Euronext Lisbon',
    SWX: 'SIX Swiss', VTX: 'SIX Swiss',
    MIL: 'Borsa Italiana', MCE: 'BME Spain',
    CPH: 'Nasdaq Copenhagen', HEL: 'Nasdaq Helsinki', STO: 'Nasdaq Stockholm',
    ISE: 'Euronext Dublin', OSL: 'Oslo',
    // Asia / APAC
    HKG: 'HKEX', HKEX: 'HKEX',
    TYO: 'Tokyo', JPX: 'Tokyo',
    SHH: 'Shanghai', SHZ: 'Shenzhen',
    NSE: 'NSE India', BSE: 'BSE India',
    KSC: 'KOSPI', KOE: 'KOSDAQ',
    TPE: 'Taiwan',
    SES: 'SGX Singapore',
    ASX: 'ASX',
    // Americas (non-US)
    TOR: 'TSX', TSX: 'TSX', CNQ: 'CSE',
    BUE: 'Buenos Aires', BVMF: 'B3 Brazil', SAO: 'B3 Brazil',
    MEX: 'BMV Mexico',
    // Crypto / FX
    CCC: 'Crypto', CCY: 'Currency',
};

function prettyExchange(code) {
    if (!code) return '';
    const u = String(code).toUpperCase();
    return EXCHANGE_NAMES[u] || u;
}

export function initSearch(onSelect) {
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = input.value.trim();
        if (query.length < 2) {
            results.classList.remove('visible');
            return;
        }
        searchTimeout = setTimeout(() => performSearch(query, onSelect), 300);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim().length >= 2) {
            results.classList.add('visible');
        }
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.search-container')) results.classList.remove('visible');
    });
}

async function performSearch(query, onSelect) {
    const results = document.getElementById('search-results');
    results.innerHTML = '<div class="loading"><div class="loader"></div></div>';
    results.classList.add('visible');

    try {
        const items = state.mode === 'stock' ? await searchStocks(query) : await searchCrypto(query);
        if (items.length === 0) {
            results.innerHTML = '<div class="empty-state">No results found</div>';
            return;
        }
        results.innerHTML = items.map(item => {
            if (state.mode === 'stock') {
                const exchange = prettyExchange(item.exchange);
                return `<div class="search-result-item" data-symbol="${item.symbol}">
                    <div><span class="result-symbol">${item.symbol}</span> <span class="result-name">${item.name}</span></div>
                    ${exchange ? `<span class="result-name">${exchange}</span>` : ''}
                </div>`;
            }
            return `<div class="search-result-item" data-coinid="${item.id}" data-symbol="${item.symbol}">
                <div><span class="result-symbol">${item.symbol}</span> <span class="result-name">${item.name}</span></div>
            </div>`;
        }).join('');
        results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                results.classList.remove('visible');
                onSelect({
                    mode: state.mode,
                    symbol: el.dataset.symbol,
                    coinId: el.dataset.coinid || null,
                });
            });
        });
    } catch (e) {
        results.innerHTML = `<div class="error-message">Search failed: ${e.message}</div>`;
    }
}

export function updatePlaceholder() {
    const input = document.getElementById('search-input');
    if (!input) return;
    input.placeholder = state.mode === 'stock'
        ? 'Search any global symbol — AAPL, RELIANCE.NS, 0700.HK, 7203.T...'
        : 'Search crypto by name (e.g., Bitcoin, Solana)...';
}
