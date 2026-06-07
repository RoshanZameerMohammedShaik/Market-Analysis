// Mia's DYNAMIC app walkthrough.
//
// Roshan's spec: Mia should walk a user through the app, performing REAL
// actions (not a screenshot tour, not a single hardcoded sequence). This
// module builds the tour FRESH each time from the LIVE state of the app:
//   - it picks a real symbol from the current Hot Picks grid (whatever is
//     actually showing right now), never a baked-in ticker;
//   - it only includes stops whose target surfaces actually exist this
//     session, and skips ones that don't apply (e.g. no Hot Picks loaded);
//   - it shuffles the order of the optional "tour" stops so two runs are
//     not the same walkthrough;
//   - every stop performs a genuine control action (switch tab, load a
//     symbol, run analysis, open a panel, cycle theme…) via the same
//     ui-bridge controls Mia uses for any other request — so the user is
//     watching the real app drive itself.
//
// It narrates through the launcher caption (the floating glass pill next to
// the orb) + the agent toast, and pulses/scrolls each target so the user's
// eye follows along. Mia's orb stays visible the whole time.
//
// Nothing here mutates a signal number — it only navigates and triggers the
// same handlers a user could click. Honest by construction.

import {
    controlSwitchMode, controlRunAnalysis, controlCycleTheme,
    controlRefreshHotPicks, controlOpenResources, controlCloseResources,
    controlOpenFullLedger, controlCloseFullLedger,
    controlOpenSectorHeatmap, controlCloseSectorHeatmap,
    controlScrollTo,
} from './ui-bridge.js';
import {
    showAgentToast, pulseElement, pulseElementById, scrollIntoViewIfNeeded, sleep,
} from './agent-pulse.js';

// Narration goes through the launcher caption when voice is minimized, and
// always through the agent toast. We import the voice caption setter lazily
// (voice.js is heavy + may not be initialised) and degrade gracefully.
let _setCaption = null;
async function caption(text, role = 'mia') {
    showAgentToast(text);
    if (_setCaption === null) {
        try {
            const m = await import('./voice.js');
            _setCaption = (typeof m.setLauncherCaptionExternal === 'function') ? m.setLauncherCaptionExternal : false;
        } catch (_) { _setCaption = false; }
    }
    if (_setCaption) { try { _setCaption(text, role); } catch (_) {} }
}

let _running = false;
export function isWalkthroughRunning() { return _running; }

let _abort = false;
export function stopWalkthrough() { _abort = true; }

// Read the symbols currently in the Hot Picks grid (live DOM), strongest
// first as rendered. Returns [{ symbol, name, signal, confidence }].
function readHotPicks() {
    const grid = document.getElementById('hotpicks-grid');
    if (!grid) return [];
    const cards = [...grid.querySelectorAll('.hot-pick-card[data-symbol]')];
    return cards.map(c => ({
        symbol: c.getAttribute('data-symbol'),
        name: c.querySelector('.hot-pick-name')?.textContent?.trim() || '',
        signal: c.classList.contains('buy') ? 'BUY' : c.classList.contains('sell') ? 'SELL' : 'NEUTRAL',
        confidence: Number(c.querySelector('.hot-pick-conf-num')?.getAttribute('data-conf-target')) || null,
        el: c,
    })).filter(p => p.symbol);
}

