/**
 * RBAC regression guard: a signed-in customer must not reach any admin route.
 *
 * Boots the real Worker (src/index.ts) on an in-memory MerchantDO and calls
 * every route in the OpenAPI document, plus the admin routers that are not in
 * it, the way a customer's browser does:
 *   - Better Auth session cookie of a non-admin user, with the storefront's
 *     public `pk_` key (what the storefront sends), and
 *   - the same cookie alone.
 * Every route must answer 401 or 403 unless it is listed in STOREFRONT below.
 *
 * If this test fails after you add a route:
 *   - admin route → add `adminOnly` (router `.use('*', authMiddleware, adminOnly)`
 *     or `middleware: [adminOnly]` on the route);
 *   - route meant for shoppers → add it to STOREFRONT, with a reason.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMerchantDb } from './helpers/merchant-db';
import { hashKey } from '../src/middleware/auth';

// The rate limiter counts per key; hundreds of calls would just return 429.
vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
// routes/images.ts reads the Workers-only `caches` global at import time.
vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
const { default: worker } = await import('../src/index');

const PK = 'pk_' + 'b'.repeat(48);
const COOKIE = 'better-auth.session_token=customer.sig';

/** Routes shoppers (or callbacks/agents with their own checks) are meant to reach. */
const STOREFRONT: Array<[method: string, path: RegExp, reason: string]> = [
  ['GET', /^\/\.well-known\/ucp$/, 'UCP discovery'],
  ['*', /^\/ucp\/v1\//, 'UCP: AI shopping agents (catalogue + checkout sessions)'],
  ['GET', /^\/v1\/(products|categories|banners|payment-methods)(\/|$)/, 'catalogue'],
  ['GET', /^\/v1\/storefront\//, 'storefront settings, home sections, best sellers'],
  ['GET', /^\/v1\/images\/\{key\}$/, 'image files'],
  ['*', /^\/v1\/carts(\/|$)/, 'cart and checkout'],
  ['*', /^\/v1\/me\//, 'customer account (customerAuthMiddleware: own data only)'],
  ['GET', /^\/v1\/orders\/:orderId\/downloads$/, 'own digital downloads (customerAuthMiddleware)'],
  ['GET', /^\/v1\/orders\/(lookup|\{orderId\}\/status)$/, 'order view link (signed token)'],
  ['*', /^\/v1\/products\/\{productId\}\/reviews/, 'product reviews'],
  ['POST', /^\/v1\/setup\/init$/, 'first-run key bootstrap; 409 once keys exist'],
  ['*', /^\/v1\/ai-tokens\/proxy\//, 'AI proxy: checks its own API key'],
  ['POST', /^\/v1\/webhooks\/sslcommerz\/ipn$/, 'payment callback: validated with the gateway'],
];

/** Admin routers that are plain Hono (not in the OpenAPI document). */
const EXTRA_ADMIN_ROUTES: Array<[string, string]> = [
  ['PUT', '/v1/admin/digital-assets/upload/x'],
  ['GET', '/v1/admin/marketplace/channels'],
  ['PATCH', '/v1/admin/marketplace/channels/x/config'],
  ['POST', '/v1/marketplace/connect/etsy'],
  ['GET', '/v1/marketplace/x/status'],
  ['POST', '/v1/marketplace/x/orders/import'],
  ['POST', '/v1/marketplace/x/sync/products'],
];

const isStorefront = (method: string, path: string) =>
  STOREFRONT.some(([m, re]) => (m === '*' || m === method) && re.test(path));

async function setup() {
  const ENV = {
    API_BASE_URL: 'https://api.shop.test',
    STORE_URL: 'https://shop.test',
    ADMIN_EMAILS: 'boss@shop.test',
    BETTER_AUTH_SECRET: 'x'.repeat(40),
  };
  const { merchant, ready } = createMerchantDb(ENV);
  await ready();
  // Test double: reach into the DO's SQL storage and replace its session RPC.
  const m = merchant as unknown as {
    sql: { exec: (q: string, ...a: unknown[]) => unknown };
    getSessionForCookie: (cookie: string) => Promise<unknown>;
  };
  m.sql.exec(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k', ?, 'pk_bbbb', 'public')`, await hashKey(PK));
  m.sql.exec(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'Cust', 'cust@x.test', 1, 0, 0)`);
  m.getSessionForCookie = async () => ({ userId: 'u1', email: 'cust@x.test', name: 'Cust' });

  const kv = new Map<string, string>();
  const env = {
    ...ENV,
    MERCHANT: { idFromName: () => 'id', get: () => merchant },
    KV_CACHE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [], list_complete: true }),
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const call = async (method: string, path: string, headers: Record<string, string>) => {
    const url = 'https://api.shop.test' + path.replace(/\{[^}]+\}|:\w+(\{[^}]*\})?/g, 'x');
    const res = await worker.fetch(
      new Request(url, {
        method,
        headers: { ...headers, 'Content-Type': 'application/json', Origin: 'https://shop.test' },
        body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
      }),
      env as never,
      ctx as never,
    );
    return res.status;
  };
  const openapi = async () =>
    (await (await worker.fetch(new Request('https://api.shop.test/openapi.json'), env as never, ctx as never)).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
  return { call, openapi };
}

describe('RBAC: customers cannot reach admin routes', () => {
  it('every non-storefront route rejects a customer session (with or without the pk_ key)', async () => {
    const { call, openapi } = await setup();
    const doc = await openapi();

    const routes: Array<[string, string]> = [...EXTRA_ADMIN_ROUTES];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) routes.push([method.toUpperCase(), path]);
    }
    const adminRoutes = routes.filter(([m, p]) => !isStorefront(m, p));
    // Guard against the check silently testing nothing.
    expect(adminRoutes.length).toBeGreaterThan(100);

    const leaks: string[] = [];
    for (const [method, path] of adminRoutes) {
      for (const [who, headers] of [
        ['customer+pk', { Cookie: COOKIE, Authorization: `Bearer ${PK}` }],
        ['customer', { Cookie: COOKIE }],
      ] as const) {
        const status = await call(method, path, headers);
        if (status !== 401 && status !== 403) leaks.push(`${who}: ${method} ${path} → ${status}`);
      }
    }
    expect(leaks).toEqual([]);
  }, 60_000);

  it('the same customer can use their own account routes', async () => {
    const { call } = await setup();
    for (const path of ['/v1/me/profile', '/v1/me/orders', '/v1/me/addresses', '/v1/me/wishlist']) {
      expect(await call('GET', path, { Cookie: COOKIE, Authorization: `Bearer ${PK}` })).toBe(200);
    }
  });
});
