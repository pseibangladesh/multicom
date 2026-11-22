import { describe, it, expect, vi } from 'vitest';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import {
  buildEbayAuthorizeUrl,
  exchangeEbayCode,
  refreshEbayAccessToken,
  saveEbayTokens,
  EbayTokenManager,
  EbayOAuthError,
  EBAY_SCOPES,
  ebayAppFromEnv,
} from '../src/lib/marketplace/ebay-oauth';
import { createMerchantDb } from './helpers/merchant-db';

const APP = { clientId: 'client-id', clientSecret: 's3cret', ruName: 'My_App-RuName', environment: 'production' as const };
const NOW = new Date('2026-11-22T10:00:00.000Z');
const KEY = 'test-crypto-key-0123456789abcdef0123456789';

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

function setup() {
  const { merchant } = createMerchantDb();
  merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch1', 'ebay', 'default')`);
  const credentials = new CredentialManager(getDb(merchant as never), KEY);
  return { merchant, credentials };
}

describe('buildEbayAuthorizeUrl', () => {
  it('targets auth.ebay.com with the RuName, state, and singly-encoded scopes', () => {
    const url = new URL(buildEbayAuthorizeUrl(APP, 'state-123'));
    expect(url.origin + url.pathname).toBe('https://auth.ebay.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('My_App-RuName');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    // Decoding once must give back the space-separated scope list (no %2520).
    expect(url.searchParams.get('scope')).toBe(EBAY_SCOPES.join(' '));
    expect(url.toString()).not.toContain('%25');
  });

  it('uses the sandbox host in sandbox', () => {
    expect(buildEbayAuthorizeUrl({ ...APP, environment: 'sandbox' }, 's')).toMatch(/^https:\/\/auth\.sandbox\.ebay\.com\/oauth2\/authorize\?/);
  });
});

describe('ebayAppFromEnv', () => {
  it('requires id, secret and RuName; defaults to production', () => {
    expect(ebayAppFromEnv({ EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b' })).toBeNull();
    expect(ebayAppFromEnv({ EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b', EBAY_RU_NAME: 'r' })?.environment).toBe('production');
    expect(ebayAppFromEnv({ EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b', EBAY_RU_NAME: 'r', EBAY_ENVIRONMENT: 'sandbox' })?.environment).toBe('sandbox');
  });
});

describe('exchangeEbayCode', () => {
  it('POSTs the code with Basic client auth and computes expiries', async () => {
    const fetchMock = tokenResponse({
      access_token: 'v^1.1#access',
      expires_in: 7200,
      refresh_token: 'v^1.1#refresh',
      refresh_token_expires_in: 47304000,
      token_type: 'User Access Token',
    });

    const tokens = await exchangeEbayCode(APP, 'auth-code', { fetch: fetchMock, now: NOW });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('client-id:s3cret')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init!.body as string);
    expect(Object.fromEntries(body)).toEqual({ grant_type: 'authorization_code', code: 'auth-code', redirect_uri: 'My_App-RuName' });
    // Secrets go in the header only.
    expect(body.has('client_secret')).toBe(false);

    expect(tokens).toEqual({
      accessToken: 'v^1.1#access',
      accessTokenExpiresAt: '2026-11-22T12:00:00.000Z',
      refreshToken: 'v^1.1#refresh',
      refreshTokenExpiresAt: new Date(NOW.getTime() + 47304000 * 1000).toISOString(),
    });
  });

  it('throws EbayOAuthError with eBay\'s description on failure', async () => {
    const fetchMock = tokenResponse({ error: 'invalid_grant', error_description: 'the provided authorization grant code is invalid' }, 400);
    const err = await exchangeEbayCode(APP, 'bad', { fetch: fetchMock }).catch((e) => e);
    expect(err).toBeInstanceOf(EbayOAuthError);
    expect(err.status).toBe(400);
    expect(err.ebayError).toBe('invalid_grant');
    expect(err.message).toContain('authorization grant code is invalid');
  });
});

describe('refreshEbayAccessToken', () => {
  it('sends grant_type=refresh_token with the scopes, against the sandbox host', async () => {
    const fetchMock = tokenResponse({ access_token: 'new', expires_in: 7200 });
    const tokens = await refreshEbayAccessToken({ ...APP, environment: 'sandbox' }, 'rt', { fetch: fetchMock, now: NOW });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sandbox.ebay.com/identity/v1/oauth2/token');
    const body = new URLSearchParams(init!.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('scope')).toBe(EBAY_SCOPES.join(' '));
    expect(tokens).toEqual({ accessToken: 'new', accessTokenExpiresAt: '2026-11-22T12:00:00.000Z' });
  });
});

describe('saveEbayTokens + CredentialManager', () => {
  it('stores tokens encrypted with expires_at in its own column', async () => {
    const { merchant, credentials } = setup();
    await saveEbayTokens(credentials, 'ch1', {
      accessToken: 'plain-access',
      accessTokenExpiresAt: '2026-11-22T12:00:00.000Z',
      refreshToken: 'plain-refresh',
      refreshTokenExpiresAt: '2028-05-22T10:00:00.000Z',
    });

    const rows = merchant.query<{ credential_type: string; encrypted_value: string; expires_at: string }>(
      `SELECT credential_type, encrypted_value, expires_at FROM marketplace_credentials ORDER BY credential_type`
    );
    expect(rows.map((r) => [r.credential_type, r.expires_at])).toEqual([
      ['oauth_token', '2026-11-22T12:00:00.000Z'],
      ['refresh_token', '2028-05-22T10:00:00.000Z'],
    ]);
    expect(rows.every((r) => !r.encrypted_value.includes('plain'))).toBe(true);

    expect(await credentials.getCredential('ch1', 'oauth_token')).toEqual({ value: 'plain-access', expiresAt: '2026-11-22T12:00:00.000Z' });
    expect(await credentials.isTokenNearExpiry('ch1', 'oauth_token', new Date('2026-11-22T11:56:00.000Z'))).toBe(true);
    expect(await credentials.isTokenNearExpiry('ch1', 'oauth_token', new Date('2026-11-22T11:00:00.000Z'))).toBe(false);
  });

  it('a refresh without a new refresh token keeps the stored one', async () => {
    const { credentials } = setup();
    await saveEbayTokens(credentials, 'ch1', { accessToken: 'a1', accessTokenExpiresAt: 'x', refreshToken: 'r1' });
    await saveEbayTokens(credentials, 'ch1', { accessToken: 'a2', accessTokenExpiresAt: 'y' });
    expect(await credentials.getSecret('ch1', 'oauth_token')).toBe('a2');
    expect(await credentials.getSecret('ch1', 'refresh_token')).toBe('r1');
  });
});

describe('EbayTokenManager', () => {
  async function seeded(accessExpiresAt: string, refreshExpiresAt = '2028-01-01T00:00:00.000Z') {
    const ctx = setup();
    await saveEbayTokens(ctx.credentials, 'ch1', {
      accessToken: 'stored-access',
      accessTokenExpiresAt: accessExpiresAt,
      refreshToken: 'stored-refresh',
      refreshTokenExpiresAt: refreshExpiresAt,
    });
    return ctx;
  }

  it('returns the stored token without calling eBay while it is fresh', async () => {
    const { credentials } = await seeded('2026-11-22T11:00:00.000Z');
    const fetchMock = tokenResponse({});
    const tm = new EbayTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });
    expect(await tm.getAccessToken()).toBe('stored-access');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes within 5 minutes of expiry and persists the new token and expiry', async () => {
    const { credentials } = await seeded('2026-11-22T10:04:00.000Z');
    const fetchMock = tokenResponse({ access_token: 'fresh-access', expires_in: 7200 });
    const tm = new EbayTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });

    expect(await tm.getAccessToken()).toBe('fresh-access');
    expect(new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string).get('refresh_token')).toBe('stored-refresh');
    expect(await credentials.getCredential('ch1', 'oauth_token')).toEqual({
      value: 'fresh-access',
      expiresAt: '2026-11-22T12:00:00.000Z',
    });
  });

  it('shares one refresh between concurrent callers', async () => {
    const { credentials } = await seeded('2026-11-22T09:00:00.000Z');
    const fetchMock = tokenResponse({ access_token: 'fresh', expires_in: 7200 });
    const tm = new EbayTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });
    expect(await Promise.all([tm.refresh(), tm.refresh(), tm.refresh()])).toEqual(['fresh', 'fresh', 'fresh']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for a reconnect when the refresh token has expired', async () => {
    const { credentials } = await seeded('2026-11-22T09:00:00.000Z', '2026-11-01T00:00:00.000Z');
    const fetchMock = tokenResponse({});
    const tm = new EbayTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });
    await expect(tm.getAccessToken()).rejects.toThrow(/refresh token expired; reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors clearly when the channel was never connected', async () => {
    const { credentials } = setup();
    const tm = new EbayTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: tokenResponse({}) });
    await expect(tm.getAccessToken()).rejects.toThrow(/not connected/);
  });
});

describe('crypto-utils compatibility', () => {
  it('decrypts values written by the old CredentialManager.encryptForStorage', async () => {
    const { decrypt } = await import('../src/lib/marketplace/crypto-utils');
    // Verbatim copy of the removed helper: PBKDF2 deriveBits, first 32 bytes as the AES-GCM key.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), 'PBKDF2', false, ['deriveBits']);
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 100_000 }, baseKey, 384)
    );
    const aesKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-GCM', false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode('legacy')));
    const combined = new Uint8Array([...iv, ...encrypted]);

    expect(await decrypt(btoa(String.fromCharCode(...combined)), KEY)).toBe('legacy');
  });
});
