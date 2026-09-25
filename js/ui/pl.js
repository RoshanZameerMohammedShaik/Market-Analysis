import { fmt } from './format.js';
import { state } from './state.js';
import { format as fmtCurrency } from '../currency.js';
import { roundPrice } from '../price-round.js';
import { PLANS, DEFAULT_PLAN, planTrade, quotedHalfSpreadPct } from '../trading-costs.js';

// The broker and order type persist: they describe the user's account, not one calculation, and
// re-picking "IBKR Pro Tiered" every time would just train people to leave it on the default.
const PLAN_KEY = 'ma-pl-plan';
const ORDER_KEY = 'ma-pl-order';

export function getPLPrefs() {
    let plan = DEFAULT_PLAN, orderType = 'limit';
    try {
        const p = localStorage.getItem(PLAN_KEY);
        if (p && PLANS[p]) plan = p;
        const o = localStorage.getItem(ORDER_KEY);
        if (o === 'limit' || o === 'market') orderType = o;
    } catch (_) { /* private mode: defaults */ }
    return { plan, orderType };
}

export function setPLPrefs({ plan, orderType } = {}) {
    try {
        if (plan && PLANS[plan]) localStorage.setItem(PLAN_KEY, plan);
        if (orderType === 'limit' || orderType === 'market') localStorage.setItem(ORDER_KEY, orderType);
    } catch (_) {}
    syncControls();
}

function syncControls() {
    const { plan, orderType } = getPLPrefs();
    const sel = document.getElementById('pl-plan');
    if (sel) sel.value = plan;
    document.querySelectorAll('#pl-orderType [data-v]').forEach(b => {
        const on = b.dataset.v === orderType;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
}

/**
 * THE calculation, shared by the panel and by Mia's pl_calculate tool.
 *
 * One function on purpose. Mia's tool used to recompute the result itself (shares x move, gross),
 * so the moment the panel started showing a NET figure she would have reported a different number
 * from the one on screen. Two derivations of one displayed value is the bug this project keeps
 * paying for.
 *
 * Uses the LIVE quoted spread for market orders when the app has a fresh Public quote for the
 * current symbol AND the entered buy price is within 5% of it. Otherwise it estimates, and says so:
 * applying AAPL's spread to a hypothetical $10.90 stock the user typed in would be a fabrication.
 */
export async function computePL({ investment, buyPrice, sellPrice, targetNetUSD, plan, orderType } = {}) {
    const prefs = getPLPrefs();
    plan = plan && PLANS[plan] ? plan : prefs.plan;
    orderType = orderType === 'market' || orderType === 'limit' ? orderType : prefs.orderType;
    const crypto = state.mode === 'crypto';

    let liveHalfSpreadPct = null;
    let liveQuote = null;
    if (orderType === 'market' && !crypto && state.currentSymbol) {
        try {
            const pricing = await import('../portfolio/pricing.js');
            const q = await pricing.fetchLiveQuote(state.currentSymbol);
            if (q && q.bid > 0 && q.ask >= q.bid) {
                const mid = (q.bid + q.ask) / 2;
                if (Math.abs(Number(buyPrice) - mid) / mid <= 0.05) {
                    liveHalfSpreadPct = quotedHalfSpreadPct(q.bid, q.ask);
                    if (liveHalfSpreadPct != null) liveQuote = { symbol: state.currentSymbol, bid: q.bid, ask: q.ask };
                }
            }
        } catch (_) { /* pricing unavailable: estimate */ }
    }

    const r = planTrade({
        buyPrice, sellPrice, investment, targetNetUSD,
        plan, orderType, crypto, liveHalfSpreadPct,
    });
    r.liveQuote = liveQuote;
    return r;
}

export function initPLCalculator() {
    const calcBtn = document.getElementById('pl-calcBtn');
    if (!calcBtn) return;
    calcBtn.addEventListener('click', calculatePL);
    document.getElementById('pl-sidebar').addEventListener('keydown', e => {
        // Enter on a focused toggle button must not ALSO fire a calculation.
        if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') calculatePL();
    });

    const useBtn = document.getElementById('pl-useCurrent');
    if (useBtn) wireUseCurrent(useBtn);

    // Broker + order type controls. Populated from the cost model so the list cannot drift from the
    // plans the calculator actually knows how to charge.
    const sel = document.getElementById('pl-plan');
    if (sel && !sel.options.length) {
        sel.innerHTML = Object.entries(PLANS)
            // Label only: with the fee note appended the text truncated mid-number in a 360px panel
            // ("IBKR Pro · Tiered ($0.0035/"). The note is spelled out under the result instead,
            // and on hover here.
            .map(([k, v]) => `<option value="${k}" title="${v.note}">${v.label}</option>`).join('');
    }
    syncControls();
    const recalcIfShowing = () => {
        if (document.getElementById('pl-result')?.classList.contains('show')) calculatePL();
    };
    sel?.addEventListener('change', () => { setPLPrefs({ plan: sel.value }); recalcIfShowing(); });
    document.getElementById('pl-orderType')?.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        setPLPrefs({ orderType: b.dataset.v });
        recalcIfShowing();
    });
}

