// The prediction, as Roshan asked for it on 2026-10-13:
//
//   1. ONE card with the call and today's range on one bar. BUY (or HOLD if you own it) when the
//      price is expected to rise, SELL (or DON'T BUY if you don't) when it is expected to fall.
//   2. THIS WEEK, one bar per trading day, holidays left out.
//   3. NEXT WEEK, the same.
//
// Every day opens to say what is predicted for it, how sure the app is, and why, with the source
// of each input. Nothing here may be invented: a call is made only by a pattern with a measured
// record, its confidence is that record, and the "why" lists only what the model actually used.
//
// Replaces the 7-session table (forecast-band-panel.js) and the "Typical week" card
// (week-card.js), which stated the same forecast in percentages nobody could use.

import { fmtPriceTag } from './format.js';
import { bandDates, exchangeToday, barSessionDate, sessionProgress } from '../earnings-calendar-slice.js';
import { isSession } from '../market-sessions.js';
import { blendHeldOut } from '../forecast-band.js';
import { baselineSentence } from '../setup-baseline.js';

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

let _spikeRec = null;
let _spikePromise = null;
/** model/spike_record.json: the spike odds' backtest and live grade (tools/write_vol_slice.py). */
export async function loadSpikeRecord() {
    if (_spikeRec !== null) return _spikeRec || null;
    if (_spikePromise) return _spikePromise;
    _spikePromise = (async () => {
        try {
            const r = await fetch('model/spike_record.json', { cache: 'no-cache' });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('not json');
            const j = await r.json();
            _spikeRec = j && typeof j === 'object' ? { ...j, walkForward: j.backtest?.walkForward || null } : false;
        } catch (_) { _spikeRec = false; }
        return _spikeRec || null;
    })();
    return _spikePromise;
}

