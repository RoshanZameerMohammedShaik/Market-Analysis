// Mia 2.0's auto-trading desk, rendered inside the Portfolio panel.
//
// WHAT THIS IS
// ------------
// Mia trades a $25,000 paper account on a cron in GitHub Actions, not in this tab. This
// module is a READER: it fetches the slice that tools/write_bot_slice.py publishes and
// draws it. Nothing here decides, sizes or executes anything, and there is deliberately no
// write path -- a browser that could edit the desk's history would destroy the only thing
// the desk is for.
//
// THE TIMELINE IS THE PRODUCT
// ---------------------------
// Roshan's ask was not "a bot that trades". It was: show when it traded, why, on what
// basis and strategy, and the P/L at each point. So every fill renders as an entry that
// answers all five, and the evidence that drove it is one tap away rather than hidden in a
// log. A bot whose reasoning you cannot audit is indistinguishable from a random number
// generator that got lucky.
//
// WHY IT SHOWS UP EVEN WITH NO PRACTICE PORTFOLIO
// -----------------------------------------------
// Mia's book and the hand-traded practice portfolio are separate ledgers on purpose (see
// bot/portfolio.py): hers lives in the repo, the user's lives in localStorage, and she can
// never liquidate a position he opened. So the desk renders whether or not a practice
// portfolio exists, and the combined figure is shown as an explicit sum of two named books
// rather than one blended number that hides which money is whose.

const SLICE_URL = 'model/bot/timeline.json';

// How many timeline entries to draw before "Show more". The slice ships 200; rendering all
// of them into a 420px panel on open is wasted layout for rows nobody scrolls to.
const PAGE = 12;

// A run older than this means the cron is not running. The schedule is hourly, and Actions
// routinely delays scheduled runs by 10-30 minutes, so the threshold has to tolerate that
// without crying wolf. Three hours is two missed slots: late is normal, absent is not.
const STALE_AFTER_MIN = 180;

// How far ahead of buy-and-hold a sleeve must be, in percentage points, before it gets the
// "beats benchmark" badge.
//
// Zero was wrong and the first screenshot proved it: on day one every sleeve was down about
// 0.05% purely from the cost of entering, and two of them were awarded "beats benchmark" for
// leading by less than a thousandth of a percent. That is cost noise presented as a finding,
// which is the exact failure mode that let this project believe it had 71.6% accuracy for
// months. The badge has to mean something or it should not exist.
//
// 0.25pp is not derived from anything: it is simply wider than the round-trip cost spread
// between sleeves, so the badge cannot fire on execution noise alone. Nothing about it says
// the lead is statistically significant, and over 996,541 predictions this engine's measured
// edge was zero, so the badge is a description of the record so far and not a claim.
const MEANINGFUL_MARGIN_PP = 0.25;

let slice = null;
let shown = PAGE;
let loadState = 'idle';      // idle | loading | ready | error | absent
let loadError = '';
let practiceUSD = null;      // pushed in by portfolio-panel.js; see setPracticeTotalUSD

export function initMiaDesk() {
    const host = document.getElementById('mia-desk');
    if (!host) return;
    render();
    load();
    host.addEventListener('click', onClick);
}

/** Called by portfolio-panel.js whenever its own total changes.
 *
 *  Pushed in rather than imported, because the desk drawing the practice portfolio's live
 *  total would mean importing portfolio-panel while portfolio-panel imports this module.
 *  One-directional data flow avoids a circular import for the sake of one number. */
export function setPracticeTotalUSD(usd) {
    practiceUSD = Number.isFinite(usd) ? usd : null;
    patchCombined();
}

async function load() {
    loadState = 'loading';
    render();
    try {
        // Bucketed cache-buster. The desk commits at most once an hour, so a per-minute
        // buster would defeat the CDN cache for no benefit while a fully cached URL could
        // serve a stale timeline for hours.
        const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
        const res = await fetch(`${SLICE_URL}?v=${bucket}`, { cache: 'no-cache' });

        // Cloudflare Pages' SPA fallback answers a MISSING file with HTTP 200 and the
        // contents of index.html, so res.ok proves nothing. The content type is the only
        // reliable tell, and this exact trap already produced one wrong "the deploy is
        // fine" conclusion.
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !ctype.includes('json')) {
            loadState = 'absent';
            loadError = !res.ok
                ? `HTTP ${res.status}`
                : `served ${ctype || 'an unknown type'} instead of JSON (the file is probably not deployed yet)`;
            render();
            return;
        }
        slice = await res.json();
        loadState = 'ready';
    } catch (err) {
        loadState = 'error';
        loadError = err.message || String(err);
    }
    render();
}

