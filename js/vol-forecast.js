// Next-week volatility forecast. MIRRORS vol_forecast.py; tools/vol_sync_check.py holds them
// together. See that file for the evidence; in short, on 459,197 forecasts in years the model never
// saw, the size of next week's moves scored R^2 0.63 (the old 30-day estimate 0.53), the 80% range
// held 80% including earnings weeks, and the calmer/choppier call is calibrated: calls made at
// 70-80% confidence were right 74.8%, at 90%+ right 94.5%.
//
// US stocks only: the model was trained on them, with VIX and SPY as its market inputs.
//
// Implied volatility: the stock's own option IV (DoltHub) and the VIX term structure (CBOE), both
// as of the PREVIOUS session, come from the nightly slice (slice.iv, slice.market). A stock with
// no listed options gets them as missing, which the trees were trained to route.

import { loadEarningsSlice, earningsDayFor } from './earnings-calendar-slice.js';
import { loadMarketSessions } from './market-sessions.js';

const MODEL_URL = 'model/vol_model.json';
const SLICE_URL = 'model/vol_forecasts.json';
const RECORD_URL = 'model/vol_record.json';
export const H = 5;
export const MIN_BARS = 90;
const EPS = 1e-10;
const LN2X4 = 4 * Math.log(2);
const MARKET_FEATURES = ['l_vix', 'vix_rel', 'spy_rv5', 'spy_rv22', 'ts9', 'ts3m', 'l_vvix'];
const SQRT252 = Math.sqrt(252);
const num = (v) => (v === null || v === undefined ? NaN : Number(v));

const once = (url) => {
    let p = null;
    return () => (p ||= (async () => {
        try {
            const r = await fetch(url, { cache: 'no-cache' });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
            return await r.json();
        } catch (_) { return null; }
    })());
};
export const loadVolModel = once(MODEL_URL);
export const loadVolSlice = once(SLICE_URL);
export const loadVolRecord = once(RECORD_URL);

const halfLogMean = (xs) => 0.5 * Math.log(xs.reduce((a, b) => a + b, 0) / xs.length + EPS);

