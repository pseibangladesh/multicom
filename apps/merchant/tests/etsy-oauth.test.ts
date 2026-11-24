import { describe, it, expect, vi } from 'vitest';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import {
  buildEtsyAuthorizeUrl,
  codeChallengeS256,
  createCodeVerifier,
  exchangeEtsyCode,
  refreshEtsyAccessToken,
  saveEtsyTokens,
  EtsyTokenManager,
  EtsyOAuthError,
  ETSY_SCOPES,
  etsyAppFromEnv,
  etsyUserIdFromToken,
} from '../src/lib/marketplace/etsy-oauth';
import { createMerchantDb } from './helpers/merchant-db';

const APP = { clientId: 'keystring123', sharedSecret: 'shh', redirectUri: 'https://api.shop.test/v1/marketplace/connect/etsy/callback' };
const NOW = new Date('2026-11-22T10:00:00.000Z');
const KEY = 'test-crypto-key-0123456789abcdef0123456789';

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

function setup() {
  const { merchant } = createMerchantDb();
  merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch1', 'etsy', 'default')`);
  return { merchant, credentials: new CredentialManager(getDb(merchant as never), KEY) };
}

describe('PKCE', () => {
  it('creates 43-char base64url verifiers', () => {
    const v = createCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCodeVerifier()).not.toBe(v);
  });

  it('derives the S256 challenge as unpadded base64url(sha256(verifier))', async () => {
    // Expected value computed independently with python3 hashlib + urlsafe_b64encode.
    expect(await codeChallengeS256('dBjftJeZ4CVP-mJ92ZAI6zVjaUw5L8vCdVkHmHtCSJkV')).toBe('WwzAJJFlYzFQ7exjK-i6X75wA8L1xPI2iaVDtNVYmCE');
  });
});

describe('buildEtsyAuthorizeUrl', () => {
  it('sends client_id, redirect, scopes, state and an S256 challenge (never the verifier)', async () => {
    const verifier = createCodeVerifier();
    const url = new URL(await buildEtsyAuthorizeUrl(APP, 'state-1', verifier));
    expect(url.origin + url.pathname).toBe('https://www.etsy.com/oauth/connect');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'keystring123',
      redirect_uri: APP.redirectUri,
      scope: ETSY_SCOPES.join(' '),
      state: 'state-1',
      code_challenge: await codeChallengeS256(verifier),
      code_challenge_method: 'S256',
    });
    expect(url.toString()).not.toContain(verifier);
    expect(url.toString()).not.toContain('shh');
  });
});

describe('etsyAppFromEnv', () => {
  it('needs keystring + secret, and defaults the redirect to API_BASE_URL', () => {
    expect(etsyAppFromEnv({ ETSY_CLIENT_ID: 'a' })).toBeNull();
    expect(etsyAppFromEnv({ ETSY_CLIENT_ID: 'a', ETSY_SHARED_SECRET: 'b' })).toBeNull();
    expect(etsyAppFromEnv({ ETSY_CLIENT_ID: 'a', ETSY_SHARED_SECRET: 'b', API_BASE_URL: 'https://api.test/' })?.redirectUri).toBe(
      'https://api.test/v1/marketplace/connect/etsy/callback'
    );
    expect(
      etsyAppFromEnv({ ETSY_CLIENT_ID: 'a', ETSY_SHARED_SECRET: 'b', API_BASE_URL: 'https://x', ETSY_REDIRECT_URI: 'https://cb' })?.redirectUri
    ).toBe('https://cb');
  });
});

