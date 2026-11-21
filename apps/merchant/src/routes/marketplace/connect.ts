/**
 * MIT License
 *
 * Copyright (c) 2025 ygwyg
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { Hono } from 'hono';
import { getDb } from '../../db';
import { ApiError, uuid } from '../../types';
import { encrypt } from '../../lib/marketplace/crypto-utils';
import type { MarketplacePlatform } from '../../lib/marketplace/types';

/**
 * OAuth connect routes: initiate platform authorization and handle callbacks.
 *
 * POST /v1/marketplace/connect/:platform — Generate auth URL for the given platform.
 * GET  /v1/marketplace/connect/:platform/callback — OAuth callback handler.
 */

export function connectRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // ── POST /connect/:platform — Initiate OAuth ────────────────────────────

  app.post('/:platform', async (c) => {
    const db = getDb(c.var.db);
    const platform = c.req.param('platform') as MarketplacePlatform;
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

    if (!['etsy', 'ebay', 'amazon'].includes(platform)) {
      throw ApiError.invalidRequest('Invalid platform. Supported: etsy, ebay, amazon');
    }

    // Validate API key auth (admin token).
    const apiKey = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!apiKey) {
      throw ApiError.unauthorized('API key required');
    }

    // Look up the admin API key to get store_id.
    const keyHash = await hashKey(apiKey);
    const keyRow = await db.query<{ id: string; role: string }>(
      `SELECT id, role FROM api_keys WHERE key_hash = ?`,
      [keyHash],
    );

    if (keyRow.length === 0 || keyRow[0].role !== 'admin') {
      throw ApiError.unauthorized('Invalid or non-admin API key');
    }

    // Get the store_id from the admin user's config.
    const configRows = await db.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'store_id'`,
      [],
    );
    const storeId = configRows.length > 0 ? JSON.parse(configRows[0].value) : null;
    if (!storeId) {
      throw ApiError.invalidRequest('Store not configured. Complete setup first.');
    }

    // Check if channel already exists.
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM marketplace_channels WHERE platform = ? AND store_id = ?`,
      [platform, storeId],
    );

    let channelId: string;

    if (existing.length > 0) {
      // Channel already connected — return existing.
      channelId = existing[0].id;
    } else {
      // Create a new channel record.
      channelId = uuid();
      await db.run(
        `INSERT INTO marketplace_channels (id, platform, store_id, config_json, status) VALUES (?, ?, ?, '{}', 'active')`,
        [channelId, platform, storeId],
      );
    }

    // Generate platform-specific auth URL.
    const authUrl = await generateAuthUrl(platform, channelId, body);

    return c.json({ ok: true, channelId, authUrl });
  });

  // ── GET /connect/:platform/callback — OAuth redirect handler ────────────

  app.get('/:platform/callback', async (c) => {
    const platform = c.req.param('platform') as MarketplacePlatform;
    const params = new URLSearchParams(c.req.url.split('?')[1] ?? '');
    const code = params.get('code');
    const state = params.get('state');

    if (!code) {
      throw ApiError.invalidRequest('No authorization code received');
    }

    // Look up the channel by store_id from config.
    const db = getDb(c.var.db);
    const configRows = await db.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'store_id'`,
      [],
    );
    const storeId = configRows.length > 0 ? JSON.parse(configRows[0].value) : null;

    if (!storeId) {
      throw ApiError.invalidRequest('Store not configured');
    }

    const channelRow = await db.query<{ id: string }>(
      `SELECT id FROM marketplace_channels WHERE platform = ? AND store_id = ?`,
      [platform, storeId],
    );

    if (channelRow.length === 0) {
      throw ApiError.notFound('Channel not found. Connect first.');
    }

    const channelId = channelRow[0].id;

    // Exchange code for tokens and store encrypted credentials.
    await exchangeCodeForTokens(platform, channelId, code);

    return c.json({ ok: true, channelId });
  });

  return app;
}

// ─── Platform-specific auth URL generation ───────────────────────────────────

async function generateAuthUrl(
  platform: MarketplacePlatform,
  channelId: string,
  body: Record<string, unknown>,
): Promise<string> {
  switch (platform) {
    case 'etsy': {
      // Etsy OAuth 2.0 Authorization Code flow.
      // The app's CLIENT_ID is stored in the config table as key='etsy_client_id'.
      const rows = await globalThis.__env?.ETSY_CLIENT_ID;
      const clientId = process.env.ETSY_CLIENT_ID ?? (body as any)?.client_id ?? '';
      if (!clientId) {
        throw new Error('Etsy: ETSY_CLIENT_ID environment variable not set');
      }
      const state = uuid();
      // Store state for CSRF protection in KV or config table.
      return `https://www.etsy.com/oauth_connect/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`;
    }
    case 'ebay': {
      // eBay OAuth 2.0 Authorization Code flow with RuName redirect URI alias.
      const clientId = process.env.EBAY_CLIENT_ID ?? (body as any)?.client_id ?? '';
      if (!clientId) {
        throw new Error('eBay: EBAY_CLIENT_ID environment variable not set');
      }
      const ruName = process.env.EBAY_RU_NAME;
      if (!ruName) {
        throw new Error('eBay: EBAY_RU_NAME environment variable not set');
      }
      const state = uuid();
      // Store state for CSRF protection in KV or config table.
      const scopes = [
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.account',
      ].join('%20');
      return `https://signin.ebay.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
    }
    case 'amazon': {
      // Amazon LWA (Login with Amazon) OAuth 2.0 Authorization Code flow.
      const clientId = process.env.AMAZON_LWA_APP_ID ?? (body as any)?.client_id ?? '';
      if (!clientId) {
        throw new Error('Amazon: AMAZON_LWA_APP_ID environment variable not set');
      }
      const state = uuid();
      const scopes = [
        'calls:2021-03-01',
        'inventory:2021-03-01',
        'orders:2021-01-01',
        'notifications:2020-10-01',
      ].join('%20');
      return `https://www.amazon.com/ap/oa?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
    }
  }
}

