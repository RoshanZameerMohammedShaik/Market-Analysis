// Usage meter pill at the top of the Mia panel. Shows Groq's reported
// remaining limit when on Groq, or a generic indicator on Cloudflare
// (CF doesn't expose a per-day quota header). When both keys are
// configured, hint that auto-fallback is wired.

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

    if (!usage) {
        container.innerHTML = `<div class="mia-usage idle">
            <span class="mia-usage-dot"></span>
            <span>${provLabel}${fallbackTag} — send a message to see usage</span>
        </div>`;
        return;
    }

    const axes = [];
    if (usage.reqLim) axes.push({ label: 'requests', rem: usage.reqRem || 0, lim: usage.reqLim });
    if (usage.tokLim) axes.push({ label: 'tokens', rem: usage.tokRem || 0, lim: usage.tokLim });
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
    container.innerHTML = `<div class="mia-usage ${tone}" title="${allAxes}">
        <span class="mia-usage-dot"></span>
        <span class="mia-usage-text">${provLabel}${fallbackTag} • ${pct}% of ${tightest.label} left</span>
        <span class="mia-usage-bar">${bar}</span>
    </div>`;
}
