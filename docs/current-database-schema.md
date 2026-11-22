# Current Database Schema

> **Generated:** 2026-11-22, from the *live* schema (not the SQL text).
> **How:** `MerchantDO` was booted on `node:sqlite` via `apps/merchant/tests/helpers/merchant-db.ts`, which runs the real `SCHEMA` constant plus all 86 inline migrations in `ensureInitialized()`. The tables, columns, keys and indexes below were read back from `sqlite_master` / `PRAGMA`.
> **Storage:** a single `MerchantDO` Durable Object (SQLite). There is no D1. Foreign keys are enforced: `routes/setup.ts` only turns them off around a reset.

## How the schema is built (read this first)

- **The source of truth is `do.ts`**: the `SCHEMA` constant plus the inline `migrations` array. The files in `apps/merchant/migrations/` (`001` to `037`) are reference copies and are not executed at runtime.
- **The two are already out of sync.** The 5 `marketplace_*` tables exist **only** as inline migrations (`037_marketplace_*`). They are missing from `SCHEMA` and have no numbered `.sql` file. That breaks the project's three-edit rule (`SCHEMA` + inline migration + numbered file).
- **Two different migrations are both numbered 037**: `037-add-better-auth-tables.sql` (Better Auth) and the inline `037_marketplace_*` entries. The next migration should be `038`.

---

## 1. Table inventory (55 tables)

| Domain | Tables |
|---|---|
| **Catalog** | `products`, `variants`, `variant_prices`, `categories`, `product_categories`, `product_reviews`, `shipping_classes` |
| **Inventory** | `inventory`, `inventory_logs`, `warehouses`, `warehouse_inventory`, `warehouse_inventory_logs`, `digital_assets` |
| **Commerce** | `carts`, `cart_items`, `saved_carts`, `orders`, `order_items`, `refunds`, `discounts`, `discount_usage`, `order_email_settings` |
| **Customers** | `customers`, `customer_addresses`, `ai_token_balances`, `ai_token_transactions` |
| **Regions / tax / shipping** | `regions`, `countries`, `region_countries`, `currencies`, `region_warehouses`, `shipping_rates`, `shipping_rate_prices`, `region_shipping_rates`, `tax_rates` |
| **Auth (Better Auth)** | `user`, `session`, `account`, `verification` |
| **Auth (API / OAuth)** | `api_keys`, `oauth_clients`, `oauth_authorizations`, `oauth_tokens` |
| **Integrations** | `webhooks`, `webhook_deliveries`, `events` (Stripe event de-duplication), `ucp_checkout_sessions` |
| **Marketplace** | `marketplace_channels`, `marketplace_credentials`, `marketplace_product_mappings`, `marketplace_orders`, `marketplace_sync_jobs` |
| **System** | `config`, `store_themes`, `migrations` |

Every table uses a `TEXT` primary key named `id` (UUID), except `config` (`key`) and `migrations`.

---

## 2. Entity-Relationship overview

`──►` is a declared foreign key. `┄┄►` is an **implicit** reference: the column exists but there is no `REFERENCES` constraint, so the database does not enforce it.

```text
                         ┌──────────────────┐
                         │ shipping_classes │◄────────────┬──────────────────┐
                         └──────────────────┘             │                  │
                                                          │                  │
 categories ◄── product_categories ──► products ◄─────────┤ shipping_class_id│
   ▲  (parent_id)                       │  ▲               │                  │
   └─────┘                              │  └── product_reviews ──► customers, orders
                                        │
                                        ▼ product_id
                                     variants ──────────────► variant_prices ──► currencies
                                        │ sku (UNIQUE)              ▲
                    ┌───────────────────┼─────────────┐             │
                    ┊ sku               ┊ sku         ┊ sku      regions ──► currencies
                    ▼                   ▼             ▼             │ (region_countries,
               inventory ◄── digital_assets      cart_items        │  region_warehouses,
               (sku UNIQUE)   (FK sku→inventory)  │                 │  region_shipping_rates)
                    ┊                             ▼ cart_id         │
          warehouse_inventory ──► warehouses     carts ┄┄► regions, discounts, shipping_rates
                                                  ▲
                                             saved_carts

 customers ◄┄┄ orders ──────────────────────────────────────────────────────────┐
   │  ▲  (customer_id: implicit)                                                  │
   │  │      │ ◄── order_items (order_id)   order_items ┄┄► variants (by sku)     │
   │  │      │ ◄── refunds, discount_usage, ai_token_transactions                 │
   │  │      ┊ region_id, warehouse_id, discount_id, shipping_rate_id: implicit   │
   │  └── customer_addresses, ai_token_balances, oauth_tokens                     │
   ┊ email                                                                        │
   ▼                                                                              │
 user (Better Auth) ◄── session, account                                          │
                                                                                  │
 marketplace_channels ◄── marketplace_credentials                                 │
        ▲   ▲   ▲                                                                 │
        │   │   └── marketplace_sync_jobs                                         │
        │   └────── marketplace_product_mappings ──► variants                     │
        └────────── marketplace_orders ──► orders ◄───────────────────────────────┘
```

Key structural facts:

1. **`sku` is the real join key** for stock and line items. `inventory`, `warehouse_inventory`, `cart_items`, `order_items` and `digital_assets` all reference a variant **by SKU**, not by `variants.id`. Only `digital_assets.sku → inventory.sku` is a declared FK.
2. **`orders` has no declared foreign keys.** `customer_id`, `region_id`, `warehouse_id`, `discount_id` and `shipping_rate_id` are all implicit.
3. **Customers are linked to Better Auth `user` by email.** `/v1/me` auto-provisions a `customers` row (`auth_provider = 'better-auth'`, `auth_provider_id = user.id`).
4. **No FK uses `ON DELETE CASCADE`** except `variant_prices` (the variant and currency FKs). Because FKs are enforced, deleting a parent with children fails.

