// Left-rail glossary + FAQ + Mia intro. Renders into #glossary-rail on init.
// Items are <details> so users can scan and expand what interests them.

const SECTIONS = [
    {
        title: 'Meet Mia',
        intro: 'Market Intelligence Analyst — your in-app chatbot. Click the 💬 launcher (bottom-right) to ask anything about a stock, an indicator, or what a signal means.',
        items: [],
    },
    {
        title: 'Signal terminology',
        items: [
            ['Signal', 'BUY / SELL / NEUTRAL. The direction the engine thinks price is heading over the chosen timeframe.'],
            ['Confidence', 'How likely the signal is to play out, expressed as a percentage. When backtest data is loaded, this is the empirical hit rate — not a heuristic.'],
            ['Timeframe', 'Today = next bar. Tomorrow = roughly 24 hours out. Tomorrow predictions are slightly less confident on average because more can change.'],
            ['Confluence', 'When daily, weekly, and 4-hour timeframes all agree. The highest-quality setup; confidence gets a bonus.'],
            ['Trend regime', 'The market\'s current behavior. "Trending" rewards momentum signals; "ranging" rewards mean-reversion signals.'],
        ],
    },
    {
        title: 'Indicators we use',
        items: [
            ['RSI', 'Relative Strength Index. Below 30 = oversold (bounce likely). Above 70 = overbought (pullback likely).'],
            ['MACD', 'Moving Average Convergence/Divergence. Crossovers signal momentum shifts.'],
            ['Bollinger Bands', 'Volatility envelope around price. Touches of the outer bands often precede mean-reversion moves.'],
            ['ADX', 'Trend strength meter. Above 25 = strong trend. Below 20 = chop, where breakouts often fail.'],
            ['MFI', 'Money Flow Index. Like RSI but weighted by volume — catches institutional moves.'],
            ['ATR', 'Average True Range. Used to scale stop-losses and price targets to a stock\'s normal volatility.'],
        ],
    },
    {
        title: 'Sources we blend',
        items: [
            ['Technicals', 'Multi-timeframe indicator agreement. The largest weight, most reliable in the medium term.'],
            ['AI Model', 'A small LSTM trained on 300 stocks and 38 crypto symbols, retrained monthly. Acts as a pattern-recognition co-pilot.'],
            ['Sentiment', 'FinBERT analyzes recent news headlines. Recent news weighted higher than stale news.'],
            ['Market', 'Fear & Greed Index, VIX, S&P 500 trend. Provides regime context.'],
        ],
    },
    {
        title: 'Calibration',
        items: [
            ['What is calibration?', 'A 70%-confidence signal should hit 70% of the time historically. Calibration adjusts displayed confidence to match real outcomes from backtesting.'],
            ['Backtest', 'A simulation that replays our signal pipeline across years of past data. Daily-refreshed via GitHub Actions.'],
            ['Live accuracy', 'Your personal hit rate. Every signal you\'re shown is logged and resolved against future prices, in your browser.'],
        ],
    },
    {
        title: 'FAQs',
        items: [
            ['How accurate is this?', 'It depends — see the per-confidence-bucket calibration. Anyone claiming "95% accuracy" on stock prediction is either lying or has overfit.'],
            ['Should I trade based on this?', 'No tool replaces your own judgment. This is one input among many. Position size matters more than entry.'],
            ['Where does the data come from?', 'Yahoo Finance for stocks, CoinGecko for crypto, Google News + FinBERT for sentiment, alternative.me for Fear & Greed. All free, no API keys.'],
            ['Is my data sent anywhere?', 'No. Everything runs in your browser. Your prediction history lives in your browser\'s localStorage.'],
            ['What\'s “dev mode”?', 'A diagnostic view for the developer. Shows calibration metadata, raw vs. calibrated confidence, and a personal-accuracy strip. Public users see a cleaner view.'],
        ],
    },
];

// Resources panel state — in-memory only. Always starts closed on page
// load (Roshan's UX preference: the panel should never auto-open after
// a refresh, even if the user opened it earlier in a previous session).
import { flashShimmer } from './flash-shimmer.js';
import { nextTip } from './tips.js';

