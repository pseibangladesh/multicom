/**
 * Etsy end to end through the HTTP routes: admin auth → PKCE connect →
 * channel factory → real EtsyClient + EtsyTokenManager → mocked Etsy HTTP →
 * order import / shipment.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { marketplaceRoutes } from '../src/routes/marketplace';
import { hashKey } from '../src/middleware/auth';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import { codeChallengeS256, saveEtsyTokens } from '../src/lib/marketplace/etsy-oauth';
import type { EtsyReceipt } from '../src/lib/marketplace/etsy';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const ADMIN_KEY = 'sk_test_admin_key';
const CRYPTOKEN = 'etsy-route-crypto-key-0123456789abcdef';
const ENV = {
  ETSY_CLIENT_ID: 'keystr',
  ETSY_SHARED_SECRET: 'shared',
  API_BASE_URL: 'https://api.shop.test',
  CRYPTOKEN,
  STORE_URL: 'https://shop.test',
};

const usd = (amount: number) => ({ amount, divisor: 100, currency_code: 'USD' });
const RECEIPT: EtsyReceipt = {
  receipt_id: 900100,
  status: 'Paid',
  is_paid: true,
  is_shipped: false,
  buyer_email: 'cy@example.com',
  name: 'Cy',
  first_line: '9 Elm',
  city: 'Leeds',
  zip: 'LS1',
  country_iso: 'GB',
  created_timestamp: 1763805600,
  subtotal: usd(1999),
  grandtotal: usd(1999),
  transactions: [{ transaction_id: 5001, title: 'Red tee', quantity: 1, price: usd(1999), sku: 'TEE-RED-M' }],
};

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** Fakes the Etsy token endpoint, /users/me and receipts. */
function stubEtsy(opts: { shopId?: number; tokenStatus?: number; receipts?: EtsyReceipt[] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? 'GET', url, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
      const path = url.pathname;
      if (path === '/v3/public/oauth/token') {
        return opts.tokenStatus && opts.tokenStatus !== 200
          ? Response.json({ error: 'invalid_grant' }, { status: opts.tokenStatus })
          : Response.json({ access_token: '4242.acc', token_type: 'Bearer', expires_in: 3600, refresh_token: '4242.ref' });
      }
      if (path === '/v3/application/users/me') return Response.json({ user_id: 4242, shop_id: opts.shopId ?? 31337 });
      if (path.endsWith('/receipts')) return Response.json({ count: (opts.receipts ?? [RECEIPT]).length, results: opts.receipts ?? [RECEIPT] });
      if (path.endsWith('/tracking')) return Response.json({ receipt_id: 900100 });
      return Response.json({ error: `unexpected ${path}` }, { status: 500 });
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const { merchant } = createMerchantDb();
  merchant.run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k1', ?, 'sk_', 'admin')`, [await hashKey(ADMIN_KEY)]);

  const app = new Hono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/marketplace', marketplaceRoutes());

  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      `/v1/marketplace${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      ENV
    );
  const connect = async (body?: unknown) => (await (await call('POST', '/connect/etsy', body)).json()) as { authUrl: string; state: string };
  return { merchant, call, connect };
}

describe('Etsy OAuth connect', () => {
  it('returns an Etsy authorize URL whose PKCE challenge matches the stored verifier', async () => {
    const { merchant, connect } = await setup();
    const { authUrl, state } = await connect();

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://www.etsy.com/oauth/connect');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('client_id')).toBe('keystr');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.shop.test/v1/marketplace/connect/etsy/callback');

    const [row] = merchant.query<{ platform: string; code_verifier: string }>(`SELECT platform, code_verifier FROM marketplace_oauth_states WHERE state = ?`, [state]);
    expect(row.platform).toBe('etsy');
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallengeS256(row.code_verifier));
    expect(authUrl).not.toContain(row.code_verifier);
  });

  it('callback exchanges code + verifier, looks up the shop, stores tokens, creates the channel', async () => {
    const { merchant, call, connect } = await setup();
    const { state } = await connect();
    const [{ code_verifier }] = merchant.query<{ code_verifier: string }>(`SELECT code_verifier FROM marketplace_oauth_states`);
    const calls = stubEtsy();

    const res = await call('GET', `/connect/etsy/callback?state=${state}&code=etsy-code`);
    expect(res.status).toBe(200);
    const { channelId } = (await res.json()) as { channelId: string };

    const token = new URLSearchParams(calls[0].body);
    expect(token.get('code')).toBe('etsy-code');
    expect(token.get('code_verifier')).toBe(code_verifier);
    expect(calls[1].url.pathname).toBe('/v3/application/users/me');
    expect(calls[1].headers['x-api-key']).toBe('keystr:shared');

    expect(merchant.query<any>(`SELECT platform, status, external_shop_id, config_json FROM marketplace_channels WHERE id = ?`, [channelId])).toEqual([
      { platform: 'etsy', status: 'active', external_shop_id: '31337', config_json: JSON.stringify({ shop_id: '31337' }) },
    ]);
    const creds = new CredentialManager(getDb(merchant as never), CRYPTOKEN);
    expect(await creds.getSecret(channelId, 'oauth_token')).toBe('4242.acc');
    expect((await creds.getCredential(channelId, 'refresh_token'))?.expiresAt).toMatch(/^\d{4}-/);
    expect(merchant.query(`SELECT * FROM marketplace_oauth_states`)).toHaveLength(0);
  });

  it('connecting the same shop again reuses its channel and keeps its config', async () => {
    const { merchant, call, connect } = await setup();
    stubEtsy();
    const first = await connect();
    const { channelId } = (await (await call('GET', `/connect/etsy/callback?state=${first.state}&code=c`)).json()) as { channelId: string };
    merchant.run(`UPDATE marketplace_channels SET status = 'error', config_json = json_set(config_json, '$.default_carrier', 'usps')`);

    const second = await connect();
    const res = await call('GET', `/connect/etsy/callback?state=${second.state}&code=c`);
    expect(await res.json()).toMatchObject({ channelId });
    const rows = merchant.query<any>(`SELECT status, config_json FROM marketplace_channels`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(JSON.parse(rows[0].config_json)).toEqual({ shop_id: '31337', default_carrier: 'usps' });
  });

  it('refuses to re-point an existing channel at a different shop', async () => {
    const { merchant, call, connect } = await setup();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, external_shop_id, config_json) VALUES ('ch-a', 'etsy', 'default', '111', '{"shop_id":"111"}')`);
    stubEtsy({ shopId: 222 });
    const { state } = await connect({ channel_id: 'ch-a' });
    const res = await call('GET', `/connect/etsy/callback?state=${state}&code=c`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'shop_mismatch' });
    expect(merchant.query<any>(`SELECT external_shop_id FROM marketplace_channels`)).toEqual([{ external_shop_id: '111' }]);
    expect(merchant.query(`SELECT * FROM marketplace_credentials`)).toHaveLength(0);
  });

  it('reports a failed token exchange without creating a channel', async () => {
    const { merchant, call, connect } = await setup();
    stubEtsy({ tokenStatus: 400 });
    const { state } = await connect();
    expect((await call('GET', `/connect/etsy/callback?state=${state}&code=bad`)).status).toBe(502);
    expect(merchant.query(`SELECT * FROM marketplace_channels`)).toHaveLength(0);
  });

  it('an eBay state cannot complete an Etsy callback', async () => {
    const { merchant, call } = await setup();
    merchant.run(`INSERT INTO marketplace_oauth_states (state, platform, expires_at) VALUES ('ebay-state', 'ebay', ?)`, [new Date(Date.now() + 60_000).toISOString()]);
    const calls = stubEtsy();
    expect((await call('GET', `/connect/etsy/callback?state=ebay-state&code=c`)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('Etsy order import and shipment', () => {
  async function connected(config: Record<string, unknown> = {}) {
    const ctx = await setup();
    ctx.merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, external_shop_id, config_json) VALUES ('ch1', 'etsy', 'default', '31337', ?)`, [
      JSON.stringify({ shop_id: '31337', ...config }),
    ]);
    ctx.merchant.run(`INSERT INTO products (id, title) VALUES ('p1', 'Tee')`);
    ctx.merchant.run(`INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES ('v1', 'p1', 'TEE-RED-M', 'Red / M', 1999)`);
    ctx.merchant.run(`INSERT INTO inventory (id, sku, on_hand, reserved) VALUES ('i1', 'TEE-RED-M', 5, 0)`);
    await saveEtsyTokens(new CredentialManager(getDb(ctx.merchant as never), CRYPTOKEN), 'ch1', {
      accessToken: '4242.live',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: '4242.ref',
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    return ctx;
  }

  it('imports paid receipts through the shared order import', async () => {
    const { merchant, call } = await connected();
    const calls = stubEtsy();

    const res = await call('POST', '/ch1/orders/import', { since: '2026-11-20T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fetched: 1, failed: [], imported: [{ externalOrderId: '900100', number: 'ETSY-900100' }] });

    expect(calls[0].url.pathname).toBe('/v3/application/shops/31337/receipts');
    expect(calls[0].url.searchParams.get('min_last_modified')).toBe(String(Date.parse('2026-11-20T00:00:00.000Z') / 1000));
    expect(calls[0].headers.Authorization).toBe('Bearer 4242.live');

    expect(merchant.query<any>(`SELECT status, channel_id, total_cents, customer_email FROM orders`)).toEqual([
      { status: 'paid', channel_id: 'ch1', total_cents: 1999, customer_email: 'cy@example.com' },
    ]);
    expect(merchant.query<any>(`SELECT external_line_item_id, qty FROM marketplace_order_lines`)).toEqual([{ external_line_item_id: '5001', qty: 1 }]);
    expect(merchant.query<any>(`SELECT on_hand FROM inventory`)[0].on_hand).toBe(4);
  });

  it('skips unpaid and cancelled receipts', async () => {
    const { call } = await connected();
    stubEtsy({ receipts: [{ ...RECEIPT, receipt_id: 1, is_paid: false, status: 'Payment Processing' }, { ...RECEIPT, receipt_id: 2, status: 'Canceled' }] });
    const body = (await (await call('POST', '/ch1/orders/import')).json()) as any;
    expect(body.skipped).toEqual([
      { externalOrderId: '1', reason: 'unpaid' },
      { externalOrderId: '2', reason: 'cancelled' },
    ]);
  });

  it('pushes tracking to the receipt with the configured carrier', async () => {
    const { merchant, call } = await connected({ default_carrier: 'royal-mail' });
    stubEtsy();
    const { imported } = (await (await call('POST', '/ch1/orders/import')).json()) as any;
    const orderId = imported[0].orderId as string;
    merchant.run(`UPDATE orders SET tracking_number = 'RM123GB' WHERE id = ?`, [orderId]);

    const calls = stubEtsy();
    const res = await call('POST', `/ch1/orders/${orderId}/shipment`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/v3/application/shops/31337/receipts/900100/tracking');
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ tracking_code: 'RM123GB', carrier_name: 'royal-mail' });
    expect(merchant.query<any>(`SELECT status FROM marketplace_orders`)[0].status).toBe('FULFILLED');
  });

  it('refuses a channel without a shop_id', async () => {
    const { merchant, call } = await connected();
    merchant.run(`UPDATE marketplace_channels SET config_json = '{}'`);
    stubEtsy();
    const res = await call('POST', '/ch1/orders/import');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/shop_id/);
  });
});