---

## 3. Core tables for marketplace sync

Notation: **PK** primary key, `!` NOT NULL, `= x` default.

### `products`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT **PK** | UUID |
| `title` | TEXT ! | Plain text **or** a JSON locale map (`{"en-US":"…","fr-FR":"…"}`) |
| `description` | TEXT = `''` | Plain text or JSON locale map |
| `image_url` | TEXT | Single primary image |
| `shipping_class_id` | TEXT | FK → `shipping_classes.id` |
| `vendor`, `tags` | TEXT | `tags` is free text |
| `handle` | TEXT | UNIQUE (URL slug) |
| `status` | TEXT ! = `'active'` | |
| `review_count` / `average_rating` | INTEGER / REAL | Denormalized from `product_reviews` |
| `created_at` | TEXT ! | No `updated_at` column |

- **Indexes:** `idx_products_handle` (UNIQUE), `idx_products_vendor`, `idx_products_status`, `idx_products_shipping_class`.
- **Marketplace relevance:** there's no `updated_at`, so "what changed since the last sync" can't be answered from this table. Titles in locale JSON have to be resolved to one language for each marketplace.

### `variants`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT **PK** | |
| `product_id` | TEXT ! | FK → `products.id` (no cascade) |
| `sku` | TEXT ! | **UNIQUE**, the join key for inventory and line items |
| `title` | TEXT ! | e.g. "Black / Medium" |
| `price_cents` | INTEGER ! | Base price in `currency` |
| `currency` | TEXT ! = `'USD'` | Per-currency overrides in `variant_prices` |
| `weight_g` | INTEGER ! = 0 | |
| `dims_cm` | TEXT | JSON `{l,w,h}` |
| `requires_shipping` | INTEGER ! = 1 | |
| `barcode` | TEXT | EAN/UPC/GTIN; needed by Amazon and eBay |
| `compare_at_price_cents`, `tax_code` | | |
| `image_url`, `thumbnail_url` | TEXT | |
| `shipping_class_id` | TEXT | FK → `shipping_classes.id` |
| `status` | TEXT ! = `'active'` | |
| `variant_type` | TEXT ! = `'physical'` | `physical` / `digital` / `ai_tokens` |
| `ai_token_units` | INTEGER | |
| `created_at` | TEXT ! | No `updated_at` |

- **Indexes:** `sku` (UNIQUE + `idx_variants_sku`), `idx_variants_product`, `idx_variants_status`, `idx_variants_barcode`, `idx_variants_type`, `idx_variants_requires_shipping`, `idx_variants_shipping_class`.
- **Related:** `variant_prices(variant_id, currency_id)` UNIQUE, `ON DELETE CASCADE` on both.
- **Marketplace relevance:** only `physical` variants should sync. There are no variant option columns (size, colour), only a free-text `title`, so building marketplace variation specs (eBay aspects, Amazon variation themes) will need parsing or new data.

### `inventory` (stock per SKU)
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT **PK** | |
| `sku` | TEXT ! | UNIQUE (implicit link to `variants.sku`) |
| `on_hand` / `reserved` | INTEGER ! = 0 | Available = `on_hand − reserved` |
| `updated_at` | TEXT ! | |

- When a SKU has rows in `warehouse_inventory`, `inventory` mirrors the warehouse totals (`lib/inventory.ts`). Stock changes are logged in `inventory_logs` / `warehouse_inventory_logs`.

### `orders`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT **PK** | |
| `customer_id` | TEXT | *implicit* → `customers.id` |
| `number` | TEXT ! | UNIQUE, e.g. `ORD-…` |
| `status` | TEXT ! = `'paid'` | CHECK: `pending, paid, processing, shipped, delivered, refunded, canceled` |
| `customer_email` | TEXT ! | Required |
| `region_id`, `warehouse_id`, `shipping_rate_id`, `discount_id` | TEXT | *implicit* |
| `shipping_name`, `shipping_phone`, `ship_to` | TEXT | `ship_to` is a JSON address |
| `subtotal_cents`, `tax_cents`, `total_cents` | INTEGER ! | |
| `shipping_cents` | INTEGER ! = 0 | |
| `currency` | TEXT ! = `'USD'` | |
| `discount_code`, `discount_amount_cents` | | |
| `tracking_number`, `tracking_url`, `shipped_at` | TEXT | Needed to push fulfilment back to marketplaces |
| `stripe_checkout_session_id`, `stripe_payment_intent_id` | TEXT | |
| `sslcommerz_tran_id` | TEXT | |
| `payment_gateway` | TEXT = `'stripe'` | Free text (no CHECK) |
| `taxes_json`, `locale`, `viewtoken*`, `confirmationemail*` | | |
| `created_at` | TEXT ! | No `updated_at` |

- **Indexes:** `number` (UNIQUE), `viewtoken` (UNIQUE), `idx_orders_customer`, `idx_orders_status`, `idx_orders_status_created`, `idx_orders_email`, `idx_orders_email_created`, `idx_orders_region`, `idx_orders_warehouse`, `idx_orders_sslcommerz_tran`, `idx_orders_payment_gateway`.
- **No declared FKs.**
- **Marketplace relevance:** there's no column recording where an order came from (web / Etsy / eBay / Amazon). `customer_email` is NOT NULL, but marketplace buyer emails can be masked or missing.

### `order_items`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT **PK** | |
| `order_id` | TEXT ! | FK → `orders.id` (index `idx_order_items_order_id`) |
| `sku` | TEXT ! | *implicit* → `variants.sku` |
| `title` | TEXT ! | Snapshot at purchase |
| `qty`, `unit_price_cents` | INTEGER ! | |

