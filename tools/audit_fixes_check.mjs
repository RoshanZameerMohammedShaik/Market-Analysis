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
import { renderForecastBand } from '../js/ui/forecast-band-panel.js';
import { readFileSync } from 'node:fs';

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

console.log('\n=== the band table marks its earnings rows ===');
{
    // A band read back from a ledger row carries only {day, low, high, widthPct} + earningsDay,
    // so the panel has to work from that alone. An unmarked widened row reads as a glitch.
    const days = [1, 2, 3, 4, 5, 6, 7].map(h => ({ day: h, low: 100 - h, high: 100 + h, widthPct: h }));
    const render = (earningsDay) => renderForecastBand(
        { calibrated: true, confidence: 80, volTier: 'normal', sigmaDaily: 2.1, days, earningsDay },
        { currency: 'USD', currentPrice: 100, cryptoMode: false });
    const count = (h, re) => (h.match(re) || []).length;
    const mid = render(4), none = render(0), unknown = render(null);
    check('the earnings day carries a tag', count(mid, /fb-earn-tag/g) === 1);
    check('that row and the ones after it are marked', count(mid, /fb-row-earn/g) === 4, String(count(mid, /fb-row-earn/g)));
    check('and the caveat names the row', /Earnings are due/.test(mid));
    check('nothing is marked when no earnings fall inside', count(none, /fb-row-earn/g) === 0 && !/Earnings are due/.test(none));
    check('nothing is marked when earnings are unknown', count(unknown, /fb-row-earn/g) === 0);
}

console.log('\n=== the card and the published list read ONE cell ===');
{
    // ELV's 30-day sigma sits at 1.455% against a 1.5% tier edge, so the browser's bars and the
    // slice's bars put it in different tiers and the app showed 67.7% in one place and 67.3% in
    // another. A symbol on today's list must take the published cell.
    const { evaluateReversionSetup } = await import('../js/reversion-setup.js');
    const cal = JSON.parse(readFileSync('model/reversion_calibration.json', 'utf8'));
    // Bars engineered to land just inside `calm` while the published row says `normal`.
    const bars = [];
    let px = 300;
    for (let i = 0; i < 260; i++) {
        px *= 1 + (i % 7 === 0 ? 0.004 : 0.0012);
        bars.push({ close: +px.toFixed(4), high: +(px * 1.004).toFixed(4), low: +(px * 0.996).toFixed(4), volume: 3e6 });
    }
    bars[bars.length - 2] = { ...bars[bars.length - 2], close: +(bars[bars.length - 3].close * 0.96).toFixed(4) };
    bars[bars.length - 1] = { ...bars[bars.length - 1], close: +(bars[bars.length - 2].close * 0.97).toFixed(4) };
    bars[bars.length - 1].low = bars[bars.length - 1].close;
    const published = { bySymbol: new Map([['TEST', { symbol: 'TEST', tier: 'wild', vixBand: 'high' }]]) };
    const live = evaluateReversionSetup({ history: bars, region: 'NYSE', vix: 16, cal, symbol: 'TEST' });
    const pubd = evaluateReversionSetup({ history: bars, region: 'NYSE', vix: 16, cal, published, symbol: 'TEST' });
    check('a symbol on the list takes the PUBLISHED tier, not a recomputed one',
        pubd?.tier === 'wild' && pubd?.vixBand === 'high' && pubd?.published === true,
        `${pubd?.tier}/${pubd?.vixBand}`);
    check('its cell is the published cell', pubd?.cell === cal.cells['wild:high'] || JSON.stringify(pubd?.cell) === JSON.stringify(cal.cells['wild:high']));
    check('a symbol NOT on the list is still evaluated live', live?.published === false && live?.tier !== 'wild', `${live?.tier}`);
}

console.log('\n=== the headline leads with what is measured, not a coin-flip direction ===');
{
    // Every US stock read "no clear edge" because next-day direction IS a coin flip. The headline
    // must be the pullback setup when one is active, else the calibrated volatility call.
    const { renderSuggestedDecision, directionRecord } = await import('../js/ui/suggested-decision.js');
    const pt = { currentPrice: 32.55, predictedLow: 30.38, predictedHigh: 34.89, highPercent: 7.2, lowPercent: -6.7, expectedMove: 0.9 };
    const vf = { sigma: 0.0335, lo: 0.0179, hi: 0.0712, past20: 0.0137, confidence: 0.83, call: 'choppier', earnIn: true,
                 bucket: { lo: 0.8, hi: 0.9, hitRate: 0.84 } };
    const rs = { active: true, reliable: true, forming: false, trigger: 33.1,
                 cell: { hitRate: 0.673, netBps: 25, n: 5495 } };
    const opts = { timeframe: 'today', ticker: 'NKE', name: 'Nike, Inc.' };
    const vol = renderSuggestedDecision({ signal: 'NEUTRAL', confidence: 50, priceTargets: pt, volForecast: vf }, opts);
    check('a US stock with a volatility forecast leads with it', /choppier week/.test(vol) && !/no clear edge/.test(vol));
    check('and states the measured hit rate of calls this sure', /right 84\.0%/.test(vol));
    check('direction is one line, not the headline', /Which way:<\/strong> no measurable edge/.test(vol));
    const setup = renderSuggestedDecision({ signal: 'BUY', confidence: 62, priceTargets: pt, volForecast: vf, reversionSetup: rs }, opts);
    check('an active pullback setup outranks the volatility call', /pullback setup/.test(setup) && /BUY<\/span><span class="sd-chip-cond">at the next open/.test(setup));
    const tomorrow = renderSuggestedDecision({ signal: 'BUY', confidence: 62, priceTargets: pt, volForecast: vf, reversionSetup: rs }, { ...opts, timeframe: 'tomorrow' });
    check("the setup leads only on Today (it is defined at today's close)", !/pullback setup/.test(tomorrow) && /choppier week/.test(tomorrow));
    const crypto = renderSuggestedDecision({ signal: 'NEUTRAL', confidence: 50, priceTargets: pt }, { ...opts, ticker: 'BTC-USD', name: 'Bitcoin' });
    check('no volatility model (crypto, non-US): the old direction text stands', /no clear edge/.test(crypto));
    const held = renderSuggestedDecision({ signal: 'NEUTRAL', confidence: 50, priceTargets: pt, volForecast: vf,
        reversionSetup: { active: false, trigger: 33.1, record: { symbol: [{ session: '2026-10-01', status: 'open', held: 2, markPct: -0.8, hitRate: 0.673 }] } } }, opts);
    check('a published setup still inside its trade leads with the exit rule', /still open/.test(held) && /HOLD<\/span><span class="sd-chip-cond">until the exit rule fires/.test(held), held.slice(0, 200));
    check('and says buying late was not measured', /Late to enter/.test(held));
    const rec = directionRecord({ byHorizon: { 1: { BUY: { a: { n: 10, actual: 40 } }, SELL: { b: { n: 30, actual: 60 } }, NEUTRAL: { c: { n: 99, actual: 50 } } } } });
    check('the live direction record counts BUY and SELL only', rec && rec.n === 40 && Math.abs(rec.hitRate - 0.55) < 1e-9, JSON.stringify(rec));
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
