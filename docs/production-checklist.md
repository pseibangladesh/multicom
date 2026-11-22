# Production deployment checklist

Exact steps to put multicom on a live Cloudflare account: the `merchant` Worker (API, MerchantDO, marketplace queue consumer) plus the `client` SPA. Run every `wrangler` command from `apps/merchant`. Do the steps in order; several of them only work if an earlier one is done.

> Placeholders: `api.example.com` is the API's public host, `shop.example.com` is the storefront's. Put both on the **same registrable domain** if you can (see step 7).

---

## 0. Before you start: rotate leaked secrets

The repository has tracked `.env` and `apps/client/.env`, and they were pushed to `origin`. The root `.env` holds real-looking values for `STRIPE_SECRET_KEY` (test mode), `STRIPE_WEBHOOK_SECRET`, `MERCHANT_SK` and `BETTER_AUTH_SECRET`. Assume all four are public.

- [ ] Roll the Stripe key and the webhook signing secret in the Stripe dashboard.
- [ ] Generate **new** values for `MERCHANT_SK` and `BETTER_AUTH_SECRET` (step 3). Never reuse the ones in git.
- [ ] Stop tracking the files. `.gitignore` now ignores them; this removes them from the index but keeps your local copies:
  ```bash
  git rm --cached .env apps/client/.env
  git commit -m "Stop tracking .env files"
  ```
  Removing them from **history** (`git filter-repo`) is optional once the values are rotated, because rotation is what makes the leaked values useless.

## 1. Prerequisites

```bash
npm install                 # repo root
cd apps/merchant
npx wrangler login
npx wrangler whoami         # confirm the account you will deploy to
```

## 2. Create the Cloudflare resources (once per account)

```bash
# KV: response cache, rate limits, encrypted AI config
npx wrangler kv namespace create KV_CACHE
#   → copy the printed id into wrangler.jsonc "kv_namespaces"[0].id
#     (the id committed today belongs to the original developer's account)

# R2
npx wrangler r2 bucket create multicom-images
npx wrangler r2 bucket create multicom-digital-assets

# Queues: marketplace sync jobs + dead letter queue
npx wrangler queues create multicom-marketplace-sync
npx wrangler queues create multicom-marketplace-sync-dlq
```

The Durable Object (`MerchantDO`, SQLite) needs no manual step. `wrangler deploy` creates it from the `migrations` block, and the database schema runs inside the object on first use.

## 3. Secrets

Secrets are encrypted by Cloudflare and never appear in `wrangler.jsonc`. The quickest way is one JSON file kept **outside the repo**, uploaded once and then deleted:

```bash
cat > ~/multicom-secrets.json <<EOF
{
  "BETTER_AUTH_SECRET": "$(openssl rand -base64 32)",
  "CRYPTOKEN": "$(openssl rand -base64 32)",
  "ORDER_TOKEN_SECRET": "$(openssl rand -base64 32)",
  "MERCHANT_SK": "sk_$(openssl rand -hex 24)",
  "MERCHANT_PK": "pk_$(openssl rand -hex 24)",
  "STRIPE_SECRET_KEY": "sk_live_…",
  "STRIPE_WEBHOOK_SECRET": "whsec_…"
}
EOF
npx wrangler secret bulk ~/multicom-secrets.json
# Store MERCHANT_SK and CRYPTOKEN in your password manager, then:
rm ~/multicom-secrets.json
```

Add a single secret later with `npx wrangler secret put NAME`, and list the names (not the values) with `npx wrangler secret list`.

