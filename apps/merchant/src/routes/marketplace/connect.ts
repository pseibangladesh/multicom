import { Hono } from 'hono';
import { getDb } from '../../db';
import { ApiError, uuid, type HonoEnv } from '../../types';
import { encrypt } from '../../lib/marketplace/crypto-utils';
import type { MarketplacePlatform } from '../../lib/marketplace/types';
import type { Context } from 'hono';

export function connectRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post('/:platform', async (c) => {
    const db = getDb(c.var.db);
    const platform = c.req.param('platform') as MarketplacePlatform;
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

    if (!['etsy', 'ebay', 'amazon'].includes(platform)) {
      throw ApiError.invalidRequest('Invalid platform. Supported: etsy, ebay, amazon');
    }

    const apiKey = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!apiKey) throw ApiError.unauthorized('API key required');

    const keyHash = await hashKey(apiKey);
    const keyRow = await db.query<{ id: string; role: string }>(
      `SELECT id, role FROM api_keys WHERE key_hash = ?`, [keyHash]
    );

    if (keyRow.length === 0 || keyRow[0].role !== 'admin') {
      throw ApiError.unauthorized('Invalid or non-admin API key');
    }

    const configRows = await db.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'store_id'`, []
    );
    const storeId = configRows.length > 0 ? JSON.parse(configRows[0].value) : null;
    if (!storeId) throw ApiError.invalidRequest('Store not configured. Complete setup first.');

    const existing = await db.query<{ id: string }>(
      `SELECT id FROM marketplace_channels WHERE platform = ? AND store_id = ?`, [platform, storeId]
    );

    let channelId: string;
    if (existing.length > 0) {
      channelId = existing[0].id;
    } else {
      channelId = uuid();
      await db.run(
        `INSERT INTO marketplace_channels (id, platform, store_id, config_json, status) VALUES (?, ?, ?, '{}', 'active')`,
        [channelId, platform, storeId]
      );
    }

    const authUrl = await generateAuthUrl(c, platform, channelId, body);
    return c.json({ ok: true, channelId, authUrl });
  });

  app.get('/:platform/callback', async (c) => {
    const platform = c.req.param('platform') as MarketplacePlatform;
    const params = new URLSearchParams(c.req.url.split('?')[1] ?? '');
    const code = params.get('code');

    if (!code) throw ApiError.invalidRequest('No authorization code received');

    const db = getDb(c.var.db);
    const configRows = await db.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'store_id'`, []
    );
    const storeId = configRows.length > 0 ? JSON.parse(configRows[0].value) : null;
    if (!storeId) throw ApiError.invalidRequest('Store not configured');

    const channelRow = await db.query<{ id: string }>(
      `SELECT id FROM marketplace_channels WHERE platform = ? AND store_id = ?`, [platform, storeId]
    );
    if (channelRow.length === 0) throw ApiError.notFound('Channel not found. Connect first.');

    const channelId = channelRow[0].id;
    await exchangeCodeForTokens(c, platform, channelId, code);
    return c.json({ ok: true, channelId });
  });

  return app;
}

async function generateAuthUrl(c: Context<HonoEnv>, platform: MarketplacePlatform, channelId: string, body: Record<string, unknown>): Promise<string> {
  switch (platform) {
    case 'etsy': {
      const clientId = c.env.ETSY_CLIENT_ID ?? (body as any)?.client_id ?? '';
      if (!clientId) throw new Error('Etsy: ETSY_CLIENT_ID environment variable not set');
      return `https://www.etsy.com/oauth_connect/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(uuid())}`;
    }
    case 'ebay': {
      const clientId = c.env.EBAY_CLIENT_ID ?? (body as any)?.client_id ?? '';
      const ruName = c.env.EBAY_RU_NAME;
      if (!clientId || !ruName) throw new Error('eBay: credentials not set');
      const scopes = ['https://api.ebay.com/oauth/api_scope/sell.inventory', 'https://api.ebay.com/oauth/api_scope/sell.fulfillment'].join('%20');
      return `https://signin.ebay.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(uuid())}`;
    }
    case 'amazon': {
      const clientId = c.env.AMAZON_LWA_APP_ID ?? (body as any)?.client_id ?? '';
      if (!clientId) throw new Error('Amazon: AMAZON_LWA_APP_ID environment variable not set');
      const scopes = ['calls:2021-03-01', 'inventory:2021-03-01', 'orders:2021-01-01'].join('%20');
      return `https://www.amazon.com/ap/oa?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(uuid())}`;
    }
  }
}

async function exchangeCodeForTokens(c: Context<HonoEnv>, platform: MarketplacePlatform, channelId: string, code: string): Promise<void> {
  const db = getDb(c.var.db);
  
  if (platform === 'ebay') {
    const clientId = c.env.EBAY_CLIENT_ID ?? '';
    const clientSecret = c.env.EBAY_CLIENT_SECRET ?? '';
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret });
    const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', body: tokenBody });
    
    if (!response.ok) throw new Error(`eBay token exchange failed`);
    const tokens = await response.json() as any;
    
    const encAccess = await encrypt(tokens.access_token, c.env.CRYPTOKEN ?? '');
    const encRefresh = await encrypt(tokens.refresh_token, c.env.CRYPTOKEN ?? '');

    await db.run(`INSERT INTO marketplace_credentials (id, channel_id, credential_type, encrypted_value, metadata) VALUES (?, ?, 'oauth_token', ?, '{}') ON CONFLICT(channel_id, credential_type) DO UPDATE SET encrypted_value = excluded.encrypted_value`, [uuid(), channelId, encAccess]);
    await db.run(`INSERT INTO marketplace_credentials (id, channel_id, credential_type, encrypted_value, metadata) VALUES (?, ?, 'refresh_token', ?, '{}') ON CONFLICT(channel_id, credential_type) DO UPDATE SET encrypted_value = excluded.encrypted_value`, [uuid(), channelId, encRefresh]);
  }
}

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}