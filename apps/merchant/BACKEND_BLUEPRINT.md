# Backend Customization Blueprint

**Purpose:** Guide developers through customizing the Cloudflare Worker backend for multiple clients — different brand identities, payment gateways, email templates, shipping rules, marketplace integrations, and feature toggles.

---

## 1. Architecture Overview

The backend is a **Cloudflare Worker** (Hono + OpenAPI) backed by a **Durable Object** running SQLite. It serves three audiences simultaneously:

| Audience | Route prefix | Auth method |
|----------|-------------|-------------|
| **Public storefront** | `/v1/*` (GET only), `/api/auth/*`, `/.well-known/ucp` | None or Better Auth session cookie |
| **Admin dashboard** | `/v1/admin/*`, `/v1/me/*` | Admin API key (`sk_`) or Better Auth session |
| **OAuth integrations** | `/v1/marketplace/*`, `/oauth/*` | OAuth token (64-char hex) with scoped access |

The worker is a single entry point in `src/index.ts` that mounts route modules via `app.route()`. The Durable Object (`MerchantDO`) owns all database state and runs migrations automatically.

---

## 2. Environment Configuration

### 2.1 Worker Bindings (`Env` type)

All client-specific configuration flows through **Cloudflare secrets** (set in Wrangler or the Cloudflare dashboard). See `src/types.ts:28-174` for the full list. Key variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `STORE_URL` | Public storefront URL for order links | None (required) |
| `STORE_NAME` | Store display name in emails | `"Fufuni Store"` |
| `BETTER_AUTH_SECRET` | Signs session cookies (≥32 chars) | Required |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | Stripe payment processing | Optional |
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming Stripe webhooks | Optional |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` | Transactional email delivery | None (disabled if absent) |
| `ORDER_TOKEN_SECRET` | Signs order view tokens (≥32 chars) | Required |
| `AI_API_KEY`, `AI_MODEL`, `AI_API_URL` | AI product description translation | Optional |
| `CRYPTOKEN` | Decrypts encrypted config values in DB | Required for payment gateways |
| `KV_CACHE` / `KV_CACHE_DEFAULT_TTL_SECONDS` | KV namespace + cache TTL | 3600s default |

### 2.2 Per-Client Configuration Strategy

**Option A: Shared backend, per-store settings in DB**

All clients share one worker deployment. Branding is stored in the `config` table or `store_themes` table. Each client's admin panel sets their own `STORE_NAME`, payment credentials, and email templates via API.

**Option B: Separate deployments per client**

Duplicate the worker with different Wrangler bindings (different `STRIPE_SECRET_KEY`, `MAILGUN_*`, etc.). Use separate Cloudflare accounts or sub-accounts for isolation.

**Recommended:** Option A for most cases — it keeps a single codebase, shared migrations, and easier updates.

---

## 3. Database Schema Customization

### 3.1 How Schema Evolution Works

The Durable Object (`src/do.ts`) embeds the full schema in a `SCHEMA` constant (line 53). Migrations run automatically on first access via `ensureInitialized()`. The migration system:

1. Creates all base tables from `SCHEMA`
2. Runs incremental migrations from the `migrations` array (each has `{ name, sql }`)
3. Records applied migrations in the `migrations` table
4. Silently ignores failures (marks as applied to prevent retry loops)

### 3.2 Adding a New Table or Column

1. **Add to `SCHEMA`** — insert the CREATE TABLE or ALTER TABLE into the base schema string
2. **Add a migration entry** in the `migrations` array with a unique `name` and the SQL to run
3. **Re-deploy** — the DO will apply it on first request

### 3.3 Adding a New Config Key

Store client-specific settings in the `config` table via the existing key-value pattern:

```sql
INSERT OR REPLACE INTO config (key, value, updated_at)
  VALUES ('client_brand.logo_url', '"https://example.com/logo.png"', datetime('now'));
