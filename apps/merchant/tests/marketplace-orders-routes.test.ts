/**
 * End to end through the HTTP routes: admin auth → channel factory → real
 * EbayClient + EbayTokenManager → mocked eBay HTTP → order import / shipment.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { marketplaceRoutes } from '../src/routes/marketplace';
import { hashKey } from '../src/middleware/auth';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import { saveEbayTokens } from '../src/lib/marketplace/ebay-oauth';
import type { EbayOrder } from '../src/lib/marketplace/ebay';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const ADMIN_KEY = 'sk_test_admin_key';
const CRYPTOKEN = 'orders-route-crypto-key-0123456789abcdef';
const ENV = { EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'cs', EBAY_RU_NAME: 'Ru', CRYPTOKEN };

const ORDER: EbayOrder = {
  orderId: '27-11111-22222',
  creationDate: '2026-11-21T12:00:00.000Z',
  orderFulfillmentStatus: 'NOT_STARTED',
  orderPaymentStatus: 'PAID',
  buyer: { buyerRegistrationAddress: { fullName: 'Bo', email: 'bo@example.com' } },
  pricingSummary: { priceSubtotal: { value: '19.99', currency: 'USD' }, total: { value: '19.99', currency: 'USD' } },
  lineItems: [{ lineItemId: '10055', sku: 'TEE-RED-M', title: 'Red tee', quantity: 1, lineItemCost: { value: '19.99', currency: 'USD' } }],
};

interface EbayCall {
  method: string;
  url: URL;
  body: any;
}

function stubEbay(orders: EbayOrder[] = [ORDER]) {
  const calls: EbayCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.pathname === '/sell/fulfillment/v1/order') return Response.json({ orders, total: orders.length });
      if (url.pathname.endsWith('/shipping_fulfillment')) return new Response(null, { status: 201 });
      return new Response(JSON.stringify({ errors: [{ message: `unexpected ${url.pathname}` }] }), { status: 500 });
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

async function setup(config: Record<string, unknown> = {}) {
  const { merchant } = createMerchantDb();
  merchant.run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k1', ?, 'sk_', 'admin')`, [await hashKey(ADMIN_KEY)]);
  merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, config_json) VALUES ('ch1', 'ebay', 'default', ?)`, [JSON.stringify(config)]);
  merchant.run(`INSERT INTO products (id, title) VALUES ('p1', 'Tee')`);
  merchant.run(`INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES ('v1', 'p1', 'TEE-RED-M', 'Red / M', 1999)`);
  merchant.run(`INSERT INTO inventory (id, sku, on_hand, reserved) VALUES ('i1', 'TEE-RED-M', 5, 0)`);
  await saveEbayTokens(new CredentialManager(getDb(merchant as never), CRYPTOKEN), 'ch1', {
    accessToken: 'live-token',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: 'r',
  });

  const app = new Hono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/marketplace', marketplaceRoutes());

  const post = (path: string, body?: unknown, key: string | null = ADMIN_KEY) =>
    app.request(
      `/v1/marketplace${path}`,
      {
        method: 'POST',
        headers: { ...(key && { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      ENV
    );
  return { merchant, post };
}

describe('POST /v1/marketplace/:channelId/orders/import', () => {
  it('is admin only', async () => {
    const { post } = await setup();
    expect((await post('/ch1/orders/import', undefined, null)).status).toBe(401);
  });

  it('pulls eBay orders, creates the internal order, deducts stock, and records the job', async () => {
    const { merchant, post } = await setup();
    const calls = stubEbay();

    const res = await post('/ch1/orders/import', { since: '2026-11-20T00:00:00.000Z' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, fetched: 1, failed: [], imported: [{ externalOrderId: '27-11111-22222', number: 'EBAY-27-11111-22222' }] });

    // The real client sent the stored token and a lastmodifieddate window.
    expect(calls[0].url.searchParams.get('filter')).toBe('lastmodifieddate:[2026-11-20T00:00:00.000Z..]');

    expect(merchant.query<any>(`SELECT status, channel_id, total_cents FROM orders`)).toEqual([{ status: 'paid', channel_id: 'ch1', total_cents: 1999 }]);
    expect(merchant.query<any>(`SELECT on_hand FROM inventory`)[0].on_hand).toBe(4);
    expect(merchant.query<any>(`SELECT job_type, status FROM marketplace_sync_jobs`)).toEqual([{ job_type: 'pull_orders', status: 'completed' }]);

    const config = JSON.parse(merchant.query<any>(`SELECT config_json FROM marketplace_channels`)[0].config_json);
    expect(typeof config.last_order_import_at).toBe('string');
  });

  it('resumes from the last import minus one hour of overlap', async () => {
    const { post } = await setup({ last_order_import_at: '2026-11-21T10:00:00.000Z' });
    const calls = stubEbay([]);
    await post('/ch1/orders/import');
    expect(calls[0].url.searchParams.get('filter')).toBe('lastmodifieddate:[2026-11-21T09:00:00.000Z..]');
  });

  it('records a failed job when eBay errors', async () => {
    const { merchant, post } = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'Internal error' }] }), { status: 500 })));
    expect((await post('/ch1/orders/import')).status).toBe(500);
    expect(merchant.query<any>(`SELECT status, error_message FROM marketplace_sync_jobs`)).toEqual([
      { status: 'failed', error_message: expect.stringContaining('Internal error') },
    ]);
  });

  it('rejects a bad since value', async () => {
    const { post } = await setup();
    expect((await post('/ch1/orders/import', { since: 'yesterday' })).status).toBe(400);
  });
});

describe('POST /v1/marketplace/:channelId/orders/:orderId/shipment', () => {
  async function imported(config: Record<string, unknown>) {
    const ctx = await setup(config);
    stubEbay();
    const body = (await (await ctx.post('/ch1/orders/import')).json()) as any;
    return { ...ctx, orderId: body.imported[0].orderId as string };
  }

  it('confirms the shipment with the channel default carrier and eBay line IDs', async () => {
    const { merchant, post, orderId } = await imported({ default_carrier: 'USPS' });
    merchant.run(`UPDATE orders SET tracking_number = '9400TRACK' WHERE id = ?`, [orderId]);
    const calls = stubEbay();

    const res = await post(`/ch1/orders/${orderId}/shipment`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, carrier: 'USPS', externalOrderId: '27-11111-22222', lines: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/sell/fulfillment/v1/order/27-11111-22222/shipping_fulfillment');
    expect(calls[0].body).toMatchObject({ lineItems: [{ lineItemId: '10055', quantity: 1 }], shippingCarrierCode: 'USPS', trackingNumber: '9400TRACK' });
    expect(merchant.query<any>(`SELECT status FROM marketplace_orders`)[0].status).toBe('FULFILLED');
  });

  it("uses the order's own carrier over the channel default", async () => {
    const { merchant, post, orderId } = await imported({ default_carrier: 'USPS' });
    merchant.run(`UPDATE orders SET tracking_number = '1Z999', tracking_carrier = 'UPS' WHERE id = ?`, [orderId]);
    const calls = stubEbay();
    await post(`/ch1/orders/${orderId}/shipment`);
    expect(calls[0].body.shippingCarrierCode).toBe('UPS');
  });

  it("falls back to eBay's generic carrier when none is configured", async () => {
    const { merchant, post, orderId } = await imported({});
    merchant.run(`UPDATE orders SET tracking_number = 'T1' WHERE id = ?`, [orderId]);
    const calls = stubEbay();
    await post(`/ch1/orders/${orderId}/shipment`);
    expect(calls[0].body.shippingCarrierCode).toBe('Other');
  });

  it('requires a tracking number', async () => {
    const { post, orderId } = await imported({});
    expect((await post(`/ch1/orders/${orderId}/shipment`)).status).toBe(400);
  });
});
