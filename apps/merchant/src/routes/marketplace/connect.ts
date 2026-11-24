import { Hono } from 'hono';
import { getDb } from '../../db';
import { ApiError, uuid, type HonoEnv } from '../../types';
import { allowedOrigins } from '../../lib/session';
import { CredentialManager } from '../../lib/marketplace/auth-manager';
import {
  buildEbayAuthorizeUrl,
  ebayAppFromEnv,
  exchangeEbayCode,
  saveEbayTokens,
  EbayOAuthError,
} from '../../lib/marketplace/ebay-oauth';
import {
  buildEtsyAuthorizeUrl,
  createCodeVerifier,
  etsyAppFromEnv,
  exchangeEtsyCode,
  saveEtsyTokens,
  EtsyOAuthError,
} from '../../lib/marketplace/etsy-oauth';
import { fetchEtsyShopId, EtsyApiError } from '../../lib/marketplace/etsy';
import {
  amazonAppFromEnv,
  buildAmazonAuthorizeUrl,
  buildAmazonLoginReturnUrl,
  exchangeAmazonCode,
  isAmazonCallbackUri,
  saveAmazonTokens,
  AmazonOAuthError,
} from '../../lib/marketplace/amazon-oauth';
import { fetchMarketplaceParticipations, pickMarketplace, AmazonApiError } from '../../lib/marketplace/amazon';
import { parseChannelConfig, type ChannelConfig } from '../../lib/marketplace/channel';
import type { MarketplacePlatform } from '../../lib/marketplace/types';

/**
 * OAuth connect flow (admin only; mounted behind authMiddleware + adminOnly).
 *
 *   POST /connect/:platform          → { authUrl, state }; records a single-use state
 *   GET  /connect/:platform/callback → consumes the state, exchanges the code,
 *                                      stores tokens, creates/activates the channel
 *
 * The state is the CSRF defence: 256 bits of randomness, bound to the platform,
 * valid for 10 minutes, and deleted atomically on first use. The channel row is
 * only created (or re-activated) once tokens have actually been obtained.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Single-merchant DO: every channel belongs to the one store. */
const DEFAULT_STORE_ID = 'default';

const PLATFORMS: readonly MarketplacePlatform[] = ['etsy', 'ebay', 'amazon'];

function parsePlatform(raw: string): MarketplacePlatform {
  if (!PLATFORMS.includes(raw as MarketplacePlatform)) {
    throw ApiError.invalidRequest('Invalid platform. Supported: etsy, ebay, amazon');
  }
  return raw as MarketplacePlatform;
}

