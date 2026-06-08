# Yahoo Finance crumb-proxy worker

A tiny Cloudflare Worker (~150 lines) that bypasses Yahoo's session-crumb requirement on `/v10/finance/quoteSummary` so the GitHub Pages frontend can read float / short-interest data.

## Why this exists

Yahoo started requiring a session crumb token on its rich `defaultKeyStatistics` endpoint in 2024. Browsers behind CORS proxies can't replay the cookie+crumb dance. This Worker does it server-side and returns a clean JSON shape.

## What it exposes

- `GET /key-stats?symbol=BBAI`  → `{floatShares, sharesShort, shortPercentOfFloat, sharesOutstanding, heldPercentInsiders, heldPercentInstitutions}`
- `GET /stock-quote?symbol=AAPL`  → realtime equity price via Public.com (see below). Origin-restricted.
- `GET /health`  → `{ok: true, ts: <epoch>, publicQuoteConfigured: <bool>}`

Most responses include permissive CORS headers so the frontend can call them directly. `/stock-quote` is the exception — it's locked to the app's own origins (see below).

## Realtime stock quotes via Public.com (`/stock-quote`)

`/stock-quote` fronts the [Public.com trading API](https://public.com/api) to return **realtime** equity prices (vs. Stooq's 5–15 min delay). The app tries this first and falls back to Stooq/Yahoo if it's unconfigured or down.

**Security model (the whole point of routing through the Worker):**
- The Public API **secret** lives ONLY as a Cloudflare Worker secret — never in the repo, never sent to the browser. The browser only ever calls `/stock-quote`.
- The Worker exchanges the secret for a short-lived (30 min) bearer token, caches it, and uses it to fetch quotes. The browser never sees the secret OR the token.
- **Read-only:** only the market-data quote endpoint is wired. No order/write endpoint is ever exposed through this Worker — worst case abuse is quote spam, never a trade.
- **Origin-locked + rate-limited:** `/stock-quote` only serves `market-ai.pages.dev` (+ CF preview deploys + localhost dev); a **missing** Origin is rejected (curl/bots/scrapers send none), and other origins get `ACAO: null` so a browser blocks the read. On top of that, a per-(IP, symbol) sliding-window limit (30/min) caps quota burn even from a spoofed Origin. Honest caveat: the rate-limit map is in-memory **per Worker isolate** (not global), so it's a proportionate quota guard for a free-tier key — not a hard global cap. The 10s quote cache further blunts abuse. If this ever fronted a paid/sensitive key, move the limiter to KV / Durable Objects for a true global cap.

**Setting the secret (one-time, you run this — it's interactive, the value never hits disk/history):**
```bash
cd workers/yahoo-proxy
wrangler secret put PUBLIC_API_SECRET
# paste your Public.com secret key (Account Settings → Security → API)
wrangler deploy
```
Without the secret set, `/stock-quote` returns `{configured:false}` and the app silently uses the delayed sources — so deploying without it is safe.

**Endpoint chain (verified against the docs):** token → `GET /userapigateway/trading/account` (for the `accountId`) → `POST /userapigateway/marketdata/{accountId}/quotes`. Price fields come back as **strings** (e.g. `"last": "187.34"`) so the Worker parses them to numbers; it prefers `last`, then mid(bid,ask), then `previousClose`, and honors the per-instrument `outcome` field.

## Deploy (one-time, ~3 minutes)

```bash
cd workers/yahoo-proxy
npm install -g wrangler
wrangler login              # opens a browser to your CF account
wrangler deploy             # prints e.g. https://market-analysis-yahoo-proxy.<your-account>.workers.dev
```

Then paste the printed URL into `js/penny-tier.js`:

```js
const WORKER_URL = 'https://market-analysis-yahoo-proxy.<your-account>.workers.dev';
```

Commit + push, wait ~40s for GitHub Pages to redeploy, and the penny-tier module will start returning live data.

## Free-tier capacity

- 100,000 requests/day on the CF free plan
- 10ms CPU per request budget
- 60-min cache per symbol on the worker, 30-min crumb cache shared across all calls
- Realistic max throughput at this app's usage: ~hundreds of unique symbol lookups per day

## Costs

None. Free plan covers everything this app needs. No credit card required to deploy.

## Privacy

The worker is stateless except for two in-memory caches (key-stats per symbol, Yahoo crumb). No request logging beyond Cloudflare's standard worker analytics.
