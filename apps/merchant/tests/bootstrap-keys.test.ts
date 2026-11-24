/**
 * MERCHANT_SK / MERCHANT_PK are seeded when MerchantDO starts, before any RPC,
 * so the unauthenticated POST /v1/setup/init is closed on a fresh deployment.
 */
import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { adminSetup } from '../src/routes/setup';
import { hashKey } from '../src/middleware/auth';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const SK = 'sk_' + 'a'.repeat(48);
const PK = 'pk_' + 'b'.repeat(48);
const ATTACKER_KEYS = { keys: [{ id: '00000000-0000-4000-8000-000000000001', key_hash: 'f'.repeat(64), key_prefix: 'sk_evil', role: 'admin' }] };

function initApp(merchant: unknown) {
  const app = new OpenAPIHono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/setup', adminSetup);
  return (body: unknown) =>
    app.request('/v1/setup/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('bootstrap API keys', () => {
  it('stores hashes of MERCHANT_SK/PK at startup, so /v1/setup/init is refused', async () => {
    const { merchant, ready } = createMerchantDb({ MERCHANT_SK: SK, MERCHANT_PK: PK });
    await ready();
    const rows = merchant.query<{ key_hash: string; role: string }>(`SELECT key_hash, role FROM api_keys ORDER BY role`);
    expect(rows).toEqual([
      { key_hash: await hashKey(SK), role: 'admin' },
      { key_hash: await hashKey(PK), role: 'public' },
    ]);

    const res = await initApp(merchant)(ATTACKER_KEYS);
    expect(res.status).toBe(409);
    expect(merchant.query(`SELECT 1 FROM api_keys WHERE key_prefix = 'sk_evil'`)).toEqual([]);
  });

  it('without bootstrap keys, the first /v1/setup/init call still works (local dev)', async () => {
    const { merchant, ready } = createMerchantDb();
    await ready();
    expect(merchant.query(`SELECT 1 FROM api_keys`)).toEqual([]);
    expect((await initApp(merchant)(ATTACKER_KEYS)).status).toBe(200);
  });
});

describe('GET /v1/setup/config redaction', () => {
  it('hides credential fields but keeps everything else', async () => {
    const { redactConfigValue } = await import('../src/routes/setup');
    expect(
      JSON.parse(redactConfigValue(JSON.stringify({ secret_key: 'sk_live_x', webhook_secret: null, store_password: 'enc', store_id: 's1', nested: { api_key: 'k' } }))!)
    ).toEqual({ secret_key: '[redacted]', webhook_secret: null, store_password: '[redacted]', store_id: 's1', nested: { api_key: '[redacted]' } });
    expect(redactConfigValue('plain')).toBe('plain');
    expect(redactConfigValue(null)).toBeNull();
  });
});
