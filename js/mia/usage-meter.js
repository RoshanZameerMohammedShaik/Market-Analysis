// Usage meter pill at top of Mia panel.
// Reads provider rate-limit headers (Groq exposes them) and shows the
// closest-to-exhaustion limit as a percentage with a 10-segment bar.

import { getUsage } from './llm-client.js';
import { loadSettings } from './settings.js';

export function renderUsageMeter(container) {
    if (!container) return;
    const s = loadSettings();
    const usage = getUsage();

    if (s.backend === 'webllm') {
        container.innerHTML = `<div class="mia-usage local">
            <span class="mia-usage-dot"></span>
            <span>Running locally — no rate limit</span>
        </div>`;
        return;
    }

    if (!usage) {
        container.innerHTML = `<div class="mia-usage idle">
            <span class="mia-usage-dot"></span>
            <span>${s.backend === 'cloudflare' ? 'Cloudflare Workers AI' : 'Groq'} — send a message to see usage</span>
        </div>`;
        return;
    }

    // Pick the axis closest to exhaustion.
    const axes = [];
    if (usage.reqLim) axes.push({ label: 'requests', rem: usage.reqRem || 0, lim: usage.reqLim });
    if (usage.tokLim) axes.push({ label: 'tokens', rem: usage.tokRem || 0, lim: usage.tokLim });
    if (axes.length === 0) {
        container.innerHTML = '';
        return;
    }
    const tightest = axes.reduce((a, b) => (a.rem / a.lim < b.rem / b.lim ? a : b));
    const pct = Math.max(0, Math.min(100, Math.round((tightest.rem / tightest.lim) * 100)));
    const tone = pct > 50 ? 'good' : pct > 20 ? 'warn' : 'bad';
    const segments = 10;
    const filled = Math.round((pct / 100) * segments);
    const bar = Array.from({ length: segments }, (_, i) => `<i class="${i < filled ? 'on' : 'off'}"></i>`).join('');

    const provLabel = usage.provider === 'cloudflare' ? 'Cloudflare' : 'Groq';
    const allAxes = axes.map(a => `${Math.round(a.rem)} / ${a.lim} ${a.label}`).join(' • ');
    container.innerHTML = `<div class="mia-usage ${tone}" title="${allAxes}">
        <span class="mia-usage-dot"></span>
        <span class="mia-usage-text">${provLabel} • ${pct}% of ${tightest.label} left</span>
        <span class="mia-usage-bar">${bar}</span>
    </div>`;
}
