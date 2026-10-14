// Shareable prediction cards.
//
// Renders a clean, branded 1080×1080 PNG of the current signal entirely
// on a <canvas> (no html2canvas, no DOM screenshot, no library), the
// confidence dial as an arc, the BUY/SELL verdict, the price targets, the
// symbol, and the market-ai.pages.dev wordmark. Then shares it via the
// Web Share API (with the image file) where supported, falling back to a
// PNG download everywhere else.
//
// Built so the app spreads: one tap turns a prediction into something a
// user can drop into a chat with friends, and it carries the URL, not
// the GitHub repo.

import { fmtPrice } from './format.js';

const SITE = 'market-ai.pages.dev';

// Theme-ish palette pulled from the app's dark identity (the card is
// always dark, it reads well on any background it's pasted onto).
const PAL = {
    bg0: '#0a0a12', bg1: '#12121f',
    text: '#e8eef5', muted: '#8b96a8', dim: '#5b6678',
    green: '#22c55e', red: '#ef4444', amber: '#fbbf24', accent: '#4a9eff', violet: '#7c3aed',
};

function tierColor(conf) {
    return conf >= 65 ? PAL.green : conf >= 50 ? PAL.amber : PAL.red;
}
// The image carries the call the card shows (prediction.cardCall, set by js/ui/signal.js) and the
// card's own range, never the engine's plain up/down call: that one is a coin flip and no part of
// the app shows it any more, so a shared image must not either.
function toneColor(tone) {
    return tone === 'up' ? PAL.green : tone === 'down' ? PAL.red : PAL.amber;
}
function callOf(prediction) {
    const c = prediction?.cardCall;
    return c ? { title: c.title, tone: c.tone, measured: c.confidence != null ? Math.round(c.confidence * 100) : null }
        : { title: 'WAIT', tone: 'flat', measured: null };
}

// Draw the 270° confidence arc centered at (cx,cy).
function drawDial(ctx, cx, cy, r, conf) {
    const START = (135 * Math.PI) / 180;
    const SWEEP = (270 * Math.PI) / 180;
    const frac = Math.max(0, Math.min(1, conf / 100));
    // Track
    ctx.beginPath();
    ctx.lineWidth = 26;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.arc(cx, cy, r, START, START + SWEEP);
    ctx.stroke();
    // Value
    ctx.beginPath();
    ctx.strokeStyle = tierColor(conf);
    ctx.shadowColor = tierColor(conf);
    ctx.shadowBlur = 24;
    ctx.arc(cx, cy, r, START, START + SWEEP * frac);
    ctx.stroke();
    ctx.shadowBlur = 0;
}


// Build the canvas for `prediction` + `symbol`. Returns the canvas.
export function renderShareCanvas(prediction, symbol, range = null) {
    const S = 1080;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');

    // Background gradient.
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, PAL.bg1); g.addColorStop(1, PAL.bg0);
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    // Subtle accent glow top-left.
    const glow = ctx.createRadialGradient(180, 160, 0, 180, 160, 620);
    glow.addColorStop(0, 'rgba(124,58,237,0.20)'); glow.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, S, S);

    const call = callOf(prediction);

    // Header, symbol + wordmark.
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PAL.text;
    ctx.font = '800 72px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(String(symbol || '').toUpperCase(), 80, 150);
    ctx.fillStyle = PAL.muted;
    ctx.font = '500 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Market Analyzer', 80, 196);

    const cx = S / 2, cy = 540, r = 200;
    ctx.textAlign = 'center';
    if (call.measured != null) {
        // The measured rate of the pattern behind the call, as the dial.
        drawDial(ctx, cx, cy, r, call.measured);
        ctx.fillStyle = PAL.text;
        ctx.font = '900 150px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(String(call.measured), cx, cy + 30);
        ctx.fillStyle = PAL.muted;
        ctx.font = '700 48px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('%', cx + ctx.measureText(String(call.measured)).width / 2 + 110, cy - 50);
        ctx.fillStyle = PAL.dim;
        ctx.font = '500 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('measured', cx, cy - 230);
        ctx.fillStyle = toneColor(call.tone);
        ctx.font = '800 60px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(call.title, cx, cy + 130);
    } else {
        ctx.fillStyle = toneColor(call.tone);
        ctx.font = '900 130px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(call.title, cx, cy);
        ctx.fillStyle = PAL.muted;
        ctx.font = '600 34px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('no measured edge today', cx, cy + 70);
    }

    // The card's own range.
    if (range && Number.isFinite(range.low) && Number.isFinite(range.high)) {
        const y = 850;
        ctx.textAlign = 'center';
        ctx.fillStyle = PAL.muted;
        ctx.font = '600 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('EXPECTED RANGE', cx, y - 44);
        ctx.fillStyle = PAL.text;
        ctx.font = '800 52px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        // The same currency path as every other price in the app (a hard-coded "$" read Reliance's
        // rupees and Toyota's yen as dollars).
        const co = { srcCurrency: String(prediction.currency || 'USD').toUpperCase() };
        ctx.fillText(`${fmtPrice(range.low, co)}  →  ${fmtPrice(range.high, co)}`, cx, y + 18);
    }

    // Footer wordmark + disclaimer.
    ctx.textAlign = 'center';
    ctx.fillStyle = PAL.accent;
    ctx.font = '800 40px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(SITE, cx, 1000);
    ctx.fillStyle = PAL.dim;
    ctx.font = '400 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Statistical signal, not financial advice.', cx, 1040);
    ctx.textAlign = 'left';

    return c;
}

function canvasToBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// Share (or download) a prediction card. `prediction` is the engine
// result object; `symbol` the ticker.
export async function sharePredictionCard(prediction, symbol) {
    if (!prediction) {
        const { notify } = await import('./notify.js');
        notify('Load a symbol first, then share its prediction.', { kind: 'warn' });
        return;
    }
    // The range the card's big bar shows, read off the bar itself so the image matches the page.
    const bar = document.querySelector('#signal-section .fc-bigbar');
    const range = bar ? { low: Number(bar.dataset.low), high: Number(bar.dataset.high) } : null;
    const canvas = renderShareCanvas(prediction, symbol, range);
    const call = callOf(prediction);
    const rate = call.measured != null ? ` (${call.measured}% measured)` : '';
    const blob = await canvasToBlob(canvas);
    if (!blob) return;
    const fileName = `${String(symbol || 'prediction').toUpperCase()}-market-analyzer.png`;
    const file = new File([blob], fileName, { type: 'image/png' });

    // Prefer native share-with-file (mobile). Guard with canShare so we
    // don't call share() on a platform that can't take the file.
    const shareData = {
        files: [file],
        title: `${String(symbol).toUpperCase()}, ${call.title}${rate}`,
        text: `${String(symbol).toUpperCase()}: ${call.title}${rate}, via ${SITE}`,
    };
    try {
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
            await navigator.share(shareData);
            return;
        }
    } catch (_) { /* user cancelled or share failed → fall through to download */ }

    // Fallback: trigger a PNG download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    try {
        const { notify } = await import('./notify.js');
        notify('Prediction card saved, share it anywhere.', { kind: 'success' });
    } catch (_) {}
}
