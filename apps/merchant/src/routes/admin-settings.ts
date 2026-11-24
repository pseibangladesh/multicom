// apps/merchant/src/routes/admin-settings.ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, HonoEnv } from '../types';
import {
  SSLCOMMERZ_CONFIG_KEY,
  STRIPE_CONFIG_KEY,
  encryptSecret,
  getSslcommerzSettings,
  getStripeSettings,
  readConfigJson,
  stripeMode,
  writeConfigJson,
} from '../lib/payment-config';

// ─── App setup ────────────────────────────────────────────────────────
const adminApp = new OpenAPIHono<HonoEnv>();
// Mounted at /v1/admin, so this middleware runs for EVERY /v1/admin/* route
// (Hono applies a sub-app's use('*') to the whole prefix). adminOnly reads
// c.get('auth'), so authentication must run first or every request 500s.
adminApp.use('*', authMiddleware);
adminApp.use('*', adminOnly);

// ─── Schemas ──────────────────────────────────────────────────────────
const KeySource = z.enum(['dashboard', 'environment', 'legacy', 'none']);

const StripeSettingsView = z.object({
  enabled: z.boolean().openapi({ description: 'The admin on/off switch' }),
  active: z.boolean().openapi({ description: 'Shoppers can pay with Stripe (switched on and a secret key is available)' }),
  mode: z.enum(['test', 'live']).nullable(),
  publishable_key: z.string(),
  secret_key_set: z.boolean(),
  secret_key_last4: z.string().nullable(),
  secret_key_source: KeySource,
  webhook_secret_set: z.boolean(),
  webhook_secret_source: KeySource,
  webhook_url: z.string(),
});

const GatewaySettingsView = z.object({
  sslcommerz: z.object({
    enabled: z.boolean(),
    store_id: z.string(),
    sandbox: z.boolean(),
  }),
  stripe: StripeSettingsView,
});

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

function webhookUrl(requestUrl: string, apiBase: string | undefined): string {
  const base = (apiBase || new URL(requestUrl).origin).replace(/\/+$/, '');
  return `${base}/v1/webhooks/stripe`;
}

async function stripeView(c: { var: HonoEnv['Variables']; env: HonoEnv['Bindings']; req: { url: string } }) {
  const db = getDb(c.var.db);
  const s = await getStripeSettings(db, c.env);
  return {
    enabled: s.switched_on,
    active: s.enabled,
    mode: stripeMode(s.secretKey),
    publishable_key: s.publishableKey ?? '',
    secret_key_set: s.secretKey !== null,
    secret_key_last4: s.secretKey ? s.secretKey.slice(-4) : null,
    secret_key_source: s.secretKeySource,
    webhook_secret_set: s.webhookSecret !== null,
    webhook_secret_source: s.webhookSecretSource,
    webhook_url: webhookUrl(c.req.url, c.env.API_BASE_URL),
  };
}

// ─── GET /v1/admin/settings/payment-gateways ─────────────────────────
const getGatewaySettings = createRoute({
  method: 'get',
  path: '/settings/payment-gateways',
  tags: ['Admin Settings'],
  summary: 'Get payment gateway settings',
  description: 'SSLCommerz and Stripe settings. Secrets are never returned, only whether they are set.',
  responses: {
    200: { content: { 'application/json': { schema: GatewaySettingsView } }, description: 'Payment gateway configuration' },
  },
});

adminApp.openapi(getGatewaySettings, async (c) => {
  const db = getDb(c.var.db);
  return c.json({ sslcommerz: await getSslcommerzSettings(db), stripe: await stripeView(c) }, 200);
});

// ─── PUT /v1/admin/settings/payment-gateways (SSLCommerz) ────────────
const putGatewaySettings = createRoute({
  method: 'put',
  path: '/settings/payment-gateways',
  tags: ['Admin Settings'],
  summary: 'Update SSLCommerz settings',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      enabled: z.boolean().optional(),
      store_id: z.string().min(1).optional(),
      store_password: z.string().min(1).optional(),
      sandbox: z.boolean().optional(),
    }) } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } }, description: 'Settings saved' },
    400: { content: { 'application/json': { schema: ErrorBody } }, description: 'Invalid request' },
  },
});

