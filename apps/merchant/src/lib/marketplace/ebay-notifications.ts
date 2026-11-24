/**
 * eBay Notification API (Commerce Notification API) receiver helpers.
 *
 * Endpoint validation (GET ?challenge_code=…):
 *   challengeResponse = hex(SHA-256(challengeCode + verificationToken + endpoint))
 *   answered as application/json { "challengeResponse": "…" }.
 *
 * Notification signatures (POST, header X-EBAY-SIGNATURE):
 *   base64(JSON { alg, kid, signature, digest }); `signature` is base64 ECDSA
 *   over the message with SHA-1. eBay's own Node SDK verifies it against
 *   JSON.stringify(parsedBody) using the key from
 *   GET /commerce/notification/v1/public_key/{kid} (application token).
 *   eBay recommends caching that key for about an hour.
 *
 * Two details are not documented, so both forms are accepted: the signature
 * may be DER (what Node's crypto.verify takes) or raw r||s (what WebCrypto
 * takes), and the message may be the raw body or its JSON re-serialization.
 * Every candidate is still checked against eBay's key, so accepting both
 * forms does not let an unsigned payload through.
 */
import { ebayHosts, getEbayApplicationToken, type EbayAppCredentials } from './ebay-oauth';

export const EBAY_SIGNATURE_HEADER = 'x-ebay-signature';
/** Public keys are cached this long (eBay: "one-hour is recommended"). */
export const EBAY_PUBLIC_KEY_TTL_SECONDS = 3600;
/** eBay verification tokens: 32–80 chars of [A-Za-z0-9_-]. */
export const EBAY_VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,80}$/;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── Endpoint validation ─────────────────────────────────────────────────────

export async function ebayChallengeResponse(challengeCode: string, verificationToken: string, endpoint: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(challengeCode + verificationToken + endpoint)));
}

// ─── Signature header ────────────────────────────────────────────────────────

export interface EbaySignatureHeader {
  kid: string;
  signature: string;
  alg?: string;
  digest?: string;
}

/** Key ids go into a URL path, so only plain id characters are accepted. */
const KID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseEbaySignatureHeader(header: string | undefined | null): EbaySignatureHeader | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(header))) as Record<string, unknown>;
    if (typeof parsed.kid !== 'string' || !KID_PATTERN.test(parsed.kid)) return null;
    if (typeof parsed.signature !== 'string' || !parsed.signature) return null;
    return {
      kid: parsed.kid,
      signature: parsed.signature,
      ...(typeof parsed.alg === 'string' && { alg: parsed.alg }),
      ...(typeof parsed.digest === 'string' && { digest: parsed.digest }),
    };
  } catch {
    return null;
  }
}

// ─── ECDSA plumbing ──────────────────────────────────────────────────────────

const CURVES = [
  { namedCurve: 'P-256', size: 32 },
  { namedCurve: 'P-384', size: 48 },
  { namedCurve: 'P-521', size: 66 },
] as const;

/** A DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) as fixed-width r||s, or null if it isn't one. */
export function derToRawSignature(der: Uint8Array, size: number): Uint8Array<ArrayBuffer> | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  let seqLen = der[i++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n < 1 || n > 2) return null;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | der[i++];
  }
  if (i + seqLen !== der.length) return null;
  const out = new Uint8Array(new ArrayBuffer(size * 2));
  for (const offset of [0, size]) {
    if (der[i++] !== 0x02) return null;
    const len = der[i++];
    if (len === undefined || i + len > der.length) return null;
    let int = der.subarray(i, i + len);
    i += len;
    while (int.length > 1 && int[0] === 0) int = int.subarray(1); // sign padding
    if (int.length > size) return null;
    out.set(int, offset + size - int.length);
  }
  return i === der.length ? out : null;
}

/** Accepts a PEM with or without headers/newlines (eBay returns it on one line). */
export function pemToSpki(pem: string): Uint8Array<ArrayBuffer> {
  return fromBase64(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, ''));
}

export interface ImportedKey {
  key: CryptoKey;
  size: number;
}

export async function importEbayPublicKey(pem: string): Promise<ImportedKey> {
  const spki = pemToSpki(pem);
  for (const { namedCurve, size } of CURVES) {
    try {
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve }, false, ['verify']);
      return { key, size };
    } catch {
      // wrong curve; try the next one
    }
  }
  throw new Error('eBay public key is not an ECDSA P-256/P-384/P-521 SPKI key');
}

const DIGESTS: Record<string, string> = { SHA1: 'SHA-1', 'SHA-1': 'SHA-1', SHA256: 'SHA-256', 'SHA-256': 'SHA-256' };

