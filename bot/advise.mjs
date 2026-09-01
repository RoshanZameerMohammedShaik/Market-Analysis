/**
 * Mia's brain, running headless. THE app's real engine, not a reimplementation.
 *
 * WHY NODE AND NOT PYTHON
 * -----------------------
 * Roshan asked why chat Mia and the trading desk cannot just be the same thing. They can.
 * js/confidence.js runs unmodified under Node with live data, so the desk imports the
 * SAME four-source engine the browser shows a user, plus the same LSTM, the same
 * calibrated band, and the same Mia prompt. Verified: AAPL NEUTRAL conf=51 score=55.9
 * with ai/tech/sentiment/market all populated, ~500ms per symbol after warmup.
 *
 * This also repairs something older: record_predictions.py runs a technicals-only subset
 * (three indicators) while the browser runs the full blend, so the cron has always been
 * grading a thinner engine than the product. The desk does not inherit that.
 *
 * CONTRACT
 * --------
 * Pure function of its input. Reads a request JSON, writes an advice JSON, touches no
 * account state and executes nothing. bot/run.py owns the money. That split means a bug
 * here cannot spend anything, and it keeps the LLM one step away from execution.
 *
 *   node bot/advise.mjs <request.json> <advice.json>
 *
 * The two browser-only surfaces the engine reaches for are stubbed and nothing else:
 * localStorage (three lines) and relative fetches for model JSON (file-backed).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const [reqPath, outPath] = process.argv.slice(2);
if (!reqPath || !outPath) {
    console.error('usage: node bot/advise.mjs <request.json> <advice.json>');
    process.exit(2);
}

// ── shims: the only two things the engine needs that a browser provides ──────
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (/^https?:/i.test(s)) return realFetch(s, opts);
    // Relative paths are the engine's model files (calibration, weights, ledger slice).
    const rel = s.replace(/^\.?\//, '').split('?')[0];
    try {
        const body = await readFile(join(REPO, rel), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body),
                 text: async () => body };
    } catch {
        return { ok: false, status: 404, json: async () => null, text: async () => '' };
    }
};
// The engine reads cached calibration and user prefs from localStorage. On a runner there
// is no user and no cache, so every read is a miss and the engine falls back to its
// shipped defaults, which is exactly what we want for a reproducible decision.
const _mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (_mem.has(k) ? _mem.get(k) : null),
    setItem: (k, v) => _mem.set(k, String(v)),
    removeItem: (k) => _mem.delete(k),
};

const load = (p) => import(pathToFileURL(join(REPO, p)).href);
const { fetchStockMultiTimeframe } = await load('js/data.js');
const { computeFullConfidence } = await load('js/confidence.js');
const { loadModel } = await load('js/ai-model.js');
const { loadBandCalibration } = await load('js/forecast-band.js');
const { loadCalibration } = await load('js/calibration.js');

const req = JSON.parse(await readFile(reqPath, 'utf8'));
const cfg = req.config || {};
const started = Date.now();

// Warm the shared model + calibration once rather than per symbol.
await Promise.all([loadModel(), loadBandCalibration(), loadCalibration()]);

/** One symbol through the real engine. Returns null on any data failure so a single
 *  bad ticker cannot abort the run: a desk that skips a day because one quote failed is
 *  worse than one that trades the other 59 names. */
async function analyse(symbol) {
    try {
        const md = await fetchStockMultiTimeframe(symbol);
        const candles = md?.daily?.candles;
        if (!Array.isArray(candles) || candles.length < 60) return null;
        const price = md.daily.currentPrice ?? candles[candles.length - 1]?.close;
        if (!(price > 0)) return null;

        const r = await computeFullConfidence(md, 'stock', symbol, 'today',
                                              { bulkScan: true });
        const ind = r.indicatorSnapshot || {};
        const b = r.breakdown || {};
        return {
            symbol,
            price,
            // asOf is what bot/run.py checks for staleness. A decision made on an hour-old
            // quote is not the decision it claims to be.
            asOf: new Date().toISOString(),
            score: typeof r.weightedScore === 'number' ? r.weightedScore : null,
            signal: r.signal,
            confidence: r.confidence,
            dispersion: r.dispersion ?? null,
            regime: r.regime ?? null,
            indicators: {
                rsi: ind.rsi ?? null,
                macdHist: ind.macdHist ?? ind.macd?.histogram ?? null,
                bb: ind.bb ?? null,
                adx: ind.adx ?? null,
                atrPct: ind.atrPct ?? null,
            },
            ai: {
                score: b.ai?.score ?? null,
                probability: typeof b.ai?.score === 'number' ? b.ai.score / 100 : null,
                available: b.ai?.available ?? false,
                weight: b.ai?.weight ?? null,
            },
            sources: {
                technical: b.technical?.score ?? null,
                sentiment: b.sentiment?.score ?? null,
                market: b.market?.score ?? null,
            },
            band: r.forecastBand
                ? { calibrated: r.forecastBand.calibrated, tier: r.forecastBand.volTier,
                    confidence: r.forecastBand.confidence,
                    day1: r.forecastBand.days?.[0] ?? null }
                : null,
            reasons: (r.reasons || []).slice(0, 5),
        };
    } catch (e) {
        return { symbol, error: `${e.constructor.name}: ${String(e.message).slice(0, 120)}` };
    }
}

