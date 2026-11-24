# Phase 3 Development Plan: Amazon SP-API Integration

**Project:** Multicom (bengal-exchange) — Headless commerce platform
**Date:** 2026-11-19
**Status:** Implemented (2026-11-22). Setup: `docs/run-instructions.md` §4.6.

> **Changes from this plan:** no AWS SigV4 (Amazon removed it in Oct 2023, so there are no AWS keys); listings use the Listings Items API (PATCH for existing listings, `LISTING_OFFER_ONLY` when the barcode matches a catalog ASIN) instead of the Feeds API; order PII uses a Restricted Data Token and falls back to importing without PII. Code: `src/lib/marketplace/amazon.ts`, `amazon-oauth.ts`; tests: `tests/amazon.test.ts`.
**Dependencies:** Phase 0 foundation complete; Phase 1 Etsy ~75%; Phase 2 eBay core API ~40%

---

## Overview

Phase 3 implements Amazon Selling Partner API (SP-API) integration. This is the most complex of the three platforms due to:

1. **Three-layer authentication** — LWA tokens + Restricted Data Tokens + AWS Signature V4 signing on every request
2. **Developer onboarding barrier** — 4–8 week review process for restricted roles (PII access required for orders/shipping)
3. **Extremely restrictive rate limits** — `searchOrders` at 0.0056/sec (~480/day); requires aggressive batching and caching
4. **No webhooks** — polling only; must use time-range filters efficiently
5. **ASIN-centric data model** — products are tied to Amazon's catalog (ASIN), requiring SKU→ASIN reverse lookups

The existing shared library (`types.ts`, `auth-manager.ts`, `rate-limiter.ts`, `data-mapper.ts`, `crypto-utils.ts`) and patterns from Etsy/eBay implementations provide a solid foundation. The key additions are AWS SigV4 signing, RDT token management, and batched polling strategies.

---

## Architecture Decisions

### File Structure

```
apps/merchant/src/lib/marketplace/amazon.ts    ← Amazon SP-API client (~500-600 lines)
apps/merchant/src/routes/marketplace/connect.ts  ← Add Amazon OAuth routes (extend existing)
apps/merchant/src/lib/marketplace/crypto-utils.ts ← Add HMAC-SHA256 for SigV4 (extend existing)
```

No new files needed beyond `amazon.ts`. The shared library is reused.

### Authentication Architecture

Amazon SP-API requires three authentication layers:

```
1. LWA (Login with Amazon) — OAuth 2.0-like service
   POST https://api.amazon.com/auth/o2/token
   Grant type: refresh_token or client_credentials
   Access token: 1-hour expiry
   Refresh token: permanent

2. RDT (Restricted Data Token) — PII operations only
   POST https://sellingpartnerapi-{region}.amazon.com/2021-06-30/authorizationTokens
   Uses LWA token in Authorization header
   Specific to each restricted operation; cannot be reused across operations

3. AWS Signature V4 — All SP-API requests must be cryptographically signed
   Headers: host, x-amz-date, x-amz-content-sha256, Authorization (SigV4)
   Uses AWS credentials (Access Key ID + Secret Access Key)
   Requires precise date/time formatting
```

**Storage:**
- `oauth_token` → LWA access token (encrypted in DB)
- `refresh_token` → LWA refresh token (encrypted in DB, permanent)
- `api_key` → AWS Access Key ID (encrypted in DB)
- `secret_key` → AWS Secret Access Key (encrypted in DB)
- RDTs are obtained on-demand per restricted operation (not stored)

### SigV4 Signing Utility

A new helper function in `crypto-utils.ts`:

```typescript
/**
 * Generate AWS Signature V4 for an SP-API request.
 * Returns the Authorization header value and x-amz-content-sha256 hash.
 */
async function signRequestV4(
  method: string,
  host: string,
  pathname: string,
  searchParams: URLSearchParams,
  awsCredentials: { accessKeyId: string; secretAccessKey: string; region: string },
  payloadHash: string,
): Promise<{ authorization: string; contentSha256: string }>
```