function onClick(e) {
    const entry = e.target.closest('.desk-entry-head');
    if (entry) {
        const card = entry.closest('.desk-entry');
        card.classList.toggle('open');
        entry.setAttribute('aria-expanded', card.classList.contains('open') ? 'true' : 'false');
        return;
    }
    if (e.target.closest('#desk-more')) {
        shown += PAGE;
        render();
        return;
    }
    if (e.target.closest('#desk-retry')) {
        load();
    }
}

// ── render ────────────────────────────────────────────────────────────────

function render() {
    const host = document.getElementById('mia-desk');
    if (!host) return;

    if (loadState === 'loading' || loadState === 'idle') {
        host.innerHTML = shell(`<div class="desk-msg">Reading Mia's desk…</div>`);
        return;
    }
    if (loadState === 'absent' || loadState === 'error') {
        // Says WHICH failure it was. "Couldn't load" would leave no way to tell a desk that
        // has never run from one whose slice failed to deploy, and those need different
        // fixes.
        host.innerHTML = shell(`
            <div class="desk-msg">
                <p>Mia hasn't published a desk yet${loadError ? ` (${escapeHtml(loadError)})` : ''}.</p>
                <p class="desk-msg-sub">She trades on a schedule in the cloud, so this fills
                in on her next run. Nothing is wrong with your portfolio.</p>
                <button class="portfolio-action-btn" id="desk-retry" type="button">Try again</button>
            </div>`);
        return;
    }

    const t = slice.totals || {};
    const pnl = num(t.pnlUSD);
    const cls = pnl >= 0 ? 'pos' : 'neg';
    const runs = slice.runs || [];
    const last = runs[0];
    const stale = isStale(last);

    host.innerHTML = shell(`
        <div class="desk-hero">
            <div class="desk-hero-main">
                <span class="desk-hero-label">Mia's equity</span>
                <span class="desk-hero-value">${money(t.equityUSD)}</span>
                <span class="desk-hero-pnl ${cls}">
                    ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}
                    <span class="desk-hero-pct">(${signed(num(t.pnlPct), 2)}%)</span>
                </span>
            </div>
            ${sparkline(slice.equityCurve || [])}
        </div>

        <div class="desk-pills">
            ${pill('Cash', money(t.cashUSD))}
            ${pill('Positions', money(t.holdingsUSD))}
            ${pill('Realized', money(t.realizedUSD))}
            ${pill('Costs paid', money(t.feesUSD), 'Spread crossed plus commission and regulatory fees. Charged on every fill, because a desk that fills at the midpoint for free is reporting profits it could not have captured.')}
            ${pill('Fills', String(t.trades ?? 0))}
            ${pill('Seed', money(slice.seedUSD))}
        </div>

        <div class="desk-heartbeat ${stale ? 'stale' : ''}">
            <span class="desk-hb-dot" aria-hidden="true"></span>
            ${last
                ? `Last run ${escapeHtml(fmtRelative(last.ts))}${last.openMarkets?.length
                    ? ` &middot; ${escapeHtml(last.openMarkets.join(', '))} open` : ' &middot; all markets closed'}
                   ${stale ? '<strong>&middot; overdue</strong>' : ''}`
                : 'No runs recorded yet'}
        </div>
        ${stale ? `<p class="desk-note">Her schedule is hourly. A gap this long usually means
            the scheduled job was delayed or skipped, which GitHub Actions does under load.
            The timeline below is still accurate for the runs that did happen.</p>` : ''}

        ${combinedRow(t)}
        ${leaderboard()}
        ${timeline()}
    `);
}