- There's no column for the marketplace's own line-item ID, which is needed when pushing shipment confirmations per line.

### `customers`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT **PK** | |
| `email` | TEXT ! | UNIQUE (+ `idx_customers_email`) |
| `name`, `phone`, `locale` = `'en'`, `metadata` | | |
| `password_hash`, `email_verified_at` | | Legacy; Better Auth now owns credentials |
| `auth_provider`, `auth_provider_id` | TEXT | `'better-auth'` + `user.id` (index `idx_customers_auth_provider_id`) |
| `accepts_marketing` | INTEGER = 0 | |
| `order_count`, `total_spent_cents`, `last_order_at` | | Denormalized; updated by the payment webhook/IPN |
| `created_at`, `updated_at` | TEXT ! | |

- **Marketplace relevance:** customers are unique by email. Importing marketplace buyers under relay or anonymized emails would create one-off customers, or merge them wrongly. That needs a policy decision (see §5.6).

---

## 4. Existing marketplace tables (inline migration `037_marketplace_*`)

| Table | Columns (key ones) | Keys / indexes | Used by code? |
|---|---|---|---|
| `marketplace_channels` | `platform` ! CHECK (`etsy`,`ebay`,`amazon`), `store_id` !, `external_shop_id`, `config_json` = `'{}'`, `status` CHECK (`active`,`paused`,`error`), `created_at`, `updated_at` | PK `id`; idx `platform`; idx `store_id`; **no UNIQUE** | `routes/marketplace/connect.ts`, `status.ts`, `sync-products.ts` |
| `marketplace_credentials` | `channel_id` ! FK, `credential_type` CHECK (`api_key`,`oauth_token`,`refresh_token`), `encrypted_value` !, `metadata` = `'{}'` | UNIQUE (`channel_id`,`credential_type`); idx `channel_id` | `lib/marketplace/auth-manager.ts`, `connect.ts` |
| `marketplace_product_mappings` | `channel_id` ! FK, `variant_id` FK (nullable), `external_listing_id` !, `external_sku`, `status` CHECK (`active`,`inactive`,`error`), `last_sync_at` | UNIQUE (`channel_id`,`external_listing_id`); idx `channel_id` | **Not read or written anywhere** |
| `marketplace_orders` | `channel_id` ! FK, `internal_order_id` FK → `orders`, `external_order_id` !, `status` !, `raw_payload` ! | idx `channel_id`; **no UNIQUE on external id** | **Not read or written anywhere** |
| `marketplace_sync_jobs` | `channel_id` ! FK, `job_type` CHECK (`push_products`,`push_inventory`,`pull_orders`,`sync_all`), `status` CHECK (`pending`,`in_progress`,`completed`,`failed`), `payload`, `error_message`, `attempts` | idx (`channel_id`,`status`) | `sync-products.ts` |

All of these FKs are `ON DELETE NO ACTION`.

---

## 5. Phase 5 Marketplace Requirements

### 5.1 What already exists

The three tables named as examples in the brief (`marketplace_channels`, `marketplace_credentials`, `marketplace_product_mappings`) **already exist**, along with `marketplace_orders` and `marketplace_sync_jobs`. Phase 5 therefore needs to **repair and extend** them, not create them from scratch.

### 5.2 Issues to fix first (found while mapping; not schema design)

These are existing defects, recorded here as asked; no code was changed.

| # | Severity | Issue | Where |
|---|---|---|---|
| A | **Security** | No marketplace route has auth middleware. Anyone can start an OAuth connect, trigger syncs, and read channel status. A code comment says "admin auth required", but nothing enforces it. | `routes/marketplace/index.ts` |
| B | **Security** | The OAuth `state` is a random UUID that's never stored or checked. The callback picks the channel by platform alone, so the callback is open to CSRF / account-linking attacks. | `connect.ts` |
| C | Bug | The sync job insert uses `job_type = 'pending'`, which violates the CHECK constraint, so **every sync request fails**. | `sync-products.ts:77, :117` |
| D | Bug | Connect requires `config.store_id`, but nothing in `src/` ever writes that key, so connect always fails with "Store not configured". | `connect.ts` |
| E | Bug | The eBay token exchange stores `metadata = '{}'`, so `auth-manager.ts` never sees `expires_at` and can't tell when a token needs refreshing. Etsy and Amazon token exchange isn't implemented; the code silently does nothing. | `connect.ts`, `auth-manager.ts` |
| F | Process | The marketplace tables are missing from `SCHEMA` and have no numbered `.sql` file, and they reuse the `037` number (see top). | `do.ts` |

### 5.3 Changes needed to existing marketplace tables

| Table | Change | Why |
|---|---|---|
| `marketplace_channels` | Add `'pending'` and `'disconnected'` to the `status` CHECK; add UNIQUE (`platform`, `external_shop_id`); drop the dependency on `store_id` (or default it, since this is a single-merchant DO) | A channel is created before OAuth completes, so it can't be `active` yet. Uniqueness prevents connecting the same shop twice. |
| `marketplace_credentials` | Add an `expires_at TEXT` column | Token refresh needs a queryable expiry, not a value buried in a JSON blob. |
| `marketplace_product_mappings` | Add `product_id` (FK → `products`), `external_offer_id`, `last_error`, `content_hash`, `price_override_cents`; UNIQUE (`channel_id`,`variant_id`); index `variant_id` | Etsy listings and eBay item groups are per product, while inventory pushes are per variant. A reverse lookup (variant → listings) is needed whenever stock changes. A hash lets unchanged items be skipped. |
| `marketplace_orders` | Add UNIQUE (`channel_id`, `external_order_id`); index `internal_order_id` | Without it, re-polling imports the same order twice. |
| `marketplace_sync_jobs` | Add `run_after` (retry backoff), `locked_at` (worker lease), `result_json` (counts and errors) | Retry and concurrency control for the scheduled sync. |
| All | Decide `ON DELETE` behaviour: CASCADE for credentials, jobs and mappings; keep NO ACTION for `marketplace_orders` | Today, disconnecting a channel can't delete it while children exist, because FKs are enforced. |

