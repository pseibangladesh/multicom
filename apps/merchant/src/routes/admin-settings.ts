// apps/merchant/src/routes/admin-settings.ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, HonoEnv } from '../types';

// ─── Encryption helpers ───────────────────────────────────────────────
async function encryptSecret(plaintext: string, password: string): Promise<string> {
  const raw = new TextEncoder().encode(plaintext);
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const pwBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
      baseKey, 384
    )
  );
  const aesKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-CBC', false, ['encrypt']);
  const iv = derived.slice(32, 48);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, raw);
  const combined = new Uint8Array(salt.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(new Uint8Array(encrypted), salt.length);
  return btoa(String.fromCharCode(...combined));
}

// ─── App setup ────────────────────────────────────────────────────────
const adminApp = new OpenAPIHono<HonoEnv>();
// Mounted at /v1/admin, so this middleware runs for EVERY /v1/admin/* route
// (Hono applies a sub-app's use('*') to the whole prefix). adminOnly reads
// c.get('auth'), so authentication must run first or every request 500s.
adminApp.use('*', authMiddleware);
adminApp.use('*', adminOnly);

// ─── GET /v1/admin/settings/payment-gateways ─────────────────────────
const getGatewaySettings = createRoute({
  method: 'get',
  path: '/settings/payment-gateways',
  tags: ['Admin Settings'],
  summary: 'Get payment gateway settings',
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({
        sslcommerz: z.object({
          enabled: z.boolean(),
          store_id: z.string(),
          sandbox: z.boolean(),
        }),
      }) } },
      description: 'Payment gateway configuration',
    },
  },
});

adminApp.openapi(getGatewaySettings, async (c) => {
  const db = getDb(c.var.db);
  const [row] = await db.query<any>(`SELECT value FROM config WHERE key = 'payment_gateway.sslcommerz'`);

  let sslcommerz = { enabled: false, store_id: '', sandbox: true };

  if (row && row.value) {
    try {
      const parsed = JSON.parse(row.value);
      sslcommerz = {
        enabled: parsed.enabled === true,
        store_id: parsed.store_id || '',
        sandbox: parsed.sandbox !== false,
      };
    } catch { /* Malformed config */ }
  }

  return c.json({ sslcommerz }, 200);
});

// ─── PUT /v1/admin/settings/payment-gateways ─────────────────────────
const putGatewaySettings = createRoute({
  method: 'put',
  path: '/settings/payment-gateways',
  tags: ['Admin Settings'],
  summary: 'Update payment gateway settings',
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
    400: { content: { 'application/json': { schema: z.any() } }, description: 'Invalid request' },
  },
});

adminApp.openapi(putGatewaySettings, async (c) => {
  const body = c.req.valid('json');
  const db = getDb(c.var.db);
  const cryptoken = c.env.CRYPTOKEN;

  if (!cryptoken) {
    throw ApiError.invalidRequest('CRYPTOKEN environment variable is not set. Cannot save encrypted credentials.');
  }

  const [existingRow] = await db.query<any>(`SELECT value FROM config WHERE key = 'payment_gateway.sslcommerz'`);
  let existing: any = {};
  if (existingRow && existingRow.value) {
    try { existing = JSON.parse(existingRow.value); } catch { /* ignore */ }
  }

  const merged = {
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

  const configJson = JSON.stringify(merged);

  await db.run(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('payment_gateway.sslcommerz', ?, datetime('now'))`,
    [configJson]
  );

  return c.json({ ok: true }, 200);
});

export { adminApp as adminSettings };