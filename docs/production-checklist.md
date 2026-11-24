# Production deployment checklist

Exact steps to put multicom on a live Cloudflare account: the `merchant` Worker (API, MerchantDO, marketplace queue consumer) plus the `client` SPA. Run every `wrangler` command from `apps/merchant`. Do the steps in order; several of them only work if an earlier one is done.

> Placeholders: `www.example.com` is the storefront, `api.example.com` is the API.
>
> **Required:** the storefront and the API must be subdomains of the **same root domain** (`www.mysite.com` + `api.mysite.com`). Do not deploy on `*.github.io` + `*.workers.dev`. Step 7 explains why.

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
| `EBAY_VERIFICATION_TOKEN` | for eBay notifications | 32–80 characters of `A-Z a-z 0-9 _ -`: `openssl rand -hex 24`. The same value goes into the eBay destination (step 10). |
| `MAILGUN_API_KEY` | for email | |
| `AI_API_KEY`, `CLOUDFLARE_AIG_TOKEN`, `AI_BALANCE_SHARED_SECRET` | for AI features | |

`MERCHANT_PK` is a *public* key: it is baked into the client bundle (step 8). `MERCHANT_SK` must never appear in any client build or `VITE_*` variable.

## 4. Plain variables

These are not secret, but they must not be committed with production values while `wrangler.jsonc` is shared, so set them as secrets too (`wrangler secret bulk` works the same way). A plain variable set only in the dashboard is **overwritten** by `wrangler deploy` unless it is also in `wrangler.jsonc` `"vars"`.

| Variable | Value |
|---|---|
| `API_BASE_URL` | `https://api.example.com` (no trailing slash). Must be `https://`: that switches the session cookie to `SameSite=None; Secure`. |
| `STORE_URL` | `https://www.example.com`. This is the CORS allowlist and the Better Auth trusted origin. |
| `CORS_ORIGIN` | Optional comma-separated allowlist that **replaces** `STORE_URL` for CORS, e.g. `https://www.example.com,https://admin.example.com`. Leave it unset unless you need more than one origin. |
| `ADMIN_EMAILS` | Comma-separated. A Better Auth session gets the admin role only if its email is in this list. |
| `STORE_NAME`, `IMAGES_URL` | `IMAGES_URL` is optional (defaults to `API_BASE_URL/v1/images`). |
| `ETSY_CLIENT_ID`, `ETSY_REDIRECT_URI` | The redirect defaults to `API_BASE_URL/v1/marketplace/connect/etsy/callback`. |
| `EBAY_CLIENT_ID`, `EBAY_RU_NAME`, `EBAY_ENVIRONMENT` | `EBAY_ENVIRONMENT=production` (or unset). `sandbox` targets eBay's sandbox. |
| `EBAY_NOTIFICATION_ENDPOINT` | Optional. Defaults to `API_BASE_URL/v1/marketplace/webhook/ebay`. It must match the URL registered with eBay **exactly**, because it is part of the challenge hash. |
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

## 6. FIRST ACTION AFTER DEPLOY: create the admin accounts

> **Do this before anything else touches the live site**: before step 7 onward, before DNS is announced, before the store link goes anywhere.

Email verification is deliberately off (`requireEmailVerification: false`), because no email worker runs yet. Admin rights come from `ADMIN_EMAILS`. Public sign-up refuses every address in `ADMIN_EMAILS` (a Better Auth `before` hook in `lib/auth.ts`), so admin accounts can only be created with the provisioning script:

- [ ] `npx wrangler secret put ADMIN_EMAILS` (in `apps/merchant`) with every admin address, comma-separated.
- [ ] For each address: `npx tsx apps/merchant/scripts/create-admin.ts admin@example.com --remote`. It prompts for the password, sends it only over https, and must report `The backend recognises this email as an admin`.
- [ ] Sign in at the storefront and confirm `GET https://api.example.com/api/auth/session` (sent with the cookie) shows `is_admin: true`.
- [ ] If the script says an admin address already exists and you didn't create it, assume compromise. It would have to predate this protection. Remove the address from `ADMIN_EMAILS`, redeploy, and investigate before continuing.
- [ ] Adding an admin later works the same way. Add the address to `ADMIN_EMAILS` **before** creating the account, so nobody can sign up with it first.
- [ ] Revisit this step when an email worker exists: turn on `requireEmailVerification`.

