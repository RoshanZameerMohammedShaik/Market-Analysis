// In-app About modal. Mirrors README highlights so visitors don't need
// to leave the site to learn what Market Analyzer can do.

const SECTIONS = [
    {
        title: 'What is Market Analyzer?',
        body: `<p>A real-time stock & crypto prediction engine. Multi-timeframe technicals, AI pattern recognition, FinBERT news sentiment, macro regime, sector-relative scoring, earnings-aware confidence — blended into a single calibrated <strong>BUY / SELL / NEUTRAL</strong> signal.</p>
            <p>Runs in your browser. No backend. <em>Not financial advice.</em></p>`,
    },
    {
        title: 'Reading a signal card',
        body: `<ul>
            <li><strong>Signal</strong> — BUY / SELL / NEUTRAL.</li>
            <li><strong>Confidence %</strong> — calibrated to backtested empirical hit rate when calibration data is loaded.</li>
            <li><strong>Range</strong> — [low, high] interval. Wider = more uncertainty.</li>
            <li><strong>Trend regime</strong> — trending / ranging / transitional, from ADX.</li>
            <li><strong>Macro regime</strong> — risk-on / risk-off / transition / neutral, from VIX + S&P + DXY.</li>
            <li><strong>Source breakdown</strong> — AI, technicals, sentiment, market, each shown 0-100.</li>
            <li><strong>Price targets</strong> — ATR-derived, bounded by Bollinger and recent S/R.</li>
            <li><strong>Reasons</strong> — plain-English bullets explaining the score.</li>
        </ul>`,
    },
    {
        title: 'Mia — your in-app analyst',
        body: `<p>Floating launcher (bottom-right). She reads the live signal data so her numbers always match yours.</p>
            <ul>
                <li><strong>Two backends</strong>: <em>WebLLM</em> (runs in your browser, private, desktop only) or <em>API key</em> (free Groq / Cloudflare, mobile-friendly).</li>
                <li><strong>Tools she can call</strong>: analyze a symbol, fetch hot picks, read market conditions, compare stocks, look up calibration.</li>
                <li><strong>Thinking mode</strong> toggle for deeper reasoning (slower).</li>
                <li><strong>Send button</strong> morphs into <em>stop</em> while streaming — click to abort.</li>
                <li><strong>Clear chat</strong> button right next to send.</li>
                <li><strong>Usage meter</strong> shows the closest-to-exhaustion API rate-limit as a percentage.</li>
            </ul>`,
    },
    {
        title: 'Hot picks',
        body: `<p>Top 20 dynamic picks scanned from real-time market sources every refresh. Tap a card to load full analysis. Cards show signal, confidence, sparkline, and current price.</p>
            <p>Filtered strictly to equities / ETFs in the stocks tab — no crypto leakage.</p>`,
    },
    {
        title: 'P&L Calculator',
        body: `<p>Right sidebar. Enter your investment, purchase price, and a target price. Click <em>Use current</em> to load the live price for the selected symbol.</p>`,
    },
    {
        title: 'Keyboard shortcuts',
        body: `<ul>
            <li><kbd>/</kbd> focus search</li>
            <li><kbd>1</kbd> / <kbd>2</kbd> stock / crypto tabs</li>
            <li><kbd>t</kbd> / <kbd>m</kbd> today / tomorrow</li>
            <li><kbd>r</kbd> refresh hot picks</li>
            <li><kbd>?</kbd> open this help</li>
        </ul>`,
    },
    {
        title: 'Privacy',
        body: `<p>All analysis runs in your browser. API keys (Groq / Cloudflare) and conversation history live only in your browser's localStorage. Nothing relays through a server you don't control.</p>`,
    },
    {
        title: 'Disclaimer',
        body: `<p><strong>Not financial advice.</strong> Predictions are statistical signals, not guarantees. Past performance does not predict future results. Trade at your own risk.</p>`,
    },
];

let open = false;

export function initAbout() {
    const btn = document.getElementById('about-btn');
    if (btn) btn.addEventListener('click', toggle);
}

export function toggle() {
    if (open) close();
    else show();
}

function show() {
    if (open) return;
    const el = document.createElement('div');
    el.id = 'about-overlay';
    el.className = 'about-overlay';
    el.innerHTML = `
        <div class="about-card" role="dialog" aria-label="About Market Analyzer">
            <div class="about-head">
                <div class="about-title">About Market Analyzer</div>
                <button class="about-close" id="about-close" aria-label="Close">✕</button>
            </div>
            <div class="about-body">
                ${SECTIONS.map(s => `
                    <details class="about-section">
                        <summary><span class="about-sec-title">${s.title}</span><span class="about-chev">▸</span></summary>
                        <div class="about-sec-body">${s.body}</div>
                    </details>`).join('')}
            </div>
        </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.getElementById('about-close').addEventListener('click', close);
    open = true;
    document.addEventListener('keydown', escClose);
}

function close() {
    const el = document.getElementById('about-overlay');
    if (el) el.remove();
    open = false;
    document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') close(); }