// ─── Platform-specific token exchange ────────────────────────────────────────

async function exchangeCodeForTokens(
  platform: MarketplacePlatform,
  channelId: string,
  code: string,
): Promise<void> {
  // Placeholder — each platform implementation fills this in during its phase.
  // Phase 1 (Etsy) will replace this with the actual token exchange logic.
  switch (platform) {
    case 'etsy': {
      // Will exchange code for Etsy OAuth 2.0 access + refresh tokens.
      console.log(`[marketplace] Token exchange placeholder for ${platform}`);
      break;
    }
    case 'ebay': {
      // Exchange authorization code for user access + refresh tokens.
      const clientId = process.env.EBAY_CLIENT_ID ?? '';
      const clientSecret = process.env.EBAY_CLIENT_SECRET ?? '';
      if (!clientId || !clientSecret) {
        throw new Error('eBay: EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables not set');
      }

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      });

      if (!response.ok) {
        throw new Error(`eBay token exchange failed: ${response.status} ${response.statusText}`);
      }

      const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number };

      // Store encrypted credentials in marketplace_credentials table.
      const db = getDb(globalThis.__db__);
      const encryptedAccess = await encrypt(tokens.access_token, process.env.CRYPTOKEN ?? '');
      const encryptedRefresh = await encrypt(tokens.refresh_token, process.env.CRYPTOKEN ?? '');

      // Save access token (oauth_token type).
      await db.run(
        `INSERT INTO marketplace_credentials 
          (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
          VALUES (?, ?, 'oauth_token', ?, '{}', datetime('now'), datetime('now'))
          ON CONFLICT(channel_id, credential_type) DO UPDATE SET
            encrypted_value = excluded.encrypted_value,
            metadata = excluded.metadata,
            updated_at = datetime('now')`,
        [
          crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          channelId,
          encryptedAccess,
        ],
      );

      // Save refresh token (refresh_token type).
      await db.run(
        `INSERT INTO marketplace_credentials 
          (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
          VALUES (?, ?, 'refresh_token', ?, '{}', datetime('now'), datetime('now'))
          ON CONFLICT(channel_id, credential_type) DO UPDATE SET
            encrypted_value = excluded.encrypted_value,
            metadata = excluded.metadata,
            updated_at = datetime('now')`,
        [
          crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          channelId,
          encryptedRefresh,
        ],
      );

      // Store tokens in channel config for immediate use.
      await db.run(
        `UPDATE marketplace_channels SET config_json = json_set(config_json, 
          '$.access_token', ?, '$.refresh_token', ?, '$.token_expires_at', ?)
          WHERE id = ?`,
        [tokens.access_token, tokens.refresh_token, String(Date.now() + tokens.expires_in * 1000), channelId],
      );

      console.log(`[marketplace] eBay tokens exchanged and stored for channel ${channelId}`);
      break;
    }
    case 'amazon': {
      // Exchange authorization code for LWA access + refresh tokens, plus store AWS credentials.
      const clientId = process.env.AMAZON_LWA_APP_ID ?? '';
      const clientSecret = process.env.AMAZON_LWA_APP_SECRET ?? '';
      if (!clientId || !clientSecret) {
        throw new Error('Amazon: AMAZON_LWA_APP_ID and AMAZON_LWA_APP_SECRET environment variables not set');
      }

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const response = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      });

      if (!response.ok) {
        throw new Error(`Amazon LWA token exchange failed: ${response.status} ${response.statusText}`);
      }

      const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number };

      // Store encrypted credentials in marketplace_credentials table.
      const db = getDb(globalThis.__db__);
      const encryptedAccess = await encrypt(tokens.access_token, process.env.CRYPTOKEN ?? '');
      const encryptedRefresh = await encrypt(tokens.refresh_token, process.env.CRYPTOKEN ?? '');

      // Save LWA access token (oauth_token type).
      await db.run(
        `INSERT INTO marketplace_credentials 
          (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
          VALUES (?, ?, 'oauth_token', ?, '{}', datetime('now'), datetime('now'))
          ON CONFLICT(channel_id, credential_type) DO UPDATE SET
            encrypted_value = excluded.encrypted_value,
            metadata = excluded.metadata,
            updated_at = datetime('now')`,
        [
          crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          channelId,
          encryptedAccess,
        ],
      );

      // Save LWA refresh token (refresh_token type).
      await db.run(
        `INSERT INTO marketplace_credentials 
          (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
          VALUES (?, ?, 'refresh_token', ?, '{}', datetime('now'), datetime('now'))
          ON CONFLICT(channel_id, credential_type) DO UPDATE SET
            encrypted_value = excluded.encrypted_value,
            metadata = excluded.metadata,
            updated_at = datetime('now')`,
        [
          crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          channelId,
          encryptedRefresh,
        ],
      );

      // Store AWS credentials (api_key type stores Access Key ID).
      const awsAccessKey = process.env.AMAZON_AWS_ACCESS_KEY ?? '';
      const awsSecretKey = process.env.AMAZON_AWS_SECRET_KEY ?? '';
      if (awsAccessKey && awsSecretKey) {
        const encryptedAwsAccess = await encrypt(awsAccessKey, process.env.CRYPTOKEN ?? '');
        const encryptedAwsSecret = await encrypt(awsSecretKey, process.env.CRYPTOKEN ?? '');

        // AWS Access Key ID.
        await db.run(
          `INSERT INTO marketplace_credentials 
            (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
            VALUES (?, ?, 'api_key', ?, '{}', datetime('now'), datetime('now'))
            ON CONFLICT(channel_id, credential_type) DO UPDATE SET
              encrypted_value = excluded.encrypted_value,
              metadata = excluded.metadata,
              updated_at = datetime('now')`,
          [
            crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            channelId,
            encryptedAwsAccess,
          ],
        );

        // AWS Secret Access Key — stored with a custom credential_type.
        await db.run(
          `INSERT INTO marketplace_credentials 
            (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
            VALUES (?, ?, 'secret_key', ?, '{}', datetime('now'), datetime('now'))
            ON CONFLICT(channel_id, credential_type) DO UPDATE SET
              encrypted_value = excluded.encrypted_value,
              metadata = excluded.metadata,
              updated_at = datetime('now')`,
          [
            crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            channelId,
            encryptedAwsSecret,
          ],
        );
      }

      // Store tokens in channel config for immediate use.
      await db.run(
        `UPDATE marketplace_channels SET config_json = json_set(config_json, 
          '$.access_token', ?, '$.refresh_token', ?, '$.token_expires_at', ?)
          WHERE id = ?`,
        [tokens.access_token, tokens.refresh_token, String(Date.now() + tokens.expires_in * 1000), channelId],
      );

      console.log(`[marketplace] Amazon LWA tokens exchanged and stored for channel ${channelId}`);
      break;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
