// Always-on debug capture. Loaded via a tiny inline script at the
// top of every page (see index.html / dev/index.html) BEFORE any
// app module — that's the only way to catch errors thrown during
// the early ES-module load phase.
//
// Captured streams:
//   1. console.log / warn / error / info / debug — full args
//   2. window.onerror — uncaught synchronous exceptions
//   3. unhandledrejection — Promise rejections without a .catch
//   4. fetch failures — 4xx / 5xx responses + network errors
//
// Storage: ring buffer (last 1000 entries). Past that, oldest drops.
// Memory ceiling on a long session capped at ~1MB.
//
// Redaction: every captured string gets the same key/token regex
// scrub before it lands in the buffer. We never store the raw key
// even internally, so a copy-all from the debug UI is guaranteed safe.
//
// This module is "passive" — it only collects. The /dev/console UI
// reads window.__debugBuffer and renders it.

(function installDebugCapture() {
    if (window.__debugCaptureInstalled) return;
    window.__debugCaptureInstalled = true;

    const MAX_ENTRIES = 1000;
    const buffer = [];
    window.__debugBuffer = buffer;
    window.__debugListeners = new Set();

    function notify() {
        for (const fn of window.__debugListeners) {
            try { fn(); } catch (_) {}
        }
    }

    // Single-pass redactor for any captured text. Same regex set
    // we'd use on a clipboard scrubber — keeps the capture buffer
    // safe to copy or screenshot.
    function redact(s) {
        return String(s)
            .replace(/[?&]key=[A-Za-z0-9_-]+/g, m => m.split('=')[0] + '=<REDACTED>')
            .replace(/AIza[0-9A-Za-z_-]{35}/g, '<REDACTED-KEY>')
            .replace(/\bAQ[\.\-_][A-Za-z0-9_-]{20,}/g, '<REDACTED-KEY>')
            .replace(/\bAQ[A-Za-z0-9_-]{30,}/g, '<REDACTED-KEY>')
            .replace(/ya29\.[A-Za-z0-9_-]+/g, '<REDACTED-OAUTH>')
            .replace(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g, '<REDACTED-PEM>');
    }

    function fmtArg(a) {
        if (a == null) return String(a);
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    }

    // Tag detection: any "[xxx]" prefix anywhere in the joined message
    // becomes the source tag. First match wins. Default 'app'.
    function detectTag(text) {
        const m = text.match(/\[([a-z][a-z0-9/_-]{1,20})\]/i);
        return m ? m[1].toLowerCase() : 'app';
    }

    function record(level, args, opts = {}) {
        const text = redact(args.map(fmtArg).join(' '));
        buffer.push({
            ts: Date.now(),
            level,
            text,
            tag: opts.tag || detectTag(text),
        });
        if (buffer.length > MAX_ENTRIES) buffer.shift();
        notify();
    }

    // Hook console levels — preserve original output so DevTools
    // still works normally for anyone who has it open.
    const origConsole = {};
    ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
        origConsole[level] = console[level].bind(console);
        console[level] = (...args) => {
            try { record(level, args); } catch (_) {}
            origConsole[level](...args);
        };
    });

    // Uncaught synchronous errors.
    window.addEventListener('error', (e) => {
        // Resource load errors (script/img/css 404) come through here
        // with e.target being the failing element, not e.error.
        if (e.error) {
            record('error', [e.error.stack || `${e.error.name}: ${e.error.message}`], { tag: 'window' });
        } else if (e.target && e.target !== window) {
            record('error', [`Failed to load: ${e.target.tagName} ${e.target.src || e.target.href || ''}`], { tag: 'window' });
        } else {
            record('error', [`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`], { tag: 'window' });
        }
    }, true); // capture phase so we beat anything that re-throws

    // Promise rejections without a .catch.
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        const msg = r instanceof Error ? (r.stack || `${r.name}: ${r.message}`) : fmtArg(r);
        record('error', [`Unhandled rejection: ${msg}`], { tag: 'promise' });
    });

    // fetch failures: wrap window.fetch so we see 4xx / 5xx and
    // network errors centrally. Doesn't change behavior — we just
    // observe the result and log on failure.
    const origFetch = window.fetch?.bind(window);
    if (origFetch) {
        window.fetch = async (...args) => {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            try {
                const res = await origFetch(...args);
                if (!res.ok) {
                    record('warn', [`fetch ${res.status} ${res.statusText} — ${url}`], { tag: 'fetch' });
                }
                return res;
            } catch (err) {
                record('error', [`fetch error — ${url} — ${err.message}`], { tag: 'fetch' });
                throw err;
            }
        };
    }

    // Public API for the dev console UI.
    window.__debugCapture = {
        get entries() { return buffer.slice(); },
        clear() { buffer.length = 0; notify(); },
        subscribe(fn) {
            window.__debugListeners.add(fn);
            return () => window.__debugListeners.delete(fn);
        },
        copyAll() {
            const text = buffer.map(e => {
                const t = new Date(e.ts).toISOString().slice(11, 23);
                return `${t} [${e.level}] [${e.tag}] ${e.text}`;
            }).join('\n');
            return navigator.clipboard.writeText(text);
        },
    };

    // Sentinel to confirm capture is active. Useful when debugging
    // the debugger.
    record('info', ['[debug-capture] installed — capturing console + errors + fetch failures'], { tag: 'debug-capture' });
})();
