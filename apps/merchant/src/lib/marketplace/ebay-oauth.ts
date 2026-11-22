/**
 * eBay OAuth 2.0 (authorization code grant) for seller "user" tokens.
 *
 * - Authorize: https://auth.ebay.com/oauth2/authorize (sandbox: auth.sandbox.ebay.com)
 * - Token:     https://api.ebay.com/identity/v1/oauth2/token (sandbox: api.sandbox.ebay.com)
 * - Client authentication is HTTP Basic base64(client_id:client_secret).
 * - `redirect_uri` is the app's RuName, not a URL.
 * - Access tokens last ~2h. Refresh tokens last ~18 months, and a refresh
 *   does not return a new refresh token.
 *
 * Every network call takes an injectable `fetch` so the flow is unit-testable.
 */
import type { CredentialManager } from './auth-manager';

export type EbayEnvironment = 'production' | 'sandbox';

export interface EbayAppCredentials {
  clientId: string;
  clientSecret: string;
  /** eBay RuName (redirect URL name) registered for the app. */
  ruName: string;
  environment?: EbayEnvironment;
}

/** Scopes needed for listing management and order fulfilment. */
export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
] as const;

export function ebayHosts(environment: EbayEnvironment = 'production') {
  return environment === 'sandbox'
    ? { api: 'https://api.sandbox.ebay.com', auth: 'https://auth.sandbox.ebay.com' }
    : { api: 'https://api.ebay.com', auth: 'https://auth.ebay.com' };
}

export function buildEbayAuthorizeUrl(
  app: Pick<EbayAppCredentials, 'clientId' | 'ruName' | 'environment'>,
  state: string,
  scopes: readonly string[] = EBAY_SCOPES,
): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.ruName,
    response_type: 'code',
    scope: scopes.join(' '), // URLSearchParams encodes the spaces once
    state,
  });
  return `${ebayHosts(app.environment).auth}/oauth2/authorize?${params}`;
}

export interface EbayTokens {
  accessToken: string;
  /** ISO 8601 */
  accessTokenExpiresAt: string;
  /** Only returned by the authorization-code grant. */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export class EbayOAuthError extends Error {
  constructor(message: string, readonly status: number, readonly ebayError?: string) {
    super(message);
    this.name = 'EbayOAuthError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function tokenRequest(
  app: EbayAppCredentials,
  body: URLSearchParams,
  fetchFn: typeof fetch,
  now: Date,
): Promise<EbayTokens> {
  const res = await fetchFn(`${ebayHosts(app.environment).api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
    },
    body: body.toString(),
  });

  const data = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token || !data.expires_in) {
    throw new EbayOAuthError(
      `eBay token request failed (${res.status}): ${data.error_description || data.error || 'no access token'}`,
      res.status,
      data.error,
    );
  }

  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: at(data.expires_in),
    ...(data.refresh_token && { refreshToken: data.refresh_token }),
    ...(data.refresh_token_expires_in && { refreshTokenExpiresAt: at(data.refresh_token_expires_in) }),
  };
}

/** Scope for application (client credentials) tokens, e.g. the Notification API's getPublicKey. */
export const EBAY_APPLICATION_SCOPE = 'https://api.ebay.com/oauth/api_scope';

/** Application access token (client credentials grant); no user or refresh token involved. */
export function getEbayApplicationToken(
  app: Pick<EbayAppCredentials, 'clientId' | 'clientSecret' | 'environment'>,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<EbayTokens> {
  return tokenRequest(
    app as EbayAppCredentials,
    new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_APPLICATION_SCOPE }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
}

/** Exchanges the `code` from the OAuth callback for user tokens. */
export function exchangeEbayCode(
  app: EbayAppCredentials,
  code: string,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<EbayTokens> {
  return tokenRequest(
    app,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: app.ruName }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
}

/** Mints a new access token from a refresh token. */
export function refreshEbayAccessToken(
  app: EbayAppCredentials,
  refreshToken: string,
  opts: { fetch?: typeof fetch; now?: Date; scopes?: readonly string[] } = {},
): Promise<EbayTokens> {
  return tokenRequest(
    app,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: (opts.scopes ?? EBAY_SCOPES).join(' '),
    }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
}

/** Persists tokens (encrypted) with their expiry in marketplace_credentials. */
export async function saveEbayTokens(
  credentials: CredentialManager,
  channelId: string,
  tokens: EbayTokens,
): Promise<void> {
  await credentials.saveCredential({
    channelId,
    type: 'oauth_token',
    value: tokens.accessToken,
    expiresAt: tokens.accessTokenExpiresAt,
  });
  if (tokens.refreshToken) {
    await credentials.saveCredential({
      channelId,
      type: 'refresh_token',
      value: tokens.refreshToken,
      expiresAt: tokens.refreshTokenExpiresAt ?? null,
    });
  }
}

/** What EbayClient needs from token storage. */
export interface EbayTokenProvider {
  getAccessToken(): Promise<string>;
  /** Forces a refresh (e.g. after a 401) and returns the new token. */
  refresh(): Promise<string>;
}

/** Refresh access tokens this long before they expire. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * DB-backed token provider for one channel: returns the stored access token,
 * refreshing (and persisting) it when it is within 5 minutes of expiry.
 */
export class EbayTokenManager implements EbayTokenProvider {
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly opts: {
      channelId: string;
      credentials: CredentialManager;
      app: EbayAppCredentials;
      fetch?: typeof fetch;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async getAccessToken(): Promise<string> {
    const stored = await this.opts.credentials.getCredential(this.opts.channelId, 'oauth_token');
    if (!stored) throw new Error('eBay: channel is not connected (no access token)');

    const expiresAt = stored.expiresAt ? new Date(stored.expiresAt).getTime() : 0;
    if (expiresAt - this.now().getTime() > REFRESH_MARGIN_MS) return stored.value;

    return this.refresh();
  }

  /** Concurrent callers share one in-flight refresh. */
  refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const refresh = await this.opts.credentials.getCredential(this.opts.channelId, 'refresh_token');
    if (!refresh) throw new Error('eBay: no refresh token; reconnect the channel');
    if (refresh.expiresAt && new Date(refresh.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error('eBay: refresh token expired; reconnect the channel');
    }

    const tokens = await refreshEbayAccessToken(this.opts.app, refresh.value, {
      fetch: this.opts.fetch,
      now: this.now(),
    });
    await saveEbayTokens(this.opts.credentials, this.opts.channelId, tokens);
    return tokens.accessToken;
  }
}

/** Reads the eBay app credentials from the Worker env, or null if incomplete. */
export function ebayAppFromEnv(env: {
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_RU_NAME?: string;
  EBAY_ENVIRONMENT?: string;
}): EbayAppCredentials | null {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET || !env.EBAY_RU_NAME) return null;
  return {
    clientId: env.EBAY_CLIENT_ID,
    clientSecret: env.EBAY_CLIENT_SECRET,
    ruName: env.EBAY_RU_NAME,
    environment: env.EBAY_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
  };
}