// Deterministic-enough shuffle that varies per call WITHOUT Math.random
// being required (kept simple; Math.random is fine in the browser here).
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Build the list of stops dynamically from live state. Each stop is
// { id, run: async () => {} }. Only includes stops whose surfaces exist.
function buildStops() {
    const stops = [];
    const picks = readHotPicks();
    // Choose a symbol to feature: prefer the highest-confidence BUY in the
    // live grid; else the first pick; else fall back to whatever is loaded.
    const featured = picks.length
        ? (picks.filter(p => p.signal === 'BUY').sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || picks[0])
        : null;

    // ── Opening stop (always) ──────────────────────────────────────────
    stops.push({
        id: 'intro', fixed: 'start',
        run: async () => {
            await caption("Let me show you around — I'll drive, you watch.");
            const hero = document.querySelector('.app-title, header, .hero-title') || document.body;
            scrollIntoViewIfNeeded(hero);
            await sleep(1400);
        },
    });

    // ── Hot Picks tour (only if the grid has cards) ────────────────────
    if (picks.length) {
        stops.push({
            id: 'hotpicks',
            run: async () => {
                await caption(`These are today's Hot Picks — the engine's strongest reads right now. ${picks.length} of them.`);
                await controlScrollTo({ section: 'hotpicks' });
                // Pulse the top few cards in sequence so the eye sweeps the grid.
                for (const p of picks.slice(0, 3)) {
                    pulseElement(p.el);
                    await sleep(520);
                }
                await sleep(700);
            },
        });
    }

    // ── Load + analyze the featured symbol (the heart of the demo) ─────
    if (featured) {
        stops.push({
            id: 'analyze',
            run: async () => {
                const conf = featured.confidence ? ` at ${featured.confidence}% confidence` : '';
                await caption(`Let's open ${featured.symbol} — a ${featured.signal}${conf}. Watch the full analysis build.`);
                pulseElement(featured.el);
                await sleep(600);
                // Use the proven direct loader (sets state + chart + analysis + scroll).
                if (typeof window !== 'undefined' && typeof window.__loadSymbolDirect === 'function') {
                    window.__loadSymbolDirect(featured.symbol);
                }
                await sleep(2600);   // let the chart + signal card render
                await caption("Here's the signal, the confidence dial, the price targets, and the technicals — each explained for THIS symbol.");
                await controlScrollTo({ section: 'signal' });
                await sleep(2200);
            },
        });
    }

    // ── Optional tour stops — order shuffled each run ──────────────────
    const optional = [];

    // Switch market mode (only show if a mode tab pair exists)
    if (document.querySelector('[data-tab="crypto"]') && document.querySelector('[data-tab="stock"]')) {
        optional.push({
            id: 'modes',
            run: async () => {
                const onCrypto = document.querySelector('[data-tab="crypto"]')?.classList.contains('active');
                const to = onCrypto ? 'stock' : 'crypto';
                await caption(`You can flip between Stocks and Crypto any time — like this.`);
                await controlSwitchMode(to);
                await sleep(1500);
            },
        });
    }

    // Sector heatmap
    if (document.getElementById('sector-heatmap-section')) {
        optional.push({
            id: 'heatmap',
            run: async () => {
                await caption("This is the Sector Heatmap — where money is rotating across the market today.");
                try { await controlOpenSectorHeatmap(); } catch (_) {}
                await sleep(2600);
                try { await controlCloseSectorHeatmap(); } catch (_) {}
            },
        });
    }

    // Full Ledger (the honesty surface — show the engine's real track record)
    if (document.querySelector('#scanner-section .scanner-details')) {
        optional.push({
            id: 'ledger',
            run: async () => {
                const sym = featured?.symbol || null;
                await caption(sym
                    ? `And here's the receipts — the Full Ledger of every past call${sym ? `, filtered to ${sym}` : ''}. I never hide the misses.`
                    : "And here's the receipts — the Full Ledger of every past call. I never hide the misses.");
                try { await controlOpenFullLedger(sym ? { symbol: sym } : {}); } catch (_) {}
                await sleep(3000);
                try { await controlCloseFullLedger(); } catch (_) {}
            },
        });
    }

    // Resources / glossary
    if (document.getElementById('resources-toggle')) {
        optional.push({
            id: 'resources',
            run: async () => {
                await caption("New to a term? Resources has plain-English definitions for every indicator.");
                try { controlOpenResources(); } catch (_) {}
                await sleep(2400);
                try { controlCloseResources(); } catch (_) {}
            },
        });
    }

    // Theme cycle (a fun, harmless flourish)
    if (document.getElementById('theme-toggle')) {
        optional.push({
            id: 'theme',
            run: async () => {
                await caption("Prefer a different look? I can switch themes too.");
                try { await controlCycleTheme(); } catch (_) {}
                await sleep(1500);
            },
        });
    }

    // Pick a varying subset (3–4) of the optional stops, shuffled, so no two
    // walkthroughs are the same sequence — satisfies "dynamic, not one static
    // sequence". If there are few optional stops, take them all.
    const shuffled = shuffle(optional);
    const take = Math.min(shuffled.length, 3 + Math.floor(Math.random() * 2)); // 3 or 4
    stops.push(...shuffled.slice(0, take));

    // ── Closing stop (always) ──────────────────────────────────────────
    stops.push({
        id: 'outro', fixed: 'end',
        run: async () => {
            await caption("That's the tour. Ask me anything, or say \"analyze\" any ticker and I'll take it from there.");
            await sleep(2000);
            await caption('', 'idle');   // clear the caption
        },
    });

    return stops;
}

/**
 * Run the dynamic walkthrough. Returns a summary of what was shown so the
 * calling Mia tool can describe it in its spoken reply.
 *
 * @param {object} opts
 * @param {number} opts.maxStops  hard cap on total stops (safety).
 */
export async function runWalkthrough({ maxStops = 8 } = {}) {
    if (_running) return { ok: false, reason: 'already-running' };
    _running = true;
    _abort = false;
    const shown = [];
    try {
        const stops = buildStops().slice(0, maxStops);
        for (const stop of stops) {
            if (_abort) break;
            try {
                // eslint-disable-next-line no-await-in-loop
                await stop.run();
                shown.push(stop.id);
            } catch (e) {
                // A single failed stop never kills the tour.
                console.warn('[walkthrough] stop failed:', stop.id, e);
            }
            // eslint-disable-next-line no-await-in-loop
            if (!_abort) await sleep(500);
        }
    } finally {
        _running = false;
        _abort = false;
    }
    return { ok: true, stopsShown: shown, count: shown.length, aborted: _abort };
}
