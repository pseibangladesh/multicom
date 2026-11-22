/**
 * Marketplace sync queue: producer (enqueueSyncJob + routes), job engine
 * (processSyncMessage) and the queue handler, against the real schema.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { getDb } from '../src/db';
import { hashKey } from '../src/middleware/auth';
import { marketplaceRoutes } from '../src/routes/marketplace';
import { loadChannel, type ChannelRow } from '../src/lib/marketplace/channel';
import {
  MAX_ATTEMPTS,
  enqueueSyncJob,
  isRetryable,
  plainText,
  processSyncMessage,
  SyncQueueError,
  type MarketplaceSyncMessage,
  type SyncDeps,
} from '../src/lib/marketplace/sync-jobs';
import type { IMarketplaceClient, MarketProduct } from '../src/lib/marketplace/types';
import { EtsyApiError } from '../src/lib/marketplace/etsy';
import { handleMarketplaceQueue } from '../src/workers/marketplace-consumer';
import { ApiError, type Env, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

type Merchant = ReturnType<typeof createMerchantDb>['merchant'];

function seed(merchant: Merchant) {
  merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, status) VALUES ('ch1', 'etsy', 'default', 'active')`);
  merchant.run(`INSERT INTO products (id, title, description, status, image_url) VALUES
    ('p1', '{"en-US":"Tee","fr-FR":"T-shirt"}', 'Soft', 'active', 'https://img.test/p1.jpg'),
    ('p2', 'Mug', '', 'active', NULL),
    ('p3', 'Hidden', '', 'draft', NULL)`);
  merchant.run(`INSERT INTO variants (id, product_id, sku, title, price_cents, status, variant_type) VALUES
    ('v1', 'p1', 'TEE-S', 'Small', 1500, 'active', 'physical'),
    ('v2', 'p1', 'TEE-M', 'Medium', 1500, 'active', 'physical'),
    ('v3', 'p2', 'MUG', 'Default Title', 900, 'active', 'physical'),
    ('v4', 'p2', 'MUG-PDF', 'Manual', 100, 'active', 'digital'),
    ('v5', 'p3', 'HID', 'Default', 100, 'active', 'physical')`);
  merchant.run(`INSERT INTO inventory (id, sku, on_hand, reserved) VALUES ('i1', 'TEE-S', 10, 3), ('i3', 'MUG', 1, 2)`);
}

function fakeClient(overrides: Partial<IMarketplaceClient> = {}) {
  const pushed: MarketProduct[] = [];
  const stock: Array<[string, number]> = [];
  const client = {
    platform: 'etsy',
    config: {},
    upsertProduct: vi.fn(async (p: MarketProduct) => {
      pushed.push(p);
      return `L-${p.sku}`;
    }),
    updateInventory: vi.fn(async (sku: string, qty: number) => void stock.push([sku, qty])),
    listOrders: vi.fn(async () => []),
    ...overrides,
  } as unknown as IMarketplaceClient;
  return { client, pushed, stock };
}

function setup(client: IMarketplaceClient, pageSize = 2) {
  const { merchant } = createMerchantDb();
  seed(merchant);
  const db = getDb(merchant as never);
  const deps: SyncDeps = { db, loadChannel: (id) => loadChannel(db, id), clientFor: () => client, pageSize };
  const addJob = (type: string, id = 'j1') =>
    merchant.run(`INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status) VALUES (?, 'ch1', ?, 'pending')`, [id, type]);
  const job = (id = 'j1') =>
    merchant.query<{ status: string; attempts: number; error_message: string | null; payload: string }>(
      `SELECT status, attempts, error_message, payload FROM marketplace_sync_jobs WHERE id = ?`,
      [id],
    )[0];
  /** Feeds continuation messages back in, like the queue would. */
  const drain = async (first: MarketplaceSyncMessage) => {
    let msg: MarketplaceSyncMessage | null = first;
    let messages = 0;
    while (msg) {
      messages++;
      const outcome = await processSyncMessage(deps, msg, 1);
      msg = outcome.kind === 'continue' ? outcome.next : null;
    }
    return messages;
  };
  return { merchant, db, deps, addJob, job, drain };
}

