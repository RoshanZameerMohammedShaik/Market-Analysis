// Anti-hallucination post-check. After Mia's final reply assembles,
// flag any numerical claim that didn't appear in CONTEXT or any tool
// RESULT seen during this turn. We don't strip the number — we annotate
// it with a small ⚠ marker so the user can see and verify.
//
// Phase 8.2: don't flag illustrative numbers (ranges, examples).
// Phase 9 (this update): math-aware. When the reply contains explicit
// arithmetic like "974 / 8.80 = 110.68", evaluate the expression. If
// the LHS computes to the RHS within rounding tolerance, the result is
// verified — same status as a number that appeared in CONTEXT. Verified
// derived numbers chain: each becomes an input for subsequent equations
// (so a multi-step P&L calculation flows through cleanly).

const NUM_RE = /(\$?[-+]?\d{1,5}(?:,\d{3})*(?:\.\d+)?\s*(?:%|x|tokens|kudos)?)/g;

// Inline equation: "A op B = C" where op ∈ +, -, *, ×, /, ÷.
// Allows $, commas, and decimals on each operand.
const EQUATION_RE = /(\$?[-+]?\d[\d,]*(?:\.\d+)?)\s*([+\-*×/÷])\s*(\$?[-+]?\d[\d,]*(?:\.\d+)?)\s*=\s*(\$?[-+]?\d[\d,]*(?:\.\d+)?)/g;
// Two-step on the LHS: "A op B op C = D" (left-associative).
const EQUATION_3OP_RE = /(\$?[-+]?\d[\d,]*(?:\.\d+)?)\s*([+\-*×/÷])\s*(\$?[-+]?\d[\d,]*(?:\.\d+)?)\s*([+\-*×/÷])\s*(\$?[-+]?\d[\d,]*(?:\.\d+)?)\s*=\s*(\$?[-+]?\d[\d,]*(?:\.\d+)?)/g;

function asNumber(s) {
    const cleaned = String(s).replace(/[$,\s]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
}

function applyOp(a, op, b) {
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*' || op === '×') return a * b;
    if (op === '/' || op === '÷') return b === 0 ? null : a / b;
    return null;
}

// Tolerance for "computed matches asserted result." 1% relative or 0.01
// absolute, whichever is larger — covers rounding to 2 decimal places on
// dollar amounts and 4 decimals on share counts.
function withinTolerance(computed, asserted) {
    if (computed == null || !Number.isFinite(asserted)) return false;
    const absDiff = Math.abs(computed - asserted);
    const relTol = Math.max(Math.abs(asserted) * 0.01, 0.01);
    return absDiff <= relTol;
}

// Walk the reply and harvest verified results from any well-formed
// equation. Multi-pass: each verified result is added to the seen set,
// which lets the next equation use it as a verified operand.
function harvestVerifiedFromEquations(reply, seen) {
    if (!reply) return;
    let prevSize = -1;
    let safety = 0;
    while (seen.size !== prevSize && safety < 8) {
        prevSize = seen.size;
        safety++;
        // 3-operand first (so "974 - 880.53 = 93.47" inside a longer
        // expression doesn't shadow the 2-operand match).
        let m;
        EQUATION_3OP_RE.lastIndex = 0;
        while ((m = EQUATION_3OP_RE.exec(reply)) !== null) {
            const a = asNumber(m[1]);
            const op1 = m[2];
            const b = asNumber(m[3]);
            const op2 = m[4];
            const c = asNumber(m[5]);
            const r = asNumber(m[6]);
            if (a == null || b == null || c == null || r == null) continue;
            const intermediate = applyOp(a, op1, b);
            if (intermediate == null) continue;
            const computed = applyOp(intermediate, op2, c);
            if (withinTolerance(computed, r)) {
                // Use the raw string forms so trailing-zero variants
                // (121.30 vs 121.3) both match downstream.
                seen.add(normalize(m[6]));
                seen.add(normalize(String(intermediate)));
            }
        }
        EQUATION_RE.lastIndex = 0;
        while ((m = EQUATION_RE.exec(reply)) !== null) {
            const a = asNumber(m[1]);
            const op = m[2];
            const b = asNumber(m[3]);
            const r = asNumber(m[4]);
            if (a == null || b == null || r == null) continue;
            const computed = applyOp(a, op, b);
            if (withinTolerance(computed, r)) seen.add(normalize(m[4]));
        }
    }
}

// Phrases that contextually mark a number as illustrative, not a real claim.
const EXAMPLE_LEADERS = [
    'for example',
    'for instance',
    'e.g.',
    'eg.',
    'i.e.',
    'such as',
    'like ',
    'imagine',
    'say ',
    'if the confidence is',
    'if confidence is',
    'if the score is',
    'if the price is',
    'ranges from',
    'ranging from',
    'between ',
    'on a scale of',
    'on a scale from',
    'from 0 to',
    'from 1 to',
];

// Range patterns that should NOT be flagged: numbers inside something like
// "0 to 100", "0-100", "0–100", "0 through 100".
function isRangeContext(reply, idx, len) {
    const before = reply.slice(Math.max(0, idx - 20), idx);
    const after = reply.slice(idx + len, idx + len + 20);
    if (/(?:to|through|–|—|-)\s*$/i.test(before)) return true;
    if (/^\s*(?:to|through|–|—|-)\s*\d/i.test(after)) return true;
    return false;
}

function isExampleContext(reply, idx) {
    const window = reply.slice(Math.max(0, idx - 80), idx).toLowerCase();
    return EXAMPLE_LEADERS.some(p => window.includes(p));
}

export function flagUnverifiedNumbers(reply, sources) {
    if (!reply) return reply;
    const seenNumbers = new Set();
    for (const src of sources) if (src) {
        const text = typeof src === 'string' ? src : JSON.stringify(src);
        const m = text.match(NUM_RE) || [];
        m.forEach(n => seenNumbers.add(normalize(n)));
    }
    // Math-aware: verify derived numbers from explicit arithmetic, chained.
    harvestVerifiedFromEquations(reply, seenNumbers);

    const unverified = [];
    const annotated = reply.replace(NUM_RE, (match, _g, offset) => {
        const norm = normalize(match);
        const trimmed = match.trim();

        // Allow single-digit ordinals (1., 2., 3.) — common in lists.
        if (/^\d{1,2}$/.test(trimmed) && !match.includes('%')) return match;

        // Already grounded in CONTEXT or tool RESULT.
        if (seenNumbers.has(norm)) return match;

        // Range patterns and example phrases — illustrative, not factual.
        if (isRangeContext(reply, offset, match.length)) return match;
        if (isExampleContext(reply, offset)) return match;

        unverified.push(match.trim());
        return match;
    });

    if (unverified.length === 0) return annotated;

    // Consolidate to a single trailing footnote rather than inline marks on
    // every number. Less visual noise; the user still gets the warning.
    const sample = [...new Set(unverified)].slice(0, 4).join(', ');
    const more = unverified.length > 4 ? ` (+${unverified.length - 4} more)` : '';
    const note = `\n\n<div class="mia-unverified-note" title="These numbers weren't in tool results or signal data—double-check them."><span class="mia-unverified-icon">⚠</span> Verify: ${sample}${more}</div>`;
    return annotated + note;
}

function normalize(s) {
    let out = s.replace(/[\s$,]/g, '').toLowerCase();
    // Drop trailing zeros after a decimal point ("121.30" → "121.3", "8.80" → "8.8")
    // so trailing-zero variants of the same value collide in the seen set.
    if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
    return out;
}