### 5.4 Missing tables

| Table | Purpose | Relations |
|---|---|---|
| `marketplace_oauth_states` | One row per connect attempt: `state` (PK), `channel_id`, `platform`, `code_verifier` (Etsy uses PKCE), `return_to`, `expires_at` | → `marketplace_channels`. Fixes issue B. |
| `marketplace_order_lines` | Maps marketplace line items to ours: `marketplace_order_id`, `external_line_item_id`, `order_item_id`, `sku`, `qty` | → `marketplace_orders`, → `order_items`. Shipment confirmations are pushed per line item on eBay and Amazon. |
| `marketplace_webhook_events` | De-duplicates incoming notifications: `channel_id`, `external_event_id` (UNIQUE with channel), `topic`, `received_at`, `processed_at`, `payload` | → `marketplace_channels`. Same role `events` plays for Stripe; the existing `events` table is keyed on `stripe_event_id`. |
| `marketplace_inventory_policies` *(optional)* | Per channel/SKU `buffer_qty` and `max_qty` | → `marketplace_channels`, ┄ `variants.sku`. Stops overselling across channels. Could live in `config_json` instead if per-SKU control isn't needed. |

### 5.5 Changes needed to core tables

| Table | Change | Why |
|---|---|---|
| `orders` | Add `channel_id TEXT REFERENCES marketplace_channels(id)` (NULL = web store), plus index | Filter and report by sales channel, and route fulfilment back to the right marketplace. |
| `orders` | Allow `payment_gateway` values `etsy`, `ebay`, `amazon` (no CHECK exists, so this is a convention change only) | Marketplace orders are paid on the marketplace. |
| `orders` | Add `updated_at` | Order status sync needs change tracking. |
| `products`, `variants` | Add `updated_at` | Incremental "changed since last sync" pushes. Without it, every sync is a full push. |
| `order_items` | *(optional)* add `variant_id` | `sku` works as the key today. Only needed if SKUs can change after an order. |

### 5.6 Proposed relationships

```text
                    marketplace_oauth_states
                              │
                              ▼
   marketplace_credentials ──► marketplace_channels ◄── marketplace_webhook_events
   marketplace_sync_jobs ────►   ▲        ▲      ▲
                                 │        │      │
         products ◄── marketplace_product_mappings ──► variants ┄┄(sku)┄┄► inventory
                                 │
    orders.channel_id ───────────┘
       ▲
       │ internal_order_id
   marketplace_orders ◄── marketplace_order_lines ──► order_items ──► orders
```

Inbound flow: a marketplace order is pulled → `marketplace_orders` (raw payload, de-duplicated) → an internal `orders` row with `channel_id` set → `order_items` + `marketplace_order_lines` → stock committed through `lib/inventory.ts` → the `push_inventory` job updates every mapping for the affected SKUs on the other channels.

Outbound flow: a product or variant changes (`updated_at`) → a `push_products` job → `marketplace_product_mappings` upsert.

### 5.7 Decisions needed before writing migrations

1. **Marketplace buyers vs `customers`:** create `customers` rows for marketplace buyers (which may have relay or masked emails), or store the buyer only on the order? `orders.customer_email` is NOT NULL, so masked buyers would need a placeholder email.
2. **Mapping granularity:** product-level listings (Etsy / eBay item groups) with variant rows underneath, or variant-only mappings?
3. **Inventory policy:** one shared stock pool with a per-channel buffer, or fixed allocations per channel?
4. **Fix order:** issues A to F (§5.2) are separate from the schema work and could ship first.
5. **Migration numbering:** use `038` for the marketplace repair. Should the existing inline `037_marketplace_*` names stay as they are? Renaming them would make already-deployed DOs re-run them.

---

## Appendix: every table (generated)

Columns are listed as `name type` (`PK`, `!` NOT NULL). FK = declared foreign key. Indexes exclude the automatic primary-key index.

### `account`
- **PK:** `id`
- **FK:** `user_id` → `user.id` (CASCADE)
- **Indexes:** none
- **Columns:** `id` TEXT PK, `account_id` TEXT !, `provider_id` TEXT !, `user_id` TEXT !, `access_token` TEXT, `refresh_token` TEXT, `id_token` TEXT, `access_token_expires_at` INTEGER, `refresh_token_expires_at` INTEGER, `scope` TEXT, `password` TEXT, `created_at` INTEGER !, `updated_at` INTEGER !

### `ai_token_balances`
- **PK:** `customer_id`
- **FK:** `customer_id` → `customers.id` (CASCADE)
- **Indexes:** idx_ai_token_balances_api_key(`api_key`) unique
- **Columns:** `customer_id` TEXT PK, `api_key` TEXT !, `balance_units` INTEGER !, `updated_at` TEXT !

### `ai_token_transactions`
- **PK:** `id`
- **FK:** `order_id` → `orders.id` (SET NULL); `customer_id` → `customers.id` (SET NULL)
- **Indexes:** idx_ai_token_transactions_order(`order_id`); idx_ai_token_transactions_api_key(`api_key, created_at`)
- **Columns:** `id` TEXT PK, `api_key` TEXT !, `customer_id` TEXT, `order_id` TEXT, `amount` INTEGER !, `type` TEXT !, `note` TEXT, `created_at` TEXT !

### `api_keys`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_api_keys_hash(`key_hash`); UNIQUE(`key_hash`)
- **Columns:** `id` TEXT PK, `key_hash` TEXT !, `key_prefix` TEXT !, `role` TEXT !, `created_at` TEXT !

