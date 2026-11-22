/**
 * Amazon Selling Partner API (SP-API): seller authorization and LWA tokens.
 *
 * Flow (website authorization workflow):
 *   1. Admin starts at POST /v1/marketplace/connect/amazon → we return the
 *      Seller Central consent URL (`/apps/authorize/consent?application_id=…&state=…`).
 *   2. If the app has a Login URI registered, Amazon first sends the browser to
 *      it (GET …/connect/amazon/login) with `amazon_callback_uri` and
 *      `amazon_state`; we send it back to `amazon_callback_uri` with our state.
 *   3. Amazon redirects to the OAuth redirect URI with `spapi_oauth_code`,
 *      `state` and `selling_partner_id`.
 *   4. The code is exchanged at LWA for an access token (1 h) and a refresh
 *      token (does not expire; revoked if the seller removes the app).
 *
 * Amazon removed the AWS Signature V4 / IAM requirement from SP-API in
 * October 2023: requests only need the `x-amz-access-token` header, so no
 * AWS keys are involved.
 */
import type { CredentialManager } from './auth-manager';

export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export type AmazonRegion = 'NA' | 'EU' | 'FE';
export type AmazonEnvironment = 'production' | 'sandbox';

interface MarketplaceInfo {
  id: string;
  country: string;
  region: AmazonRegion;
  currency: string;
  languageTag: string;
}

/** Main SP-API marketplaces (id → region, currency, listing language). */
export const AMAZON_MARKETPLACES: readonly MarketplaceInfo[] = [
  { id: 'ATVPDKIKX0DER', country: 'US', region: 'NA', currency: 'USD', languageTag: 'en_US' },
  { id: 'A2EUQ1WTGCTBG2', country: 'CA', region: 'NA', currency: 'CAD', languageTag: 'en_CA' },
  { id: 'A1AM78C64UM0Y8', country: 'MX', region: 'NA', currency: 'MXN', languageTag: 'es_MX' },
  { id: 'A2Q3Y263D00KWC', country: 'BR', region: 'NA', currency: 'BRL', languageTag: 'pt_BR' },
  { id: 'A1F83G8C2ARO7P', country: 'GB', region: 'EU', currency: 'GBP', languageTag: 'en_GB' },
  { id: 'A1PA6795UKMFR9', country: 'DE', region: 'EU', currency: 'EUR', languageTag: 'de_DE' },
  { id: 'A13V1IB3VIYZZH', country: 'FR', region: 'EU', currency: 'EUR', languageTag: 'fr_FR' },
  { id: 'APJ6JRA9NG5V4', country: 'IT', region: 'EU', currency: 'EUR', languageTag: 'it_IT' },
  { id: 'A1RKKUPIHCS9HS', country: 'ES', region: 'EU', currency: 'EUR', languageTag: 'es_ES' },
  { id: 'A1805IZSGTT6HS', country: 'NL', region: 'EU', currency: 'EUR', languageTag: 'nl_NL' },
  { id: 'AMEN7PMS3EDWL', country: 'BE', region: 'EU', currency: 'EUR', languageTag: 'fr_BE' },
  { id: 'A2NODRKZP88ZB9', country: 'SE', region: 'EU', currency: 'SEK', languageTag: 'sv_SE' },
  { id: 'A1C3SOZRARQ6R3', country: 'PL', region: 'EU', currency: 'PLN', languageTag: 'pl_PL' },
  { id: 'A33AVAJ2PDY3EV', country: 'TR', region: 'EU', currency: 'TRY', languageTag: 'tr_TR' },
  { id: 'A2VIGQ35RCS4UG', country: 'AE', region: 'EU', currency: 'AED', languageTag: 'en_AE' },
  { id: 'A17E79C6D8DWNP', country: 'SA', region: 'EU', currency: 'SAR', languageTag: 'ar_SA' },
  { id: 'ARBP9OOSHTCHU', country: 'EG', region: 'EU', currency: 'EGP', languageTag: 'en_AE' },
  { id: 'A21TJRUUN4KGV', country: 'IN', region: 'EU', currency: 'INR', languageTag: 'en_IN' },
  { id: 'A1VC38T7YXB528', country: 'JP', region: 'FE', currency: 'JPY', languageTag: 'ja_JP' },
  { id: 'A39IBJ37TRP1C6', country: 'AU', region: 'FE', currency: 'AUD', languageTag: 'en_AU' },
  { id: 'A19VAU5U5O7RUS', country: 'SG', region: 'FE', currency: 'SGD', languageTag: 'en_SG' },
];

