// Agentic stage — full-screen overlay that pulls a target card into
// the center of the screen, blurs the background with an aurora
// animation, and rains white particles. Used when Mia is performing
// an agentic action (P&L calc, future: alert setup, screenshot, etc.)
// so the user has a clear "Mia is doing this for me" focus state
// while she works through the steps.
//
// Roshan's spec: "pull the card up, bring it to center, blur the
// background with aurora animation, white dots going up, glass panel,
// looks super agentic and powerful." The minimized Mia orb stays
// visible the entire time (driven by body.mia-agentic-active class
// which the launcher CSS treats the same as voice-minimized).
//
// API:
//   await openAgenticStage({ host, title, subtitle })
//     - host: id (string) or element of the card to relocate
//     - title: header text shown above the card
//     - subtitle: optional smaller text under the title
//   closeAgenticStage()
//     - reverse: animate stage out, return the card to its origin
//
// Honest caveats:
//   - We MOVE the host element (not clone) so its existing event
//     handlers + form state survive. When we close, we put it back
//     where we found it via a placeholder marker.
//   - Reduced-motion users skip the aurora + particles; the card
//     just appears centered.

import { setLauncherVis, getLauncherVis } from './launcher-vis.js';

const STAGE_ID = 'mia-agentic-stage';
const PARTICLE_COUNT = 24;
let activeOriginParent = null;
let activeOriginNext = null;     // sibling reference for re-insertion
let activeHost = null;
let escHandler = null;
let priorLauncherVis = null;     // restored on close so we don't strand the launcher

function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
}

function buildOverlay({ title, subtitle }) {
    const el = document.createElement('div');
    el.id = STAGE_ID;
    el.className = 'agentic-stage';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', title || 'Mia is doing something');
    el.innerHTML = `
        <div class="agentic-stage-bg" aria-hidden="true">
            <div class="agentic-aurora"></div>
            <div class="agentic-particles">
                ${Array.from({ length: PARTICLE_COUNT }).map((_, i) => {
                    // Each particle gets randomized timing + horizontal
                    // start position so they read as a continuous shower
                    // instead of a synchronized chorus line.
                    const left = Math.round(Math.random() * 100);
                    const delay = (Math.random() * 8).toFixed(2);
                    const duration = (6 + Math.random() * 6).toFixed(2);
                    const size = (2 + Math.random() * 3).toFixed(2);
                    return `<span class="agentic-particle" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;width:${size}px;height:${size}px"></span>`;
                }).join('')}
            </div>
        </div>
        <div class="agentic-stage-card" data-stage-card>
            <div class="agentic-stage-header">
                <div class="agentic-stage-mia">
                    <span class="agentic-stage-mia-dot" aria-hidden="true"></span>
                    <span class="agentic-stage-mia-label">Mia is working</span>
                </div>
                <h2 class="agentic-stage-title">${title || ''}</h2>
                ${subtitle ? `<p class="agentic-stage-subtitle">${subtitle}</p>` : ''}
                <button type="button" class="agentic-stage-close" aria-label="Close">×</button>
            </div>
            <div class="agentic-stage-host" data-stage-host></div>
        </div>
    `;
    return el;
}

/**
 * Open the agentic stage with `host` (an element or id) pulled into
 * its center. Returns when the entrance animation completes. Sets
 * body.mia-agentic-active so the launcher orb stays visible.
 */
export async function openAgenticStage({ host, title, subtitle, variant } = {}) {
    closeAgenticStage();   // idempotent — close any prior stage first
    const hostEl = (typeof host === 'string') ? document.getElementById(host) : host;
    if (!hostEl) throw new Error(`agentic stage: host element not found (${host})`);

    // Remember where the host lived so closeAgenticStage can put it back.
    activeOriginParent = hostEl.parentNode;
    activeOriginNext = hostEl.nextSibling;
    activeHost = hostEl;

    const overlay = buildOverlay({ title, subtitle });
    if (variant) overlay.classList.add(`agentic-variant-${variant}`);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-stage-host]').appendChild(hostEl);
    // Mark the host so its CSS can override layout for the centered
    // version (e.g., its own border/shadow may need to relax inside
    // the glass card).
    hostEl.classList.add('agentic-stage-mounted');

    // Body class drives the backdrop dim. Launcher visibility is
    // owned by launcher-vis.js — capture the prior state so we can
    // restore it on close, then force orb mode so the user always
    // sees Mia "working" while the agentic stage is up.
    document.body.classList.add('mia-agentic-active');
    priorLauncherVis = getLauncherVis();
    setLauncherVis('orb');

    // Close button + Esc + click-outside dismiss.
    overlay.querySelector('.agentic-stage-close').addEventListener('click', closeAgenticStage);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.classList.contains('agentic-stage-bg')) {
            closeAgenticStage();
        }
    });
    escHandler = (e) => { if (e.key === 'Escape') closeAgenticStage(); };
    document.addEventListener('keydown', escHandler);

    // Wait one frame for the entrance animation to start, then resolve
    // ~360ms later when it's actually visible. Lets the caller chain
    // (e.g. fill inputs, click Calculate) only after the user can see
    // the stage land.
    if (!reducedMotion()) {
        await new Promise(r => setTimeout(r, 360));
    }
    return overlay;
}

/**
 * Close the stage: reverse the entrance, return the host element to
 * its original parent so its form state stays intact for the next
 * visit. Idempotent.
 */
export function closeAgenticStage() {
    const overlay = document.getElementById(STAGE_ID);
    if (!overlay) return;
    if (escHandler) {
        document.removeEventListener('keydown', escHandler);
        escHandler = null;
    }
    document.body.classList.remove('mia-agentic-active');
    // Restore launcher visibility to whatever it was before we forced
    // orb mode. If voice took over while we were running, prior is
    // already 'orb' and stays that way; if user was in chat mode,
    // prior was 'hidden' and the chat panel is still showing; if
    // there was no prior state, default 'visible' so the launcher
    // never gets stranded invisible.
    if (priorLauncherVis) setLauncherVis(priorLauncherVis);
    else setLauncherVis('visible');
    priorLauncherVis = null;

    // Put the host element back where it came from, BEFORE removing
    // the overlay — otherwise the hostEl reference becomes orphaned.
    if (activeHost && activeOriginParent) {
        activeHost.classList.remove('agentic-stage-mounted');
        if (activeOriginNext && activeOriginNext.parentNode === activeOriginParent) {
            activeOriginParent.insertBefore(activeHost, activeOriginNext);
        } else {
            activeOriginParent.appendChild(activeHost);
        }
    }
    activeOriginParent = null;
    activeOriginNext = null;
    activeHost = null;

    // Animate out, then unmount.
    overlay.classList.add('dismissing');
    setTimeout(() => overlay.remove(), 280);
}

/** Returns true if a stage is currently mounted. */
export function isAgenticStageOpen() {
    return !!document.getElementById(STAGE_ID);
}