let _intraday = null;
let _intradayPromise = null;
/** model/band_intraday.json (tools/calibrate_intraday.py), memoised; null when unavailable. */
export async function loadIntraday() {
    if (_intraday !== null) return _intraday || null;
    if (_intradayPromise) return _intradayPromise;
    _intradayPromise = (async () => {
        try {
            const r = await fetch('model/band_intraday.json', { cache: 'no-cache' });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('not json');
            const j = await r.json();
            _intraday = j && j.z ? j : false;
        } catch (_) { _intraday = false; }
        return _intraday || null;
    })();
    return _intradayPromise;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const addDays = (iso, n) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const dayLabel = (iso, today) => {
    if (iso === today) return 'Today';
    if (iso === addDays(today, 1)) return 'Tomorrow';
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// ── the call ─────────────────────────────────────────────────────────────────────────────────

/**
 * BUY / HOLD / SELL / DON'T BUY, from patterns with a measured record only.
 *
 * Plain next-day up/down is right 51% of the time live (35,034 graded calls), so it never drives
 * this card. What does:
 *   - the dip-recovery setup (js/reversion-setup.js): 68% of 34,641 past setups closed back above
 *     the 5-day average within 10 sessions, held out 66%, live 74%. Expected up: BUY, or HOLD.
 *   - that setup's exit (a close back above the 5-day average): the recovery has happened. SELL
 *     for a holder; for anyone else there is nothing left to buy.
 * With neither, nothing measured points either way, and the card says so instead of guessing.
 */
export function decideCall({ rs = null, owned = null, setupsLive = null, gap = null } = {}) {
    const own = owned === true;
    const entries = rs?.record?.symbol || [];
    const pending = entries.find(e => e.status === 'pending');
    const exiting = entries.find(e => e.status === 'exiting');
    const open = entries.find(e => e.status === 'open');
    const base = { live: setupsLive };
    // 1. A setup is live on today's prices (confirmed at the close, or forming during the session).
    if (rs?.active && rs.reliable && rs.cell) {
        return { ...base, kind: own ? 'HOLD' : 'BUY', tone: 'up', confidence: rs.cell.hitRate, n: rs.cell.n, source: 'setup',
            title: own ? 'HOLD' : 'BUY',
            line: `${rs.forming ? 'A dip-recovery setup is forming today (it confirms at the close, and the measured entry is the next open).' : 'A dip-recovery setup is live: the measured entry is the next open.'} `
                + `${pct(rs.cell.hitRate)} of ${rs.cell.n.toLocaleString()} trades like it sold above their entry price, ${signedPct(rs.cell.netBps)} on average after costs.` };
    }
    // 2. Its exit fired: the recovery has happened.
    if (exiting) {
        return { ...base, kind: own ? 'SELL' : 'DONT_BUY', tone: 'down', confidence: null, source: 'setup-exit', entry: exiting,
            title: own ? 'SELL' : "DON'T BUY",
            line: own
                ? 'The dip has recovered: it closed back above its 5-day average, which is where this setup sells, at the next open.'
                : 'The dip has already recovered, so this setup is selling. There is nothing left to buy here.' };
    }
    // 3. It fired at the last close: this session's open is the measured entry.
    if (pending) {
        return { ...base, kind: own ? 'HOLD' : 'BUY', tone: 'up', confidence: pending.hitRate ?? rs?.cell?.hitRate ?? null, source: 'setup-pending', entry: pending,
            title: own ? 'HOLD' : 'BUY',
            line: `A dip-recovery setup fired at the ${shortDay(pending.session)} close, so this session's open is the measured entry. `
                + `${pct(pending.hitRate ?? rs?.cell?.hitRate ?? 0)} of trades like it were profitable${Number.isFinite(pending.expNetBps) ? `, ${signedPct(pending.expNetBps)} on average after costs` : ''}.` };
    }
    // 4. A trade from an earlier day is still running.
    if (open) {
        return { ...base, kind: own ? 'HOLD' : 'DONT_BUY', tone: own ? 'up' : 'flat', confidence: own ? (open.hitRate ?? null) : null, source: 'setup-open', entry: open,
            title: own ? 'HOLD' : "DON'T BUY",
            line: own
                ? 'A dip-recovery trade is still open: it sells after the first close above the 5-day average, or after 10 sessions.'
                : `This setup's entry was the ${shortDay(open.entryDate)} open. Buying later is not the measured trade.` };
    }
    // 5. A big gap up this morning with no earnings behind it: the one direction signal that
    //    measured better than a coin flip (tools/calibrate_gap_fade.py). About today only.
    if (gap) {
        return { ...base, kind: own ? 'HOLD' : 'DONT_BUY', tone: own ? 'flat' : 'down', confidence: own ? null : gap.rec.closedBelowOpen,
            source: 'gap', gap,
            title: own ? 'HOLD' : "DON'T BUY",
            line: own
                ? `It opened ${gap.pct}% above yesterday's close with no earnings behind it. Opens like this closed below the open ${pct(gap.rec.closedBelowOpen)} of the time, so expect it to give some back today. Tomorrow is a coin flip again.`
                : `Don't chase this open: it gapped ${gap.pct}% above yesterday's close, more than twice its normal move, with no earnings behind it. ${pct(gap.rec.closedBelowOpen)} of ${gap.rec.n.toLocaleString()} opens like this closed below the open, against ${pct(gap.rec.baseClosedBelowOpen)} on other days.` };
    }
    return { ...base, kind: own ? 'HOLD' : 'DONT_BUY', tone: 'flat', confidence: null, source: 'none',
        title: own ? 'HOLD' : "DON'T BUY",
        line: own ? 'No sell signal: nothing with a measured record points down today.'
            : 'No buy signal: nothing with a measured record points up today.' };
}

const signedPct = (bps) => `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`;

/**
 * Today's gap test (tools/calibrate_gap_fade.py), from what the band already knows: its anchor is
 * yesterday's close and its sigma the 30 sessions to yesterday. Only while the session trades, for
 * a liquid US listing, with the earnings calendar known and no reaction today or tomorrow.
 */
export function gapSignal({ rec, band, todayBar, liquid, region, nowMs = Date.now() }) {
    if (!rec?.n || !band?.anchor || !todayBar || !(todayBar.open > 0) || !liquid) return null;
    if (String(region || '').toUpperCase() !== 'NYSE' || !sessionProgress(region, nowMs)) return null;
    if (band.earningsDay == null || band.earningsDay === 1 || band.earningsDay === 2) return null;
    const sigma = Number(band.sigmaSource === 'blend' ? band.sigmaTrail : band.sigmaDaily) / 100;
    const prev = Number(band.anchor.price);
    if (!(sigma > 0) || !(prev > 0)) return null;
    const g = Math.log(todayBar.open / prev);
    if (g < (rec.k || 2) * sigma) return null;
    return { rec, gap: g, pct: (Math.expm1(g) * 100).toFixed(1), sigmaPct: (sigma * 100).toFixed(2) };
}

function shortDay(iso) {
    if (!iso) return 'last';
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function callEvidence(call, rs, co, symbol, dirRec, baseline = null) {
    const items = [];
    const e = call.entry;
    if (e && e.rsi2 != null) {
        items.push(`At the ${shortDay(e.session)} close, RSI(2) was <strong>${Number(e.rsi2).toFixed(1)}</strong>, under 10: a sharp two-day drop, in a stock above its 200-day average.`);
        if (Number.isFinite(e.entry)) items.push(`Entry: the ${shortDay(e.entryDate)} open, ${fmtPriceTag(e.entry, co)}.`);
    } else if (rs && rs.rsi2 != null) {
        items.push(rs.active
            ? `RSI(2) is <strong>${rs.rsi2.toFixed(1)}</strong>, under 10: a sharp two-day drop.`
            : `RSI(2) is ${rs.rsi2.toFixed(0)}. The dip-recovery setup needs it under 10, so there is no dip to buy today.`);
    }
    if (rs && Number.isFinite(rs.ma200) && Number.isFinite(rs.price)) {
        items.push(rs.price > rs.ma200
            ? `Price ${fmtPriceTag(rs.price, co)} is above its 200-day average ${fmtPriceTag(rs.ma200, co)}: an uptrend, which this setup requires.`
            : `Price ${fmtPriceTag(rs.price, co)} is below its 200-day average ${fmtPriceTag(rs.ma200, co)}: a downtrend, where this setup does not trade.`);
    }
    if (rs && rs.eligible === false && rs.reason) items.push(`Setup not available: ${esc(rs.reason)}.`);
    const c = rs?.cell;
    if (c && ['setup', 'setup-pending', 'setup-open'].includes(call.source)) {
        items.push(`Track record for this volatility and market mood: ${pct(c.hitRate)} of ${c.n.toLocaleString()} trades sold above their entry price, `
            + `average ${signedPct(c.netBps)} per trade after costs, positive in ${c.positiveYears} of ${c.years} years.`);
        const why = baselineSentence(baseline, { lead: 'Where the odds come from' });
        if (why) items.push(why);
        if (rs.heldOut) items.push(`On 2023 to 2026, years the rule was not fitted on: ${pct(rs.heldOut.hitRate)} of ${rs.heldOut.n.toLocaleString()}.`);
        if (Number.isFinite(rs.trigger)) items.push(`It sells at the open after the first close above the 5-day average (now ${fmtPriceTag(rs.trigger, co)}), or after 10 sessions. No stop: every stop tested lost money on this pattern.`);
    }
    if (call.live?.n) {
        items.push(`Live since ${shortDay(call.live.since)}: ${call.live.wins} of ${call.live.n} published setups sold above their entry price (${pct(call.live.hitRate)}).`);
    }
    if (call.source === 'gap' && call.gap) {
        const r = call.gap.rec;
        items.push(`Opened ${call.gap.pct}% above yesterday's close. Its normal daily move is about ±${call.gap.sigmaPct}%, so this gap is more than twice that. No earnings today or tomorrow on the earnings calendar.`);
        items.push(`Record, ${r.from} to ${r.to}: ${pct(r.closedBelowOpen)} of ${r.n.toLocaleString()} gaps like this on liquid US stocks closed below their open (95% range ${pct(r.ci95[0])} to ${pct(r.ci95[1])}), against ${pct(r.baseClosedBelowOpen)} on other days, and in ${r.yearsAboveBase} of ${r.years} years. They gave back ${(r.meanFadeBps / 100).toFixed(2)}% on average by the close.`);
        items.push('It is about today only: the next session after a gap like this is a coin flip. It is not a reason to sell short: after costs the margin is thin.');
    }
    if (dirRec?.n >= 30) {
        items.push(`Plain "up or down tomorrow" calls are right ${pct(dirRec.hitRate)} of the time on ${dirRec.n.toLocaleString()} live calls, so they never make this call. Of every direction signal tested on 2014 to 2026 data (earnings surprises, analyst ratings, momentum, short interest, options), only the gap rule above beat its base rate by a useful margin.`);
    }
    items.push(`Prices: <a href="https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history" target="_blank" rel="noopener">Yahoo Finance daily history</a>.`);
    return items;
}

// ── bars ─────────────────────────────────────────────────────────────────────────────────────

function scale(values) {
    const v = values.filter(Number.isFinite);
    if (!v.length) return null;
    let lo = Math.min(...v), hi = Math.max(...v);
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    return (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
}

/** The signal card's bar: red from the expected low up to the price, green from the price up to the expected high. */
function bigBar({ low, high, price, co }) {
    if (!(Number.isFinite(low) && Number.isFinite(high) && high > low)) return '';
    const p = Number.isFinite(price) ? price : (low + high) / 2;
    const x = scale([low, high, p]);
    const xl = x(low), xh = x(high), xp = x(p);
    const red = `<span class="fc-zone fc-red" style="left:${xl.toFixed(2)}%;width:${Math.max(0, Math.min(xp, xh) - xl).toFixed(2)}%"></span>`;
    const green = `<span class="fc-zone fc-green" style="left:${Math.max(xl, xp).toFixed(2)}%;width:${Math.max(0, xh - Math.max(xl, xp)).toFixed(2)}%"></span>`;
    const note = p > high ? '<div class="fc-bar-note">Already above the expected high.</div>'
        : p < low ? '<div class="fc-bar-note">Already below the expected low.</div>' : '';
    return `
        <div class="fc-bigbar" role="img" aria-label="Expected low ${low}, now ${p}, expected high ${high}">
            <div class="fc-track">${red}${green}<span class="fc-pointer" style="left:${xp.toFixed(2)}%"><span class="fc-pointer-tag" style="${xp < 18 ? 'left:0;transform:none' : xp > 82 ? 'left:auto;right:0;transform:none' : ''}">Now ${fmtPriceTag(p, co)}</span></span></div>
            <div class="fc-scale">
                <span class="fc-num fc-num-low" style="left:${xl.toFixed(2)}%"><b>${fmtPriceTag(low, co)}</b><i>expected low</i></span>
                <span class="fc-num fc-num-high" style="left:${xh.toFixed(2)}%"><b>${fmtPriceTag(high, co)}</b><i>expected high</i></span>
            </div>
            ${note}
        </div>`;
}

// ── the days ─────────────────────────────────────────────────────────────────────────────────

/**
 * THE LIVE "TODAY" RANGE (tools/calibrate_intraday.py). While the session trades, the rest of the
 * day only has the time left to move in, and the range can never be narrower than what has
 * already traded:  low = min(low so far, price * e^(-z * sigma * sqrt(f))), high likewise, with
 * f the share of the session still to trade and z measured per (tier, f) on two years of hourly
 * bars. Returns null outside the session or without the calibration.
 */
export function liveToday({ intraday, band, price, todayBar, region, nowMs = Date.now() }) {
    if (!intraday?.z || !band || !todayBar || !(price > 0)) return null;
    const prog = sessionProgress(region, nowMs);
    if (!prog) return null;
    const sigma = Number(band.sigmaDaily) / 100;
    const zt = intraday.z[band.volTier];
    if (!(sigma > 0) || !zt) return null;
    // Interpolated between bucket centres, so the range does not jump when f crosses a bucket edge.
    const edges = intraday.fEdges || [0, 0.2, 0.4, 0.6, 0.8, 1];
    const pts = [];
    for (let i = 0; i < edges.length - 1; i++) {
        const v = Number(zt[String(i)]);
        if (Number.isFinite(v)) pts.push([(edges[i] + edges[i + 1]) / 2, v]);
    }
    if (!pts.length) return null;
    let z = pts[0][1];
    if (prog.f >= pts[pts.length - 1][0]) z = pts[pts.length - 1][1];
    else for (let i = 1; i < pts.length; i++) {
        if (prog.f <= pts[i][0]) {
            const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
            z = prog.f <= x0 ? y0 : y0 + (y1 - y0) * (prog.f - x0) / (x1 - x0);
            break;
        }
    }
    const move = z * sigma * Math.sqrt(prog.f);
    return {
        low: Math.min(todayBar.low, price * Math.exp(-move)),
        high: Math.max(todayBar.high, price * Math.exp(move)),
        f: prog.f, confidence: Math.round((intraday.targetConfidence ?? 0.8) * 100),
    };
}

/** Session dates of the band's rows, from its own day 1. */
function bandRowDates(band, region, cryptoMode) {
    const day1 = band?.anchor?.day1;
    const n = band?.days?.length || 0;
    if (!day1 || !n) return [];
    if (cryptoMode) return band.days.map((_, i) => addDays(day1, i));
    return bandDates(day1, region, n);
}

/** Mon..Fri (Mon..Sun for crypto) of the week containing iso, trading days only. */
function weekOf(iso, region, cryptoMode) {
    const wd = weekday(iso);
    const monday = addDays(iso, wd === 0 ? -6 : 1 - wd);
    const span = cryptoMode ? 7 : 5;
    const out = [];
    for (let i = 0; i < span; i++) {
        const d = addDays(monday, i);
        if (cryptoMode || isSession(region, d)) out.push(d);
    }
    return out;
}

/** The spike odds for the band's first session, with the evidence behind the number. */
function spikeBlock(spike, record, row, co) {
    const p = spike.p, base = spike.base || 0.066;
    const movePct = (spike.move * 100).toFixed(1);
    const lines = [];
    lines.push(`<div class="fc-conf-line"><b>${pct(p, p < 0.1 ? 1 : 0)}</b> chance this session moves at least ±${movePct}% (twice this stock's normal day), either way. The usual chance for a stock: ${pct(base, 1)}.</div>`);
    const ev = [];
    const t = spike.trainedOn;
    ev.push(`From a model trained on ${t?.symbols ? `${t.symbols} US stocks, ${String(t.from).slice(0, 4)} to ${String(t.to).slice(0, 4)},` : 'years of US stock prices'} and scored only on years it never saw: it reads recent ranges, gaps and volume, the VIX and its term structure, this stock's own options prices, its own record of big days, and the earnings calendar.`);
    if (spike.backtest?.top10pctLift) ev.push(`Its top tenth of days moved twice normal ${pct(spike.backtest.top10pctRate)} of the time, ${spike.backtest.top10pctLift}x the usual rate.`);
    const b = (record?.byOdds || []).find(x => p >= x.lo && p < x.hi);
    if (b && b.n >= 30) ev.push(`Live since ${esc(record.since)}: on ${b.n.toLocaleString()} days given odds like this, ${pct(b.spiked / b.n)} had a big move (the odds said ${pct(b.predicted / b.n)}).`);
    lines.push(`<ul>${ev.map(t => `<li>${t}</li>`).join('')}</ul>`);
    return `<div class="fc-sub">Big-move odds</div>${lines.join('')}`;
}

function dayWhy({ row, band, k, earningsDay, symbol, sigma, tier }) {
    const items = [];
    if (row.kind === 'past') {
        items.push(row.met
            ? `It held: the day traded ${fmtPriceTag(row.actualLow, row.co)} to ${fmtPriceTag(row.actualHigh, row.co)}, inside the range.`
            : `It broke ${row.brokeSide === 'both' ? 'both edges' : row.brokeSide === 'high' ? 'above the high' : 'below the low'}: the day traded ${fmtPriceTag(row.actualLow, row.co)} to ${fmtPriceTag(row.actualHigh, row.co)}.`);
        items.push(row.source === 'locked' ? 'This is the range the app committed to before that session opened.'
            : 'Rebuilt from only the prices available before that session.');
        return items;
    }
    if (band.sigmaSource === 'blend' && Number.isFinite(band.sigmaTrail) && Number.isFinite(band.sigmaVol)) {
        items.push(`How much this stock is expected to move: about ±${sigma.toFixed(2)}% a day, the blend of how much it moved over the last 30 sessions (±${band.sigmaTrail.toFixed(2)}%) and the volatility forecast (±${band.sigmaVol.toFixed(2)}%). This is the main input.`);
        items.push(`The volatility forecast reads the market's fear gauge (<a href="https://www.cboe.com/tradable_products/vix/" target="_blank" rel="noopener">VIX, Cboe</a>) and its term structure, this stock's own options prices (<a href="https://www.dolthub.com/repositories/post-no-preference/options" target="_blank" rel="noopener">options data, DoltHub</a>) and the earnings calendar, so it moves before the price history does.`);
        const ho = blendHeldOut();
        if (ho?.blend?.byVix) {
            const v = Object.values(ho.blend.byVix).filter(Number.isFinite);
            items.push(`Sized this way, the range held ${pct(Math.min(...v))} to ${pct(Math.max(...v))} in every VIX regime on 2022 to 2026, years it was not fitted on${ho.trail?.byVix?.['30+'] ? `, where sizing by the 30-day range alone fell to ${pct(ho.trail.byVix['30+'])} when the VIX was above 30` : ''}.`);
        }
    } else if (Number.isFinite(sigma)) {
        items.push(`How much this stock has been moving: about ±${sigma.toFixed(2)}% a day over the last 30 sessions (${esc(tier || '')} volatility). This is the main input.`);
    }
    if (k > 1) items.push(`${k} sessions ahead: the range widens with each session because the uncertainty adds up.`);
    if (Number.isFinite(row.fromPrice)) {
        items.push(`Started from the live price, ${fmtPriceTag(row.fromPrice, row.co)}, with ${Math.round(row.fromF * 100)}% of today still to trade, `
            + `because the stock has moved since the ${shortDay(band.anchor?.session)} close the range was built on. From that close it read `
            + `${fmtPriceTag(row.morningLow, row.co)} to ${fmtPriceTag(row.morningHigh, row.co)}.`);
    }
    if (earningsDay > 0 && k >= earningsDay) {
        items.push(`Earnings move ${k === earningsDay ? 'this session' : 'an earlier session in this window'}, so it uses the much wider range measured on earnings weeks. <a href="https://finance.yahoo.com/calendar/earnings?symbol=${encodeURIComponent(symbol)}" target="_blank" rel="noopener">Earnings calendar</a>`);
    } else if (earningsDay === 0) {
        items.push('No earnings fall in this window (checked against the earnings calendar).');
    }
    items.push(`The width is set so the day's high and low both stay inside ${band.confidence}% of the time, measured on past prices of stocks this volatile, not assumed from a formula.`);
    const m = Array.isArray(band.m) ? band.m[k - 1] : null;
    if (Number.isFinite(m) && Math.abs(m - 1) >= 0.01) {
        items.push(`Checked against the live record: recent ranges like this one needed to be ${Math.abs(Math.round((m - 1) * 100))}% ${m > 1 ? 'wider' : 'narrower'} to hold ${band.confidence}% of the time, so this one is.`);
    }
    return items;
}

function dayRow(row, x, opts) {
    const { co, today } = opts;
    const has = Number.isFinite(row.low) && Number.isFinite(row.high);
    const seg = (a, b, cls) => (Number.isFinite(a) && Number.isFinite(b) && b > a
        ? `<span class="${cls}" style="left:${x(a).toFixed(2)}%;width:${(x(b) - x(a)).toFixed(2)}%"></span>` : '');
    const actual = row.kind === 'past' || row.kind === 'today'
        ? seg(row.actualLow, row.actualHigh, 'fc-act') : '';
    const outside = row.kind === 'past' && has
        ? `${row.actualHigh > row.high ? seg(row.high, row.actualHigh, 'fc-out') : ''}${row.actualLow < row.low ? seg(row.actualLow, row.low, 'fc-out') : ''}` : '';
    const now = (row.kind === 'today' || row.kind === 'future') && Number.isFinite(opts.price)
        ? `<span class="fc-now" style="left:${x(opts.price).toFixed(2)}%"></span>` : '';
    // A big-move flag on the row itself when the odds are at least twice the usual.
    const spikeFlag = (row.kind !== 'past' && row.k === 1 && opts.spike && opts.spike.p >= 2 * (opts.spike.base || 0.066))
        ? `<span class="fc-spike" title="Chance of a move at least twice the normal size">big move ${pct(opts.spike.p)}</span>` : '';
    const verdict = row.kind === 'past'
        ? (row.met ? '<span class="fc-v fc-v-in">held</span>' : '<span class="fc-v fc-v-out">broke</span>')
        : row.kind === 'today' ? '<span class="fc-v fc-v-live">today</span>' : '';
    const conf = Number.isFinite(row.confidence) ? row.confidence : null;
    const why = dayWhy({ row: { ...row, co }, band: opts.band, k: row.k, earningsDay: opts.earningsDay,
        symbol: opts.symbol, sigma: opts.sigma, tier: opts.tier });
    const spikeHtml = (row.kind !== 'past' && row.k === 1 && opts.spike) ? spikeBlock(opts.spike, opts.spikeRecord, row, co) : '';
    const news = (row.kind !== 'past' && row.k === 1 && opts.news?.length)
        ? `<div class="fc-news"><div class="fc-sub">Latest headlines (for context: the range does not use news)</div>${opts.news.slice(0, 3).map(n =>
            `<a href="${esc(n.url || '#')}" target="_blank" rel="noopener">${esc(n.title)}</a><span>${esc(n.source || '')}</span>`).join('')}</div>` : '';
    return `
        <details class="fc-day fc-${row.kind}">
            <summary>
                <span class="fc-day-label">${dayLabel(row.date, today)}</span>
                <span class="fc-day-bar">${has ? seg(row.low, row.high, 'fc-pred') : ''}${actual}${outside}${now}</span>
                <span class="fc-day-nums">${has ? `${fmtPriceTag(row.low, co)} to ${fmtPriceTag(row.high, co)}` : 'no range'}</span>
                ${verdict || spikeFlag}
            </summary>
            <div class="fc-day-body">
                ${has ? `<div class="fc-pred-line">Expected: low <b>${fmtPriceTag(row.low, co)}</b>, high <b>${fmtPriceTag(row.high, co)}</b>.</div>` : ''}
                ${conf != null && row.kind !== 'past' ? `<div class="fc-conf-line"><b>${conf}%</b> chance the day's high and low both land inside this range.</div>` : ''}
                ${row.kind === 'today' && Number.isFinite(row.actualLow) ? `<div class="fc-conf-line">So far today: ${fmtPriceTag(row.actualLow, co)} to ${fmtPriceTag(row.actualHigh, co)}.</div>` : ''}
                ${Number.isFinite(row.liveF) ? `<div class="fc-conf-line">Updated live: ${Math.round(row.liveF * 100)}% of the session is left to trade, so the rest of the day can only move so far. Before the open the range was ${fmtPriceTag(row.morningLow, co)} to ${fmtPriceTag(row.morningHigh, co)}.</div>` : ''}
                ${spikeHtml}
                <div class="fc-sub">Why</div>
                <ul>${why.map(t => `<li>${t}</li>`).join('')}</ul>
                ${news}
            </div>
        </details>`;
}

/**
 * The rows for this week and next.
 * history: buildBandHistory() output (past sessions, locked or replayed); band: the live band with
 * an anchor; todayBar: today's partial daily bar while the session runs.
 */
export function weekRows({ band, history, region, cryptoMode, todayBar = null, live = null, price = null, nowMs = Date.now() }) {
    const today = cryptoMode ? new Date(nowMs).toISOString().slice(0, 10) : exchangeToday(region, nowMs);
    if (!today) return null;
    const dates = bandRowDates(band, region, cryptoMode);
    const byDate = new Map(dates.map((d, i) => [d, { ...band.days[i], k: i + 1 }]));
    const past = new Map((history?.rows || []).map(r => [r.date, r]));
    const tradingToday = !!(live && todayBar && Number.isFinite(todayBar.high) && byDate.has(today));
    // The days AFTER a session that is trading start from the live price, not the close the band
    // was built on: DOCN fell 14% on 2026-10-14 and its next session still read $116 to $141 from
    // the 10-13 close, with the stock at $110. From now, day k is (k-2) full sessions, the f of
    // today still to trade, and day k's own range away, so its width sits between the calibrated
    // widths for k-1 and k sessions: interpolated in variance, exact at the close (f = 0, the
    // horizon k-1 band from today's close) and at the open (f = 1, the original).
    const A = band.anchor?.price;
    const fromNow = (k) => {
        if (!tradingToday || !(price > 0) || !(A > 0) || !(k >= 2)) return null;
        const a = band.days[k - 2], b = band.days[k - 1];
        if (!a || !b) return null;
        const up1 = Math.log(a.high / A), up2 = Math.log(b.high / A), dn1 = Math.log(A / a.low), dn2 = Math.log(A / b.low);
        if (![up1, up2, dn1, dn2].every(v => Number.isFinite(v) && v > 0)) return null;
        const f = Math.min(1, Math.max(0, live.f));
        const wu = Math.sqrt(up1 * up1 + f * Math.max(0, up2 * up2 - up1 * up1));
        const wd = Math.sqrt(dn1 * dn1 + f * Math.max(0, dn2 * dn2 - dn1 * dn1));
        return { low: price * Math.exp(-wd), high: price * Math.exp(wu), f };
    };
    const build = (iso) => {
        const f = iso >= today ? byDate.get(iso) : null;
        if (f) {
            const trading = iso === today && tradingToday;
            const lv = trading ? live : null;
            const moved = iso > today ? fromNow(f.k) : null;
            return { date: iso, kind: trading ? 'today' : 'future', k: f.k,
                     low: lv ? lv.low : moved ? moved.low : f.low, high: lv ? lv.high : moved ? moved.high : f.high,
                     morningLow: lv || moved ? f.low : null, morningHigh: lv || moved ? f.high : null,
                     liveF: lv ? lv.f : null, fromPrice: moved ? price : null, fromF: moved ? moved.f : null,
                     confidence: lv ? lv.confidence : band.confidence,
                     actualLow: trading ? todayBar.low : null, actualHigh: trading ? todayBar.high : null };
        }
        const p = past.get(iso);
        if (p) {
            return { date: iso, kind: 'past', low: p.predLow, high: p.predHigh, actualLow: p.actualLow,
                     actualHigh: p.actualHigh, met: p.met, brokeSide: p.brokeSide, source: p.source };
        }
        return iso < today ? null : { date: iso, kind: 'future', low: null, high: null, k: null };
    };
    const thisWeek = weekOf(today, region, cryptoMode).map(build).filter(Boolean);
    const nextWeek = weekOf(addDays(today, 7), region, cryptoMode).map(build).filter(Boolean);
    return { today, thisWeek, nextWeek };
}

/**
 * The band to show: the locked one, unless the live one starts from a newer close. After today's
 * close the lock still starts from yesterday's, and every day after today would read from a price
 * two sessions old.
 */
export function freshestBand(locked, live) {
    const a = locked?.anchor?.session, b = live?.anchor?.session;
    if (b && (!a || b > a)) return live;
    return a ? locked : (live || locked || null);
}

/**
 * The range the big bar shows: today's (widened live by what has already traded) when today is a
 * session, else the next session's. Hot Picks reads it too, so a card and the symbol it opens can
 * never show two different ranges for the same day (DOCN on 2026-10-14 showed the band locked at
 * the 10-13 close, $119.99 to $136.99, beside a live $110 after a 14% fall).
 */
export function headlineRange({ band, price, region = 'NYSE', cryptoMode = false, todayBar = null, intraday = null,
                                history = null, next = false, nowMs = Date.now() }) {
    if (!band || !Array.isArray(band.days) || !band.days.length) return null;
    const live = liveToday({ intraday, band, price, todayBar, region: cryptoMode ? 'CRYPTO' : region, nowMs });
    const rows = band.anchor ? weekRows({ band, history, region, cryptoMode, todayBar, live, price, nowMs }) : null;
    // next: the first session after today (the Tomorrow view), else today's or the next one.
    const row = rows ? [...rows.thisWeek, ...rows.nextWeek].find(r => (next ? r.date > rows.today : r.kind === 'today') || (!next && r.kind === 'future')) : null;
    const d = row && Number.isFinite(row.low) ? row : { low: band.days[0].low, high: band.days[0].high, date: band.anchor?.day1 };
    return { low: d.low, high: d.high, date: d.date || null, today: rows?.today || null, rows,
             liveF: Number.isFinite(d.liveF) ? d.liveF : null, confidence: d.confidence ?? band.confidence };
}

function weekCard(title, rows, x, opts) {
    if (!rows.length) return '';
    const span = `${new Date(`${rows[0].date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} to ${new Date(`${rows[rows.length - 1].date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
    return `
        <div class="fc-card fc-week">
            <div class="fc-week-head"><span class="fc-week-title">${title}</span><span class="fc-week-span">${span}</span></div>
            <div class="fc-legend"><span class="fc-k fc-k-pred"></span>expected range <span class="fc-k fc-k-act"></span>where it traded <span class="fc-k fc-k-out"></span>outside <span class="fc-k fc-k-now"></span>price now</div>
            <div class="fc-days">${rows.map(r => dayRow(r, x, opts)).join('')}</div>
            <div class="fc-week-foot">Tap a day for what is expected, how sure the app is, and why. Market holidays are left out.</div>
        </div>`;
}

// ── public ───────────────────────────────────────────────────────────────────────────────────

/**
 * @returns {string} the three cards, or '' when there is no band to show.
 */
export function renderForecastCards({ symbol, band, history = null, rs = null, owned = null, price = null,
                                      currency = 'USD', region = 'NYSE', cryptoMode = false, todayBar = null,
                                      news = [], dirRec = null, setupsLive = null, intraday = null,
                                      spike = null, spikeRecord = null, gapRec = null, liquid = false,
                                      baseline = null } = {}) {
    if (!band || !Array.isArray(band.days) || !band.days.length) return '';
    const co = { srcCurrency: currency };
    const head = headlineRange({ band, price, region, cryptoMode, todayBar, intraday, history });
    const rows = head.rows;
    const gap = gapSignal({ rec: gapRec, band, todayBar, liquid, region: cryptoMode ? 'CRYPTO' : region });
    const call = decideCall({ rs, owned, setupsLive, gap });

    // Today's range on the big bar: the row for today when the session is today, else the next one.
    const d = head;
    const whenLabel = rows && d.date ? (d.date === rows.today ? (Number.isFinite(d.liveF) ? "Today's expected range, updated live" : "Today's expected range") : `Expected range, ${dayLabel(d.date, rows.today)}`) : "Next session's expected range";

    const evidence = callEvidence(call, rs, co, symbol, dirRec, baseline);
    const signalCard = `
        <div class="fc-card fc-signal fc-tone-${call.tone}" data-tone="${call.tone}" data-call="${call.kind}">
            <div class="fc-signal-head">
                <span class="fc-badge fc-badge-${call.kind.toLowerCase()}">${call.title}</span>
                ${call.confidence != null ? `<span class="fc-signal-conf"><b>${pct(call.confidence)}</b> measured</span>` : ''}
                ${owned == null ? '<span class="fc-own-hint">Own it? Add it to your portfolio and this switches to HOLD or SELL.</span>' : ''}
            </div>
            <div class="fc-signal-line">${call.line}</div>
            <div class="fc-when">${whenLabel} <span>· ${band.confidence}% chance the price stays inside</span></div>
            ${bigBar({ low: d.low, high: d.high, price, co })}
            <details class="fc-why"><summary>Why this call</summary><ul>${evidence.map(t => `<li>${t}</li>`).join('')}</ul></details>
        </div>`;

    if (!rows) return signalCard;
    const all = [...rows.thisWeek, ...rows.nextWeek];
    const x = scale([...all.flatMap(r => [r.low, r.high, r.actualLow, r.actualHigh]), price]);
    if (!x) return signalCard;
    const opts = { co, today: rows.today, price, band, earningsDay: band.earningsDay ?? null, symbol,
                   sigma: band.sigmaDaily, tier: band.volTier, news, spike, spikeRecord };
    return signalCard
        + weekCard('This week', rows.thisWeek, x, opts)
        + weekCard('Next week', rows.nextWeek, x, opts);
}

/** Today's partial bar while the session runs, else null. */
export function todayPartialBar(candles, region, nowMs = Date.now()) {
    const c = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
    if (!c || !Number.isFinite(c.time)) return null;
    const iso = barSessionDate(region, c.time);
    const today = region === 'CRYPTO' ? new Date(nowMs).toISOString().slice(0, 10) : exchangeToday(region, nowMs);
    return iso === today && c.high > 0 && c.low > 0 ? { high: c.high, low: c.low, open: c.open } : null;
}

let _gapRec = null;
let _gapPromise = null;
/** model/gap_fade.json (tools/calibrate_gap_fade.py), memoised. */
export async function loadGapRecord() {
    if (_gapRec !== null) return _gapRec || null;
    if (_gapPromise) return _gapPromise;
    _gapPromise = (async () => {
        try {
            const r = await fetch('model/gap_fade.json', { cache: 'no-cache' });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('not json');
            const j = await r.json();
            _gapRec = j && j.n ? j : false;
        } catch (_) { _gapRec = false; }
        return _gapRec || null;
    })();
    return _gapPromise;
}