describe('processSyncMessage: push_products', () => {
  it('pushes active physical variants page by page and records mappings', async () => {
    const { client, pushed } = fakeClient();
    const { merchant, addJob, job, drain } = setup(client);
    addJob('push_products');

    expect(await drain({ jobId: 'j1' })).toBe(2); // 3 variants, page size 2
    expect(pushed.map((p) => p.sku)).toEqual(['TEE-S', 'TEE-M', 'MUG']);
    expect(pushed[0]).toMatchObject({ title: 'Tee - Small', priceCents: 1500, quantity: 7, imageUrl: 'https://img.test/p1.jpg', status: 'active' });
    expect(pushed[1].quantity).toBe(0); // no inventory row
    expect(pushed[2]).toMatchObject({ title: 'Mug', quantity: 0 }); // reserved > on_hand clamps to 0

    const j = job();
    expect(j.status).toBe('completed');
    expect(j.attempts).toBe(2);
    expect(JSON.parse(j.payload).products).toEqual({ processed: 3, succeeded: 3, failed: 0, errors: [] });
    expect(merchant.query(`SELECT variant_id, external_listing_id, status FROM marketplace_product_mappings ORDER BY variant_id`)).toEqual([
      { variant_id: 'v1', external_listing_id: 'L-TEE-S', status: 'active' },
      { variant_id: 'v2', external_listing_id: 'L-TEE-M', status: 'active' },
      { variant_id: 'v3', external_listing_id: 'L-MUG', status: 'active' },
    ]);
  });

  it('is idempotent: a second push updates mappings instead of duplicating them', async () => {
    const { client } = fakeClient();
    const { merchant, addJob, drain } = setup(client, 10);
    addJob('push_products', 'a');
    addJob('push_products', 'b');
    await drain({ jobId: 'a' });
    await drain({ jobId: 'b' });
    expect(merchant.query<{ n: number }>(`SELECT COUNT(*) AS n FROM marketplace_product_mappings`)[0].n).toBe(3);
  });

  it('records a rejected item and carries on', async () => {
    const { client } = fakeClient({
      upsertProduct: vi.fn(async (p: MarketProduct) => {
        if (p.sku === 'TEE-M') throw new EtsyApiError('Etsy 400: bad title', 400);
        return `L-${p.sku}`;
      }),
    });
    const { addJob, job, drain } = setup(client, 10);
    addJob('push_products');
    await drain({ jobId: 'j1' });
    expect(job().status).toBe('completed');
    expect(JSON.parse(job().payload).products).toMatchObject({ succeeded: 2, failed: 1, errors: [{ sku: 'TEE-M', error: 'Etsy 400: bad title' }] });
  });

  it('fails the job when every item fails (e.g. listing defaults not set)', async () => {
    const { client } = fakeClient({
      upsertProduct: vi.fn(async () => {
        throw new Error('Etsy: set listing defaults (taxonomy_id, shipping_profile_id) on the channel before creating listings');
      }),
    });
    const { addJob, job, drain } = setup(client, 10);
    addJob('push_products');
    await drain({ jobId: 'j1' });
    expect(job().status).toBe('failed');
    expect(job().error_message).toMatch(/All 3 item\(s\) failed; first error: Etsy: set listing defaults/);
  });

  it('retries the page with backoff on a rate limit, then gives up after MAX_ATTEMPTS', async () => {
    const { client } = fakeClient({ upsertProduct: vi.fn(async () => Promise.reject(new EtsyApiError('Etsy 429', 429))) });
    const { deps, addJob, job } = setup(client);
    addJob('push_products');

    expect(await processSyncMessage(deps, { jobId: 'j1' }, 1)).toEqual({ kind: 'retry', delaySeconds: 30 });
    expect(job()).toMatchObject({ status: 'pending', error_message: 'Attempt 1 failed, retrying: Etsy 429' });
    expect(await processSyncMessage(deps, { jobId: 'j1' }, 3)).toEqual({ kind: 'retry', delaySeconds: 120 });
    expect(await processSyncMessage(deps, { jobId: 'j1' }, MAX_ATTEMPTS)).toEqual({ kind: 'ack' });
    expect(job()).toMatchObject({ status: 'failed', error_message: 'Etsy 429', attempts: 3 });
  });

  it('acks redeliveries of finished jobs without calling the marketplace', async () => {
    const { client } = fakeClient();
    const { merchant, deps, addJob } = setup(client);
    addJob('push_products');
    merchant.run(`UPDATE marketplace_sync_jobs SET status = 'completed'`);
    expect(await processSyncMessage(deps, { jobId: 'j1' }, 2)).toEqual({ kind: 'ack' });
    expect(await processSyncMessage(deps, { jobId: 'missing' }, 1)).toEqual({ kind: 'ack' });
    expect(client.upsertProduct).not.toHaveBeenCalled();
  });

  it('fails without retrying when the channel is paused or its platform is unsupported', async () => {
    const { client } = fakeClient();
    const { merchant, deps, addJob, job } = setup(client);
    addJob('push_products');
    merchant.run(`UPDATE marketplace_channels SET status = 'paused'`);
    expect(await processSyncMessage(deps, { jobId: 'j1' }, 1)).toEqual({ kind: 'ack' });
    expect(job()).toMatchObject({ status: 'failed', error_message: 'Channel is paused' });

    addJob('push_products', 'j2');
    merchant.run(`UPDATE marketplace_channels SET status = 'active'`);
    const unsupported: SyncDeps = {
      ...deps,
      clientFor: () => {
        throw new ApiError('not_implemented', 501, 'amazon channels are not supported yet');
      },
    };
    expect(await processSyncMessage(unsupported, { jobId: 'j2' }, 1)).toEqual({ kind: 'ack' });
    expect(job('j2').status).toBe('failed');
  });
});

