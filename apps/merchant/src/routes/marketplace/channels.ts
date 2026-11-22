import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type Database } from '../../db';
import { ApiError, type HonoEnv } from '../../types';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import {
  parseChannelConfig,
  resolveEtsyListingDefaults,
  resolveListingConfig,
  type ChannelConfig,
} from '../../lib/marketplace/channel';

/**
 * Channel management for the admin UI, mounted at /v1/admin/marketplace.
 *
 *   GET   /channels             every channel with its config and last sync job
 *   PATCH /channels/:id/config  merge settings into config_json
 *
 * PATCH accepts only the editable keys of the channel's platform (strict
 * schemas). OAuth-derived identity (shop_id, environment) and bookkeeping
 * (last_order_import_at) are rejected, so a config edit can never re-point a
 * channel at another shop. `null` removes a key. listing / listing_defaults
 * merge one level deep, so a single field can be changed on its own.
 */

const carrier = z.string().trim().min(1).max(64);
const id = z.string().trim().min(1).max(128);
const positiveInt = z.number().int().positive();

const EBAY_CONFIG_PATCH = z
  .object({
    marketplace_id: z.string().regex(/^EBAY_[A-Z_]{2,}$/, 'e.g. EBAY_US').nullable(),
    content_language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'e.g. en-US').nullable(),
    default_carrier: carrier.nullable(),
    listing: z
      .object({
        category_id: id.nullable(),
        fulfillment_policy_id: id.nullable(),
        payment_policy_id: id.nullable(),
        return_policy_id: id.nullable(),
        merchant_location_key: id.nullable(),
      })
      .partial()
      .strict()
      .nullable(),
  })
  .partial()
  .strict();

const ETSY_CONFIG_PATCH = z
  .object({
    default_carrier: carrier.nullable(),
    listing_defaults: z
      .object({
        taxonomy_id: positiveInt.nullable(),
        shipping_profile_id: positiveInt.nullable(),
        readiness_state_id: positiveInt.nullable(),
        return_policy_id: positiveInt.nullable(),
        who_made: z.enum(['i_did', 'someone_else', 'collective']).nullable(),
        // made_to_order, 2020_2026, before_2007, 1990s, ...
        when_made: z.string().regex(/^(made_to_order|\d{4}_\d{4}|before_\d{4}|\d{4}s)$/).nullable(),
        is_supply: z.boolean().nullable(),
      })
      .partial()
      .strict()
      .nullable(),
  })
  .partial()
  .strict();

const AMAZON_CONDITIONS = [
  'new_new', 'new_open_box', 'new_oem', 'refurbished_refurbished',
  'used_like_new', 'used_very_good', 'used_good', 'used_acceptable',
  'collectible_like_new', 'collectible_very_good', 'collectible_good', 'collectible_acceptable',
] as const;

const AMAZON_CONFIG_PATCH = z
  .object({
    // Must be one of the seller's marketplaces.
    marketplace_id: z.string().regex(/^[A-Z0-9]{9,14}$/, 'e.g. ATVPDKIKX0DER').nullable(),
    default_carrier: carrier.nullable(),
    import_fba_orders: z.boolean().nullable(),
    amazon_listing: z
      .object({
        // Amazon product type, e.g. SHIRT, HOME, PRODUCT.
        product_type: z.string().trim().regex(/^[A-Z0-9_]{2,64}$/, 'e.g. SHIRT').nullable(),
        condition_type: z.enum(AMAZON_CONDITIONS).nullable(),
        brand: z.string().trim().min(1).max(100).nullable(),
        language_tag: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/, 'e.g. en_US').nullable(),
      })
      .partial()
      .strict()
      .nullable(),
  })
  .partial()
  .strict();

const PATCH_SCHEMAS = { ebay: EBAY_CONFIG_PATCH, etsy: ETSY_CONFIG_PATCH, amazon: AMAZON_CONFIG_PATCH } as const;

/** Nested objects whose keys are merged rather than replaced. */
const NESTED_KEYS = new Set(['listing', 'listing_defaults', 'amazon_listing']);