This utility will be called by `AmazonClient.fetchWithSigV4()` which wraps all HTTP calls.

---

## Amazon SP-API Endpoint Mapping

### Products / Listings

| Operation | API Family | Endpoint | Role Required | SigV4 |
|-----------|-----------|----------|---------------|-------|
| Get item details | Catalog Items | `GET /catalog/2022-04-01/items/{asin}` | Product Listing | Yes |
| Search catalog | Catalog Items | `POST /catalog/2022-04-01/items` | Product Listing | Yes |
| Update listing | Listings Items | `PATCH /listings/2021-08-01/items/{sellerId},{asin}` | Product Listing | Yes |
| Create listing | Listings Items | `PUT /listings/2021-08-01/items/{sellerId},{asin}` | Product Listing | Yes |

### Inventory

| Operation | API Family | Endpoint | Role Required | SigV4 |
|-----------|-----------|----------|---------------|-------|
| List inventory units | FBA Inventory | `GET /inventory/v2` | Inventory and Order Tracking | Yes |
| Update quantity | Listings Items | (via PATCH listings) | Product Listing | Yes |

### Orders

| Operation | API Family | Endpoint | Role Required | Restricted? | SigV4 |
|-----------|-----------|----------|---------------|-------------|-------|
| Search orders | Orders v2021-01-01 | `GET /orders/v2/orders` | Inventory and Order Tracking | No (metadata) | Yes |
| Get order | Orders v2021-01-01 | `GET /orders/v2/orders/{orderId}` | Direct-to-Consumer Shipping | **Yes — PII** | Yes + RDT |

### Fulfillment / Shipment

| Operation | API Family | Endpoint | Role Required | Restricted? | SigV4 |
|-----------|-----------|----------|---------------|-------------|-------|
| Confirm shipment | Orders v2021-01-01 | `POST /orders/v2/{orderId}/shipments` | Direct-to-Consumer Shipping | **Yes — PII** | Yes + RDT |

### Notifications (Limited)

Amazon provides a Notifications API for specific event types, but it is limited in scope and not reliable for real-time order processing. Primary order ingestion must use polling.

---

## Implementation Tasks

### Week 1: Amazon Auth + SigV4 Signing

**Task 3.1 — Create `AmazonClient` class** (~150 lines)
- Implement `IMarketplaceClient` interface
- Constructor accepts config, token getter, rate limiter (same pattern as `EtsyClient`/`EbayClient`)
- Add AWS region configuration (`NA`, `EU`, `FEA`)
- Implement `getAccessToken()` with LWA token refresh before expiry
- Implement `fetchWithSigV4()` — wraps fetch with SigV4 signing

**Task 3.2 — OAuth URL generation for Amazon** (~50 lines)
- Extend `connect.ts` `generateAuthUrl()` switch case for `'amazon'`
- Construct LWA authorization URL: `https://www.amazon.com/ap/oa?client_id=...&response_type=code&scope=...&state=...`
- Scopes: `calls:2021-03-01`, `inventory:2021-03-01`, `orders:2021-01-01`, `notifications:2020-10-01`

**Task 3.3 — LWA token exchange for Amazon** (~100 lines)
- Extend `connect.ts` `exchangeCodeForTokens()` switch case for `'amazon'`
- POST to `https://api.amazon.com/auth/o2/token` with client credentials + auth code
- Store LWA access token, refresh token, AWS access key, and secret key in `marketplace_credentials`
- Handle LWA token expiry (1 hour) with automatic refresh

**Task 3.4 — AWS Signature V4 utility** (~100 lines)
- Add `signRequestV4()` to `crypto-utils.ts`
- Generate canonical request, string-to-sign, signature
- Return Authorization header and x-amz-content-sha256 hash
- Test against Amazon sandbox with known test vectors

---

### Week 2: Restricted Data Tokens + Product Sync

