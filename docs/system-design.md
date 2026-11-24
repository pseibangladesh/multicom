# Bengal Exchange — System Design

**Version:** 3.1 | **Updated:** 2026-11-23 | **Status:** Active

Bengal Exchange (repository `multicom`, npm package `bengal-exchange`) is a headless e-commerce platform that runs entirely on Cloudflare. This document describes how it is built today. For setup see [run-instructions.md](./run-instructions.md); for a step-by-step walk through login and sessions see [authentication.md](./authentication.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Repository Layout](#4-repository-layout)
5. [Request Pipeline](#5-request-pipeline)
6. [Data Layer: MerchantDO](#6-data-layer-merchantdo)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [Catalog, Cart & Orders](#8-catalog-cart--orders)
9. [Payments](#9-payments)
10. [Marketplace Integrations](#10-marketplace-integrations)
11. [AI Agents (UCP) & AI Features](#11-ai-agents-ucp--ai-features)
12. [Caching & Rate Limiting](#12-caching--rate-limiting)
13. [File Storage](#13-file-storage)
14. [Webhooks](#14-webhooks)
15. [Background Work](#15-background-work)
16. [Frontend](#16-frontend)
17. [Environment Variables](#17-environment-variables)
18. [Deployment](#18-deployment)
19. [Security](#19-security)
20. [Testing](#20-testing)

---

## 1. Overview

| Area | What it provides |
|---|---|
| Catalog | Products with variants, SKUs, barcodes, weights, per-currency prices; hierarchical categories; reviews with moderation; per-locale titles/descriptions |
| Selling | Carts, checkout, orders, refunds; regions, countries, currencies, warehouses; shipping rates and classes; tax rates; discount codes |
| Payments | Stripe Checkout and SSLCommerz, both configured and switched on/off from the admin dashboard |
| Customers | Email + password accounts (Better Auth), addresses, order history, wishlist, saved carts |
| Digital goods | Downloadable files (R2, signed links) and AI token packages |
| Marketplaces | Etsy, eBay and Amazon SP-API: connect, push listings/price/stock, import orders, send tracking |
| AI | UCP endpoints for AI shopping agents; AI translation and review-moderation help; an MCP knowledge server |
| Storefront + admin | One React 19 SPA with the Bengal theme (light/dark) and 7 languages (RTL supported) |

All store data lives in **one Durable Object's SQLite database**. There is no D1 or external database.

---

## 2. Architecture

```
   Browser: storefront + admin SPA       AI agents (UCP)      Etsy / eBay / Amazon
   (GitHub Pages / any static host)            │                       ▲  │
                  │                            │                       │  │ eBay notifications
                  ▼                            ▼                       │  ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker  apps/merchant  (Hono + @hono/zod-openapi)                   │
│                                                                                │
│  CORS allowlist → DO stub → KV cache/invalidate → rate limit → auth → routes   │
│                                                                                │
│  /v1/*  REST API      /api/auth/*  → forwarded to MerchantDO (Better Auth)     │
│  /ucp/v1/*, /.well-known/ucp       /v1/marketplace/*      /docs (Swagger)      │
│                                                                                │
│  fetch()      scheduled() every 15 min      queue() marketplace sync consumer  │
└───────┬───────────────────────────────┬─────────────────────────┬──────────────┘
        │ RPC + fetch                   │                         │
        ▼                               ▼                         ▼
┌───────────────────────────┐ ┌──────────────────────────┐ ┌─────────────────────┐
│ MerchantDO (Durable Obj.) │ │ R2  IMAGES               │ │ Queue               │
│ SQLite: catalog, carts,   │ │ R2  DIGITAL_ASSETS_BUCKET│ │ multicom-marketplace│
│ orders, customers, auth,  │ │ KV  KV_CACHE (cache,     │ │ -sync (+ DLQ)       │
│ settings, marketplaces    │ │     rate limits, AI cfg) │ │                     │
│ Better Auth, WebSockets   │ └──────────────────────────┘ └─────────────────────┘
└───────────────────────────┘
        External: Stripe · SSLCommerz · Mailgun · AI provider (OpenAI-compatible)
```

- The Worker is stateless. Every request gets a stub to the single `MerchantDO` instance (`idFromName('default')`).
- Better Auth runs **inside** the DO, because only the DO can reach its SQLite storage.

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Database | SQLite inside a Durable Object (`MerchantDO`) |
| API | Hono 4 + `@hono/zod-openapi` (Zod schemas → OpenAPI 3.1, Swagger UI at `/docs`) |
| Auth | Better Auth 1.x (email/password, Drizzle adapter over `drizzle-orm/durable-sqlite`) + hashed API keys |
| Payments | Stripe (SDK v22), SSLCommerz |
| Cache / limits | Cloudflare KV |
| Files | Cloudflare R2 |
| Background jobs | Cloudflare Queues + Cron Trigger |
| Email | Mailgun |
| AI | Any OpenAI-compatible API (Groq, OpenAI, Cloudflare AI Gateway) |
| Frontend | React 19, Vite 8, HeroUI v3, React Router 7, i18next, Tailwind |
| Monorepo | npm workspaces + Turborepo |
| Tests | Vitest (backend on `node:sqlite`, client), Playwright (e2e) |

---

## 4. Repository Layout

| Path | Contents |
|---|---|
| `apps/merchant` | Worker + Durable Object. `src/index.ts` (entry), `src/do.ts` (MerchantDO, schema, migrations), `src/routes/*`, `src/lib/*` (shared domain logic), `src/middleware/*`, `migrations/*.sql`, `scripts/` (`init.ts`, `seed.ts`, `create-admin.ts`) |
| `apps/client` | Storefront and admin SPA (`src/pages`, `src/pages/admin`, `src/locales`) |
| `apps/mcp` | MCP knowledge server about this codebase (Worker on :8788, plus a stdio build) |
| `apps/inspector` | Fork of the MCP Inspector UI |
| `e2e` | Playwright tests |
| `docs` | Documentation |

Key backend libraries in `apps/merchant/src/lib`:

| File | Responsibility |
|---|---|
| `auth.ts`, `session.ts` | Better Auth instance; session verification and admin rules |
| `order-token.ts` | Signed order view links |
| `payment-config.ts` | Encrypted payment-gateway settings (Stripe, SSLCommerz) |
| `pricing.ts`, `shipping.ts`, `tax.ts`, `inventory.ts` | Price resolution, shipping rates, tax, stock reservation |
| `webhooks.ts` | Outbound webhook signing and delivery |
| `order-email.ts`, `email-templates.ts` | Order status emails |
| `marketplace/*` | Etsy, eBay and Amazon clients, OAuth, credentials, sync queue, order import, fulfillment |

---

## 5. Request Pipeline

`src/index.ts` builds one `OpenAPIHono` app. Order matters:

1. **CORS** — allowlist only: `STORE_URL`, or the comma-separated `CORS_ORIGIN`. Credentials are allowed so the session cookie is sent. No `*` fallback; with neither set, no browser origin is allowed.
2. **DO stub** — puts the `MerchantDO` stub on the context (`c.var.db`).
3. **KV cache / invalidation** — registered with `app.use()` *before* any `app.route()` (see §12).
4. **Routes mounted before the rate limiter** (not rate-limited): `/sitemap.xml`, public `/v1/orders` (order view by token), public `/v1/categories`, `/v1/payment-methods`, `/v1/admin` settings, SSLCommerz checkout and IPN.
5. **`rateLimitMiddleware`** on `/v1/*`.
6. **All other routers.** `reviews` is mounted before the catalog router, because the catalog applies `authMiddleware` to `*`. Several routers share a prefix (`/v1/orders`, `/v1/products`, `/v1/carts`, `/v1/webhooks`), so check for collisions when adding a route.
7. `/api/auth/*` is forwarded to the DO; `/openapi.json` and `/docs` serve the API spec.

Main route groups:

| Prefix | Router(s) |
|---|---|
| `/v1/products`, `/v1/categories`, `/v1/inventory` | catalog, reviews, digital-asset variants, categories, inventory |
| `/v1/carts` | cart + Stripe checkout, SSLCommerz checkout |
| `/v1/orders` | public order view, admin orders/refunds, customer downloads |
| `/v1/customers`, `/v1/me`, `/v1/me/ai-tokens` | admin customers; signed-in customer profile, addresses, orders, AI tokens |
| `/v1/discounts`, `/v1/regions`, `/v1/tax-rates`, `/v1/analytics`, `/v1/reviews`, `/v1/mails` | admin features |
| `/v1/webhooks` | Stripe webhook; outbound webhook management |
| `/v1/setup` | `init`, `admin-user`, `config`, `reset`, `demo-reset`, migrations |
| `/v1/admin/*` | settings (payment gateways), order-email settings, digital assets, AI tokens, marketplace channels |
| `/v1/marketplace/*` | connect, sync, status, order import/shipment, inbound webhooks |
| `/ucp/v1/*`, `/.well-known/ucp` | Universal Commerce Protocol |
| `/oauth/*` | OAuth 2.0 for third-party apps |

Errors: `ApiError` carries a status code and is turned into `{ error: { code, message } }` by `app.onError`.

---

## 6. Data Layer: MerchantDO

`MerchantDO` (`src/do.ts`) owns all data. Routes talk to it through the `Database` wrapper in `src/db.ts` (`query` / `run`). The DO also exposes RPC methods:

| Method | Used by |
|---|---|
| `getSessionForCookie(cookie)` | Worker auth middleware, on every session request |
| `provisionUser(...)` | `POST /v1/setup/admin-user` (`create-admin.ts`) |
| `cleanupExpiredCarts()` | Cron |
| `broadcast(event)` | WebSocket push to connected admin clients |

Its own `fetch()` handles `/api/auth/*` (Better Auth), `/health` and WebSocket upgrades.

### 6.1 Schema and migrations

Initialization is idempotent (`ensureInitialized()`), and default API keys are created from `MERCHANT_SK` / `MERCHANT_PK`. A schema change needs **three edits together**:

1. the `SCHEMA` constant in `do.ts`
2. the inline migration list in `ensureInitialized()`
3. a numbered file in `migrations/` (currently up to `039-marketplace-order-import.sql`)

Migrations are additive only (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`).

### 6.2 Tables

| Group | Tables |
|---|---|
| Catalog | `products`, `variants`, `variant_prices`, `categories`, `product_categories`, `product_reviews`, `shipping_classes` |
| Stock | `inventory`, `inventory_logs`, `warehouses`, `warehouse_inventory`, `warehouse_inventory_logs` |
| Geography & pricing | `currencies`, `countries`, `regions`, `region_countries`, `region_warehouses`, `region_shipping_rates`, `shipping_rates`, `shipping_rate_prices`, `tax_rates` |
| Carts & orders | `carts`, `cart_items`, `orders`, `order_items`, `refunds`, `discounts`, `discount_usage`, `events` (Stripe events) |
| Customers | `customers`, `customer_addresses`, `saved_carts` |
| Auth | `user`, `session`, `account`, `verification` (Better Auth); `api_keys`; `oauth_clients`, `oauth_authorizations`, `oauth_tokens` |
| Digital | `digital_assets`, `ai_token_balances`, `ai_token_transactions` |
| Marketplaces | `marketplace_channels`, `marketplace_credentials`, `marketplace_oauth_states`, `marketplace_product_mappings`, `marketplace_orders`, `marketplace_order_lines`, `marketplace_sync_jobs`, `marketplace_webhook_events` |
| Settings | `config` (key/value, includes encrypted gateway settings), `store_themes`, `order_email_settings` |
| UCP / webhooks | `ucp_checkout_sessions`, `webhooks`, `webhook_deliveries` |
| System | `migrations` |

Full column list: [current-database-schema.md](./current-database-schema.md).

### 6.3 Key relationships

```
products ─┬─< variants ─< variant_prices (per currency)
          ├─< product_categories >─ categories
          └── shipping_classes (0..1)
variants ── inventory (by SKU) ─< warehouse_inventory (per warehouse)
carts ─< cart_items ;  carts ── orders (0..1) ─< order_items, refunds, discount_usage
customers ─< customer_addresses, saved_carts ;  customers ── user (by email)
marketplace_channels ─< credentials, product_mappings, orders ─< order_lines, sync_jobs
orders.channel_id → marketplace_channels (orders imported from a marketplace)
```

---

## 7. Authentication & Authorization

### 7.1 Credential order

`middleware/auth.ts` (admin routes) and `customer-auth.ts` (customer routes) check credentials in this order:

```
1. Cookie better-auth.session_token  → MerchantDO.getSessionForCookie()
2. Bearer sk_…  (admin key)          → SHA-256 lookup in api_keys
   Bearer pk_…  (public key)         → SHA-256 lookup, role = public
3. Bearer <64 hex chars> (OAuth)     → SHA-256 lookup in oauth_tokens
```

### 7.2 Roles

| Role | Comes from | Can do |
|---|---|---|
| `admin` | `sk_*` key, or a session whose email is in `ADMIN_EMAILS` | Everything |
| `customer` | Any other Better Auth session | Own profile, orders, addresses, wishlist, saved carts |
| `public` | `pk_*` key | Read-only storefront endpoints |
| `oauth` | OAuth access token | Limited by its `scope` |

### 7.3 Better Auth

- **Where it runs:** inside `MerchantDO` (`src/lib/auth.ts`), with tables in `src/db/schema.ts` (migration `037-add-better-auth-tables.sql`). The Worker forwards `/api/auth/*` to the DO, e.g. `POST /api/auth/sign-in/email`, `POST /api/auth/sign-up/email`, `POST /api/auth/sign-out`. The DO adds `GET /api/auth/session`, a simpler `{ session }` response that the storefront uses.
- **Verification:** the Worker does not read session tables itself. It calls the DO's `getSessionForCookie` RPC, which runs Better Auth's `getSession` (signature and expiry checked) without going through the rate-limited HTTP handler.
- **Settings:** email + password, minimum 8 characters, no email verification. Sessions last 30 days and are refreshed every 24 hours. A 5-minute cookie cache. Rate limit: 10 requests per 60 seconds per IP (`cf-connecting-ip`, `x-forwarded-for`).
- **Cross-site cookie:** when `API_BASE_URL` is `https://`, cookies are `SameSite=None; Secure`, because the storefront and API are on different sites. `trustedOrigins` = the CORS allowlist, and Better Auth's Origin (CSRF) check is always on.
- **Admins:** admin rights come only from `ADMIN_EMAILS`. Because email verification is off, public sign-up **refuses** any address in `ADMIN_EMAILS`. Admin accounts are created with `scripts/create-admin.ts` (→ `POST /v1/setup/admin-user` → `provisionUser`), which also supports `--reset-password` and `--remote`.

### 7.4 Customers

When a customer session arrives, `/v1/me/*` finds the `customers` row with the same email, and creates one if it does not exist.

### 7.5 Order view links and downloads

- **Order links:** HS256 JWT signed with `ORDER_TOKEN_SECRET`, holding the order ID, valid 30 days (`lib/order-token.ts`). Sent in order emails so buyers can view an order without logging in.
- **Downloads:** digital items get a signed download token per SKU and order; `/v1/downloads` serves the file from R2.

### 7.6 API keys and OAuth

- Keys are `sk_` / `pk_` + 48 hex characters. Only the SHA-256 hash and the prefix are stored (`api_keys`). The DO creates keys from `MERCHANT_SK` / `MERCHANT_PK` on first start.
- OAuth 2.0 for third-party apps (`/oauth/*`): tokens are 64 hex characters, stored hashed in `oauth_tokens` with scope and expiry.

---

## 8. Catalog, Cart & Orders

- **Prices** (`lib/pricing.ts`): a variant has a price per currency (`variant_prices`); the region decides the currency.
- **Stock** (`lib/inventory.ts`): stock is kept per SKU and per warehouse. Adding to a cart reserves stock; a paid order commits the sale. The cron releases reservations of expired carts.
- **Shipping and tax** (`lib/shipping.ts`, `lib/tax.ts`): rates per region and shipping class, with weight ranges; tax rates per country/region.
- **Discounts:** fixed or percentage codes, with usage limits, synced to Stripe coupons.
- **Orders:** status changes (e.g. shipped) send order emails (Mailgun, configurable per status and locale) and outbound webhooks. Refunds go back through Stripe.
- **Localized content:** product and category titles/descriptions can be plain text or per-locale JSON.

---

## 9. Payments

Both gateways are configured from **Admin → Payment Gateways**. Their settings are stored in the `config` table, and secrets are encrypted with `CRYPTOKEN` (PBKDF2-SHA256, 100,000 iterations → AES-256-CBC) by `lib/payment-config.ts`.

| | Stripe | SSLCommerz |
|---|---|---|
| Settings key | `payment_gateway.stripe` | `payment_gateway.sslcommerz` |
| Admin API | `PUT /v1/admin/settings/payment-gateways/stripe` | `PUT /v1/admin/settings/payment-gateways` |
| Saved | Publishable key, secret key, webhook secret, on/off | Store ID, store password, sandbox flag, on/off |
| Checks on save | Secret key must be accepted by Stripe (`/v1/balance`); test and live keys cannot be mixed | — |
| Checkout | `POST /v1/carts/{cartId}/checkout` → Stripe Checkout Session | `POST /v1/carts/{cartId}/checkout/sslcommerz` |
| Confirmation | `POST /v1/webhooks/stripe` (`checkout.session.completed`, `payment_intent.payment_failed`), deduplicated in `events` | `POST /v1/webhooks/sslcommerz/ipn`, then checked server-side with SSLCommerz's validation API |

- **Where Stripe keys come from:** the dashboard settings first, then the `STRIPE_*` environment variables, then the older `stripe` config row.
- **Switching Stripe off** stops new checkouts. Refunds and webhooks for existing orders keep working.
- **Storefront:** the checkout asks `GET /v1/payment-methods` (public) and only shows gateways that are on.

---

## 10. Marketplace Integrations

### 10.1 Design

Each platform has a client that implements `IMarketplaceClient` (`lib/marketplace/types.ts`). Clients that can send tracking also implement `ShipmentClient`.

```ts
interface IMarketplaceClient {
  readonly platform: 'etsy' | 'ebay' | 'amazon';
  readonly config: Record<string, unknown>;
  refreshTokens(): Promise<void>;
  getAccessToken(): Promise<string>;
  listProducts(p?: { limit?: number; cursor?: string }): Promise<{ items: MarketProduct[]; nextCursor?: string }>;
  getProduct(id: string): Promise<MarketProduct>;
  upsertProduct(product: MarketProduct): Promise<string>;
  deleteProduct(externalId: string): Promise<void>;
  listInventory(p?: { limit?: number }): Promise<MarketInventoryItem[]>;
  updateInventory(sku: string, quantity: number): Promise<void>;
  listOrders(p?: { from?: Date; to?: Date; limit?: number; by?: 'created' | 'modified' }): Promise<MarketOrder[]>;
  getOrder(externalOrderId: string): Promise<MarketOrder>;
  updateShipment(externalOrderId: string, trackingNumber: string, trackingUrl?: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

interface ShipmentClient {
  createShippingFulfillment(input: {
    orderId: string; trackingNumber: string; shippingCarrierCode: string;
    lineItems?: Array<{ lineItemId: string; quantity: number }>;
  }): Promise<void>;
}
```

| Module | Role |
|---|---|
| `etsy.ts`, `ebay.ts`, `amazon.ts` | Platform clients and mappers (`mapEtsyReceipt`, `mapEbayOrder`, `mapAmazonOrder`, …) |
| `etsy-oauth.ts`, `ebay-oauth.ts`, `amazon-oauth.ts` | Consent URLs, code exchange, token refresh |
| `auth-manager.ts` | `CredentialManager`: encrypted tokens in `marketplace_credentials` |
| `channel.ts` | Loads a channel and builds its client (`clientForChannel`) |
| `sync-jobs.ts` | Queue jobs: `push_products`, `push_inventory`, `pull_orders`, `sync_all` |
| `order-import.ts` | Turns marketplace orders into internal orders |
| `fulfillment.ts` | `pushShipment`: sends tracking back per order line |
| `buyer.ts` | Placeholder emails for masked or missing buyer emails |
| `ebay-notifications.ts` | eBay notification signature checks |
| `rate-limiter.ts` | KV per-platform limiter (exported, not yet used by the clients, which retry on 429 instead) |

### 10.2 Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/marketplace/connect/:platform` | Returns the consent URL; stores a one-time state in `marketplace_oauth_states` |
| `GET /v1/marketplace/connect/amazon/login` | Amazon "Login URI" step: sends the browser back to Seller Central |
| `GET /v1/marketplace/connect/:platform/callback` | Exchanges the code, stores tokens, creates or updates the channel, redirects to the admin page |
| `POST /v1/marketplace/:channelId/sync/{products,inventory,orders,all}` | Queues a sync job (409 if one is already running) |
| `GET /v1/marketplace/:channelId/status` | Channel and job status |
| `POST /v1/marketplace/:channelId/orders/import` | Imports orders now |
| `POST /v1/marketplace/:channelId/orders/:orderId/shipment` | Sends tracking to the marketplace |
| `GET /v1/admin/marketplace/channels`, `PATCH …/channels/:id/config` | Admin channel list and per-platform settings (validated per platform) |
| `GET|POST /v1/marketplace/webhook/ebay` | eBay endpoint check and notifications; Etsy and Amazon return 501 |

### 10.3 Per-platform details

| | Etsy | eBay | Amazon (SP-API) |
|---|---|---|---|
| Auth | OAuth 2.0 + PKCE; `x-api-key: keystring:shared_secret` | OAuth 2.0 with RuName | Seller Central consent → LWA code (`spapi_oauth_code`) → refresh token. No AWS SigV4 (dropped by Amazon in 2023) |
| Seller ID | Shop ID | — | `selling_partner_id`, stored as `external_shop_id` |
| Listings | Listings API; needs taxonomy and shipping profile | Inventory + Offer APIs; needs category and business policies | Listings Items 2021-08-01: PATCH existing listing; offer on a catalog ASIN found by barcode (`LISTING_OFFER_ONLY`); new product only with a product type |
| Orders | Receipts, pulled by the cron | Fulfillment API; pulled by the cron and on notifications | Orders v0, by last update, merchant-fulfilled only unless `import_fba_orders`; buyer data through a Restricted Data Token when the app has that role |
| Tracking | Receipt tracking | Shipping fulfillment per line item | `shipmentConfirmation` per order item |
| Channel settings | `listing_defaults`, `default_carrier` | `marketplace_id`, `content_language`, `listing`, `default_carrier` | `marketplace_id`, `region`, `amazon_listing` (product type, brand, condition, language), `default_carrier`, `import_fba_orders` |

Clients retry on 429/503 with backoff and refresh an expired access token once. Errors are marked retryable or not, so the queue does not retry bad input.

### 10.4 Order import

`importOrders()` (`order-import.ts`), for each order:

1. Skips cancelled and unpaid orders. Unpaid ones are picked up on a later run.
2. Claims `(channel_id, external_order_id)` in `marketplace_orders`. The unique index makes the import idempotent.
3. Creates or merges the customer by email, then writes `orders` (number `ETSY-…`, `EBAY-…`, `AMAZON-…`, with `channel_id`), `order_items` and `marketplace_order_lines` (with the marketplace line IDs, used later for tracking).
4. Deducts stock (reserve + commit). If stock is short, it deducts what is there and reports the shortfall; the order is never undone, because the sale already happened.

### 10.5 Credentials

`marketplace_credentials` holds `oauth_token` (with expiry) and `refresh_token`, encrypted with AES-256-GCM and a key derived from `CRYPTOKEN` (PBKDF2-SHA256, 100,000 iterations) in `crypto-utils.ts`. Access tokens are refreshed shortly before they expire; concurrent refreshes share one request.

---

## 11. AI Agents (UCP) & AI Features

- **UCP** (`routes/ucp.ts`): `/.well-known/ucp` describes the store. `/ucp/v1/products`, `/ucp/v1/categories` and `/ucp/v1/checkout-sessions` (create, read, update, estimate shipping, complete, cancel) let AI shopping agents browse and buy. Sessions are stored in `ucp_checkout_sessions`. UCP payments use Stripe only when it is on.
- **AI features** (`routes/ai.ts`): translation of product content and order emails, and review-moderation suggestions. The provider config is encrypted (`ai.json.enc`, key `CRYPTOKEN`) and pushed to KV under `ai:config` (`npm run ai:encrypt | ai:decrypt | ai:kv:push`); the `AI_*` environment variables are the fallback.
- **AI token packages:** variants of type `ai_tokens` credit `ai_token_balances` and log `ai_token_transactions`. `/v1/ai-tokens/proxy` lets an external AI service check and spend balances (`AI_BALANCE_SHARED_SECRET`).
- **MCP server** (`apps/mcp`): a knowledge server that explains this codebase to coding assistants.

---

## 12. Caching & Rate Limiting

### 12.1 KV response cache (`middleware/kv-cache.ts`)

- **Cached:** GETs on `/v1/products*`, `/v1/categories*`, `/openapi*`, `/.well-known/ucp`, `/ucp/v1/products*` and `/ucp/v1/categories` that are anonymous or use a `pk_` key. Admin requests always skip the cache.
- **Key:** `cache:<full URL>`, so each page and filter is cached separately.
- **TTL:** search 300 s, reviews 600 s, everything else 3600 s (configurable with `KV_CACHE_*_TTL_SECONDS`).
- **Invalidation:** a successful POST/PUT/PATCH/DELETE on products or categories (or a demo reset) deletes every key with the matching prefix, paging through `kv.list()`.

### 12.2 API rate limiting (`middleware/rate-limit.ts`, `config/rate-limits.ts`)

KV counters per API key and window:

| Who | Limit |
|---|---|
| Default | 100 requests/minute |
| Admin | 2000/minute |
| Public key | 60/minute |
| `/v1/carts` | 30/minute |

Better Auth has its own limit (§7.3).

---

## 13. File Storage

| Binding | Bucket | Holds |
|---|---|---|
| `IMAGES` | `multicom-images` | Product and category images, served through `/v1/images` (or `IMAGES_URL` if set) |
| `DIGITAL_ASSETS_BUCKET` | `multicom-digital-assets` | Files sold as digital products |

`digital_assets` links a SKU to a file, either an R2 key or an external URL.

---

## 14. Webhooks

### 14.1 Outbound

Merchants register URLs and event filters in **Admin → Webhooks**.

| Event | Sent when |
|---|---|
| `order.created` | An order is created (checkout or marketplace import) |
| `order.updated`, `order.shipped` | Order status changes (`shipped` sends `order.shipped`) |
| `order.refunded` | A refund is issued |
| `inventory.low` | Stock falls below the threshold |
| `ai_tokens.key_created`, `ai_tokens.credited` | AI token events |

- **Signing:** each delivery is signed with HMAC-SHA256 and carries the headers `X-Bengal-Exchange-Signature`, `X-Bengal-Exchange-Timestamp` and `X-Bengal-Exchange-Delivery-Id`.
- **Delivery:** runs in `waitUntil`, with up to 3 attempts and 2 s / 4 s backoff. Results are logged in `webhook_deliveries` and can be re-sent from the admin.

### 14.2 Inbound

| Source | Endpoint | Verification |
|---|---|---|
| Stripe | `POST /v1/webhooks/stripe` | Stripe signature with the saved webhook secret |
| SSLCommerz | `POST /v1/webhooks/sslcommerz/ipn` | Re-checked with SSLCommerz's validation API |
| eBay | `GET/POST /v1/marketplace/webhook/ebay` | `X-EBAY-SIGNATURE`. Order topics queue a `pull_orders` job; the payload itself is not trusted |

---

## 15. Background Work

| Trigger | Does |
|---|---|
| Cron `*/15 * * * *` (`scheduled()`) | Removes expired carts and releases their stock; queues `pull_orders` for every active Etsy, eBay and Amazon channel (skips channels that already have a pull queued or running) |
| Queue `multicom-marketplace-sync` (`queue()`) | Runs sync jobs one at a time (`max_batch_size` 1, `max_concurrency` 1), with 5 retries and a dead-letter queue `multicom-marketplace-sync-dlq`. Job status is in `marketplace_sync_jobs` |
| `ctx.waitUntil` | Outbound webhook delivery, emails |
| WebSocket (DO) | Live updates to connected admin clients |

---

## 16. Frontend

`apps/client` is one Vite SPA for the storefront and the admin dashboard.

- **Storefront pages:** home, product, cart/checkout, success, order view, account (profile, orders, addresses, wishlist, saved carts), CMS pages, blog, API docs.
- **Admin (`/admin`):** products, categories, inventory, warehouses, orders, customers, reviews, analytics, regions, countries, currencies, shipping rates and classes, tax rates, email templates, webhooks, payment gateways, marketplaces, users and permissions.
- **Auth:** a Better Auth session cookie (`credentials: 'include'`); the admin dashboard is shown only when `/v1/me` reports the admin role.
- **Theme:** a single Bengal theme (`data-theme="bengal"`, set before first paint by `index.html`) with light and dark modes. Tokens are in `src/styles/themes/bengal.css`, mapped onto HeroUI v3's CSS variables. Older slugs (`classic`, `luxury`, `luxury-dark`, `default`, `heroui_standard`), whether stored in user preferences, browser storage, `store_themes` rows or the `BENGAL_EXCHANGE_THEME`/`FUFUNI_THEME` env value, all resolve to `bengal`. The client no longer reads or writes a theme slug; the `store_themes` table and the `theme` field of `/v1/me/preferences` are kept but unused.
- **Light/dark:** the `.dark` class on `<html>`, managed by `hooks/use-theme.ts`. The mode is saved in browser storage (`theme`) only after the visitor picks Light or Dark in the side menu or account preferences; until then it follows the system setting, including later changes.
- **Shell:** the storefront header, side menu (profile, log in/out, language, light/dark, About/Blog/Contact) and footer are in `src/components/shell/`. Footer and menu links come from `src/config/navigation.ts` and only point at existing routes or CMS pages. Payment badges show only enabled gateways. Fonts are system stacks; there are no web fonts.
- **i18n:** `src/locales` (en-US, fr-FR, es-ES, zh-CN, ar-SA, he-IL, bn-BD). The language list is in `src/lib/languages.ts`. Arabic and Hebrew switch `<html dir>` to right-to-left on every language change. A unit test checks that every locale has exactly the en-US keys (language-specific plural forms allowed) and keeps every `{{placeholder}}`.
- **Conventions:** HeroUI components use `onPress`, not `onClick`.
- **Hosting:** built with `npm run build:client:env` and published to GitHub Pages or any static host.

---

## 17. Environment Variables

The Worker reads them from `apps/merchant/.dev.vars` locally (`npm run dev:env` copies the root `.env` there) and from `wrangler secret put` in production. Types are in `src/types.ts` (`Env`).

### 17.1 Core

| Variable | Purpose |
|---|---|
| `MERCHANT_SK`, `MERCHANT_PK` | Admin and public API keys, created on first start |
| `BETTER_AUTH_SECRET` | Signs session cookies (32+ characters) |
| `API_BASE_URL` | Public URL of the Worker; used for Better Auth and OAuth redirect URIs |
| `STORE_URL` | Storefront URL; links in emails and the default CORS origin |
| `CORS_ORIGIN` | Optional comma-separated list of allowed browser origins (replaces `STORE_URL` for CORS) |
| `ADMIN_EMAILS` | Comma-separated emails whose sessions get admin rights |
| `CRYPTOKEN` | Passphrase for encrypting gateway settings, marketplace tokens and the AI config |
| `ORDER_TOKEN_SECRET` | Signs order view links (32+ characters) |
| `STORE_NAME` | Store name in emails |

### 17.2 Payments

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Fallback used when Stripe keys are not saved in the dashboard |

SSLCommerz is configured only in the dashboard.

### 17.3 Marketplaces

| Platform | Variables |
|---|---|
| Etsy | `ETSY_CLIENT_ID` (keystring), `ETSY_SHARED_SECRET`, `ETSY_REDIRECT_URI` (optional) |
| eBay | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_ENVIRONMENT` (`sandbox`/`production`), `EBAY_VERIFICATION_TOKEN`, `EBAY_NOTIFICATION_ENDPOINT` |
| Amazon | `AMAZON_SP_APP_ID`, `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET` (old names `AMAZON_LWA_APP_ID` / `AMAZON_LWA_APP_SECRET` still work), `AMAZON_REGION` (`NA`/`EU`/`FE`); optional `AMAZON_MARKETPLACE_ID`, `AMAZON_ENVIRONMENT` (`sandbox`), `AMAZON_APP_DRAFT`, `AMAZON_SELLER_CENTRAL_URL`, `AMAZON_REDIRECT_URI` |

Without a platform's variables, its connect button returns a clear "not configured" error.

### 17.4 Optional

| Variable | Purpose | Default |
|---|---|---|
| `IMAGES_URL` | Public URL prefix for images | empty (served by the Worker) |
| `MAILGUN_USER`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL` | Email | email off |
| `AI_API_KEY`, `AI_MODEL`, `AI_API_URL` | AI provider fallback when `ai:config` is not in KV | AI off |
| `CLOUDFLARE_AIG_TOKEN` | Cloudflare AI Gateway token | — |
| `AI_BALANCE_SHARED_SECRET` | AI token proxy | proxy off |
| `KV_CACHE_SEARCH_TTL_SECONDS`, `KV_CACHE_REVIEWS_TTL_SECONDS`, `KV_CACHE_DEFAULT_TTL_SECONDS` | Cache TTLs | 300 / 600 / 3600 |
| `DATABASE_PERMISSION`, `MAIL_PERMISSION`, `AI_PERMISSION` | Permission names used by the admin UI | — |

### 17.5 Adding a variable

1. Add it to `Env` in `src/types.ts`, with a comment.
2. For a non-secret value, add it to `vars` in `wrangler.jsonc`; for a secret, use `npx wrangler secret put NAME`.
3. If the Durable Object needs it, also add it to `MerchantEnv` in `do.ts`.
4. Document it in `run-instructions.md` and here. Run `npm run typegen` after changing `wrangler.jsonc`.

---

## 18. Deployment

**Bindings** (`wrangler.jsonc`):

| Binding | Resource |
|---|---|
| `MERCHANT` | `MerchantDO` (SQLite class) |
| `IMAGES`, `DIGITAL_ASSETS_BUCKET` | R2 buckets |
| `KV_CACHE` | KV namespace |
| `MARKETPLACE_SYNC_QUEUE` | Queue producer and consumer (with DLQ) |
| Cron | `*/15 * * * *` |

**Steps:**

1. **Backend:**
   ```bash
   cd apps/merchant
   npx wrangler deploy
   npx wrangler secret put BETTER_AUTH_SECRET   # and MERCHANT_SK, ADMIN_EMAILS, CRYPTOKEN, …
   ```
2. **First run:**
   ```bash
   npx tsx scripts/init.ts --remote
   npx tsx scripts/create-admin.ts you@example.com --remote
   ```
3. **Storefront:** run `npm run build:client:env` and publish `apps/client/dist`.
4. **MCP server** (optional): deploy `apps/mcp` and create its vectorize index (`bengal-exchange-mcp`).

Checklist before launch: [production-checklist.md](./production-checklist.md).

---

## 19. Security

| Concern | How it is handled |
|---|---|
| Sessions | Better Auth signed cookies, HttpOnly, `SameSite=None; Secure` over HTTPS; Origin check always on |
| Admin rights | Only emails in `ADMIN_EMAILS`; public sign-up refuses those emails; admins are created by script |
| API keys / OAuth tokens | Stored as SHA-256 hashes only |
| CORS | Allowlist, fails closed |
| Secrets at rest | Gateway settings: AES-256-CBC; marketplace tokens: AES-256-GCM; both with keys from `CRYPTOKEN` via PBKDF2-SHA256 |
| Payments | Stripe webhook signatures; SSLCommerz payments re-validated server-side; Stripe keys checked before saving |
| Inbound marketplace webhooks | eBay signatures verified; the payload only triggers a pull |
| OAuth connect | One-time `state` with expiry; Amazon's return address must be a Seller Central host over HTTPS |
| Buyer data | Amazon buyer data only with the restricted role; masked marketplace emails replaced by placeholders |
| Order links | Signed 30-day tokens |
| Outbound webhooks | HMAC-SHA256 signature with timestamp |
| Abuse | KV rate limits per key; Better Auth limit per IP |

The root `.env` holds secrets and must not be committed.

---

## 20. Testing

| Suite | Command | Notes |
|---|---|---|
| Backend | `cd apps/merchant && npm test` | Vitest. `tests/helpers/merchant-db.ts` runs the real `MerchantDO` schema and migrations on `node:sqlite`; `cloudflare:workers` is stubbed. External APIs (Stripe, Etsy, eBay, Amazon) are faked at the `fetch` level |
| Client | `cd apps/client && npm test` | Vitest, Node environment (no DOM) |
| E2E | `cd e2e && npm run test:dev` | Playwright against local dev servers (projects: `public-chromium`, `auth-user`, `auth-admin`) |

The integration suites `advanced-routes`, `regions.integration` and `variant-pricing` need a running Worker and a `.env` at a fixed path, so they fail in a plain `npm test`.