| Secret | Required | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | **yes** | At least 32 characters. Auth refuses to start without it (`assertAuthSecret`). Changing it signs everyone out. |
| `CRYPTOKEN` | **yes** | Encrypts SSLCommerz credentials, marketplace OAuth tokens and `ai.json.enc`. **Never change it after go-live**: anything encrypted with the old value can no longer be read. |
| `ORDER_TOKEN_SECRET` | **yes** | Signs order-view, download and review links. |
| `MERCHANT_SK` / `MERCHANT_PK` | **yes**, before the first deploy | The object hashes them into `api_keys` when it starts. Once they exist, the unauthenticated `POST /v1/setup/init` answers 409. If you skip them, the first person to call `/v1/setup/init` creates the admin key. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for Stripe | Prefer these over `POST /v1/setup/stripe`, which stores the key unencrypted in the database. |
| `ETSY_SHARED_SECRET`, `EBAY_CLIENT_SECRET` | for marketplaces | |
| `MAILGUN_API_KEY` | for email | |
| `AI_API_KEY`, `CLOUDFLARE_AIG_TOKEN`, `AI_BALANCE_SHARED_SECRET` | for AI features | |

`MERCHANT_PK` is a *public* key: it is baked into the client bundle (step 8). `MERCHANT_SK` must never appear in any client build or `VITE_*` variable.

## 4. Plain variables

These are not secret, but they must not be committed with production values while `wrangler.jsonc` is shared, so set them as secrets too (`wrangler secret bulk` works the same way). A plain variable set only in the dashboard is **overwritten** by `wrangler deploy` unless it is also in `wrangler.jsonc` `"vars"`.

| Variable | Value |
|---|---|
| `API_BASE_URL` | `https://api.example.com` (no trailing slash). Must be `https://`: that switches the session cookie to `SameSite=None; Secure`. |
| `STORE_URL` | `https://shop.example.com`. This is the CORS allowlist and the Better Auth trusted origin. |
| `CORS_ORIGIN` | Optional comma-separated allowlist that **replaces** `STORE_URL` for CORS, e.g. `https://shop.example.com,https://admin.example.com`. Leave it unset unless you need more than one origin. |
| `ADMIN_EMAILS` | Comma-separated. A Better Auth session gets the admin role only if its email is in this list. |
| `STORE_NAME`, `IMAGES_URL` | `IMAGES_URL` is optional (defaults to `API_BASE_URL/v1/images`). |
| `ETSY_CLIENT_ID`, `ETSY_REDIRECT_URI` | The redirect defaults to `API_BASE_URL/v1/marketplace/connect/etsy/callback`. |
| `EBAY_CLIENT_ID`, `EBAY_RU_NAME`, `EBAY_ENVIRONMENT` | `EBAY_ENVIRONMENT=production` (or unset). `sandbox` targets eBay's sandbox. |
| `KV_CACHE_*_TTL_SECONDS` | Optional. |

**CORS is now strict.** Only `STORE_URL` (or the `CORS_ORIGIN` list) gets CORS headers, and there is no `*` fallback. Any other browser frontend that calls the API must be added to `CORS_ORIGIN`. Server-to-server callers using `pk_`/`sk_` keys are not affected.

## 5. Deploy the API

```bash
cd apps/merchant
npx wrangler deploy --dry-run     # check: MERCHANT, KV_CACHE, MARKETPLACE_SYNC_QUEUE, IMAGES, DIGITAL_ASSETS_BUCKET
npx wrangler deploy
```

Then upload the encrypted AI config, if you use AI features (it needs the same `CRYPTOKEN`):

```bash
npx wrangler kv key put ai:config --binding KV_CACHE --path ../../ai.json.enc --remote
```

Do **not** use `scripts/init-remote.ts`: it targets a D1 database that no longer exists.

## 6. Create the admin account immediately

Email verification is off (`requireEmailVerification: false`), and admin rights come from `ADMIN_EMAILS`. That means **whoever signs up first with an address listed in `ADMIN_EMAILS` becomes admin**.

- [ ] Right after the deploy, sign up through the storefront with every address in `ADMIN_EMAILS`, before the site is announced.
- [ ] Confirm `GET https://api.example.com/api/auth/session` (sent with the cookie) shows `is_admin: true`.

## 7. Cookies across sites

The storefront calls the API with `credentials: "include"`. If the two are on **different registrable domains** (e.g. `*.github.io` and `*.workers.dev`), the session cookie is a third-party cookie. Safari and Firefox block those by default, and admins on those browsers cannot stay signed in.