### `cart_items`
- **PK:** `id`
- **FK:** `cart_id` → `carts.id`
- **Indexes:** idx_cart_items_cart_id(`cart_id`)
- **Columns:** `id` TEXT PK, `cart_id` TEXT !, `sku` TEXT !, `title` TEXT !, `qty` INTEGER !, `unit_price_cents` INTEGER !, `currency` TEXT !

### `carts`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_carts_shipping_country(`shipping_country`); idx_carts_region(`region_id`); idx_carts_status(`status`); idx_carts_expires(`expires_at`)
- **Columns:** `id` TEXT PK, `status` TEXT !, `customer_email` TEXT !, `currency` TEXT !, `region_id` TEXT, `stripe_checkout_session_id` TEXT, `discount_code` TEXT, `discount_id` TEXT, `discount_amount_cents` INTEGER, `shipping_rate_id` TEXT, `shipping_cents` INTEGER, `locale` TEXT !, `shipping_name` TEXT, `shipping_line1` TEXT, `shipping_line2` TEXT, `shipping_city` TEXT, `shipping_state` TEXT, `shipping_postal_code` TEXT, `shipping_country` TEXT, `billing_same_as_shipping` INTEGER, `taxes_json` TEXT, `expires_at` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `categories`
- **PK:** `id`
- **FK:** `parent_id` → `categories.id` (SET NULL)
- **Indexes:** idx_categories_parent(`parent_id`); idx_categories_handle_active(`handle`); UNIQUE(`handle`)
- **Columns:** `id` TEXT PK, `handle` TEXT !, `name` TEXT !, `description` TEXT, `parent_id` TEXT, `image_url` TEXT, `thumbnail_url` TEXT, `position` INTEGER !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `config`
- **PK:** `key`
- **FK:** none
- **Indexes:** none
- **Columns:** `key` TEXT PK, `value` TEXT !, `updated_at` TEXT !

### `countries`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_countries_status(`status`); idx_countries_code(`code`); UNIQUE(`code`)
- **Columns:** `id` TEXT PK, `code` TEXT !, `display_name` TEXT !, `country_name` TEXT !, `language_code` TEXT !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `currencies`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_currencies_status(`status`); idx_currencies_code(`code`); UNIQUE(`code`)
- **Columns:** `id` TEXT PK, `code` TEXT !, `display_name` TEXT !, `symbol` TEXT !, `decimal_places` INTEGER !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `customer_addresses`
- **PK:** `id`
- **FK:** `customer_id` → `customers.id` (CASCADE)
- **Indexes:** idx_customer_addresses_customer(`customer_id`)
- **Columns:** `id` TEXT PK, `customer_id` TEXT !, `label` TEXT, `is_default` INTEGER, `name` TEXT, `company` TEXT, `line1` TEXT !, `line2` TEXT, `city` TEXT !, `state` TEXT, `postal_code` TEXT !, `country` TEXT !, `phone` TEXT, `created_at` TEXT !, `updated_at` TEXT !

### `customers`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_customers_auth_provider_id(`auth_provider_id`); idx_customers_created_at(`created_at`); idx_customers_last_order(`last_order_at`); idx_customers_email(`email`); UNIQUE(`email`)
- **Columns:** `id` TEXT PK, `email` TEXT !, `name` TEXT, `phone` TEXT, `password_hash` TEXT, `email_verified_at` TEXT, `auth_provider` TEXT, `auth_provider_id` TEXT, `accepts_marketing` INTEGER, `locale` TEXT, `metadata` TEXT, `order_count` INTEGER, `total_spent_cents` INTEGER, `created_at` TEXT !, `updated_at` TEXT !, `last_order_at` TEXT

### `digital_assets`
- **PK:** `id`
- **FK:** `sku` → `inventory.sku` (CASCADE)
- **Indexes:** UNIQUE(`sku`)
- **Columns:** `id` TEXT PK, `sku` TEXT !, `storage_type` TEXT !, `storage_value` TEXT !, `filename` TEXT !, `content_type` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `discount_usage`
- **PK:** `id`
- **FK:** `order_id` → `orders.id`; `discount_id` → `discounts.id`
- **Indexes:** idx_discount_usage_order_discount(`order_id, discount_id`) unique; idx_discount_usage_customer(`discount_id, customer_email`); idx_discount_usage_order(`order_id`)
- **Columns:** `id` TEXT PK, `discount_id` TEXT !, `order_id` TEXT !, `customer_email` TEXT !, `discount_amount_cents` INTEGER !, `created_at` TEXT !

### `discounts`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_discounts_status(`status`); idx_discounts_code(`code`); UNIQUE(`code`)
- **Columns:** `id` TEXT PK, `code` TEXT, `type` TEXT !, `value` INTEGER !, `status` TEXT !, `min_purchase_cents` INTEGER, `max_discount_cents` INTEGER, `starts_at` TEXT, `expires_at` TEXT, `usage_limit` INTEGER, `usage_limit_per_customer` INTEGER, `usage_count` INTEGER !, `stripe_coupon_id` TEXT, `stripe_promotion_code_id` TEXT, `created_at` TEXT !, `updated_at` TEXT !

### `events`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_events_type_processed(`type, processed_at`); idx_events_stripe_event_id(`stripe_event_id`); UNIQUE(`stripe_event_id`)
- **Columns:** `id` TEXT PK, `stripe_event_id` TEXT, `type` TEXT !, `payload` TEXT !, `processed_at` TEXT !

### `inventory`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_inventory_sku(`sku`); UNIQUE(`sku`)
- **Columns:** `id` TEXT PK, `sku` TEXT !, `on_hand` INTEGER !, `reserved` INTEGER !, `updated_at` TEXT !

