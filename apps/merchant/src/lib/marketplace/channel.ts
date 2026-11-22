/**
 * Per-channel settings (marketplace_channels.config_json) and the factory that
 * turns a channel row into a ready-to-use marketplace client.
 *
 * config_json for an eBay channel (all keys optional):
 * {
 *   "environment": "production" | "sandbox",
 *   "marketplace_id": "EBAY_US",
 *   "content_language": "en-US",
 *   "default_carrier": "USPS",
 *   "listing": {
 *     "category_id": "...", "fulfillment_policy_id": "...",
 *     "payment_policy_id": "...", "return_policy_id": "...",
 *     "merchant_location_key": "..."
 *   },
 *   "last_order_import_at": "<ISO 8601>"   // written by order import
 * }
 */
import type { Database } from '../../db';
import { ApiError } from '../../types';
import { CredentialManager } from './auth-manager';
import { EbayClient, type EbayListingConfig } from './ebay';
import { EbayTokenManager, ebayAppFromEnv, type EbayTokenProvider } from './ebay-oauth';
import { EtsyClient, ETSY_DEFAULT_CARRIER_FALLBACK, type EtsyListingDefaults } from './etsy';
import { EtsyTokenManager, etsyAppFromEnv, type EtsyTokenProvider } from './etsy-oauth';
import type { IMarketplaceClient, ShipmentClient } from './types';

export interface EbayChannelConfig {
  environment?: 'production' | 'sandbox';
  marketplace_id?: string;
  content_language?: string;
  default_carrier?: string;
  listing?: Partial<{
    category_id: string;
    fulfillment_policy_id: string;
    payment_policy_id: string;
    return_policy_id: string;
    merchant_location_key: string;
  }>;
  last_order_import_at?: string;
}

/**
 * TEMPORARY fallback until the admin UI writes per-channel listing defaults.
 * Category and business-policy IDs are specific to each seller account, so
 * there is no safe value to hard-code for them; only the location key has a
 * conventional default. Until all five are known, products are pushed as
 * unlisted inventory items (no offer is created).
 */
/** Etsy keys in config_json. `listing_defaults` is needed to create new listings. */
export interface EtsyChannelConfig {
  shop_id?: string;
  default_carrier?: string;
  listing_defaults?: Partial<{
    taxonomy_id: number;
    shipping_profile_id: number;
    readiness_state_id: number;
    return_policy_id: number;
    who_made: 'i_did' | 'someone_else' | 'collective';
    when_made: string;
    is_supply: boolean;
  }>;
  last_order_import_at?: string;
}

/** config_json of any channel; each platform reads its own keys. */
export type ChannelConfig = EbayChannelConfig & EtsyChannelConfig;

export const EBAY_LISTING_FALLBACK: EbayChannelConfig['listing'] = {
  merchant_location_key: 'default',
};

/** eBay's generic carrier code; tracking still uploads, buyers just get no carrier link. */
export const EBAY_DEFAULT_CARRIER_FALLBACK = 'Other';

export interface ChannelRow {
  id: string;
  platform: 'etsy' | 'ebay' | 'amazon';
  status: string;
  config: ChannelConfig;
}

