// Usage meter pill at the top of the Mia panel. Always visible once a
// backend is configured so the user can see how close they are to the
// rate limit BEFORE Mia hits a 429 mid-stream. The bar fills based on
// the tightest of (requests-per-minute, tokens-per-minute) — whichever
// is closer to exhaustion. Pulses red as remaining drops below 20%.

import { getUsage, getRoutingSummary } from './llm-client.js';
import { loadSettings } from './settings.js';

export function renderUsageMeter(container) {
    if (!container) return;
    const s = loadSettings();
    const usage = getUsage();
    const routing = getRoutingSummary();

    if (!s.backend) {
        container.innerHTML = `<div class="mia-usage idle">
            <span class="mia-usage-dot"></span>
            <span>No backend configured — add a key in welcome.</span>
        </div>`;
        return;
    }

    const provLabel = s.backend === 'cloudflare' ? 'Cloudflare' : 'Groq';
    const fallbackTag = routing.fallback ? ` → ${routing.fallback} (auto-fallback)` : '';

    // Pre-first-message: show a placeholder bar so the user knows it
    // exists. Once the first response comes back with rate headers, it
    // populates with real numbers.
    if (!usage) {
        const segments = 10;
        const placeholderBar = Array.from({ length: segments }, () => `<i class="off"></i>`).join('');
        container.innerHTML = `<div class="mia-usage idle" title="Per-minute usage shows after the first message">
            <span class="mia-usage-dot"></span>
            <span class="mia-usage-text">${provLabel}${fallbackTag} • limits show after first reply</span>
            <span class="mia-usage-bar">${placeholderBar}</span>
        </div>`;
        return;
    }

    const axes = [];
    if (usage.reqLim) axes.push({ label: 'req/min', rem: usage.reqRem || 0, lim: usage.reqLim });
    if (usage.tokLim) axes.push({ label: 'tok/min', rem: usage.tokRem || 0, lim: usage.tokLim });
    if (axes.length === 0) {
        container.innerHTML = `<div class="mia-usage idle"><span class="mia-usage-dot"></span><span>${provLabel}${fallbackTag}</span></div>`;
        return;
    }
    const tightest = axes.reduce((a, b) => (a.rem / a.lim < b.rem / b.lim ? a : b));
    const pct = Math.max(0, Math.min(100, Math.round((tightest.rem / tightest.lim) * 100)));
    const tone = pct > 50 ? 'good' : pct > 20 ? 'warn' : 'bad';
    const segments = 10;
    const filled = Math.round((pct / 100) * segments);
    const bar = Array.from({ length: segments }, (_, i) => `<i class="${i < filled ? 'on' : 'off'}"></i>`).join('');
    const allAxes = axes.map(a => `${Math.round(a.rem)} / ${a.lim} ${a.label}`).join(' • ');
    container.innerHTML = `<div class="mia-usage ${tone}" title="${allAxes} — Groq sliding-window per-minute limits. Resets continuously.">
        <span class="mia-usage-dot"></span>
        <span class="mia-usage-text">${provLabel}${fallbackTag} • ${pct}% ${tightest.label} left</span>
        <span class="mia-usage-bar">${bar}</span>
    </div>`;
}
