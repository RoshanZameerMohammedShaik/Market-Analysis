// js/crypto-stream.js against a fake WebSocket: how many Binance handshakes a page makes before it
// settles on a venue, on a network that blocks Binance and on one that does not.
//
// Run: node tools/crypto_stream_check.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) pass++; else fail++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function fakeSocketClass(binanceReachable, log) {
    return class FakeWS {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            log.push(url);
            const kraken = url.includes('kraken');
            setTimeout(() => {
                if (kraken || binanceReachable) { this.readyState = 1; this.onopen?.(); }
                else { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
            }, 5);
        }
        send() {}
        close() { this.readyState = 3; }
    };
}

async function run(binanceReachable) {
    const log = [];
    globalThis.WebSocket = fakeSocketClass(binanceReachable, log);
    // A fresh module instance per scenario: the venue state is module-level.
    const mod = await import(`${pathToFileURL(path.join(repo, 'js', 'crypto-stream.js')).href}?r=${binanceReachable}`);
    const coins = Array.from({ length: 30 }, (_, i) => `C${String(i).padStart(2, '0')}X`);
    const handles = coins.map(c => mod.streamCryptoPrice(c, () => {}));
    await wait(1600);    // the probe, its one retry after the 1 s backoff, and the switch
    return { log, venue: mod.cryptoStreamVenue(), handles };
}

console.log('=== a network that blocks Binance ===');
const blocked = await run(false);
const bn = blocked.log.filter(u => u.includes('binance')).length;
check('30 coins at once make at most 2 Binance handshakes (the probe and its retry)', bn <= 2, `${bn} handshakes`);
check('then every coin moves to Kraken', blocked.venue === 'kraken');
check('over one shared Kraken socket', blocked.log.filter(u => u.includes('kraken')).length === 1, String(blocked.log.filter(u => u.includes('kraken')).length));

console.log('\n=== a network that reaches Binance ===');
const open = await run(true);
const bo = open.log.filter(u => u.includes('binance')).length;
check('the probe opens, then every coin gets its own Binance stream', bo === 30, `${bo} handshakes`);
check('and Kraken is never touched', open.log.every(u => !u.includes('kraken')));

console.log('\n=== the probe coin is closed before Binance answers ===');
{
    const log = [];
    let reach = false;
    // Binance is slow to answer here: nothing happens until `reach` flips.
    globalThis.WebSocket = class {
        constructor(url) { this.url = url; this.readyState = 0; log.push(url); const t = setInterval(() => { if (reach) { clearInterval(t); this.readyState = 1; this.onopen?.(); } }, 5); }
        send() {}
        close() { this.readyState = 3; }
    };
    const mod = await import(`${pathToFileURL(path.join(repo, 'js', 'crypto-stream.js')).href}?r=dropped`);
    const first = mod.streamCryptoPrice('AAAX', () => {});
    const rest = ['BBBX', 'CCCX', 'DDDX'].map(c => mod.streamCryptoPrice(c, () => {}));
    first.close();                  // the probe goes away while it is still out
    reach = true;
    await wait(80);
    const bn2 = log.filter(u => u.includes('binance'));
    check('the next coin takes over the probe, and the rest follow when it opens', bn2.length === 4, `${bn2.length} handshakes: ${bn2.map(u => u.split('/ws/')[1]).join(', ')}`);
    for (const h of rest) h?.close();
}

for (const h of [...blocked.handles, ...open.handles]) h?.close();
console.log(`\n${fail ? 'CRYPTO STREAM CHECK FAIL' : 'CRYPTO STREAM CHECK PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
