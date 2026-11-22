# Feasibility Study: Integration with Etsy, eBay, and Amazon Marketplaces

**Project:** Multicom (bengal-exchange) — Headless multi-tenant commerce platform  
**Date:** 2026-11-18  
**Version:** 1.0  
**Status:** Draft for Review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Project Context](#2-project-context)
3. [Integration Architecture Overview](#3-integration-architecture-overview)
4. [Etsy API v3 Integration](#4-etsy-api-v3-integration)
5. [eBay Sell APIs Integration](#5-ebay-sell-apis-integration)
6. [Amazon SP-API Integration](#6-amazon-sp-api-integration)
7. [Comparative Analysis](#7-comparative-analysis)
8. [Recommended Implementation Phases](#8-recommended-implementation-phases)
9. [Risk Assessment](#9-risk-assessment)
10. [Conclusion and Recommendations](#10-conclusion-and-recommendations)

---

## 1. Executive Summary

This study evaluates the technical feasibility of integrating the Multicom platform with three major external marketplaces: **Etsy**, **eBay**, and **Amazon (SP-API)**. The analysis covers API capabilities, authentication models, rate limits, data mapping challenges, webhooks, onboarding complexity, and implementation effort relative to the existing architecture.

**Key findings:**

| Marketplace | Feasibility | Auth Complexity | Onboarding Effort | Rate Limits | Webhook Support |
|-------------|-------------|-----------------|-------------------|-------------|-----------------|
| **Etsy**    | High        | Moderate        | Low (~1 week)     | 10K/day, 10/s | Yes (11 events) |
| **eBay**    | High        | Moderate        | Low (~1 week)     | Up to 2M/day  | Limited         |
| **Amazon**  | Conditional | High            | Medium-High (~4-8 weeks) | Per-operation, very low | No (polling-based) |

All three integrations are technically feasible. Etsy and eBay can be implemented in the current architecture with minimal changes. Amazon SP-API requires additional infrastructure for PII handling and a more rigorous security review process.

---

## 2. Project Context

### 2.1 Current Architecture

The Multicom project is a **Cloudflare-based headless commerce platform** built on:

- **Runtime:** Cloudflare Workers + Durable Objects (SQL via SQLite)
- **Storage:** D1 (SQLite), R2 (images/files), KV (caching)
- **API Framework:** Hono with `@hono/zod-openapi` (OpenAPI/Swagger)
- **Authentication:** Auth0 (OAuth 2.0 + JWT), API keys, customer auth
- **Payment:** Stripe Checkout + webhooks
- **Data Model:** Products → Variants (SKUs) → Inventory → Carts → Orders

### 2.2 Existing Data Model Relevance

The existing schema already supports the core entities needed for marketplace integration:

| Entity | Current Schema | Integration Need |
|--------|---------------|------------------|
| Products | `products` table | Sync product titles, descriptions, images |
| Variants/SKUs | `variants` table with unique SKU constraint | Map to marketplace SKUs; add channel-specific fields |
| Inventory | `inventory` + `warehouse_inventory` | Bidirectional sync with marketplace stock levels |
| Orders | `orders` + `order_items` | Ingest external orders; push shipment updates |
| Customers | `customers` table | Store marketplace buyer data (PII considerations for Amazon) |

### 2.3 Required Schema Extensions

All three integrations require additional columns/tables:

```sql
-- New table: Marketplace channel registry
CREATE TABLE marketplace_channels (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'amazon')),
    store_id TEXT NOT NULL,
    external_shop_id TEXT,        -- Etsy shop_id, eBay userId, Amazon SellerId
    config TEXT NOT NULL DEFAULT '{}',  -- JSON: credentials, settings
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New table: Channel-specific product mapping
CREATE TABLE marketplace_product_mappings (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
    variant_id TEXT REFERENCES variants(id),
    external_listing_id TEXT NOT NULL,  -- Etsy listing_id, eBay itemId, Amazon ASIN/SKU
    external_sku TEXT,                  -- Marketplace-assigned SKU
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
    last_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(channel_id, external_listing_id)
);

-- New table: External orders ingested from marketplaces
CREATE TABLE marketplace_orders (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
    internal_order_id TEXT REFERENCES orders(id),
    external_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_payload TEXT NOT NULL,          -- JSON snapshot of the original payload
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New table: API credential store (encrypted)
CREATE TABLE marketplace_credentials (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
    credential_type TEXT NOT NULL CHECK (credential_type IN ('api_key', 'oauth_token', 'refresh_token')),
    encrypted_value TEXT NOT NULL,      -- AES-256-CBC encrypted
    metadata TEXT DEFAULT '{}',         -- e.g., expiry timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New column on variants: marketplace sync flags
-- ALTER TABLE variants ADD COLUMN sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending', 'error'));
```

---

## 3. Integration Architecture Overview

### 3.1 High-Level Design

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   Etsy API  │    │   eBay Sell APIs │    │  Amazon SP-API   │
│   (REST)    │    │   (REST)         │    │  (REST + SigV4)  │
└──────┬──────┘    └──────┬───────────┘    └───────┬──────────┘
       │                  │                         │
       ▼                  ▼                         ▼
┌──────────────────────────────────────────────────────────────┐
│              Integration Layer (Cloudflare Worker)            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Channel Router: routes requests by platform             │ │
│  │  Auth Manager: OAuth/token lifecycle per channel         │ │
│  │  Rate Limiter: per-platform quota enforcement            │ │
│  │  Webhook Processor: receives, verifies, queues events    │ │
│  │  Data Mapper: normalizes marketplace → internal schema   │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────┬───────────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                    ▼
┌─────────────┐   ┌──────────────┐   ┌────────────────┐
│  Durable    │   │   R2 Bucket  │   │     KV Cache   │
│  Object (DB)│   │  (images,    │   │  (token cache, │
│  (SQLite)   │   │   payloads)  │   │  rate limits)  │
└─────────────┘   └──────────────┘   └────────────────┘
```

### 3.2 Integration Patterns

| Pattern | Etsy | eBay | Amazon SP-API |
|---------|------|------|---------------|
| **Data Sync Direction** | Push (→Etsy) + Pull (←Etsy orders) | Bidirectional | Primarily Pull (orders, inventory) |
| **Inventory Strategy** | Override mode: internal → Etsy | Per-location: multi-warehouse support | External fulfillment or FBA sync |
| **Order Flow** | Webhook `order.paid` → create order | Polling + notifications | Polling (`searchOrders`) |
| **Shipment Update** | API call to mark shipped | Fulfillment API call | ConfirmShipment API call |
| **Webhook Reliability** | Signed POST, retries (1h+10h) | Limited (Notifications API) | None — polling only |

---

## 4. Etsy API v3 Integration

### 4.1 Overview

Etsy's Open API v3 is the current standard (v2 deprecated). It uses a RESTful design with OAuth 2.0 authentication and provides comprehensive endpoints for listings, inventory, orders, and shops.

**Base URL:** `https://api.etsy.com/v3/application/`

### 4.2 Authentication

Etsy requires **two credentials** on every request:

1. **API Key** (header: `x-api-key`) — Application-level authentication
   - Format: `keystring:shared_secret`
   - Required for all v3 endpoints regardless of auth level

2. **OAuth 2.0 Access Token** (header: `Authorization: Bearer <token>`)
   - Authorization Code Grant flow
   - Access token expires in 1 hour
   - Refresh token for obtaining new access tokens
   - Scopes are endpoint-level (not field-level)

**Scopes required:**
| Scope | Purpose |
|-------|---------|
| `listings_r` | Read listings and inventory |
| `listings_w` | Write/update listings and inventory |
| `orders_r` | Read orders |
| `orders_w` | Update order status (ship/cancel) |
| `shops_r` | Read shop information |

**Implementation complexity:** Moderate. The OAuth 2.0 flow is standard but requires storing refresh tokens securely and handling token expiration.

### 4.3 Key Endpoints for Integration

#### Products / Listings

| Operation | Endpoint | Method | Scope Required |
|-----------|----------|--------|----------------|
| Create listing | `/shops/{shop_id}/listings` | POST | `listings_w` |
| Update listing | `/shops/{shop_id}/listings/{listing_id}` | PATCH | `listings_w` |
| Get listing | `/listings/{listing_id}` | GET | `listings_r` |
| Delete listing | `/listings/{listing_id}` | DELETE | `listings_w` |
| Get inventory | `/listings/{listing_id}/inventory` | GET | `listings_r` |
| Update inventory | `/shops/{shop_id}/listings/{listing_id}/inventory` | PUT | `listings_w` |

**Data mapping notes:**
- Etsy uses `listing_id` (not SKU) as the primary listing identifier
- Inventory is structured as `products` within a listing, each with `sku`, `offerings`, and `property_values` (variations)
- Listings have states: `draft`, `active`, `deactivated`, `sold_out`, `expired`
- Multi-variation listings map naturally to the existing variants table

#### Orders

| Operation | Endpoint | Method | Scope Required |
|-----------|----------|--------|----------------|
| Get receipt | `/shops/{shop_id}/receipts/{receipt_id}` | GET | `orders_r` |
| List receipts | `/shops/{shop_id}/receipts` | GET | `orders_r` |
| Update receipt | `/shops/{shop_id}/receipts/{receipt_id}` | PATCH | `orders_w` |

### 4.4 Webhooks (Real-time Notifications)

Etsy provides robust webhook support across three domains:

**Order events:**
- `order.paid` — Order receives payment
- `order.canceled` — Seller cancels order
- `order.shipped` — Shipping info created
- `order.delivered` — Order marked delivered

**Listing events:**
- `listing.created`, `listing.updated`, `listing.deleted`

**Inventory events:**
- `inventory.created`, `inventory.updated`, `inventory.deleted`
- `inventory.out_of_stock` — Quantity reaches 0

**Webhook delivery details:**
| Property | Value |
|----------|-------|
| Delivery method | HTTP POST to callback URL |
| Payload format | JSON with `event_type`, `resource_url`, `shop_id` |
| Signature | HMAC-SHA256 (headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`) |
| Retry policy | Immediate, 5s, 5min, 30min, 2h, 5h, 10h, 10h |
| Configuration | Via Etsy Developer Portal (no subscription API documented) |

**Implementation note:** Payloads contain only IDs and a `resource_url` — your app must make a follow-up request to fetch the actual data. This consumes API quota.

### 4.5 Rate Limits

| Limit | Value |
|-------|-------|
| Queries Per Day (QPD) | 10,000 per 24-hour sliding window |
| Queries Per Second (QPS) | 10 requests/second |
| Burst allowance | Up to 50 requests in a single second |

The sliding window uses progressive buckets over 24 hours — oldest bucket exits as new ones enter, immediately freeing quota.

### 4.6 Feasibility Assessment: Etsy

| Criteria | Rating | Notes |
|----------|--------|-------|
| API quality | Excellent | Well-documented OpenAPI v3 spec |
| Authentication | Moderate | Standard OAuth 2.0 + API key combo |
| Rate limits | Good | 10K/day sufficient for most use cases |
| Webhooks | Excellent | Real-time, signed, reliable retries |
| Data model fit | High | Listings → Products, Inventory → Variants |
| Onboarding effort | Low | Developer portal registration, ~1 day setup |

**Verdict: HIGHLY FEASIBLE — Recommended as the first integration.**

---

## 5. eBay Sell APIs Integration

### 5.1 Overview

eBay offers a modern REST API surface under the `sell` namespace, with both application-level and user-level tokens. There is also a legacy XML-based Trading API still supported but not recommended for new integrations.

**Base URLs:**
- Inventory: `https://api.ebay.com/sell/inventory/v1`
- Fulfillment: `https://api.ebay.com/sell/fulfillment/v1`
- Identity: `https://api.ebay.com/identity/v1/oauth2/token`

### 5.2 Authentication

eBay uses OAuth 2.0 with **two distinct token types**:

1. **Application Token** (Client Credentials Grant) — identifies the application only
   - Used for public data and some read operations
   - Expires in 2 hours

2. **User Token** (Authorization Code Flow) — identifies a seller
   - Required for every `sell` endpoint (inventory, orders, fulfillment)
   - Access token expires in 2 hours
   - Refresh token valid for ~18 months

**Key configuration detail:** eBay uses `RuName` (a registered redirect URI alias) instead of an actual URL in the OAuth flow. This is a common implementation pitfall.

**OAuth scopes required:**
| Scope | Purpose |
|-------|---------|
| `https://api.ebay.com/oauth/api_scope/sell.inventory` | Inventory CRUD |
| `https://api.ebay.com/oauth/api_scope/sell.fulfillment` | Orders and shipping |
| `https://api.ebay.com/oauth/api_scope/sell.account` | Account info |

### 5.3 Key Endpoints for Integration

#### Inventory / Products

| Operation | Endpoint | Method | Auth Required |
|-----------|----------|--------|---------------|
| List inventory items | `/sell/inventory/v1/inventory_item` | GET | User token |
| Get inventory item | `/sell/inventory/v1/inventory_item/{sku}` | GET | User token |
| Create inventory item | `/sell/inventory/v1/inventory_item` | POST | User token |
| Update inventory item | `/sell/inventory/v1/inventory_item/{sku}` | PUT | User token |
| Delete inventory item | `/sell/inventory/v1/inventory_item/{sku}` | DELETE | User token |
| Bulk create/replace | `/sell/inventory/v1/bulk/inventory_items` | POST | User token |

**Data mapping notes:**
- eBay has no enforced shared catalogue — listings are seller-authored objects
- Inventory items have `condition` (NEW, USED, REFURBISHED) and `product` with title/description/aspects
- Multi-warehouse support via `availabilityDistributions` keyed by `merchantLocationKey`
- No reserved quantity concept exposed in the API

#### Orders / Fulfillment

| Operation | Endpoint | Method | Auth Required |
|-----------|----------|--------|---------------|
| List orders | `/sell/fulfillment/v1/order` | GET | User token + `.readonly` scope |
| Get order detail | `/sell/fulfillment/v1/order/{orderId}` | GET | User token |
| Update order status | `/sell/fulfillment/v1/order/{orderId}/status` | PUT | User token |

**Order filtering:** Supports bracket range syntax: `creationdate:[2026-09-01T00:00:00.000Z..]`

#### Marketplaces

eBay operates multiple marketplaces (EBAY_US, EBAY_GB, EBAY_DE, etc.). Every call requires the `X-EBAY-C-MARKETPLACE-ID` header.

### 5.4 Notifications

eBay's Notification API (`https://api.ebay.com/sell/notification/v1`) provides limited webhook-like capabilities:
- Event-driven notifications for orders, inventory changes
- Requires separate subscription setup in the eBay Developer Portal
- Not as robust or comprehensive as Etsy's webhook system

### 5.5 Rate Limits

| API Category | Default Limit | Notes |
|-------------|---------------|-------|
| Inventory API | **2,000,000 calls/day** | Very generous |
| Fulfillment (Orders) | **100,000 calls/day** | Per order method |
| Account API | 25,000 calls/day | — |
| Finances API | 15,000 calls/day | — |

Limits are at the application level. Higher limits available via Application Growth Check (free process).

### 5.6 Feasibility Assessment: eBay

| Criteria | Rating | Notes |
|----------|--------|-------|
| API quality | Good | Well-structured REST, good SDKs available |
| Authentication | Moderate | Dual token types; RuName quirk is a pitfall |
| Rate limits | Excellent | 2M/day for inventory, 100K/day for orders |
| Webhooks | Limited | Notification API exists but less mature |
| Data model fit | Good | Inventory items map well to variants |
| Onboarding effort | Low | Developer portal registration, ~1 day setup |

**Verdict: HIGHLY FEASIBLE — Recommended as the second integration.**

---

## 6. Amazon SP-API Integration

### 6.1 Overview

Amazon's Selling Partner API (SP-API) is a comprehensive REST API for sellers and vendors to manage their Amazon business operations. It consists of multiple API families covering orders, inventory, listings, feeds, reports, notifications, and more.

**Base URL pattern:** `https://sellingpartnerapi-{region}.amazon.com`

### 6.2 Authentication — The Biggest Hurdle

Amazon SP-API authentication is the most complex among the three platforms:

1. **Login with Amazon (LWA)** — OAuth 2.0-like service
   - Access token expires in 1 hour
   - Refresh tokens do not expire
   - Endpoint: `https://api.amazon.com/auth/o2/token`

2. **Restricted Data Tokens (RDTs)** — Enhanced security for PII operations
   - Required instead of LWA tokens for restricted operations
   - Obtained via the Tokens API `createRestrictedDataToken` call
   - Specific to restricted operations; cannot be reused for standard calls

3. **AWS Signature Version 4** — All requests must be cryptographically signed
   - Uses AWS credentials (Access Key ID + Secret Access Key)
   - Requires precise date/time headers (`x-amz-date`)
   - Includes `user-agent` header in specific format

**Headers required on every request:**
```
host: sellingpartnerapi-na.amazon.com
x-amz-access-token: Atza|IQEBLjAsAhRm...  (or RDT for restricted ops)
x-amz-date: 20190430T123600Z
user-agent: MySellingTool/2.0 (Language=TypeScript/1.0)
```

### 6.3 Developer Onboarding — Significant Barrier

Amazon requires a multi-stage review process before API access is granted:

**Standard Review (non-restricted roles):**
- Business review: evaluates functionality, AUP compliance, security measures
- Duration: **1–2 weeks**
- Requires a public website describing the application

**Restricted Roles Review (PII access — required for orders/shipping):**
- Phase 1: Business verification + developer profile assessment
- Phase 2: Data security assessment (PII protection controls)
- Phase 3: Technical review with Amazon Solutions Architect (screen-sharing demo)
- Duration: **4–8 weeks** total

**Required documentation:**
- Public website with business description, privacy policy, terms of service
- Detailed use case descriptions (max 500 characters per field)
- Security architecture documentation
- Compliance with Acceptable Use Policy and Data Protection Policy
- Incident response procedures

### 6.4 Key Endpoints for Integration

#### Listings / Products

| Operation | API Family | Endpoint | Role Required |
|-----------|-----------|----------|---------------|
| Get item details | Catalog Items | `GET /catalog/2022-04-01/items/{asin}` | Product Listing |
| Search catalog | Catalog Items | `POST /catalog/2022-04-01/items` | Product Listing |
| Update listing | Listings Items | `PATCH /listings/2021-08-01/items/{sellerId,{asin}` | Product Listing |

#### Inventory

| Operation | API Family | Endpoint | Role Required |
|-----------|-----------|----------|---------------|
| List inventory units | FBA Inventory | `GET /inventory/v2` | Inventory and Order Tracking |
| Update quantity | Listings Items | (via PATCH listings) | Product Listing |

#### Orders

| Operation | API Family | Endpoint | Role Required | Restricted? |
|-----------|-----------|----------|---------------|-------------|
| Search orders | Orders v2026-01-01 | `GET /orders/v2/orders` | Inventory and Order Tracking | No (metadata only) |
| Get order | Orders v2026-01-01 | `GET /orders/v2/orders/{orderId}` | Direct-to-Consumer Shipping (Restricted) | **Yes — PII** |

### 6.5 Rate Limits — Very Restrictive

Amazon SP-API rate limits are per-operation and often extremely low:

| Operation | Rate Limit | Burst |
|-----------|-----------|-------|
| `searchOrders` | 0.0056 requests/second | 20 |
| `getOrder` | 0.5 requests/second | 30 |
| `updateShipmentStatus` | 5 requests/second | 15 |

**Critical implication:** The `searchOrders` rate of 0.0056/sec means approximately **480 requests per day** for order polling. This requires careful batch design and caching.

### 6.6 No Webhook Support

Amazon SP-API does **not** provide real-time webhooks for orders or inventory changes. Applications must:
- Poll `searchOrders` with time-range filters
- Use the Notifications API (separate, limited scope)
- Accept eventual consistency delays

### 6.7 Feasibility Assessment: Amazon SP-API

| Criteria | Rating | Notes |
|----------|--------|-------|
| API quality | Good | Comprehensive but complex docs |
| Authentication | **Very High** | LWA + RDT + SigV4 signing |
| Rate limits | **Poor** | 0.0056/sec for searchOrders is extremely restrictive |
| Webhooks | **None** | Polling only — no real-time order notifications |
| Data model fit | Moderate | Amazon-centric (ASIN-based); many fields not applicable |
| Onboarding effort | **Very High** | 4–8 weeks review, extensive documentation required |
| PII handling | **High risk** | Requires architecture review, incident response plan |

**Verdict: CONDITIONALLY FEASIBLE — Requires significant upfront investment. Not recommended as a first integration.**

---

## 7. Comparative Analysis

### 7.1 Feature Comparison Matrix

| Feature | Etsy | eBay | Amazon SP-API |
|---------|------|------|---------------|
| **REST API** | Yes (v3) | Yes (modern REST) | Yes (REST + SigV4) |
| **Auth method** | OAuth 2.0 + API key | OAuth 2.0 (dual tokens) | LWA + RDT + AWS SigV4 |
| **Token expiry** | 1 hour (access) | 2 hours (both) | 1 hour (LWA), permanent (refresh) |
| **Rate limit — Orders** | 10K/day | 100K/day | ~480/day (searchOrders) |
| **Rate limit — Inventory** | 10K/day | 2M/day | Per-operation (varies) |
| **Webhooks** | Yes (11 events, signed) | Limited (Notifications API) | No (polling only) |
| **Sandbox environment** | Yes | Yes | Yes |
| **SDK availability** | Community (JS/TS, Python) | Official (Python SDK) | Official (Python, Java, .NET) — no TypeScript SDK |
| **Multi-warehouse** | No (single location) | Yes (`availabilityDistributions`) | FBA network or external fulfillment |
| **Order status update** | PATCH receipt | Fulfillment API | ConfirmShipment API |
| **Bulk operations** | Per-listing only | Bulk inventory endpoints | Feeds API (CSV/bulk) |
| **Onboarding time** | ~1 day | ~1 day | 4–8 weeks |
| **Ongoing compliance** | Minimal | Application Growth Check (optional) | Annual security review, AUP/DPP compliance |

### 7.2 Data Mapping Complexity

```
Internal Model              Etsy          eBay            Amazon SP-API
─────────────────────────────────────────────────────────────────────────────
Product                   Listing        Inventory Item   ASIN-based
SKU                      Product SKU    Inventory SKU    Seller SKU / UPC
Variant                  Offering       Variant (no)     Variation theme
Inventory                Quantity       shipToLocation   inventoryUnits
Order                    Receipt        Order            Order (v2)
Customer                 Shop owner     Buyer username   PII (restricted)
Shipment Tracking        Yes            Yes              Yes (restricted)
```

**Key challenges:**
- **Etsy:** Listings bundle multiple products; need to flatten to internal variants table
- **eBay:** No enforced catalogue — each listing is seller-authored; no direct ASIN mapping
- **Amazon:** ASIN-centric model requires reverse lookup from SKU → ASIN; many Amazon-specific fields (condition, offer_listing_id) don't map cleanly

### 7.3 Implementation Effort Estimate

| Component | Etsy | eBay | Amazon SP-API |
|-----------|------|------|---------------|
| Auth integration | 2 days | 3 days | 5 days |
| Product sync | 3 days | 3 days | 4 days |
| Inventory sync | 2 days | 2 days | 3 days |
| Order ingestion | 2 days | 2 days | 4 days |
| Shipment updates | 1 day | 1 day | 2 days |
| Webhook/notifications | 1 day | 1 day | N/A (polling) |
| Admin UI integration | 3 days | 3 days | 3 days |
| Testing + QA | 3 days | 3 days | 5 days |
| **Total** | **~17 days** | **~18 days** | **~26+ days** |

*Note: These estimates assume a single developer familiar with the existing codebase.*

---

## 8. Recommended Implementation Phases

### Phase 1: Etsy Integration (Weeks 1–4)

**Rationale:** Best API quality, lowest onboarding friction, excellent webhook support.

**Deliverables:**
- `apps/merchant/src/lib/marketplace/etsy.ts` — Etsy API client module
- `apps/merchant/src/routes/marketplace/etsy.ts` — Route handlers
- OAuth 2.0 token management (stored in `marketplace_credentials`)
- Product push: internal products → Etsy listings
- Inventory sync: real-time bidirectional with rate limiting
- Order ingestion via webhooks (`order.paid`, `order.shipped`)
- Admin UI: connect/disconnect Etsy shop, view sync status

### Phase 2: eBay Integration (Weeks 5–8)

**Rationale:** Similar architecture to Etsy but with dual token types and RuName quirk.

**Deliverables:**
- `apps/merchant/src/lib/marketplace/ebay.ts` — eBay API client module
- Application token + user token lifecycle management
- Product push: internal products → eBay inventory items
- Inventory sync with multi-warehouse support (`availabilityDistributions`)
- Order ingestion via polling (Notifications API limited)
- Admin UI: connect/disconnect eBay seller account

### Phase 3: Amazon SP-API (Weeks 9–16+)

**Rationale:** Requires significant upfront investment in onboarding review. Can be developed in parallel after initial approval submission.

**Prerequisites:**
- Public website with privacy policy and terms of service
- Security architecture documentation prepared
- AWS credentials provisioned for SigV4 signing

**Deliverables:**
- `apps/merchant/src/lib/marketplace/amazon.ts` — Amazon SP-API client
- LWA + RDT token management (complex dual-token flow)
- AWS Signature V4 request signing utility
- Product sync via Listings Items API
- Inventory sync via FBA Inventory API
- Order polling with aggressive caching (rate limit: 0.0056/sec)
- Shipment updates via ConfirmShipment API

### Phase 4: Unified Dashboard & Automation (Weeks 17+)

**Deliverables:**
- Multi-channel product dashboard in admin panel
- Cross-channel inventory allocation rules
- Automated price synchronization across channels
- Analytics: sales per marketplace, conversion rates
- Error handling and retry queue for failed syncs

---

## 9. Risk Assessment

### 9.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Amazon onboarding rejection | Medium | High | Submit early; prepare thorough documentation; engage Amazon support proactively |
| Rate limit exhaustion (Amazon) | High | High | Implement aggressive caching; batch order polling; use time-range filters efficiently |
| Token refresh failures | Low | Medium | Store refresh tokens encrypted in R2 or KV; implement automatic retry on 401 |
| Data sync conflicts (race conditions) | Medium | Medium | Use optimistic locking; last-write-wins with timestamp tracking |
| Webhook delivery failures (Etsy) | Low | Low | Etsy retries up to 10 hours; implement idempotent handlers |

### 9.2 Business Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Platform policy changes | Medium | High | Subscribe to developer newsletters; monitor changelogs |
| Amazon PII compliance breach | Low | Critical | Encrypt all PII at rest; restrict access via IAM; annual security audit |
| Multi-channel order conflicts | Medium | Medium | Implement order deduplication by external ID; flag manual review |
| Customer data fragmentation | High | Medium | Maintain single customer record; map marketplace buyers to internal accounts |

### 9.3 Cost Considerations

| Platform | Direct Cost | Indirect Cost |
|----------|------------|---------------|
| Etsy | Free API access | Developer time (~17 days) |
| eBay | Free API access | Developer time (~18 days) |
| Amazon SP-API | Free for most APIs; referral fees on sales | Developer time (~26+ days), legal/security review costs |

---

## 10. Conclusion and Recommendations

### 10.1 Overall Feasibility

**All three integrations are technically feasible within the existing Multicom architecture.** The platform's Cloudflare Workers runtime, Durable Objects for SQL persistence, and Hono-based API framework provide a solid foundation. The main challenges are:

1. **Amazon SP-API onboarding complexity** — requires 4–8 weeks of review before any code can be tested against production
2. **Amazon rate limits** — extremely restrictive for order polling (0.0056/sec)
3. **Data model normalization** — each platform has a different product/inventory abstraction

### 10.2 Recommendations

1. **Start with Etsy.** It offers the best developer experience, robust webhooks, and straightforward OAuth flow. The implementation can be completed in ~4 weeks.

2. **Follow with eBay.** Similar architecture to Etsy but with more generous rate limits (2M/day for inventory). Can be developed in parallel after Phase 1 stabilizes.

3. **Begin Amazon SP-API onboarding immediately** — submit the developer profile and security documentation early since the review takes 4–8 weeks. Development can proceed in sandbox mode once approved.

4. **Build a unified marketplace abstraction layer.** Define interfaces (`IMarketplaceClient`, `IProductSync`, `IOrderIngestion`) that all three platforms implement, keeping the admin UI and core logic platform-agnostic.

5. **Implement rate limiting at the integration layer.** Use Cloudflare KV for per-platform quota tracking with sliding windows.

6. **Store all credentials encrypted.** Use AES-256-CBC encryption (similar to the existing `ai.json.enc` pattern) for OAuth tokens and API keys. Store in R2 or a dedicated D1 table.

### 10.3 Suggested File Structure

```
apps/merchant/src/
├── lib/
│   ├── marketplace/
│   │   ├── index.ts              # Unified marketplace interface
│   │   ├── types.ts              # Shared type definitions
│   │   ├── auth-manager.ts       # Token lifecycle management
│   │   ├── rate-limiter.ts       # Per-platform rate limiting
│   │   ├── data-mapper.ts        # Normalizes platform → internal schema
│   │   ├── etsy.ts               # Etsy API client + webhooks
│   │   ├── ebay.ts               # eBay API client
│   │   └── amazon.ts             # Amazon SP-API client
├── routes/
│   └── marketplace/
│       ├── connect.ts            # OAuth authorization flows
│       ├── webhook.ts            # Unified webhook receiver
│       ├── sync-products.ts      # Trigger product sync
│       └── sync-inventory.ts     # Trigger inventory sync
```

---

*End of document.*