export function amazonMarketplace(id: string | undefined | null): MarketplaceInfo | undefined {
  return AMAZON_MARKETPLACES.find((m) => m.id === id);
}

const REGION_DEFAULTS: Record<AmazonRegion, { host: string; sellerCentral: string; marketplaceId: string }> = {
  NA: { host: 'sellingpartnerapi-na.amazon.com', sellerCentral: 'https://sellercentral.amazon.com', marketplaceId: 'ATVPDKIKX0DER' },
  EU: { host: 'sellingpartnerapi-eu.amazon.com', sellerCentral: 'https://sellercentral-europe.amazon.com', marketplaceId: 'A1F83G8C2ARO7P' },
  FE: { host: 'sellingpartnerapi-fe.amazon.com', sellerCentral: 'https://sellercentral.amazon.co.jp', marketplaceId: 'A1VC38T7YXB528' },
};

export function parseAmazonRegion(raw: string | undefined | null): AmazonRegion {
  const r = (raw ?? '').trim().toUpperCase();
  if (r === 'EU' || r === 'FE') return r;
  if (r === 'FEA') return 'FE'; // older spelling used in earlier docs
  return 'NA';
}

/** SP-API base URL, e.g. https://sellingpartnerapi-eu.amazon.com or the sandbox host. */
export function amazonApiBase(region: AmazonRegion, environment: AmazonEnvironment = 'production'): string {
  const host = REGION_DEFAULTS[region].host;
  return `https://${environment === 'sandbox' ? `sandbox.${host}` : host}`;
}

export function defaultMarketplaceId(region: AmazonRegion): string {
  return REGION_DEFAULTS[region].marketplaceId;
}

/**
 * Seller Central hosts that may appear as `amazon_callback_uri` during the
 * Login URI step. Anything else is refused (no open redirect).
 */
export function isAmazonCallbackUri(raw: string | undefined | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^(sellercentral|vendorcentral)(-[a-z]+)?\.amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(u.hostname);
  } catch {
    return false;
  }
}

// ─── App credentials (env) ───────────────────────────────────────────────────

export interface AmazonAppCredentials {
  /** LWA client identifier (amzn1.application-oa2-client.…). */
  clientId: string;
  clientSecret: string;
  /** SP-API application ID (amzn1.sp.solution.…), used in the consent URL. */
  applicationId: string;
  /** Must match an OAuth Redirect URI registered on the app. */
  redirectUri: string;
  region: AmazonRegion;
  environment: AmazonEnvironment;
  /** Seller Central origin for the consent page. */
  sellerCentralUrl: string;
  /** Marketplace to use when the seller sells in several. */
  marketplaceId: string;
  /** App still in draft: the consent URL needs version=beta. */
  draft: boolean;
}

export interface AmazonEnv {
  AMAZON_LWA_CLIENT_ID?: string;
  AMAZON_LWA_CLIENT_SECRET?: string;
  /** Older names, still accepted. */
  AMAZON_LWA_APP_ID?: string;
  AMAZON_LWA_APP_SECRET?: string;
  AMAZON_SP_APP_ID?: string;
  AMAZON_REGION?: string;
  AMAZON_MARKETPLACE_ID?: string;
  AMAZON_ENVIRONMENT?: string;
  AMAZON_REDIRECT_URI?: string;
  AMAZON_SELLER_CENTRAL_URL?: string;
  AMAZON_APP_DRAFT?: string;
  API_BASE_URL?: string;
}

export function amazonAppFromEnv(env: AmazonEnv): AmazonAppCredentials | null {
  const clientId = env.AMAZON_LWA_CLIENT_ID || env.AMAZON_LWA_APP_ID;
  const clientSecret = env.AMAZON_LWA_CLIENT_SECRET || env.AMAZON_LWA_APP_SECRET;
  const applicationId = env.AMAZON_SP_APP_ID;
  if (!clientId || !clientSecret || !applicationId) return null;

  const redirectUri =
    env.AMAZON_REDIRECT_URI ||
    (env.API_BASE_URL ? `${env.API_BASE_URL.replace(/\/+$/, '')}/v1/marketplace/connect/amazon/callback` : '');
  if (!redirectUri) return null;

  const region = parseAmazonRegion(env.AMAZON_REGION);
  return {
    clientId,
    clientSecret,
    applicationId,
    redirectUri,
    region,
    environment: env.AMAZON_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
    sellerCentralUrl: (env.AMAZON_SELLER_CENTRAL_URL || REGION_DEFAULTS[region].sellerCentral).replace(/\/+$/, ''),
    marketplaceId: env.AMAZON_MARKETPLACE_ID || REGION_DEFAULTS[region].marketplaceId,
    draft: env.AMAZON_APP_DRAFT === 'true' || env.AMAZON_APP_DRAFT === '1',
  };
}