function shell(inner) {
    return `
        <div class="desk-head">
            <span class="desk-title">Mia 2.0 <span class="desk-title-sub">Auto-Trading Desk</span></span>
            <span class="desk-badge" title="Simulated money. No real orders are ever placed.">PAPER</span>
        </div>
        ${inner}`;
}

/** The two books, named, plus their sum. Never one blended number: it must stay obvious
 *  which money Mia moved and which money the user moved by hand. */
function combinedRow(t) {
    return `
        <div class="desk-combined" id="desk-combined">
            <div class="desk-combined-row">
                <span>Mia's desk</span><span class="num">${money(t.equityUSD)}</span>
            </div>
            <div class="desk-combined-row" data-role="practice">
                <span>Your practice portfolio</span>
                <span class="num">${practiceUSD == null ? 'not loaded' : money(practiceUSD)}</span>
            </div>
            <div class="desk-combined-row total">
                <span>Combined</span>
                <span class="num" data-role="combined">${money(num(t.equityUSD) + (practiceUSD || 0))}</span>
            </div>
        </div>`;
}

// Patch just the two affected cells rather than re-rendering. A price tick fires this
// often, and rebuilding the section would collapse every entry the user had expanded.
function patchCombined() {
    const box = document.getElementById('desk-combined');
    if (!box || !slice) return;
    const p = box.querySelector('[data-role="practice"] .num');
    const c = box.querySelector('[data-role="combined"]');
    if (p) p.textContent = practiceUSD == null ? 'not loaded' : money(practiceUSD);
    if (c) c.textContent = money(num((slice.totals || {}).equityUSD) + (practiceUSD || 0));
}

function leaderboard() {
    const rows = slice.leaderboard || [];
    if (!rows.length) return '';
    // The control sleeve is the bar, not a competitor. A strategy that beat its own seed
    // while losing to equal-weight buy-and-hold produced nothing but market exposure, and
    // presenting it as a winner would be the flattering-but-useless reading.
    const ctrl = rows.find(r => r.id === 'control');
    // Scale to the largest move actually present. The previous floor of 0.5 squashed a
    // day-one book -- where every sleeve is down ~0.05% purely from the cost of entering --
    // into four identical invisible slivers, which conveys nothing.
    const max = Math.max(...rows.map(r => Math.abs(num(r.pnlPct))), 0.01);
    return `
        <div class="desk-section">
            <h4 class="desk-h4">Strategy leaderboard</h4>
            <div class="desk-board">
                ${rows.map(r => {
                    const v = num(r.pnlPct);
                    const margin = ctrl && r.id !== 'control' ? v - num(ctrl.pnlPct) : null;
                    const beats = margin != null && margin >= MEANINGFUL_MARGIN_PP;
                    return `
                    <div class="desk-board-row ${r.id === 'control' ? 'is-control' : ''}">
                        <span class="desk-board-name" title="${escapeHtml(r.blurb || '')}">
                            ${escapeHtml(r.name || r.id)}
                            ${r.id === 'control' ? '<em class="desk-board-tag">benchmark</em>' : ''}
                            ${beats ? `<em class="desk-board-tag win" title="Ahead of buy-and-hold by ${margin.toFixed(2)} percentage points">beats benchmark</em>` : ''}
                        </span>
                        <span class="desk-board-bar" aria-hidden="true">
                            <span class="desk-board-fill ${v >= 0 ? 'pos' : 'neg'}"
                                  style="width:${(Math.abs(v) / max * 50).toFixed(1)}%"></span>
                        </span>
                        <span class="desk-board-val ${v >= 0 ? 'pos' : 'neg'}">${signed(v, 2)}%</span>
                        <span class="desk-board-meta">${r.trades} fill${r.trades === 1 ? '' : 's'} &middot; ${r.positions} held${
                            margin != null ? ` &middot; ${signed(margin, 2)}pp vs benchmark` : ''}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
}

