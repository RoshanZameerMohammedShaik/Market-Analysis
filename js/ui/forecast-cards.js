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
import { bandDates, exchangeToday, barSessionDate } from '../earnings-calendar-slice.js';
import { isSession } from '../market-sessions.js';

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
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
export function decideCall({ rs = null, owned = null, setupsLive = null } = {}) {
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
                + `${pct(rs.cell.hitRate)} of ${rs.cell.n.toLocaleString()} like it closed back above the 5-day average within 10 sessions.` };
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
                + `${pct(pending.hitRate ?? rs?.cell?.hitRate ?? 0)} of setups like it closed back above the 5-day average within 10 sessions.` };
    }
    // 4. A trade from an earlier day is still running.
    if (open) {
        return { ...base, kind: own ? 'HOLD' : 'DONT_BUY', tone: own ? 'up' : 'flat', confidence: own ? (open.hitRate ?? null) : null, source: 'setup-open', entry: open,
            title: own ? 'HOLD' : "DON'T BUY",
            line: own
                ? 'A dip-recovery trade is still open: it sells after the first close above the 5-day average, or after 10 sessions.'
                : `This setup's entry was the ${shortDay(open.entryDate)} open. Buying later is not the measured trade.` };
    }
    return { ...base, kind: own ? 'HOLD' : 'DONT_BUY', tone: 'flat', confidence: null, source: 'none',
        title: own ? 'HOLD' : "DON'T BUY",
        line: own ? 'No sell signal: nothing with a measured record points down today.'
            : 'No buy signal: nothing with a measured record points up today.' };
}

