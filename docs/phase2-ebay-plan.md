# Phase 2 Development Plan: eBay Integration

**Project:** Multicom (bengal-exchange) — Headless commerce platform
**Date:** 2026-11-19
**Status:** Planning
**Dependencies:** Phase 1 Etsy client completed; P1 remaining tasks (OAuth token exchange, webhook order creation, shipment update) should be finished first

---

## Overview

Phase 2 implements eBay Sell API integration following the same architecture patterns established in Phase 1. The key differences from Etsy are:

1. **Dual OAuth tokens** — eBay requires both an Application Token (client credentials) and a User Token (authorization code flow). Only the User Token can access `sell/*` endpoints.
2. **RuName redirect URI** — eBay uses a registered redirect URI alias (`RuName`) instead of an actual URL in the OAuth flow. This is a common implementation pitfall.
3. **No real-time webhooks** — eBay's Notification API is limited; order polling via cron is the primary approach.
4. **Multi-warehouse support** — eBay uses `availabilityDistributions` keyed by `merchantLocationKey`, which maps to our internal warehouse concept.
5. **Generous rate limits** — 2M/day for inventory, 100K/day for orders (vs Etsy's 10K/day).

---

## Architecture Decisions

### File Structure

```
apps/merchant/src/lib/marketplace/ebay.ts    ← eBay API client (~400 lines)
apps/merchant/src/routes/marketplace/connect.ts  ← Add eBay OAuth routes (extend existing)
apps/merchant/src/routes/marketplace/webhook.ts   ← Add eBay notification handler (extend existing)
```

No new files needed beyond `ebay.ts`. The shared library (`types.ts`, `auth-manager.ts`, `rate-limiter.ts`, `data-mapper.ts`, `crypto-utils.ts`) is already in place and reused.

### OAuth Flow Design

eBay's two-token flow:

```
1. Application Token (Client Credentials Grant):
   POST https://api.ebay.com/identity/v1/oauth2/token
   Body: grant_type=client_credentials&scope=sell.notifications.read
   
2. User Token (Authorization Code Flow):
   GET  https://signin.ebay.com/oauth/authorize?client_id=...&redirect_uri=RuName&response_type=code&scope=...
   → User authorizes → redirect to RuName with ?code=...
   
3. Exchange code for tokens:
   POST https://api.ebay.com/identity/v1/oauth2/token
   Body: grant_type=authorization_code&code=...&client_id=...&client_secret=...
```

**Storage:** Both tokens stored in `marketplace_credentials` table:
- `oauth_token` → User access token (2-hour expiry)
- `refresh_token` → User refresh token (~18-month validity)
- Application token is obtained on-demand via client credentials grant (not stored long-term)

### eBay-Specific Types

```typescript
interface EbayInventoryItem {
  sku: string;
  title: string;
  description: string;
  primary_image_url: string;
  product: {
    product_description: { name: string };
    aspects?: Record<string, string>;
  };
  listing_type: 'FIXED';
  price: { value: string; currency: string };
  quantity: number;
  condition: 'NEW' | 'USED' | 'REFURBISHED';
  availability_distribution?: Array<{
    merchant_location_key: string;
    type: 'Available' | 'Preorder';
    quantity: number;
  }>;
}

interface EbayOrder {
  order_id: string;
  buyer: { username: string };
  payment_instant_date: string;
  last_paid_date: string;
  shipping_service: string;
  line_items: Array<{
    sku: string;
    title: string;
  }>;
}
```

---

## Implementation Tasks

### Week 1: eBay Auth + Inventory Setup

**Task 2.1 — Create `EbayClient` class** (~150 lines)
- Implement `IMarketplaceClient` interface
- Constructor accepts config, token getter, rate limiter (same pattern as `EtsyClient`)
- Add `X-EBAY-C-MARKETPLACE-ID` header injection (`EBAY_US` default, configurable)
- Implement `getAccessToken()` with automatic refresh check

**Task 2.2 — OAuth URL generation for eBay** (~50 lines)
- Extend `connect.ts` `generateAuthUrl()` switch case for `'ebay'`
- Read `RuName` from env var `EBAY_RU_NAME`
- Construct authorization URL: `https://signin.ebay.com/oauth/authorize?client_id=...&redirect_uri=RuName&response_type=code&scope=...`
- Scopes: `sell.inventory`, `sell.fulfillment`, `sell.account`

**Task 2.3 — Token exchange for eBay** (~100 lines)
- Extend `connect.ts` `exchangeCodeForTokens()` switch case for `'ebay'`
- POST to `https://api.ebay.com/identity/v1/oauth2/token` with client credentials + auth code
- Store user access token and refresh token in `marketplace_credentials`
- Application token obtained on-demand (client credentials grant, not persisted)

**Task 2.4 — Inventory location setup** (~50 lines)
- Map internal warehouse concept to eBay `merchantLocationKey`
- Create default `merchantLocationKey` per channel if not exists
- Store in `marketplace_channels.config_json`

---

### Week 2: Product Push + Inventory Sync

**Task 2.5 — Product push** (~100 lines)
- `upsertProduct()` → `POST /sell/inventory/v1/inventory_item`
- Map internal product fields to eBay inventory item structure
- Handle `condition` field (default: NEW)
- Map images, aspects, title, description
- Activate listing after creation

**Task 2.6 — Inventory sync** (~80 lines)
- Push: internal → eBay via `PUT /sell/inventory/v1/inventory_item/{sku}`
- Multi-warehouse: map to `availabilityDistributions` array
- Pull: read eBay items → map to internal variants via `mapMarketplaceToProduct()`
- Use bulk endpoint for batch operations: `POST /sell/inventory/v1/bulk/inventory_items`

**Task 2.7 — Product pull** (~50 lines)
- `listProducts()` → `GET /sell/inventory/v1/inventory_item?filter=...`
- Pagination via `nextPageToken` in response
- Map eBay inventory items to internal variants

---

### Week 3: Orders + Fulfillment

**Task 2.8 — Order polling setup** (~80 lines)
- Implement `listOrders()` → `GET /sell/fulfillment/v1/order?filter=creationdate:[from..to]`
- Track last-poll timestamp per channel in `config_json.last_poll_at`
- Schedule cron job every 15 minutes (extend existing scheduled handler in `index.ts`)
- Deduplicate orders by `order_id` using `marketplace_orders` table

**Task 2.9 — Order mapping** (~50 lines)
- Map eBay order structure to `MarketOrder`
- Extract buyer info, line items, payment/shipping amounts
- Handle eBay's multi-line-item structure

**Task 2.10 — Shipment updates** (~50 lines)
- `updateShipment()` → `PUT /sell/fulfillment/v1/order/{orderId}/status`
- Set status to `SHIPPED` with tracking number
- Upload tracking via eBay logistics API if available

---

### Week 4: Testing + Admin UI + Polish

**Task 2.11 — Integration tests** (~100 lines)
- Create `apps/merchant/src/tests/marketplace/ebay.test.ts`
- Mock eBay API responses for inventory, orders, fulfillment
- Test OAuth flow simulation (code → tokens)
- Test product push/pull round-trip
- Test order polling with deduplication

**Task 2.12 — Admin UI** (~100 lines)
- Add eBay connect button to marketplace dashboard
- Display eBay channel status, sync health, last poll time
- Manual sync trigger buttons (products, inventory, orders)

**Task 2.13 — Error handling** (~50 lines)
- Handle eBay-specific error codes (e.g., `INVALID_AUTH`, `RATE_LIMIT_EXCEEDED`)
- Auto-refresh on 401 responses
- Log warnings for failed listings

---

## Rate Limiting Configuration

Update `rate-limiter.ts` with eBay limits:

```typescript
const PLATFORM_LIMITS = {
  // ...existing Etsy...
  ebay: {
    dailyQuota: 2_000_000,   // Inventory API
    perSecond: 50,
    ordersDailyQuota: 100_000,
    ordersPerSecond: 10,
  },
};
```

---

## Environment Variables Required

| Variable | Purpose |
|----------|---------|
| `EBAY_CLIENT_ID` | eBay application client ID |
| `EBAY_CLIENT_SECRET` | eBay application client secret |
| `EBAY_RU_NAME` | eBay registered redirect URI alias (not a URL) |
| `EBAY_MARKETPLACE` | Default marketplace code (default: `EBAY_US`) |

---

## API Endpoints Reference

### Inventory
| Operation | Endpoint | Method | Auth |
|-----------|----------|--------|------|
| List items | `/sell/inventory/v1/inventory_item` | GET | User token |
| Create item | `/sell/inventory/v1/inventory_item` | POST | User token |
| Update item | `/sell/inventory/v1/inventory_item/{sku}` | PUT | User token |
| Delete item | `/sell/inventory/v1/inventory_item/{sku}` | DELETE | User token |
| Bulk create | `/sell/inventory/v1/bulk/inventory_items` | POST | User token |

### Orders / Fulfillment
| Operation | Endpoint | Method | Auth |
|-----------|----------|--------|------|
| List orders | `/sell/fulfillment/v1/order` | GET | User token + `.readonly` |
| Get order | `/sell/fulfillment/v1/order/{orderId}` | GET | User token |
| Update status | `/sell/fulfillment/v1/order/{orderId}/status` | PUT | User token |

### Notifications
| Operation | Endpoint | Method | Auth |
|-----------|----------|--------|------|
| Subscribe | `/sell/notification/v1/subscription` | POST | User token |
| List events | `/sell/notification/v1/event` | GET | User token |

---

## Testing Strategy

### Sandbox Accounts
- eBay Developer Portal → Create application (free)
- Sandbox seller user account for testing
- Test inventory items with known SKUs
- Simulate order creation via sandbox tools

### Test Cases
1. OAuth flow: generate auth URL → simulate callback → verify tokens stored
2. Product push: create internal product → verify eBay listing created
3. Inventory sync: update quantity → verify eBay updated
4. Order polling: create test order in sandbox → verify internal order created
5. Shipment update: mark order shipped → verify eBay status updated
6. Deduplication: poll twice for same orders → only one internal order created
7. Multi-warehouse: push to 2 warehouses → verify `availabilityDistributions` set

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| RuName misconfiguration | Medium | High | Validate RuName format on connect; clear error message |
| eBay sandbox vs production differences | Medium | Medium | Test against both; document known differences |
| Order polling lag (15-min interval) | Low | Low | Acceptable for eBay; buyers don't expect instant sync |
| Bulk inventory endpoint rate limits | Low | Medium | Use bulk only for initial push; individual updates for ongoing sync |

---

## Completion Criteria

- [ ] eBay OAuth flow works end-to-end (connect → authorize → tokens stored)
- [ ] Products push to eBay inventory with correct condition/aspects
- [ ] Inventory syncs bidirectionally, multi-warehouse mapped
- [ ] Orders polled every 15 min and created as internal orders
- [ ] Shipment tracking updates on eBay
- [ ] Admin UI shows eBay channel status
- [ ] All integration tests pass against sandbox
- [ ] No TypeScript errors in `ebay.ts` or modified files

---

*Plan created: 2026-11-19*
