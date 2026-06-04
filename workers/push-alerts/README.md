# Push Alerts Worker — closed-tab price notifications

Sends a Web Push notification when a watched symbol crosses a price
threshold, **even when the app/tab is fully closed**. A 1-minute cron
checks live prices server-side and pushes via VAPID to each subscriber.

- **Crypto** → real-time price (Binance).
- **Stocks** → ~15-min delayed (free data limit; Stooq). The delay is the
  data's, not the architecture's.
- **iPhone** → Web Push only fires when the app is added to the Home
  Screen as a PWA (Apple rule, iOS 16.4+). Normal Safari tabs won't get it.

The tab-OPEN crypto alerts in `js/ui/price-alerts.js` (Binance WebSocket)
keep working independently — this worker is purely additive for the
closed-app case.

---

## One-time setup (Roshan — needs your authenticated Cloudflare account)

All commands run from `workers/push-alerts/`.

### 1. Generate VAPID keys
```
npx web-push generate-vapid-keys
```
Copy the **Public Key** and **Private Key** it prints.

- Paste the **Public Key** into `js/push/push-client.js` → `VAPID_PUBLIC_KEY`
  is NOT hardcoded there; instead the client fetches it from the worker's
  `/vapidPublicKey`. So you only need to set it as a worker secret (step 3).
- Also paste the worker's deployed URL (step 5) into `js/push/push-client.js`
  → `PUSH_API`.

### 2. Create the KV namespace
```
npx wrangler kv namespace create ALERTS_KV
npx wrangler kv namespace create ALERTS_KV --preview
```
Copy the two printed ids into `wrangler.toml` (`id` and `preview_id`).

### 3. Set secrets (never commit these)
```
npx wrangler secret put VAPID_PUBLIC_KEY      # paste the public key
npx wrangler secret put VAPID_PRIVATE_KEY     # paste the private key
npx wrangler secret put VAPID_SUBJECT         # e.g. mailto:you@example.com
```
**Important — key format:** paste the keys EXACTLY as `web-push
generate-vapid-keys` prints them. They are base64url-unpadded (uses `-`
and `_`, no `+`/`/`/`=`). The worker decodes them as base64url and uses
the public key verbatim in the `k=` header — do not re-encode them to
standard base64 or the signature/JWK import will break.

### 4. Deploy
```
npx wrangler deploy
```
Note the printed `https://market-analysis-push-alerts.<acct>.workers.dev` URL.

### 5. Wire the client
Put that URL into `js/push/push-client.js`:
```js
const PUSH_API = 'https://market-analysis-push-alerts.<acct>.workers.dev';
```
Commit + push → Cloudflare Pages redeploys. The watchlist now shows a
**"🔔 Notify even when app is closed"** button.

### 6. Test
- Open the app, star a crypto symbol (e.g. BTC-USD), set a `below`
  threshold just above the current price.
- Click "Notify even when app is closed", grant permission.
- Close the tab. Within ~1 minute you should get a system notification.
- `npx wrangler tail` streams the cron logs if you want to watch it fire.

---

## How it works

```
browser ── /subscribe {subscription, alerts} ──▶ Worker ── KV (sub:<hash>)
                                                   │
                          cron (every minute) ─────┤
                          fetch live prices  ◀──────┘
                          threshold crossed? ──▶ Web Push (VAPID/aes128gcm)
                                                   │
                                                   ▼
                                          Service Worker (sw.js)
                                          showNotification()  ← fires with tab closed
```

KV value per subscriber:
```json
{ "subscription": { "endpoint": "...", "keys": {"p256dh","auth"} },
  "alerts": { "BTC-USD": { "above": 75000, "below": null } },
  "updatedAt": 1730000000000 }
```

Web Push (VAPID JWT + RFC 8291 aes128gcm payload encryption) is
implemented with WebCrypto only in `src/worker.js` — no npm push library,
so it runs on the Workers runtime unmodified.

## Free-tier notes
- Workers free: 100K req/day; cron counts as invocations — 1/min = 1,440/day.
- KV free: 100K reads + 1K writes/day. We read all subs once per minute;
  scale stays tiny for a friends-and-family deployment.