function timeline() {
    const all = slice.trades || [];
    const counts = slice.counts || {};
    if (!all.length) {
        return `
            <div class="desk-section">
                <h4 class="desk-h4">Timeline</h4>
                <p class="desk-msg-sub">No fills yet. Mia refuses trades that fail her risk
                limits, and a run that decides to do nothing is a decision too, not a
                failure.</p>
            </div>`;
    }
    const page = all.slice(0, shown);
    return `
        <div class="desk-section">
            <h4 class="desk-h4">Timeline
                <span class="desk-h4-count">${page.length} of ${counts.trades ?? all.length}</span>
            </h4>
            <div class="desk-timeline">${page.map(entry).join('')}</div>
            ${shown < all.length
                ? `<button class="portfolio-action-btn desk-more" id="desk-more" type="button">
                     Show ${Math.min(PAGE, all.length - shown)} more</button>`
                : ''}
        </div>`;
}

function entry(t) {
    const isBuy = t.action === 'BUY';
    const realized = t.realizedUSD;
    const hasRealized = Number.isFinite(realized);
    const cum = num(t.cumRealizedUSD);
    return `
        <article class="desk-entry">
            <button class="desk-entry-head" type="button" aria-expanded="false"
                    aria-label="Details for ${escapeHtml(t.action)} ${escapeHtml(t.symbol)}">
                <span class="desk-entry-line1">
                    <span class="desk-act ${isBuy ? 'buy' : 'sell'}">${escapeHtml(t.action)}</span>
                    <span class="desk-sym">${escapeHtml(t.symbol)}</span>
                    <span class="desk-notional">${money(t.notionalUSD)}</span>
                    ${hasRealized
                        ? `<span class="desk-realized ${realized >= 0 ? 'pos' : 'neg'}">${signed(realized, 2, true)}</span>`
                        : ''}
                    <span class="desk-caret" aria-hidden="true"></span>
                </span>
                <span class="desk-entry-line2">
                    <span class="desk-chip">${escapeHtml(t.sleeveName || t.sleeve)}</span>
                    <span class="desk-chip subtle">${escapeHtml(t.strategy || 'n/a')}</span>
                    <time datetime="${escapeHtml(t.ts || '')}">${escapeHtml(fmtRelative(t.ts))}</time>
                </span>
                <span class="desk-why">${escapeHtml(t.why || '')}</span>
            </button>
            <div class="desk-entry-body">
                <dl class="desk-kv">
                    ${kv('Units', fmtUnits(t.units))}
                    ${kv('Quoted price', money(t.refPriceUSD, 4))}
                    ${kv('Filled at', money(t.fillPriceUSD, 4),
                         'A buy lifts the offer and a sell hits the bid, so the fill is always worse than the quote. Booking fills at the midpoint is how a losing system shows a profit.')}
                    ${kv('Spread cost', money(t.spreadCostUSD, 4))}
                    ${kv('Commission', money(t.commissionUSD, 4))}
                    ${kv('Regulatory', money(t.regulatoryUSD, 4),
                         'SEC Section 31 and FINRA TAF. Both are charged on SELLS only, which is why buys show zero.')}
                    ${kv('Total cost', money(t.totalCostUSD, 4))}
                    ${hasRealized ? kv('Realized on this fill', signed(realized, 2, true)) : ''}
                    ${Number.isFinite(t.costBasisUSD) ? kv('Cost basis sold', money(t.costBasisUSD, 2), 'FIFO: the oldest lots are consumed first.') : ''}
                    ${kv('Realized to date', signed(cum, 2, true), 'Running total across every fill in the log, not just the ones shown.')}
                    ${kv('Account', `${escapeHtml(String(t.accountType || '').toUpperCase())}`,
                         'Cash accounts settle T+1 and cannot spend unsettled proceeds; margin accounts get Reg T buying power and accrue interest. Mia respects both.')}
                    ${kv('Market', escapeHtml(t.market || 'n/a'))}
                    ${kv('Conviction', `${(num(t.conviction) * 100).toFixed(0)}%`,
                         'How strongly the strategy wanted this trade. Drives position size.')}
                    ${kv('Cash left in sleeve', money(t.cashAfterUSD))}
                </dl>
                ${evidence(t.evidence)}
            </div>
        </article>`;
}

