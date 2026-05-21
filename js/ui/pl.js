import { fmt } from './format.js';
import { state } from './state.js';
import { format as fmtCurrency } from '../currency.js';

export function initPLCalculator() {
    const calcBtn = document.getElementById('pl-calcBtn');
    if (!calcBtn) return;
    calcBtn.addEventListener('click', calculatePL);
    document.getElementById('pl-sidebar').addEventListener('keydown', e => {
        if (e.key === 'Enter') calculatePL();
    });

    const useBtn = document.getElementById('pl-useCurrent');
    if (useBtn) wireUseCurrent(useBtn);
}

// Tap = fill Current/Target Price (existing behavior).
// Long-press (>=500ms) = fill Purchase Price per Share instead.
// Same gesture pattern Mia's send button uses for clear-chat.
const HOLD_MS = 500;

function wireUseCurrent(btn) {
    let holdTimer = null;
    let holdState = 'idle';     // 'idle' | 'pressing' | 'firing'
    let armed = false;

    const fillInto = (inputId, label) => {
        const input = document.getElementById(inputId);
        if (state.currentPrice == null) {
            const errEl = document.getElementById('pl-error');
            errEl.textContent = 'Select a stock or crypto first.';
            errEl.classList.add('show');
            setTimeout(() => errEl.classList.remove('show'), 2500);
            return;
        }
        input.value = state.currentPrice.toFixed(2);
        input.classList.add('flash');
        setTimeout(() => input.classList.remove('flash'), 600);
        // Briefly show on the button which field got filled, so the long-press
        // behavior is discoverable. The chip text returns to default after 1.4s.
        btn.dataset.origText = btn.dataset.origText || btn.textContent;
        btn.textContent = `→ ${label}`;
        btn.classList.add('pl-uc-flashed');
        setTimeout(() => {
            btn.textContent = btn.dataset.origText;
            btn.classList.remove('pl-uc-flashed');
        }, 1400);
    };

    const start = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        holdState = 'pressing';
        armed = false;
        holdTimer = setTimeout(() => {
            if (holdState !== 'pressing') return;
            armed = true;
            holdState = 'firing';
            fillInto('pl-buyPrice', 'Purchase');
        }, HOLD_MS);
        btn.classList.add('pl-uc-pressing');
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
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('mouseup', end);
    btn.addEventListener('touchend', end);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener('touchcancel', cancel);
}

function calculatePL() {
    const errEl = document.getElementById('pl-error');
    const resEl = document.getElementById('pl-result');
    errEl.classList.remove('show');
    resEl.classList.remove('show', 'profit', 'loss', 'neutral');

    const investment = parseFloat(document.getElementById('pl-investment').value);
    const buyPrice = parseFloat(document.getElementById('pl-buyPrice').value);
    const currentPrice = parseFloat(document.getElementById('pl-currentPrice').value);

    if ([investment, buyPrice, currentPrice].some(v => isNaN(v) || v < 0)) {
        errEl.textContent = 'Please enter valid positive numbers for all fields.';
        errEl.classList.add('show');
        return;
    }
    if (buyPrice === 0) {
        errEl.textContent = 'Purchase price cannot be zero.';
        errEl.classList.add('show');
        return;
    }

    const shares = investment / buyPrice;
    const currentValue = shares * currentPrice;
    const plDollar = currentValue - investment;
    const plPct = ((currentPrice - buyPrice) / buyPrice) * 100;

    const isProfit = plDollar > 0;
    const isLoss = plDollar < 0;
    const type = isProfit ? 'profit' : isLoss ? 'loss' : 'neutral';

    document.getElementById('pl-resIcon').textContent = isProfit ? '📈' : isLoss ? '📉' : '➖';
    document.getElementById('pl-resLabel').textContent = isProfit ? 'Total Profit' : isLoss ? 'Total Loss' : 'Break Even';
    // Note: P&L inputs are entered in whatever currency the user typed; we treat
    // them as USD for the toggle to work consistently with the rest of the app.
    // Sign + amount come back as currency-formatted text (no markup) so we
    // preserve the +/-$ prefix on USD; for INR we render the symbol, then number.
    const sign = plDollar >= 0 ? '+' : '−';
    document.getElementById('pl-resAmount').textContent = sign + fmtCurrency(Math.abs(plDollar)).replace(/^[$₹]/, '$&');
    document.getElementById('pl-resPct').textContent = (plPct >= 0 ? '+' : '') + fmt(plPct) + '%';
    document.getElementById('pl-resShares').textContent = fmt(shares, 4);
    document.getElementById('pl-resValue').textContent = fmtCurrency(currentValue);

    resEl.classList.add(type);
    requestAnimationFrame(() => resEl.classList.add('show'));
}
