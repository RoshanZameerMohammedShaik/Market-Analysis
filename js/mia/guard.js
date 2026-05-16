// Anti-hallucination post-check. After Mia's final reply assembles,
// flag any numerical claim that didn't appear in CONTEXT or any tool
// RESULT seen during this turn. We don't strip the number — we annotate
// it with a small ⚠ marker so the user can see and verify.
//
// Phase 8.2 update: don't flag illustrative/explanatory numbers. The
// guard was wrapping things like "0 to 100" or "for example, 85" with
// warnings, which made educational answers look broken. We now exempt:
//   1. Range patterns: "0 to 100", "0–100", "between 0 and 100"
//   2. Example phrases: "for example", "e.g.", "such as", "if the X is N"
//   3. Tiny single-digit ordinals (was already exempt)

const NUM_RE = /(\$?[-+]?\d{1,5}(?:,\d{3})*(?:\.\d+)?\s*(?:%|x|tokens|kudos)?)/g;

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

    return reply.replace(NUM_RE, (match, _g, offset) => {
        const norm = normalize(match);
        const trimmed = match.trim();

        // Allow single-digit ordinals (1., 2., 3.) — common in lists.
        if (/^\d{1,2}$/.test(trimmed) && !match.includes('%')) return match;

        // Already grounded in CONTEXT or tool RESULT.
        if (seenNumbers.has(norm)) return match;

        // Range patterns and example phrases — illustrative, not factual.
        if (isRangeContext(reply, offset, match.length)) return match;
        if (isExampleContext(reply, offset)) return match;

        return `${match}<sup class="mia-unverified" title="This number wasn\'t in tool results or signal data—double-check it.">⚠</sup>`;
    });
}

function normalize(s) {
    return s.replace(/[\s$,]/g, '').toLowerCase();
}