## 7. Same root domain (required)

The storefront calls the API with `credentials: "include"`, and sign-in is a Better Auth cookie set by the API. If the two are on **different root domains** (e.g. `*.github.io` and `*.workers.dev`), that cookie is a third-party cookie. Safari and Firefox block those by default, so admins and customers on those browsers cannot stay signed in. This is not a supported configuration.

- [ ] API on `api.<root>`: Dashboard → Workers → merchant → Settings → Domains & Routes → **Add custom domain** → `api.example.com`. (The domain's DNS zone must be on Cloudflare.)
- [ ] Storefront on `www.<root>`: for GitHub Pages, add `apps/client/public/CNAME` containing `www.example.com` and a DNS `CNAME www → <user>.github.io`. For Cloudflare Pages, add the custom domain in the Pages project.
- [ ] Set `API_BASE_URL=https://api.example.com` and `STORE_URL=https://www.example.com` (step 4), then redeploy the API and rebuild the client with the same values.
- [ ] Check in Safari: sign in, reload, and you are still signed in.

## 8. Build and publish the client

The client has no CI in this checkout (no `.github/`), so build it locally:

```bash
cd apps/client
API_BASE_URL=https://api.example.com \
STORE_URL=https://www.example.com \
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

**Automatic order pulls**
- Every 15 minutes the cron queues a `pull_orders` job for each active, connected eBay and Etsy channel. That is the baseline and needs no setup.
- eBay notifications make eBay orders arrive within seconds instead:
  - [ ] Set `EBAY_VERIFICATION_TOKEN` (step 3) and deploy.
  - [ ] Create an eBay notification **destination** with endpoint `https://api.example.com/v1/marketplace/webhook/ebay` and the same verification token: developer portal → *Alerts & Notifications*, or the Notification API `createDestination`. eBay immediately sends `GET …?challenge_code=…`, and the API answers it.
  - [ ] Subscribe to `ORDER_CONFIRMATION` (also useful: `ORDER_CANCELLATION_ACTIVITY`, `ITEM_MARKED_SHIPPED`), plus `MARKETPLACE_ACCOUNT_DELETION`, which eBay requires for production keys. Order topics are user-scoped, so the subscription must be created with the seller's token. **The app does not create subscriptions yet.**
  - [ ] Send a test notification from eBay. `marketplace_webhook_events` gets a row with `processed_at` set, and an order topic queues a pull.
- Every notification is checked against eBay's ECDSA public key (header `X-EBAY-SIGNATURE`, key fetched with an application token and cached for 1 hour). Bad signatures get 412 and are not recorded.
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
  -H 'Origin: https://www.example.com' -H 'Access-Control-Request-Method: GET' \
  | grep -i access-control-allow-origin                                              # https://www.example.com
curl -s $API/v1/admin/marketplace/channels -H "Authorization: Bearer $MERCHANT_SK"   # {"ok":true,...}
curl -s "$API/v1/marketplace/webhook/ebay?challenge_code=test"                       # {"challengeResponse":"…"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/v1/marketplace/webhook/ebay \
  -H 'Content-Type: application/json' -d '{}'                                        # 412 (unsigned)
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

- **eBay notification subscriptions are manual** (step 10). The receiver verifies and acts on notifications, but nothing creates the destination or subscriptions yet.
- **Etsy and Amazon webhooks are refused (501).** Etsy orders arrive through the 15-minute cron only.
- **Account deletion notices are recorded, not acted on.** Imported marketplace orders don't store the eBay username or userId, so there's nothing keyed to that user to erase. Revisit this if that changes.
- **Etsy lists one listing per variant.** Multi-variant products become separate listings.
- **Password reset emails are not sent.** `sendResetPassword` only logs the link.
