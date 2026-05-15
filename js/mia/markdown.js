// Safe markdown renderer for Mia replies. Supports:
//   # / ## / ### headings
//   **bold** (multi-line ok), *italic*, `inline code`
//   - / *  bullet lists; 1. 2. 3. ordered lists
//   ```fenced``` code blocks
//   GitHub-flavored | a | b | tables with --- separator row
//   blank-line paragraphs
// Everything else is escaped first — no raw HTML, no script execution.
//
// Why hand-rolled: shipping 50KB of marked.js for a chat bubble is silly.
// Why bother: tables, headings, and multi-line bold come up constantly
// in stock comparisons and Mia's analyses.

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function renderMarkdown(src) {
    if (src == null) return '';
    const escaped = escapeHtml(src);
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

        // Fenced code block: ```
        if (/^```/.test(trimmed)) {
            flushAll();
            const buf = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i].trim())) {
                buf.push(lines[i]);
                i++;
            }
            i++; // consume closing fence (or EOF)
            out.push(`<pre class="mia-pre"><code>${buf.join('\n')}</code></pre>`);
            continue;
        }

        // Heading: # / ## / ###
        const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
            flushAll();
            const level = heading[1].length;
            out.push(`<h${level + 2} class="mia-h mia-h${level}">${inlineFmt(heading[2])}</h${level + 2}>`);
            i++;
            continue;
        }

        // GFM-style table: detect header row + separator row
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

        // Bullet list
        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        if (bullet) {
            flushPara();
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (!inUl) { out.push('<ul>'); inUl = true; }
            out.push(`<li>${inlineFmt(bullet[1])}</li>`);
            i++;
            continue;
        }

        // Ordered list: 1. 2. 3.
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

function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|');
}

function inlineFmt(s) {
    // Order matters: code first (its contents must not be re-formatted), then
    // bold (greedy across whitespace, including newlines collapsed into spaces),
    // then italic.
    return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>');
}