export function parseChannelConfig(raw: string | null | undefined): ChannelConfig {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merges config over the fallback; null unless every required field is present. */
export function resolveListingConfig(config: EbayChannelConfig): EbayListingConfig | null {
  const l = { ...EBAY_LISTING_FALLBACK, ...config.listing };
  if (!l.category_id || !l.fulfillment_policy_id || !l.payment_policy_id || !l.return_policy_id || !l.merchant_location_key) {
    return null;
  }
  return {
    categoryId: l.category_id,
    fulfillmentPolicyId: l.fulfillment_policy_id,
    paymentPolicyId: l.payment_policy_id,
    returnPolicyId: l.return_policy_id,
    merchantLocationKey: l.merchant_location_key,
  };
}

export async function loadChannel(db: Database, channelId: string): Promise<ChannelRow> {
  const [row] = await db.query<{ id: string; platform: ChannelRow['platform']; status: string; config_json: string }>(
    `SELECT id, platform, status, config_json FROM marketplace_channels WHERE id = ?`,
    [channelId],
  );
  if (!row) throw ApiError.notFound('Channel not found');
  return { id: row.id, platform: row.platform, status: row.status, config: parseChannelConfig(row.config_json) };
}

/** Shallow-merges keys into config_json. */
export async function updateChannelConfig(db: Database, channelId: string, patch: Partial<ChannelConfig>): Promise<void> {
  const channel = await loadChannel(db, channelId);
  await db.run(`UPDATE marketplace_channels SET config_json = ?, updated_at = datetime('now') WHERE id = ?`, [
    JSON.stringify({ ...channel.config, ...patch }),
    channelId,
  ]);
}

export interface ClientEnv {
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_RU_NAME?: string;
  EBAY_ENVIRONMENT?: string;
  ETSY_CLIENT_ID?: string;
  ETSY_SHARED_SECRET?: string;
  ETSY_REDIRECT_URI?: string;
  API_BASE_URL?: string;
  CRYPTOKEN?: string;
}

/** Builds an EbayClient for an active eBay channel. `tokens`/`fetch` are injectable for tests. */
export function ebayClientForChannel(
  db: Database,
  env: ClientEnv,
  channel: ChannelRow,
  overrides: { tokens?: EbayTokenProvider; fetch?: typeof fetch } = {},
): EbayClient {
  if (channel.platform !== 'ebay') throw ApiError.invalidRequest(`Channel ${channel.id} is not an eBay channel`);
  if (channel.status !== 'active') throw ApiError.invalidRequest('Channel is not active');

  const environment = channel.config.environment ?? (env.EBAY_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production');

  let tokens = overrides.tokens;
  if (!tokens) {
    const app = ebayAppFromEnv(env);
    if (!app) throw ApiError.invalidRequest('eBay is not configured');
    if (!env.CRYPTOKEN) throw ApiError.internalServerError('CRYPTOKEN is not set');
    tokens = new EbayTokenManager({
      channelId: channel.id,
      credentials: new CredentialManager(db, env.CRYPTOKEN),
      app: { ...app, environment },
      fetch: overrides.fetch,
    });
  }

  return new EbayClient({
    tokens,
    environment,
    channelId: channel.id,
    ...(channel.config.marketplace_id && { marketplaceId: channel.config.marketplace_id }),
    ...(channel.config.content_language && { contentLanguage: channel.config.content_language }),
    listing: resolveListingConfig(channel.config) ?? undefined,
    defaultShippingCarrierCode: channel.config.default_carrier ?? EBAY_DEFAULT_CARRIER_FALLBACK,
    fetch: overrides.fetch,
  });
}

/** Converts config_json listing_defaults; null unless taxonomy and shipping profile are set. */
export function resolveEtsyListingDefaults(config: EtsyChannelConfig): EtsyListingDefaults | null {
  const d = config.listing_defaults;
  if (!d?.taxonomy_id || !d.shipping_profile_id) return null;
  return {
    taxonomyId: d.taxonomy_id,
    shippingProfileId: d.shipping_profile_id,
    ...(d.readiness_state_id && { readinessStateId: d.readiness_state_id }),
    ...(d.return_policy_id && { returnPolicyId: d.return_policy_id }),
    ...(d.who_made && { whoMade: d.who_made }),
    ...(d.when_made && { whenMade: d.when_made }),
    ...(d.is_supply !== undefined && { isSupply: d.is_supply }),
  };
}

/** Builds an EtsyClient for an active Etsy channel. `tokens`/`fetch` are injectable for tests. */
export function etsyClientForChannel(
  db: Database,
  env: ClientEnv,
  channel: ChannelRow,
  overrides: { tokens?: EtsyTokenProvider; fetch?: typeof fetch } = {},
): EtsyClient {
  if (channel.platform !== 'etsy') throw ApiError.invalidRequest(`Channel ${channel.id} is not an Etsy channel`);
  if (channel.status !== 'active') throw ApiError.invalidRequest('Channel is not active');
  if (!channel.config.shop_id) throw ApiError.invalidRequest('Etsy channel has no shop_id; reconnect the channel');

  const app = etsyAppFromEnv(env);
  if (!app) throw ApiError.invalidRequest('Etsy is not configured');

  let tokens = overrides.tokens;
  if (!tokens) {
    if (!env.CRYPTOKEN) throw ApiError.internalServerError('CRYPTOKEN is not set');
    tokens = new EtsyTokenManager({
      channelId: channel.id,
      credentials: new CredentialManager(db, env.CRYPTOKEN),
      app,
      fetch: overrides.fetch,
    });
  }

  return new EtsyClient({
    tokens,
    apiKey: `${app.clientId}:${app.sharedSecret}`,
    shopId: channel.config.shop_id,
    channelId: channel.id,
    listing: resolveEtsyListingDefaults(channel.config) ?? undefined,
    defaultCarrier: channel.config.default_carrier ?? ETSY_DEFAULT_CARRIER_FALLBACK,
    fetch: overrides.fetch,
  });
}

/** The client for any connected channel, by platform. */
export function clientForChannel(
  db: Database,
  env: ClientEnv,
  channel: ChannelRow,
  overrides: { fetch?: typeof fetch } = {},
): IMarketplaceClient & ShipmentClient {
  switch (channel.platform) {
    case 'ebay':
      return ebayClientForChannel(db, env, channel, overrides);
    case 'etsy':
      return etsyClientForChannel(db, env, channel, overrides);
    default:
      throw new ApiError('not_implemented', 501, `${channel.platform} channels are not supported yet`);
  }
}
