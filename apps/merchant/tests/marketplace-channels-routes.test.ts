import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { adminSettings } from '../src/routes/admin-settings';
import { adminMarketplaceChannelRoutes, mergeConfig } from '../src/routes/marketplace/channels';
import { hashKey } from '../src/middleware/auth';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const ADMIN_KEY = 'sk_test_admin_key';
const PUBLIC_KEY = 'pk_test_public_key';
const CRYPTOKEN = 'channels-route-crypto-key-0123456789abcdef';

async function setup() {
  const { merchant } = createMerchantDb();
  for (const [kid, key, role] of [
    ['k1', ADMIN_KEY, 'admin'],
    ['k2', PUBLIC_KEY, 'public'],
  ]) {
    merchant.run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, ?, ?)`, [kid, await hashKey(key), key.slice(0, 3), role]);
  }
  merchant.run(
    `INSERT INTO marketplace_channels (id, platform, store_id, external_shop_id, config_json, created_at) VALUES
      ('etsy1', 'etsy', 'default', '31337', '{"shop_id":"31337"}', '2026-11-01 00:00:00'),
      ('ebay1', 'ebay', 'default', NULL, '{"environment":"sandbox","listing":{"merchant_location_key":"wh1"}}', '2026-11-02 00:00:00')`
  );

  // Same mount order as src/index.ts: adminSettings at /v1/admin comes first.
  const app = new Hono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message, details: (err as ApiError).details }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/admin', adminSettings);
  app.route('/v1/admin/marketplace', adminMarketplaceChannelRoutes());

  const call = (method: string, path: string, body?: unknown, key: string | null = ADMIN_KEY) =>
    app.request(`/v1/admin/marketplace${path}`, {
      method,
      headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }, { CRYPTOKEN });
  return { merchant, call };
}

const configOf = (merchant: ReturnType<typeof createMerchantDb>['merchant'], id: string) =>
  JSON.parse(merchant.query<{ config_json: string }>(`SELECT config_json FROM marketplace_channels WHERE id = ?`, [id])[0].config_json);

describe('/v1/admin/marketplace access control', () => {
  it.each([
    ['GET', '/channels'],
    ['PATCH', '/channels/etsy1/config'],
  ])('%s %s: 401 without credentials, 403 for a public key (not a 500)', async (method, path) => {
    const { call } = await setup();
    expect((await call(method, path, method === 'PATCH' ? {} : undefined, null)).status).toBe(401);
    expect((await call(method, path, method === 'PATCH' ? {} : undefined, PUBLIC_KEY)).status).toBe(403);
  });
});

describe('GET /v1/admin/marketplace/channels', () => {
  it('lists channels newest first with readiness, connection and last job', async () => {
    const { merchant, call } = await setup();
    await new CredentialManager(getDb(merchant as never), CRYPTOKEN).saveCredential({ channelId: 'etsy1', type: 'oauth_token', value: 't', expiresAt: null });
    merchant.run(`INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status, error_message, updated_at) VALUES
      ('j1', 'etsy1', 'pull_orders', 'completed', NULL, '2026-11-20 10:00:00'),
      ('j2', 'etsy1', 'push_products', 'failed', 'boom', '2026-11-21 10:00:00')`);

    const res = await call('GET', '/channels');
    expect(res.status).toBe(200);
    const { channels } = (await res.json()) as { channels: any[] };
    expect(channels.map((c) => c.id)).toEqual(['ebay1', 'etsy1']);
    expect(channels[1]).toMatchObject({
      platform: 'etsy',
      status: 'active',
      externalShopId: '31337',
      config: { shop_id: '31337' },
      connected: true,
      listingReady: false,
      lastJob: { type: 'push_products', status: 'failed', error: 'boom' },
    });
    expect(channels[0]).toMatchObject({ platform: 'ebay', connected: false, lastJob: null });
  });
});

describe('PATCH /v1/admin/marketplace/channels/:id/config', () => {
  it('sets Etsy listing defaults and reports the channel as ready', async () => {
    const { merchant, call } = await setup();
    const res = await call('PATCH', '/channels/etsy1/config', {
      listing_defaults: { taxonomy_id: 1027, shipping_profile_id: 555, who_made: 'i_did' },
      default_carrier: 'usps',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel).toMatchObject({ listingReady: true, config: { default_carrier: 'usps' } });
    expect(configOf(merchant, 'etsy1')).toEqual({
      shop_id: '31337',
      default_carrier: 'usps',
      listing_defaults: { taxonomy_id: 1027, shipping_profile_id: 555, who_made: 'i_did' },
    });
  });

  it('merges nested listing fields and deletes keys set to null', async () => {
    const { merchant, call } = await setup();
    await call('PATCH', '/channels/etsy1/config', { listing_defaults: { taxonomy_id: 1, shipping_profile_id: 2 } });
    await call('PATCH', '/channels/etsy1/config', { listing_defaults: { shipping_profile_id: 3, taxonomy_id: null } });
    expect(configOf(merchant, 'etsy1').listing_defaults).toEqual({ shipping_profile_id: 3 });

    await call('PATCH', '/channels/etsy1/config', { listing_defaults: { shipping_profile_id: null } });
    expect(configOf(merchant, 'etsy1')).toEqual({ shop_id: '31337' });
  });

  it('accepts eBay listing policies and keeps the OAuth environment', async () => {
    const { merchant, call } = await setup();
    const res = await call('PATCH', '/channels/ebay1/config', {
      marketplace_id: 'EBAY_GB',
      listing: { category_id: '9355', fulfillment_policy_id: 'f', payment_policy_id: 'p', return_policy_id: 'r' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.listingReady).toBe(true);
    expect(configOf(merchant, 'ebay1')).toEqual({
      environment: 'sandbox',
      marketplace_id: 'EBAY_GB',
      listing: { merchant_location_key: 'wh1', category_id: '9355', fulfillment_policy_id: 'f', payment_policy_id: 'p', return_policy_id: 'r' },
    });
  });

  it.each([
    ['identity fields', { shop_id: '666' }],
    ['bookkeeping fields', { last_order_import_at: '2020-01-01T00:00:00Z' }],
    ['another platform\'s keys', { listing: { category_id: '1' } }],
    ['wrong types', { listing_defaults: { taxonomy_id: '1027' } }],
    ['non-positive ids', { listing_defaults: { shipping_profile_id: 0 } }],
    ['unknown nested keys', { listing_defaults: { price: 1 } }],
    ['bad enums', { listing_defaults: { who_made: 'robot' } }],
  ])('rejects %s on an Etsy channel', async (_label, body) => {
    const { merchant, call } = await setup();
    const res = await call('PATCH', '/channels/etsy1/config', body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).details.issues.length).toBeGreaterThan(0);
    expect(configOf(merchant, 'etsy1')).toEqual({ shop_id: '31337' });
  });

  it('rejects environment changes on eBay (set at connect time)', async () => {
    const { call } = await setup();
    expect((await call('PATCH', '/channels/ebay1/config', { environment: 'production' })).status).toBe(400);
  });

  it('400s on a non-JSON body and 404s on an unknown channel', async () => {
    const { call } = await setup();
    expect((await call('PATCH', '/channels/etsy1/config', 'not json')).status).toBe(400);
    expect((await call('PATCH', '/channels/nope/config', {})).status).toBe(404);
  });

  it('501s for platforms without an editable config', async () => {
    const { merchant, call } = await setup();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('amz', 'amazon', 'default')`);
    expect((await call('PATCH', '/channels/amz/config', {})).status).toBe(501);
  });
});

describe('mergeConfig', () => {
  it('replaces scalars, merges nested config objects, and deletes on null', () => {
    expect(mergeConfig({ a: 1, listing: { x: 1, y: 2 } }, { a: 2, listing: { y: null, z: 3 } })).toEqual({ a: 2, listing: { x: 1, z: 3 } });
    expect(mergeConfig({ listing: { x: 1 } }, { listing: null })).toEqual({});
  });
});