### `inventory_logs`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_inventory_logs_sku_created(`sku, created_at`)
- **Columns:** `id` TEXT PK, `sku` TEXT !, `delta` INTEGER !, `reason` TEXT !, `created_at` TEXT !

### `marketplace_channels`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_marketplace_channels_store(`store_id`); idx_marketplace_channels_platform(`platform`)
- **Columns:** `id` TEXT PK, `platform` TEXT !, `store_id` TEXT !, `external_shop_id` TEXT, `config_json` TEXT !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `marketplace_credentials`
- **PK:** `id`
- **FK:** `channel_id` → `marketplace_channels.id`
- **Indexes:** idx_marketplace_credentials_channel(`channel_id`); UNIQUE(`channel_id, credential_type`)
- **Columns:** `id` TEXT PK, `channel_id` TEXT !, `credential_type` TEXT !, `encrypted_value` TEXT !, `metadata` TEXT, `created_at` TEXT !, `updated_at` TEXT !

### `marketplace_orders`
- **PK:** `id`
- **FK:** `internal_order_id` → `orders.id`; `channel_id` → `marketplace_channels.id`
- **Indexes:** idx_marketplace_orders_channel(`channel_id`)
- **Columns:** `id` TEXT PK, `channel_id` TEXT !, `internal_order_id` TEXT, `external_order_id` TEXT !, `status` TEXT !, `raw_payload` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `marketplace_product_mappings`
- **PK:** `id`
- **FK:** `variant_id` → `variants.id`; `channel_id` → `marketplace_channels.id`
- **Indexes:** idx_marketplace_product_mappings_channel(`channel_id`); UNIQUE(`channel_id, external_listing_id`)
- **Columns:** `id` TEXT PK, `channel_id` TEXT !, `variant_id` TEXT, `external_listing_id` TEXT !, `external_sku` TEXT, `status` TEXT !, `last_sync_at` TEXT, `created_at` TEXT !

### `marketplace_sync_jobs`
- **PK:** `id`
- **FK:** `channel_id` → `marketplace_channels.id`
- **Indexes:** idx_marketplace_sync_jobs_channel_status(`channel_id, status`)
- **Columns:** `id` TEXT PK, `channel_id` TEXT !, `job_type` TEXT !, `status` TEXT !, `payload` TEXT, `error_message` TEXT, `attempts` INTEGER !, `created_at` TEXT !, `updated_at` TEXT !

### `migrations`
- **PK:** `name`
- **FK:** none
- **Indexes:** none
- **Columns:** `name` TEXT PK, `applied_at` TEXT !

### `oauth_authorizations`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_oauth_authorizations_client(`client_id`)
- **Columns:** `id` TEXT PK, `client_id` TEXT !, `redirect_uri` TEXT !, `scope` TEXT !, `state` TEXT, `code_challenge` TEXT !, `customer_email` TEXT, `magic_token_hash` TEXT, `magic_expires_at` TEXT, `code_hash` TEXT, `code_expires_at` TEXT, `status` TEXT !, `expires_at` TEXT !, `created_at` TEXT !

### `oauth_clients`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_oauth_clients_client_id(`client_id`); UNIQUE(`client_id`)
- **Columns:** `id` TEXT PK, `client_id` TEXT !, `client_secret_hash` TEXT, `name` TEXT !, `redirect_uris` TEXT !, `created_at` TEXT !

### `oauth_tokens`
- **PK:** `id`
- **FK:** `customer_id` → `customers.id`
- **Indexes:** idx_oauth_tokens_customer(`customer_id`); idx_oauth_tokens_refresh(`refresh_token_hash`); idx_oauth_tokens_access(`access_token_hash`)
- **Columns:** `id` TEXT PK, `client_id` TEXT !, `customer_id` TEXT !, `access_token_hash` TEXT !, `refresh_token_hash` TEXT !, `scope` TEXT !, `access_expires_at` TEXT !, `refresh_expires_at` TEXT !, `created_at` TEXT !

### `order_email_settings`
- **PK:** `id`
- **FK:** none
- **Indexes:** UNIQUE(`event`)
- **Columns:** `id` TEXT PK, `event` TEXT !, `enabled` INTEGER !, `subject` TEXT !, `html_body` TEXT !, `text_body` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `order_items`
- **PK:** `id`
- **FK:** `order_id` → `orders.id`
- **Indexes:** idx_order_items_order_id(`order_id`)
- **Columns:** `id` TEXT PK, `order_id` TEXT !, `sku` TEXT !, `title` TEXT !, `qty` INTEGER !, `unit_price_cents` INTEGER !

### `orders`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_orders_payment_gateway(`payment_gateway`); idx_orders_sslcommerz_tran(`sslcommerz_tran_id`); idx_orders_viewtoken(`viewtoken`) unique; idx_orders_warehouse(`warehouse_id`); idx_orders_region(`region_id`); idx_orders_number(`number`); idx_orders_email_created(`customer_email, created_at`); idx_orders_status_created(`status, created_at`); idx_orders_email(`customer_email`); idx_orders_status(`status`); idx_orders_customer(`customer_id`); UNIQUE(`number`)
- **Columns:** `id` TEXT PK, `customer_id` TEXT, `number` TEXT !, `status` TEXT !, `customer_email` TEXT !, `region_id` TEXT, `warehouse_id` TEXT, `shipping_name` TEXT, `shipping_phone` TEXT, `ship_to` TEXT, `subtotal_cents` INTEGER !, `tax_cents` INTEGER !, `shipping_cents` INTEGER !, `shipping_rate_id` TEXT, `total_cents` INTEGER !, `currency` TEXT !, `discount_code` TEXT, `discount_id` TEXT, `discount_amount_cents` INTEGER, `tracking_number` TEXT, `tracking_url` TEXT, `shipped_at` TEXT, `stripe_checkout_session_id` TEXT, `stripe_payment_intent_id` TEXT, `taxes_json` TEXT, `viewtoken` TEXT, `viewtoken_issued_at` TEXT, `confirmationemailsentat` TEXT, `confirmationemaillasterror` TEXT, `confirmationemailupdatedat` TEXT, `locale` TEXT !, `created_at` TEXT !, `sslcommerz_tran_id` TEXT, `payment_gateway` TEXT