**Task 3.5 — RDT token management** (~80 lines)
- Implement `getRestrictedToken()` method on `AmazonClient`
- Call Tokens API `createRestrictedDataToken` with LWA token and scope
- Cache RDT per restricted operation (not reusable across operations)
- Auto-refresh RDT when expired

**Task 3.6 — Product sync via Listings Items API** (~100 lines)
- `upsertProduct()` → `PUT /listings/2021-08-01/items/{sellerId},{asin}`
- Map internal product fields to Amazon listing structure
- Handle variation themes (size, color, etc.) — map internal variants → Amazon variation child items
- Catalog lookup: resolve internal SKU → Amazon ASIN via `GET /catalog/2022-04-01/items/{asin}` or search
- Handle Amazon-specific fields: condition, offer_listing_id, price, quantity

**Task 3.7 — Product pull** (~50 lines)
- `listProducts()` → FBA Inventory API `GET /inventory/v2` or Listings Items API
- Map Amazon product structure to internal variants table
- Handle ASIN-based model: reverse lookup from SKU → ASIN

---

### Week 3: Inventory Sync + Order Polling

**Task 3.8 — Inventory sync via FBA** (~80 lines)
- `listInventory()` → `GET /inventory/v2` to read current stock levels
- `updateInventory()` → Update quantity via Listings Items PATCH
- Handle FBA vs MFN (Merchant Fulfillment Network) distinction
- Map Amazon inventoryUnits structure to internal variants

**Task 3.9 — Order polling with aggressive batching** (~100 lines)
- `listOrders()` → `GET /orders/v2/orders?created_after=...&created_before=...`
- Rate limit: 0.0056/sec for searchOrders → batch efficiently with time-range filters
- Schedule every 30 minutes via cron (extend existing scheduled handler in `index.ts`)
- Deduplicate orders by `amazon_order_id` using `marketplace_orders` table
- Track last-poll timestamp per channel in `config_json.last_poll_at`

**Task 3.10 — Order mapping** (~50 lines)
- Map Amazon order structure to `MarketOrder`
- Extract buyer info (PII — restricted), line items, payment/shipping amounts
- Handle Amazon's multi-line-item and offer-level granularity
- Parse shipping address from PII-restricted fields

---

### Week 4: Shipment Updates + Reporting

**Task 3.11 — Shipment confirmation** (~50 lines)
- `updateShipment()` → `POST /orders/v2/{orderId}/shipments` (ConfirmShipment API)
- Requires RDT for PII access
- Handle Amazon's shipment confirmation flow with tracking number and carrier

**Task 3.12 — Feed-based reporting for bulk operations** (~50 lines)
- Use Feeds API for batch inventory updates if needed
- Generate CSV feeds for large product catalogs
- Submit via `POST /feeds/2021-06-30/documents`
- Poll feed processing status

---

### Week 5: Testing + Admin UI + Compliance Review

**Task 3.13 — Integration tests against Amazon sandbox** (~100 lines)
- Create `apps/merchant/src/tests/marketplace/amazon.test.ts`
- Mock SP-API responses for listings, inventory, orders
- Test LWA token refresh cycle
- Test RDT acquisition and usage
- Test SigV4 signing correctness

**Task 3.14 — Admin UI** (~100 lines)
- Add Amazon connect button to marketplace dashboard
- Display Amazon channel status, sync health, last poll time
- Manual sync trigger buttons (products, inventory, orders)
- Show PII compliance status

**Task 3.15 — PII handling audit** (~50 lines)
- Ensure all customer data encrypted at rest in `marketplace_orders`
- Restrict access via IAM policies
- Document incident response procedures for Amazon review
- Verify AES-GCM encryption on all PII fields

---

### Week 6–8: Performance Tuning + Compliance (Buffer)

**Task 3.16 — Rate limit optimization** (~50 lines)
- Implement request coalescing for order polling
- Add exponential backoff with jitter for 429 responses
- Optimize time-range filters to minimize API calls
- Monitor per-operation rate limit usage via KV counters

**Task 3.17 — Compliance documentation** (~50 lines)
- Prepare security architecture documentation for Amazon review
- Document PII protection controls (encryption at rest, access restrictions)
- Write incident response plan
- Prepare technical demo materials for Solutions Architect review