function escapeHtmlGlos(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
// Swap in a fresh Did-You-Know fact (called on every panel open).
function refreshResourcesDyk() {
    const body = document.querySelector('.glossary-rail .res-dyk-body');
    if (body) body.textContent = nextTip();
}

let _open = false;
function isOpen() { return _open; }
function setOpen(v) {
    const wasOpen = _open;
    _open = !!v;
    document.body.classList.toggle('resources-open', _open);
    const toggle = document.getElementById('resources-toggle');
    if (toggle) {
        toggle.setAttribute('aria-expanded', _open ? 'true' : 'false');
        toggle.title = _open ? 'Hide Resources panel' : 'Show Resources panel';
    }
    // One-shot shimmer on the "Resources" headline when the panel
    // opens (transition from closed → open). Skipped on the initial
    // setOpen(false) call during render.
    if (_open && !wasOpen) {
        // Fresh Did-You-Know fact on every open.
        refreshResourcesDyk();
        requestAnimationFrame(() => {
            flashShimmer(document.querySelector('.glossary-rail .resources-title'));
        });
    }
}
// Clear any persisted open state from prior sessions so the panel
// stays closed on hard-refresh.
try { localStorage.removeItem('ma-resources-open'); } catch (_) {}

export function renderGlossary() {
    const rail = document.getElementById('glossary-rail');
    if (!rail) return;
    const sectionsHTML = SECTIONS.map((section, sIdx) => {
        const intro = section.intro ? `<p class="glos-intro">${section.intro}</p>` : '';
        const items = section.items.map(([term, def]) => `
            <details class="glos-item">
                <summary><span class="glos-term">${term}</span><span class="glos-chev">▸</span></summary>
                <div class="glos-def">${def}</div>
            </details>`).join('');
        return `
            <section class="glos-section" data-idx="${sIdx}">
                <h3 class="glos-title">${section.title}</h3>
                ${intro}
                ${items}
            </section>`;
    }).join('');

    rail.innerHTML = `
        <div class="resources-header">
            <h2 class="resources-title">Resources</h2>
            <button type="button" class="resources-close" id="resources-close" aria-label="Close Resources panel" title="Close">×</button>
        </div>
        <div class="resources-body">
            <div class="res-dyk" aria-live="polite">
                <div class="res-dyk-head"><span aria-hidden="true">💡</span> Did you know?</div>
                <div class="res-dyk-body">${escapeHtmlGlos(nextTip())}</div>
            </div>
            ${sectionsHTML}
        </div>
    `;
    const closeBtn = rail.querySelector('#resources-close');
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));

    // Mount the toggle inline in the .tabs-row, to the RIGHT of the Portfolio
    // launcher (appended last) so the row reads:
    // Stock/Crypto · Today/Tomorrow · Portfolio · Resources.
    if (!document.getElementById('resources-toggle')) {
        const toggle = document.createElement('button');
        toggle.id = 'resources-toggle';
        toggle.className = 'resources-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-controls', 'glossary-rail');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.title = 'Show Resources panel';
        toggle.innerHTML = `
            <span class="resources-toggle-icon" aria-hidden="true">📚</span>
            <span class="resources-toggle-label">Resources</span>
        `;
        toggle.addEventListener('click', () => setOpen(!isOpen()));
        const tabsRow = document.querySelector('.tabs-row');
        if (tabsRow) tabsRow.appendChild(toggle);   // right of Portfolio
        else document.body.appendChild(toggle);
    }

    // Click-outside / Esc to dismiss. Resources is an overlay, so the
    // backdrop intercepts pointer events; clicking it closes the panel
    // the same way as clicking the rail's × button.
    if (!document.getElementById('resources-backdrop')) {
        const backdrop = document.createElement('div');
        backdrop.id = 'resources-backdrop';
        backdrop.className = 'resources-backdrop';
        backdrop.addEventListener('click', () => setOpen(false));
        document.body.appendChild(backdrop);
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) setOpen(false);
    });

    // Force-close on render so the panel never auto-opens on refresh.
    setOpen(false);
}