// Tap = fill Current/Target Price (existing behavior).
// Long-press (>=3000ms) = fill Purchase Price per Share instead.
// Same gesture pattern Mia's send button uses for clear-chat.
const HOLD_MS = 3000;

function wireUseCurrent(btn) {
    let holdTimer = null;
    let holdState = 'idle';     // 'idle' | 'pressing' | 'firing'
    let armed = false;

    const textEl = btn.querySelector('.pl-uc-text') || btn;
    const origText = textEl.textContent;

    // Match the SVG ring's corner radius to the button's actual rendered
    // border-radius. SVG rx="999" or "50%" don't clamp consistently across
    // browsers/versions, so we measure once at init (and on resize) and
    // set the rect's rx/ry explicitly.
    const ringRect = btn.querySelector('.pl-uc-ring-fg');
    const updateRingShape = () => {
        if (!ringRect) return;
        const h = btn.getBoundingClientRect().height;
        if (!h) return;
        // Plus 2 because the SVG sits 1px outside the button on each side.
        const r = (h + 2) / 2;
        ringRect.setAttribute('rx', String(r));
        ringRect.setAttribute('ry', String(r));
    };
    updateRingShape();
    // Re-measure if the panel was hidden when first init'd.
    new ResizeObserver(updateRingShape).observe(btn);

    const fillInto = (inputId, label) => {
        const input = document.getElementById(inputId);
        if (state.currentPrice == null) {
            const errEl = document.getElementById('pl-error');
            errEl.textContent = 'Select a stock or crypto first.';
            errEl.classList.add('show');
            setTimeout(() => errEl.classList.remove('show'), 2500);
            return;
        }
        // roundPrice, not toFixed(2). toFixed(2) filled SHIB and every other sub-penny asset in as
        // 0.00, which the calculator then rejects as a zero purchase price, so the button simply did
        // not work for a whole class of symbols.
        input.value = String(roundPrice(state.currentPrice));
        // Punchy "this field just got filled" pulse on the wrapper.
        input.classList.add('flash');
        setTimeout(() => input.classList.remove('flash'), 700);
        // Quick fire-pulse on the chip — confirms the action without
        // lingering for 1.4s like before.
        textEl.textContent = `→ ${label}`;
        btn.classList.remove('pl-uc-fired'); // restart if rapid-fire
        void btn.offsetWidth;
        btn.classList.add('pl-uc-fired');
        setTimeout(() => {
            textEl.textContent = origText;
            btn.classList.remove('pl-uc-fired');
        }, 700);
    };

    const start = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        holdState = 'pressing';
        armed = false;
        // Force a reflow before adding the class so the CSS animation always
        // restarts cleanly (without this, a second press in the same session
        // doesn't replay the ring animation).
        btn.classList.remove('pl-uc-pressing', 'pl-uc-fired');
        void btn.offsetWidth;
        btn.classList.add('pl-uc-pressing');
        holdTimer = setTimeout(() => {
            if (holdState !== 'pressing') return;
            armed = true;
            holdState = 'firing';
            fillInto('pl-buyPrice', 'Purchase');
        }, HOLD_MS);
    };
    const end = () => {
        if (holdState === 'pressing' && !armed) {
            // Quick tap — original behavior.
            fillInto('pl-currentPrice', 'Current');
        }
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        btn.classList.remove('pl-uc-pressing');
        holdState = 'idle';
    };
    const cancel = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        btn.classList.remove('pl-uc-pressing');
        holdState = 'idle';
    };

    btn.title = 'Tap: fill Current/Target Price.  Long-press: fill Purchase Price per Share.';

    // Pointer events handle mouse + touch + pen with one code path. We
    // capture the pointer on press so we keep getting events even if the
    // cursor strays off the chip during the 3-second hold — otherwise a
    // small wobble would cancel the press, which is brutal UX for a long
    // target.
    btn.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        start(e);
    });
    btn.addEventListener('pointerup', (e) => {
        try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
        end();
    });
    btn.addEventListener('pointercancel', cancel);
    // No mouseleave handler. Pointer capture means the user can drift the
    // cursor anywhere during the hold and the gesture still completes.
}

const money = (v) => fmtCurrency(Number(v) || 0);
const signed = (v) => (Number(v) < 0 ? '−' : '+') + fmtCurrency(Math.abs(Number(v) || 0));
const cost = (v) => (Number(v) > 0 ? '−' + fmtCurrency(Number(v)) : fmtCurrency(0));

