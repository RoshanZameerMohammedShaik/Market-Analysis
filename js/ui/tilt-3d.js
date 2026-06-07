/* ============================================================================
   tilt-3d.js — cursor-reactive 3D tilt + parallax for Market-Analysis (final).

   Pairs with css/premium-3d.css. The CSS owns ALL geometry (perspective, the
   translateZ parallax tiers, the specular gradient, the directional shadows).
   This module feeds a small set of EASED custom properties to the ONE element
   the pointer is over (or the keyboard-focused one):

       --rx          rotateX in deg  (tilt up/down)
       --ry          rotateY in deg  (tilt left/right)
       --mx, --my    pointer position as a % within the element (specular spot)
       --engage      0→1 eased — CSS multiplies tilt/lift/parallax/spec by this

   It also injects a single <div class="tilt-spec"> into the engaged element so
   the moving highlight has its own layer (won't collide with premium.css's
   ::after sheen). The spec node is pointer-events:none + aria-hidden and is
   always removed on release.

   Engine:
     • Single active element at a time; one self-stopping rAF loop.
     • Per-frame eased lerp of rx/ry/mx/my AND a separate --engage ramp (0→1 on
       engage, →0 on release), so engaging/releasing is smooth and the
       overflow:hidden↔visible handoff in CSS never snaps.
     • getBoundingClientRect cached on engage; invalidated on scroll/resize.

   Review fixes baked in:
     • Synchronous teardown of the OUTGOING element inside engage() so a direct
       A→B pointer cross can never leave card A stuck lifted/tilted with an
       orphaned spec node.
     • MutationObserver on #hotpicks-grid: if the active (esp. keyboard-focused)
       card is detached by an innerHTML re-render, release immediately.
     • --tilt-max cached and recomputed only on theme change (no per-hover style
       flush).
     • Capability gate also excludes narrow viewports (≤540px) so JS work matches
       the CSS flatten — no orphan spec nodes on narrow touch laptops.
     • :focus-visible undetectable → fail to NO engage (never tilt on touch tap).

   No-ops under prefers-reduced-motion / touch / coarse / narrow. Delegated
   listeners on a few stage roots (not per card), so the #hotpicks-grid
   delegation survives loadHotPicks()'s innerHTML re-render with no rebind.
   ========================================================================== */

let initialised = false;

