/**
 * Payment gateway settings stored in the `config` table.
 *
 * Secrets (SSLCommerz store password, Stripe secret key and webhook secret) are
 * encrypted with CRYPTOKEN (PBKDF2-SHA256 → AES-256-CBC) before storage.
 *
 * Stripe keys are resolved in this order, so existing setups keep working:
 *   1. the admin-saved row `payment_gateway.stripe` (Payment Gateways page)
 *   2. the STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET environment variables
 *   3. the legacy plaintext row `stripe` written by POST /v1/setup/stripe
 * The `enabled` switch only controls whether shoppers can start a Stripe
 * checkout. Refunds, discount sync and webhooks for existing orders still use
 * the keys while Stripe is switched off.
 */
import type { Database } from '../db';

export const SSLCOMMERZ_CONFIG_KEY = 'payment_gateway.sslcommerz';
export const STRIPE_CONFIG_KEY = 'payment_gateway.stripe';
const LEGACY_STRIPE_CONFIG_KEY = 'stripe';

// ─── Encryption ───────────────────────────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt') {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, baseKey, 384)
  );
  const aesKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-CBC', false, [usage]);
  return { aesKey, iv: derived.slice(32, 48) };
}

export async function encryptSecret(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const { aesKey, iv } = await deriveKey(password, salt, 'encrypt');
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, new TextEncoder().encode(plaintext)));
  const combined = new Uint8Array(salt.length + encrypted.length);
  combined.set(salt, 0);
  combined.set(encrypted, salt.length);
  return btoa(String.fromCharCode(...combined));
}

// PBKDF2 with 100k iterations is slow; checkout and refunds decrypt the same
// ciphertext over and over, so keep the result per isolate. A new key gets a
// new ciphertext (random salt), so saving settings never serves a stale value.
const decryptCache = new Map<string, string>();

export async function decryptSecret(base64Ciphertext: string, password: string): Promise<string> {
  const cacheKey = `${password.length}:${base64Ciphertext}`;
  const hit = decryptCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const raw = Uint8Array.from(atob(base64Ciphertext.trim()), (ch) => ch.charCodeAt(0));
  const { aesKey, iv } = await deriveKey(password, raw.slice(0, 8), 'decrypt');
  const plaintext = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, raw.slice(8)));
  if (decryptCache.size > 32) decryptCache.clear();
  decryptCache.set(cacheKey, plaintext);
  return plaintext;
}

// ─── Raw config rows ──────────────────────────────────────────────────

export async function readConfigJson(db: Database, key: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.query<{ value: string | null }>(`SELECT value FROM config WHERE key = ?`, [key]);
  if (!row?.value) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function writeConfigJson(db: Database, key: string, value: Record<string, unknown>): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [key, JSON.stringify(value)]
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ─── SSLCommerz ───────────────────────────────────────────────────────

export interface SslcommerzSettings {
  enabled: boolean;
  store_id: string;
  sandbox: boolean;
}

export async function getSslcommerzSettings(db: Database): Promise<SslcommerzSettings> {
  const row = await readConfigJson(db, SSLCOMMERZ_CONFIG_KEY);
  return {
    enabled: row?.enabled === true,
    store_id: str(row?.store_id),
    sandbox: row?.sandbox !== false,
  };
}

// ─── Stripe ───────────────────────────────────────────────────────────

export type StripeKeySource = 'dashboard' | 'environment' | 'legacy' | 'none';

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  CRYPTOKEN?: string;
}

export interface StripeSettings {
  /** Shoppers can start a Stripe checkout: switched on AND a secret key is available. */
  enabled: boolean;
  /** The admin switch itself (true when never configured, for backwards compatibility). */
  switched_on: boolean;
  secretKey: string | null;
  webhookSecret: string | null;
  publishableKey: string | null;
  secretKeySource: StripeKeySource;
  webhookSecretSource: StripeKeySource;
}

async function decryptOrNull(ciphertext: string, cryptoken: string | undefined): Promise<string | null> {
  if (!ciphertext || !cryptoken) return null;
  try {
    return await decryptSecret(ciphertext, cryptoken);
  } catch {
    return null;
  }
}

export async function getStripeSettings(db: Database, env: StripeEnv): Promise<StripeSettings> {
  const row = await readConfigJson(db, STRIPE_CONFIG_KEY);
  const legacy = row && str(row.secret_key) && str(row.webhook_secret) ? null : await readConfigJson(db, LEGACY_STRIPE_CONFIG_KEY);

  const pick = async (
    encrypted: unknown,
    envValue: string | undefined,
    legacyValue: unknown
  ): Promise<[string | null, StripeKeySource]> => {
    const fromDashboard = await decryptOrNull(str(encrypted), env.CRYPTOKEN);
    if (fromDashboard) return [fromDashboard, 'dashboard'];
    if (envValue) return [envValue, 'environment'];
    if (str(legacyValue)) return [str(legacyValue), 'legacy'];
    return [null, 'none'];
  };

  const [secretKey, secretKeySource] = await pick(row?.secret_key, env.STRIPE_SECRET_KEY, legacy?.secret_key);
  const [webhookSecret, webhookSecretSource] = await pick(row?.webhook_secret, env.STRIPE_WEBHOOK_SECRET, legacy?.webhook_secret);
  const switchedOn = row ? row.enabled !== false : true;

  return {
    enabled: switchedOn && secretKey !== null,
    switched_on: switchedOn,
    secretKey,
    webhookSecret,
    publishableKey: str(row?.publishable_key) || env.STRIPE_PUBLISHABLE_KEY || null,
    secretKeySource,
    webhookSecretSource,
  };
}

/** test / live, from the key prefix (sk_test_, rk_live_, ...). */
export function stripeMode(secretKey: string | null): 'test' | 'live' | null {
  if (!secretKey) return null;
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  return null;
}
