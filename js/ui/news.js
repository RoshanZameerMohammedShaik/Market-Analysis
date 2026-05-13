import { state } from './state.js';
import { timeAgo } from './format.js';
import { generateNewsImpact } from './reasons.js';

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
            <div class="news-list">
                ${newsData.slice(0, 5).map(item => {
                    const sentIcon = item.sentiment ? (item.sentiment.label === 'positive' ? '🟢' : item.sentiment.label === 'negative' ? '🔴' : '⚪') : '⚪';
                    const sentLabel = item.sentiment ? item.sentiment.label : 'neutral';
                    const ago = timeAgo(item.date);
                    const impact = generateNewsImpact(item.title, sentLabel, state.currentSymbol);
                    return `<details class="accordion-item news-accordion">
                        <summary class="accordion-header">
                            <span class="news-item-sentiment">${sentIcon}</span>
                            <div class="accordion-header-content">
                                <div class="news-item-title">${item.title}</div>
                                <div class="news-item-meta">${item.source} · ${ago}</div>
                            </div>
                            <span class="accordion-chevron">▸</span>
                        </summary>
                        <div class="accordion-body"><div class="accordion-impact ${sentLabel}">${impact}</div></div>
                    </details>`;
                }).join('')}
            </div>
        </div>`;
}
