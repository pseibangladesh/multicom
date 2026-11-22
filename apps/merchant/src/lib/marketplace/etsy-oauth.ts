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

/**
 * Etsy Open API v3 OAuth 2.0 (authorization code + PKCE).
 *
 *   authorize  https://www.etsy.com/oauth/connect
 *   token      https://api.etsy.com/v3/public/oauth/token
 *
 * Etsy is a public client: the token endpoint takes `client_id` (the app
 * keystring) and no secret. PKCE (S256) is mandatory. Access tokens last 1 hour
 * and are prefixed with the seller's user ID ("12345678.abc…"); refresh tokens
 * last 90 days. API calls also need `x-api-key: keystring:shared_secret`.
 */

import type { CredentialManager } from './auth-manager';

export const ETSY_AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

/** Shop + listing management and receipts (orders). */
export const ETSY_SCOPES = ['shops_r', 'listings_r', 'listings_w', 'listings_d', 'transactions_r', 'transactions_w'] as const;

/** Etsy does not return the refresh token lifetime; it is documented as 90 days. */
const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;

export interface EtsyAppCredentials {
  /** App keystring (also the OAuth client_id). */
  clientId: string;
  sharedSecret: string;
  /** Must exactly match a callback URL registered on the Etsy app. */
  redirectUri: string;
}

export class EtsyOAuthError extends Error {
  constructor(message: string, readonly status: number, readonly etsyError?: string) {
    super(message);
    this.name = 'EtsyOAuthError';
  }
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 43-char verifier from 32 random bytes (RFC 7636 allows 43–128). */
export function createCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function buildEtsyAuthorizeUrl(
  app: Pick<EtsyAppCredentials, 'clientId' | 'redirectUri'>,
  state: string,
  codeVerifier: string,
  scopes: readonly string[] = ETSY_SCOPES,
): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: await codeChallengeS256(codeVerifier),
    code_challenge_method: 'S256',
  });
  return `${ETSY_AUTHORIZE_URL}?${params}`;
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface EtsyTokens {
  accessToken: string;
  /** ISO 8601 */
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

/** The numeric seller user ID Etsy prefixes onto every access token. */
export function etsyUserIdFromToken(accessToken: string): string | null {
  const m = /^(\d+)\./.exec(accessToken);
  return m ? m[1] : null;
}

async function tokenRequest(body: URLSearchParams, fetchFn: typeof fetch, now: Date): Promise<EtsyTokens> {
  const res = await fetchFn(ETSY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!res.ok || !data.access_token || !data.expires_in || !data.refresh_token) {
    throw new EtsyOAuthError(
      `Etsy token request failed (${res.status}): ${data.error_description || data.error || 'no access token'}`,
      res.status,
      data.error,
    );
  }

  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: at(data.expires_in),
    refreshToken: data.refresh_token,
    refreshTokenExpiresAt: at(REFRESH_TOKEN_TTL_S),
  };
}

/** Exchanges the callback `code` (plus the PKCE verifier stored with the state) for tokens. */
export function exchangeEtsyCode(
  app: EtsyAppCredentials,
  code: string,
  codeVerifier: string,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<EtsyTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      redirect_uri: app.redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
}

/** Etsy rotates refresh tokens: the response carries a new one to store. */
export function refreshEtsyAccessToken(
  app: Pick<EtsyAppCredentials, 'clientId'>,
  refreshToken: string,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<EtsyTokens> {
  return tokenRequest(
    new URLSearchParams({ grant_type: 'refresh_token', client_id: app.clientId, refresh_token: refreshToken }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
}

export async function saveEtsyTokens(credentials: CredentialManager, channelId: string, tokens: EtsyTokens): Promise<void> {
  await credentials.saveCredential({ channelId, type: 'oauth_token', value: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt });
  await credentials.saveCredential({ channelId, type: 'refresh_token', value: tokens.refreshToken, expiresAt: tokens.refreshTokenExpiresAt });
}

/** What EtsyClient needs from token storage (same shape as EbayTokenProvider). */
export interface EtsyTokenProvider {
  getAccessToken(): Promise<string>;
  /** Forces a refresh (e.g. after a 401) and returns the new token. */
  refresh(): Promise<string>;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** DB-backed token provider for one Etsy channel; refreshes within 5 minutes of expiry. */
export class EtsyTokenManager implements EtsyTokenProvider {
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly opts: {
      channelId: string;
      credentials: CredentialManager;
      app: Pick<EtsyAppCredentials, 'clientId'>;
      fetch?: typeof fetch;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async getAccessToken(): Promise<string> {
    const stored = await this.opts.credentials.getCredential(this.opts.channelId, 'oauth_token');
    if (!stored) throw new Error('Etsy: channel is not connected (no access token)');
    const expiresAt = stored.expiresAt ? new Date(stored.expiresAt).getTime() : 0;
    if (expiresAt - this.now().getTime() > REFRESH_MARGIN_MS) return stored.value;
    return this.refresh();
  }

  /** Concurrent callers share one in-flight refresh (a rotated refresh token is single-use). */
  refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const refresh = await this.opts.credentials.getCredential(this.opts.channelId, 'refresh_token');
    if (!refresh) throw new Error('Etsy: no refresh token; reconnect the channel');
    if (refresh.expiresAt && new Date(refresh.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error('Etsy: refresh token expired; reconnect the channel');
    }
    const tokens = await refreshEtsyAccessToken(this.opts.app, refresh.value, { fetch: this.opts.fetch, now: this.now() });
    await saveEtsyTokens(this.opts.credentials, this.opts.channelId, tokens);
    return tokens.accessToken;
  }
}

/**
 * Reads the Etsy app from the Worker env, or null if incomplete. The redirect
 * URI defaults to this worker's callback route under API_BASE_URL.
 */
export function etsyAppFromEnv(env: {
  ETSY_CLIENT_ID?: string;
  ETSY_SHARED_SECRET?: string;
  ETSY_REDIRECT_URI?: string;
  API_BASE_URL?: string;
}): EtsyAppCredentials | null {
  if (!env.ETSY_CLIENT_ID || !env.ETSY_SHARED_SECRET) return null;
  const redirectUri =
    env.ETSY_REDIRECT_URI ||
    (env.API_BASE_URL ? `${env.API_BASE_URL.replace(/\/+$/, '')}/v1/marketplace/connect/etsy/callback` : '');
  if (!redirectUri) return null;
  return { clientId: env.ETSY_CLIENT_ID, sharedSecret: env.ETSY_SHARED_SECRET, redirectUri };
}