---

## Rate Limiting Configuration

Update `rate-limiter.ts` with Amazon-specific per-operation limits:

```typescript
amazon: {
  maxPerDay: 10_000,          // Conservative default
  maxPerSecond: 5,            // Overall cap
  operations: {
    searchOrders: { maxPerSecond: 0.0056, burst: 20 },   // ~480/day
    getOrder: { maxPerSecond: 0.5, burst: 30 },          // ~43K/day
    updateShipmentStatus: { maxPerSecond: 5, burst: 15 },
    listInventory: { maxPerSecond: 2, burst: 10 },
    listingsUpdate: { maxPerSecond: 1, burst: 5 },
  },
},
```

---

## Environment Variables Required

| Variable | Purpose |
|----------|---------|
| `AMAZON_LWA_APP_ID` | Amazon Login with Amazon app ID |
| `AMAZON_LWA_APP_SECRET` | Amazon Login with Amazon app secret |
| `AMAZON_AWS_ACCESS_KEY` | AWS Access Key ID for SigV4 signing |
| `AMAZON_AWS_SECRET_KEY` | AWS Secret Access Key for SigV4 signing |
| `AMAZON_REGION` | SP-API region (`NA`, `EU`, `FEA`) — default: `NA` |
| `AMAZON_MWS_AUTH_TOKEN` | MWS Auth Token (optional, for some endpoints) |

---

## API Endpoints Reference

### Listings / Products
| Operation | Endpoint | Method | Role | SigV4 |
|-----------|----------|--------|------|-------|
| Get catalog item | `/catalog/2022-04-01/items/{asin}` | GET | Product Listing | Yes |
| Search catalog | `/catalog/2022-04-01/items` | POST | Product Listing | Yes |
| Update listing | `/listings/2021-08-01/items/{sellerId},{asin}` | PATCH | Product Listing | Yes |
| Create listing | `/listings/2021-08-01/items/{sellerId},{asin}` | PUT | Product Listing | Yes |

### Inventory
| Operation | Endpoint | Method | Role | SigV4 |
|-----------|----------|--------|------|-------|
| List FBA inventory | `/inventory/v2` | GET | Inventory and Order Tracking | Yes |
| Update quantity | (via Listings PATCH) | PATCH | Product Listing | Yes |

### Orders
| Operation | Endpoint | Method | Role | Restricted? | SigV4 |
|-----------|----------|--------|------|-------------|-------|
| Search orders | `/orders/v2/orders` | GET | Inventory and Order Tracking | No (metadata) | Yes |
| Get order details | `/orders/v2/orders/{orderId}` | GET | Direct-to-Consumer Shipping | **Yes — PII** | Yes + RDT |

### Fulfillment
| Operation | Endpoint | Method | Role | Restricted? | SigV4 |
|-----------|----------|--------|------|-------------|-------|
| Confirm shipment | `/orders/v2/{orderId}/shipments` | POST | Direct-to-Consumer Shipping | **Yes — PII** | Yes + RDT |

### Feeds / Reports
| Operation | Endpoint | Method | Role | SigV4 |
|-----------|----------|--------|------|-------|
| Create feed | `/feeds/2021-06-30/documents` | POST | Product Listing | Yes |
| Get feed document | `/feeds/2021-06-30/documents/{documentId}` | GET | Product Listing | Yes |

---

## Data Mapping Complexity

```
Internal Model              Amazon SP-API
─────────────────────────────────────────────
Product                   ASIN-based (catalog-driven)
SKU                       Seller SKU / UPC (mapped to ASIN)
Variant                   Variation theme child items
Inventory                 inventoryUnits (FBA/MFN)
Order                     Order v2 (metadata-only, PII-restricted for details)
Customer                  PII (restricted — requires RDT)
Shipment Tracking         ConfirmShipment API (PII-restricted)
```