describe('exchangeEtsyCode', () => {
  it('POSTs the code + verifier as a public client and computes expiries', async () => {
    const fetchMock = tokenResponse({ access_token: '12345678.acc', token_type: 'Bearer', expires_in: 3600, refresh_token: '12345678.ref' });
    const tokens = await exchangeEtsyCode(APP, 'the-code', 'the-verifier', { fetch: fetchMock, now: NOW });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.etsy.com/v3/public/oauth/token');
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(init!.body as string))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'keystring123',
      redirect_uri: APP.redirectUri,
      code: 'the-code',
      code_verifier: 'the-verifier',
    });
    expect(String(init!.body)).not.toContain('shh');
    expect(tokens).toEqual({
      accessToken: '12345678.acc',
      accessTokenExpiresAt: '2026-11-22T11:00:00.000Z',
      refreshToken: '12345678.ref',
      refreshTokenExpiresAt: '2027-02-20T10:00:00.000Z',
    });
  });

  it('throws EtsyOAuthError with Etsy\'s message on failure', async () => {
    const fetchMock = tokenResponse({ error: 'invalid_grant', error_description: 'code_verifier is invalid' }, 400);
    const err = await exchangeEtsyCode(APP, 'c', 'v', { fetch: fetchMock }).catch((e) => e);
    expect(err).toBeInstanceOf(EtsyOAuthError);
    expect(err.status).toBe(400);
    expect(err.etsyError).toBe('invalid_grant');
    expect(err.message).toMatch(/code_verifier is invalid/);
  });
});

describe('refreshEtsyAccessToken', () => {
  it('uses the refresh_token grant with client_id', async () => {
    const fetchMock = tokenResponse({ access_token: 'a2', expires_in: 3600, refresh_token: 'r2' });
    await refreshEtsyAccessToken(APP, 'r1', { fetch: fetchMock, now: NOW });
    expect(Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'keystring123',
      refresh_token: 'r1',
    });
  });
});

describe('etsyUserIdFromToken', () => {
  it('reads the numeric prefix', () => {
    expect(etsyUserIdFromToken('12345678.abcdef')).toBe('12345678');
    expect(etsyUserIdFromToken('abcdef')).toBeNull();
  });
});

describe('EtsyTokenManager', () => {
  const fresh = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

  async function seeded(accessExpiresInMin: number, refreshExpiresAt = fresh(60 * 24 * 30)) {
    const s = setup();
    await saveEtsyTokens(s.credentials, 'ch1', {
      accessToken: 'old-access',
      accessTokenExpiresAt: fresh(accessExpiresInMin),
      refreshToken: 'old-refresh',
      refreshTokenExpiresAt: refreshExpiresAt,
    });
    return s;
  }

  it('returns the stored token while it is fresh', async () => {
    const { credentials } = await seeded(30);
    const fetchMock = tokenResponse({});
    const mgr = new EtsyTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });
    expect(await mgr.getAccessToken()).toBe('old-access');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes near expiry and stores the rotated refresh token', async () => {
    const { credentials } = await seeded(2);
    const fetchMock = tokenResponse({ access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' });
    const mgr = new EtsyTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });

    expect(await mgr.getAccessToken()).toBe('new-access');
    expect(await credentials.getSecret('ch1', 'oauth_token')).toBe('new-access');
    expect(await credentials.getSecret('ch1', 'refresh_token')).toBe('new-refresh');
    expect((await credentials.getCredential('ch1', 'oauth_token'))?.expiresAt).toBe('2026-11-22T11:00:00.000Z');
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    const { credentials } = await seeded(0);
    const fetchMock = tokenResponse({ access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' });
    const mgr = new EtsyTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });
    expect(await Promise.all([mgr.refresh(), mgr.refresh(), mgr.getAccessToken()])).toEqual(['new-access', 'new-access', 'new-access']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for a reconnect when the refresh token has expired or is missing', async () => {
    const { credentials } = await seeded(0, fresh(-1));
    const fetchMock = tokenResponse({});
    const mgr = new EtsyTokenManager({ channelId: 'ch1', credentials, app: APP, fetch: fetchMock, now: () => NOW });
    await expect(mgr.getAccessToken()).rejects.toThrow(/refresh token expired; reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();

    const empty = setup();
    const mgr2 = new EtsyTokenManager({ channelId: 'ch1', credentials: empty.credentials, app: APP, fetch: fetchMock });
    await expect(mgr2.getAccessToken()).rejects.toThrow(/not connected/);
  });
});