export function buildAmazonAuthorizeUrl(app: AmazonAppCredentials, state: string): string {
  const params = new URLSearchParams({ application_id: app.applicationId, state, redirect_uri: app.redirectUri });
  if (app.draft) params.set('version', 'beta');
  return `${app.sellerCentralUrl}/apps/authorize/consent?${params}`;
}

/** Login URI step: hand control back to Seller Central with our state. */
export function buildAmazonLoginReturnUrl(
  app: Pick<AmazonAppCredentials, 'redirectUri' | 'draft'>,
  callbackUri: string,
  amazonState: string,
  state: string,
): string {
  const u = new URL(callbackUri);
  u.searchParams.set('amazon_state', amazonState);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', app.redirectUri);
  if (app.draft) u.searchParams.set('version', 'beta');
  return u.toString();
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export class AmazonOAuthError extends Error {
  constructor(message: string, readonly status: number, readonly lwaError?: string) {
    super(message);
    this.name = 'AmazonOAuthError';
  }
}

export interface AmazonTokens {
  accessToken: string;
  /** ISO 8601 */
  accessTokenExpiresAt: string;
  /** LWA refresh tokens don't expire; present on code exchange (and usually on refresh). */
  refreshToken?: string;
}

async function tokenRequest(body: URLSearchParams, fetchFn: typeof fetch, now: Date): Promise<AmazonTokens> {
  const res = await fetchFn(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token || !data.expires_in) {
    throw new AmazonOAuthError(
      `Amazon LWA token request failed (${res.status}): ${data.error_description || data.error || 'no access token'}`,
      res.status,
      data.error,
    );
  }
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + data.expires_in * 1000).toISOString(),
    ...(data.refresh_token && { refreshToken: data.refresh_token }),
  };
}

export async function exchangeAmazonCode(
  app: Pick<AmazonAppCredentials, 'clientId' | 'clientSecret' | 'redirectUri'>,
  code: string,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<AmazonTokens & { refreshToken: string }> {
  const tokens = await tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
  if (!tokens.refreshToken) throw new AmazonOAuthError('Amazon LWA returned no refresh token', 502);
  return tokens as AmazonTokens & { refreshToken: string };
}

export function refreshAmazonAccessToken(
  app: Pick<AmazonAppCredentials, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<AmazonTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
    opts.fetch ?? fetch,
    opts.now ?? new Date(),
  );
}

export async function saveAmazonTokens(credentials: CredentialManager, channelId: string, tokens: AmazonTokens): Promise<void> {
  await credentials.saveCredential({ channelId, type: 'oauth_token', value: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt });
  if (tokens.refreshToken) {
    await credentials.saveCredential({ channelId, type: 'refresh_token', value: tokens.refreshToken });
  }
}

export interface AmazonTokenProvider {
  getAccessToken(): Promise<string>;
  /** Forces a refresh (e.g. after an expired-token 403) and returns the new token. */
  refresh(): Promise<string>;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class AmazonTokenManager implements AmazonTokenProvider {
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly opts: {
      channelId: string;
      credentials: CredentialManager;
      app: Pick<AmazonAppCredentials, 'clientId' | 'clientSecret'>;
      fetch?: typeof fetch;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async getAccessToken(): Promise<string> {
    const stored = await this.opts.credentials.getCredential(this.opts.channelId, 'oauth_token');
    if (!stored) throw new Error('Amazon: channel is not connected (no access token)');
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
    if (!refresh) throw new Error('Amazon: no refresh token; reconnect the channel');
    const tokens = await refreshAmazonAccessToken(this.opts.app, refresh.value, { fetch: this.opts.fetch, now: this.now() });
    await saveAmazonTokens(this.opts.credentials, this.opts.channelId, tokens);
    return tokens.accessToken;
  }
}
