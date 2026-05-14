// Anti-hallucination post-check. After Mia's final reply assembles,
// flag any numerical claim that didn't appear in CONTEXT or any tool
// RESULT seen during this turn. We don't strip the number — we annotate
// it with a small ⚠ marker so the user can see and verify.
//
// This is a safety net, not the primary defense. The primary defense is
// the system prompt + tool-use loop. This catches the rare slip.

const NUM_RE = /(\$?[-+]?\d{1,5}(?:,\d{3})*(?:\.\d+)?\s*(?:%|x|tokens|kudos)?)/g;

export function flagUnverifiedNumbers(reply, sources) {
    if (!reply) return reply;
    const seenNumbers = new Set();
    for (const src of sources) if (src) {
        const text = typeof src === 'string' ? src : JSON.stringify(src);
        const m = text.match(NUM_RE) || [];
        m.forEach(n => seenNumbers.add(normalize(n)));
    }

    return reply.replace(NUM_RE, (match) => {
        const norm = normalize(match);
        // Allow tiny ordinal numbers (1, 2, 3 single-digits often referring to lists)
        if (/^\d{1,2}$/.test(match.trim()) && !match.includes('%')) return match;
        if (seenNumbers.has(norm)) return match;
        // Allow common no-data phrases that include a number incidentally.
        return `${match}<sup class="mia-unverified" title="This number wasn\'t in tool results or signal data—double-check it.">⚠</sup>`;
    });
}

function normalize(s) {
    return s.replace(/[\s$,]/g, '').toLowerCase();
}
