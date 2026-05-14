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
    if (useBtn) {
        useBtn.addEventListener('click', () => {
            const input = document.getElementById('pl-currentPrice');
            if (state.currentPrice != null) {
                input.value = state.currentPrice.toFixed(2);
                input.classList.add('flash');
                setTimeout(() => input.classList.remove('flash'), 600);
            } else {
                const errEl = document.getElementById('pl-error');
                errEl.textContent = 'Select a stock or crypto first.';
                errEl.classList.add('show');
                setTimeout(() => errEl.classList.remove('show'), 2500);
            }
        });
    }
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
