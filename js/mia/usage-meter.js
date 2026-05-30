// Usage meter pill at the top of the Mia panel. Always visible once a
// backend is configured so the user can see how close they are to the
// rate limit BEFORE Mia hits a 429 mid-stream. The bar fills based on
// the tightest of (requests-per-minute, tokens-per-minute) — whichever
// is closer to exhaustion. Pulses red as remaining drops below 20%.

import { getUsage, getRoutingSummary, getModelStatus } from './llm-client.js';
import { clearCooldown } from './backends/tier-cooldown.js';
import { GEMINI_MODELS } from './backends/gemini-models.js';
import { loadSettings } from './settings.js';

// Re-render the meter whenever a tier moves in/out of cooldown so the
// user sees fallback decisions surface in real time. Idempotent: re-
// listens cleanly across renderChat calls.
let coolingListener = null;
let countdownTimer = null;
function ensureCoolingListener(container) {
    if (coolingListener) return;
    coolingListener = () => renderUsageMeter(container);
    document.addEventListener('ma:gemini-tier-cooldown-changed', coolingListener);
    // Also wire the manual-clear handler once via delegation. Survives
    // re-renders because the listener is on the container, not the
    // individual badges (which get rebuilt on each render).
    container.addEventListener('click', (e) => {
        const clearBtn = e.target.closest('.mia-cooldown-clear');
        if (!clearBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const model = clearBtn.dataset.model;
        if (model) clearCooldown(model);
    });
}

// Tick down the countdown text every second so users see the cooldown
// shrinking in real time instead of frozen at "cooling 14m" until some
// other event triggers a re-render. We patch only the text node — no
// full re-render, no flicker, no ResizeObserver thrash. The badges have
// a data-model attribute so we can find them; the secondsRemaining
// comes from getModelStatus() each tick (re-reads from localStorage
// via getCooldownState).
function ensureCountdownTicker(container) {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => {
        const badges = container.querySelectorAll('.mia-cooldown-badge[data-model]');
        if (!badges.length) return; // nothing to tick — leave it alone
        const status = getModelStatus();
        const liveByModel = Object.fromEntries(status.cooling.map(c => [c.model, c.secondsRemaining]));
        let anyChanged = false;
        for (const badge of badges) {
            const model = badge.dataset.model;
            const remaining = liveByModel[model];
            if (remaining == null) {
                // Cooldown expired since last render — re-render to drop
                // the badge entirely (and update the active-model line).
                anyChanged = true;
                break;
            }
            // Replace just the text content of the badge while preserving
            // the × button at the end. The badge layout is: short ":"
            // cooling Xm × — we can rebuild the leading text node.
            const short = modelShortName(model);
            const expected = `${short}: cooling ${fmtCoolingTime(remaining)}`;
            // First text node holds the status string. Rebuild it.
            const firstText = [...badge.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
            if (firstText && firstText.textContent !== expected) {
                firstText.textContent = expected;
            }
        }
        if (anyChanged) renderUsageMeter(container);
    }, 1000);
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
    ensureCountdownTicker(container);
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

    // Smart-routing rule: per-model cooling badges add noise during normal
    // operation (the chain just routes around the cooling model — that's
    // its job, the user doesn't need to see each one). Only surface a
    // badge when EVERY Gemini model is cooling — that's the genuinely
    // notable state where the user is waiting on the earliest reset and
    // we'd be falling through to Cloudflare. We compute the soonest
    // reset across all cooling models so the countdown reflects "when
    // will Mia be back" rather than "when does this specific model
    // recover."
    const totalGeminiModels = GEMINI_MODELS.length;
    const allCooling = modelStatus.cooling.length >= totalGeminiModels;
    let coolingBadges = '';
    if (allCooling && modelStatus.cooling.length > 0) {
        const soonestSecs = Math.min(...modelStatus.cooling.map(c => c.secondsRemaining));
        // Find the model that hits soonest so the × button targets it —
        // clearing only that one is enough to unstick the chain.
        const soonest = modelStatus.cooling.reduce((a, b) => a.secondsRemaining < b.secondsRemaining ? a : b);
        coolingBadges = `<span class="mia-cooldown-badge" data-model="${soonest.model}" title="All Gemini models exhausted. Earliest one resets in ${fmtCoolingTime(soonestSecs)}. Click × to force-retry now.">All models cooling — back in ${fmtCoolingTime(soonestSecs)}<button class="mia-cooldown-clear" data-model="${soonest.model}" type="button" aria-label="Force retry now">×</button></span>`;
    }
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