// BOUNDED CONCURRENCY.
//
// This was sequential, which was right when the universe was capped at 60 names: ~1.36s each
// measured, so about 80 seconds. The cap is gone -- Roshan asked for the whole universe to be
// reviewed -- and 264 tradeable names sequentially is roughly six minutes, which does not fit
// a near-real-time loop.
//
// A small pool rather than Promise.all over everything: Yahoo rate-limits aggressively and
// this repo already carries retry/backoff scars from hammering it (one run degraded into a
// 3h17m hang). Five in flight is a large speedup over one while staying far below the rate at
// which the ledger cron started getting empty responses. Each worker still fails
// independently, so one bad ticker cannot abort the pass.
const CONCURRENCY = 5;
const candidates = {};
const failures = [];
const queue = [...(req.universe || [])];
let cursor = 0;

async function worker() {
  while (cursor < queue.length) {
    const sym = queue[cursor++];
    const a = await analyse(sym);
    absorb(sym, a);
  }
}

function absorb(sym, a) {
    if (!a) { failures.push({ symbol: sym, error: 'no data' }); return; }
    // `return`, not `continue`: this used to be the body of a for-loop and moving it into a
    // function turned the loop keyword into a syntax error.
    if (a.error) { failures.push(a); return; }
    candidates[sym] = a;
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

// ── Mia's own judgement ──────────────────────────────────────────────────────
/**
 * Ask Gemini for decisions. Returns [] when no key is configured, which is a normal
 * state and not an error: bot/strategies.py then drives that sleeve from the LSTM and
 * says so on every trade, so nothing about the desk is blocked on a secret existing.
 *
 * The model is given FEATURES and asked to justify a decision. It is never given raw
 * prices to forecast from: language models have no numerical edge on price series, and
 * asking one for a number invites a confident hallucination. Reasoning over structured
 * evidence is the task they are actually good at.
 */
async function miaDecides(holdings, cashUSD) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        return { decisions: [], brain: 'lstm',
                 note: 'No GEMINI_API_KEY on the runner, so the AI sleeve runs on the '
                     + 'LSTM alone. Add the secret to switch Mia to her own judgement.' };
    }
    const ai = cfg.ai || {};
    const model = ai.model || 'gemini-2.5-flash';
    const maxN = ai.maxSymbolsPerCall || 12;

    // Send the strongest and weakest by score: those are where a decision is live.
    // Sending the middle of the distribution wastes tokens on names nothing would act on.
    const ranked = Object.values(candidates)
        .filter((c) => typeof c.score === 'number')
        .sort((a, b) => b.score - a.score);
    const held = new Set(Object.keys(holdings || {}));
    const shortlist = [...ranked.slice(0, maxN), ...ranked.slice(-4)]
        .filter((c, i, arr) => arr.findIndex((x) => x.symbol === c.symbol) === i);
    // Always include what she already owns, or she cannot decide to sell it.
    for (const c of ranked) if (held.has(c.symbol) && !shortlist.includes(c)) shortlist.push(c);

    const brief = shortlist.map((c) => ({
        symbol: c.symbol, price: +c.price.toFixed(4), engineScore: +(c.score ?? 0).toFixed(1),
        signal: c.signal, engineConfidence: c.confidence,
        rsi: c.indicators.rsi != null ? +c.indicators.rsi.toFixed(1) : null,
        adx: c.indicators.adx != null ? +c.indicators.adx.toFixed(1) : null,
        aiProbUp: c.ai.probability != null ? +c.ai.probability.toFixed(3) : null,
        sentiment: c.sources.sentiment, market: c.sources.market,
        bandDay1: c.band?.day1 ? [c.band.day1.low, c.band.day1.high] : null,
        held: held.has(c.symbol) ? holdings[c.symbol] : null,
    }));

    const rules = cfg.risk || {};
    const sysPrompt = [
        'You are Mia, a Market Intelligence Analyst running a small PAPER trading book.',
        'The money is simulated. Your job is to make the best decisions you can and to',
        'explain each one in one sentence a person can check against the evidence given.',
        '',
        'What you must know about your own edge, because it shapes what a good decision is:',
        '  * This engine has NO measured directional skill. Over 996,541 historical',
        '    predictions its 1-day accuracy was 51.5% against a 51.79% majority-class',
        '    baseline, and zero of 40 cost-adjusted strategy cells were net-positive.',
        '  * A round trip costs roughly 0.2% in spread plus commission. So a trade needs a',
        '    reason big enough to clear that, and doing nothing is very often correct.',
        '  * The ONE thing measured as real here is short-horizon mean reversion',
        '    (RSI/Bollinger, IC about +0.05, t 3.3) and cross-sectional ordering.',
        'Therefore: be selective. HOLD is a legitimate and usually the best answer.',
        '',
        'This capital is FINITE and it is NOT replaced. If you trade your book down to',
        'nothing it stays at zero permanently and that is your recorded result. Treat it',
        'exactly as you would real money, because the whole purpose of this exercise is',
        'to find out what your decisions are actually worth. Protecting the book is not',
        'timidity here, it is the job.',
        '',
        `Constraints: max ${rules.maxPositions || 8} positions, at most`,
        `${rules.maxPositionPct || 12}% of the book per name, no more than`,
        `${rules.maxTradesPerRun || 3} trades this run. You cannot short. Cash: $${(cashUSD || 0).toFixed(2)}.`,
        '',
        'Reply with ONLY a JSON array, no prose and no code fence:',
        '[{"symbol":"XYZ","action":"BUY|SELL|HOLD","confidence":0.0-1.0,"reason":"one sentence"}]',
        'Omit anything you would HOLD. Confidence is your own, not the engine\'s.',
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await realFetch(url, {
        method: 'POST',
        // Key in a HEADER, never the query string: a URL with ?key= lands in logs,
        // error messages and proxy traces. Same reason the app redacts pasted logs.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: sysPrompt }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(brief) }] }],
            generationConfig: {
                temperature: ai.temperature ?? 0.2,
                maxOutputTokens: 1200,
                responseMimeType: 'application/json',
            },
        }),
        signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Never echo the body verbatim at length; it can contain the request including
        // anything the API chose to reflect back.
        throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // A model that ignores the JSON instruction must not crash the desk.
        const m = text.match(/\[[\s\S]*\]/);
        parsed = m ? JSON.parse(m[0]) : [];
    }
    const decisions = (Array.isArray(parsed) ? parsed : [])
        .filter((d) => d && d.symbol && /^(BUY|SELL)$/i.test(d.action || ''))
        .map((d) => ({ symbol: String(d.symbol).toUpperCase(),
                       action: String(d.action).toUpperCase(),
                       confidence: Number(d.confidence),
                       reason: String(d.reason || '').slice(0, 300) }));
    return { decisions, brain: 'gemini', model,
             note: `Gemini returned ${decisions.length} actionable decision(s) from `
                 + `${brief.length} symbols reviewed.` };
}

let mia = { decisions: [], brain: 'lstm', note: 'not attempted' };
try {
    mia = await miaDecides(req.holdings || {}, req.cashUSD || 0);
} catch (e) {
    // Degrade, never die. The LSTM path still trades and the timeline records why the
    // LLM was absent, so a dead API is visible rather than silently skipped.
    mia = { decisions: [], brain: 'lstm',
            note: `LLM unavailable (${String(e.message).slice(0, 160)}); using the LSTM.` };
}

await writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    engine: 'js/confidence.js (the app\'s own engine, unmodified)',
    analysed: Object.keys(candidates).length,
    failed: failures.length,
    failures: failures.slice(0, 20),
    candidates,
    mia,
}, null, 2), 'utf8');

console.log(`[advise] ${Object.keys(candidates).length} analysed, ${failures.length} failed, `
    + `Mia brain=${mia.brain}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