function shortDay(iso) {
    if (!iso) return 'last';
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function callEvidence(call, rs, co, symbol, dirRec) {
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
            ? `Price ${fmtPriceTag(rs.price, co)} is above its 200-day average ${fmtPriceTag(rs.ma200, co)}: an uptrend, where dips have recovered.`
            : `Price ${fmtPriceTag(rs.price, co)} is below its 200-day average ${fmtPriceTag(rs.ma200, co)}: a downtrend, where this setup does not hold.`);
    }
    if (rs && rs.eligible === false && rs.reason) items.push(`Setup not available: ${esc(rs.reason)}.`);
    const c = rs?.cell;
    if (c && ['setup', 'setup-pending', 'setup-open'].includes(call.source)) {
        items.push(`Track record for this volatility and market mood: ${pct(c.hitRate)} of ${c.n.toLocaleString()} setups recovered, `
            + `average ${(c.netBps / 100).toFixed(2)}% per trade after costs, positive in ${c.positiveYears} of ${c.years} years.`);
        if (rs.heldOut) items.push(`On 2023 to 2026, years the rule was not fitted on: ${pct(rs.heldOut.hitRate)} of ${rs.heldOut.n.toLocaleString()}.`);
        if (Number.isFinite(rs.trigger)) items.push(`It sells at the open after the first close above the 5-day average (now ${fmtPriceTag(rs.trigger, co)}), or after 10 sessions. No stop: every stop tested lost money on this pattern.`);
    }
    if (call.live?.n) {
        items.push(`Live since ${shortDay(call.live.since)}: ${call.live.wins} of ${call.live.n} published setups recovered (${pct(call.live.hitRate)}).`);
    }
    if (dirRec?.n >= 30) {
        items.push(`Plain "up or down tomorrow" calls are right ${pct(dirRec.hitRate)} of the time on ${dirRec.n.toLocaleString()} live calls, so they never make this call.`);
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
    if (Number.isFinite(sigma)) {
        items.push(`How much this stock has been moving: about ±${sigma.toFixed(2)}% a day over the last 30 sessions (${esc(tier || '')} volatility). This is the main input.`);
    }
    if (k > 1) items.push(`${k} sessions ahead: the range widens with each session because the uncertainty adds up.`);
    if (earningsDay > 0 && k >= earningsDay) {
        items.push(`Earnings move ${k === earningsDay ? 'this session' : 'an earlier session in this window'}, so it uses the much wider range measured on earnings weeks. <a href="https://finance.yahoo.com/calendar/earnings?symbol=${encodeURIComponent(symbol)}" target="_blank" rel="noopener">Earnings calendar</a>`);
    } else if (earningsDay === 0) {
        items.push('No earnings fall in this window (checked against the earnings calendar).');
    }
    items.push(`The width is set so the day's high and low both stay inside ${band.confidence}% of the time, measured on past prices of stocks this volatile, not assumed from a formula.`);
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
    const verdict = row.kind === 'past'
        ? (row.met ? '<span class="fc-v fc-v-in">held</span>' : '<span class="fc-v fc-v-out">broke</span>')
        : row.kind === 'today' ? '<span class="fc-v fc-v-live">today</span>' : '';
    const conf = Number.isFinite(row.confidence) ? row.confidence : null;
    const why = dayWhy({ row: { ...row, co }, band: opts.band, k: row.k, earningsDay: opts.earningsDay,
        symbol: opts.symbol, sigma: opts.sigma, tier: opts.tier });
    const news = (row.kind !== 'past' && row.k === 1 && opts.news?.length)
        ? `<div class="fc-news"><div class="fc-sub">Latest headlines (for context: the range does not use news)</div>${opts.news.slice(0, 3).map(n =>
            `<a href="${esc(n.url || '#')}" target="_blank" rel="noopener">${esc(n.title)}</a><span>${esc(n.source || '')}</span>`).join('')}</div>` : '';
    return `
        <details class="fc-day fc-${row.kind}">
            <summary>
                <span class="fc-day-label">${dayLabel(row.date, today)}</span>
                <span class="fc-day-bar">${has ? seg(row.low, row.high, 'fc-pred') : ''}${actual}${outside}${now}</span>
                <span class="fc-day-nums">${has ? `${fmtPriceTag(row.low, co)} to ${fmtPriceTag(row.high, co)}` : 'no range'}</span>
                ${verdict}
            </summary>
            <div class="fc-day-body">
                ${has ? `<div class="fc-pred-line">Expected: low <b>${fmtPriceTag(row.low, co)}</b>, high <b>${fmtPriceTag(row.high, co)}</b>.</div>` : ''}
                ${conf != null && row.kind !== 'past' ? `<div class="fc-conf-line"><b>${conf}%</b> chance the day's high and low both land inside this range.</div>` : ''}
                ${row.kind === 'today' && Number.isFinite(row.actualLow) ? `<div class="fc-conf-line">So far today: ${fmtPriceTag(row.actualLow, co)} to ${fmtPriceTag(row.actualHigh, co)}.</div>` : ''}
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
export function weekRows({ band, history, region, cryptoMode, todayBar = null }) {
    const today = cryptoMode ? new Date().toISOString().slice(0, 10) : exchangeToday(region);
    if (!today) return null;
    const dates = bandRowDates(band, region, cryptoMode);
    const byDate = new Map(dates.map((d, i) => [d, { ...band.days[i], k: i + 1 }]));
    const past = new Map((history?.rows || []).map(r => [r.date, r]));
    const build = (iso) => {
        const f = iso >= today ? byDate.get(iso) : null;
        if (f) {
            const live = iso === today && todayBar && Number.isFinite(todayBar.high);
            return { date: iso, kind: live ? 'today' : 'future', low: f.low, high: f.high, k: f.k,
                     confidence: band.confidence, actualLow: live ? todayBar.low : null, actualHigh: live ? todayBar.high : null };
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
                                      news = [], dirRec = null, setupsLive = null } = {}) {
    if (!band || !Array.isArray(band.days) || !band.days.length) return '';
    const co = { srcCurrency: currency };
    const rows = band.anchor ? weekRows({ band, history, region, cryptoMode, todayBar }) : null;
    const call = decideCall({ rs, owned, setupsLive });

    // Today's range on the big bar: the row for today when the session is today, else the next one.
    const todayRow = rows ? [...rows.thisWeek, ...rows.nextWeek].find(r => r.kind === 'today' || r.kind === 'future') : null;
    const d = todayRow && Number.isFinite(todayRow.low) ? todayRow : { low: band.days[0].low, high: band.days[0].high, date: band.anchor?.day1 };
    const whenLabel = rows && d.date ? (d.date === rows.today ? "Today's expected range" : `Expected range, ${dayLabel(d.date, rows.today)}`) : "Next session's expected range";

    const evidence = callEvidence(call, rs, co, symbol, dirRec);
    const signalCard = `
        <div class="fc-card fc-signal fc-tone-${call.tone}">
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
                   sigma: band.sigmaDaily, tier: band.volTier, news };
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
    return iso === today && c.high > 0 && c.low > 0 ? { high: c.high, low: c.low } : null;
}