- [ ] Put the Worker on a custom domain next to the storefront: Dashboard → Workers → merchant → Settings → Domains & Routes → add `api.example.com`. Serve the storefront from `shop.example.com` (for GitHub Pages, add a `CNAME`).

## 8. Build and publish the client

The client has no CI in this checkout (no `.github/`), so build it locally:

```bash
cd apps/client
API_BASE_URL=https://api.example.com \
STORE_URL=https://shop.example.com \
MERCHANT_PK=pk_… \
STORE_NAME="My Store" \
VITE_BASE_PATH=/ \
npm run build
# publish dist/ to your static host (GitHub Pages, Cloudflare Pages, …)
```

`VITE_BASE_PATH` is `/` on a custom domain, or `/<repo>/` on a `github.io` project page.

## 9. Payment providers

**Stripe**
- [ ] Dashboard → Developers → Webhooks → add endpoint `https://api.example.com/v1/webhooks/stripe`.
- [ ] Events: `checkout.session.completed`, `payment_intent.payment_failed`.
- [ ] Put the signing secret in `STRIPE_WEBHOOK_SECRET` (step 3).

**SSLCommerz**
- [ ] Admin → Payment gateways: enter the store ID and password, and set **sandbox off**. The password is encrypted with `CRYPTOKEN` before it is stored and is never returned by the API.
- [ ] The IPN URL is sent per transaction (`/v1/webhooks/sslcommerz/ipn`), so nothing needs registering. Payments are confirmed through SSLCommerz's validation API, not from the IPN body alone.

## 10. Marketplaces

- [ ] **Etsy app:** add the callback `https://api.example.com/v1/marketplace/connect/etsy/callback`.
- [ ] **eBay:** create a production RuName whose *accept URL* is `https://api.example.com/v1/marketplace/connect/ebay/callback`, and set `EBAY_RU_NAME` to the RuName (not the URL).
- [ ] Connect each shop from **Admin → Marketplaces**, then fill in **Edit config** until the listing shows *Ready*.
- [ ] Watch the sync queue: Dashboard → Queues → `multicom-marketplace-sync`. Messages in `multicom-marketplace-sync-dlq` are jobs that failed infrastructure-level 5 times.

## 11. Verify the live deployment

```bash
API=https://api.example.com
curl -s -o /dev/null -w "%{http_code}\n" $API/openapi.json                         # 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/v1/setup/init \
  -H 'Content-Type: application/json' -d '{"keys":[]}'                             # 409 (keys exist)
curl -s -D - -o /dev/null -X OPTIONS $API/v1/products \
  -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' \
  | grep -i access-control-allow-origin                                              # (no output)
curl -s -D - -o /dev/null -X OPTIONS $API/v1/products \
  -H 'Origin: https://shop.example.com' -H 'Access-Control-Request-Method: GET' \
  | grep -i access-control-allow-origin                                              # https://shop.example.com
curl -s $API/v1/admin/marketplace/channels -H "Authorization: Bearer $MERCHANT_SK"   # {"ok":true,...}
npx wrangler tail                                                                    # live logs
```

- [ ] Place a real low-value order through each payment provider and refund it.
- [ ] Run **Push products** on a marketplace channel and watch *Last sync* go from *pending* to *completed*.

## 12. Rollback

```bash
npx wrangler deployments list
npx wrangler rollback            # previous Worker version
```

Schema migrations are additive only, so older code runs against a newer database. Rolling back never needs a data migration.

---

## Known gaps (not blockers, but decide before launch)

- **Marketplace webhooks are not signature-verified.** `POST /v1/marketplace/webhook/:platform` only logs today. Add verification before any handler acts on a payload.
- **No automatic order pull.** Orders import when an admin clicks *Pull orders*, or via `POST /v1/marketplace/:id/sync/orders`. The 15-minute cron only cleans expired carts.
- **Etsy lists one listing per variant.** Multi-variant products become separate listings.
- **Password reset emails are not sent.** `sendResetPassword` only logs the link.
