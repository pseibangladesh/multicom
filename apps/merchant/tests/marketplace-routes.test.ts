import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { marketplaceRoutes } from '../src/routes/marketplace';
import { OAUTH_STATE_TTL_MS } from '../src/routes/marketplace/connect';
import { hashKey } from '../src/middleware/auth';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const ADMIN_KEY = 'sk_test_admin_key';
const PUBLIC_KEY = 'pk_test_public_key';
const CRYPTOKEN = 'route-test-crypto-key-0123456789abcdef';

const ENV = {
  EBAY_CLIENT_ID: 'cid',
  EBAY_CLIENT_SECRET: 'csecret',
  EBAY_RU_NAME: 'Shop-RuName',
  CRYPTOKEN,
  STORE_URL: 'https://shop.test',
};

async function setup(env: Record<string, unknown> = ENV) {
  const { merchant } = createMerchantDb();
  for (const [id, key, role] of [
    ['k1', ADMIN_KEY, 'admin'],
    ['k2', PUBLIC_KEY, 'public'],
  ]) {
    merchant.run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, ?, ?)`, [id, await hashKey(key), key.slice(0, 3), role]);
  }

  const app = new Hono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/marketplace', marketplaceRoutes());

  const call = (method: string, path: string, opts: { key?: string | null; body?: unknown } = {}) => {
    const key = opts.key === undefined ? ADMIN_KEY : opts.key;
    return app.request(
      `/v1/marketplace${path}`,
      {
        method,
        headers: {
          ...(key && { Authorization: `Bearer ${key}` }),
          ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      },
      env
    );
  };
  return { merchant, call };
}

function stubTokenEndpoint(status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify(
        status === 200
          ? { access_token: 'acc', expires_in: 7200, refresh_token: 'ref', refresh_token_expires_in: 47304000 }
          : { error: 'invalid_grant' }
      ),
      { status }
    )
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marketplace routes: access control', () => {
  it.each([
    ['POST', '/connect/ebay'],
    ['GET', '/connect/ebay/callback?state=x&code=y'],
    ['POST', '/ch1/sync/products'],
    ['POST', '/ch1/sync/inventory'],
    ['GET', '/ch1/status'],
  ])('%s %s: 401 without credentials, 403 for a public key', async (method, path) => {
    const { call } = await setup();
    expect((await call(method, path, { key: null })).status).toBe(401);
    expect((await call(method, path, { key: PUBLIC_KEY })).status).toBe(403);
  });

  it('leaves the webhook receiver outside admin auth', async () => {
    const { call } = await setup();
    const res = await call('POST', '/webhook/ebay', { key: null, body: { type: 'test' } });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('marketplace routes: OAuth connect', () => {
  it('returns an eBay authorize URL carrying a stored, short-lived state, without creating a channel', async () => {
    const { merchant, call } = await setup();
    const before = Date.now();
    const res = await call('POST', '/connect/ebay');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string; state: string };

    const url = new URL(body.authUrl);
    expect(url.origin).toBe('https://auth.ebay.com');
    expect(url.searchParams.get('state')).toBe(body.state);
    expect(body.state).toMatch(/^[0-9a-f]{64}$/);

    const [row] = merchant.query<{ platform: string; expires_at: string }>(`SELECT * FROM marketplace_oauth_states WHERE state = ?`, [body.state]);
    expect(row.platform).toBe('ebay');
    const ttl = new Date(row.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(OAUTH_STATE_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(OAUTH_STATE_TTL_MS + 5_000);

    expect(merchant.query(`SELECT * FROM marketplace_channels`)).toHaveLength(0);
  });

  it('a callback consumes the state, stores tokens with expiry, and creates an active channel', async () => {
    const { merchant, call } = await setup();
    const fetchMock = stubTokenEndpoint();
    const { state } = (await (await call('POST', '/connect/ebay')).json()) as { state: string };

    const res = await call('GET', `/connect/ebay/callback?state=${state}&code=the-code`);
    expect(res.status).toBe(200);
    const { channelId } = (await res.json()) as { channelId: string };

    expect(new URLSearchParams((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).get('code')).toBe('the-code');
    expect(merchant.query<any>(`SELECT platform, store_id, status FROM marketplace_channels WHERE id = ?`, [channelId])).toEqual([
      { platform: 'ebay', store_id: 'default', status: 'active' },
    ]);
    expect(merchant.query(`SELECT * FROM marketplace_oauth_states`)).toHaveLength(0);

    const creds = new CredentialManager(getDb(merchant as never), CRYPTOKEN);
    const access = await creds.getCredential(channelId, 'oauth_token');
    expect(access?.value).toBe('acc');
    expect(access?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await creds.getSecret(channelId, 'refresh_token')).toBe('ref');

    // Replay of the same callback is rejected.
    expect((await call('GET', `/connect/ebay/callback?state=${state}&code=the-code`)).status).toBe(400);
  });

  it('rejects unknown, wrong-platform, and expired states before calling eBay', async () => {
    const { merchant, call } = await setup();
    const fetchMock = stubTokenEndpoint();

    expect((await call('GET', '/connect/ebay/callback?state=forged&code=c')).status).toBe(400);
    expect((await call('GET', '/connect/ebay/callback?code=c')).status).toBe(400);

    const { state } = (await (await call('POST', '/connect/ebay')).json()) as { state: string };
    expect((await call('GET', `/connect/etsy/callback?state=${state}&code=c`)).status).toBe(400);

    const { state: old } = (await (await call('POST', '/connect/ebay')).json()) as { state: string };
    merchant.run(`UPDATE marketplace_oauth_states SET expires_at = ? WHERE state = ?`, [new Date(Date.now() - 1000).toISOString(), old]);
    const expired = await call('GET', `/connect/ebay/callback?state=${old}&code=c`);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { error: string }).error).toMatch(/expired/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(merchant.query(`SELECT * FROM marketplace_channels`)).toHaveLength(0);
  });

  it('does not create a channel when eBay rejects the code', async () => {
    const { merchant, call } = await setup();
    stubTokenEndpoint(400);
    const { state } = (await (await call('POST', '/connect/ebay')).json()) as { state: string };
    const res = await call('GET', `/connect/ebay/callback?state=${state}&code=bad`);
    expect(res.status).toBe(502);
    expect(merchant.query(`SELECT * FROM marketplace_channels`)).toHaveLength(0);
  });

  it('reports a declined consent without calling eBay', async () => {
    const { call } = await setup();
    const fetchMock = stubTokenEndpoint();
    const { state } = (await (await call('POST', '/connect/ebay')).json()) as { state: string };
    const res = await call('GET', `/connect/ebay/callback?state=${state}&error=access_denied`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, result: 'denied', error: 'access_denied' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only redirects back to allowed front-end origins', async () => {
    const { call } = await setup();
    stubTokenEndpoint();

    expect((await call('POST', '/connect/ebay', { body: { return_to: 'https://evil.test/admin' } })).status).toBe(400);

    const { state } = (await (await call('POST', '/connect/ebay', { body: { return_to: 'https://shop.test/admin/marketplaces' } })).json()) as {
      state: string;
    };
    const res = await call('GET', `/connect/ebay/callback?state=${state}&code=c`);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://shop.test/admin/marketplaces');
    expect(loc.searchParams.get('marketplace')).toBe('ebay');
    expect(loc.searchParams.get('result')).toBe('connected');
    expect(loc.searchParams.get('channelId')).toBeTruthy();
  });

  it('reconnecting an existing channel reactivates it instead of creating another', async () => {
    const { merchant, call } = await setup();
    stubTokenEndpoint();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, status) VALUES ('ch-old', 'ebay', 'default', 'error')`);

    const { state } = (await (await call('POST', '/connect/ebay', { body: { channel_id: 'ch-old' } })).json()) as { state: string };
    const res = await call('GET', `/connect/ebay/callback?state=${state}&code=c`);
    expect(await res.json()).toMatchObject({ channelId: 'ch-old' });
    expect(merchant.query<any>(`SELECT id, status FROM marketplace_channels`)).toEqual([{ id: 'ch-old', status: 'active' }]);
  });

  it('rejects unknown platforms and an unconfigured Amazon app', async () => {
    const { call } = await setup();
    expect((await call('POST', '/connect/shopify')).status).toBe(400);
    const amazon = await call('POST', '/connect/amazon');
    expect(amazon.status).toBe(400);
    expect(JSON.stringify(await amazon.json())).toMatch(/Amazon is not configured/);
  });

  it('400s when the eBay or Etsy app is not configured', async () => {
    const { call } = await setup({ CRYPTOKEN });
    expect((await call('POST', '/connect/ebay')).status).toBe(400);
    expect((await call('POST', '/connect/etsy')).status).toBe(400);
  });
});

describe('marketplace routes: sync jobs', () => {
  it('queues push_products / push_inventory jobs (the CHECK used to reject "pending")', async () => {
    const sent: unknown[] = [];
    const { merchant, call } = await setup({ ...ENV, MARKETPLACE_SYNC_QUEUE: { send: async (m: unknown) => void sent.push(m) } });
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch1', 'ebay', 'default')`);

    expect((await call('POST', '/ch1/sync/products')).status).toBe(202);
    expect((await call('POST', '/ch1/sync/inventory')).status).toBe(202);
    expect(sent).toHaveLength(2);
    expect(merchant.query<any>(`SELECT job_type, status FROM marketplace_sync_jobs ORDER BY job_type`)).toEqual([
      { job_type: 'push_inventory', status: 'pending' },
      { job_type: 'push_products', status: 'pending' },
    ]);
  });

  it('works with the status route for admins', async () => {
    const { merchant, call } = await setup();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch1', 'ebay', 'default')`);
    expect(await (await call('GET', '/ch1/status')).json()).toMatchObject({ ok: true, platform: 'ebay', status: 'active' });
  });
});