### `product_categories`
- **PK:** `product_id`, `category_id`
- **FK:** `category_id` → `categories.id` (CASCADE); `product_id` → `products.id` (CASCADE)
- **Indexes:** idx_product_categories_category(`category_id, position`)
- **Columns:** `product_id` TEXT PK, `category_id` TEXT PK, `position` INTEGER !

### `product_reviews`
- **PK:** `id`
- **FK:** `order_id` → `orders.id` (SET NULL); `customer_id` → `customers.id` (SET NULL); `product_id` → `products.id` (CASCADE)
- **Indexes:** idx_product_reviews_customer(`customer_id`); idx_product_reviews_product(`product_id, status, created_at`)
- **Columns:** `id` TEXT PK, `product_id` TEXT !, `customer_id` TEXT, `author_name` TEXT !, `author_email` TEXT !, `rating` INTEGER !, `title` TEXT, `body` TEXT, `status` TEXT !, `is_verified_purchase` INTEGER !, `order_id` TEXT, `helpful_count` INTEGER !, `created_at` TEXT !, `updated_at` TEXT !

### `products`
- **PK:** `id`
- **FK:** `shipping_class_id` → `shipping_classes.id`
- **Indexes:** idx_products_handle(`handle`) unique; idx_products_vendor(`vendor`); idx_products_shipping_class(`shipping_class_id`); idx_products_status(`status`); UNIQUE(`handle`)
- **Columns:** `id` TEXT PK, `title` TEXT !, `description` TEXT, `image_url` TEXT, `shipping_class_id` TEXT, `vendor` TEXT, `tags` TEXT, `handle` TEXT, `status` TEXT !, `review_count` INTEGER !, `average_rating` REAL !, `created_at` TEXT !

### `refunds`
- **PK:** `id`
- **FK:** `order_id` → `orders.id`
- **Indexes:** idx_refunds_order_id(`order_id`)
- **Columns:** `id` TEXT PK, `order_id` TEXT !, `stripe_refund_id` TEXT !, `amount_cents` INTEGER !, `currency` TEXT !, `reason` TEXT, `notes` TEXT, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `region_countries`
- **PK:** `region_id`, `country_id`
- **FK:** `country_id` → `countries.id` (CASCADE); `region_id` → `regions.id` (CASCADE)
- **Indexes:** idx_region_countries_country(`country_id`); idx_region_countries_region(`region_id`)
- **Columns:** `region_id` TEXT PK, `country_id` TEXT PK

### `region_shipping_rates`
- **PK:** `region_id`, `shipping_rate_id`
- **FK:** `shipping_rate_id` → `shipping_rates.id` (CASCADE); `region_id` → `regions.id` (CASCADE)
- **Indexes:** idx_region_shipping_rates_region(`region_id`)
- **Columns:** `region_id` TEXT PK, `shipping_rate_id` TEXT PK

### `region_warehouses`
- **PK:** `region_id`, `warehouse_id`
- **FK:** `warehouse_id` → `warehouses.id` (CASCADE); `region_id` → `regions.id` (CASCADE)
- **Indexes:** idx_region_warehouses_warehouse(`warehouse_id`); idx_region_warehouses_region(`region_id`)
- **Columns:** `region_id` TEXT PK, `warehouse_id` TEXT PK

### `regions`
- **PK:** `id`
- **FK:** `currency_id` → `currencies.id`
- **Indexes:** idx_regions_currency(`currency_id`); idx_regions_default(`is_default`); idx_regions_status(`status`)
- **Columns:** `id` TEXT PK, `display_name` TEXT !, `currency_id` TEXT !, `tax_inclusive` INTEGER !, `is_default` INTEGER !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `saved_carts`
- **PK:** `id`
- **FK:** `cart_id` → `carts.id` (CASCADE)
- **Indexes:** idx_saved_carts_user(`user_id`); UNIQUE(`user_id, cart_id`)
- **Columns:** `id` INTEGER PK, `user_id` TEXT !, `cart_id` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `session`
- **PK:** `id`
- **FK:** `user_id` → `user.id` (CASCADE)
- **Indexes:** UNIQUE(`token`)
- **Columns:** `id` TEXT PK, `expires_at` INTEGER !, `token` TEXT !, `created_at` INTEGER !, `updated_at` INTEGER !, `ip_address` TEXT, `user_agent` TEXT, `user_id` TEXT !

### `shipping_classes`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_shipping_classes_status(`status`); idx_shipping_classes_code(`code`); UNIQUE(`code`)
- **Columns:** `id` TEXT PK, `code` TEXT !, `display_name` TEXT !, `description` TEXT, `resolution` TEXT !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `shipping_rate_prices`
- **PK:** `id`
- **FK:** `currency_id` → `currencies.id` (CASCADE); `shipping_rate_id` → `shipping_rates.id` (CASCADE)
- **Indexes:** UNIQUE(`shipping_rate_id, currency_id`)
- **Columns:** `id` TEXT PK, `shipping_rate_id` TEXT !, `currency_id` TEXT !, `amount_cents` INTEGER !, `created_at` TEXT !

