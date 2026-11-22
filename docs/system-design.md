# Multicom  — System Design Document

**Version:** 2.0 | **Date:** 2026-11-21 | **Status:** Active

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Tech Stack](#3-tech-stack)
4. [Project Structure](#4-project-structure)
5. [Core Runtime: Cloudflare Durable Object](#5-core-runtime-cloudflare-durable-object)
6. [Database Schema](#6-database-schema)
7. [Authentication System](#7-authentication-system)
8. [Marketplace Integrations](#8-marketplace-integrations)
9. [API Key System](#9-api-key-system)
10. [Caching Layer](#10-caching-layer)
11. [Payment & Checkout](#11-payment--checkout)
12. [Image & Digital Asset Storage](#12-image--digital-asset-storage)
13. [Webhooks](#13-webhooks)
14. [Environment Variables](#14-environment-variables)
15. [Deployment](#15-deployment)

---

> **Note:** See [docs/authentication.md](./authentication.md) for a detailed end-to-end walkthrough of how authentication works across the entire project — from frontend login to session verification in the worker.

---

## 1. Overview

Multicom is a **headless commerce platform** built on Cloudflare Workers. It provides:

- **Product catalog** with variants, categories, and multi-currency pricing
- **Cart + checkout** powered by Stripe (and SSLCommerz for South Asia)
- **Order management** with shipping, tax, and discount support
- **Customer accounts** via Better Auth session-based authentication (email/password)
- **Multi-channel marketplace sync** (Etsy, eBay, Amazon SP-API)
- **Digital products** (downloadable assets + AI token packages)
- **Storefront API** (OpenAPI/Swagger documented)
- **Public storefront** (React SPA with theming and i18n)

The platform is designed for **single-region Durable Object storage** (SQLite), **KV caching**, and **R2 object storage** — all running on Cloudflare's edge network.

---

## 2. Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│                        Client Layer                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │ Storefront   │   │ Admin Panel  │   │ Third-party      │  │
│  │ (React SPA)  │   │ (React SPA)  │   │ consumers        │  │
│  └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘  │
└─────────┼──────────────────┼─────────────────────┼────────────┘
          │                   │                     │
          ▼                   ▼                     ▼
┌───────────────────────────────────────────────────────────────┐
│                   Cloudflare Edge (Worker)                    │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Hono API Server (OpenAPI/Swagger)                      │  │
│  │  /v1/* — Admin + Public REST endpoints                  │  │
│  │  /oauth/* — OAuth flows                                 │  │
│  │  /v1/marketplace/* — Multi-channel sync                 │  │
│  └───────────────────┬─────────────────────────────────────┘  │
│                      │                                        │
│  ┌───────────────────▼─────────────────────────────────────┐  │
│  │  Middleware Pipeline                                      │  │
│  │  • CORS                                                   │  │
│  │  • Auth (API keys, Better Auth sessions, OAuth tokens)              │  │
│  │  • Rate limiting                                          │  │
│  │  • KV cache / invalidation                                │  │
│  └───────────────────┬─────────────────────────────────────┘  │
│                      │                                        │
│  ┌───────────────────▼─────────────────────────────────────┐  │
│  │  MerchantDO (Durable Object)                              │  │
│  │  • SQLite storage (SQLITE3)                               │  │
│  │  • Schema migrations                                      │  │
│  │  • WebSocket broadcasts                                   │  │
│  │  • Scheduled cron (cart expiry)                           │  │
│  └───────────────────┬─────────────────────────────────────┘  │
│                      │                                        │
│  ┌───────────────────▼─────────────────────────────────────┐  │
│  │  External Services                                        │  │
│  │  • Stripe (payments, webhooks)                            │  │
│  │  • Better Auth (session cookies)                              │  │
│  │  • Mailgun (transactional email)                          │  │
│  │  • AI providers (Groq/OpenAI-compatible)                  │  │
│  │  • Marketplaces (Etsy, eBay, Amazon SP-API)               │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
          │                   │                     │
          ▼                   ▼                     ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│ R2: IMAGES   │   │ R2: DIGITAL  │   │ KV: KV_CACHE     │
│ (product     │   │ ASSETS       │   │ (public JSON     │
│  photos)     │   │ (downloads,  │   │  responses,      │
│              │   │  AI tokens)  │   │  rate limits)    │
└──────────────┘   └──────────────┘   └──────────────────┘
```

---

## 3. Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Cloudflare Workers | Edge serverless execution |
| **Database** | SQLite (Durable Object) | Primary data store, single-region |
| **Cache** | Cloudflare KV | Public response caching, rate limiting |
| **Object Storage** | Cloudflare R2 | Product images, digital assets |
| **API Framework** | Hono + OpenAPI | REST API with Swagger docs |
| **Validation** | Zod | Request/response schemas |
|| **Auth** | Better Auth (session cookies) + API keys | Customer identity + admin permissions |
| **Payments** | Stripe + SSLCommerz | Checkout, subscriptions, refunds |
| **Email** | Mailgun | Transactional emails |
| **AI** | Groq / OpenAI-compatible | Product description translation |
| **Frontend** | React + Vite | Storefront SPA |
| **Admin UI** | HeroUI (React) | Merchant admin panel |

## 6. Database Schema Details

### Key Relationships

```
products (1) ──┬── (N) variants ── (1..N) variant_prices (via currencies)
               ├── (N) product_categories ── (N) categories
               └── (0..1) shipping_classes

variants (1) ── (N) inventory (by SKU)
               └── (N) warehouse_inventory (per warehouse)

carts (1) ── (N) cart_items
            └── (0..1) orders → (N) order_items

customers (1) ── (N) customer_addresses
                └── (N) saved_carts

orders (1) ── (N) refunds
             └── (N) discount_usage

marketplace_channels (1) ── (N) marketplace_product_mappings
                            └── (N) marketplace_orders
                            └── (N) marketplace_credentials
                            └── (N) marketplace_sync_jobs
```

### Indexes

All tables have composite indexes covering the most common query patterns:

- `idx_variants_sku` — unique lookup by SKU
- `idx_products_status` — filtered product listing
- `idx_orders_customer`, `idx_orders_email`, `idx_orders_status_created` — order queries
- `idx_carts_expires`, `idx_carts_status` — cart expiry cleanup
- `idx_marketplace_*` — all marketplace tables indexed by channel_id

---

## 7. Authentication System

> **Full details:** See [docs/authentication.md](./authentication.md) for an end-to-end walkthrough of the auth flow from frontend login through session verification and role-based access control.

### 7.1 Three-Layer Auth

The platform supports **three authentication methods**, handled by the auth middleware in order:

```
Request → Authorization Header / Cookie
         │
         ├─ Cookie: better-auth.session_token=*** (Better Auth session) → DB lookup via SHA-256 hash
         ├─ Bearer sk_... (Admin API key) → DB lookup via SHA-256 hash
         ├─ Bearer pk_... (Public API key) → DB lookup, role=public
         └─ Bearer <64-hex> (OAuth token)  → DB lookup via SHA-256 hash
```

### 7.2 Auth Roles

|| Role | Source | Permissions |
|------|--------|-------------|
| `public` | `pk_*` API key | Read-only endpoints |
| `admin` | `sk_*` API key or Better Auth session | Full store management |
| `oauth` | OAuth 2.0 access token (64-char hex) | Scoped via `scope` claim |
| `customer` | Better Auth session | Customer-facing endpoints only |

### 7.3 Better Auth Integration

**Customer auth:** Users sign up or log in via email/password at `/api/auth/signin/email`. The backend issues a secure HttpOnly cookie (`better-auth.session_token`) containing a random session token. The frontend verifies login state by calling `GET /api/auth/session`.

**Session verification:** The middleware hashes the raw cookie token with SHA-256 and queries the `sessions` table for a matching hash with a future `expires_at`. On match, the user's email, name, and user ID are extracted from the joined `user` table.

**Session storage (D1):**
```sql
CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "session" (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,        -- SHA-256 hash of raw token
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE "account" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT, refresh_token TEXT, id_token TEXT,
  access_token_expires_at TEXT, refresh_token_expires_at TEXT,
  scope TEXT, password TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, provider_id)
);
```

**Session configuration:**
- Lifetime: 30 days (`session.expiresIn = 2592000s`)
- Update age: renewed every 24 hours (`session.updateAge = 86400s`)
- Cookie cache: session data cached for 5 minutes in the cookie itself

**Rate limiting:** 10 requests per 60-second window per IP (using `cf-connecting-ip` / `x-forwarded-for`).

### 7.4 Auth Router & Session Endpoint

The worker mounts Better Auth's built-in handlers at `/api/auth/*`:
```typescript
// apps/merchant/src/index.ts
app.all('/api/auth/*', async (c) => {
  const auth = createAuthRouter(c.env as any);
  return auth.fetch(c.req.raw);
});

app.get('/api/auth/session', async (c) => {
  const sessionApp = createSessionRouter(c.env as any);
  return sessionApp.fetch(c.req.raw);
});
```

This provides all standard Better Auth endpoints out of the box: `POST /api/auth/signin/email`, `POST /api/auth/signup/email`, `POST /api/auth/signout`, `GET /api/auth/session`, etc.

### 7.5 Customer Account Resolution

When a Better Auth session is verified, the middleware sets `auth.userId` (the `user.id`). Customer-facing routes (`/v1/me/*`) then resolve the corresponding `customers` row by joining on email:
```sql
SELECT * FROM customers 
WHERE email IN (SELECT email FROM "user" WHERE id = ?) LIMIT 1;
```

If no customer row exists, one is auto-created with `auth_provider = 'better-auth'` and `auth_provider_id` set to the user ID.

### 7.6 Order View Tokens

Customers can view their order status without logging in. The system generates an HMAC-HS256 JWT (`ORDER_TOKEN_SECRET`) containing the order ID (`oid` claim). This token is included in order confirmation emails as a tracking link. Valid for 30 days.

### 7.7 API Key Generation

```typescript
function generateApiKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes); // 48 hex chars
  return `${prefix}_${hex}`;
}
```

Keys are stored as SHA-256 hashes in the `api_keys` table. The prefix (`sk_` or `pk_`) is stored separately for display purposes.

---

## 8. Marketplace Integrations

### 8.1 Architecture

All marketplace clients implement the **unified `IMarketplaceClient` interface** defined in `types.ts`:

```typescript
interface IMarketplaceClient {
  readonly platform: 'etsy' | 'ebay' | 'amazon';
  config: Record<string, unknown>;

  // Auth
  refreshTokens(): Promise<void>;
  getAccessToken(): Promise<string>;

  // Products
  listProducts(params?): Promise<{ items: MarketProduct[]; nextCursor?: string }>;
  getProduct(id: string): Promise<MarketProduct>;
  upsertProduct(product: MarketProduct): Promise<string>;
  deleteProduct(externalId: string): Promise<void>;

  // Inventory
  listInventory(params?): Promise<MarketInventoryItem[]>;
  updateInventory(sku: string, quantity: number): Promise<void>;

  // Orders
  listOrders(params?): Promise<MarketOrder[]>;
  getOrder(externalOrderId: string): Promise<MarketOrder>;
  updateShipment(orderId: string, trackingNumber: string, trackingUrl?: string): Promise<void>;

  // Health
  healthCheck(): Promise<boolean>;
}
```

### 8.2 Data Mapping

Each platform returns data in its own shape. The **data-mapper** module normalizes to internal types:

```
Etsy Listing ──→ mapMarketplaceToProduct() ──→ MarketProduct
eBay InventoryItem ──→ mapMarketplaceToProduct() ──→ MarketProduct
Amazon ListingsItems ──→ mapAmazonListingToProduct() ──→ MarketProduct

Etsy Receipt ──→ mapMarketplaceToOrder() ──→ MarketOrder
eBay Order ──→ mapEbayOrderToOrder() ──→ MarketOrder
Amazon Orders v2 ──→ mapAmazonOrderToOrder() ──→ MarketOrder
```

### 8.3 Amazon SP-API Integration (Phase 3)

**Three-layer authentication:**

1. **LWA (Login with Amazon):** OAuth 2.0 flow — authorization code → access token (1h expiry) + refresh token (permanent)
2. **RDT (Restricted Data Token):** Per-operation PII token fetched via `/2021-06-30/authorizationTokens` endpoint
3. **AWS SigV4:** Every request cryptographically signed using HMAC-SHA256 chain

**Implementation in `amazon.ts`:**

| Method | Endpoint | Auth Required | RDT Required |
|--------|----------|---------------|--------------|
| `listProducts` | GET /listings/2021-08-01/items/{sellerId} | LWA + SigV4 | No |
| `getProduct` | GET /listings/.../{sellerId},{asin} | LWA + SigV4 | No |
| `upsertProduct` | PUT /listings/.../{sellerId},{sku} | LWA + SigV4 | No |
| `deleteProduct` | DELETE /listings/.../{sellerId},{id} | LWA + SigV4 | No |
| `listInventory` | GET /inventory/v2 | LWA + SigV4 | No |
| `updateInventory` | PATCH /listings/.../{sellerId},{sku} | LWA + SigV4 | No |
| `listOrders` | GET /orders/v2/orders?created_after=... | LWA + SigV4 | No (metadata only) |
| `getOrder` | GET /orders/v2/orders/{orderId} | LWA + SigV4 + RDT | **Yes** |
| `updateShipment` | POST /orders/v2/{orderId}/shipments | LWA + SigV4 + RDT | **Yes** |

**Rate limits:** Amazon orders API is limited to 0.0056 req/sec (~480/day). The rate limiter enforces per-operation sub-limits in `rate-limiter.ts`.

### 8.4 OAuth Connect Flow

All platforms share the same connect flow via `/v1/marketplace/connect/:platform`:

```
POST /connect/:platform     → generateAuthUrl() → returns { channelId, authUrl }
GET  /connect/:platform/callback?code=... → exchangeCodeForTokens() → stores encrypted credentials
```

- **Etsy:** OAuth 2.0 with keystring:shared_secret API key header
- **eBay:** OAuth 2.0 with RuName redirect URI
- **Amazon:** LWA OAuth 2.0 with `api.amazon.com/auth/o2/token`

### 8.5 Credential Storage

All marketplace credentials are encrypted at rest using **AES-GCM** (via `crypto-utils.ts`):

| Credential Type | Stored In | Decrypted Via |
|-----------------|-----------|---------------|
| `oauth_token` | `marketplace_credentials` table | `getSecret(channelId, 'oauth_token')` |
| `refresh_token` | `marketplace_credentials` table | Same |
| `api_key` (AWS Access Key ID) | `marketplace_credentials` table | Same |
| `secret_key` (AWS Secret Key) | `marketplace_credentials` table | Same |

Encryption passphrase is the `CRYPTOKEN` environment variable, derived via PBKDF2-SHA256.

---

## 9. API Key System

### 9.1 Key Types

| Prefix | Role | Scope |
|--------|------|-------|
| `sk_...` | Admin | Full access to all admin routes |
| `pk_...` | Public | Read-only storefront endpoints (products, categories, reviews) |

### 9.2 Storage & Verification

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,    -- SHA-256 of the raw key
  key_prefix TEXT NOT NULL,          -- Display prefix (sk_ or pk_)
  role TEXT NOT NULL CHECK (role IN ('public', 'admin'))
);
```

The middleware hashes the incoming token and does a single indexed lookup. Keys are seeded at DO startup from `MERCHANT_SK` and `MERCHANT_PK` environment variables.

### 9.3 OAuth Tokens

For third-party integrations that need scoped access:

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,   -- SHA-256 of raw token
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL
);
```

Tokens are 64-character hex strings (32 bytes random). The middleware checks `isOAuthToken` by pattern matching (`/^[a-f0-9]{64}$/`).

---

## 10. Caching Layer

### 10.1 KV Cache Strategy

The `KV_CACHE` namespace stores serialized JSON responses for **public endpoints**:

| Endpoint | Cache Key Pattern | TTL |
|----------|-------------------|-----|
| `/v1/products` | `products:*` | Default (3600s) |
| `/v1/categories` | `categories:*` | Default (3600s) |
| `/v1/products/:id/reviews/guest` | `reviews:guest:*` | Reviews TTL (600s) |
| Search results | `search:*` | Search TTL (300s) |

### 10.2 Cache Invalidation

On successful mutations (POST/PUT/PATCH/DELETE), the `kvInvalidateMiddleware` purges by prefix:

```typescript
// After PUT /v1/products/:id → purge all product cache keys
await kv.delete('products:*');
```

### 10.3 Rate Limiting

The KV-backed rate limiter (`rate-limiter.ts`) uses sliding-window counters:

- **Daily counter:** `ml:dq:{platform}:{windowId}` — expires after 86400s
- **Per-second counter:** `ml:sq:{platform}:{windowId}` — expires after 2s

Amazon has per-operation sub-limits (e.g., `searchOrders: 0.0056/s`, `getOrder: 0.5/s`).

---

## 11. Payment & Checkout

### 11.1 Stripe Integration

```
Customer creates cart → POST /v1/carts/:id/checkout
                         ↓
                    Stripe Checkout Session (server-side)
                         ↓
                    Redirect customer to Stripe hosted page
                         ↓
                    Stripe webhook → POST /v1/webhooks/stripe
                         ↓
                    Worker processes order creation, inventory deduction
```

**Environment variables:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`

### 11.2 SSLCommerz (South Asia)

Separate app mounts at `/v1/carts` and `/v1/webhooks/sslcommerz`. Handles payment initiation and IPN (instant payment notification) callbacks.

---

## 12. Image & Digital Asset Storage

### 12.1 R2 Buckets

| Binding | Purpose |
|---------|---------|
| `IMAGES` | Product photos, category thumbnails |
| `DIGITAL_ASSETS_BUCKET` | Downloadable files, AI token package assets |

### 12.2 Digital Assets Table

```sql
CREATE TABLE digital_assets (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE REFERENCES inventory(sku),
  storage_type TEXT NOT NULL DEFAULT 'url' CHECK (storage_type IN ('url', 'r2')),
  storage_value TEXT NOT NULL,     -- R2 key or external URL
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL
);
```

### 12.3 AI Token Packages

Products with `variant_type = 'ai_tokens'` include `ai_token_units`. Purchases credit the customer's `ai_token_balances` table and create ledger entries in `ai_token_transactions`.

---

## 13. Webhooks

### 13.1 Outbound Webhooks

The platform sends events to merchant-configured URLs:

| Event | Trigger |
|-------|---------|
| `order.created` | New order placed |
| `order.updated` | Order status changed |
| `order.shipped` | Tracking number set |
| `order.refunded` | Refund issued |
| `inventory.low` | Stock below threshold |

**Delivery retry:** Failed deliveries are retried with exponential backoff. Status tracked in `webhook_deliveries` table.

### 13.2 Inbound Webhooks

Marketplace webhooks (Etsy/eBay) are received at `/v1/marketplace/webhook/:platform` and processed to update local inventory/orders.

---

## 14. Environment Variables

See [Section 15](#15-environment-variables) for full configuration guide.

---

## 15. Environment Variables

### 15.1 Required (Production)

| Variable | Purpose | Example |
|----------|---------|---------|
| `MERCHANT_SK` | Admin API key (seeded at DO startup) | `sk_abc123...` |
| `MERCHANT_PK` | Public API key (seeded at DO startup) | `pk_def456...` |
| `STRIPE_SECRET_KEY` | Stripe API secret key | `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (frontend) | `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification | `whsec_...` |
| `CRYPTOKEN` | AES-GCM encryption passphrase for secrets at rest | 32+ char random string |
| `ORDER_TOKEN_SECRET` | HMAC secret for order view tokens (32+ chars) | 32+ char random string |

### 15.2 Better Auth Configuration

|| Variable | Purpose | Default |
|----------|---------|---------|
| `BETTER_AUTH_SECRET` | Secret used to sign Better Auth session cookies (≥32 chars) | *(required)* |
| `API_BASE_URL` | Base URL for cookie callbacks and redirect URIs | `http://127.0.0.1:8787` |

### 15.3 Marketplace Configuration

#### Etsy
| Variable | Purpose |
|----------|---------|
| `ETSY_CLIENT_ID` | Etsy app keystring |
| `ETSY_SHARED_SECRET` | Etsy shared secret; sent with the keystring as `x-api-key: keystring:shared_secret` |
| `ETSY_REDIRECT_URI` | Registered OAuth callback URL (optional; defaults to `API_BASE_URL` + `/v1/marketplace/connect/etsy/callback`) |

#### eBay
| Variable | Purpose |
|----------|---------|
| `EBAY_CLIENT_ID` | eBay OAuth client ID |
| `EBAY_CLIENT_SECRET` | eBay OAuth client secret |
| `EBAY_RU_NAME` | eBay RuName redirect URI alias |

#### Amazon (Phase 3)
| Variable | Purpose |
|----------|---------|
| `AMAZON_LWA_APP_ID` | Login with Amazon app ID |
| `AMAZON_LWA_APP_SECRET` | Login with Amazon app secret |
| `AMAZON_AWS_ACCESS_KEY` | AWS Access Key ID for SigV4 signing |
| `AMAZON_AWS_SECRET_KEY` | AWS Secret Access Key for SigV4 signing |
| `AMAZON_REGION` | SP-API region (`NA`, `EU`, `FEA`) — default: `NA` |

### 15.4 Optional / Operational

| Variable | Purpose | Default |
|----------|---------|---------|
| `STORE_NAME` | Store display name in emails | *(none)* |
| `STORE_URL` | Public storefront URL for tracking links | *(none)* |
| `IMAGES_URL` | R2 public URL prefix for images | *(empty, uses signed URLs)* |
| `AI_API_KEY` | Groq/OpenAI API key for AI features | *(none — disabled)* |
| `AI_MODEL` | Model name (e.g., `llama-3.3-70b-versatile`) | *(none)* |
| `AI_API_URL` | AI provider base URL | *(none)* |
| `MAILGUN_USER` | Mailgun API user | *(none — email disabled)* |
| `MAILGUN_API_KEY` | Mailgun API key | *(none — email disabled)* |
| `MAILGUN_DOMAIN` | Mailgun domain | *(none — email disabled)* |
| `MAILGUN_BASE_URL` | Custom Mailgun endpoint | *(default: api.mailgun.net)* |
| `KV_CACHE_SEARCH_TTL_SECONDS` | Search result cache TTL | `300` (5 min) |
| `KV_CACHE_REVIEWS_TTL_SECONDS` | Review cache TTL | `600` (10 min) |
| `KV_CACHE_DEFAULT_TTL_SECONDS` | Default cache TTL | `3600` (1 hour) |
| `AI_BALANCE_SHARED_SECRET` | Secret for AI token proxy auth | *(none — proxy disabled)* |
| `CLOUDFLARE_AIG_TOKEN` | Cloudflare AI Gateway bearer token | *(none)* |

### 15.5 Adding New Environment Variables

**In the Worker (`wrangler.jsonc`):** Add to the `"vars"` object:
```jsonc
"vars": {
  "IMAGES_URL": "",
  "MY_NEW_VAR": "default-value"
}
```

**In the TypeScript types (`src/types.ts` `Env` interface):** Add the binding with JSDoc:
```typescript
/** Description of what this var does. */
MY_NEW_VAR?: string;
```

**In the Durable Object (`src/do.ts` `MerchantEnv` interface):** If used as a secret (not a plain var), add to the `MerchantEnv` interface — Cloudflare secrets are injected as top-level bindings, not under `vars`.

**For secrets (sensitive values):** Set via `wrangler secret put MY_SECRET` or in the Cloudflare dashboard. These are injected as direct bindings on `c.env`, not through `vars`.

---

## 16. Deployment

### 16.1 Build & Deploy

```bash
# From project root
cd apps/merchant
npx wrangler deploy          # Deploy to production
npx wrangler deploy --dry-run  # Type-check + dry run (used in CI)
```

The `wrangler.jsonc` configures:
- **Durable Object:** `MERCHANT` → `MerchantDO` class
- **R2 buckets:** `IMAGES`, `DIGITAL_ASSETS_BUCKET`
- **KV namespace:** `KV_CACHE`
- **Cron trigger:** `*/15 * * * *` (cart expiry cleanup every 15 min)

### 16.2 Frontend

```bash
cd apps/client
npm run build    # Vite production build
# Deploy output from dist/ to any static host (Cloudflare Pages, Netlify, etc.)
```

---

## 17. Security Considerations

|| Concern | Mechanism |
|---------|-----------|-----------|
| **Session tokens** | SHA-256 hash stored in DB; raw token only in HttpOnly cookie |
| **Secrets at rest** | AES-GCM encryption via `crypto-utils.ts` with PBKDF2 key derivation |
| **API authentication** | SHA-256 hash comparison (never store plaintext keys) |
| **Order view tokens** | HMAC-HS256 JWT signed with `ORDER_TOKEN_SECRET`, 30-day TTL |
| **AWS SigV4** | HMAC-SHA256 signing chain for all Amazon SP-API requests |
| **PII handling** | RDT tokens obtained per-operation; never cached across sessions |
| **Rate limiting** | KV-backed sliding window + Better Auth rate limiter (10 req/60s per IP) |
| **CORS** | Enabled on all routes via Hono `cors()` middleware |

---