type Json = Record<string, unknown>;

/** Applies a patch: null deletes, nested config objects merge one level deep. */
export function mergeConfig(current: Json, patch: Json): Json {
  const out: Json = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (NESTED_KEYS.has(key) && typeof value === 'object') {
      const nested = mergeConfig((out[key] as Json | undefined) ?? {}, value as Json);
      if (Object.keys(nested).length === 0) delete out[key];
      else out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface ChannelRowDb {
  id: string;
  platform: 'etsy' | 'ebay' | 'amazon';
  status: string;
  external_shop_id: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
  has_token: number;
  job_type: string | null;
  job_status: string | null;
  job_error: string | null;
  job_updated_at: string | null;
}

const CHANNEL_SELECT = `
  SELECT c.id, c.platform, c.status, c.external_shop_id, c.config_json, c.created_at, c.updated_at,
    EXISTS (SELECT 1 FROM marketplace_credentials k WHERE k.channel_id = c.id AND k.credential_type = 'oauth_token') AS has_token,
    j.job_type, j.status AS job_status, j.error_message AS job_error, j.updated_at AS job_updated_at
  FROM marketplace_channels c
  LEFT JOIN marketplace_sync_jobs j ON j.id = (
    SELECT id FROM marketplace_sync_jobs WHERE channel_id = c.id ORDER BY updated_at DESC, created_at DESC LIMIT 1
  )`;

function toSummary(row: ChannelRowDb) {
  const config: ChannelConfig = parseChannelConfig(row.config_json);
  // Amazon can always offer SKUs whose barcode is in its catalog; a product
  // type is what lets it create new products too.
  const listingReady =
    row.platform === 'ebay'
      ? resolveListingConfig(config) !== null
      : row.platform === 'etsy'
        ? resolveEtsyListingDefaults(config) !== null
        : Boolean(config.amazon_listing?.product_type);
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    externalShopId: row.external_shop_id,
    config,
    connected: Boolean(row.has_token),
    /** True when the channel has what it needs to create new listings. */
    listingReady,
    lastOrderImportAt: config.last_order_import_at ?? null,
    lastJob: row.job_type
      ? { type: row.job_type, status: row.job_status, error: row.job_error, updatedAt: row.job_updated_at }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ChannelSummary = ReturnType<typeof toSummary>;

async function getSummary(db: Database, channelId: string): Promise<ChannelSummary> {
  const [row] = await db.query<ChannelRowDb>(`${CHANNEL_SELECT} WHERE c.id = ?`, [channelId]);
  if (!row) throw ApiError.notFound('Channel not found');
  return toSummary(row);
}

export function adminMarketplaceChannelRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.use('*', authMiddleware, adminOnly);

  app.get('/channels', async (c) => {
    const db = getDb(c.var.db);
    const rows = await db.query<ChannelRowDb>(`${CHANNEL_SELECT} ORDER BY c.created_at DESC`);
    return c.json({ ok: true, channels: rows.map(toSummary) });
  });

  app.patch('/channels/:id/config', async (c) => {
    const db = getDb(c.var.db);
    const channelId = c.req.param('id');

    const [row] = await db.query<{ platform: string; config_json: string }>(
      `SELECT platform, config_json FROM marketplace_channels WHERE id = ?`,
      [channelId],
    );
    if (!row) throw ApiError.notFound('Channel not found');

    const schema = PATCH_SCHEMAS[row.platform as keyof typeof PATCH_SCHEMAS];
    if (!schema) throw new ApiError('not_implemented', 501, `${row.platform} channels have no editable config yet`);

    const body = await c.req.json().catch(() => {
      throw ApiError.invalidRequest('Body must be a JSON object');
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.invalidRequest('Invalid channel config', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const next = mergeConfig(parseChannelConfig(row.config_json) as Json, parsed.data as Json);
    await db.run(`UPDATE marketplace_channels SET config_json = ?, updated_at = datetime('now') WHERE id = ?`, [
      JSON.stringify(next),
      channelId,
    ]);
    return c.json({ ok: true, channel: await getSummary(db, channelId) });
  });

  return app;
}