### `shipping_rates`
- **PK:** `id`
- **FK:** `shipping_class_id` → `shipping_classes.id`
- **Indexes:** idx_shipping_rates_shipping_class(`shipping_class_id`); idx_shipping_rates_status(`status`)
- **Columns:** `id` TEXT PK, `display_name` TEXT !, `description` TEXT, `max_weight_g` INTEGER, `min_delivery_days` INTEGER, `max_delivery_days` INTEGER, `tax_code` TEXT, `tax_inclusive` INTEGER !, `shipping_class_id` TEXT, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `store_themes`
- **PK:** `id`
- **FK:** none
- **Indexes:** none
- **Columns:** `id` TEXT PK, `name` TEXT !, `is_active` INTEGER !, `config_json` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `tax_rates`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_tax_rates_tax_code(`tax_code`); idx_tax_rates_country(`country_code`)
- **Columns:** `id` TEXT PK, `display_name` TEXT !, `country_code` TEXT, `tax_code` TEXT, `rate_percentage` REAL !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `ucp_checkout_sessions`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_ucp_checkout_sessions_expires(`expires_at`); idx_ucp_checkout_sessions_stripe(`stripe_session_id`); idx_ucp_checkout_sessions_status(`status`)
- **Columns:** `id` TEXT PK, `status` TEXT !, `currency` TEXT !, `line_items` TEXT !, `buyer` TEXT, `totals` TEXT !, `messages` TEXT, `payment_instruments` TEXT, `stripe_session_id` TEXT, `order_id` TEXT, `order_number` TEXT, `expires_at` TEXT, `created_at` TEXT !, `updated_at` TEXT !

### `user`
- **PK:** `id`
- **FK:** none
- **Indexes:** UNIQUE(`email`)
- **Columns:** `id` TEXT PK, `name` TEXT !, `email` TEXT !, `email_verified` INTEGER !, `image` TEXT, `created_at` INTEGER !, `updated_at` INTEGER !

### `variant_prices`
- **PK:** `id`
- **FK:** `currency_id` → `currencies.id` (CASCADE); `variant_id` → `variants.id` (CASCADE)
- **Indexes:** idx_variant_prices_currency(`currency_id`); idx_variant_prices_variant(`variant_id`); UNIQUE(`variant_id, currency_id`)
- **Columns:** `id` TEXT PK, `variant_id` TEXT !, `currency_id` TEXT !, `price_cents` INTEGER !, `created_at` TEXT !, `updated_at` TEXT !

### `variants`
- **PK:** `id`
- **FK:** `shipping_class_id` → `shipping_classes.id`; `product_id` → `products.id`
- **Indexes:** idx_variants_type(`variant_type`); idx_variants_barcode(`barcode`); idx_variants_requires_shipping(`requires_shipping`); idx_variants_shipping_class(`shipping_class_id`); idx_variants_status(`status`); idx_variants_product(`product_id`); idx_variants_sku(`sku`); UNIQUE(`sku`)
- **Columns:** `id` TEXT PK, `product_id` TEXT !, `sku` TEXT !, `title` TEXT !, `price_cents` INTEGER !, `currency` TEXT !, `weight_g` INTEGER !, `dims_cm` TEXT, `requires_shipping` INTEGER !, `barcode` TEXT, `compare_at_price_cents` INTEGER, `tax_code` TEXT, `image_url` TEXT, `thumbnail_url` TEXT, `shipping_class_id` TEXT, `status` TEXT !, `created_at` TEXT !, `variant_type` TEXT !, `ai_token_units` INTEGER

### `verification`
- **PK:** `id`
- **FK:** none
- **Indexes:** none
- **Columns:** `id` TEXT PK, `identifier` TEXT !, `value` TEXT !, `expires_at` INTEGER !, `created_at` INTEGER, `updated_at` INTEGER

### `warehouse_inventory`
- **PK:** `id`
- **FK:** `warehouse_id` → `warehouses.id` (CASCADE)
- **Indexes:** idx_warehouse_inventory_warehouse(`warehouse_id`); idx_warehouse_inventory_sku(`sku`); UNIQUE(`sku, warehouse_id`)
- **Columns:** `id` TEXT PK, `sku` TEXT !, `warehouse_id` TEXT !, `on_hand` INTEGER !, `reserved` INTEGER !, `updated_at` TEXT !

### `warehouse_inventory_logs`
- **PK:** `id`
- **FK:** `warehouse_id` → `warehouses.id`
- **Indexes:** idx_warehouse_inventory_logs_sku(`sku, created_at`)
- **Columns:** `id` TEXT PK, `sku` TEXT !, `warehouse_id` TEXT !, `delta` INTEGER !, `reason` TEXT !, `created_at` TEXT !

### `warehouses`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_warehouses_priority(`priority`); idx_warehouses_status(`status`)
- **Columns:** `id` TEXT PK, `display_name` TEXT !, `address_line1` TEXT !, `address_line2` TEXT, `city` TEXT !, `state` TEXT, `postal_code` TEXT !, `country_code` TEXT !, `priority` INTEGER !, `status` TEXT !, `created_at` TEXT !, `updated_at` TEXT !

### `webhook_deliveries`
- **PK:** `id`
- **FK:** `webhook_id` → `webhooks.id`
- **Indexes:** idx_webhook_deliveries_status(`status`); idx_webhook_deliveries_webhook(`webhook_id`)
- **Columns:** `id` TEXT PK, `webhook_id` TEXT !, `event_type` TEXT !, `payload` TEXT !, `status` TEXT !, `attempts` INTEGER !, `last_attempt_at` TEXT, `response_code` INTEGER, `response_body` TEXT, `created_at` TEXT !

### `webhooks`
- **PK:** `id`
- **FK:** none
- **Indexes:** idx_webhooks_status(`status`)
- **Columns:** `id` TEXT PK, `url` TEXT !, `events` TEXT !, `secret` TEXT !, `status` TEXT !, `created_at` TEXT !