/** Exchange-local (New York) ISO date and minute-of-day for an epoch in ms. */
function nyParts(ms) {
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const g = (t) => p.find(x => x.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, minute: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

const barMs = (b) => (b.time > 1e12 ? b.time : b.time * 1000);

/** Completed daily bars only. Before 16:05 New York, today's bar is a live partial, not a close. */
export function completedBars(history, nowMs = Date.now()) {
    if (!Array.isArray(history) || !history.length) return [];
    const now = nyParts(nowMs);
    const last = history[history.length - 1];
    if (nyParts(barMs(last)).date === now.date && now.minute < 16 * 60 + 5) return history.slice(0, -1);
    return history;
}

/** MIRRORS vol_forecast.features. */
export function volFeatures(bars, market, earnIn, dow, iv = null) {
    if (!bars || bars.length < MIN_BARS || !market) return null;
    const b = bars.slice(-(MIN_BARS + 1));
    const o = b.map(x => x.open), h = b.map(x => x.high), lo = b.map(x => x.low), c = b.map(x => x.close);
    const v = b.map(x => Number(x.volume) || 0);
    if (Math.min(...c) <= 0 || Math.min(...lo) <= 0 || Math.min(...o) <= 0 || h.some((x, i) => x < lo[i])) return null;
    if ([...o, ...h, ...lo, ...c].some(x => !Number.isFinite(x))) return null;
    const n = b.length;
    const pk = h.map((x, i) => Math.log(x / lo[i]) ** 2 / LN2X4);
    const r2 = [], g2 = [];
    for (let i = 1; i < n; i++) {
        r2.push(Math.log(c[i] / c[i - 1]) ** 2);
        g2.push(Math.log(o[i] / c[i - 1]) ** 2);
    }
    const rLast = Math.log(c[n - 1] / c[n - 2]);
    const dv = c.map((x, i) => x * v[i]);
    const mean = (xs) => xs.reduce((a, b2) => a + b2, 0) / xs.length;
    const f = {
        pk1: 0.5 * Math.log(pk[n - 1] + EPS),
        pk5: halfLogMean(pk.slice(-5)), pk22: halfLogMean(pk.slice(-22)), pk66: halfLogMean(pk.slice(-66)),
        cc5: halfLogMean(r2.slice(-5)), cc22: halfLogMean(r2.slice(-22)), cc66: halfLogMean(r2.slice(-66)),
        gap22: halfLogMean(g2.slice(-22)),
        ar1: Math.log(Math.abs(rLast) + 1e-4),
        ret5: Math.log(c[n - 1] / c[n - 6]), ret22: Math.log(c[n - 1] / c[n - 23]),
        l_dv: Math.log(mean(dv.slice(-20)) + 1),
        vol_ratio: Math.log((v[n - 1] + 1) / (mean(v.slice(-20)) + 1)),
        dow, earn_in: earnIn ? 1 : 0,
        past20: halfLogMean(r2.slice(-20)),
    };
    for (const k of MARKET_FEATURES) f[k] = num(market[k]);
    const lIv = iv > 0 ? Math.log(iv / SQRT252) : NaN;
    f.l_iv = lIv;
    f.iv_rel = lIv - f.past20;
    f.iv_rv5 = lIv - f.cc5;
    return f;
}

function tree(nodes, x) {
    let i = 0;
    for (;;) {
        const nd = nodes[i];
        if (nd.length === 1) return nd[0];
        const v = x[nd[0]];
        // sklearn HistGradientBoosting: left on <=; a missing value goes where training sent them.
        if (Number.isNaN(v)) i = nd[4] ? nd[2] : nd[3];
        else i = v <= nd[1] ? nd[2] : nd[3];
    }
}
const raw = (m, x) => m.trees.reduce((s, t) => s + tree(t, x), m.base);

function interp(xs, ys, p) {
    if (p <= xs[0]) return ys[0];
    if (p >= xs[xs.length - 1]) return ys[ys.length - 1];
    for (let k = 1; k < xs.length; k++) {
        if (p <= xs[k]) {
            const t = xs[k] > xs[k - 1] ? (p - xs[k - 1]) / (xs[k] - xs[k - 1]) : 0;
            return ys[k - 1] + t * (ys[k] - ys[k - 1]);
        }
    }
    return ys[ys.length - 1];
}

/** MIRRORS vol_forecast.predict. */
export function volPredict(model, feats) {
    if (!model || !feats) return null;
    const x = model.features.map(k => feats[k]);
    const ls = raw(model.level, x);
    const earn = feats.earn_in >= 0.5;
    const q = model.residualQ[earn ? 'earn' : 'normal'];
    const rawP = 1 / (1 + Math.exp(-raw(model.up, x)));
    const p = interp(model.upCalibration.x, model.upCalibration.y, rawP);
    const sure = Math.max(p, 1 - p);
    let call = p >= 0.5 ? 'choppier' : 'calmer';
    // Both models must agree (MIRRORS vol_forecast.predict): disagreeing calls were a coin flip.
    const agrees = (ls > feats.past20) === (p >= 0.5);
    if (sure < model.minCallConfidence || !agrees) call = 'similar';
    return { sigma: Math.exp(ls), lo: Math.exp(ls + q[0]), hi: Math.exp(ls + q[1]),
             past20: Math.exp(feats.past20), pUp: p, confidence: sure, call, earnIn: earn };
}

export function bucketFor(model, confidence) {
    return (model?.accuracyByConfidence || []).find(b => confidence >= b.lo && confidence < b.hi) || null;
}

const addDay = (iso) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};

/**
 * The forecast for one symbol. A symbol in tonight's published slice for the same session takes
 * the published numbers, so the card and the landing list never disagree; anything else is
 * computed here from its completed bars and the slice's market state.
 */
export async function evaluateVolForecast({ history, symbol, region, nowMs = Date.now() }) {
    if (String(region || '').toUpperCase() !== 'NYSE') return null;
    const [model, slice] = await Promise.all([loadVolModel(), loadVolSlice()]);
    if (!model || !slice?.market) return null;
    const bars = completedBars(history, nowMs);
    if (bars.length < MIN_BARS + 1) return null;
    const last = nyParts(barMs(bars[bars.length - 1])).date;
    const sym = String(symbol || '').toUpperCase();
    const pub = slice.sessionDate === last ? slice.forecasts?.[sym] : null;
    let f = null;
    if (pub) {
        f = { sigma: pub.s, lo: pub.lo, hi: pub.hi, past20: pub.p20, pUp: pub.pUp, confidence: pub.c,
              call: pub.call, earnIn: pub.e === 1, earnKnown: pub.e != null, published: true };
    } else {
        // Market state more than a few days older than the bars would describe a different week.
        const age = (Date.parse(`${last}T12:00:00Z`) - Date.parse(`${slice.sessionDate}T12:00:00Z`)) / 864e5;
        if (!(age >= 0 && age <= 4)) return null;
        let eday = null;
        try {
            const [es] = await Promise.all([loadEarningsSlice(), loadMarketSessions()]);
            eday = earningsDayFor(sym, 'NYSE', addDay(last), es, H);
        } catch (_) { eday = null; }
        const dow = (new Date(`${last}T12:00:00Z`).getUTCDay() + 6) % 7;
        const iv = slice.ivDate && slice.ivDate < last ? slice.iv?.[sym] ?? null : null;
        const p = volPredict(model, volFeatures(bars, slice.market, eday > 0, dow, iv));
        if (!p) return null;
        f = { ...p, earnKnown: eday != null, published: false };
    }
    // The options market's own number, when there is one: shown beside the forecast, and an input to it.
    const ivUsed = slice.ivDate && slice.ivDate < last ? (slice.iv?.[sym] ?? null) : null;
    // ivLoaded: the slice carries an IV map at all. A slice published before the IV fetch existed
    // (or a night DoltHub failed) has none, which is not the same as "this stock has no options".
    return { ...f, session: last, impliedVol: ivUsed, ivDate: ivUsed ? slice.ivDate : null, ivLoaded: !!slice.ivDate,
             bucket: f.call === 'similar' ? null : bucketFor(model, f.confidence),
             walkForward: model.walkForward, minCall: model.minCallConfidence };
}
