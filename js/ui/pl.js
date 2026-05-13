import { fmt } from './format.js';

export function initPLCalculator() {
    const calcBtn = document.getElementById('pl-calcBtn');
    if (!calcBtn) return;
    calcBtn.addEventListener('click', calculatePL);
    document.getElementById('pl-sidebar').addEventListener('keydown', e => {
        if (e.key === 'Enter') calculatePL();
    });
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
    document.getElementById('pl-resAmount').textContent = (plDollar >= 0 ? '+$' : '-$') + fmt(Math.abs(plDollar));
    document.getElementById('pl-resPct').textContent = (plPct >= 0 ? '+' : '') + fmt(plPct) + '%';
    document.getElementById('pl-resShares').textContent = fmt(shares, 4);
    document.getElementById('pl-resValue').textContent = '$' + fmt(currentValue);

    resEl.classList.add(type);
    requestAnimationFrame(() => resEl.classList.add('show'));
}
