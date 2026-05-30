// Usage meter pill at the top of the Mia panel. Always visible once a
// backend is configured so the user can see how close they are to the
// rate limit BEFORE Mia hits a 429 mid-stream. The bar fills based on
// the tightest of (requests-per-minute, tokens-per-minute) — whichever
// is closer to exhaustion. Pulses red as remaining drops below 20%.

import { getUsage, getRoutingSummary, getModelStatus } from './llm-client.js';
import { loadSettings } from './settings.js';

// Re-render the meter whenever a tier moves in/out of cooldown so the
// user sees fallback decisions surface in real time. Idempotent: re-
// listens cleanly across renderChat calls.
let coolingListener = null;
function ensureCoolingListener(container) {
    if (coolingListener) return;
    coolingListener = () => renderUsageMeter(container);
    document.addEventListener('ma:gemini-tier-cooldown-changed', coolingListener);
}

function fmtCoolingTime(secondsRemaining) {
    if (secondsRemaining < 60) return `${secondsRemaining}s`;
    const mins = Math.floor(secondsRemaining / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rmin = mins % 60;
    return rmin ? `${hours}h${rmin}m` : `${hours}h`;
}

function modelShortName(model) {
    if (!model) return '';
    if (model.includes('flash-lite')) return 'Flash-Lite';
    if (model.includes('flash')) return 'Flash';
    return model;
}

export function renderUsageMeter(container) {
    if (!container) return;
    ensureCoolingListener(container);
    const s = loadSettings();
    const usage = getUsage();
    const routing = getRoutingSummary();
    const modelStatus = getModelStatus();

    if (!s.backend) {
        container.innerHTML = `<div class="mia-usage idle">
            <span class="mia-usage-dot"></span>
            <span>No backend configured — add a key in welcome.</span>
        </div>`;
        return;
    }

    const provLabel = s.backend === 'cloudflare' ? 'Cloudflare' : 'Gemini';
    const fallbackTag = routing.fallback ? ` → ${routing.fallback} (auto-fallback)` : '';

    // If any Gemini tier is cooling, surface that visibly. Multiple tiers
    // cooling at once = the rare "rate-limited everywhere" state where
    // we'd be falling over to Cloudflare.
    const coolingBadges = modelStatus.cooling.map(c => {
        const short = modelShortName(c.model);
        return `<span class="mia-cooldown-badge" title="${c.model} — quota reached, auto-recovering in ${fmtCoolingTime(c.secondsRemaining)}">${short}: cooling ${fmtCoolingTime(c.secondsRemaining)}</span>`;
    }).join('');
    // Active tier indicator — which model the most recent reply came
    // from. Helps the user understand "wait, is it on Lite or Flash?"
    const activeTag = modelStatus.activeModel
        ? ` • on <strong>${modelShortName(modelStatus.activeModel)}</strong>`
        : '';

    // Pre-first-message: show a placeholder bar so the user knows it
    // exists. Once the first response comes back with rate headers, it
    // populates with real numbers.
    if (!usage) {
        const segments = 10;
        const placeholderBar = Array.from({ length: segments }, () => `<i class="off"></i>`).join('');
        container.innerHTML = `<div class="mia-usage idle" title="Per-minute usage shows after the first message">
            <span class="mia-usage-dot"></span>
            <span class="mia-usage-text">${provLabel}${fallbackTag}${activeTag} • limits show after first reply</span>
            <span class="mia-usage-bar">${placeholderBar}</span>
            ${coolingBadges}
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
    const tipSuffix = s.backend === 'gemini'
        ? ' — Gemini per-minute and per-day caps. Resets continuously.'
        : ' — Cloudflare daily free quota. Resets at UTC midnight.';
    container.innerHTML = `<div class="mia-usage ${tone}" title="${allAxes}${tipSuffix}">
        <span class="mia-usage-dot"></span>
        <span class="mia-usage-text">${provLabel}${fallbackTag}${activeTag} • ${pct}% ${tightest.label} left</span>
        <span class="mia-usage-bar">${bar}</span>
        ${coolingBadges}
    </div>`;
}