async function calculatePL() {
    const errEl = document.getElementById('pl-error');
    const resEl = document.getElementById('pl-result');
    errEl.classList.remove('show');
    resEl.classList.remove('show', 'profit', 'loss', 'neutral');

    const num = (id) => {
        const raw = document.getElementById(id)?.value;
        return raw === '' || raw == null ? null : parseFloat(raw);
    };
    const investment = num('pl-investment');
    const buyPrice = num('pl-buyPrice');
    const sellPrice = num('pl-currentPrice');
    const targetNetUSD = num('pl-target');

    const bad = (v) => v != null && (Number.isNaN(v) || v < 0);
    if ([investment, buyPrice, sellPrice, targetNetUSD].some(bad)) {
        errEl.textContent = 'Please enter valid positive numbers.';
        errEl.classList.add('show');
        return;
    }
    if (!(buyPrice > 0) || !(sellPrice > 0)) {
        errEl.textContent = 'Enter a purchase price and a current / target price.';
        errEl.classList.add('show');
        return;
    }
    if (!(targetNetUSD > 0) && !(investment > 0)) {
        errEl.textContent = 'Enter an investment amount, or a target net profit to size the trade.';
        errEl.classList.add('show');
        return;
    }

    const r = await computePL({ investment, buyPrice, sellPrice, targetNetUSD });
    renderPLResult(r);
}

export function renderPLResult(r) {
    const errEl = document.getElementById('pl-error');
    const resEl = document.getElementById('pl-result');
    if (!r || !r.ok) {
        errEl.textContent = r?.error || 'Could not calculate.';
        errEl.classList.add('show');
        return;
    }
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    const sharesText = r.crypto
        ? fmt(r.shares, r.shares < 1 ? 6 : 4)
        : Math.round(r.shares).toLocaleString('en-US');
    const sellPrice = r.shares > 0 ? (r.capitalUSD + r.grossUSD) / r.shares : 0;

    const isProfit = r.netUSD > 0.004, isLoss = r.netUSD < -0.004;
    const type = isProfit ? 'profit' : isLoss ? 'loss' : 'neutral';

    if (r.target) {
        // Sized by target: the answer IS the share count.
        document.getElementById('pl-resIcon').textContent = '🎯';
        set('pl-resLabel', `To net ${money(r.target.wantUSD)}, buy`);
        set('pl-resAmount', `${sharesText} ${r.crypto ? 'units' : 'shares'}`);
        set('pl-resPct', `${money(r.capitalUSD)} of capital · nets ${signed(r.netUSD)}`);
    } else {
        document.getElementById('pl-resIcon').textContent = isProfit ? '📈' : isLoss ? '📉' : '➖';
        set('pl-resLabel', isProfit ? 'Net profit' : isLoss ? 'Net loss' : 'Break even');
        set('pl-resAmount', signed(r.netUSD));
        set('pl-resPct', `${r.netPct >= 0 ? '+' : ''}${fmt(r.netPct)}% on ${money(r.capitalUSD)}`);
    }

    set('pl-resShares', sharesText);
    set('pl-resCapital', money(r.capitalUSD));
    set('pl-resValue', money(r.shares * sellPrice));
    set('pl-resGross', signed(r.grossUSD));
    set('pl-resComm', cost(r.commissionBuyUSD + r.commissionSellUSD));
    set('pl-resReg', cost(r.regulatoryUSD));
    set('pl-resSpread', cost(r.spreadUSD));
    set('pl-resImpact', cost(r.impactUSD));
    show('pl-rowSpread', r.orderType === 'market');
    show('pl-rowImpact', r.orderType === 'market');
    set('pl-resCosts', `${cost(r.totalCostUSD)}${r.costShareOfGrossPct != null ? ` · ${fmt(r.costShareOfGrossPct, 1)}% of gross` : ''}`);
    set('pl-resBreakEven', fmtCurrency(roundPrice(r.breakEvenSell)));

    // One plain sentence on what the numbers assume. Every one of these is a question that came up
    // while doing this math by hand.
    const plan = PLANS[r.plan];
    const notes = [];
    if (r.crypto) {
        notes.push('Stock commission plans and SEC/FINRA fees do not apply to crypto; check your venue fee.');
    } else {
        notes.push(`${plan.label}: ${plan.note}.`);
        if (r.plan.startsWith('ibkr-pro')) {
            notes.push('IBKR Pro also passes exchange and clearing fees (roughly ±$0.003/share, depending on whether your order adds or removes liquidity), not included.');
        }
    }
    if (r.orderType === 'limit') {
        notes.push('Limit orders pay no spread, but a sell at your target only fills if the bid reaches it.');
    } else if (r.liveQuote) {
        notes.push(`Spread from the live quote on ${r.liveQuote.symbol}: bid ${fmtCurrency(r.liveQuote.bid)} / ask ${fmtCurrency(r.liveQuote.ask)}.`);
    } else {
        notes.push(`Spread estimated for a ${fmtCurrency(roundPrice(r.capitalUSD / r.shares))} ${r.crypto ? 'coin' : 'stock'} (no live quote for these prices).`);
    }
    set('pl-resNote', notes.join(' '));

    resEl.classList.add(type);
    requestAnimationFrame(() => resEl.classList.add('show'));
}
