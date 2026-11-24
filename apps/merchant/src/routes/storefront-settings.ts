/**
 * Storefront settings: languages, UCP switch, AI status.
 *
 *   GET /v1/storefront/settings            — public: which languages the shop offers
 *   GET /v1/admin/settings/languages       — admin
 *   PUT /v1/admin/settings/languages       — admin: enabled list + default
 *   GET /v1/admin/settings/ai-agents       — admin: UCP + AI provider status (no secrets)
 *   PUT /v1/admin/settings/ucp             — admin: turn UCP on/off
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ErrorResponse } from '../schemas';
import { ApiError, type HonoEnv } from '../types';
import { getDb } from '../db';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { purgeByPrefix } from '../middleware/kv-cache';
import { loadConfig } from './ai';
import {
  SUPPORTED_LANGUAGES,
  getLanguageSettings,
  saveLanguageSettings,
  isUcpEnabled,
  setUcpEnabled,
} from '../lib/storefront-settings';

const Lang = z.enum(SUPPORTED_LANGUAGES);
const LanguageSettings = z
  .object({ enabled: z.array(Lang).min(1), default: Lang })
  .openapi('LanguageSettings');
const LanguageSettingsResponse = LanguageSettings.extend({ supported: z.array(Lang) }).openapi(
  'LanguageSettingsResponse',
);

const AiAgentsStatus = z
  .object({
    ucp: z.object({ enabled: z.boolean(), discovery_url: z.string() }),
    ai: z.object({
      source: z.enum(['kv', 'environment', 'none']),
      gateway: z.boolean(),
      providers: z.array(
        z.object({
          key: z.string(),
          protocol: z.string(),
          models: z.array(z.object({ id: z.string(), usage: z.string(), priority: z.number() })),
          active_keys: z.number().int(),
          expired_keys: z.number().int(),
        }),
      ),
    }),
  })
  .openapi('AiAgentsStatus');

// ── Public ────────────────────────────────────────────────────────────────
export const publicStorefrontSettings = new OpenAPIHono<HonoEnv>();

publicStorefrontSettings.openapi(
  createRoute({
    method: 'get',
    path: '/settings',
    tags: ['Storefront'],
    summary: 'Public storefront settings',
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ languages: LanguageSettings }) } },
        description: 'Settings',
      },
    },
  }),
  async (c) => c.json({ languages: await getLanguageSettings(getDb(c.var.db)) }, 200),
);

// ── Admin ─────────────────────────────────────────────────────────────────
export const adminStorefrontSettings = new OpenAPIHono<HonoEnv>();
adminStorefrontSettings.use('*', authMiddleware);

const security = [{ bearerAuth: ['legacy sk_', 'admin:store'] }];

adminStorefrontSettings.openapi(
  createRoute({
    method: 'get',
    path: '/languages',
    tags: ['Storefront'],
    summary: 'Language settings',
    security,
    middleware: [adminOnly] as const,
    responses: { 200: { content: { 'application/json': { schema: LanguageSettingsResponse } }, description: 'Settings' } },
  }),
  async (c) => c.json({ ...(await getLanguageSettings(getDb(c.var.db))), supported: [...SUPPORTED_LANGUAGES] }, 200),
);

adminStorefrontSettings.openapi(
  createRoute({
    method: 'put',
    path: '/languages',
    tags: ['Storefront'],
    summary: 'Update language settings',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: LanguageSettings } } } },
    responses: {
      200: { content: { 'application/json': { schema: LanguageSettingsResponse } }, description: 'Saved' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    if (!body.enabled.includes(body.default)) {
      throw ApiError.invalidRequest('The default language must be one of the enabled languages');
    }
    const saved = await saveLanguageSettings(getDb(c.var.db), body);
    return c.json({ ...saved, supported: [...SUPPORTED_LANGUAGES] }, 200);
  },
);

adminStorefrontSettings.openapi(
  createRoute({
    method: 'get',
    path: '/ai-agents',
    tags: ['Storefront'],
    summary: 'UCP and AI provider status',
    description: 'Never returns API keys.',
    security,
    middleware: [adminOnly] as const,
    responses: { 200: { content: { 'application/json': { schema: AiAgentsStatus } }, description: 'Status' } },
  }),
  async (c) => {
    const db = getDb(c.var.db);
    const origin = c.env.API_BASE_URL || new URL(c.req.url).origin;
    const config = await loadConfig(c.env).catch(() => null);
    const envConfigured = Boolean(c.env.AI_API_KEY && c.env.AI_MODEL && c.env.AI_API_URL);

    const providers = config
      ? Object.entries(config.providers).map(([key, p]) => ({
          key,
          protocol: p.protocol,
          models: p.models
            .map((m) => ({ id: m.id, usage: m.usage ?? 'chat', priority: m.priority }))
            .sort((a, b) => a.priority - b.priority),
          active_keys: p.keys.filter((k) => k.type !== 'expired').length,
          expired_keys: p.keys.filter((k) => k.type === 'expired').length,
        }))
      : envConfigured
        ? [
            {
              key: 'environment',
              protocol: 'openai',
              models: [{ id: c.env.AI_MODEL as string, usage: 'chat', priority: 1 }],
              active_keys: 1,
              expired_keys: 0,
            },
          ]
        : [];

    return c.json(
      {
        ucp: { enabled: await isUcpEnabled(db), discovery_url: `${origin}/.well-known/ucp` },
        ai: {
          source: config ? ('kv' as const) : envConfigured ? ('environment' as const) : ('none' as const),
          gateway: Boolean(c.env.CLOUDFLARE_AIG_TOKEN),
          providers,
        },
      },
      200,
    );
  },
);

adminStorefrontSettings.openapi(
  createRoute({
    method: 'put',
    path: '/ucp',
    tags: ['Storefront'],
    summary: 'Turn UCP (AI shopping agents) on or off',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } } },
    responses: {
      200: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } }, description: 'Saved' },
    },
  }),
  async (c) => {
    const { enabled } = c.req.valid('json');
    await setUcpEnabled(getDb(c.var.db), enabled);
    // Cached UCP responses are served before any route runs; drop them so the
    // switch takes effect now rather than after the cache TTL.
    const kv = c.env.KV_CACHE;
    if (kv) {
      const origin = new URL(c.req.url).origin;
      const purge = Promise.all([
        purgeByPrefix(kv, `cache:${origin}/.well-known/ucp`),
        purgeByPrefix(kv, `cache:${origin}/ucp/v1/`),
      ]);
      try {
        c.executionCtx.waitUntil(purge);
      } catch {
        await purge; // no execution context (tests)
      }
    }
    return c.json({ enabled }, 200);
  },
);
