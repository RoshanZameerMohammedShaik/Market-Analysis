// Escaping for text that came from someone else.
//
// Headlines, publisher names, company and coin names all arrive from third-party feeds (Bing and
// Google News RSS, Yahoo, CoinGecko) and were interpolated straight into innerHTML. An RSS title
// is decoded text: "&lt;img src=x onerror=...&gt;" in the XML becomes a live tag in the page, in
// the same origin that holds the user's Gemini key and GitHub token in localStorage. Anything not
// written by this app goes through one of these before it touches markup.

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => HTML_ESC[c]);
}

/** Only http(s) links survive. A feed can carry "javascript:" as easily as a real URL. */
export function safeHttpUrl(u) {
    const s = String(u ?? '').trim();
    if (!s) return '';
    try {
        const parsed = new URL(s);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
    } catch (_) { return ''; }
}