describe('processSyncMessage: other job types', () => {
  it('push_inventory updates only variants already listed on the channel', async () => {
    const { client, stock } = fakeClient();
    const { merchant, addJob, job, drain } = setup(client);
    merchant.run(`INSERT INTO marketplace_product_mappings (id, channel_id, variant_id, external_listing_id, status) VALUES
      ('m1', 'ch1', 'v1', 'L1', 'active'), ('m3', 'ch1', 'v3', 'L3', 'active'), ('m2', 'ch1', 'v2', 'L2', 'inactive')`);
    addJob('push_inventory');
    await drain({ jobId: 'j1' });
    expect(stock).toEqual([
      ['TEE-S', 7],
      ['MUG', 0],
    ]);
    expect(job().status).toBe('completed');
  });

  it('pull_orders imports and advances the channel window', async () => {
    const { client } = fakeClient();
    const { db, addJob, job, drain } = setup(client);
    addJob('pull_orders');
    await drain({ jobId: 'j1' });
    expect(client.listOrders).toHaveBeenCalledOnce();
    expect(job().status).toBe('completed');
    expect(JSON.parse(job().payload).orders).toMatchObject({ fetched: 0, imported: 0 });
    expect(((await loadChannel(db, 'ch1')) as ChannelRow).config.last_order_import_at).toBeTruthy();
  });

  it('sync_all pushes products, then pulls orders', async () => {
    const { client, pushed } = fakeClient();
    const { addJob, job, drain } = setup(client);
    addJob('sync_all');
    expect(await drain({ jobId: 'j1' })).toBe(3); // 2 product pages + orders
    expect(pushed).toHaveLength(3);
    expect(client.listOrders).toHaveBeenCalledOnce();
    const payload = JSON.parse(job().payload);
    expect(job().status).toBe('completed');
    expect(payload.products.succeeded).toBe(3);
    expect(payload.orders.fetched).toBe(0);
  });
});

describe('enqueueSyncJob', () => {
  it('records a pending job and sends its id', async () => {
    const { client } = fakeClient();
    const { db, job } = setup(client);
    const send = vi.fn(async () => undefined);
    const { jobId } = await enqueueSyncJob(db, { send }, 'ch1', 'push_products');
    expect(send).toHaveBeenCalledWith({ jobId });
    expect(job(jobId).status).toBe('pending');
  });

  it('refuses a duplicate while one is pending, but not once it is stale', async () => {
    const { client } = fakeClient();
    const { merchant, db } = setup(client);
    const send = vi.fn(async () => undefined);
    const { jobId } = await enqueueSyncJob(db, { send }, 'ch1', 'push_products');
    await expect(enqueueSyncJob(db, { send }, 'ch1', 'push_products')).rejects.toMatchObject({ code: 'job_already_running', existingJobId: jobId });
    await enqueueSyncJob(db, { send }, 'ch1', 'pull_orders'); // other types are independent

    merchant.run(`UPDATE marketplace_sync_jobs SET updated_at = datetime('now', '-2 hours') WHERE id = ?`, [jobId]);
    await expect(enqueueSyncJob(db, { send }, 'ch1', 'push_products')).resolves.toHaveProperty('jobId');
  });

  it('marks the job failed when the queue rejects the send, and errors when unbound', async () => {
    const { client } = fakeClient();
    const { merchant, db } = setup(client);
    await expect(enqueueSyncJob(db, undefined, 'ch1', 'push_products')).rejects.toMatchObject({ code: 'queue_not_configured' });
    await expect(
      enqueueSyncJob(db, { send: async () => Promise.reject(new Error('queue down')) }, 'ch1', 'push_products'),
    ).rejects.toBeInstanceOf(SyncQueueError);
    expect(merchant.query(`SELECT status, error_message FROM marketplace_sync_jobs`)).toEqual([
      { status: 'failed', error_message: 'Could not enqueue: queue down' },
    ]);
  });
});

