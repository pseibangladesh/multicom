/**
 * POST /v1/setup/demo-reset backs `seed.ts --force`. It must delete only demo
 * data, keep base data / keys / settings, and never run on a deployed worker.
 */
import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { adminSetup } from '../src/routes/setup';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const SK = 'sk_' + 'a'.repeat(48);

async function setup() {
  const { merchant, ready } = createMerchantDb({ MERCHANT_SK: SK });
  await ready();
  const app = new OpenAPIHono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/setup', adminSetup);

  merchant.run(`INSERT INTO currencies (id, code, display_name, symbol) VALUES ('cur1', 'EUR', 'Euro', '€')`);
  merchant.run(`INSERT INTO products (id, handle, title) VALUES ('p1', 'tee', 'Tee')`);
  merchant.run(`INSERT INTO categories (id, handle, name) VALUES ('c1', 'caps', 'Caps')`);
  merchant.run(`INSERT INTO warehouses (id, display_name, address_line1, city, postal_code, country_code) VALUES ('w1', 'FR', 'x', 'y', '1', 'FR')`);

  const reset = (host: string, key = SK) =>
    app.request(`http://${host}/v1/setup/demo-reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, {});
  return { merchant, reset };
}

const count = (merchant: { query: <T>(sql: string) => T[] }, table: string) =>
  merchant.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

describe('POST /v1/setup/demo-reset', () => {
  it('on localhost, deletes demo data and keeps currencies and API keys', async () => {
    const { merchant, reset } = await setup();
    const res = await reset('localhost:8787');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 3 });
    for (const t of ['products', 'categories', 'warehouses']) expect(count(merchant, t)).toBe(0);
    expect(count(merchant, 'currencies')).toBe(1);
    expect(count(merchant, 'api_keys')).toBe(1);
  });

  it('is refused on a deployed hostname, even with the admin key', async () => {
    const { merchant, reset } = await setup();
    const res = await reset('merchant.example.com');
    expect(res.status).toBe(403);
    expect(count(merchant, 'products')).toBe(1);
  });

  it('requires the admin key', async () => {
    const { merchant, reset } = await setup();
    expect((await reset('localhost:8787', 'sk_' + 'z'.repeat(48))).status).toBe(401);
    expect(count(merchant, 'products')).toBe(1);
  });
});