export async function verifyEbaySignature(opts: {
  header: string | undefined | null;
  rawBody: string;
  /** Resolves a key id to eBay's public key (PEM) and digest name. */
  getPublicKey: (kid: string) => Promise<{ key: string; digest?: string }>;
}): Promise<boolean> {
  const sig = parseEbaySignatureHeader(opts.header);
  if (!sig) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    return false;
  }

  const { key: pem, digest } = await opts.getPublicKey(sig.kid);
  const hash = DIGESTS[(digest ?? sig.digest ?? 'SHA1').toUpperCase()];
  if (!hash) return false;
  const { key, size } = await importEbayPublicKey(pem);

  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromBase64(sig.signature);
  } catch {
    return false;
  }
  const signatures = [derToRawSignature(sigBytes, size), sigBytes.length === size * 2 ? sigBytes : null].filter(
    (s): s is Uint8Array<ArrayBuffer> => s !== null,
  );
  const messages = [...new Set([JSON.stringify(parsed), opts.rawBody])].map((m) => enc.encode(m));

  for (const s of signatures) {
    for (const m of messages) {
      if (await crypto.subtle.verify({ name: 'ECDSA', hash }, key, s, m)) return true;
    }
  }
  return false;
}

// ─── Public key lookup (application token + cache) ───────────────────────────

export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export class EbayPublicKeyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EbayPublicKeyError';
  }
}

/**
 * Fetches eBay notification public keys. Keys are cached in KV (shared by all
 * isolates) and in memory; the application token is cached in memory until
 * shortly before it expires.
 */
export class EbayPublicKeyResolver {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly memory = new Map<string, { key: string; digest?: string; until: number }>();

  constructor(
    private readonly app: Pick<EbayAppCredentials, 'clientId' | 'clientSecret' | 'environment'>,
    private readonly opts: { kv?: KeyValueCache; fetch?: typeof fetch; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private async appToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const t = await getEbayApplicationToken(this.app, { fetch: this.opts.fetch, now: new Date(this.now()) });
    this.token = { value: t.accessToken, expiresAt: Date.parse(t.accessTokenExpiresAt) };
    return t.accessToken;
  }

  async getPublicKey(kid: string): Promise<{ key: string; digest?: string }> {
    if (!KID_PATTERN.test(kid)) throw new EbayPublicKeyError('invalid key id', 400);
    const cacheKey = `ebay:notification-key:${this.app.environment}:${kid}`;

    const mem = this.memory.get(cacheKey);
    if (mem && mem.until > this.now()) return { key: mem.key, digest: mem.digest };

    const cached = await this.opts.kv?.get(cacheKey).catch(() => null);
    if (cached) {
      const v = JSON.parse(cached) as { key: string; digest?: string };
      this.memory.set(cacheKey, { ...v, until: this.now() + EBAY_PUBLIC_KEY_TTL_SECONDS * 1000 });
      return v;
    }

    const res = await (this.opts.fetch ?? fetch)(
      `${ebayHosts(this.app.environment).api}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      { headers: { Authorization: `Bearer ${await this.appToken()}`, Accept: 'application/json' } },
    );
    const data = (await res.json().catch(() => ({}))) as { key?: string; algorithm?: string; digest?: string };
    if (!res.ok || typeof data.key !== 'string') {
      throw new EbayPublicKeyError(`eBay getPublicKey failed (${res.status})`, res.status);
    }
    if (data.algorithm && data.algorithm.toUpperCase() !== 'ECDSA') {
      throw new EbayPublicKeyError(`unsupported eBay key algorithm ${data.algorithm}`, 500);
    }

    const value = { key: data.key, ...(data.digest && { digest: data.digest }) };
    this.memory.set(cacheKey, { ...value, until: this.now() + EBAY_PUBLIC_KEY_TTL_SECONDS * 1000 });
    await this.opts.kv?.put(cacheKey, JSON.stringify(value), { expirationTtl: EBAY_PUBLIC_KEY_TTL_SECONDS }).catch(() => undefined);
    return value;
  }
}

// ─── Topics ──────────────────────────────────────────────────────────────────

/** Topics that mean "orders changed": each triggers a background order pull. */
export const EBAY_ORDER_TOPICS = new Set(['ORDER_CONFIRMATION', 'ORDER_CANCELLATION_ACTIVITY', 'ITEM_MARKED_SHIPPED']);

export interface EbayNotification {
  metadata?: { topic?: string; schemaVersion?: string; deprecated?: boolean };
  notification?: {
    notificationId?: string;
    eventDate?: string;
    publishDate?: string;
    publishAttemptCount?: number;
    data?: Record<string, unknown>;
  };
}
