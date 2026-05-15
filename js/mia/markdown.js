// Safe markdown renderer for Mia replies.
//
// Phase 6 add: detects the structured 'Engine view: ... Mia's read: ...'
// shape (Phase 4 prompt rule) and renders the two halves visually distinct
// via a split card. Falls through to normal markdown if the structure
// isn't present, so unrelated answers render unchanged.
//
// Supports:
//   # / ## / ### headings
//   **bold** (multi-line ok), *italic*, `inline code`
//   - / *  bullet lists; 1. 2. 3. ordered lists
//   ```fenced``` code blocks
//   GitHub-flavored | a | b | tables with --- separator row
//   blank-line paragraphs
// Everything else is escaped first — no raw HTML, no script execution.

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Detect Phase 4's 'Engine view: ... Mia's read: ...' structure.
// Match is case-insensitive, multiline; both labels must appear and the
// engine view must come first.
const SPLIT_RE = /^\s*\**\s*Engine\s+view:?\s*\**[\s:\n]*([\s\S]+?)\n\s*\**\s*(?:Mia['’]?s\s+read|My\s+read):?\s*\**[\s:\n]*([\s\S]+?)\s*$/i;

function renderInline(src) {
    const escaped = escapeHtml(src);
    return inlineFmtBlock(escaped);
}

function inlineFmtBlock(escaped) {
    const lines = escaped.split('\n');
    const out = [];
    let i = 0;
    let para = [];
    let inUl = false;
    let inOl = false;

    const closeLists = () => {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
    };
    const flushPara = () => {
        if (para.length === 0) return;
        out.push(`<p>${inlineFmt(para.join(' '))}</p>`);
        para = [];
    };
    const flushAll = () => { flushPara(); closeLists(); };

    while (i < lines.length) {
        const raw = lines[i];
        const line = raw.trimEnd();
        const trimmed = line.trim();

        if (/^```/.test(trimmed)) {
            flushAll();
            const buf = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i].trim())) {
                buf.push(lines[i]);
                i++;
            }
            i++;
            out.push(`<pre class="mia-pre"><code>${buf.join('\n')}</code></pre>`);
            continue;
        }

        const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
            flushAll();
            const level = heading[1].length;
            out.push(`<h${level + 2} class="mia-h mia-h${level}">${inlineFmt(heading[2])}</h${level + 2}>`);
            i++;
            continue;
        }

        if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?\s*$/.test(lines[i + 1].trim())) {
            flushAll();
            const headerCells = splitTableRow(line);
            const aligns = splitTableRow(lines[i + 1]).map(c => {
                const s = c.trim();
                if (/^:-+:$/.test(s)) return 'center';
                if (/-+:$/.test(s)) return 'right';
                return 'left';
            });
            i += 2;
            const bodyRows = [];
            while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
                bodyRows.push(splitTableRow(lines[i]));
                i++;
            }
            const ths = headerCells.map((c, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${inlineFmt(c.trim())}</th>`).join('');
            const trs = bodyRows.map(row => `<tr>${row.map((c, idx) => `<td style="text-align:${aligns[idx] || 'left'}">${inlineFmt(c.trim())}</td>`).join('')}</tr>`).join('');
            out.push(`<table class="mia-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
            continue;
        }

        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        if (bullet) {
            flushPara();
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (!inUl) { out.push('<ul>'); inUl = true; }
            out.push(`<li>${inlineFmt(bullet[1])}</li>`);
            i++;
            continue;
        }

        const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
        if (ordered) {
            flushPara();
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (!inOl) { out.push('<ol>'); inOl = true; }
            out.push(`<li>${inlineFmt(ordered[1])}</li>`);
            i++;
            continue;
        }

        if (inUl || inOl) closeLists();

        if (trimmed === '') {
            flushPara();
            i++;
            continue;
        }
        para.push(line);
        i++;
    }
    flushAll();
    return out.join('');
}

// Highlight cited domains and 'reportedly' qualifiers in the inline pass.
function inlineFmt(s) {
    return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>')
        // Highlight domain citations: 'per <domain>.<tld>' or 'according to <domain>.<tld>'
        .replace(/\b(per|according to)\s+([a-z0-9-]+\.[a-z0-9.-]+)/gi, '$1 <span class="mia-cite">$2</span>')
        // Soften 'reportedly' as a hedge marker
        .replace(/\b(reportedly)\b/gi, '<span class="mia-hedge">$1</span>');
}

export function renderMarkdown(src) {
    if (src == null) return '';
    const trimmed = String(src).trim();

    // Phase 6: split-card render when the model used the Engine view + Mia's read structure.
    const split = trimmed.match(SPLIT_RE);
    if (split) {
        const engineHtml = inlineFmtBlock(escapeHtml(split[1].trim()));
        const miaHtml = inlineFmtBlock(escapeHtml(split[2].trim()));
        return `<div class="mia-split">
            <div class="mia-split-pane mia-split-engine">
                <div class="mia-split-label">Engine view</div>
                <div class="mia-split-body">${engineHtml}</div>
            </div>
            <div class="mia-split-pane mia-split-mia">
                <div class="mia-split-label">Mia's read</div>
                <div class="mia-split-body">${miaHtml}</div>
            </div>
        </div>`;
    }

    return renderInline(trimmed);
}

function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|');
}