```

Then read it from route handlers:

```ts
const [row] = await db.query<any>(`SELECT value FROM config WHERE key = 'client_brand.logo_url'`);
const logoUrl = row ? JSON.parse(row.value) : null;
```

### 3.4 Extending the Customer Table

Add columns to the `customers` table via migration SQL:

```sql
ALTER TABLE customers ADD COLUMN loyalty_tier TEXT DEFAULT 'bronze';
```

Then update route handlers in `src/routes/customers.ts` to read/write the new field.

---

## 4. Route Customization

### 4.1 Route Mounting Pattern

All routes are mounted in `src/index.ts`:

```ts
app.route('/v1/products', adminCatalog);       // Admin-only (has authMiddleware)
app.route('/v1/orders', publicOrders);          // Public + authenticated
app.route('/v1/categories', publicCategories);  // Public only
```

The route module file exports a Hono app. The `admin*` variants include their own `use('*', adminOnly)` middleware.

### 4.2 Adding a New Route Module

1. **Create the route file:**

   ```ts
   // src/routes/my-feature.ts
   import { OpenAPIHono } from '@hono/zod-openapi';
   import { getDb } from '../db';
   import { adminOnly } from '../middleware/auth';

   const app = new OpenAPIHono();
   app.use('*', adminOnly);

   app.get('/my-feature', async (c) => {
     const db = getDb(c.var.db);
     // ... handler logic
     return c.json({ data: 'hello' });
   });

   export { app as myFeature };
   ```

2. **Mount it in `src/index.ts`:**

   ```ts
   import { myFeature } from './routes/my-feature';
   // ...
   app.route('/v1/my-feature', myFeature);
   ```

### 4.3 Adding a Public-Only Route (No Auth)

```ts
app.use('*', async (c, next) => {
  // Custom middleware that runs before auth
  const startTime = Date.now();
  await next();
  console.log(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${Date.now() - startTime}ms)`);
});
```

### 4.4 Modifying Existing Route Responses

Each route module is self-contained. To change a response:

- Find the route file (e.g., `src/routes/catalog.ts`)
- Edit the handler function directly
- The OpenAPI schema (`z.object(...)`) defines the response shape — update it to match

---

## 5. Authentication & Authorization

### 5.1 Auth Roles

Defined in `src/types.ts:204-215`:

| Role | Trigger | Access |
|------|---------|--------|
| `public` | No token or `pk_` API key | Public routes only |
| `admin` | `sk_` API key or Better Auth session | Admin routes |
| `oauth` | 64-char hex OAuth token with scopes | Marketplace integrations |
| `customer` | Better Auth session cookie (customer-facing) | `/v1/me/*`, downloads |
| `databaseadmin` | Token with `admin:database` permission | DB admin operations |
| `aiadmin` | Token with AI permission | AI parameter routes |
| `mail` | Token with `mail:api` permission | Mail sending routes |

### 5.2 Adding a New Auth Role

1. **Extend the `AuthRole` type** in `src/types.ts:215`
2. **Add a role-gate middleware** in `src/middleware/auth.ts`:

   ```ts
   export const myFeatureAccessOnly = createMiddleware<HonoEnv>(async (c, next) => {
     const auth = c.get('auth');
     if (!auth.role.includes('myfeature')) throw ApiError.forbidden();
     await next();
   });
   ```

3. **Use it in route modules:**

   ```ts
   import { myFeatureAccessOnly } from '../middleware/auth';
   app.use('*', myFeatureAccessOnly);
   ```

### 5.3 Modifying Auth Middleware

The auth middleware (`src/middleware/auth.ts`) checks tokens in priority order:

1. **Better Auth session cookie** — validates against D1 `sessions` table
2. **Bearer token** — OAuth hex token (64-char) or API key (`sk_`/`pk_` prefix)

To add a new token format (e.g., JWT-based), insert a new priority block between the existing checks.

---

## 6. Email Template Customization

### 6.1 Email System Overview

Transactional emails are sent via Mailgun (`src/mailgun.ts`) using templates from `src/lib/order-email.ts`:

- **Order confirmation** — sent on successful checkout
- **Status change emails** — shipped, delivered, refunded, etc. (configurable per-event)

### 6.2 Customizing Email Templates

Templates are stored in the `order_email_settings` table:

| Column | Purpose |
|--------|---------|
| `event` | Event trigger (`global`, `pending`, `paid`, `shipped`, `delivered`, `refunded`, `canceled`) |
| `enabled` | Whether to send this event's email |
| `subject` | Email subject (supports `{{storeName}}`, `{{orderNumber}}`, etc.) |
| `html_body` | HTML template body (supports same variables) |
| `text_body` | Plain-text fallback |

**To customize:** Call the admin API or run SQL directly:

```sql
INSERT OR REPLACE INTO order_email_settings (id, event, enabled, subject, html_body, text_body)
VALUES (
  'custom_shipped',
  'shipped',
  1,
  '{{storeName}} — Your order has shipped!',
  '<html>...custom HTML with {{trackingNumber}}...</html>',
  'Your order has shipped. Tracking: {{trackingNumber}}'
);
```

### 6.3 Template Variables

| Variable | Example |
|----------|---------|
| `{{storeName}}` | "My Awesome Shop" |
| `{{orderNumber}}` | "ORD-260316-AB12" |
| `{{orderUrl}}` | Full order tracking URL with signed token |
| `{{status}}` | Event name (shipped, delivered, etc.) |
| `{{total}}` | Formatted price ("€49.99") |
| `{{customerName}}` | Customer's shipping name |
| `{{trackingNumber}}` | Carrier tracking number |
| `{{trackingUrl}}` | Carrier tracking link |

### 6.4 Adding a New Email Type

1. **Add the event to the CHECK constraint** in the schema (requires migration)
2. **Call `sendOrderStatusEmail(env, db, orderId, 'new_event')`** from the webhook handler or route
3. **Create an admin UI** for configuring the template (optional)

---

## 7. Payment Gateway Customization

### 7.1 Stripe (Default)

Configured via `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` environment variables. Checkout flow:

1. Admin creates product variants with prices
2. Customer adds items to cart → `POST /v1/carts/checkout`
3. Worker calls Stripe API → creates Checkout Session
4. Stripe webhook (`order.created`) confirms payment → creates order

### 7.2 Adding a New Payment Gateway

1. **Add gateway config** to the `config` table:

   ```sql
   INSERT INTO config (key, value) VALUES ('payment_gateway.mygateway', '{"enabled":true,"api_key":"..."}');
   ```

2. **Create a gateway handler:**

   ```ts
   // src/lib/payment-gateways/mygateway.ts
   export async function createCheckoutSession(env: Env, cartId: string): Promise<{ url: string }> {
     // Gateway-specific checkout creation logic
   }
   ```

3. **Wire it into the checkout route** (`src/routes/checkout.ts`) — check which gateway is enabled and call the appropriate handler.

4. **Add IPN/webhook handler** if the gateway uses server-to-server callbacks (see `src/routes/sslcommerz-ipn.ts` as a reference).

### 7.3 SSLCommerz Reference Implementation

The project already has an SSLCommerz integration (`src/routes/sslcommerz-ipn.ts`) that demonstrates:
- Payment redirect URL generation
- IPN (Instant Payment Notification) webhook handling
- Order status update on payment confirmation

---

## 8. Shipping & Tax Customization

### 8.1 Shipping Classes

Products belong to shipping classes (`shipping_classes` table). Each class defines constraints (weight, dimensions). Shipping rates are tied to classes via `shipping_rates` and mapped to regions via `region_shipping_rates`.

**To add a new shipping class:**

```sql
INSERT INTO shipping_classes (id, code, display_name) VALUES ('cl_fragile', 'fragile', 'Fragile Items');
```

### 8.2 Shipping Rates

Rates are region-specific and currency-aware:

| Table | Purpose |
|-------|---------|
| `shipping_rates` | Defines rate names, weight limits, delivery windows |
| `shipping_rate_prices` | Maps each rate to a currency amount |
| `regions` | Groups countries into shipping zones |
| `region_shipping_rates` | Links rates to regions |

### 8.3 Tax Rates

Configured per-country via the `tax_rates` table:

```sql
INSERT INTO tax_rates (id, display_name, country_code, rate_percentage)
VALUES ('tx_eu_20', 'EU VAT', 'EU', 20);
```

Set `country_code = NULL` for a global fallback rate.

---

## 9. Marketplace Integrations

### 9.1 Supported Platforms

| Platform | Files | Status |
|----------|-------|--------|
| **Etsy** | `src/lib/marketplace/etsy.ts` | Implemented |
| **eBay** | `src/lib/marketplace/ebay.ts` | Implemented |
| **Amazon** | `src/lib/marketplace/amazon.ts` | Implemented (LWA tokens) |

### 9.2 Adding a New Marketplace

1. **Create the connector:**

   ```ts
   // src/lib/marketplace/newplatform.ts
   export async function authenticate(env: Env, config: any) { /* OAuth flow */ }
   export async function pushProducts(token: string, products: any[]) { /* Push listings */ }
   export async function pullOrders(token: string, since: Date) { /* Fetch orders */ }
   ```

2. **Register tables** — the `marketplace_channels` table (already in schema) stores platform connections.

3. **Create route handlers** — follow `src/routes/marketplace/connect.ts` pattern for OAuth connect flow.

4. **Add sync jobs** — use `marketplace_sync_jobs` table to track push/pull operations.

---

## 10. Caching Strategy

### 10.1 KV Cache Middleware

Public GET requests are cached in Cloudflare KV (`src/middleware/kv-cache.ts`). Cache rules:

| Path | TTL | Authenticated? |
|------|-----|-----------------|
| `/v1/products/*` | 3600s (default) or `KV_CACHE_DEFAULT_TTL_SECONDS` | Yes — cached for all public visitors |
| `/v1/categories/*` | Same as products | Yes |
| `/openapi.json` | Same as products | Yes |
| `/.well-known/ucp` | Same as products | Yes |
| Admin routes (`sk_` prefix) | Never cached | N/A |

### 10.2 Cache Invalidation

On successful mutations (POST/PUT/DELETE), the `kvInvalidateMiddleware` purges all keys matching the route prefix:

```ts
// e.g., POST /v1/products → invalidates v1/products/*, v1/products, openapi.json
```

### 10.3 Per-Client Cache TTL

Set environment variables to control TTL per client:

| Variable | Default | Purpose |
|----------|---------|---------|
| `KV_CACHE_DEFAULT_TTL_SECONDS` | 3600 | All cached responses |
| `KV_CACHE_SEARCH_TTL_SECONDS` | 300 | Search results |
| `KV_CACHE_REVIEWS_TTL_SECONDS` | 600 | Product reviews |

---

## 11. API Schema & Validation

### 11.1 Zod OpenAPI Schemas

All routes use `@hono/zod-openapi` for request/response validation and auto-generated OpenAPI docs:

```ts
const route = createRoute({
  method: 'post',
  path: '/products',
  request: { body: { content: { 'application/json': { schema: z.object({...}) } } } },
  responses: { 200: { content: { 'application/json': { schema: z.object({...}) } } } },
});
```

### 11.2 Adding a New Request Schema

Define the Zod schema inline or in `src/schemas.ts`:

```ts
// In src/schemas.ts
export const MyFeatureBody = z.object({
  name: z.string().min(1),
  price_cents: z.number().int().min(0),
});
```

Then reference it in the route:

```ts
request: { body: { content: { 'application/json': { schema: MyFeatureBody } } } },
```

### 11.3 OpenAPI Documentation

The API docs are available at `/docs` (Swagger UI) and `/openapi.json` (OpenAPI spec). They auto-update when route schemas change — no separate doc generation step needed.

---

## 12. Quick Reference: Files to Modify Per Client

| Goal | File(s) to modify |
|------|-------------------|
| Change store name / URL | Env vars `STORE_NAME`, `STORE_URL` (Cloudflare secrets) |
| Change email templates | `order_email_settings` table (SQL or admin API) |
| Add new API endpoint | New file in `src/routes/`, mount in `src/index.ts` |
| Modify auth roles | `src/types.ts` + `src/middleware/auth.ts` |
| Add payment gateway | New file in `src/lib/payment-gateways/`, wire into `src/routes/checkout.ts` |
| Change cache TTLs | Env vars (`KV_CACHE_*_TTL_SECONDS`) |
| Add database column | Update `SCHEMA` + add migration in `src/do.ts` |
| Enable/disable a feature | New config key in `config` table, check in route handlers |
| Customize error messages | Modify `src/types.ts:ApiError` static methods |
| Change rate limits | `src/config/rate-limits.ts` or env vars passed to `rateLimitMiddleware()` |

---

## 13. Common Customization Patterns

### 13.1 Feature Toggle via Config Table

```ts
const [row] = await db.query<any>(`SELECT value FROM config WHERE key = 'feature_dark_mode'`);
const enabled = row && JSON.parse(row.value) === true;
if (!enabled) return c.json({ error: 'Feature not available' }, 404);
```

### 13.2 Per-Client CORS Policy

Modify the CORS middleware in `src/index.ts`:

```ts
app.use('*', cors({
  origin: (origin) => {
    const allowed = c.env.CLIENT_CORS_ORIGINS?.split(',') || ['http://localhost:5173'];
    return allowed.includes(origin) ? origin : 'deny';
  },
}));
```

### 13.3 Custom Rate Limits Per Client

```ts
const tier = getTenantTier(c); // Read from config or subdomain
app.use('/v1/*', rateLimitMiddleware({ window: tier === 'enterprise' ? 600 : 60, max: tier === 'enterprise' ? 1000 : 10 }));
```

### 13.4 Disable Specific Endpoints for a Client

Add the path to `disabledPaths` in the auth handler config (`src/lib/auth.ts`):

```ts
return betterAuth({
  // ...
  disabledPaths: ['/api/auth/signin/email'], // disable email sign-in for this client
});
```

---

## 14. Gotchas & Pitfalls

- **Durable Object schema is embedded.** Adding a column requires updating both the `SCHEMA` constant AND the migration array. If you forget the migration, new deployments won't add the column to existing databases.
- **SQLite has no `ALTER TABLE ... DROP COLUMN`.** To remove a column, create a new table, copy data, drop old, rename — or just leave it and ignore unused columns.
- **KV cache is global across all clients.** If Client A updates a product, Client B's cache also invalidates (same prefix). This is usually fine but be aware of the coupling.
- **Better Auth creates tables on first use.** The `user`, `session`, `account`, `verification` tables are created via migration 037 — don't assume they exist before a user has signed up.
- **Mailgun emails fail silently if credentials are missing.** The code checks `MAILGUN_API_KEY && MAILGUN_DOMAIN` and returns success even without sending. Always verify in production.
- **The Durable Object is singleton per worker.** All requests for a given DO namespace hit the same instance. Long-running handlers block other requests — keep handlers fast (<100ms ideal).
- **`SCHEMA` string must be valid SQL when split on `;`.** A stray semicolon inside a string literal (e.g., in a CHECK constraint) will break migration parsing.
