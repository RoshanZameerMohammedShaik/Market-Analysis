// Regression gate for the 2026-09-28 audit. Each block pins one bug that shipped silently, with a
// negative case so the check cannot pass by returning a constant.
//
//   node tools/audit_fixes_check.mjs            offline only
//   node tools/audit_fixes_check.mjs --network  also hits Yahoo and Kraken (crypto bars)
import { mentionsCompany, coreCompanyName } from '../js/news.js';
import { sampleVelocity } from '../js/social-velocity.js';
import { analyzeNewsSentiment } from '../js/sentiment.js';
import { escapeHtml, safeHttpUrl } from '../js/ui/escape.js';
import { generateNewsImpact } from '../js/ui/reasons.js';
import { forwardDates } from '../js/forecast-band.js';
import { coinNamesAgree } from '../js/data.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

console.log('\n=== news relevance: "Apple" is Apple Inc. ===');
// Every AAPL headline failed the old filter, which wanted the literal "apple inc." or "AAPL".
check('legal form stripped', coreCompanyName('Apple Inc.') === 'Apple', coreCompanyName('Apple Inc.'));
check('multi-part legal form stripped', coreCompanyName('Credo Technology Group Holding Ltd') === 'Credo Technology');
check('headline naming the company passes',
    mentionsCompany("Opinion: Apple’s “Gangster Move” to Boost iPhone Sales", { symbol: 'AAPL', name: 'Apple Inc.' }));
check('macro headline tagged to the ticker does not pass',
    !mentionsCompany('Stocks fall, squeezed by rising oil prices and Treasury yields', { symbol: 'AAPL', name: 'Apple Inc.' }));
check('whole words only (Pineapple is not Apple)',
    !mentionsCompany('Pineapple prices jump', { symbol: 'AAPL', name: 'Apple Inc.' }));
check('short tickers must be capitals ("on" is not ON)',
    !mentionsCompany('Stocks rally on jobs data', { symbol: 'ON', name: 'ON Semiconductor Corporation' })
    && mentionsCompany('ON Semiconductor beats estimates', { symbol: 'ON', name: 'ON Semiconductor Corporation' }));
check('first word only when the source tagged the ticker',
    mentionsCompany('Credo shares jump 9%', { symbol: 'CRDO', name: 'Credo Technology Group Holding Ltd', allowFirstWord: true })
    && !mentionsCompany('Credo shares jump 9%', { symbol: 'CRDO', name: 'Credo Technology Group Holding Ltd' }));

console.log('\n=== headline scoring sees inflected words ===');
{
    const now = new Date();
    const r = await analyzeNewsSentiment([
        { title: 'Shares plunged after the company downgraded its outlook', date: now },
    ], { bulkScan: true });
    check('"plunged" + "downgraded" score negative', r.items[0].sentiment.label === 'negative', JSON.stringify(r.items[0].sentiment));
    const r2 = await analyzeNewsSentiment([{ title: 'Company rallies as analysts upgrade the stock', date: now }], { bulkScan: true });
    check('"rallies" + "upgrade" score positive', r2.items[0].sentiment.label === 'positive', JSON.stringify(r2.items[0].sentiment));
    check('sentiment no longer claims FinBERT', !/finbert/i.test(JSON.stringify(r.reasons)) && r.method.startsWith('keyword'));
}

console.log('\n=== news impact text matches whole words ===');
check('"software" is not a war story', !/Geopolitical/.test(generateNewsImpact('Nvidia software sales grow', 'neutral', 'NVDA')));
check('"executive" is not a downgrade', !/downgrade/i.test(generateNewsImpact('Apple names new executive', 'neutral', 'AAPL')));
check('"second" is not the SEC', !/Legal/.test(generateNewsImpact('Second quarter preview', 'neutral', 'AAPL')));
check('a real war headline still classifies', /Geopolitical/.test(generateNewsImpact('Stocks slide as war fears grow', 'negative', 'AAPL')));

console.log('\n=== social velocity survives a capped sample ===');
{
    const now = Date.parse('2026-09-28T18:00:00Z');
    // 30 messages in 20 minutes, evenly spaced: a busy but STEADY stream. The old last-hour /
    // 24h-rate formula called this 24x "extreme" and docked every BUY on a popular stock.
    const steady = Array.from({ length: 30 }, (_, i) => now - i * 40e3);
    const v = sampleVelocity(steady, now);
    check('steady busy stream is ~1x, not "extreme"', v > 0.5 && v < 2, v.toFixed(2));
    const pump = [...Array.from({ length: 15 }, (_, i) => now - i * 40e3),
                  ...Array.from({ length: 15 }, (_, i) => now - 12 * 3600e3 - i * 1200e3)];
    check('a real burst still reads as a burst', sampleVelocity(pump, now) >= 5);
    check('too few messages is no signal', sampleVelocity([now, now - 1000], now) === 0);
}

console.log('\n=== third-party text is escaped ===');
check('HTML in a headline is inert', escapeHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');
check('quotes cannot break an attribute', escapeHtml('a"b\'c') === 'a&quot;b&#39;c');
check('javascript: links are dropped', safeHttpUrl('javascript:alert(1)') === '');
check('https links survive', safeHttpUrl('https://example.com/x') === 'https://example.com/x');

console.log('\n=== crypto calendar and coin identity ===');
{
    const fri = new Date('2026-10-02T12:00:00Z');
    const crypto = forwardDates(3, { cryptoMode: true, from: fri }).map(d => d.getUTCDay());
    const stock = forwardDates(3, { cryptoMode: false, from: fri }).map(d => d.getUTCDay());
    check('crypto sessions include the weekend', crypto.includes(6) && crypto.includes(0), JSON.stringify(crypto));
    check('stock sessions skip it', !stock.includes(6) && !stock.includes(0), JSON.stringify(stock));
    check('"Bitcoin USD" is Bitcoin', coinNamesAgree('Bitcoin USD', 'Bitcoin'));
    // Prefix matching would accept this, and ARB-USD really is "ARbit" at $0.0006.
    check('"ARbit" is not Arbitrum', !coinNamesAgree('ARbit USD', 'Arbitrum'));
    check('"TON Token" is not Toncoin', !coinNamesAgree('TON Token USD', 'Toncoin'));
}

if (process.argv.includes('--network')) {
    const { fetchCryptoMultiTimeframe } = await import('../js/data.js');
    console.log('\n=== crypto bars are daily, and the right coin (network) ===');
    for (const [id, base, name, lo, hi] of [['bitcoin', 'BTC', 'Bitcoin', 1000, 1e7], ['the-open-network', 'TON', 'Toncoin', 0.05, 100]]) {
        try {
            const md = await fetchCryptoMultiTimeframe(id, { base, name });
            const c = md.daily.candles;
            const gaps = c.slice(1).map((x, i) => (x.time - c[i].time) / 3600).sort((a, b) => a - b);
            const med = gaps[gaps.length >> 1];
            check(`${base}: daily bars are 24h apart (was 96h from CoinGecko)`, Math.abs(med - 24) < 1, `median gap ${med}h via ${md.source}`);
            check(`${base}: at least 60 daily bars`, c.length >= 60, String(c.length));
            // TON-USD on Yahoo is "TON Token" at ~$0.005; the real coin is ~$1-10.
            check(`${base}: price is the real coin's (${md.daily.currentPrice})`, md.daily.currentPrice > lo && md.daily.currentPrice < hi);
        } catch (e) { check(`${base}: fetch`, false, e.message); }
    }
}

console.log(`\nAUDIT FIXES CHECK ${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
