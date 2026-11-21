# Development Roadmap: External Marketplace Integrations (Etsy, eBay, Amazon)

**Project:** Multicom — Headless commerce platform on Cloudflare Workers  
**Date:** 2026-11-18  
**Version:** 1.1
**Status:** P0 Complete, P1 In Progress

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Blueprint](#2-architecture-blueprint)
3. [Phase 0: Foundation — Schema, Auth, and Integration Layer](#3-phase-0-foundation-schema-auth-and-integration-layer)
4. [Phase 1: Etsy Integration](#4-phase-1-etsy-integration)
5. [Phase 2: eBay Integration](#5-phase-2-ebay-integration)
6. [Phase 3: Amazon SP-API Integration](#6-phase-3-amazon-sp-api-integration)
7. [Phase 4: Unified Dashboard & Automation](#7-phase-4-unified-dashboard-and-automation)
8. [Dependency Graph and Timeline](#8-dependency-graph-and-timeline)
9. [Testing Strategy](#9-testing-strategy)
10. [Deployment Checklist](#10-deployment-checklist)

---

## 1. Overview

This roadmap details the implementation of marketplace integrations for Etsy, eBay, and Amazon SP-API into the existing Multicom platform. The project follows a phased approach to minimize risk and deliver incremental value.

**Key principles:**
- Build a unified `IMarketplaceClient` interface; all platforms implement it
- Reuse existing auth middleware (API keys + Auth0 JWT) for admin routes
- Store all credentials encrypted in R2 or KV; never in plain text
- Implement per-platform rate limiting with Cloudflare KV sliding windows
- Webhooks receive external events → enqueue → process asynchronously

**Timeline:** 16–24 weeks for a single developer, depending on Amazon onboarding speed.

---

## 2. Architecture Blueprint

### 2.1 Integration Layer Structure

```
apps/merchant/src/
├── lib/
│   └── marketplace/                     # New directory
│       ├── index.ts                     # Unified IMarketplaceClient interface
│       ├── types.ts                     # Shared type definitions
│       ├── auth-manager.ts              # Token lifecycle (refresh, expiry, rotation)
│       ├── rate-limiter.ts              # Per-platform KV-based rate limiting
│       ├── data-mapper.ts               # Normalizes marketplace → internal schema
│       ├── crypto-utils.ts              # AES-256-CBC encryption/decryption for credentials
│       ├── etsy.ts                      # Etsy API client + webhook handler
│       ├── ebay.ts                      # eBay API client (dual-token flow)
│       └── amazon.ts                    # Amazon SP-API client (LWA + RDT + SigV4)
├── routes/
│   └── marketplace/                     # New directory
│       ├── index.ts                     # Mount point for all marketplace routes
│       ├── connect.ts                   # OAuth authorization redirect + callback
│       ├── webhook.ts                   # Unified webhook receiver (platform-agnostic)
│       ├── sync-products.ts             # Trigger product sync to a channel
│       ├── sync-inventory.ts            # Trigger inventory sync
│       └── status.ts                    # Health check per connected channel
└── tests/
    └── marketplace/                     # New directory
        ├── auth-manager.test.ts
        ├── rate-limiter.test.ts
        ├── data-mapper.test.ts
        ├── etsy.test.ts
        ├── ebay.test.ts
        └── amazon.test.ts
```

### 2.2 Data Flow

```
[External Marketplace]
    │
    ▼ (webhook POST / polling API)
[Integration Route: /v1/marketplace/webhook/:platform]
    │
    ▼ [Verify signature → decrypt token → validate payload]
[Data Mapper: normalize to internal Order/Product/Variant types]
    │
    ▼ [Write to D1 via DO]
[Internal Orders table]  [Internal Inventory table]
    │
    ▼ [Broadcast via WebSocket]
[Admin UI real-time updates]

Reverse flow (internal → marketplace):
[Admin action: "Push products" / "Mark shipped"]
    → [Marketplace Client (IMarketplaceClient.pushProducts / .updateShipment)]
    → [External Marketplace API]
```

### 2.3 Encryption Strategy

Credentials are encrypted at rest using AES-256-CBC with a key derived from `CRYPTOKEN` env var, following the existing pattern for `ai.json.enc`:

```typescript
// apps/merchant/src/lib/marketplace/crypto-utils.ts
import { webcrypto } from 'node:crypto';

export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(secret.slice(0, 32)), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(plaintext));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(encrypted)));
}

export async function decrypt(ciphertext: string, secret: string): Promise<string> {
  const raw = atob(ciphertext);
  const iv = new Uint8Array(raw.slice(0, 12).split('').map(c => c.charCodeAt(0)));
  const data = new Uint8Array(raw.slice(12).split('').map(c => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(secret.slice(0, 32)), 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
```

---

## 3. Phase 0: Foundation — Schema, Auth, and Integration Layer

**Duration:** 2 weeks (Weeks 1–2)  
**Dependencies:** None  
**Goal:** Create the shared infrastructure that all marketplace integrations depend on.

### 3.1 Database Schema Migrations

Create migration `037_marketplace_channels.sql` applied in `do.ts`:

```sql
-- Marketplace channel registry
CREATE TABLE IF NOT EXISTS marketplace_channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'amazon')),
  store_id TEXT NOT NULL,            -- Auth0 sub or admin user ID who owns this channel
  external_shop_id TEXT,             -- Etsy shop_id, eBay userId, Amazon SellerId
  config_json TEXT NOT NULL DEFAULT '{}',  -- JSON: settings, flags, last_sync_at
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channel-specific product mapping
CREATE TABLE IF NOT EXISTS marketplace_product_mappings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  variant_id TEXT REFERENCES variants(id),
  external_listing_id TEXT NOT NULL, -- Etsy listing_id, eBay itemId, Amazon ASIN/SKU
  external_sku TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, external_listing_id)
);

-- External orders ingested from marketplaces
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  internal_order_id TEXT REFERENCES orders(id),
  external_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_payload TEXT NOT NULL,         -- JSON snapshot of original payload
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Encrypted credentials store
CREATE TABLE IF NOT EXISTS marketplace_credentials (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  credential_type TEXT NOT NULL CHECK (credential_type IN ('api_key', 'oauth_token', 'refresh_token')),
  encrypted_value TEXT NOT NULL,     -- AES-256-GCM encrypted base64 string
  metadata TEXT DEFAULT '{}',         -- e.g., {"expires_at":"...","token_type":"Bearer"}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sync job queue for async product/inventory syncs
CREATE TABLE IF NOT EXISTS marketplace_sync_jobs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('push_products', 'push_inventory', 'pull_orders', 'sync_all')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  payload TEXT DEFAULT '{}',
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_marketplace_channels_platform ON marketplace_channels(platform);
CREATE INDEX IF NOT EXISTS idx_marketplace_channels_store ON marketplace_channels(store_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_product_mappings_channel ON marketplace_product_mappings(channel_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_channel ON marketplace_orders(channel_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_credentials_channel ON marketplace_credentials(channel_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_sync_jobs_channel_status ON marketplace_sync_jobs(channel_id, status);
```

### 3.2 Shared Types (`lib/marketplace/types.ts`)

Define the unified interface contract:

```typescript
// apps/merchant/src/lib/marketplace/types.ts

export type MarketplacePlatform = 'etsy' | 'ebay' | 'amazon';

/** Unified product record across all marketplaces */
export interface MarketProduct {
  id: string;                    // internal variant_id
  sku: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  quantity: number;
  weightG: number;
  requiresShipping: boolean;
  status: 'active' | 'draft' | 'inactive';
}

/** Unified order record across all marketplaces */
export interface MarketOrder {
  externalOrderId: string;
  platform: MarketplacePlatform;
  channelStoreId: string;
  customerEmail: string;
  items: Array<{ sku: string; title: string; qty: number; unitPriceCents: number }>;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  status: string;
  shippingAddress?: {
    name: string; line1: string; line2?: string; city: string;
    state?: string; postalCode: string; country: string; phone?: string;
  };
  createdAt: string;
}

/** Unified webhook event payload */
export interface MarketWebhookEvent {
  platform: MarketplacePlatform;
  eventType: string;       // e.g., 'order.paid', 'inventory.out_of_stock'
  resourceUrl: string;
  storeId: string;
  rawPayload: Record<string, unknown>;
}

/** Unified client interface — all platforms implement this */
export interface IMarketplaceClient {
  platform: MarketplacePlatform;
  readonly config: Record<string, unknown>;

  // Authentication
  refreshTokens(): Promise<void>;
  getAccessToken(): Promise<string>;

  // Products
  listProducts(params?: { limit?: number; cursor?: string }): Promise<{ items: MarketProduct[]; nextCursor?: string }>;
  getProduct(id: string): Promise<MarketProduct>;
  upsertProduct(product: MarketProduct): Promise<string>;  // returns external ID
  deleteProduct(externalId: string): Promise<void>;

  // Inventory
  listInventory(params?: { limit?: number }): Promise<Array<{ sku: string; quantity: number }>>;
  updateInventory(sku: string, quantity: number): Promise<void>;

  // Orders
  listOrders(params?: { from?: Date; to?: Date; limit?: number }): Promise<MarketOrder[]>;
  getOrder(externalOrderId: string): Promise<MarketOrder>;
  updateShipment(externalOrderId: string, trackingNumber: string, trackingUrl?: string): Promise<void>;

  // Health
  healthCheck(): Promise<boolean>;
}
```

### 3.3 Auth Manager (`lib/marketplace/auth-manager.ts`)

Handles token lifecycle for all platforms:

- Stores refresh tokens encrypted in `marketplace_credentials` table
- Auto-refreshes access tokens before expiry (check 5 min before)
- Implements exponential backoff on 401 responses
- Platform-specific token endpoint logic

### 3.4 Rate Limiter (`lib/marketplace/rate-limiter.ts`)

Per-platform KV-based sliding window rate limiter:

```typescript
// Simplified design
class RateLimiter {
  private kv: KVNamespace;
  
  async acquire(platform: string, key: string): Promise<boolean> {
    // Check KV for remaining quota in current window
    // Decrement on success
    // Return false if exhausted (caller retries later)
  }
}
```

Rate limits per platform:

| Platform | QPD | QPS | Strategy |
|----------|-----|-----|----------|
| Etsy | 10,000 | 10 | Sliding 24h window |
| eBay | 2,000,000 (inventory) / 100,000 (orders) | ~50 | Daily quota with burst |
| Amazon | Per-operation (varies) | Very low | Operation-specific caps |

### 3.5 Data Mapper (`lib/marketplace/data-mapper.ts`)

Normalizes between marketplace schemas and internal schema:

- `marketplaceToInternalProduct(externalProduct) → MarketProduct`
- `internalToMarketplaceProduct(internalProduct, platform) → externalPayload`
- `marketplaceToInternalOrder(externalOrder) → MarketOrder`
- Handles currency conversion, image URL normalization, field mapping

### 3.6 Delivery Criteria for Phase 0

- [ ] Migration 037 applied to production schema
- [ ] All shared modules unit-tested (auth-manager, rate-limiter, data-mapper, crypto-utils)
- [ ] `IMarketplaceClient` interface defined and documented
- [ ] OpenAPI spec updated with new route definitions
- [ ] TypeScript types compile without errors

---

## 4. Phase 1: Etsy Integration

**Duration:** 4 weeks (Weeks 3–6)  
**Dependencies:** Phase 0 complete  
**Goal:** Full bidirectional sync of products, inventory, and orders via Etsy API v3.

### 4.1 Week 3: Etsy Auth + Product Push

**Tasks:**
1. Create `apps/merchant/src/lib/marketplace/etsy.ts` — Etsy API client implementing `IMarketplaceClient`
2. Implement OAuth 2.0 Authorization Code flow:
   - Generate authorization URL with scopes (`listings_r`, `listings_w`, `orders_r`, `orders_w`)
   - Handle callback at `/oauth/marketplace/etsy/callback`
   - Exchange code for access token + refresh token
   - Store credentials encrypted in `marketplace_credentials`
3. Implement API key header injection on every request (`x-api-key: keystring:secret`)
4. Implement product push: internal products → Etsy listings
   - `POST /v3/application/shops/{shop_id}/listings` (create draft)
   - `PATCH /v3/application/shops/{shop_id}/listings/{listing_id}` (activate)
5. Create variant-to-Etsy-inventory mapping logic

**File changes:**
- `apps/merchant/src/lib/marketplace/etsy.ts` — new file (~400 lines)
- `apps/merchant/src/routes/marketplace/connect.ts` — add Etsy OAuth routes
- `apps/merchant/src/index.ts` — mount `/v1/marketplace` routes

### 4.2 Week 4: Etsy Inventory Sync + Product Pull

**Tasks:**
1. Implement inventory sync:
   - Push internal inventory → Etsy (`PUT /listings/{listing_id}/inventory`)
   - Pull Etsy inventory → internal (read from `getListingInventory`, map to variants)
2. Implement product pull: read Etsy listings and create/update internal products
3. Handle Etsy listing states: `draft` → `active` → `deactivated` → `sold_out`
4. Map Etsy property_values (variations) to internal variants table

**File changes:**
- Extend `etsy.ts` with inventory methods
- Add admin route `POST /v1/marketplace/:channelId/sync/products`

### 4.3 Week 5: Etsy Orders + Webhooks

**Tasks:**
1. Implement webhook receiver at `POST /v1/webhooks/marketplace/etsy`:
   - Verify HMAC-SHA256 signature (headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`)
   - Reject timestamps > 300 seconds old
   - Respond 200 immediately (Etsy retries failures)
2. Handle event types:
   - `order.paid` → create internal order, reserve inventory
   - `order.shipped` → update order status + tracking
   - `order.canceled` → cancel order, release reservation
   - `inventory.out_of_stock` → log warning, notify admin
3. Implement order pull as fallback: `GET /shops/{shop_id}/receipts`
4. Create mapping from Etsy receipt structure to internal orders schema

**File changes:**
- Extend `etsy.ts` with webhook handler + order methods
- Add event processing logic in route handler

### 4.4 Week 6: Testing, Admin UI, Polish

**Tasks:**
1. Write integration tests against Etsy sandbox
2. Build admin UI components in `apps/client/src/pages/marketplace/`:
   - Connect Etsy shop page (OAuth redirect button)
   - Channel status dashboard showing sync health
   - Manual sync trigger buttons
3. Add error handling: rate limit 429 → backoff, token expiry → auto-refresh
4. Update OpenAPI spec with Etsy-specific endpoints
5. Performance review: ensure KV cache invalidation on product/inventory mutations

**Delivery Criteria:**
- [ ] Etsy OAuth flow works end-to-end (connect → authorize → sync)
- [ ] Products push from internal → Etsy and pull back
- [ ] Inventory syncs bidirectionally with rate limiting
- [ ] Webhooks receive `order.paid` and create internal orders
- [ ] Shipments update on Etsy via API
- [ ] Admin UI shows channel status, sync logs, manual triggers
- [ ] All integration tests pass against sandbox

---

## 5. Phase 2: eBay Integration

**Duration:** 4 weeks (Weeks 7–10)  
**Dependencies:** Phase 1 complete (reuses auth-manager, rate-limiter, data-mapper)  
**Goal:** Full product and inventory sync with eBay; order ingestion via polling.

### 5.1 Week 7: eBay Auth + Inventory Setup

**Tasks:**
1. Create `apps/merchant/src/lib/marketplace/ebay.ts` — eBay API client implementing `IMarketplaceClient`
2. Implement dual OAuth 2.0 token flow:
   - Application token (client credentials): for public data
   - User token (Authorization Code): for sell APIs
   - Handle RuName redirect URI (eBay-specific quirk)
   - Store both tokens encrypted in `marketplace_credentials`
3. Implement marketplace header injection (`X-EBAY-C-MARKETPLACE-ID: EBAY_US`)
4. Set up inventory location concept matching internal warehouses

**File changes:**
- `apps/merchant/src/lib/marketplace/ebay.ts` — new file (~350 lines)
- Extend `connect.ts` with eBay OAuth routes

### 5.2 Week 8: eBay Product Push + Inventory Sync

**Tasks:**
1. Implement product push: internal products → eBay inventory items
   - `POST /sell/inventory/v1/inventory_item`
   - Map title, description, images, aspects
   - Handle `condition` field (NEW/USED/REFURBISHED)
2. Implement bulk inventory operations:
   - `POST /sell/inventory/v1/bulk/inventory_items` for batch creates
   - `PUT /sell/inventory/v1/inventory_item/{sku}` for updates
3. Map multi-warehouse to eBay `availabilityDistributions` (keyed by `merchantLocationKey`)
4. Implement inventory pull: read eBay items → map to internal variants

### 5.3 Week 9: eBay Orders + Fulfillment

**Tasks:**
1. Implement order polling (no robust webhooks):
   - `GET /sell/fulfillment/v1/order?filter=creationdate:[from..to]`
   - Run via scheduled cron job every 15 minutes
   - Track last-poll timestamp per channel in config_json
2. Map eBay order structure to internal orders schema
3. Implement shipment updates:
   - `PUT /sell/fulfillment/v1/order/{orderId}/status`
   - Upload tracking via eBay logistics API if available
4. Handle eBay return flow (Post-Order API v2) — basic support

### 5.4 Week 10: Testing, Admin UI, Polish

**Tasks:**
1. Integration tests against eBay sandbox
2. Admin UI: connect eBay seller account, channel status dashboard
3. Scheduled cron job for order polling (add to `scheduled` handler in `index.ts`)
4. Error handling and retry logic

**Delivery Criteria:**
- [ ] eBay OAuth flow works end-to-end
- [ ] Products push to eBay inventory with correct condition/aspects
- [ ] Inventory syncs bidirectionally, multi-warehouse mapped
- [ ] Orders polled every 15 min and created as internal orders
- [ ] Shipment tracking updates on eBay
- [ ] Admin UI shows eBay channel status

---

## 6. Phase 3: Amazon SP-API Integration

**Duration:** 6–8 weeks (Weeks 11–18)  
**Dependencies:** Phase 0 complete; Amazon developer approval in progress  
**Note:** Begin Amazon developer profile submission during Phase 1 or 2 to overlap review time.

### 6.1 Pre-requisite: Developer Onboarding (Start Week 1, runs parallel)

**Actions:**
1. Create public website with privacy policy, terms of service, business description
2. Register in Amazon Solution Provider Portal
3. Submit developer profile with:
   - Public or private developer selection
   - Roles: Product Listing, Inventory and Order Tracking, Direct-to-Consumer Shipping (Restricted)
   - Detailed use case descriptions (< 500 chars each)
   - Security controls answers (AUP/DPP compliance)
4. Prepare for restricted roles review (PII access required for orders):
   - Architecture diagram showing data flow
   - PII protection documentation
   - Incident response plan

**Timeline:** Approval typically takes 2–8 weeks depending on complexity.

### 6.2 Week 11: Amazon Auth + SigV4 Signing

**Tasks:**
1. Create `apps/merchant/src/lib/marketplace/amazon.ts` — Amazon SP-API client
2. Implement LWA (Login with Amazon) token exchange:
   - POST to `https://api.amazon.com/auth/o2/token`
   - Handle access token (1h expiry) and refresh token (permanent)
3. Implement Restricted Data Token (RDT) flow for PII operations:
   - Call Tokens API `createRestrictedDataToken` with LWA token
   - Use RDT in `x-amz-access-token` header for restricted ops
4. Implement AWS Signature V4 request signing:
   - Use Web Crypto API for HMAC-SHA256
   - Sign headers: `host`, `x-amz-date`, `x-amz-content-sha256`
   - Include required `user-agent` header

**File changes:**
- `apps/merchant/src/lib/marketplace/amazon.ts` — new file (~500 lines)
- `apps/merchant/src/lib/marketplace/crypto-utils.ts` — add HMAC-SHA256 for SigV4

### 6.3 Week 12–13: Amazon Products + Inventory

**Tasks:**
1. Implement product sync via Listings Items API:
   - `PATCH /listings/2021-08-01/items/{sellerId},{asin}`
   - Handle variation themes (size, color, etc.)
   - Map internal variants → Amazon variation child items
2. Implement inventory sync via FBA Inventory or Listings Items:
   - `GET /inventory/v2` to read current stock
   - Update quantity via listings PATCH
3. Catalog lookup: resolve internal SKU → Amazon ASIN via `GET /catalog/2022-04-01/items/{asin}`

### 6.4 Week 14–15: Amazon Orders + Reporting

**Tasks:**
1. Implement order polling (no webhooks — must poll):
   - `GET /orders/v2/orders` with time-range filters
   - Rate limit: 0.0056/sec for searchOrders → batch efficiently
   - Schedule every 30 minutes via cron
2. Map Amazon order structure to internal orders schema
3. Implement shipment confirmation:
   - `POST /orders/v2/{orderId}/shipments` (updateShipmentStatus)
4. Implement feed-based reporting for bulk operations:
   - Use Feeds API for batch inventory updates if needed

### 6.5 Week 16–18: Testing, Admin UI, Compliance Review

**Tasks:**
1. Integration tests against Amazon sandbox
2. Admin UI: connect Amazon seller account, channel dashboard
3. PII handling audit — ensure all customer data encrypted at rest
4. Performance tuning for rate-limited order polling
5. Document compliance procedures for Amazon review

**Delivery Criteria:**
- [ ] Amazon LWA + RDT auth works end-to-end
- [ ] AWS SigV4 signing produces valid requests to sandbox
- [ ] Products push to Amazon via Listings Items API
- [ ] Inventory syncs with FBA or external fulfillment
- [ ] Orders polled and created as internal orders
- [ ] Shipment updates reach Amazon
- [ ] PII handling passes security review

---

## 7. Phase 4: Unified Dashboard & Automation

**Duration:** 4 weeks (Weeks 19–22)  
**Dependencies:** All three platform integrations complete  
**Goal:** Cross-platform management, automation rules, and analytics.

### 7.1 Week 19: Multi-Channel Admin Dashboard

**Tasks:**
1. Build unified channel management page in admin panel:
   - List all connected channels (Etsy, eBay, Amazon) with status
   - Per-channel product count, inventory health, recent orders
   - Manual sync triggers per channel
2. Add "Channel" column to product list showing which channels each product is pushed to
3. Per-product channel toggle: enable/disable push to specific marketplaces

### 7.2 Week 20–21: Sync Automation & Rules Engine

**Tasks:**
1. Implement sync job queue (`marketplace_sync_jobs` table):
   - Triggered by admin action or cron schedule
   - Processes one platform at a time with rate-limit awareness
   - Logs success/failure per job
2. Build automation rules engine:
   - "When inventory drops below X on Channel A, reduce stock on Channel B"
   - "When order received from Channel C, update all channels"
   - Rules stored in new `marketplace_rules` table
3. Scheduled sync via Cloudflare Cron Triggers:
   - Inventory sync every 5 minutes
   - Order polling per platform (Etsy webhooks primary, fallback polling; eBay every 15 min; Amazon every 30 min)

### 7.3 Week 22: Analytics + Polish

**Tasks:**
1. Build analytics dashboard:
   - Sales per marketplace over time
   - Conversion rates, revenue by channel
   - Inventory health across channels
2. Error alerting: Slack/email notifications for sync failures
3. Documentation: API docs, admin user guide, troubleshooting runbook
4. Performance review and optimization

---

## 8. Dependency Graph and Timeline

```
Timeline (weeks):
W1  W2  W3  W4  W5  W6  W7  W8  W9  W10 W11 W12 W13 W14 W15 W16 W17 W18 W19 W20 W21 W22
│   │   │   │   │   │   │   │   │    │    │    │    │    │    │    │    │    │    │    │    │
├───┤   │   │   │   │   │   │   │    │    │    │    │    │    │    │    │    │    │    │    │
│  [P0] Foundation: schema, types, auth-manager, rate-limiter, data-mapper, crypto-utils     │
├───┼───────────────────────────────────────────────────────────────────────────────────────┤
│   │  [P1] Etsy Integration (4 weeks)                                                     │
│   ├── OAuth + Product Push                                                               │
│   ├── Inventory Sync + Product Pull                                                      │
│   ├── Orders + Webhooks                                                                  │
│   └── Testing + Admin UI                                                                 │
│                                                                                           │
│         [P2] eBay Integration (4 weeks)                                                   │
│         ├── Auth + Inventory Setup                                                       │
│         ├── Product Push + Inventory Sync                                                │
│         ├── Orders + Fulfillment                                                         │
│         └── Testing + Admin UI                                                           │
│                                                                                            │
│               [Amazon Onboarding]  ← starts Week 1, runs parallel to P1/P2                │
│               (Developer profile submission, security review)                              │
│                                                                                            │
│                           [P3] Amazon SP-API (6-8 weeks)                                   │
│                           ├── Auth + SigV4 Signing                                         │
│                           ├── Products + Inventory                                         │
│                           ├── Orders + Reporting                                           │
│                           └── Testing + Compliance Review                                  │
│                                                                                              │
│                                    [P4] Unified Dashboard & Automation (4 weeks)            │
│                                    ├── Multi-channel Admin Dashboard                        │
│                                    ├── Sync Automation Engine                               │
│                                    └── Analytics + Polish                                   │
```

**Total estimated duration:** 22 weeks (~5.5 months) for a single developer  
**With parallel development (2 developers):** ~14–16 weeks

---

## 9. Testing Strategy

### 9.1 Test Pyramid

```
                    ┌─────────────┐
                    │ Integration  │  ← Sandbox accounts for each platform
                    │   Tests     │     (Etsy sandbox, eBay sandbox, Amazon sandbox)
                    └──────┬──────┘
                             │
              ┌──────────────┼──────────────┐
              │   Unit Tests    │  Mocked API clients
              │  (vitest)       │  - auth-manager: token refresh cycles
              │                 │  - rate-limiter: KV quota tracking
              │                 │  - data-mapper: schema normalization
              └─────────────────┘
```

### 9.2 Test Matrix

| Test Type | Scope | Tools | Frequency |
|-----------|-------|-------|-----------|
| Unit tests | auth-manager, rate-limiter, data-mapper, crypto-utils | vitest | Every commit |
| API contract tests | Each platform client against mock server | vitest + supertest | Every commit |
| Integration tests | End-to-end with sandbox accounts | vitest + real sandbox APIs | Daily (automated) |
| E2E smoke tests | Admin UI connect flow, product push, order receipt | Playwright | Pre-deployment |

### 9.3 Sandbox Accounts Required

| Platform | Account Type | Cost |
|----------|-------------|------|
| Etsy | Developer account + test shop | Free |
| eBay | Developer account + sandbox seller user | Free |
| Amazon | Solution Provider Portal (free) + SP-API sandbox | Free (approval required) |

---

## 10. Deployment Checklist

### Pre-Deployment

- [ ] All migrations applied to production D1 database
- [ ] Environment variables configured:
  - `ETSY_API_KEY`, `ETESH_SHARED_SECRET` (per store, stored in config table, not env)
  - `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`
  - `AMAZON_LWA_APP_ID`, `AMAZON_LWA_APP_SECRET`, `AMAZON_AWS_ACCESS_KEY`, `AMAZON_AWS_SECRET_KEY`
  - `MARKETPLACE_ENCRYPTION_KEY` (from CRYPTOKEN)
- [ ] CORS updated to allow webhook callback URLs from each platform
- [ ] Rate limiting configured per platform in KV

### Post-Deployment Monitoring

- [ ] Cloudflare Logs enabled for `/v1/marketplace/*` routes
- [ ] Error tracking configured (Sentry or similar)
- [ ] Webhook delivery monitoring dashboard
- [ ] Sync job success/failure rate alerts
- [ ] Per-platform API quota usage monitoring

---

*End of roadmap.*