function notImplemented(platform: string): ApiError {
  return new ApiError('not_implemented', 501, `${platform} connection is not implemented yet`);
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only allow redirecting back to our own front-end origins (no open redirect). */
function safeReturnTo(raw: unknown, origins: string[]): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    return origins.includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

function withParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function connectRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post('/:platform', async (c) => {
    const platform = parsePlatform(c.req.param('platform'));

    let authorize: (state: string) => Promise<{ authUrl: string; codeVerifier?: string }>;
    if (platform === 'ebay') {
      const ebay = ebayAppFromEnv(c.env);
      if (!ebay) throw ApiError.invalidRequest('eBay is not configured (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME)');
      authorize = async (state) => ({ authUrl: buildEbayAuthorizeUrl(ebay, state) });
    } else if (platform === 'etsy') {
      const etsy = etsyAppFromEnv(c.env);
      if (!etsy) {
        throw ApiError.invalidRequest('Etsy is not configured (ETSY_CLIENT_ID, ETSY_SHARED_SECRET, and ETSY_REDIRECT_URI or API_BASE_URL)');
      }
      // PKCE: the verifier stays server-side with the state; only its hash goes to Etsy.
      authorize = async (state) => {
        const codeVerifier = createCodeVerifier();
        return { authUrl: await buildEtsyAuthorizeUrl(etsy, state, codeVerifier), codeVerifier };
      };
    } else if (platform === 'amazon') {
      const amazon = amazonAppFromEnv(c.env);
      if (!amazon) {
        throw ApiError.invalidRequest(
          'Amazon is not configured (AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_SP_APP_ID, and AMAZON_REDIRECT_URI or API_BASE_URL)',
        );
      }
      authorize = async (state) => ({ authUrl: buildAmazonAuthorizeUrl(amazon, state) });
    } else {
      throw notImplemented(platform);
    }

    const body = (await c.req.json().catch(() => ({}))) as { channel_id?: unknown; return_to?: unknown };
    const db = getDb(c.var.db);

    // Reconnecting an existing channel (e.g. after its refresh token expired).
    let channelId: string | null = null;
    if (body.channel_id !== undefined) {
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM marketplace_channels WHERE id = ? AND platform = ?`,
        [String(body.channel_id), platform],
      );
      if (rows.length === 0) throw ApiError.notFound('Channel not found');
      channelId = rows[0].id;
    }

    const returnTo = body.return_to === undefined ? null : safeReturnTo(body.return_to, allowedOrigins(c.env));
    if (body.return_to !== undefined && !returnTo) {
      throw ApiError.invalidRequest('return_to must be a URL on an allowed origin');
    }

    const now = Date.now();
    await db.run(`DELETE FROM marketplace_oauth_states WHERE expires_at <= ?`, [new Date(now).toISOString()]);

    const state = randomState();
    const { authUrl, codeVerifier } = await authorize(state);
    await db.run(
      `INSERT INTO marketplace_oauth_states (state, platform, channel_id, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [state, platform, channelId, codeVerifier ?? null, returnTo, new Date(now + OAUTH_STATE_TTL_MS).toISOString()],
    );

    return c.json({ ok: true, authUrl, state });
  });

  /**
   * Amazon "Login URI" step of the website authorization workflow. Register
   * <API_BASE_URL>/v1/marketplace/connect/amazon/login as the app's Login URI.
   * Amazon sends the admin here after consent; we hand them back to Seller
   * Central with the pending state, and Amazon then calls the redirect URI.
   */
  app.get('/amazon/login', async (c) => {
    const amazon = amazonAppFromEnv(c.env);
    if (!amazon) throw ApiError.invalidRequest('Amazon is not configured');
    const callbackUri = c.req.query('amazon_callback_uri');
    const amazonState = c.req.query('amazon_state');
    if (!amazonState || !isAmazonCallbackUri(callbackUri)) {
      throw ApiError.invalidRequest('Missing or invalid amazon_callback_uri / amazon_state');
    }

    const db = getDb(c.var.db);
    const nowIso = new Date().toISOString();
    const given = c.req.query('state');
    const [pending] = await db.query<{ state: string }>(
      given
        ? `SELECT state FROM marketplace_oauth_states WHERE platform = 'amazon' AND state = ? AND expires_at > ?`
        : `SELECT state FROM marketplace_oauth_states WHERE platform = 'amazon' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`,
      given ? [given, nowIso] : [nowIso],
    );
    if (!pending) throw ApiError.invalidRequest('No Amazon connection in progress; start it again from the admin dashboard');

    return c.redirect(buildAmazonLoginReturnUrl(amazon, callbackUri!, amazonState, pending.state), 302);
  });

  app.get('/:platform/callback', async (c) => {
    const platform = parsePlatform(c.req.param('platform'));
    const state = c.req.query('state');
    if (!state) throw ApiError.invalidRequest('Missing OAuth state');

    const db = getDb(c.var.db);

    // Atomic consume: a replayed or concurrent callback finds nothing.
    const [row] = await db.query<{ channel_id: string | null; code_verifier: string | null; return_to: string | null; expires_at: string }>(
      `DELETE FROM marketplace_oauth_states WHERE state = ? AND platform = ?
       RETURNING channel_id, code_verifier, return_to, expires_at`,
      [state, platform],
    );
    if (!row) throw ApiError.invalidRequest('Invalid or already used OAuth state');
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw ApiError.invalidRequest('OAuth state expired; start the connection again');
    }

    const finish = (result: Record<string, string>, status: 200 | 400 | 502 = 200) =>
      row.return_to
        ? c.redirect(withParams(row.return_to, { marketplace: platform, ...result }), 303)
        : c.json({ ok: result.result === 'connected', ...result }, status);

    // Seller declined consent on the marketplace's page.
    const providerError = c.req.query('error');
    if (providerError) return finish({ result: 'denied', error: providerError }, 400);

    // Amazon names its code spapi_oauth_code.
    const code = c.req.query('code') ?? c.req.query('spapi_oauth_code');
    if (!code) throw ApiError.invalidRequest('No authorization code received');

    if (!c.env.CRYPTOKEN) throw ApiError.internalServerError('CRYPTOKEN is not set; cannot store marketplace credentials');

    // Exchange the code. Nothing is written until this succeeds.
    let saveTokens: (credentials: CredentialManager, channelId: string) => Promise<void>;
    let configPatch: Partial<ChannelConfig>;
    let externalShopId: string | null = null;
    try {
      if (platform === 'ebay') {
        const ebay = ebayAppFromEnv(c.env);
        if (!ebay) throw ApiError.invalidRequest('eBay is not configured');
        const tokens = await exchangeEbayCode(ebay, code);
        saveTokens = (cm, id) => saveEbayTokens(cm, id, tokens);
        configPatch = { environment: ebay.environment };
      } else if (platform === 'amazon') {
        const amazon = amazonAppFromEnv(c.env);
        if (!amazon) throw ApiError.invalidRequest('Amazon is not configured');
        const sellerId = c.req.query('selling_partner_id');
        if (!sellerId) throw ApiError.invalidRequest('No selling_partner_id received from Amazon');
        const tokens = await exchangeAmazonCode(amazon, code);
        // Proves the token works and tells us where the seller sells.
        const participations = await fetchMarketplaceParticipations({
          accessToken: tokens.accessToken,
          region: amazon.region,
          environment: amazon.environment,
        });
        let preferred = amazon.marketplaceId;
        if (row.channel_id) {
          const [prev] = await db.query<{ config_json: string }>(`SELECT config_json FROM marketplace_channels WHERE id = ?`, [row.channel_id]);
          preferred = parseChannelConfig(prev?.config_json).marketplace_id ?? preferred;
        }
        externalShopId = sellerId;
        saveTokens = (cm, id) => saveAmazonTokens(cm, id, tokens);
        configPatch = {
          marketplace_id: amazon.environment === 'sandbox' ? preferred : pickMarketplace(participations, preferred, amazon.region),
          region: amazon.region,
          environment: amazon.environment,
        };
      } else {
        const etsy = etsyAppFromEnv(c.env);
        if (!etsy) throw ApiError.invalidRequest('Etsy is not configured');
        if (!row.code_verifier) throw ApiError.invalidRequest('OAuth state has no PKCE verifier; start the connection again');
        const tokens = await exchangeEtsyCode(etsy, code, row.code_verifier);
        externalShopId = await fetchEtsyShopId({ accessToken: tokens.accessToken, apiKey: `${etsy.clientId}:${etsy.sharedSecret}` });
        saveTokens = (cm, id) => saveEtsyTokens(cm, id, tokens);
        configPatch = { shop_id: externalShopId };
      }
    } catch (err) {
      if (
        err instanceof EbayOAuthError ||
        err instanceof EtsyOAuthError ||
        err instanceof EtsyApiError ||
        err instanceof AmazonOAuthError ||
        err instanceof AmazonApiError
      ) {
        console.error(`[marketplace] ${platform} code exchange failed:`, err.message);
        return finish({ result: 'error', error: 'token_exchange_failed' }, 502);
      }
      throw err;
    }

    // A shop that is already connected keeps its channel (and its order history).
    let channelId = row.channel_id;
    if (!channelId && externalShopId) {
      const [same] = await db.query<{ id: string }>(
        `SELECT id FROM marketplace_channels WHERE platform = ? AND external_shop_id = ? LIMIT 1`,
        [platform, externalShopId],
      );
      channelId = same?.id ?? null;
    }

    if (channelId) {
      const [existing] = await db.query<{ external_shop_id: string | null; config_json: string }>(
        `SELECT external_shop_id, config_json FROM marketplace_channels WHERE id = ?`,
        [channelId],
      );
      // Reconnecting must not silently re-point a channel at a different shop.
      if (externalShopId && existing?.external_shop_id && existing.external_shop_id !== externalShopId) {
        return finish({ result: 'error', error: 'shop_mismatch' }, 400);
      }
      await db.run(
        `UPDATE marketplace_channels SET status = 'active', external_shop_id = COALESCE(?, external_shop_id),
           config_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [externalShopId, JSON.stringify({ ...parseChannelConfig(existing?.config_json), ...configPatch }), channelId],
      );
    } else {
      channelId = uuid();
      await db.run(
        `INSERT INTO marketplace_channels (id, platform, store_id, external_shop_id, config_json, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [channelId, platform, DEFAULT_STORE_ID, externalShopId, JSON.stringify(configPatch)],
      );
    }

    await saveTokens(new CredentialManager(db, c.env.CRYPTOKEN), channelId);
    return finish({ result: 'connected', channelId });
  });

  return app;
}