describe('handleMarketplaceQueue', () => {
  function message(body: unknown, attempts = 1) {
    return { id: 'm', body, attempts, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
  }

  it('acks, sends continuations, and retries according to the outcome', async () => {
    const { client } = fakeClient();
    const { deps, addJob } = setup(client);
    addJob('push_products');
    const send = vi.fn(async () => undefined);
    const env = { MARKETPLACE_SYNC_QUEUE: { send } } as unknown as Env;

    const first = message({ jobId: 'j1' });
    const junk = message('not a job');
    await handleMarketplaceQueue({ messages: [first, junk] } as unknown as MessageBatch<unknown>, env, deps);
    expect(first.ack).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ jobId: 'j1', cursor: 'v2' });
    expect(junk.ack).toHaveBeenCalled();
  });

  it('hands a transient failure back to the queue with the computed delay', async () => {
    const { client } = fakeClient({ upsertProduct: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) });
    const { deps, addJob } = setup(client);
    addJob('push_products');
    const m = message({ jobId: 'j1' }, 2);
    await handleMarketplaceQueue({ messages: [m] } as unknown as MessageBatch<unknown>, {} as Env, deps);
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(m.ack).not.toHaveBeenCalled();
  });
});

describe('sync routes', () => {
  const ADMIN_KEY = 'sk_test_admin_key';

  async function routeSetup(env: Record<string, unknown>) {
    const { merchant } = createMerchantDb();
    seed(merchant);
    merchant.run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k1', ?, 'sk_', 'admin')`, [await hashKey(ADMIN_KEY)]);
    const app = new Hono<HonoEnv>();
    app.onError((err, c) =>
      c.json({ error: err.message, details: (err as ApiError).details }, (err instanceof ApiError ? err.statusCode : 500) as 400),
    );
    app.use('*', async (c, next) => {
      c.set('db', merchant as never);
      await next();
    });
    app.route('/v1/marketplace', marketplaceRoutes());
    const post = (path: string) =>
      app.request(`/v1/marketplace${path}`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_KEY}` } }, env);
    return { merchant, post };
  }

  it('202 + queue send for each job type, 409 on a duplicate, 404/400 for bad channels', async () => {
    const sent: unknown[] = [];
    const { merchant, post } = await routeSetup({ MARKETPLACE_SYNC_QUEUE: { send: async (m: unknown) => void sent.push(m) } });

    for (const [path, type] of [
      ['products', 'push_products'],
      ['inventory', 'push_inventory'],
      ['orders', 'pull_orders'],
      ['all', 'sync_all'],
    ]) {
      const res = await post(`/ch1/sync/${path}`);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ ok: true, jobType: type, status: 'pending' });
    }
    expect(sent).toHaveLength(4);

    const dup = await post('/ch1/sync/products');
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { details: { jobId: string } }).details.jobId).toBeTruthy();

    expect((await post('/nope/sync/products')).status).toBe(404);
    merchant.run(`UPDATE marketplace_channels SET status = 'paused'`);
    expect((await post('/ch1/sync/products')).status).toBe(400);
  });

  it('503s when the queue binding is missing', async () => {
    const { post } = await routeSetup({});
    expect((await post('/ch1/sync/products')).status).toBe(503);
  });
});

describe('helpers', () => {
  it('plainText picks en-US, then en, then any locale, and passes plain text through', () => {
    expect(plainText('{"fr-FR":"Bonjour","en-US":"Hello"}')).toBe('Hello');
    expect(plainText('{"fr-FR":"Bonjour","en":"Hi"}')).toBe('Hi');
    expect(plainText('{"ar-SA":"مرحبا"}')).toBe('مرحبا');
    expect(plainText('{not json')).toBe('{not json');
    expect(plainText(null)).toBe('');
  });

  it('isRetryable: 429/5xx/network yes; 4xx, 501 and config errors no', () => {
    expect(isRetryable(new EtsyApiError('x', 429))).toBe(true);
    expect(isRetryable(new EtsyApiError('x', 503))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(new EtsyApiError('x', 400))).toBe(false);
    expect(isRetryable(ApiError.notFound())).toBe(false);
    expect(isRetryable(new ApiError('not_implemented', 501, 'x'))).toBe(false);
    expect(isRetryable(new Error('set listing defaults'))).toBe(false);
  });
});