/** The basis for the decision, exactly as the strategy recorded it.
 *
 *  Rendered generically from whatever keys are present rather than from a fixed list: the
 *  four strategies record different evidence, and new ones will record more. A hardcoded
 *  field list would silently drop the reasoning of any strategy added later. */
function evidence(ev) {
    if (!ev || typeof ev !== 'object') return '';
    const keys = Object.keys(ev).filter(k => k !== 'rule');
    if (!keys.length) return '';
    return `
        <div class="desk-evidence">
            <span class="desk-evidence-label">Basis</span>
            <div class="desk-evidence-grid">
                ${keys.map(k => `
                    <span class="desk-ev-k">${escapeHtml(prettyKey(k))}</span>
                    <span class="desk-ev-v">${escapeHtml(fmtEvidence(ev[k]))}</span>`).join('')}
            </div>
        </div>`;
}

function sparkline(curve) {
    const pts = curve.filter(p => Number.isFinite(p.equityUSD));
    // One point is not a line. Drawing a flat stroke for a desk with a single run would
    // imply a history that does not exist yet.
    if (pts.length < 2) return '';
    const ys = pts.map(p => p.equityUSD);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = hi - lo || 1;
    const W = 120, H = 34;
    const d = pts.map((p, i) => {
        const x = (i / (pts.length - 1)) * W;
        const y = H - ((p.equityUSD - lo) / span) * H;
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    return `
        <svg class="desk-spark ${up ? 'pos' : 'neg'}" viewBox="0 0 ${W} ${H}"
             preserveAspectRatio="none" role="img"
             aria-label="Equity over the last ${pts.length} runs">
            <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
}

// ── small helpers ─────────────────────────────────────────────────────────

function pill(label, value, tip) {
    return `<span class="desk-pill"${tip ? ` title="${escapeHtml(tip)}"` : ''}>
        <span class="desk-pill-k">${escapeHtml(label)}</span>
        <span class="desk-pill-v">${escapeHtml(value)}</span></span>`;
}

function kv(k, v, tip) {
    return `<dt${tip ? ` title="${escapeHtml(tip)}"` : ''}>${escapeHtml(k)}${tip ? '<span class="desk-info" aria-hidden="true">?</span>' : ''}</dt><dd>${v}</dd>`;
}

function isStale(lastRun) {
    if (!lastRun?.ts) return true;
    const t = Date.parse(lastRun.ts);
    if (!Number.isFinite(t)) return true;
    return (Date.now() - t) / 60000 > STALE_AFTER_MIN;
}

/** Relative for recent entries, absolute beyond a day.
 *
 *  Not ui/format.js's timeAgo: that takes a Date object and would throw on the null or
 *  malformed timestamp a truncated log line can produce, and "6d ago" is the wrong unit for
 *  a trade log where the reader wants to line a fill up against a specific session. */
function fmtRelative(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return 'unknown time';
    const mins = (Date.now() - t) / 60000;
    if (mins < 0) return 'just now';           // clock skew between runner and browser
    if (mins < 1) return 'just now';
    if (mins < 60) return `${Math.round(mins)}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return new Date(t).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

function num(x) { return Number.isFinite(x) ? x : 0; }

function money(usd, dp = 2) {
    const v = Number(usd);
    if (!Number.isFinite(v)) return '—';
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function signed(v, dp = 2, asMoney = false) {
    const n = num(v);
    const body = asMoney ? money(Math.abs(n), dp) : Math.abs(n).toFixed(dp);
    return `${n >= 0 ? '+' : '−'}${body}`;
}

function fmtUnits(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 100) return v.toFixed(2);
    if (v >= 1) return v.toFixed(4);
    return v.toFixed(8);
}

function prettyKey(k) {
    // camelCase and snake_case both appear in evidence blocks depending on which side
    // wrote them (Python strategies vs the JS advisor).
    return k.replace(/_/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/^./, c => c.toUpperCase());
}

function fmtEvidence(v) {
    if (v == null) return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') {
        // Whole numbers stay whole; fractions get enough precision to be meaningful without
        // printing 15 digits of float noise.
        if (Number.isInteger(v)) return String(v);
        return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4);
    }
    if (Array.isArray(v)) return v.map(fmtEvidence).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
