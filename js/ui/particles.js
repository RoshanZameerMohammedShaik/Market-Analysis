// particles.js — a lightweight ambient particle field (canvas 2D).
//
// Inspired by particle-love.com: a drifting field of points connected by
// thin lines, gently reacting to the cursor. NOT a heavy WebGL sim — a
// capped, GPU-friendly canvas field tuned to sit behind content without
// stealing focus or frames. Theme-aware (recolours from --accent), and it
// fully stops when off-screen / tab hidden / reduced-motion.
//
// Usage:  const stop = mountParticles(hostEl);  // returns a teardown fn
//
// Design constraints (match the app's standing rules):
//   • prefers-reduced-motion → no-op (returns a no-op teardown).
//   • Particle count scales with area but HARD-capped, so a big hero doesn't
//     spawn thousands. DPR-aware but clamped to 2 so 3x phones don't melt.
//   • One rAF loop; pauses on document.hidden and when the host scrolls out
//     of view (IntersectionObserver). No work at rest.
//   • Pointer reaction is read from a cheap mousemove (throttled by rAF), and
//     only while the pointer is over the host.

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
}

function accentRgb() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
    return v || '74, 158, 255';
}

export function mountParticles(host, opts = {}) {
    if (!host || reducedMotion()) return () => {};
    if (typeof window === 'undefined') return () => {};

    const {
        density = 0.00010,   // particles per px² (area-scaled)
        maxParticles = 90,   // hard cap
        maxLink = 120,       // px: draw a line between particles closer than this
        pointerRadius = 130, // px: cursor influence radius
        speed = 0.18,        // base drift speed
    } = opts;

    const canvas = document.createElement('canvas');
    canvas.className = 'particle-canvas';
    // Behind the host's content; host should be position:relative.
    Object.assign(canvas.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '0',
    });
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) { canvas.remove(); return () => {}; }

    let dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0, h = 0;
    let particles = [];
    let raf = 0;
    let running = false;
    let visible = true;
    const pointer = { x: -9999, y: -9999, active: false };

    function resize() {
        const r = host.getBoundingClientRect();
        w = Math.max(1, Math.floor(r.width));
        h = Math.max(1, Math.floor(r.height));
        dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // (Re)seed particle count from the new area.
        const target = Math.min(maxParticles, Math.max(18, Math.floor(w * h * density)));
        if (particles.length !== target) {
            particles = Array.from({ length: target }, () => ({
                x: Math.random() * w,
                y: Math.random() * h,
                vx: (Math.random() - 0.5) * speed,
                vy: (Math.random() - 0.5) * speed,
                r: 0.8 + Math.random() * 1.4,
            }));
        }
    }

    function step() {
        raf = 0;
        if (!running || !visible) return;
        ctx.clearRect(0, 0, w, h);
        const rgb = accentRgb();
        const n = particles.length;

        for (let i = 0; i < n; i++) {
            const p = particles[i];
            // Drift.
            p.x += p.vx; p.y += p.vy;
            // Wrap around edges (seamless field).
            if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
            if (p.y < -10) p.y = h + 10; else if (p.y > h + 10) p.y = -10;
            // Cursor repulsion — particles ease away from the pointer.
            if (pointer.active) {
                const dx = p.x - pointer.x, dy = p.y - pointer.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < pointerRadius * pointerRadius && d2 > 0.5) {
                    const d = Math.sqrt(d2);
                    const force = (pointerRadius - d) / pointerRadius * 0.6;
                    p.x += (dx / d) * force;
                    p.y += (dy / d) * force;
                }
            }
            // Dot.
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${rgb}, 0.55)`;
            ctx.fill();
        }

        // Links between near particles (O(n²) but n is capped ≤90 → ≤~4k checks).
        for (let i = 0; i < n; i++) {
            const a = particles[i];
            for (let j = i + 1; j < n; j++) {
                const b = particles[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < maxLink * maxLink) {
                    const alpha = (1 - Math.sqrt(d2) / maxLink) * 0.28;
                    ctx.strokeStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
            }
        }
        raf = requestAnimationFrame(step);
    }

    function start() {
        if (running) return;
        running = true;
        if (!raf) raf = requestAnimationFrame(step);
    }
    function stop() {
        running = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    // Pointer reaction (only while over the host).
    const onMove = (e) => {
        const r = host.getBoundingClientRect();
        pointer.x = e.clientX - r.left;
        pointer.y = e.clientY - r.top;
        pointer.active = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= r.width && pointer.y <= r.height;
    };
    const onLeave = () => { pointer.active = false; };
    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerleave', onLeave, { passive: true });

    // Pause when scrolled off-screen.
    let io = null;
    if ('IntersectionObserver' in window) {
        io = new IntersectionObserver((entries) => {
            visible = entries[0]?.isIntersecting ?? true;
            if (visible && running) { if (!raf) raf = requestAnimationFrame(step); }
        }, { threshold: 0 });
        io.observe(host);
    }
    // Pause when tab hidden.
    const onVis = () => {
        if (document.hidden) stop();
        else start();
    };
    document.addEventListener('visibilitychange', onVis);

    // Resize handling.
    let ro = null;
    if ('ResizeObserver' in window) {
        ro = new ResizeObserver(() => resize());
        ro.observe(host);
    } else {
        window.addEventListener('resize', resize);
    }

    resize();
    start();

    // Teardown.
    return () => {
        stop();
        host.removeEventListener('pointermove', onMove);
        host.removeEventListener('pointerleave', onLeave);
        document.removeEventListener('visibilitychange', onVis);
        if (io) io.disconnect();
        if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
        canvas.remove();
    };
}