adminApp.openapi(putGatewaySettings, async (c) => {
  const body = c.req.valid('json');
  const db = getDb(c.var.db);
  const cryptoken = c.env.CRYPTOKEN;

  if (!cryptoken) {
    throw ApiError.invalidRequest('CRYPTOKEN environment variable is not set. Cannot save encrypted credentials.');
  }

  const existing = (await readConfigJson(db, SSLCOMMERZ_CONFIG_KEY)) ?? {};

  const merged: Record<string, unknown> = {
    ...existing,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled ?? false,
    store_id: body.store_id !== undefined ? body.store_id : existing.store_id,
    sandbox: body.sandbox !== undefined ? body.sandbox : existing.sandbox !== false,
  };

  if (body.store_password) {
    merged.store_password = await encryptSecret(body.store_password, cryptoken);
  } else if (!merged.store_password) {
    throw ApiError.invalidRequest('store_password is required');
  }

  if (!merged.store_id) {
    throw ApiError.invalidRequest('store_id is required');
  }

  await writeConfigJson(db, SSLCOMMERZ_CONFIG_KEY, merged);
  return c.json({ ok: true as const }, 200);
});

// ─── PUT /v1/admin/settings/payment-gateways/stripe ──────────────────
const STRIPE_SECRET_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;
const STRIPE_PUBLISHABLE_RE = /^pk_(test|live)_[A-Za-z0-9]+$/;
const STRIPE_WEBHOOK_RE = /^whsec_[A-Za-z0-9+/=]+$/;

const putStripeSettings = createRoute({
  method: 'put',
  path: '/settings/payment-gateways/stripe',
  tags: ['Admin Settings'],
  summary: 'Update Stripe settings',
  description:
    'Turn Stripe checkout on or off and store its keys (encrypted with CRYPTOKEN). ' +
    'Omit a secret to keep the current one. Saved keys take precedence over the STRIPE_* environment variables.',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      enabled: z.boolean().optional(),
      publishable_key: z.string().regex(STRIPE_PUBLISHABLE_RE, 'Must start with pk_test_ or pk_live_').or(z.literal('')).optional(),
      secret_key: z.string().regex(STRIPE_SECRET_RE, 'Must start with sk_test_, sk_live_, rk_test_ or rk_live_').optional(),
      webhook_secret: z.string().regex(STRIPE_WEBHOOK_RE, 'Must start with whsec_').optional(),
    }) } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ ok: z.literal(true), stripe: StripeSettingsView }) } }, description: 'Settings saved' },
    400: { content: { 'application/json': { schema: ErrorBody } }, description: 'Invalid request or key rejected by Stripe' },
  },
});

adminApp.openapi(putStripeSettings, async (c) => {
  const body = c.req.valid('json');
  const db = getDb(c.var.db);
  const cryptoken = c.env.CRYPTOKEN;

  if ((body.secret_key || body.webhook_secret) && !cryptoken) {
    throw ApiError.invalidRequest('CRYPTOKEN environment variable is not set. Cannot save encrypted credentials.');
  }

  if (body.secret_key) {
    // Same check as POST /v1/setup/stripe: a key Stripe rejects is never stored.
    let res: Response;
    try {
      res = await fetch('https://api.stripe.com/v1/balance', {
        headers: { Authorization: `Bearer ${body.secret_key}` },
      });
    } catch {
      throw ApiError.invalidRequest('Could not reach Stripe to verify the secret key. Try again.');
    }
    if (!res.ok) throw ApiError.invalidRequest('Stripe rejected this secret key.');
  }

  const existing = (await readConfigJson(db, STRIPE_CONFIG_KEY)) ?? {};
  const merged: Record<string, unknown> = {
    ...existing,
    enabled: body.enabled ?? existing.enabled !== false,
  };
  if (body.publishable_key !== undefined) merged.publishable_key = body.publishable_key;
  if (body.secret_key) merged.secret_key = await encryptSecret(body.secret_key, cryptoken as string);
  if (body.webhook_secret) merged.webhook_secret = await encryptSecret(body.webhook_secret, cryptoken as string);

  // Validate the result before storing it.
  const before = await getStripeSettings(db, c.env);
  const secretKey = body.secret_key ?? before.secretKey;
  if (merged.enabled === true && !secretKey) {
    throw ApiError.invalidRequest('Add a Stripe secret key before enabling Stripe.');
  }
  const publishable = typeof merged.publishable_key === 'string' && merged.publishable_key
    ? merged.publishable_key
    : before.publishableKey;
  const pkMode = publishable?.startsWith('pk_live_') ? 'live' : publishable?.startsWith('pk_test_') ? 'test' : null;
  const skMode = stripeMode(secretKey);
  if (pkMode && skMode && pkMode !== skMode) {
    throw ApiError.invalidRequest(`The publishable key is a ${pkMode} key but the secret key is a ${skMode} key.`);
  }

  await writeConfigJson(db, STRIPE_CONFIG_KEY, merged);
  return c.json({ ok: true as const, stripe: await stripeView(c) }, 200);
});

export { adminApp as adminSettings };
