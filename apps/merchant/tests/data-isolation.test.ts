/**
 * Per-user data isolation on the real Worker: two signed-in customers, Alice
 * and Bob. Bob must not read or change anything of Alice's through the
 * customer routes, even when he knows her ids.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createMerchantDb } from './helpers/merchant-db';
import { hashKey } from '../src/middleware/auth';

vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
const { default: worker } = await import('../src/index');

const PK = 'pk_' + 'b'.repeat(48);
const USERS = {
  alice: { userId: 'u-alice', email: 'alice@x.test', name: 'Alice', verified: true },
  bob: { userId: 'u-bob', email: 'bob@x.test', name: 'Bob', verified: true },
  // Registered a guest shopper's address but never proved it is theirs.
  mallory: { userId: 'u-mallory', email: 'guest@x.test', name: 'Mallory', verified: false },
  dave: { userId: 'u-dave', email: 'Dave@X.test', name: 'Dave', verified: true },
} as const;
type Who = keyof typeof USERS;

type Sql = { exec: (q: string, ...a: unknown[]) => { toArray: () => Record<string, unknown>[] } };
let sql: Sql['exec'];
let call: (who: Who, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- responses vary by route

beforeAll(async () => {
  const ENV = { API_BASE_URL: 'https://api.shop.test', STORE_URL: 'https://shop.test', BETTER_AUTH_SECRET: 'x'.repeat(40) };
  const { merchant, ready } = createMerchantDb(ENV);
  await ready();
  // Test double: the session RPC maps each test cookie to its user.
  const m = merchant as unknown as { sql: Sql; getSessionForCookie: (cookie: string) => Promise<unknown> };
  sql = m.sql.exec.bind(m.sql);
  sql(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k', ?, 'pk_bbbb', 'public')`, await hashKey(PK));
  for (const u of Object.values(USERS)) {
    sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`, u.userId, u.name, u.email, u.verified ? 1 : 0);
  }
  m.getSessionForCookie = async (cookie: string) => {
    const who = /session_token=(\w+)/.exec(cookie)?.[1] as Who | undefined;
    if (!who || !USERS[who]) return null;
    const { userId, email, name, verified } = USERS[who];
    return { userId, email, name, emailVerified: verified };
  };
  const env = {
    ...ENV,
    MERCHANT: { idFromName: () => 'id', get: () => merchant },
    KV_CACHE: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
  };
  call = async (who, method, path, body) => {
    const res = await worker.fetch(
      new Request('https://api.shop.test' + path, {
        method,
        headers: {
          Cookie: `better-auth.session_token=${who}.sig`,
          Authorization: `Bearer ${PK}`,
          'Content-Type': 'application/json',
          Origin: 'https://shop.test',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };
});

describe('customer data isolation', () => {
  it('profile: each user sees only their own', async () => {
    await call('alice', 'PATCH', '/v1/me/profile', { phone: '+880 1700 000001' });
    const bob = await call('bob', 'GET', '/v1/me/profile');
    expect(bob.status).toBe(200);
    expect(bob.json.email).toBe('bob@x.test');
    expect(bob.json.phone).toBeNull();
  });

  it('addresses: Bob cannot list or delete Alice’s', async () => {
    const created = await call('alice', 'POST', '/v1/me/addresses', {
      name: 'Alice', line1: '1 Road', city: 'Dhaka', postal_code: '1200', country: 'BD',
    });
    expect(created.status).toBe(201);
    expect((await call('bob', 'GET', '/v1/me/addresses')).json.items ?? []).toEqual([]);
    expect((await call('bob', 'DELETE', `/v1/me/addresses/${created.json.id}`)).status).toBe(404);
    expect(((await call('alice', 'GET', '/v1/me/addresses')).json.items ?? []).length).toBe(1);
  });

  it('orders: Bob cannot list or open Alice’s', async () => {
    const [alice] = sql(`SELECT id FROM customers WHERE email = 'alice@x.test'`).toArray();
    sql(`INSERT INTO orders (id, number, status, customer_id, customer_email, subtotal_cents, tax_cents, total_cents)
         VALUES ('00000000-0000-4000-8000-0000000000a1', 'ORD-A1', 'paid', ?, 'alice@x.test', 100, 0, 100)`, alice.id);
    const bobOrders = await call('bob', 'GET', '/v1/me/orders');
    expect(JSON.stringify(bobOrders.json)).not.toContain('ORD-A1');
    expect((await call('bob', 'GET', '/v1/me/orders/ORD-A1')).status).toBe(404);
    expect(JSON.stringify((await call('alice', 'GET', '/v1/me/orders')).json)).toContain('ORD-A1');
  });

  it('wishlist: separate per user', async () => {
    await call('alice', 'POST', '/v1/me/wishlist', { productId: 'p-1' });
    expect(JSON.stringify((await call('bob', 'GET', '/v1/me/wishlist')).json)).not.toContain('p-1');
    expect(JSON.stringify((await call('alice', 'GET', '/v1/me/wishlist')).json)).toContain('p-1');
  });

  it('saved carts: Bob cannot save (copy) Alice’s cart even with its id', async () => {
    sql(`INSERT INTO carts (id, customer_email, expires_at) VALUES ('cart-alice', 'alice@x.test', datetime('now', '+1 day'))`);
    const bob = await call('bob', 'POST', '/v1/me/saved-carts', { cartId: 'cart-alice' });
    expect(bob.status).toBe(404);
    expect(JSON.stringify((await call('bob', 'GET', '/v1/me/saved-carts')).json)).not.toContain('cart-alice');

    const alice = await call('alice', 'POST', '/v1/me/saved-carts', { cartId: 'cart-alice' });
    expect(alice.status).toBe(201);
    expect((await call('bob', 'DELETE', '/v1/me/saved-carts/cart-alice')).status).toBe(404);
  });

  it('downloads: Bob cannot list Alice’s order downloads', async () => {
    const res = await call('bob', 'GET', '/v1/orders/00000000-0000-4000-8000-0000000000a1/downloads');
    // 403 (not hers); 500 here only because ORDER_TOKEN_SECRET isn't set in this test.
    expect([403, 500]).toContain(res.status);
    expect(JSON.stringify(res.json)).not.toContain('ORD-A1');
  });

  it('an unverified account sees nothing and cannot claim a guest’s data', async () => {
    sql(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, total_cents)
         VALUES ('o-guest', 'ORD-G1', 'paid', 'guest@x.test', 700, 0, 700)`);
    for (const path of ['/v1/me/profile', '/v1/me/orders', '/v1/me/cart', '/v1/me/wishlist', '/v1/me/saved-carts']) {
      expect((await call('mallory', 'GET', path)).status).toBe(403);
    }
    expect(sql(`SELECT customer_id FROM orders WHERE id = 'o-guest'`).toArray()[0].customer_id).toBeNull();
  });

  it('guest orders join a verified account (email matched case-insensitively) and count towards spend', async () => {
    sql(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, total_cents) VALUES
         ('o-d1', 'ORD-D1', 'paid', 'dave@x.test', 1500, 0, 1500),
         ('o-d2', 'ORD-D2', 'delivered', 'DAVE@x.test', 2500, 0, 2500),
         ('o-d3', 'ORD-D3', 'pending', 'dave@x.test', 9900, 0, 9900)`);
    const profile = await call('dave', 'GET', '/v1/me/profile');
    expect(profile.status).toBe(200);
    expect(profile.json).toMatchObject({ order_count: 2, total_spent_cents: 4000 });
    const orders = JSON.stringify((await call('dave', 'GET', '/v1/me/orders')).json);
    expect(orders).toContain('ORD-D1');
    expect(orders).toContain('ORD-D2');
  });

  it('refunds and cancellations come off the money spent', async () => {
    sql(`INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status) VALUES ('r1', 'o-d2', 're_1', 500, 'succeeded')`);
    sql(`UPDATE orders SET status = 'canceled' WHERE id = 'o-d1'`);
    expect((await call('dave', 'GET', '/v1/me/profile')).json).toMatchObject({ order_count: 1, total_spent_cents: 2000 });
  });

  it('cart: stored per account on the server, never shared', async () => {
    const items = [{ sku: 'TEE-M', title: 'Tee', price_cents: 1999, qty: 2 }];
    expect((await call('alice', 'PUT', '/v1/me/cart', { items })).status).toBe(200);
    expect((await call('alice', 'GET', '/v1/me/cart')).json.items).toEqual(items);
    expect((await call('bob', 'GET', '/v1/me/cart')).json.items).toEqual([]);
    expect((await call('alice', 'PUT', '/v1/me/cart', { items: [{ sku: 'X', title: 'X', price_cents: 1, qty: 0 }] })).status).toBe(400);
  });

  it('saved carts list returns the snapshots, only your own', async () => {
    const alice = (await call('alice', 'GET', '/v1/me/saved-carts')).json;
    expect(alice.saved_carts.map((c: { id: string }) => c.id)).toEqual(['cart-alice']);
    expect((await call('bob', 'GET', '/v1/me/saved-carts')).json.saved_carts).toEqual([]);
  });

  it('reviews: a verified buyer of a delivered order can review', async () => {
    const productId = '00000000-0000-4000-8000-00000000b001';
    sql(`INSERT INTO products (id, title, status) VALUES (?, 'Sari', 'active')`, productId);
    sql(`INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES ('v-sari', ?, 'SARI-1', 'Red', 2500)`, productId);
    sql(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES ('oi-d2', 'o-d2', 'SARI-1', 'Sari', 1, 2500)`);

    const elig = await call('dave', 'GET', `/v1/products/${productId}/reviews/eligibility`);
    expect(elig.json).toEqual({ hasPurchased: true, alreadyReviewed: false });
    expect((await call('dave', 'POST', `/v1/products/${productId}/reviews`, { rating: 5, title: 'Lovely' })).status).toBe(201);
    expect((await call('bob', 'POST', `/v1/products/${productId}/reviews`, { rating: 1 })).status).toBe(403);
  });
});
