/**
 * API key management (Admin → API keys).
 *
 *   GET    /v1/admin/api-keys        — list keys (never the secret)
 *   POST   /v1/admin/api-keys        — create; the full key is returned once
 *   DELETE /v1/admin/api-keys/{id}   — revoke
 *
 * Only the SHA-256 hash is stored (same as the bootstrap keys). The
 * MERCHANT_SK / MERCHANT_PK keys from the environment are re-inserted every
 * time the Durable Object starts, so they are listed as "environment" and
 * cannot be revoked here.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ErrorResponse, DeletedResponse } from '../schemas';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { getDb } from '../db';
import { adminOnly, authMiddleware, hashKey } from '../middleware/auth';

const ApiKey = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    role: z.enum(['public', 'admin']),
    key_prefix: z.string(),
    source: z.enum(['environment', 'admin']),
    created_at: z.string(),
  })
  .openapi('ApiKey');

const ApiKeyList = z.object({ items: z.array(ApiKey) }).openapi('ApiKeyList');
const CreatedApiKey = ApiKey.extend({ key: z.string() }).openapi('CreatedApiKey');

const CreateApiKeyBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(['public', 'admin']),
  })
  .openapi('CreateApiKey');

const IdParam = z.object({ id: z.string().min(1) });

type Row = { id: string; name: string | null; role: 'public' | 'admin'; key_prefix: string; key_hash: string; created_at: string };

function generateKey(role: 'public' | 'admin'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${role === 'admin' ? 'sk' : 'pk'}_${hex}`;
}

async function environmentHashes(env: HonoEnv['Bindings']): Promise<Set<string>> {
  const e = env as unknown as { MERCHANT_SK?: string; MERCHANT_PK?: string };
  const hashes = await Promise.all([e.MERCHANT_SK, e.MERCHANT_PK].filter(Boolean).map((k) => hashKey(k as string)));
  return new Set(hashes);
}

function toApi(row: Row, envHashes: Set<string>) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    key_prefix: row.key_prefix,
    source: envHashes.has(row.key_hash) ? ('environment' as const) : ('admin' as const),
    created_at: row.created_at,
  };
}

export const adminApiKeys = new OpenAPIHono<HonoEnv>();
adminApiKeys.use('*', authMiddleware);

const security = [{ bearerAuth: ['legacy sk_', 'admin:store'] }];

adminApiKeys.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['API keys'],
    summary: 'List API keys',
    security,
    middleware: [adminOnly] as const,
    responses: { 200: { content: { 'application/json': { schema: ApiKeyList } }, description: 'API keys' } },
  }),
  async (c) => {
    const rows = await getDb(c.var.db).query<Row>(`SELECT * FROM api_keys ORDER BY created_at ASC`);
    const env = await environmentHashes(c.env);
    return c.json({ items: rows.map((r) => toApi(r, env)) }, 200);
  },
);

adminApiKeys.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['API keys'],
    summary: 'Create an API key',
    description: 'The full key is only returned in this response. Store it safely.',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: CreateApiKeyBody } } } },
    responses: {
      201: { content: { 'application/json': { schema: CreatedApiKey } }, description: 'Created' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
    },
  }),
  async (c) => {
    const { name, role } = c.req.valid('json');
    const db = getDb(c.var.db);
    const key = generateKey(role);
    const id = uuid();
    await db.run(
      `INSERT INTO api_keys (id, key_hash, key_prefix, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, await hashKey(key), key.slice(0, 8), role, name, now()],
    );
    const [row] = await db.query<Row>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
    return c.json({ ...toApi(row, new Set()), key }, 201);
  },
);

adminApiKeys.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['API keys'],
    summary: 'Revoke an API key',
    security,
    middleware: [adminOnly] as const,
    request: { params: IdParam },
    responses: {
      200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Revoked' },
      404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
      409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cannot revoke this key' },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const db = getDb(c.var.db);
    const [row] = await db.query<Row>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
    if (!row) throw ApiError.notFound('API key not found');

    if ((await environmentHashes(c.env)).has(row.key_hash)) {
      throw ApiError.conflict('This key comes from MERCHANT_SK / MERCHANT_PK in the environment. Change it there instead.');
    }
    const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token && (await hashKey(token)) === row.key_hash) {
      throw ApiError.conflict('You cannot revoke the key this request is using.');
    }

    await db.run(`DELETE FROM api_keys WHERE id = ?`, [id]);
    return c.json({ deleted: true as const }, 200);
  },
);
