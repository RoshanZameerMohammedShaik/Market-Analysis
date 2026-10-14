import { state } from './state.js';
import { timeAgo } from './format.js';
import { generateNewsImpact } from './reasons.js';
import { escapeHtml, safeHttpUrl } from './escape.js';

// THE NEWS CARD (Roshan, 2026-10-14): each headline keeps its title, link, source and the kind of
// coverage it is, and now also shows what the article itself says, extracted from the page it
// links to (the Worker's /extract-article, the same reader the sentiment score already uses on
// the newest three). A bar on top shows how the score's weight splits between positive, neutral
// and negative headlines: each headline counts by how recent it is and how reliable its source
// is (js/sentiment.js), exactly as in the score.

const LEAD_CHARS = 700;
const NO_TEXT = 'The article text could not be read here. The link opens it at the source.';
const leadCache = new Map();          // url -> { paras, domain } | false (nothing readable)

/** The article's opening paragraphs, up to about LEAD_CHARS, without bylines and boilerplate. */
export function leadParagraphs(text, max = LEAD_CHARS) {
    const paras = String(text || '').split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim())
        .filter(p => (p.length >= 60 || (p.length >= 20 && /[.!?]["')\]]?$/.test(p)))
            && !/^(advertisement|subscribe|sign up|read more|related|click here|story continues)/i.test(p));
    const out = [];
    let len = 0;
    for (const p of paras) {
        if (len && len + p.length > max) break;
        if (p.length > max) {
            // One long paragraph: cut at the last sentence end that fits.
            const cut = p.slice(0, max);
            const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
            out.push(end > 120 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`);
            break;
        }
        out.push(p);
        len += p.length;
    }
    return out;
}

/** How the score's weight splits by label, from each headline's own weight. null when unknown. */
export function weightSplit(items) {
    let pos = 0, neg = 0, neu = 0, n = 0;
    for (const it of items || []) {
        const w = Number(it?.weight);
        if (!(w > 0)) continue;
        n++;
        const l = it.sentiment?.label;
        if (l === 'positive') pos += w;
        else if (l === 'negative') neg += w;
        else neu += w;
    }
    const t = pos + neg + neu;
    return t > 0 ? { pos: pos / t, neg: neg / t, neu: neu / t, n } : null;
}

function weightBar(items) {
    const s = weightSplit(items);
    if (!s) return '';
    const p = (x) => `${Math.round(x * 100)}%`;
    const w = (x) => (x * 100).toFixed(2);
    return `
        <div class="news-weight" title="Each headline counts by how recent it is and how reliable its source is, the same weights the sentiment score uses.">
            <div class="news-weight-bar" role="img" aria-label="Positive ${p(s.pos)}, neutral ${p(s.neu)}, negative ${p(s.neg)} of the weight">
                ${s.pos > 0 ? `<span class="nw-pos" style="width:${w(s.pos)}%"></span>` : ''}${s.neu > 0 ? `<span class="nw-neu" style="width:${w(s.neu)}%"></span>` : ''}${s.neg > 0 ? `<span class="nw-neg" style="width:${w(s.neg)}%"></span>` : ''}
            </div>
            <div class="news-weight-legend">
                <span><i class="nw-k nw-k-pos"></i>Positive ${p(s.pos)}</span>
                <span><i class="nw-k nw-k-neu"></i>Neutral ${p(s.neu)}</span>
                <span><i class="nw-k nw-k-neg"></i>Negative ${p(s.neg)}</span>
                <span class="nw-note">of the weight across ${s.n} headline${s.n === 1 ? '' : 's'}, newer and better-sourced ones counting more</span>
            </div>
        </div>`;
}

function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function leadHtml(paras, domain, href, preview = false) {
    return `
        <div class="news-lead-label">From the article${domain ? `, ${escapeHtml(domain)}` : ''}${preview ? ' · only its opening is readable outside the source' : ''}</div>
        ${paras.map(p => `<p>${escapeHtml(p)}</p>`).join('')}
        ${href ? `<a class="news-lead-more" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Read the full article</a>` : ''}`;
}

function leadBlock(item, href) {
    const cached = href ? leadCache.get(href) : undefined;
    const fromScore = item.articleText ? leadParagraphs(item.articleText) : [];
    if (fromScore.length) return `<div class="news-lead" data-state="ready">${leadHtml(fromScore, domainOf(href), href)}</div>`;
    if (cached) return `<div class="news-lead" data-state="ready">${leadHtml(cached.paras, cached.domain, href, cached.preview)}</div>`;
    const feed = item.summary ? `<div class="news-lead-label">The feed's summary</div><p>${escapeHtml(item.summary)}</p>` : '';
    if (!href || cached === false) {
        return feed ? `<div class="news-lead" data-state="ready">${feed}</div>`
            : `<div class="news-lead" data-state="none"><div class="news-lead-wait">${NO_TEXT}</div></div>`;
    }
    // Read on demand when the item is opened (wireNews), so only articles someone looks at are fetched.
    return `<div class="news-lead" data-state="idle" data-url="${escapeHtml(href)}">${feed}<div class="news-lead-wait">Opening the article…</div></div>`;
}

export function renderNews(newsData, sentiment) {
    if (!newsData || newsData.length === 0) return '';
    const sentimentIcon = sentiment.overall === 'positive' ? '🟢' : sentiment.overall === 'negative' ? '🔴' : '🟡';
    return `
        <div class="news-section">
            <div class="news-header">
                <span class="news-title">📰 Market News &amp; Sentiment</span>
                <span class="news-sentiment-badge ${sentiment.overall}">${sentimentIcon} ${sentiment.overall.toUpperCase()}</span>
            </div>
            <div class="news-summary">${sentiment.summary}</div>
            ${weightBar(newsData)}
            <div class="news-list">
                ${newsData.slice(0, 5).map(item => {
                    const sentIcon = item.sentiment ? (item.sentiment.label === 'positive' ? '🟢' : item.sentiment.label === 'negative' ? '🔴' : '⚪') : '⚪';
                    const sentLabel = item.sentiment ? item.sentiment.label : 'neutral';
                    const ago = timeAgo(item.date);
                    const impact = generateNewsImpact(item.title, sentLabel, state.currentSymbol);
                    // Title, source and link are all third-party text (see escape.js).
                    const href = safeHttpUrl(item.url);
                    const titleHTML = href
                        ? `<a class="news-item-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
                        : `<div class="news-item-title">${escapeHtml(item.title)}</div>`;
                    return `<details class="accordion-item news-accordion">
                        <summary class="accordion-header">
                            <span class="news-item-sentiment">${sentIcon}</span>
                            <div class="accordion-header-content">
                                ${titleHTML}
                                <div class="news-item-meta">${escapeHtml(item.source)} · ${ago}</div>
                            </div>
                            <span class="accordion-chevron">▸</span>
                        </summary>
                        <div class="accordion-body">
                            <div class="accordion-impact ${sentLabel}">${impact}</div>
                            ${leadBlock(item, href)}
                        </div>
                    </details>`;
                }).join('')}
            </div>
        </div>`;
}

/** After the card is in the page: read an article the first time its item is opened. */
export function wireNews(root) {
    if (!root) return;
    for (const d of root.querySelectorAll('details.news-accordion')) {
        const box = d.querySelector('.news-lead[data-state="idle"]');
        if (!box) continue;
        d.addEventListener('toggle', async () => {
            if (!d.open || box.dataset.state !== 'idle') return;
            box.dataset.state = 'loading';
            const url = box.dataset.url;
            let paras = [];
            let domain = domainOf(url);
            let preview = false;
            try {
                const { fetchFullArticle } = await import('../article-extractor.js');
                const a = await fetchFullArticle(url, { allowShort: true });
                if (a?.mainText) {
                    paras = leadParagraphs(a.mainText);
                    domain = a.domain || domain;
                    preview = !!a.preview;
                }
            } catch (_) { paras = []; }
            const wait = box.querySelector('.news-lead-wait');
            if (paras.length) {
                leadCache.set(url, { paras, domain, preview });
                box.innerHTML = leadHtml(paras, domain, url, preview);
                box.dataset.state = 'ready';
            } else {
                leadCache.set(url, false);
                if (wait) wait.textContent = NO_TEXT;
                box.dataset.state = 'none';
            }
        });
    }
}
