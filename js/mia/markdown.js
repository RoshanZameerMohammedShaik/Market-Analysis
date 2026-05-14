// Tiny, safe markdown renderer for Mia's replies. Supports:
//   **bold**, *italic*, `inline code`, - bullet lists, blank-line paragraphs.
// Everything else is escaped — no raw HTML, no script execution.
//
// Why not a full lib: shipping 50KB of marked.js for a chat bubble is silly.
// Why bother: without this, replies show literal asterisks and dashes.

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function renderMarkdown(src) {
    const escaped = escapeHtml(src);
    const lines = escaped.split('\n');
    const out = [];
    let inList = false;
    let para = [];

    const flushPara = () => {
        if (para.length === 0) return;
        const text = inlineFmt(para.join(' '));
        out.push(`<p>${text}</p>`);
        para = [];
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        if (bullet) {
            flushPara();
            if (!inList) { out.push('<ul>'); inList = true; }
            out.push(`<li>${inlineFmt(bullet[1])}</li>`);
            continue;
        }
        if (inList) { out.push('</ul>'); inList = false; }
        if (line.trim() === '') {
            flushPara();
            continue;
        }
        para.push(line);
    }
    flushPara();
    if (inList) out.push('</ul>');
    return out.join('');
}

function inlineFmt(s) {
    // Order matters: code first (so its contents aren't re-formatted), then bold, then italic.
    return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>');
}
