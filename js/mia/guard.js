// Anti-hallucination post-check. After Mia's final reply assembles,
// any number that isn't anchored to one of the verification sources
// gets surfaced as "needs verification" via a single trailing footnote.
//
// Verification sources (any of these earns a number a pass):
//   1. The number appears verbatim in CONTEXT or a tool RESULT.
//   2. The number appears in an inline equation "A op B = C" whose LHS
//      computes to the RHS within ~1% tolerance. Multi-pass: each
//      verified result becomes an input for subsequent equations.
//   3. The number is within 1% of any already-verified number (lets
//      the model round in headlines: "$92.99" → "about $93").
//   4. The number sits inside a range pattern ("0 to 100", "0-100").
//      Pure structural grammar, not a content list.
//
// We deliberately don't enumerate "example phrases" or any prose
// blacklist — the equation/structure checks above are enough; a
// number without grounding deserves the gentle nudge.

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

// Range syntax: numbers connected by a range token ("0 to 100", "0-100",
// "0–100", "between 5 and 10"). Pure structural pattern — closed-class
// grammatical connectors, not an enumeration of prose. Numbers inside
// such patterns are illustrative.
//
// We check both sides of the matched number AND look for a sibling
// number connected by a range token. Matching includes the case where
// NUM_RE captured the number with a leading "-" (so "0-100" yields
// matches "0" and "-100"; the "-100" match's preceding char is a digit,
// which is the structural giveaway for "this hyphen is a range, not a
// sign").
const SIBLING_NUM_AFTER = /^\s*(?:to|through|until|–|—|-)\s*\d/i;
const SIBLING_NUM_BEFORE = /\d\s*(?:to|through|until|–|—|-)\s*$/i;

function isRangeContext(reply, idx, len) {
    const before = reply.slice(Math.max(0, idx - 24), idx);
    const after = reply.slice(idx + len, idx + len + 24);

    // Case A: matched number is followed by a range-token then another digit.
    if (SIBLING_NUM_AFTER.test(after)) return true;

    // Case B: matched number is preceded by digit + range-token (e.g. "0-").
    if (SIBLING_NUM_BEFORE.test(before)) return true;

    // Case C: NUM_RE captured a leading "-" but the char immediately before
    // is a digit, so the "-" is a range-hyphen, not a sign.
    if (reply[idx] === '-' && idx > 0 && /\d/.test(reply[idx - 1])) return true;

    return false;
}

// Sentinel emitted by flagUnverifiedNumbers when the reply contains
// unverified numbers. mia.js detects this token AFTER markdown rendering
// (so the HTML doesn't get escaped) and renders the real footnote.
// Format: §§MIA_UNVERIFIED:comma-joined-numbers§§
export const UNVERIFIED_TOKEN_RE = /§§MIA_UNVERIFIED:([^§]*)§§/;

// Numbers within 1% of a verified number are themselves considered
// verified. Lets Mia round results in the headline ($92.99 → "about $93")
// without tripping a flag.
function fuzzyMatchVerified(candidate, seenSet) {
    const cand = parseFloat(candidate.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(cand)) return false;
    for (const seen of seenSet) {
        const s = parseFloat(seen);
        if (!Number.isFinite(s)) continue;
        const tol = Math.max(Math.abs(s) * 0.01, 0.01);
        if (Math.abs(cand - s) <= tol) return true;
    }
    return false;
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
    reply.replace(NUM_RE, (match, _g, offset) => {
        const norm = normalize(match);
        const trimmed = match.trim();

        // Allow single-digit ordinals (1., 2., 3.) — common in lists.
        if (/^\d{1,2}$/.test(trimmed) && !match.includes('%')) return match;

        // Already grounded in CONTEXT or tool RESULT (exact or ~1% fuzzy).
        if (seenNumbers.has(norm)) return match;
        if (fuzzyMatchVerified(norm, seenNumbers)) return match;

        // Range patterns ("0 to 100") — illustrative, not factual.
        if (isRangeContext(reply, offset, match.length)) return match;

        unverified.push(match.trim());
        return match;
    });

    if (unverified.length === 0) return reply;

    // Emit a sentinel token (no HTML) that mia.js substitutes after
    // markdown render. Avoids HTML-injected-into-paragraph escape issues.
    const sample = [...new Set(unverified)].slice(0, 4).join(', ');
    const more = unverified.length > 4 ? ` (+${unverified.length - 4} more)` : '';
    return reply + `\n\n§§MIA_UNVERIFIED:${sample}${more}§§`;
}

function normalize(s) {
    let out = s.replace(/[\s$,]/g, '').toLowerCase();
    // Drop trailing zeros after a decimal point ("121.30" → "121.3", "8.80" → "8.8")
    // so trailing-zero variants of the same value collide in the seen set.
    if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
    return out;
}
