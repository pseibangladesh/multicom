/**
 * Stripe settings on the Payment Gateways page:
 * PUT /v1/admin/settings/payment-gateways/stripe, GET .../payment-gateways,
 * GET /v1/payment-methods, and the key resolution every Stripe caller uses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createMerchantDb } from './helpers/merchant-db';
import { adminSettings } from '../src/routes/admin-settings';
import { publicPaymentMethods } from '../src/routes/payment-methods';
import { adminCheckout } from '../src/routes/checkout';
import { getDb } from '../src/db';
import { getStripeSettings, stripeMode } from '../src/lib/payment-config';
import { ApiError, type HonoEnv } from '../src/types';

const SK = 'sk_' + 'd'.repeat(48);
const PK = 'pk_' + 'd'.repeat(48);
const CRYPTOKEN = 'test-cryptoken-'.padEnd(48, 'x');
const STRIPE_SK = 'sk_test_51Abc' + 'Z'.repeat(20) + 'k9Q2';
const STRIPE_PK = 'pk_test_51Abc' + 'Y'.repeat(20);
const WHSEC = 'whsec_' + 'w'.repeat(32);

afterEach(() => vi.unstubAllGlobals());

/** Stripe's /v1/balance answers `ok` for key verification. */
function stubStripe(ok: boolean) {
  const fetchMock = vi.fn(async () => new Response(ok ? '{}' : '{"error":{}}', { status: ok ? 200 : 401 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function setup(env: Record<string, string> = {}) {
  const fullEnv = { MERCHANT_SK: SK, MERCHANT_PK: PK, CRYPTOKEN, API_BASE_URL: 'https://api.shop.test', ...env };
  const { merchant, ready } = createMerchantDb(fullEnv);
  await ready();

  const app = new OpenAPIHono<HonoEnv>();
  app.onError((err, c) => c.json({ error: { message: err.message } }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/payment-methods', publicPaymentMethods);
  app.route('/v1/admin', adminSettings);
  app.route('/v1/carts', adminCheckout);

  const call = (method: string, path: string, body?: unknown, key: string | null = SK) =>
    app.request(`https://api.shop.test${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, fullEnv);

  const putStripe = (body: unknown) => call('PUT', '/v1/admin/settings/payment-gateways/stripe', body);
  const getSettings = async () => (await (await call('GET', '/v1/admin/settings/payment-gateways')).json()) as {
    stripe: Record<string, unknown>;
    sslcommerz: Record<string, unknown>;
  };
  const publicMethods = async () => (await (await call('GET', '/v1/payment-methods', undefined, null)).json()) as {
    stripe: { enabled: boolean; publishable_key: string | null };
    sslcommerz: { enabled: boolean };
  };
  const resolved = () => getStripeSettings(getDb(merchant as never), fullEnv);
  const storedRow = () => merchant.query<{ value: string }>(`SELECT value FROM config WHERE key = 'payment_gateway.stripe'`)[0]?.value;

  return { merchant, call, putStripe, getSettings, publicMethods, resolved, storedRow };
}

describe('Stripe gateway settings', () => {
  it('with nothing saved, falls back to the STRIPE_* environment variables', async () => {
    const { getSettings, publicMethods } = await setup({ STRIPE_SECRET_KEY: STRIPE_SK, STRIPE_WEBHOOK_SECRET: WHSEC });
    const { stripe } = await getSettings();
    expect(stripe).toMatchObject({
      enabled: true,
      active: true,
      mode: 'test',
      secret_key_set: true,
      secret_key_last4: 'k9Q2',
      secret_key_source: 'environment',
      webhook_secret_source: 'environment',
      webhook_url: 'https://api.shop.test/v1/webhooks/stripe',
    });
    expect(JSON.stringify(stripe)).not.toContain(STRIPE_SK);
    expect((await publicMethods()).stripe.enabled).toBe(true);
  });

  it('saves keys encrypted after Stripe accepts the secret key, and prefers them over env', async () => {
    const fetchMock = stubStripe(true);
    const { putStripe, getSettings, resolved, storedRow, publicMethods } = await setup({ STRIPE_SECRET_KEY: 'sk_test_fromenv' });

    const res = await putStripe({ enabled: true, publishable_key: STRIPE_PK, secret_key: STRIPE_SK, webhook_secret: WHSEC });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${STRIPE_SK}` },
    });

    const row = storedRow();
    expect(row).not.toContain(STRIPE_SK);
    expect(row).not.toContain(WHSEC);

    const s = await resolved();
    expect(s).toMatchObject({ enabled: true, secretKey: STRIPE_SK, webhookSecret: WHSEC, secretKeySource: 'dashboard', publishableKey: STRIPE_PK });
    expect((await getSettings()).stripe).toMatchObject({ secret_key_source: 'dashboard', publishable_key: STRIPE_PK });
    expect(await publicMethods()).toEqual({ stripe: { enabled: true, publishable_key: STRIPE_PK }, sslcommerz: { enabled: false } });
  });

  it('does not store a key Stripe rejects', async () => {
    stubStripe(false);
    const { putStripe, storedRow } = await setup();
    const res = await putStripe({ enabled: true, secret_key: STRIPE_SK });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/rejected/);
    expect(storedRow()).toBeUndefined();
  });

  it('switching Stripe off hides it from checkout but keeps the keys for refunds and webhooks', async () => {
    stubStripe(true);
    const { putStripe, publicMethods, resolved, call } = await setup();
    await putStripe({ enabled: true, secret_key: STRIPE_SK, webhook_secret: WHSEC });

    const off = await putStripe({ enabled: false });
    expect(off.status).toBe(200);
    expect((await publicMethods()).stripe).toEqual({ enabled: false, publishable_key: null });
    expect(await resolved()).toMatchObject({ enabled: false, switched_on: false, secretKey: STRIPE_SK, webhookSecret: WHSEC });

    const checkout = await call('POST', '/v1/carts/00000000-0000-4000-8000-000000000000/checkout', {
      success_url: 'https://shop.test/ok',
      cancel_url: 'https://shop.test/cancel',
    }, PK);
    expect(checkout.status).toBe(400);
    expect(((await checkout.json()) as { error: { message: string } }).error.message).toMatch(/turned off/);

    // Turning it back on keeps the saved keys (no secret re-entry needed).
    expect((await putStripe({ enabled: true })).status).toBe(200);
    expect((await resolved()).enabled).toBe(true);
  });

  it('refuses to enable Stripe without any secret key', async () => {
    const { putStripe } = await setup();
    const res = await putStripe({ enabled: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/secret key/);
  });

  it('rejects malformed keys and mixed test/live keys', async () => {
    stubStripe(true);
    const { putStripe } = await setup();
    expect((await putStripe({ secret_key: 'not-a-key' })).status).toBe(400);
    expect((await putStripe({ webhook_secret: 'secret' })).status).toBe(400);
    expect((await putStripe({ publishable_key: 'sk_test_oops' })).status).toBe(400);
    const mixed = await putStripe({ secret_key: STRIPE_SK, publishable_key: 'pk_live_' + 'Y'.repeat(20) });
    expect(mixed.status).toBe(400);
    expect(((await mixed.json()) as { error: { message: string } }).error.message).toMatch(/live key but the secret key is a test key/);
  });

  it('needs the admin key', async () => {
    const { call } = await setup();
    expect((await call('PUT', '/v1/admin/settings/payment-gateways/stripe', { enabled: false }, PK)).status).toBe(403);
    expect((await call('GET', '/v1/admin/settings/payment-gateways', undefined, null)).status).toBe(401);
  });

  it('still reads keys saved by the legacy POST /v1/setup/stripe', async () => {
    const { merchant, resolved } = await setup();
    merchant.run(`INSERT INTO config (key, value) VALUES ('stripe', ?)`, [JSON.stringify({ secret_key: STRIPE_SK, webhook_secret: WHSEC })]);
    expect(await resolved()).toMatchObject({ enabled: true, secretKey: STRIPE_SK, secretKeySource: 'legacy' });
  });

  it('reports test/live mode from the key prefix', () => {
    expect(stripeMode('sk_test_x')).toBe('test');
    expect(stripeMode('rk_live_x')).toBe('live');
    expect(stripeMode(null)).toBeNull();
  });
});

describe('GET /v1/payment-methods', () => {
  it('offers SSLCommerz only when switched on with credentials', async () => {
    const { call, publicMethods } = await setup();
    expect((await publicMethods()).sslcommerz.enabled).toBe(false);
    const saved = await call('PUT', '/v1/admin/settings/payment-gateways', { enabled: true, store_id: 'shop01', store_password: 'pw' });
    expect(saved.status).toBe(200);
    expect(await publicMethods()).toEqual({ stripe: { enabled: false, publishable_key: null }, sslcommerz: { enabled: true } });
  });
});