**Key challenges:**
- **ASIN-centric model**: Products are tied to Amazon's catalog; must resolve internal SKU → ASIN via reverse lookup
- **Variation themes**: Amazon uses parent/child variation structure; internal variants map to child items under a variation theme
- **Condition field**: Amazon requires explicit condition (NEW, USED, REFURBISHED) on every listing
- **PII separation**: Order metadata is available without RDT, but customer details require restricted role + RDT

---

## Testing Strategy

### Sandbox Accounts
- Amazon Solution Provider Portal → Create developer profile (free, 4–8 weeks review)
- SP-API sandbox environment (available after approval)
- Test product catalog with known ASINs
- Simulate order creation via sandbox tools

### Test Cases
1. **LWA auth flow**: Generate auth URL → simulate callback → exchange code → store tokens
2. **RDT acquisition**: Call Tokens API with LWA token → verify RDT returned for restricted scope
3. **SigV4 signing**: Sign test request → compare against known test vectors
4. **Product push**: Create listing via Listings Items API → verify in Amazon sandbox
5. **Inventory sync**: Update FBA quantity → verify inventory units updated
6. **Order polling**: Poll with time-range filter → verify orders created, deduplicated
7. **Shipment update**: Confirm shipment via Orders API → verify status updated
8. **PII handling**: Verify customer data encrypted at rest; no PII in logs

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Amazon onboarding rejection | Medium | High | Submit early during Phase 1/2; prepare thorough documentation; engage Amazon support proactively |
| Rate limit exhaustion (orders) | High | High | Implement aggressive caching; batch order polling with time-range filters; use ~480/day budget efficiently |
| RDT token management complexity | Medium | Medium | Cache per-operation scope; auto-refresh on expiry; clear error messages when RDT unavailable |
| SigV4 signing errors | Low | High | Use Web Crypto API (same as eBay); test against Amazon sandbox with known vectors |
| PII compliance breach | Low | Critical | Encrypt all PII at rest via AES-GCM; restrict access via IAM; annual security audit; incident response plan |
| ASIN→SKU reverse lookup failures | Medium | Medium | Maintain local SKU→ASIN mapping table; fallback to catalog search when needed |

---

## Prerequisites Checklist (Before Development)

- [ ] Amazon Solution Provider Portal developer profile submitted
- [ ] Public website with business description, privacy policy, terms of service live
- [ ] Security architecture documentation prepared
- [ ] AWS credentials provisioned (Access Key ID + Secret Access Key)
- [ ] Restricted roles approval received (for PII access on orders/shipping)
- [ ] Sandbox environment accessible

*Note: Begin Amazon developer profile submission during Phase 1 or 2 to overlap review time with other development work.*

---

## Completion Criteria

- [ ] Amazon LWA + RDT auth works end-to-end
- [ ] AWS SigV4 signing produces valid requests to sandbox
- [ ] Products push to Amazon via Listings Items API
- [ ] Inventory syncs with FBA or external fulfillment
- [ ] Orders polled and created as internal orders (with deduplication)
- [ ] Shipment updates reach Amazon
- [ ] PII handling passes security review
- [ ] No TypeScript errors in `amazon.ts` or modified files

---

## Estimated Effort Summary

| Component | Est. Days | Notes |
|-----------|-----------|-------|
| Auth integration (LWA + RDT + SigV4) | 5 days | Most complex component; 3 auth layers |
| Product sync (Listings Items API) | 4 days | ASIN catalog lookup, variation themes |
| Inventory sync (FBA Inventory API) | 3 days | FBA vs MFN distinction |
| Order ingestion (polling + batching) | 4 days | Rate limit: 0.0056/sec requires careful design |
| Shipment updates (ConfirmShipment) | 2 days | RDT required for PII |
| Feeds API for bulk operations | 1 day | Optional optimization |
| Testing + QA | 5 days | Sandbox integration, compliance review prep |
| Admin UI integration | 3 days | Connect flow, dashboard, sync triggers |
| **Total** | **~27 days** | 6–8 weeks with buffer for Amazon review |

---

*Plan created: 2026-11-19*
