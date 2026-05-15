# Yahoo Finance crumb-proxy worker

A tiny Cloudflare Worker (~150 lines) that bypasses Yahoo's session-crumb requirement on `/v10/finance/quoteSummary` so the GitHub Pages frontend can read float / short-interest data.

## Why this exists

Yahoo started requiring a session crumb token on its rich `defaultKeyStatistics` endpoint in 2024. Browsers behind CORS proxies can't replay the cookie+crumb dance. This Worker does it server-side and returns a clean JSON shape.

## What it exposes

- `GET /key-stats?symbol=BBAI`  → `{floatShares, sharesShort, shortPercentOfFloat, sharesOutstanding, heldPercentInsiders, heldPercentInstitutions}`
- `GET /health`  → `{ok: true, ts: <epoch>}`

Responses include permissive CORS headers so the frontend on `*.github.io` can call them directly.

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