export function initTilt3d() {
  if (initialised) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  initialised = true;

  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = window.matchMedia('(max-width: 540px)');

  // NOTE: .signal-box (the main analysis card) is intentionally NOT a tilt
  // stage — cursor-tilt on that large card read as cheap/distracting, so it's
  // removed. It keeps its static resting depth + GSAP entrance, just no tilt.
  const STAGES = [
    { root: '#hotpicks-grid', card: '.hot-pick-card', spec: true },
    { root: 'document', card: '.spikers-card', spec: true },
    { root: 'document', card: '.kbd-help-card', spec: true },
  ];

  const LERP = 0.18;          // fraction of remaining tilt distance / frame
  const ENGAGE_LERP = 0.16;   // ramp speed for --engage
  const SETTLE_EPS = 0.02;    // deg — below this on every axis we stop the loop

  // --- cached --tilt-max (recomputed on theme change only) ------------------
  let cachedMax = 8;
  function recomputeMax() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--tilt-max').trim();
    const n = parseFloat(raw);
    cachedMax = Number.isFinite(n) && n > 0 ? n : 8;
  }
  recomputeMax();
  // theme.js toggles <html.theme-transition> on switch; recompute when it does.
  const themeObserver = new MutationObserver(() => recomputeMax());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  function tiltScaleFor(el) {
    if (el.classList.contains('spikers-card') || el.classList.contains('kbd-help-card')) return 0.6;
    return 1;
  }

  function isHotPick(el) {
    return !!(el && el.classList && el.classList.contains('hot-pick-card'));
  }

  // The Hot Picks grid gets data-lifting=1 while one of its cards is engaged so
  // CSS can blur/dim the SIBLING cards (Picasa "lift one, soften the rest").
  // Cleared on full release. Cached so we don't re-query the grid each engage.
  const hotpicksGrid = () => document.getElementById('hotpicks-grid');
  function setGridLifting(on) {
    const g = hotpicksGrid();
    if (!g) return;
    if (on) g.setAttribute('data-lifting', '1');
    else g.removeAttribute('data-lifting');
  }

  // --- active-target state --------------------------------------------------
  let activeEl = null;
  let specEl = null;
  let activeWantsSpec = false;
  let activeRect = null;
  let activeMax = 8;
  let viaKeyboard = false;

  let rafId = 0;
  let pointerX = 0, pointerY = 0;

  // current (rendered) vs target — lerped each frame
  let curRx = 0, curRy = 0, curMx = 50, curMy = 50, curEng = 0;
  let tgtRx = 0, tgtRy = 0, tgtMx = 50, tgtMy = 50, tgtEng = 0;

  function ensureSpec(el) {
    if (!activeWantsSpec) return null;
    let s = el.querySelector(':scope > .tilt-spec');
    if (!s) {
      s = document.createElement('div');
      s.className = 'tilt-spec';
      s.setAttribute('aria-hidden', 'true');
      el.appendChild(s);
    }
    return s;
  }

  // Hard, synchronous reset of an element's tilt state. Used both for the
  // outgoing element on an A→B cross and for the final release.
  function hardReset(el) {
    if (!el) return;
    delete el.dataset.tilting;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--mx', '50%');
    el.style.setProperty('--my', '50%');
    el.style.setProperty('--engage', '0');
    const s = el.querySelector(':scope > .tilt-spec');
    if (s) s.remove();
  }

  function refreshRect() {
    if (activeEl) activeRect = activeEl.getBoundingClientRect();
  }

  function engage(el, wantsSpec, keyboard) {
    if (activeEl === el) { viaKeyboard = viaKeyboard && keyboard; return; }
    // Synchronous teardown of the outgoing element (review fix #3): never defer
    // the old card's reset, or a direct A→B cross leaves A stuck.
    if (activeEl && activeEl !== el) hardReset(activeEl);
    releasing = false;

    activeEl = el;
    activeWantsSpec = wantsSpec;
    viaKeyboard = !!keyboard;
    el.dataset.tilting = '1';
    specEl = ensureSpec(el);

    activeMax = cachedMax * tiltScaleFor(el);
    activeRect = el.getBoundingClientRect();
    setGridLifting(isHotPick(el));

    // Start eased values from flat so the card rises INTO position.
    curRx = curRy = 0; curMx = curMy = 50; curEng = 0;
    tgtEng = 1;
    if (keyboard) { tgtRx = tgtRy = 0; tgtMx = tgtMy = 50; }
    startLoop();
  }

  let releasing = false;

  function release(el) {
    if (!el || el !== activeEl) { if (el) hardReset(el); return; }
    tgtRx = 0; tgtRy = 0; tgtMx = 50; tgtMy = 50; tgtEng = 0;
    releasing = true;
    startLoop();
  }

  function finishRelease() {
    if (activeEl) hardReset(activeEl);
    setGridLifting(false);
    activeEl = null;
    specEl = null;
    activeRect = null;
    releasing = false;
    viaKeyboard = false;
  }

  function updateTargetFromPointer() {
    if (!activeRect || activeRect.width === 0 || activeRect.height === 0) return;
    const cx = Math.min(Math.max((pointerX - activeRect.left) / activeRect.width, 0), 1);
    const cy = Math.min(Math.max((pointerY - activeRect.top) / activeRect.height, 0), 1);
    // PICASA-STYLE LIFT (user request, fixed direction): the card lifts and
    // tips so its RIGHT edge swings toward the viewer — like Picasa lifting an
    // image off the wall. The rotation is CONSTANT (does NOT chase the cursor),
    // so every card lifts the same way every time. CSS pairs this with a zoom
    // (scale via --engage) and blurs the sibling cards to focus the lifted one.
    // Only the specular highlight (--mx/--my) still tracks the cursor, reading
    // as light gliding over a fixed-lifted card.
    // rotateY < 0 brings the right edge toward the viewer; a small rotateX > 0
    // tips the top forward so it reads as "picked up", not just "rotated".
    if (isHotPick(activeEl)) {
      tgtRy = -activeMax;          // right edge lifts toward the user
      tgtRx = activeMax * 0.35;    // gentle top-forward tip
    } else {
      // modals (spikers / kbd-help) keep the subtle constant back-tilt
      tgtRx = activeMax * 0.5;
      tgtRy = 0;
    }
    tgtMx = cx * 100;
    tgtMy = cy * 100;
  }

  function frame() {
    rafId = 0;
    if (!activeEl) { releasing = false; return; }

    curRx += (tgtRx - curRx) * LERP;
    curRy += (tgtRy - curRy) * LERP;
    curMx += (tgtMx - curMx) * LERP;
    curMy += (tgtMy - curMy) * LERP;
    curEng += (tgtEng - curEng) * ENGAGE_LERP;

    const el = activeEl;
    el.style.setProperty('--rx', curRx.toFixed(3) + 'deg');
    el.style.setProperty('--ry', curRy.toFixed(3) + 'deg');
    el.style.setProperty('--engage', curEng.toFixed(4));
    if (specEl) {
      el.style.setProperty('--mx', curMx.toFixed(2) + '%');
      el.style.setProperty('--my', curMy.toFixed(2) + '%');
    }

    const settled =
      Math.abs(tgtRx - curRx) < SETTLE_EPS &&
      Math.abs(tgtRy - curRy) < SETTLE_EPS &&
      Math.abs(tgtMx - curMx) < 0.4 &&
      Math.abs(tgtMy - curMy) < 0.4 &&
      Math.abs(tgtEng - curEng) < 0.01;

    if (settled) {
      curRx = tgtRx; curRy = tgtRy; curMx = tgtMx; curMy = tgtMy; curEng = tgtEng;
      el.style.setProperty('--rx', curRx.toFixed(3) + 'deg');
      el.style.setProperty('--ry', curRy.toFixed(3) + 'deg');
      el.style.setProperty('--engage', curEng.toFixed(4));
      if (specEl) {
        el.style.setProperty('--mx', curMx.toFixed(2) + '%');
        el.style.setProperty('--my', curMy.toFixed(2) + '%');
      }
      if (releasing) finishRelease();
      return;   // self-stop
    }
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() { if (!rafId) rafId = requestAnimationFrame(frame); }

  // --- capability gate ------------------------------------------------------
  // Pointer tilt requires a fine pointer and a wide-enough viewport; everything
  // no-ops under reduced motion. Keyboard parity is wired whenever motion is OK.
  function pointerAllowed() {
    return finePointer.matches && !narrow.matches && !reduceMotion.matches;
  }

  // --- delegated handlers ---------------------------------------------------
  function onOver(stage, e) {
    if (!pointerAllowed()) return;
    const card = e.target.closest(stage.card);
    if (!card) return;
    if (card.closest('.hotpicks-grid[data-streaming]')) return;  // never engage mid-scan
    pointerX = e.clientX; pointerY = e.clientY;
    engage(card, stage.spec, false);
    updateTargetFromPointer();
    startLoop();
  }
  function onOut(stage, e) {
    const card = e.target.closest(stage.card);
    if (!card) return;
    const to = e.relatedTarget;
    if (to && card.contains(to)) return;     // internal child crossing
    if (viaKeyboard && card === activeEl) return;
    if (card === activeEl) release(card);
  }
  function onMove(e) {
    if (!activeEl || viaKeyboard) return;
    pointerX = e.clientX; pointerY = e.clientY;
    updateTargetFromPointer();
    startLoop();
  }

  function onFocusIn(e) {
    if (reduceMotion.matches) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    let isFocusVisible = false;
    try { isFocusVisible = t.matches(':focus-visible'); } catch (_) { isFocusVisible = false; }
    if (!isFocusVisible) return;   // fail-safe: never engage on touch tap
    for (const stage of STAGES) {
      const card = t.closest(stage.card);
      if (card) {
        if (card.closest('.hotpicks-grid[data-streaming]')) return;
        engage(card, stage.spec, true);
        startLoop();
        return;
      }
    }
  }
  function onFocusOut(e) {
    const t = e.target;
    if (!(t instanceof Element) || !activeEl) return;
    const card = t.closest('.hot-pick-card, .signal-box, .spikers-card, .kbd-help-card');
    if (card && card === activeEl && viaKeyboard) release(card);
  }

  // --- wiring ---------------------------------------------------------------
  let wired = false;
  const bound = [];
  let gridObserver = null;

  function wire() {
    if (wired) return;
    wired = true;
    STAGES.forEach((stage) => {
      const root = stage.root === 'document' ? document : (document.querySelector(stage.root) || document);
      const over = (e) => onOver(stage, e);
      const out = (e) => onOut(stage, e);
      root.addEventListener('pointerover', over, { passive: true });
      root.addEventListener('pointerout', out, { passive: true });
      bound.push({ t: root, ty: 'pointerover', fn: over });
      bound.push({ t: root, ty: 'pointerout', fn: out });
    });
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    bound.push({ t: document, ty: 'pointermove', fn: onMove });
    bound.push({ t: document, ty: 'focusin', fn: onFocusIn });
    bound.push({ t: document, ty: 'focusout', fn: onFocusOut });
    window.addEventListener('scroll', refreshRect, { passive: true, capture: true });
    window.addEventListener('resize', refreshRect, { passive: true });
    bound.push({ t: window, ty: 'scroll', fn: refreshRect, opts: true });
    bound.push({ t: window, ty: 'resize', fn: refreshRect });

    // If the active card is detached by an innerHTML re-render (esp. while
    // keyboard-focused — removal often fires no blur), release immediately.
    const grid = document.getElementById('hotpicks-grid');
    if (grid && 'MutationObserver' in window) {
      gridObserver = new MutationObserver(() => {
        if (activeEl && !document.contains(activeEl)) {
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          finishRelease();
        }
      });
      gridObserver.observe(grid, { childList: true });
    }
  }

  function unwire() {
    if (!wired) return;
    wired = false;
    bound.forEach(({ t, ty, fn, opts }) => t.removeEventListener(ty, fn, opts));
    bound.length = 0;
    if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (activeEl) finishRelease();
  }

  function sync() {
    // Reduced motion fully disables the layer. Otherwise wire (pointer handlers
    // self-gate via pointerAllowed(); keyboard parity always works).
    if (reduceMotion.matches) unwire();
    else wire();
  }

  [finePointer, reduceMotion, narrow].forEach((mq) => {
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeEl) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      finishRelease();
    }
  });

  sync();
}

export default initTilt3d;
